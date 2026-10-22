using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;
using System.Threading;
using UnityEditor;
using UnityEditor.Compilation;
using UnityEngine;
using UnityEngine.SceneManagement;

// The test runner (Haze.Ide.Editor.Tests) is a separate assembly: it compiles only with com.unity.test-framework.
[assembly: InternalsVisibleTo("Haze.Ide.Editor.Tests")]

namespace Haze.Ide.Editor
{
    /// <summary>
    /// The live link between this Unity Editor and Haze, as Rider's protocol:
    /// Unity listens on 127.0.0.1 and writes the port and a token to
    /// Library/Haze/EditorInstance.json; Haze connects. One JSON object per line.
    ///
    /// Unity → Haze: state (play mode), compileStarted, compileFinished (the
    /// compiler's messages), log (Console messages).
    /// Haze → Unity: hello (token), refresh, compile, play, pause, step, show
    /// (select an asset or the component in it), runTests.
    ///
    /// The port is kept across domain reloads, so Haze reconnects to the same
    /// address after every script compilation.
    /// </summary>
    static class HazeLink
    {
        const string k_PortKey = "Haze.Link.Port";
        const string k_TokenKey = "Haze.Link.Token";
        const string k_CompileKey = "Haze.Link.LastCompile";
        /// <summary>Messages kept while Haze is not connected (batches of up to k_MaxBatch Console messages).</summary>
        const int k_MaxPending = 200;
        const int k_MaxBatch = 100;

        static TcpListener s_Listener;
        static Client s_Client;
        static string s_Token;
        /// <summary>Lines from Haze and Console messages from any thread, handled on the main thread.</summary>
        static readonly ConcurrentQueue<string> s_Commands = new ConcurrentQueue<string>();
        static readonly ConcurrentQueue<(string message, string stack, LogType type)> s_Logs = new ConcurrentQueue<(string, string, LogType)>();
        /// <summary>Console messages while Haze is not connected (during a domain reload, say), sent once it is.</summary>
        static readonly Queue<string> s_Pending = new Queue<string>();
        static List<string> s_Messages;
        static string s_LastCompile;
        /// <summary>After a compile request: when to resend the last result if Unity found nothing to compile.</summary>
        static double s_ReportAt;
        static bool s_CompileSeen;

        /// <summary>Runs the tests matching a regex; set by Haze.Ide.Editor.Tests when the Test Framework is installed.</summary>
        internal static Action<string> RunTests;

        static string InstancePath => Path.Combine(ProjectGeneration.ProjectDirectory, "Library", "Haze", "EditorInstance.json");

        public static void Start()
        {
            if (s_Listener != null || Application.isBatchMode || AssetDatabase.IsAssetImportWorkerProcess()) return;
            try
            {
                s_Listener = Listen(SessionState.GetInt(k_PortKey, 0));
            }
            catch (SocketException e)
            {
                UnityEngine.Debug.LogWarning($"Haze: cannot listen for Haze: {e.Message}");
                return;
            }
            var port = ((IPEndPoint)s_Listener.LocalEndpoint).Port;
            SessionState.SetInt(k_PortKey, port);
            s_Token = SessionState.GetString(k_TokenKey, "");
            if (s_Token == "")
            {
                s_Token = Guid.NewGuid().ToString("N");
                SessionState.SetString(k_TokenKey, s_Token);
            }
            s_LastCompile = SessionState.GetString(k_CompileKey, "");
            if (s_LastCompile == "") s_LastCompile = null;
            WriteInstance(port);
            new Thread(Accept) { IsBackground = true, Name = "Haze link" }.Start();

            AssemblyReloadEvents.beforeAssemblyReload += Stop;
            EditorApplication.quitting += Quit;
            EditorApplication.update += Update;
            EditorApplication.playModeStateChanged += _ => SendState();
            EditorApplication.pauseStateChanged += _ => SendState();
            CompilationPipeline.compilationStarted += OnCompilationStarted;
            CompilationPipeline.assemblyCompilationFinished += OnAssemblyCompiled;
            CompilationPipeline.compilationFinished += OnCompilationFinished;
            Application.logMessageReceivedThreaded += (message, stack, type) => s_Logs.Enqueue((message, stack, type));
        }

