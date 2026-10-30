//! The detached PTY host process.

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use base64::Engine;
use interprocess::local_socket::{prelude::*, ListenerOptions, Stream};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};

use super::osc::{next_status, OscScanner, Signal};
use super::protocol::*;
use super::{now_ms, socket_name};

/// Output kept per session for replay after reattaching.
const SCROLLBACK_BYTES: usize = 4 * 1024 * 1024;
/// The host exits after this long with no clients and no running session.
const IDLE_EXIT: Duration = Duration::from_secs(60);

type ClientId = u64;

struct Session {
    info: SessionInfo,
    master: Box<dyn MasterPty + Send>,
    /// Input goes through a writer thread: a blocking PTY write must never
    /// hold the session lock, or the output reader stalls and both sides
    /// wait on each other (a large paste into a busy program).
    input: Sender<Vec<u8>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// Started as the user's shell, not as a given command.
    shell: bool,
    scrollback: Scrollback,
    subscribers: HashSet<ClientId>,
    /// Reads agent states from the output (see `osc`).
    osc: OscScanner,
    /// The agent state came from a hook; then the output's sequences are ignored.
    agent_from_hook: bool,
    /// Foreground process group when the output last named the agent (Unix).
    osc_group: Option<i32>,
}

#[derive(Default)]
pub(crate) struct Scrollback {
    buf: VecDeque<u8>,
}

impl Scrollback {
    pub(crate) fn push(&mut self, data: &[u8]) {
        self.buf.extend(data);
        if self.buf.len() > SCROLLBACK_BYTES {
            let mut cut = self.buf.len() - SCROLLBACK_BYTES;
            // Prefer to cut right after a newline so replay starts on a clean line.
            if let Some(nl) = self
                .buf
                .range(cut..)
                .take(64 * 1024)
                .position(|&b| b == b'\n')
            {
                cut += nl + 1;
            }
            self.buf.drain(..cut);
        }
    }

    pub(crate) fn bytes(&self) -> Vec<u8> {
        self.buf.iter().copied().collect()
    }
}

#[derive(Default)]
struct Host {
    sessions: Mutex<HashMap<String, Arc<Mutex<Session>>>>,
    clients: Mutex<HashMap<ClientId, Sender<ServerMsg>>>,
    last_activity: Mutex<Option<Instant>>,
}

fn b64(data: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(data)
}

/// Entry point for `haze --pty-host`.
pub fn run() -> Result<()> {
    let name = socket_name()?;
    // Another live host owns the socket: nothing to do.
    if Stream::connect(name.clone()).is_ok() {
        return Ok(());
    }
    let listener = ListenerOptions::new()
        .name(name)
        .try_overwrite(true)
        .create_sync()
        .context("binding PTY host socket")?;

    let host = Arc::new(Host::default());
    *host.last_activity.lock() = Some(Instant::now());
    spawn_idle_watchdog(host.clone());

    let next_client = AtomicU64::new(1);
    for conn in listener.incoming() {
        let Ok(conn) = conn else { continue };
        let id = next_client.fetch_add(1, Ordering::Relaxed);
        let host = host.clone();
        thread::spawn(move || serve_client(host, id, conn));
    }
    Ok(())
}

fn spawn_idle_watchdog(host: Arc<Host>) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(5));
        // Its own statement: the guard would otherwise live through the whole
        // `let`, and an output reader holding a session lock waits for
        // `clients` (see `broadcast`) while this waits for that session.
        let has_clients = !host.clients.lock().is_empty();
        let busy = has_clients || host.sessions.lock().values().any(|s| s.lock().info.running);
        let mut last = host.last_activity.lock();
        if busy {
            *last = Some(Instant::now());
        } else if last.map(|t| t.elapsed() > IDLE_EXIT).unwrap_or(true) {
            #[cfg(not(windows))]
            if let Ok(path) = super::socket_path() {
                let _ = std::fs::remove_file(path);
            }
            std::process::exit(0);
        }
    });
}

