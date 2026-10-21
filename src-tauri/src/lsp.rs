//! Language server processes (Roslyn for C#). Rust only spawns the server and
//! moves JSON-RPC messages; the protocol logic lives in the UI (src/lib/lsp).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;

use anyhow::{bail, Context, Result};
use parking_lot::Mutex;
use serde::Serialize;

pub type MessageSink = Arc<dyn Fn(LspEvent) + Send + Sync>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "t")]
pub enum LspEvent {
    Message {
        server: u64,
        message: serde_json::Value,
    },
    Exit {
        server: u64,
        code: Option<i32>,
        /// The end of the server's stderr: why it stopped, when it says.
        reason: Option<String>,
    },
}

struct Server {
    child: Child,
    /// Framed messages for the writer thread. `lsp_send` runs on the UI
    /// thread, and a server busy loading a solution stops reading its stdin:
    /// writing directly would freeze the window once the pipe is full.
    input: mpsc::Sender<Vec<u8>>,
}

#[derive(Default)]
pub struct LspServers {
    next: AtomicU64,
    servers: Mutex<HashMap<u64, Arc<Mutex<Server>>>>,
}

/// Where a C# language server was found.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerCommand {
    pub kind: &'static str,
    pub program: String,
    pub args: Vec<String>,
}

fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

fn find_in_path(name: &str) -> Option<PathBuf> {
    let file = exe(name);
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .map(|d| d.join(&file))
        .find(|p| p.is_file())
}

fn dotnet_tool(name: &str) -> Option<PathBuf> {
    let p = dirs::home_dir()?
        .join(".dotnet")
        .join("tools")
        .join(exe(name));
    p.is_file().then_some(p)
}

/// Where Roslyn writes its logs (useful when it fails to load a project).
pub fn roslyn_log_dir() -> Option<PathBuf> {
    let dir = dirs::cache_dir()?.join("dev.haze.app").join("roslyn-logs");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// The .NET install that `dotnet` on PATH belongs to. .NET tools (like the
/// language server) find the runtime only through `DOTNET_ROOT` or the
/// default install location, which a Homebrew or user-local .NET is not in.
fn dotnet_root() -> Option<PathBuf> {
    let dotnet = find_in_path("dotnet")?.canonicalize().ok()?;
    let root = dotnet.parent()?;
    root.join("host")
        .join("fxr")
        .is_dir()
        .then(|| root.to_path_buf())
}

/// The last lines of a server's stderr, for the "server stopped" message.
fn stderr_tail(bytes: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(bytes);
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim_end)
        .filter(|l| !l.trim().is_empty())
        .collect();
    let tail = lines[lines.len().saturating_sub(8)..].join("\n");
    let tail = if tail.len() > 1500 {
        let cut = tail
            .char_indices()
            .map(|(i, _)| i)
            .find(|&i| i >= tail.len() - 1500)
            .unwrap_or(0);
        format!("…{}", &tail[cut..])
    } else {
        tail
    };
    (!tail.is_empty()).then_some(tail)
}

/// Roslyn's `roslyn-language-server` .NET tool first, then `csharp-ls`.
/// `HAZE_CSHARP_SERVER` overrides the program (Roslyn arguments are used).
pub fn find_csharp_server() -> Option<ServerCommand> {
    let roslyn_args = || {
        let mut args = vec!["--stdio".to_string(), "--autoLoadProjects".to_string()];
        if let Some(dir) = roslyn_log_dir() {
            args.extend([
                "--logLevel".to_string(),
                "Information".to_string(),
                "--extensionLogDirectory".to_string(),
                dir.to_string_lossy().into_owned(),
            ]);
        }
        args
    };
    if let Ok(p) = std::env::var("HAZE_CSHARP_SERVER") {
        return Some(ServerCommand {
            kind: "roslyn",
            program: p,
            args: roslyn_args(),
        });
    }
    if let Some(p) =
        find_in_path("roslyn-language-server").or_else(|| dotnet_tool("roslyn-language-server"))
    {
        return Some(ServerCommand {
            kind: "roslyn",
            program: p.to_string_lossy().into_owned(),
            args: roslyn_args(),
        });
    }
    if let Some(p) = find_in_path("csharp-ls").or_else(|| dotnet_tool("csharp-ls")) {
        return Some(ServerCommand {
            kind: "csharp-ls",
            program: p.to_string_lossy().into_owned(),
            args: vec![],
        });
    }
    None
}

/// Reads one `Content-Length` framed message; `Ok(None)` at end of stream.
pub fn read_message<R: BufRead>(r: &mut R) -> Result<Option<serde_json::Value>> {
    let mut len: Option<usize> = None;
    let mut line = String::new();
    loop {
        line.clear();
        if r.read_line(&mut line)? == 0 {
            return Ok(None);
        }
        let l = line.trim_end();
        if l.is_empty() {
            break;
        }
        if let Some(v) = l.strip_prefix("Content-Length:") {
            len = Some(v.trim().parse().context("bad Content-Length")?);
        }
    }
    let len = len.context("message without Content-Length")?;
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf)?;
    Ok(Some(serde_json::from_slice(&buf)?))
}

pub fn frame_message(msg: &serde_json::Value) -> Result<Vec<u8>> {
    let body = serde_json::to_vec(msg)?;
    let mut frame = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    frame.extend_from_slice(&body);
    Ok(frame)
}