        /// <summary>The previous port when it is still free, else any.</summary>
        static TcpListener Listen(int port)
        {
            if (port != 0)
            {
                try
                {
                    var same = new TcpListener(IPAddress.Loopback, port);
                    // The last domain's connections linger in TIME_WAIT on this port (not an issue on Windows).
                    if (Application.platform != RuntimePlatform.WindowsEditor)
                        same.Server.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
                    same.Start();
                    return same;
                }
                catch (SocketException) { }
            }
            var any = new TcpListener(IPAddress.Loopback, 0);
            any.Start();
            return any;
        }

        static void WriteInstance(int port)
        {
            var json = "{" +
                       $"\"port\":{port}," +
                       $"\"pid\":{Process.GetCurrentProcess().Id}," +
                       $"\"token\":{Json.Str(s_Token)}," +
                       $"\"unity\":{Json.Str(Application.unityVersion)}" +
                       "}";
            Directory.CreateDirectory(Path.GetDirectoryName(InstancePath));
            File.WriteAllText(InstancePath, json, new UTF8Encoding(false));
        }

        /// <summary>Before a domain reload: the port stays reserved in SessionState and the instance file stays.</summary>
        static void Stop()
        {
            try { s_Listener?.Stop(); } catch (SocketException) { }
            s_Listener = null;
            Interlocked.Exchange(ref s_Client, null)?.Close();
        }

        static void Quit()
        {
            Stop();
            try { File.Delete(InstancePath); } catch (IOException) { }
        }

        static void Accept()
        {
            var listener = s_Listener;
            while (true)
            {
                TcpClient tcp;
                try
                {
                    tcp = listener.AcceptTcpClient();
                }
                catch (Exception)
                {
                    return; // stopped
                }
                new Thread(() => Serve(tcp)) { IsBackground = true, Name = "Haze link client" }.Start();
            }
        }

        static void Serve(TcpClient tcp)
        {
            Client client = null;
            try
            {
                tcp.NoDelay = true;
                tcp.SendTimeout = 2000;
                var reader = new StreamReader(tcp.GetStream(), new UTF8Encoding(false));
                var hello = reader.ReadLine();
                if (hello == null || Json.Field(hello, "t") != "hello" || Json.Field(hello, "token") != s_Token)
                {
                    tcp.Close();
                    return;
                }
                client = new Client(tcp);
                Interlocked.Exchange(ref s_Client, client)?.Close();
                s_Commands.Enqueue("{\"t\":\"connected\"}");
                string line;
                while ((line = reader.ReadLine()) != null)
                    s_Commands.Enqueue(line);
            }
            catch (Exception)
            {
                // closed by either side
            }
            finally
            {
                if (client != null)
                {
                    Interlocked.CompareExchange(ref s_Client, null, client);
                    client.Close();
                }
                else tcp.Close();
            }
        }

        static void Update()
        {
            while (s_Commands.TryDequeue(out var line)) Handle(line);
            if (!s_Logs.IsEmpty)
            {
                // One write for the frame's messages: a Debug.Log per object per frame adds up.
                var batch = new StringBuilder();
                for (var n = 0; n < k_MaxBatch && s_Logs.TryDequeue(out var log); n++)
                {
                    if (batch.Length > 0) batch.Append('\n');
                    batch.Append(LogJson(log.message, log.stack, log.type));
                }
                Post(batch.ToString());
            }
            if (s_ReportAt > 0 && EditorApplication.timeSinceStartup > s_ReportAt)
            {
                s_ReportAt = 0;
                // Nothing changed since the last compilation: its result still holds.
                if (!s_CompileSeen && !EditorApplication.isCompiling && s_LastCompile != null) Send(s_LastCompile);
            }
        }