fn serve_client(host: Arc<Host>, client: ClientId, conn: Stream) {
    let conn = Arc::new(conn);
    let (tx, rx) = mpsc::channel::<ServerMsg>();
    host.clients.lock().insert(client, tx.clone());

    let writer_conn = conn.clone();
    let writer = thread::spawn(move || {
        let mut w = &*writer_conn;
        for msg in rx {
            if write_frame(&mut w, &msg).is_err() {
                break;
            }
        }
    });

    let mut r = &*conn;
    while let Ok(Some(msg)) = read_frame::<_, ClientMsg>(&mut r) {
        let reply = handle(&host, client, msg.body);
        if msg.req != 0 {
            let _ = tx.send(ServerMsg::Reply {
                req: msg.req,
                body: reply,
            });
        }
    }

    host.clients.lock().remove(&client);
    for s in host.sessions.lock().values() {
        s.lock().subscribers.remove(&client);
    }
    drop(tx);
    let _ = writer.join();
}

fn handle(host: &Arc<Host>, client: ClientId, req: Request) -> Reply {
    let result = match req {
        Request::Hello { .. } => {
            return Reply::Hello {
                version: PROTOCOL_VERSION,
                pid: std::process::id(),
            }
        }
        Request::List => {
            let mut sessions: Vec<SessionInfo> = host
                .sessions
                .lock()
                .values()
                .map(|s| {
                    let s = s.lock();
                    SessionInfo {
                        busy: Some(busy(&s)),
                        ..s.info.clone()
                    }
                })
                .collect();
            sessions.sort_by_key(|s| s.created_at);
            return Reply::Sessions { sessions };
        }
        Request::Create { spec } => match create(host, spec) {
            Ok(session) => {
                return Reply::Created {
                    session: Box::new(session),
                }
            }
            Err(e) => Err(e),
        },
        Request::Attach { id } => with_session(host, &id, |s| {
            // Snapshot and subscription happen under the session lock, so the
            // reader thread cannot slip output in between them.
            let snapshot = ServerMsg::Event {
                body: Event::Snapshot {
                    id: id.clone(),
                    data: b64(&s.scrollback.bytes()),
                    size: s.master.get_size().ok().map(|z| (z.cols, z.rows)),
                },
            };
            if let Some(tx) = host.clients.lock().get(&client) {
                let _ = tx.send(snapshot);
                if !s.info.running {
                    let _ = tx.send(ServerMsg::Event {
                        body: Event::Exit {
                            id: id.clone(),
                            code: s.info.exit_code,
                        },
                    });
                }
            }
            s.subscribers.insert(client);
            Ok(())
        }),
        Request::Detach { id } => with_session(host, &id, |s| {
            s.subscribers.remove(&client);
            Ok(())
        }),
        Request::Write { id, data } => with_session(host, &id, |s| {
            s.input
                .send(data.into_bytes())
                .map_err(|_| anyhow::anyhow!("terminal input is closed"))
        }),
        Request::Resize { id, cols, rows } => with_session(host, &id, |s| {
            s.master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })?;
            Ok(())
        }),
        Request::Close { id } => {
            if let Some(s) = host.sessions.lock().remove(&id) {
                let mut s = s.lock();
                if s.info.running {
                    let _ = s.killer.kill();
                }
            }
            Ok(())
        }
        Request::Agent { id, status } => with_session(host, &id, |s| {
            s.agent_from_hook = status.is_some();
            set_agent(host, &id, s, status);
            Ok(())
        }),
        Request::Check { id, check } => with_session(host, &id, |s| {
            let status = s
                .info
                .agent
                .clone()
                .context("no agent is known in this terminal")?;
            set_agent(host, &id, s, Some(with_check(status, check)));
            Ok(())
        }),
    };
    match result {
        Ok(()) => Reply::Ok,
        Err(e) => Reply::Error {
            message: format!("{e:#}"),
        },
    }
}

/// Sets a session's agent state and, when it changed, tells every client: a
/// tab not attached right now still shows it. A repeated state is still
/// kept, with its time: `haze wait` looks for one reported after it started.
fn set_agent(host: &Host, id: &str, s: &mut Session, status: Option<AgentStatus>) {
    let status = carry_checks(s.info.agent.as_ref(), status);
    let key = |a: &Option<AgentStatus>| {
        a.as_ref().map(|a| {
            (
                a.agent.clone(),
                a.state.clone(),
                a.message.clone(),
                a.checks.clone(),
            )
        })
    };
    let changed = key(&s.info.agent) != key(&status);
    s.info.agent = status.clone();
    if !changed {
        return;
    }
    for tx in host.clients.lock().values() {
        let _ = tx.send(ServerMsg::Event {
            body: Event::Agent {
                id: id.to_string(),
                status: status.clone(),
            },
        });
    }
}

