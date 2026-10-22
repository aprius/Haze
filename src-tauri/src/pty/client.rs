//! UI-side connection to the PTY host.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use interprocess::local_socket::{prelude::*, Stream};
use parking_lot::Mutex;

use super::protocol::*;
use super::{socket_name, HOST_FLAG};

type Pending = Arc<Mutex<HashMap<u64, mpsc::Sender<Reply>>>>;

struct Connection {
    stream: Arc<Stream>,
    pending: Pending,
    /// Serializes frame writes coming from concurrent commands.
    write_lock: Mutex<()>,
}

/// Delivers host events (and a `None` on disconnect) to the UI.
pub type EventSink = Arc<dyn Fn(Option<Event>) + Send + Sync>;

/// How long output keeps being merged once a terminal is streaming.
const OUTPUT_BATCH: Duration = Duration::from_millis(5);
/// Merged output is cut at this size, so one event never gets huge.
const MAX_MERGED: usize = 256 * 1024;

/// Wraps `sink` so a stream of output reaches it as a few large events instead
/// of one per PTY read (each is a script evaluated by the webview, and a build
/// log or a `cat` makes thousands per second). The first event after a quiet
/// moment passes at once, so typing is not delayed; while output keeps coming,
/// consecutive chunks of a terminal are merged every `OUTPUT_BATCH`.
pub fn batched(sink: EventSink) -> EventSink {
    use base64::Engine;
    use mpsc::RecvTimeoutError;

    enum Item {
        Output { id: String, data: Vec<u8> },
        Other(Option<Event>),
    }
    let b64 = base64::engine::general_purpose::STANDARD;

    let (tx, rx) = mpsc::channel::<Option<Event>>();
    thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            sink(first);
            loop {
                let mut batch: Vec<Item> = Vec::new();
                let deadline = Instant::now() + OUTPUT_BATCH;
                let mut closed = false;
                while let Some(left) = deadline.checked_duration_since(Instant::now()) {
                    let ev = match rx.recv_timeout(left) {
                        Ok(ev) => ev,
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => {
                            closed = true;
                            break;
                        }
                    };
                    let Some(Event::Output { id, data }) = ev else {
                        batch.push(Item::Other(ev));
                        continue;
                    };
                    let Ok(bytes) = b64.decode(&data) else {
                        batch.push(Item::Other(Some(Event::Output { id, data })));
                        continue;
                    };
                    match batch.last_mut() {
                        Some(Item::Output { id: last, data })
                            if *last == id && data.len() < MAX_MERGED =>
                        {
                            data.extend_from_slice(&bytes)
                        }
                        _ => batch.push(Item::Output { id, data: bytes }),
                    }
                }
                let idle = batch.is_empty();
                for item in batch {
                    sink(match item {
                        Item::Output { id, data } => Some(Event::Output {
                            id,
                            data: b64.encode(data),
                        }),
                        Item::Other(ev) => ev,
                    });
                }
                if closed {
                    return;
                }
                if idle {
                    break;
                }
            }
        }
    });
    Arc::new(move |ev| {
        let _ = tx.send(ev);
    })
}

pub struct PtyClient {
    conn: Mutex<Option<Arc<Connection>>>,
    next_req: AtomicU64,
    sink: EventSink,
}

impl PtyClient {
    pub fn new(sink: EventSink) -> Self {
        Self {
            conn: Mutex::new(None),
            next_req: AtomicU64::new(1),
            sink,
        }
    }

    fn connection(&self) -> Result<Arc<Connection>> {
        let mut guard = self.conn.lock();
        if let Some(c) = guard.as_ref() {
            return Ok(c.clone());
        }
        let stream = connect_or_spawn()?;
        let conn = Arc::new(Connection {
            stream: Arc::new(stream),
            pending: Default::default(),
            write_lock: Mutex::new(()),
        });
        spawn_reader(conn.clone(), self.sink.clone());
        *guard = Some(conn.clone());
        drop(guard);
        match self.request(Request::Hello {
            version: PROTOCOL_VERSION,
        })? {
            Reply::Hello { version, .. } if version == PROTOCOL_VERSION => Ok(conn),
            other => {
                *self.conn.lock() = None;
                bail!("PTY host handshake failed: {other:?}")
            }
        }
    }