        static void Handle(string line)
        {
            switch (Json.Field(line, "t"))
            {
                case "connected":
                    SendState();
                    if (s_LastCompile != null) Send(s_LastCompile);
                    while (s_Pending.Count > 0 && Send(s_Pending.Peek())) s_Pending.Dequeue();
                    break;
                case "refresh":
                    if (!EditorApplication.isPlayingOrWillChangePlaymode) AssetDatabase.Refresh();
                    break;
                case "compile":
                    Compile();
                    break;
                case "play":
                    EditorApplication.isPlaying = !EditorApplication.isPlaying;
                    break;
                case "pause":
                    EditorApplication.isPaused = !EditorApplication.isPaused;
                    break;
                case "step":
                    EditorApplication.Step();
                    break;
                case "show":
                    Show(Json.Field(line, "path"), Json.Field(line, "fileId"));
                    break;
                case "runTests":
                    if (RunTests != null) RunTests(Json.Field(line, "pattern") ?? ".*");
                    else
                        Post("{\"t\":\"testRunFinished\",\"passed\":0,\"failed\":0,\"skipped\":0," +
                             "\"error\":\"Install the Test Framework package (com.unity.test-framework) to run tests.\"}");
                    break;
            }
        }

        /// <summary>
        /// Selects an asset in the Project window, or the GameObject of the
        /// component `fileId` in it: in an open scene, or inside a prefab asset.
        /// </summary>
        static void Show(string path, string fileId)
        {
            var asset = string.IsNullOrEmpty(path) ? null : AssetDatabase.LoadMainAssetAtPath(path);
            if (asset == null) return;
            UnityEngine.Object target = asset;
            if (!string.IsNullOrEmpty(fileId))
            {
                var guid = AssetDatabase.AssetPathToGUID(path);
                var scene = SceneManager.GetSceneByPath(path);
                // GlobalObjectId types: 1 imported asset, 2 scene object, 3 source asset.
                var types = scene.IsValid() && scene.isLoaded ? new[] { 2 } : new[] { 1, 3 };
                foreach (var type in types)
                {
                    if (!GlobalObjectId.TryParse($"GlobalObjectId_V1-{type}-{guid}-{fileId}-0", out var id)) continue;
                    var found = GlobalObjectId.GlobalObjectIdentifierToObjectSlow(id);
                    if (found == null) continue;
                    target = found is Component component ? component.gameObject : found;
                    break;
                }
            }
            Selection.activeObject = target;
            EditorGUIUtility.PingObject(target);
        }

        /// <summary>
        /// Haze's Build: import changed scripts and compile. Unity compiles
        /// only when something changed; otherwise the last result is resent,
        /// and when there is none yet (Unity compiled before this package
        /// loaded) a compilation is forced to get one.
        /// </summary>
        static void Compile()
        {
            if (EditorApplication.isCompiling) return;
            if (s_LastCompile == null)
            {
                CompilationPipeline.RequestScriptCompilation();
                return;
            }
            s_CompileSeen = false;
            if (!EditorApplication.isPlayingOrWillChangePlaymode) AssetDatabase.Refresh();
            s_ReportAt = EditorApplication.timeSinceStartup + 0.5;
        }

        static void SendState()
        {
            Send("{\"t\":\"state\"," +
                 $"\"unity\":{Json.Str(Application.unityVersion)}," +
                 $"\"playing\":{Json.Bool(EditorApplication.isPlaying)}," +
                 $"\"paused\":{Json.Bool(EditorApplication.isPaused)}," +
                 $"\"compiling\":{Json.Bool(EditorApplication.isCompiling)}" +
                 "}");
        }

        static void OnCompilationStarted(object _)
        {
            s_CompileSeen = true;
            s_Messages = new List<string>();
            Send("{\"t\":\"compileStarted\"}");
        }

        // "Assets/A.cs(12,5): error CS1002: ; expected"
        static readonly Regex k_Message = new Regex(@"^.*?\(\d+,\d+\):\s*(?:error|warning|info)\s*(?<code>[A-Za-z]+\d+)?\s*:\s*(?<text>.*)$", RegexOptions.Singleline);

        static void OnAssemblyCompiled(string assembly, CompilerMessage[] messages)
        {
            if (s_Messages == null) s_Messages = new List<string>();
            foreach (var m in messages)
            {
                var match = k_Message.Match(m.message ?? "");
                var code = match.Success && match.Groups["code"].Success ? match.Groups["code"].Value : null;
                var text = match.Success ? match.Groups["text"].Value : m.message;
                var file = string.IsNullOrEmpty(m.file) ? null : ProjectGeneration.Resolve(m.file);
                s_Messages.Add("{" +
                               $"\"severity\":{Json.Str(m.type == CompilerMessageType.Error ? "error" : "warning")}," +
                               $"\"code\":{Json.Str(code)}," +
                               $"\"message\":{Json.Str(text)}," +
                               $"\"file\":{Json.Str(file)}," +
                               $"\"line\":{(m.line > 0 ? m.line.ToString() : "null")}," +
                               $"\"column\":{(m.column > 0 ? m.column.ToString() : "null")}," +
                               $"\"project\":{Json.Str(Path.GetFileNameWithoutExtension(assembly))}" +
                               "}");
            }
        }