/// A turn's checks stay with the state that ends it (done, waiting…), and
/// go when the same agent works again or another one takes the terminal.
fn carry_checks(prev: Option<&AgentStatus>, next: Option<AgentStatus>) -> Option<AgentStatus> {
    let mut next = next?;
    if let Some(prev) = prev {
        let new_turn = matches!(next.state.as_str(), "working" | "idle");
        if next.checks.is_empty() && !new_turn && prev.agent == next.agent {
            next.checks = prev.checks.clone();
        }
    }
    Some(next)
}

/// `status` with `check` added, or replacing the check of the same name in place.
fn with_check(mut status: AgentStatus, check: Check) -> AgentStatus {
    match status.checks.iter_mut().find(|c| c.name == check.name) {
        Some(c) => *c = check,
        None => status.checks.push(check),
    }
    status
}

/// Applies what the output's escape sequences say, unless a hook reports
/// this terminal's agent (hooks know better). Haze's sequence always counts;
/// a notification counts when it names an agent; otherwise notifications and
/// progress bars only update the agent the output named, while that program
/// is still in front: `dotnet build` run after the agent exited draws a
/// progress bar too.
fn apply_signals(host: &Host, id: &str, s: &mut Session, signals: Vec<Signal>) {
    for signal in signals {
        if s.agent_from_hook {
            return;
        }
        let group = foreground_group(s);
        let known = s.info.agent.clone().filter(|_| s.osc_group == group);
        let Some(next) = next_status(signal, known, now_ms()) else {
            continue;
        };
        s.osc_group = group;
        set_agent(host, id, s, next);
    }
}

/// The program in front of the terminal, as its process group (Unix only).
fn foreground_group(s: &Session) -> Option<i32> {
    #[cfg(unix)]
    {
        s.master.process_group_leader()
    }
    #[cfg(not(unix))]
    {
        let _ = s;
        None
    }
}

/// Whether closing would stop a program: anything but a shell at its prompt.
fn busy(s: &Session) -> bool {
    if !s.info.running {
        return false;
    }
    if !s.shell {
        return true;
    }
    #[cfg(unix)]
    {
        // At the prompt the shell's own process group is in the foreground;
        // a command it runs gets a group of its own.
        match (s.master.process_group_leader(), s.info.pid) {
            (Some(group), Some(pid)) => group as u32 != pid,
            _ => true,
        }
    }
    #[cfg(windows)]
    {
        s.info
            .pid
            .and_then(crate::procinfo::has_children)
            .unwrap_or(true)
    }
}

fn with_session(host: &Host, id: &str, f: impl FnOnce(&mut Session) -> Result<()>) -> Result<()> {
    let session = host.sessions.lock().get(id).cloned();
    let session = session.with_context(|| format!("no terminal session {id}"))?;
    let mut s = session.lock();
    f(&mut s)
}

fn build_command(spec: &SessionSpec, id: &str) -> CommandBuilder {
    let mut cmd = match &spec.command {
        Some(argv) if !argv.is_empty() => {
            let mut c = CommandBuilder::new(&argv[0]);
            c.args(&argv[1..]);
            c
        }
        _ => default_shell(),
    };
    cmd.cwd(&spec.cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "Haze");
    cmd.env("HAZE_TERMINAL_ID", id);
    for (k, v) in &spec.env {
        cmd.env(k, v);
    }
    cmd
}

#[cfg(windows)]
fn default_shell() -> CommandBuilder {
    let has = |exe: &str| {
        std::env::var_os("PATH")
            .map(|p| std::env::split_paths(&p).any(|d| d.join(exe).is_file()))
            .unwrap_or(false)
    };
    if has("pwsh.exe") {
        CommandBuilder::new("pwsh.exe")
    } else {
        CommandBuilder::new("powershell.exe")
    }
}

#[cfg(not(windows))]
fn default_shell() -> CommandBuilder {
    // Starts the user's login shell, like a terminal emulator would.
    CommandBuilder::new_default_prog()
}

