//! Live link to a Unity Editor running the `com.aprius.ide.haze` package. Unity
//! listens on 127.0.0.1 and writes its port and a token to
//! `Library/Haze/EditorInstance.json`; Haze connects, says hello with the
//! token, then both sides exchange one JSON object per line (see
//! `HazeLink.cs`). Unity drops the connection on every domain reload and
//! listens again on the same port, so the link reconnects on its own.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{Shutdown, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use anyhow::{Context, Result};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

/// How often a disconnected link looks for Unity again.
const RETRY: Duration = Duration::from_millis(1000);
/// Most messages per event to the UI: a Debug.Log every frame arrives in bursts.
const MAX_BATCH: usize = 500;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnityEvent {
    pub root: String,
    /// Messages from Unity in the order sent, or `{"t":"link","connected":bool}` from Haze.
    pub events: Vec<serde_json::Value>,
}

pub type UnitySink = Arc<dyn Fn(UnityEvent) + Send + Sync>;

#[derive(Deserialize)]
struct Instance {
    port: u16,
    token: String,
}

#[derive(Default)]
struct Link {
    stop: AtomicBool,
    stream: Mutex<Option<TcpStream>>,
}

impl Link {
    fn close(&self) {
        if let Some(s) = self.stream.lock().take() {
            let _ = s.shutdown(Shutdown::Both);
        }
    }
}

#[derive(Default)]
pub struct UnityLinks {
    links: Mutex<HashMap<String, Arc<Link>>>,
}

pub fn is_unity_project(root: &Path) -> bool {
    root.join("Assets").is_dir() && root.join("ProjectSettings").is_dir()
}

fn instance_path(root: &Path) -> PathBuf {
    root.join("Library").join("Haze").join("EditorInstance.json")
}

impl UnityLinks {
    /// Keeps a link to the Unity Editor of `root` until `disconnect`. False
    /// (and nothing started) when `root` is not a Unity project.
    pub fn connect(&self, root: &str, sink: UnitySink) -> bool {
        if !is_unity_project(Path::new(root)) {
            return false;
        }
        let mut links = self.links.lock();
        if links.contains_key(root) {
            return true;
        }
        let link = Arc::new(Link::default());
        links.insert(root.to_string(), link.clone());
        let root = root.to_string();
        thread::Builder::new()
            .name("unity link".into())
            .spawn(move || run(&link, &root, &sink))
            .is_ok()
    }

    pub fn disconnect(&self, root: &str) {
        if let Some(link) = self.links.lock().remove(root) {
            link.stop.store(true, Ordering::Relaxed);
            link.close();
        }
    }

    /// Sends a command to Unity; false when it is not connected.
    pub fn send(&self, root: &str, message: &serde_json::Value) -> bool {
        let Some(link) = self.links.lock().get(root).cloned() else {
            return false;
        };
        let mut stream = link.stream.lock();
        let Some(s) = stream.as_mut() else {
            return false;
        };
        let mut line = message.to_string();
        line.push('\n');
        if s.write_all(line.as_bytes()).is_ok() {
            return true;
        }
        if let Some(s) = stream.take() {
            let _ = s.shutdown(Shutdown::Both);
        }
        false
    }
}

fn run(link: &Link, root: &str, sink: &UnitySink) {
    let emit = |events: Vec<serde_json::Value>| {
        sink(UnityEvent {
            root: root.to_string(),
            events,
        })
    };
    while !link.stop.load(Ordering::Relaxed) {
        let Ok(stream) = open(Path::new(root)) else {
            thread::sleep(RETRY);
            continue;
        };
        let Ok(writer) = stream.try_clone() else {
            thread::sleep(RETRY);
            continue;
        };
        *link.stream.lock() = Some(writer);
        if link.stop.load(Ordering::Relaxed) {
            link.close();
            break;
        }
        emit(vec![serde_json::json!({ "t": "link", "connected": true })]);
        // Lines already received go out together: one UI event per burst, not per line.
        let mut reader = BufReader::new(stream);
        let mut batch = Vec::new();
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(n) if n > 0 => {
                    if let Ok(event) = serde_json::from_str::<serde_json::Value>(&line) {
                        batch.push(event);
                    }
                    if reader.buffer().is_empty() || batch.len() >= MAX_BATCH {
                        emit(std::mem::take(&mut batch));
                    }
                }
                _ => break,
            }
        }
        if !batch.is_empty() {
            emit(batch);
        }
        link.close();
        emit(vec![serde_json::json!({ "t": "link", "connected": false })]);
        if !link.stop.load(Ordering::Relaxed) {
            thread::sleep(RETRY);
        }
    }
}