        static void OnCompilationFinished(object _)
        {
            s_LastCompile = "{\"t\":\"compileFinished\",\"messages\":[" + string.Join(",", s_Messages ?? new List<string>()) + "]}";
            s_Messages = null;
            // Kept across the domain reload that follows a successful compilation.
            SessionState.SetString(k_CompileKey, s_LastCompile);
            Send(s_LastCompile);
        }

        // "Foo.Update () (at Packages/com.x/Runtime/Foo.cs:12)": package paths are virtual.
        static readonly Regex k_PackageFrame = new Regex(@"\(at (Packages/[^:)]+):(\d+)\)");

        static string LogJson(string message, string stack, LogType type)
        {
            if (!string.IsNullOrEmpty(stack) && stack.Contains("(at Packages/"))
                stack = k_PackageFrame.Replace(stack, m => $"(at {ProjectGeneration.Resolve(m.Groups[1].Value)}:{m.Groups[2].Value})");
            return "{\"t\":\"log\"," +
                   $"\"type\":{Json.Str(LogTypeName(type))}," +
                   $"\"message\":{Json.Str(message)}," +
                   $"\"stack\":{Json.Str(stack)}" +
                   "}";
        }

        /// <summary>Sends messages (lines), or keeps them for when Haze connects again (after a domain reload, say). Main thread.</summary>
        internal static void Post(string json)
        {
            if (Send(json)) return;
            if (s_Pending.Count >= k_MaxPending) s_Pending.Dequeue();
            s_Pending.Enqueue(json);
        }

        static string LogTypeName(LogType type)
        {
            switch (type)
            {
                case LogType.Error: return "error";
                case LogType.Assert: return "assert";
                case LogType.Warning: return "warning";
                case LogType.Exception: return "exception";
                default: return "log";
            }
        }

        /// <summary>Sends a line to Haze; false when it is not connected.</summary>
        static bool Send(string json)
        {
            var client = s_Client;
            if (client == null) return false;
            if (client.Write(json)) return true;
            Interlocked.CompareExchange(ref s_Client, null, client);
            client.Close();
            return false;
        }

        class Client
        {
            readonly TcpClient m_Tcp;
            readonly Stream m_Stream;
            readonly object m_Lock = new object();

            public Client(TcpClient tcp)
            {
                m_Tcp = tcp;
                m_Stream = tcp.GetStream();
            }

            public bool Write(string json)
            {
                var bytes = Encoding.UTF8.GetBytes(json + "\n");
                lock (m_Lock)
                {
                    try
                    {
                        m_Stream.Write(bytes, 0, bytes.Length);
                        return true;
                    }
                    catch (Exception)
                    {
                        return false;
                    }
                }
            }

            public void Close()
            {
                try { m_Tcp.Close(); } catch (Exception) { }
            }
        }
    }

    /// <summary>Just enough JSON for the link's flat messages.</summary>
    static class Json
    {
        public static string Bool(bool b) => b ? "true" : "false";

        public static string Str(string s)
        {
            if (s == null) return "null";
            var x = new StringBuilder(s.Length + 2).Append('"');
            foreach (var c in s)
            {
                switch (c)
                {
                    case '"': x.Append("\\\""); break;
                    case '\\': x.Append("\\\\"); break;
                    case '\n': x.Append("\\n"); break;
                    case '\r': x.Append("\\r"); break;
                    case '\t': x.Append("\\t"); break;
                    default:
                        if (c < ' ') x.Append("\\u").Append(((int)c).ToString("x4"));
                        else x.Append(c);
                        break;
                }
            }
            return x.Append('"').ToString();
        }

        /// <summary>A top-level string field of a flat object, or null.</summary>
        public static string Field(string json, string name)
        {
            var m = Regex.Match(json, "\"" + Regex.Escape(name) + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"");
            return m.Success ? Regex.Unescape(m.Groups[1].Value) : null;
        }
    }
}