fn create(host: &Arc<Host>, spec: SessionSpec) -> Result<SessionInfo> {
    let id = uuid::Uuid::new_v4().to_string();
    let pair = native_pty_system().openpty(PtySize {
        rows: spec.rows.max(1),
        cols: spec.cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    })?;
    let cmd = build_command(&spec, &id);
    let mut child = pair.slave.spawn_command(cmd).context("starting shell")?;
    drop(pair.slave);

    let title = spec.title.clone().unwrap_or_else(|| match &spec.command {
        Some(argv) if !argv.is_empty() => argv.join(" "),
        _ => "Terminal".into(),
    });
    let info = SessionInfo {
        id: id.clone(),
        project_id: spec.project_id.clone(),
        cwd: spec.cwd.clone(),
        title,
        pid: child.process_id(),
        created_at: now_ms(),
        running: true,
        exit_code: None,
        agent: None,
        busy: None,
    };
    let mut reader = pair.master.try_clone_reader()?;
    let mut writer = pair.master.take_writer()?;
    let (input, input_rx) = mpsc::channel::<Vec<u8>>();
    thread::spawn(move || {
        for data in input_rx {
            if writer
                .write_all(&data)
                .and_then(|()| writer.flush())
                .is_err()
            {
                break;
            }
        }
    });
    let session = Arc::new(Mutex::new(Session {
        info: info.clone(),
        input,
        master: pair.master,
        killer: child.clone_killer(),
        shell: !spec.command.as_ref().is_some_and(|argv| !argv.is_empty()),
        scrollback: Scrollback::default(),
        subscribers: HashSet::new(),
        osc: OscScanner::default(),
        agent_from_hook: false,
        osc_group: None,
    }));
    host.sessions.lock().insert(id.clone(), session.clone());

    // The reader says it went on (bounded: one pending mark is enough), and
    // ends the channel when the PTY closes; see `settle`.
    let (activity, output_activity) = mpsc::sync_channel::<()>(1);
    let out_host = host.clone();
    let out_session = session.clone();
    let out_id = id.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 32 * 1024];
        loop {
            let n = match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            let chunk = &buf[..n];
            let mut s = out_session.lock();
            s.scrollback.push(chunk);
            let signals = s.osc.feed(chunk);
            if !signals.is_empty() {
                apply_signals(&out_host, &out_id, &mut s, signals);
            }
            broadcast(
                &out_host,
                &s.subscribers,
                Event::Output {
                    id: out_id.clone(),
                    data: b64(chunk),
                },
            );
            drop(s);
            let _ = activity.try_send(());
        }
    });

    let exit_host = host.clone();
    thread::spawn(move || {
        let code = child.wait().ok().map(|status| status.exit_code());
        settle(&output_activity, EXIT_QUIET, EXIT_WAIT_MAX);
        let mut s = session.lock();
        s.info.running = false;
        s.info.exit_code = code;
        // Every client: a tab not shown yet is not attached, and its tab still shows it ended.
        for tx in exit_host.clients.lock().values() {
            let _ = tx.send(ServerMsg::Event {
                body: Event::Exit {
                    id: id.clone(),
                    code,
                },
            });
        }
    });

    Ok(info)
}

/// After a program exits, how long its output may pause before the exit is
/// told, and the longest the exit waits for it.
const EXIT_QUIET: Duration = Duration::from_millis(50);
const EXIT_WAIT_MAX: Duration = Duration::from_secs(1);

/// Waits for output still on its way after the program exited (left in the
/// PTY, or still being drawn by ConPTY's console host, which goes on after the
/// process is gone), so `[Process exited]` comes after the last lines: until
/// the reader ends (`activity` closes), or goes `quiet`, at most `max`. A
/// background process keeping the terminal open only costs `quiet`.
fn settle(activity: &mpsc::Receiver<()>, quiet: Duration, max: Duration) {
    let deadline = Instant::now() + max;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return;
        }
        match activity.recv_timeout(quiet.min(left)) {
            Ok(()) => continue,
            Err(_) => return,
        }
    }
}

