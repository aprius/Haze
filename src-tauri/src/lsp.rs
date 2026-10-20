//! Language server processes (Roslyn for C#). Rust only spawns the server and
//! moves JSON-RPC messages; the protocol logic lives in the UI (src/lib/lsp).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
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
    },
}

struct Server {
    child: Child,
    stdin: ChildStdin,
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

/// Roslyn's `roslyn-language-server` .NET tool first, then `csharp-ls`.
/// `HAZE_CSHARP_SERVER` overrides the program (Roslyn arguments are used).
pub fn find_csharp_server() -> Option<ServerCommand> {
    let roslyn_args = || vec!["--stdio".to_string(), "--autoLoadProjects".to_string()];
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

pub fn write_message<W: Write>(w: &mut W, msg: &serde_json::Value) -> Result<()> {
    let body = serde_json::to_vec(msg)?;
    write!(w, "Content-Length: {}\r\n\r\n", body.len())?;
    w.write_all(&body)?;
    w.flush()?;
    Ok(())
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
        let mut child = command
            .spawn()
            .with_context(|| format!("starting {}", cmd.program))?;
        let stdin = child.stdin.take().context("no stdin")?;
        let stdout = child.stdout.take().context("no stdout")?;
        let stderr = child.stderr.take().context("no stderr")?;
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        self.servers
            .lock()
            .insert(id, Arc::new(Mutex::new(Server { child, stdin })));

        // Drain stderr so the server never blocks on a full pipe.
        thread::spawn(move || {
            let mut sink_buf = Vec::new();
            let _ = BufReader::new(stderr).read_to_end(&mut sink_buf);
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
            });
        });
        Ok(id)
    }

    pub fn send(&self, id: u64, msg: &serde_json::Value) -> Result<()> {
        let server = self.servers.lock().get(&id).cloned();
        let Some(server) = server else {
            bail!("language server {id} is not running")
        };
        let mut s = server.lock();
        write_message(&mut s.stdin, msg)
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
    fn frames_round_trip() {
        let msg = serde_json::json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"x": "ü"}});
        let mut buf = Vec::new();
        write_message(&mut buf, &msg).unwrap();
        write_message(&mut buf, &msg).unwrap();
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
                LspEvent::Exit { .. } => panic!("server exited"),
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
