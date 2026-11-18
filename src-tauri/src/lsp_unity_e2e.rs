//! End-to-end: Roslyn, started the way Haze starts it, completes Unity types
//! in a project laid out like one Unity generates. Ignored by default (it needs
//! the .NET SDK and the `roslyn-language-server` tool and takes minutes); the
//! `Unity C# completion` workflow runs it on Windows, macOS and Linux:
//!
//! `cargo test --lib unity_completion -- --ignored --nocapture`
//!
//! Unity's `.csproj` files are not SDK-style, so Roslyn loads them with the
//! .NET Framework build host (Visual Studio's MSBuild) on Windows and the
//! .NET SDK elsewhere: this is what differs between the platforms.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::lsp::{find_csharp_server, roslyn_log_dir, LspEvent, LspServers};

/// The stand-in for Unity's DLLs: the types a script uses.
const STUB: &str = r#"
namespace UnityEngine
{
    public class Object { }
    public class Component : Object { }
    public class Behaviour : Component { }
    public class MonoBehaviour : Behaviour { }
    public struct Vector3 { public float x, y, z; }
    public class Rigidbody : Component { public Vector3 velocity; public void AddForce(Vector3 force) { } }
    public class Rigidbody2D : Component { }
}
"#;

/// An SDK-style project for the stub; also copies the `netstandard.dll` it
/// compiled against, which Unity's projects reference by path.
const STUB_PROJECT: &str = r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>netstandard2.1</TargetFramework>
    <AssemblyName>UnityEngine</AssemblyName>
  </PropertyGroup>
  <Target Name="CopyNetstandard" AfterTargets="Build">
    <Copy SourceFiles="@(ReferencePath)" Condition="'%(Filename)' == 'netstandard'" DestinationFolder="$(OutDir)" />
  </Target>
</Project>
"#;

const SCRIPT: &str =
    "using UnityEngine;\n\npublic class Player : MonoBehaviour\n{\n    Rigidb\n}\n";
/// Just after `Rigidb` (0-based).
const CURSOR: (u32, u32) = (4, 10);

fn build_stub(dir: &Path) -> (PathBuf, PathBuf) {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join("UnityStub.csproj"), STUB_PROJECT).unwrap();
    std::fs::write(dir.join("UnityEngine.cs"), STUB).unwrap();
    let out = dir.join("out");
    let status = Command::new("dotnet")
        .args(["build", "-c", "Release", "-o"])
        .arg(&out)
        .current_dir(dir)
        .status()
        .expect("running dotnet build");
    assert!(status.success(), "building the UnityEngine stub failed");
    let engine = out.join("UnityEngine.dll");
    let netstandard = out.join("netstandard.dll");
    assert!(
        engine.is_file() && netstandard.is_file(),
        "stub output missing in {out:?}"
    );
    (engine, netstandard)
}