impl LspServers {
    pub fn start(&self, cmd: &ServerCommand, cwd: &Path, sink: MessageSink) -> Result<u64> {
        let mut command = Command::new(&cmd.program);
        command
            .args(&cmd.args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        if std::env::var_os("DOTNET_ROOT").is_none() {
            if let Some(root) = dotnet_root() {
                command.env("DOTNET_ROOT", root);
            }
        }
        let mut child = command
            .spawn()
            .with_context(|| format!("starting {}", cmd.program))?;
        let mut stdin = child.stdin.take().context("no stdin")?;
        let stdout = child.stdout.take().context("no stdout")?;
        let stderr = child.stderr.take().context("no stderr")?;
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (input, frames) = mpsc::channel::<Vec<u8>>();
        self.servers
            .lock()
            .insert(id, Arc::new(Mutex::new(Server { child, input })));

        thread::spawn(move || {
            for frame in frames {
                if stdin
                    .write_all(&frame)
                    .and_then(|()| stdin.flush())
                    .is_err()
                {
                    break;
                }
            }
        });

        // Drain stderr so the server never blocks on a full pipe; keep its end.
        let stderr_reader = thread::spawn(move || {
            const KEEP: usize = 16 * 1024;
            let mut reader = BufReader::new(stderr);
            let mut kept = Vec::new();
            let mut buf = [0u8; 4096];
            while let Ok(n @ 1..) = reader.read(&mut buf) {
                kept.extend_from_slice(&buf[..n]);
                if kept.len() > 2 * KEEP {
                    kept.drain(..kept.len() - KEEP);
                }
            }
            stderr_tail(&kept)
        });
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            while let Ok(Some(message)) = read_message(&mut reader) {
                sink(LspEvent::Message {
                    server: id,
                    message,
                });
            }
            sink(LspEvent::Exit {
                server: id,
                code: None,
                reason: stderr_reader.join().ok().flatten(),
            });
        });
        Ok(id)
    }

    pub fn send(&self, id: u64, msg: &serde_json::Value) -> Result<()> {
        let server = self.servers.lock().get(&id).cloned();
        let Some(server) = server else {
            bail!("language server {id} is not running")
        };
        let frame = frame_message(msg)?;
        let sent = server.lock().input.send(frame);
        sent.map_err(|_| anyhow::anyhow!("language server {id} stopped reading"))
    }

    pub fn stop(&self, id: u64) {
        if let Some(server) = self.servers.lock().remove(&id) {
            let mut s = server.lock();
            let _ = s.child.kill();
            let _ = s.child.wait();
        }
    }

    pub fn stop_all(&self) {
        let ids: Vec<u64> = self.servers.lock().keys().copied().collect();
        for id in ids {
            self.stop(id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_end_of_stderr() {
        let mut err = b"\n".repeat(3);
        for i in 0..20 {
            err.extend(format!("line {i}\n").bytes());
        }
        let tail = stderr_tail(&err).unwrap();
        assert!(tail.starts_with("line 12") && tail.ends_with("line 19"));
        assert_eq!(stderr_tail(b"  \n"), None);
    }

    #[cfg(unix)]
    #[test]
    fn reports_why_a_server_exited() {
        let servers = LspServers::default();
        let cmd = ServerCommand {
            kind: "roslyn",
            program: "sh".into(),
            args: vec![
                "-c".into(),
                "echo 'You must install .NET' >&2; exit 1".into(),
            ],
        };
        let (tx, rx) = std::sync::mpsc::channel();
        let tx = std::sync::Mutex::new(tx);
        let sink: MessageSink = Arc::new(move |e| {
            let _ = tx.lock().unwrap().send(e);
        });
        servers.start(&cmd, Path::new("."), sink).unwrap();
        match rx.recv_timeout(std::time::Duration::from_secs(10)).unwrap() {
            LspEvent::Exit { reason, .. } => {
                assert_eq!(reason.as_deref(), Some("You must install .NET"))
            }
            e => panic!("unexpected {e:?}"),
        }
    }

    #[test]
    fn frames_round_trip() {
        let msg = serde_json::json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"x": "ü"}});
        let mut buf = frame_message(&msg).unwrap();
        buf.extend(frame_message(&msg).unwrap());
        let mut r = BufReader::new(&buf[..]);
        assert_eq!(read_message(&mut r).unwrap(), Some(msg.clone()));
        assert_eq!(read_message(&mut r).unwrap(), Some(msg));
        assert_eq!(read_message(&mut r).unwrap(), None);
    }

    /// Talks to a real Roslyn server when one is installed (skipped otherwise).
    #[test]
    fn roslyn_initializes_when_installed() {
        let Some(cmd) = find_csharp_server().filter(|c| c.kind == "roslyn") else {
            eprintln!("roslyn-language-server not installed; skipping");
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let servers = LspServers::default();
        let (tx, rx) = std::sync::mpsc::channel();
        let tx = std::sync::Mutex::new(tx);
        let id = servers
            .start(
                &cmd,
                dir.path(),
                Arc::new(move |e| {
                    let _ = tx.lock().unwrap().send(e);
                }),
            )
            .unwrap();
        servers
            .send(
                id,
                &serde_json::json!({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                    "params": {"processId": null, "rootUri": null, "capabilities": {}}}),
            )
            .unwrap();
        let reply = loop {
            match rx.recv_timeout(std::time::Duration::from_secs(60)).unwrap() {
                LspEvent::Message { message, .. }
                    if message.get("id") == Some(&serde_json::json!(1)) =>
                {
                    break message
                }
                LspEvent::Exit { reason, .. } => panic!("server exited: {reason:?}"),
                _ => continue,
            }
        };
        assert!(
            reply["result"]["capabilities"]["definitionProvider"]
                .as_bool()
                .unwrap_or(false)
                || reply["result"]["capabilities"]["definitionProvider"].is_object()
        );
        servers.stop(id);
    }
}