fn broadcast(host: &Host, subscribers: &HashSet<ClientId>, event: Event) {
    let clients = host.clients.lock();
    for c in subscribers {
        if let Some(tx) = clients.get(c) {
            let _ = tx.send(ServerMsg::Event {
                body: event.clone(),
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(name: &str, state: &str, checks: &[(&str, &str)]) -> AgentStatus {
        AgentStatus {
            agent: name.into(),
            state: state.into(),
            message: None,
            at: 1,
            checks: checks
                .iter()
                .map(|(name, state)| Check {
                    name: (*name).into(),
                    state: (*state).into(),
                    summary: None,
                })
                .collect(),
        }
    }

    fn checks(status: &Option<AgentStatus>) -> Vec<(String, String)> {
        status
            .iter()
            .flat_map(|a| &a.checks)
            .map(|c| (c.name.clone(), c.state.clone()))
            .collect()
    }

    #[test]
    fn checks_stay_with_the_end_of_a_turn() {
        let checked = agent("claude", "done", &[("compile", "running")]);
        let pair = |n: &str, s: &str| vec![(n.to_string(), s.to_string())];

        // "done" arriving after the check started keeps it, as do later end states.
        let next = carry_checks(Some(&checked), Some(agent("claude", "done", &[])));
        assert_eq!(checks(&next), pair("compile", "running"));
        let next = carry_checks(Some(&checked), Some(agent("claude", "waiting", &[])));
        assert_eq!(checks(&next), pair("compile", "running"));

        // Working again, a new session, another agent or none: gone.
        for next in [
            agent("claude", "working", &[]),
            agent("claude", "idle", &[]),
            agent("codex", "done", &[]),
        ] {
            assert!(checks(&carry_checks(Some(&checked), Some(next))).is_empty());
        }
        assert!(carry_checks(Some(&checked), None).is_none());
    }

    #[test]
    fn a_check_updates_in_place() {
        let status = agent("claude", "done", &[("compile", "running"), ("lint", "ok")]);
        let check = |state: &str| Check {
            name: "compile".into(),
            state: state.into(),
            summary: Some("2 errors".into()),
        };
        let status = with_check(status, check("fail"));
        assert_eq!(
            checks(&Some(status.clone())),
            vec![
                ("compile".to_string(), "fail".to_string()),
                ("lint".into(), "ok".into())
            ]
        );
        assert_eq!(status.checks[0].summary.as_deref(), Some("2 errors"));
        let mut added = Check {
            name: "style".into(),
            ..check("ok")
        };
        added.summary = None;
        assert_eq!(with_check(status, added).checks.len(), 3);
    }

    #[test]
    fn exit_waits_for_output_to_settle() {
        let (quiet, max) = (Duration::from_millis(50), Duration::from_millis(400));
        let timed = |rx: &mpsc::Receiver<()>| {
            let t = Instant::now();
            settle(rx, quiet, max);
            t.elapsed()
        };

        // Output keeps coming every 10 ms: waits, but not past `max`.
        let (tx, rx) = mpsc::sync_channel::<()>(1);
        let feeder = thread::spawn(move || {
            for _ in 0..100 {
                let _ = tx.try_send(());
                thread::sleep(Duration::from_millis(10));
            }
        });
        let busy = timed(&rx);
        assert!(
            busy >= Duration::from_millis(390) && busy < Duration::from_millis(800),
            "{busy:?}"
        );
        feeder.join().unwrap();

        // No more output: one quiet pause.
        let (_tx, rx) = mpsc::sync_channel::<()>(1);
        let took = timed(&rx);
        assert!(
            took >= quiet && took < Duration::from_millis(300),
            "{took:?}"
        );

        // The reader ended: no wait, even with a mark still pending.
        let (tx, rx) = mpsc::sync_channel::<()>(1);
        tx.try_send(()).unwrap();
        drop(tx);
        let took = timed(&rx);
        assert!(took < Duration::from_millis(30), "{took:?}");
    }

    #[test]
    fn scrollback_is_bounded_and_cuts_at_newline() {
        let mut sb = Scrollback::default();
        let line = vec![b'x'; 1023]
            .into_iter()
            .chain(*b"\n")
            .collect::<Vec<_>>();
        for _ in 0..(SCROLLBACK_BYTES / 1024 + 10) {
            sb.push(&line);
        }
        let bytes = sb.bytes();
        assert!(bytes.len() <= SCROLLBACK_BYTES);
        assert_eq!(bytes[0], b'x');
        assert_eq!(bytes.len() % 1024, 0);
    }
}
