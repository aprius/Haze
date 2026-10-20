//! UI-side connection to the PTY host.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

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
    for _ in 0..50 {
        thread::sleep(Duration::from_millis(100));
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