    fn send(&self, req: u64, body: Request) -> Result<Arc<Connection>> {
        let conn = self.connection()?;
        let result = {
            let _guard = conn.write_lock.lock();
            let mut w = &*conn.stream;
            write_frame(&mut w, &ClientMsg { req, body })
        };
        if let Err(e) = result {
            *self.conn.lock() = None;
            return Err(e).context("PTY host connection lost");
        }
        Ok(conn)
    }

    pub fn request(&self, body: Request) -> Result<Reply> {
        let req = self.next_req.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        let conn = {
            let conn = self.conn.lock().clone();
            match conn {
                Some(c) => c,
                None => self.connection()?,
            }
        };
        conn.pending.lock().insert(req, tx);
        if let Err(e) = self.send(req, body) {
            conn.pending.lock().remove(&req);
            return Err(e);
        }
        let reply = rx
            .recv_timeout(Duration::from_secs(15))
            .map_err(|_| anyhow!("PTY host did not answer"))?;
        match reply {
            Reply::Error { message } => Err(anyhow!(message)),
            r => Ok(r),
        }
    }

    /// Connects now, starting the host if none is running, so the first
    /// terminal does not wait for it.
    pub fn warm(&self) {
        let _ = self.connection();
    }

    /// Fire-and-forget request (input, resize, attach).
    pub fn notify(&self, body: Request) -> Result<()> {
        self.send(0, body).map(|_| ())
    }
}

fn spawn_reader(conn: Arc<Connection>, sink: EventSink) {
    thread::spawn(move || {
        let mut r = &*conn.stream;
        while let Ok(Some(msg)) = read_frame::<_, ServerMsg>(&mut r) {
            match msg {
                ServerMsg::Reply { req, body } => {
                    if let Some(tx) = conn.pending.lock().remove(&req) {
                        let _ = tx.send(body);
                    }
                }
                ServerMsg::Event { body } => sink(Some(body)),
            }
        }
        conn.pending.lock().clear();
        sink(None);
    });
}

fn connect_or_spawn() -> Result<Stream> {
    if let Ok(s) = Stream::connect(socket_name()?) {
        return Ok(s);
    }
    spawn_host()?;
    // The host binds its socket within a few milliseconds of starting.
    for _ in 0..500 {
        thread::sleep(Duration::from_millis(10));
        if let Ok(s) = Stream::connect(socket_name()?) {
            return Ok(s);
        }
    }
    bail!("could not start the terminal host")
}

fn spawn_host() -> Result<()> {
    let exe = std::env::current_exe()?;
    let mut cmd = std::process::Command::new(exe);
    cmd.arg(HOST_FLAG)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // New session: the host must not die with our terminal or process group.
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }
    cmd.spawn().context("spawning terminal host")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use base64::Engine;

    use super::*;

    #[test]
    fn batching_merges_output_and_keeps_order() {
        let b64 = base64::engine::general_purpose::STANDARD;
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let sink = batched(Arc::new(move |ev| {
            let _ = tx.lock().send(ev);
        }));
        let output = |id: &str, text: &str| {
            Some(Event::Output {
                id: id.into(),
                data: b64.encode(text),
            })
        };
        for i in 0..1000 {
            sink(output("a", &format!("{i},")));
        }
        sink(output("b", "other"));
        sink(Some(Event::Exit {
            id: "a".into(),
            code: Some(0),
        }));
        sink(None);

        let mut got = Vec::new();
        while let Ok(ev) = rx.recv_timeout(Duration::from_secs(5)) {
            let end = ev.is_none();
            got.push(ev);
            if end {
                break;
            }
        }
        assert!(got.len() < 100, "{} events", got.len());
        let mut a = String::new();
        let mut rest = Vec::new();
        for ev in got {
            match ev {
                Some(Event::Output { id, data }) if id == "a" => {
                    assert!(rest.is_empty(), "output of a after later events");
                    a.push_str(&String::from_utf8(b64.decode(data).unwrap()).unwrap());
                }
                other => rest.push(other),
            }
        }
        let expected: String = (0..1000).map(|i| format!("{i},")).collect();
        assert_eq!(a, expected);
        assert!(matches!(&rest[0], Some(Event::Output { id, .. }) if id == "b"));
        assert!(matches!(&rest[1], Some(Event::Exit { .. })));
        assert!(rest[2].is_none());
    }
}