/// Connects to the Unity Editor listed in the project's instance file and says hello.
fn open(root: &Path) -> Result<TcpStream> {
    let text = std::fs::read_to_string(instance_path(root))?;
    let instance: Instance = serde_json::from_str(&text).context("instance file")?;
    let addr = SocketAddr::from(([127, 0, 0, 1], instance.port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(500))?;
    stream.set_nodelay(true)?;
    let hello = serde_json::json!({ "t": "hello", "token": instance.token });
    stream.write_all(format!("{hello}\n").as_bytes())?;
    Ok(stream)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::mpsc;

    fn unity_project() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for d in ["Assets", "ProjectSettings", "Library/Haze"] {
            std::fs::create_dir_all(dir.path().join(d)).unwrap();
        }
        dir
    }

    fn write_instance(root: &Path, port: u16) {
        let json = format!(r#"{{"port":{port},"pid":1,"token":"secret","unity":"6000.0.0f1"}}"#);
        std::fs::write(instance_path(root), json).unwrap();
    }

    #[test]
    fn ignores_folders_that_are_not_unity_projects() {
        let dir = tempfile::tempdir().unwrap();
        let links = UnityLinks::default();
        assert!(!links.connect(dir.path().to_str().unwrap(), Arc::new(|_| {})));
    }

    #[test]
    fn exchanges_lines_and_reconnects() {
        let dir = unity_project();
        let root = dir.path().to_str().unwrap().to_string();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        write_instance(dir.path(), listener.local_addr().unwrap().port());

        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let links = UnityLinks::default();
        assert!(links.connect(&root, Arc::new(move |e| tx.lock().send(e).unwrap())));
        let next = || {
            let mut events = rx.recv_timeout(Duration::from_secs(5)).unwrap().events;
            assert_eq!(events.len(), 1);
            events.remove(0)
        };

        // Unity's side: check the hello, send a message, read a command.
        let (stream, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut hello = String::new();
        reader.read_line(&mut hello).unwrap();
        assert_eq!(hello.trim(), r#"{"t":"hello","token":"secret"}"#);
        assert_eq!(next()["connected"], true);
        (&stream).write_all(b"{\"t\":\"state\",\"playing\":true}\nnot json\n").unwrap();
        assert_eq!(next()["playing"], true);
        // A burst comes as one event.
        (&stream).write_all(b"{\"t\":\"log\",\"message\":\"a\"}\n{\"t\":\"log\",\"message\":\"b\"}\n").unwrap();
        let burst = rx.recv_timeout(Duration::from_secs(5)).unwrap().events;
        assert_eq!(burst.iter().map(|e| e["message"].as_str().unwrap()).collect::<Vec<_>>(), ["a", "b"]);
        assert!(links.send(&root, &serde_json::json!({ "t": "play" })));
        let mut command = String::new();
        reader.read_line(&mut command).unwrap();
        assert_eq!(command.trim(), r#"{"t":"play"}"#);

        // A domain reload: Unity closes the connection and listens again.
        drop(reader);
        drop(stream);
        assert_eq!(next()["connected"], false);
        let (again, _) = listener.accept().unwrap();
        assert_eq!(next()["connected"], true);

        links.disconnect(&root);
        assert_eq!(next()["connected"], false);
        assert!(!links.send(&root, &serde_json::json!({ "t": "play" })));
        drop(again);
    }
}