fn xml(p: &Path) -> String {
    p.to_string_lossy()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// `Assembly-CSharp.csproj` as Unity's generator writes it (trimmed).
fn unity_csproj(engine: &Path, netstandard: &Path) -> String {
    let script = ["Assets", "Scripts", "Player.cs"].join(std::path::MAIN_SEPARATOR_STR);
    format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="4.0" DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup>
    <LangVersion>9.0</LangVersion>
    <_TargetFrameworkDirectories>non_empty_path_generated_by_unity.rider.package</_TargetFrameworkDirectories>
    <_FullFrameworkReferenceAssemblyPaths>non_empty_path_generated_by_unity.rider.package</_FullFrameworkReferenceAssemblyPaths>
    <DisableHandlePackageFileConflicts>true</DisableHandlePackageFileConflicts>
  </PropertyGroup>
  <PropertyGroup>
    <Configuration Condition=" '$(Configuration)' == '' ">Debug</Configuration>
    <Platform Condition=" '$(Platform)' == '' ">AnyCPU</Platform>
    <ProductVersion>10.0.20506</ProductVersion>
    <SchemaVersion>2.0</SchemaVersion>
    <RootNamespace></RootNamespace>
    <ProjectGuid>{{5742f7d0-b2f6-eadc-fc51-aa11c694d4b0}}</ProjectGuid>
    <ProjectTypeGuids>{{E097FAD1-6243-4DAD-9C02-E9B9EFC3FFC1}};{{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}}</ProjectTypeGuids>
    <OutputType>Library</OutputType>
    <AppDesignerFolder>Properties</AppDesignerFolder>
    <AssemblyName>Assembly-CSharp</AssemblyName>
    <TargetFrameworkVersion>v4.7.1</TargetFrameworkVersion>
    <FileAlignment>512</FileAlignment>
    <BaseDirectory>.</BaseDirectory>
  </PropertyGroup>
  <PropertyGroup Condition=" '$(Configuration)|$(Platform)' == 'Debug|AnyCPU' ">
    <DebugSymbols>true</DebugSymbols>
    <DebugType>full</DebugType>
    <Optimize>false</Optimize>
    <OutputPath>Temp\Bin\Debug\Assembly-CSharp\</OutputPath>
    <DefineConstants>UNITY_EDITOR;NET_STANDARD_2_1;DEBUG;TRACE</DefineConstants>
    <ErrorReport>prompt</ErrorReport>
    <WarningLevel>4</WarningLevel>
    <NoWarn>0169,0649</NoWarn>
    <AllowUnsafeBlocks>False</AllowUnsafeBlocks>
    <TreatWarningsAsErrors>False</TreatWarningsAsErrors>
  </PropertyGroup>
  <PropertyGroup>
    <NoConfig>true</NoConfig>
    <NoStdLib>true</NoStdLib>
    <AddAdditionalExplicitAssemblyReferences>false</AddAdditionalExplicitAssemblyReferences>
    <ImplicitlyExpandNETStandardFacades>false</ImplicitlyExpandNETStandardFacades>
    <ImplicitlyExpandDesignTimeFacades>false</ImplicitlyExpandDesignTimeFacades>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="{script}" />
  </ItemGroup>
  <ItemGroup>
    <Reference Include="UnityEngine">
      <HintPath>{engine}</HintPath>
      <Private>False</Private>
    </Reference>
    <Reference Include="netstandard">
      <HintPath>{netstandard}</HintPath>
      <Private>False</Private>
    </Reference>
  </ItemGroup>
  <Import Project="$(MSBuildToolsPath)\Microsoft.CSharp.targets" />
</Project>
"#,
        engine = xml(engine),
        netstandard = xml(netstandard),
    )
}

const SLN: &str = "\u{feff}\r\nMicrosoft Visual Studio Solution File, Format Version 11.00\r\n# Visual Studio 2010\r\nProject(\"{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}\") = \"Assembly-CSharp\", \"Assembly-CSharp.csproj\", \"{5742f7d0-b2f6-eadc-fc51-aa11c694d4b0}\"\r\nEndProject\r\nGlobal\r\n\tGlobalSection(SolutionConfigurationPlatforms) = preSolution\r\n\t\tDebug|Any CPU = Debug|Any CPU\r\n\tEndGlobalSection\r\n\tGlobalSection(ProjectConfigurationPlatforms) = postSolution\r\n\t\t{5742f7d0-b2f6-eadc-fc51-aa11c694d4b0}.Debug|Any CPU.ActiveCfg = Debug|Any CPU\r\n\t\t{5742f7d0-b2f6-eadc-fc51-aa11c694d4b0}.Debug|Any CPU.Build.0 = Debug|Any CPU\r\n\tEndGlobalSection\r\nEndGlobal\r\n";

/// A file URI as Monaco writes it (`Uri.file(p).toString()`), which is what
/// the UI sends: `file:///c%3A/My%20project%20%282%29/...` on Windows.
fn monaco_uri(p: &Path) -> String {
    let mut s = p.to_string_lossy().replace('\\', "/");
    let b = s.as_bytes();
    if b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
        s = format!("/{}{}", s[..1].to_lowercase(), &s[1..]);
    }
    let mut out = String::from("file://");
    for c in s.chars() {
        match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '.' | '_' | '~' | '/' => out.push(c),
            _ => {
                let mut buf = [0u8; 4];
                for byte in c.encode_utf8(&mut buf).bytes() {
                    out.push_str(&format!("%{byte:02X}"));
                }
            }
        }
    }
    out
}

struct Session {
    servers: LspServers,
    id: u64,
    rx: mpsc::Receiver<LspEvent>,
    next_id: u64,
    /// The server's log and progress lines, printed when the test fails.
    log: Vec<String>,
    initialized: bool,
}

impl Session {
    fn send(&self, msg: Value) {
        self.servers.send(self.id, &msg).unwrap();
    }

    /// Answers what the server asks, like the UI does (src/lib/lsp/csharp.ts).
    fn answer(&self, msg: &Value) {
        let (Some(id), Some(method)) = (msg.get("id"), msg["method"].as_str()) else {
            return;
        };
        let result = match method {
            "workspace/configuration" => Value::Array(
                msg["params"]["items"]
                    .as_array()
                    .map(|items| {
                        items
                            .iter()
                            .map(|i| match i["section"].as_str() {
                                Some("projects.dotnet_enable_automatic_restore") => json!(false),
                                _ => Value::Null,
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
            ),
            _ => Value::Null,
        };
        self.send(json!({"jsonrpc": "2.0", "id": id, "result": result}));
    }

    /// Handles messages until `want` matches one, or `timeout` passes.
    fn wait(&mut self, timeout: Duration, mut want: impl FnMut(&Value) -> bool) -> Option<Value> {
        let end = Instant::now() + timeout;
        loop {
            let left = end.checked_duration_since(Instant::now())?;
            match self.rx.recv_timeout(left) {
                Ok(LspEvent::Message { message, .. }) => {
                    self.answer(&message);
                    match message["method"].as_str() {
                        Some("window/logMessage" | "window/showMessage") => {
                            let p = &message["params"];
                            self.log.push(format!(
                                "[{}] {}",
                                p["type"],
                                p["message"].as_str().unwrap_or("")
                            ));
                        }
                        Some("$/progress") => {
                            let v = &message["params"]["value"];
                            let text = [&v["title"], &v["message"]]
                                .iter()
                                .filter_map(|x| x.as_str())
                                .collect::<Vec<_>>()
                                .join(": ");
                            if !text.is_empty() {
                                self.log.push(format!(
                                    "[progress {}] {text}",
                                    v["kind"].as_str().unwrap_or("")
                                ));
                            }
                        }
                        _ => {}
                    }
                    if want(&message) {
                        return Some(message);
                    }
                }
                Ok(LspEvent::Exit { reason, .. }) => {
                    self.fail(&format!("the server exited: {reason:?}"));
                }
                Err(_) => return None,
            }
        }
    }

    fn request(&mut self, method: &str, params: Value, timeout: Duration) -> Value {
        self.next_id += 1;
        let id = self.next_id;
        self.send(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}));
        let reply = self
            .wait(timeout, |m| {
                m.get("id") == Some(&json!(id)) && m.get("method").is_none()
            })
            .unwrap_or_else(|| self.fail(&format!("no answer to {method}")));
        if let Some(e) = reply.get("error") {
            self.fail(&format!("{method} failed: {e}"));
        }
        reply["result"].clone()
    }

    fn fail(&self, why: &str) -> ! {
        eprintln!("---- server log ({} lines) ----", self.log.len());
        for l in &self.log {
            eprintln!("{l}");
        }
        eprintln!("---- Roslyn's own logs: {:?} ----", roslyn_log_dir());
        panic!("{why} (initialized: {})", self.initialized);
    }
}

fn labels(result: &Value) -> Vec<String> {
    let items = result.get("items").unwrap_or(result);
    items
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|i| i["label"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

#[test]
#[ignore = "needs the .NET SDK and roslyn-language-server; run by the Unity C# completion workflow"]
fn unity_completion_through_roslyn() {
    let cmd = find_csharp_server()
        .filter(|c| c.kind == "roslyn")
        .expect("roslyn-language-server not found (dotnet tool install --global roslyn-language-server --prerelease)");
    eprintln!("server: {} {:?}", cmd.program, cmd.args);

    let tmp = tempfile::tempdir().unwrap();
    let (engine, netstandard) = build_stub(&tmp.path().join("stub"));
    // A name like Unity Hub's default, with a space and brackets.
    let root = tmp.path().join("My project (2)");
    let script = root.join("Assets").join("Scripts").join("Player.cs");
    std::fs::create_dir_all(script.parent().unwrap()).unwrap();
    std::fs::create_dir_all(root.join("ProjectSettings")).unwrap();
    std::fs::write(
        root.join("ProjectSettings").join("ProjectVersion.txt"),
        "m_EditorVersion: 6000.0.0f1\n",
    )
    .unwrap();
    std::fs::write(&script, SCRIPT).unwrap();
    std::fs::write(
        root.join("Assembly-CSharp.csproj"),
        unity_csproj(&engine, &netstandard),
    )
    .unwrap();
    std::fs::write(root.join("My project (2).sln"), SLN).unwrap();
    // The path as the OS gives it, like the project root Haze opens.
    let root = root.canonicalize().map(|p| dunce(&p)).unwrap();
    let script = root.join("Assets").join("Scripts").join("Player.cs");

    let (tx, rx) = mpsc::channel();
    let tx = Mutex::new(tx);
    let servers = LspServers::default();
    let id = servers
        .start(
            &cmd,
            &root,
            Arc::new(move |e| drop(tx.lock().unwrap().send(e))),
        )
        .unwrap();
    let mut s = Session {
        servers,
        id,
        rx,
        next_id: 0,
        log: vec![],
        initialized: false,
    };

    let root_uri = monaco_uri(&root);
    let script_uri = monaco_uri(&script);
    eprintln!("root: {root_uri}\nscript: {script_uri}");
    s.request(
        "initialize",
        json!({
            "processId": null,
            "clientInfo": {"name": "Haze"},
            "rootUri": root_uri,
            "rootPath": root.to_string_lossy(),
            "workspaceFolders": [{"uri": root_uri, "name": "My project (2)"}],
            "capabilities": {
                "workspace": {"workspaceFolders": true, "configuration": true, "didChangeWatchedFiles": {"dynamicRegistration": true}},
                "textDocument": {
                    "synchronization": {"didSave": true},
                    "completion": {"completionItem": {"snippetSupport": true}},
                },
                "window": {"workDoneProgress": true},
            },
        }),
        Duration::from_secs(120),
    );
    s.send(json!({"jsonrpc": "2.0", "method": "initialized", "params": {}}));
    s.initialized = true;

    let loaded = s.wait(Duration::from_secs(300), |m| {
        m["method"] == "workspace/projectInitializationComplete"
    });
    if loaded.is_none() {
        s.fail("projects did not finish loading in 5 minutes");
    }
    eprintln!("projects loaded");

    s.send(json!({"jsonrpc": "2.0", "method": "textDocument/didOpen", "params": {
        "textDocument": {"uri": script_uri, "languageId": "csharp", "version": 1, "text": SCRIPT}
    }}));

    // The file is matched to its project a moment after it opens.
    let mut last = vec![];
    for _ in 0..10 {
        let result = s.request(
            "textDocument/completion",
            json!({
                "textDocument": {"uri": script_uri},
                "position": {"line": CURSOR.0, "character": CURSOR.1},
                "context": {"triggerKind": 1},
            }),
            Duration::from_secs(60),
        );
        last = labels(&result);
        if last.iter().any(|l| l == "Rigidbody") {
            eprintln!("completed Rigidbody among {} items", last.len());
            s.servers.stop(s.id);
            return;
        }
        std::thread::sleep(Duration::from_secs(3));
    }
    let sample: Vec<_> = last.iter().take(40).collect();
    s.fail(&format!(
        "Rigidbody was not completed; {} items, first ones: {sample:?}",
        last.len()
    ));
}

/// `canonicalize` gives `\\?\C:\...` on Windows; the OS's usual spelling is `C:\...`.
fn dunce(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => p.to_path_buf(),
    }
}

#[test]
fn writes_uris_like_monaco() {
    assert_eq!(
        monaco_uri(Path::new("/Users/me/My project (2)/A.cs")),
        "file:///Users/me/My%20project%20%282%29/A.cs"
    );
    assert_eq!(
        monaco_uri(Path::new(r"C:\Users\me\My project (2)\A.cs")),
        "file:///c%3A/Users/me/My%20project%20%282%29/A.cs"
    );
}
