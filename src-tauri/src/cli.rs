//! `haze` subcommands for driving terminals and agents from a shell or from
//! another agent, through the PTY host's socket:
//!
//! ```text
//! haze agent <claude|codex|gemini|opencode|…> [--worktree <branch>] [--prompt <text> | <text>…]
//! haze run [--worktree <branch>] [--] <command…>
//! haze list [--json]
//! haze send <id> <text…>
//! haze wait <id> [--for done,waiting,error] [--timeout <seconds>]
//! haze read <id> [--lines <n>]
//! ```
//!
//! `agent` and `run` start a shell in a new terminal (in a new worktree when
//! asked), type the command into it, show the terminal in Haze and print its
//! id. Ids can be shortened to any unique prefix.

use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;

use crate::pty::client::PtyClient;
use crate::pty::protocol::{Event, Reply, Request, SessionInfo, SessionSpec};

const COMMANDS: &[&str] = &["agent", "run", "list", "send", "wait", "read", "help"];

const USAGE: &str = "Usage:
  haze <folder> [<file>] [--line N] [--column N]   open a project or file
  haze agent <name> [options] [<prompt>…]          start claude, codex, gemini, opencode… in a new terminal
  haze run [options] [--] <command…>               run a command in a new terminal
      options: --dir <path>  --worktree <branch> [--from <ref>]  --title <text>  --prompt <text>  --no-ui
  haze list [--json]                               terminals with their agent state
  haze send <id> <text…> [--no-enter]              type text into a terminal, then Enter
  haze wait <id> [--for done,waiting,error] [--timeout <seconds>]
                                                   wait for the agent's next state among these
  haze read <id> [--lines <n>]                     print the end of a terminal's output";

/// `argv[1]` is a subcommand, not a folder or file of that name.
pub fn is_subcommand(argv: &[String], cwd: &Path) -> bool {
    argv.get(1).is_some_and(|a| {
        a == "--help" || a == "-h" || (COMMANDS.contains(&a.as_str()) && !cwd.join(a).exists())
    })
}

/// Runs a subcommand; returns the process exit code.
pub fn run(argv: &[String]) -> i32 {
    match dispatch(&argv[1..]) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("haze: {e:#}");
            1
        }
    }
}

fn dispatch(args: &[String]) -> Result<i32> {
    let (cmd, rest) = args.split_first().context("no command")?;
    match cmd.as_str() {
        "agent" => start(rest, true),
        "run" => start(rest, false),
        "list" => list(rest),
        "send" => send(rest),
        "wait" => wait(rest),
        "read" => read(rest),
        _ => {
            println!("{USAGE}");
            Ok(0)
        }
    }
}

fn client() -> PtyClient {
    PtyClient::new(Arc::new(|_| {}))
}

fn sessions(client: &PtyClient) -> Result<Vec<SessionInfo>> {
    match client.request(Request::List)? {
        Reply::Sessions { sessions } => Ok(sessions),
        other => bail!("unexpected reply {other:?}"),
    }
}

/// The session whose id is `prefix` or starts with it (only one may).
fn resolve(client: &PtyClient, prefix: &str) -> Result<SessionInfo> {
    let mut found: Vec<SessionInfo> = sessions(client)?
        .into_iter()
        .filter(|s| s.id.starts_with(prefix))
        .collect();
    match found.len() {
        0 => bail!("no terminal {prefix}"),
        1 => Ok(found.remove(0)),
        _ => bail!(
            "{prefix} matches {} terminals; give more of the id",
            found.len()
        ),
    }
}

// ---------------------------------------------------------------- agent / run

#[derive(Debug, Default, PartialEq)]
struct StartOpts {
    dir: Option<String>,
    worktree: Option<String>,
    from: Option<String>,
    title: Option<String>,
    prompt: Option<String>,
    no_ui: bool,
    /// The agent's name, or the command to run.
    words: Vec<String>,
}

fn parse_start(args: &[String]) -> Result<StartOpts> {
    let mut o = StartOpts::default();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let mut value = |name: &str| {
            it.next()
                .cloned()
                .with_context(|| format!("{name} needs a value"))
        };
        match a.as_str() {
            "--dir" | "-C" => o.dir = Some(value(a)?),
            "--worktree" | "-w" => o.worktree = Some(value(a)?),
            "--from" => o.from = Some(value(a)?),
            "--title" => o.title = Some(value(a)?),
            "--prompt" | "-p" => o.prompt = Some(value(a)?),
            "--no-ui" => o.no_ui = true,
            "--" => {
                o.words.extend(it.by_ref().cloned());
                break;
            }
            _ => o.words.push(a.clone()),
        }
    }
    Ok(o)
}

/// The command line that starts `agent` with an optional first prompt.
pub fn agent_command(agent: &str, prompt: Option<&str>) -> Vec<String> {
    let mut argv = vec![agent.to_string()];
    if let Some(p) = prompt.filter(|p| !p.is_empty()) {
        match agent {
            // `-p` would answer once and exit; `-i` keeps the session open.
            "gemini" => argv.push("-i".into()),
            "opencode" => argv.push("--prompt".into()),
            _ => {}
        }
        argv.push(p.to_string());
    }
    argv
}

fn start(args: &[String], agent: bool) -> Result<i32> {
    let mut o = parse_start(args)?;
    let command = if agent {
        let name = o
            .words
            .first()
            .cloned()
            .context("which agent? e.g. haze agent claude")?;
        let prompt = o
            .prompt
            .clone()
            .or_else(|| (o.words.len() > 1).then(|| o.words[1..].join(" ")));
        o.title.get_or_insert_with(|| name.clone());
        agent_command(&name, prompt.as_deref())
    } else {
        if !o.words.is_empty() {
            o.title.get_or_insert_with(|| o.words.join(" "));
        }
        o.words.clone()
    };
    let cwd = std::env::current_dir()?;
    let mut dir = o.dir.as_deref().map(|d| cwd.join(d)).unwrap_or(cwd);
    if let Some(branch) = &o.worktree {
        dir = worktree(&dir, branch, o.from.as_deref())?;
        if let Some(t) = &mut o.title {
            *t = format!("{t} · {branch}");
        }
    }
    let dir = dir.canonicalize().unwrap_or(dir);

    let (tx, rx) = mpsc::channel::<String>();
    let client = PtyClient::new(Arc::new(move |ev| match ev {
        Some(Event::Output { id, .. }) => {
            let _ = tx.send(id);
        }
        Some(Event::Snapshot { id, data, .. }) if !data.is_empty() => {
            let _ = tx.send(id);
        }
        _ => {}
    }));
    let mut env = Vec::new();
    crate::pty::add_utf8_locale(&mut env);
    let spec = SessionSpec {
        project_id: None,
        cwd: dir.to_string_lossy().into_owned(),
        cols: 120,
        rows: 30,
        title: o.title.clone(),
        command: None,
        env,
    };
    let session = match client.request(Request::Create { spec })? {
        Reply::Created { session } => session,
        other => bail!("unexpected reply {other:?}"),
    };
    if !command.is_empty() {
        // Type the command once the shell has printed its prompt and gone
        // quiet, so it runs in the user's shell setup, and the shell stays
        // afterwards.
        client.notify(Request::Attach {
            id: session.id.clone(),
        })?;
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut printed = false;
        while let Some(left) = deadline.checked_duration_since(Instant::now()) {
            let wait = if printed {
                left.min(Duration::from_millis(200))
            } else {
                left
            };
            match rx.recv_timeout(wait) {
                Ok(id) => printed |= id == session.id,
                Err(_) => break,
            }
        }
        client.request(Request::Write {
            id: session.id.clone(),
            data: shell_line(&command) + "\r",
        })?;
        let _ = client.notify(Request::Detach {
            id: session.id.clone(),
        });
    }
    if !o.no_ui {
        show_in_haze(&dir, &session.id);
    }
    println!("{}", session.id);
    Ok(0)
}

/// `<repo>-<branch>` next to the repository, on a new branch (or the existing
/// one), as the Branches popup's New Worktree does; reused if it exists.
fn worktree(dir: &Path, branch: &str, from: Option<&str>) -> Result<PathBuf> {
    let root = git(dir, &["rev-parse", "--show-toplevel"]).context("not in a git repository")?;
    let safe: String = branch
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let path = PathBuf::from(format!("{}-{safe}", root.trim_end_matches(['/', '\\'])));
    if path.exists() {
        return Ok(path);
    }
    let p = path.to_string_lossy().into_owned();
    let root = Path::new(&root);
    let exists = git(
        root,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
    )
    .is_ok();
    if exists {
        git(root, &["worktree", "add", &p, branch])?;
    } else {
        let mut args = vec!["worktree", "add", "-b", branch, &p];
        args.extend(from);
        git(root, &args)?;
    }
    eprintln!("haze: created worktree {p} ({branch})");
    Ok(path)
}

fn git(dir: &Path, args: &[&str]) -> Result<String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .context("running git")?;
    if !out.status.success() {
        bail!(
            "git {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// A command line for the user's shell (PowerShell on Windows, POSIX elsewhere).
pub fn shell_line(argv: &[String]) -> String {
    let safe = |a: &str| {
        !a.is_empty()
            && a.chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_./=:@+,%".contains(c))
    };
    argv.iter()
        .map(|a| {
            if safe(a) {
                a.clone()
            } else if cfg!(windows) {
                format!("'{}'", a.replace('\'', "''"))
            } else {
                format!("'{}'", a.replace('\'', r"'\''"))
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Opens the folder in Haze with the terminal shown: handed to a running
/// Haze like `haze <folder>`, or starting one.
fn show_in_haze(dir: &Path, id: &str) {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let mut cmd = std::process::Command::new(exe);
    cmd.arg(dir)
        .args(["--terminal", id])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Not tied to the calling terminal, if it starts Haze itself.
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    if let Err(e) = cmd.spawn() {
        eprintln!("haze: could not show the terminal in Haze: {e}");
    }
}

// ---------------------------------------------------------------- list / send / wait / read

fn list(args: &[String]) -> Result<i32> {
    let list = sessions(&client())?;
    if args.iter().any(|a| a == "--json") {
        println!("{}", serde_json::to_string_pretty(&list)?);
        return Ok(0);
    }
    for s in &list {
        let state = match (&s.agent, s.running) {
            (Some(a), true) => format!("{} {}", a.agent, a.state),
            (None, true) => "-".into(),
            (_, false) => "exited".into(),
        };
        println!(
            "{:<8}  {:<16}  {:<24}  {}",
            &s.id[..8.min(s.id.len())],
            state,
            s.title,
            s.cwd
        );
    }
    Ok(0)
}

fn send(args: &[String]) -> Result<i32> {
    let no_enter = args.iter().any(|a| a == "--no-enter");
    let words: Vec<&String> = args.iter().filter(|a| *a != "--no-enter").collect();
    let (id, text) = words
        .split_first()
        .context("usage: haze send <id> <text…>")?;
    let client = client();
    let s = resolve(&client, id)?;
    let text = text
        .iter()
        .map(|w| w.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    client.request(Request::Write {
        id: s.id.clone(),
        data: text,
    })?;
    if !no_enter {
        // Separately, so a TUI agent takes the text as typed and Enter as submit.
        std::thread::sleep(Duration::from_millis(150));
        client.request(Request::Write {
            id: s.id,
            data: "\r".into(),
        })?;
    }
    Ok(0)
}

fn wait(args: &[String]) -> Result<i32> {
    let mut id = None;
    let mut wanted = vec!["done".to_string(), "waiting".into(), "error".into()];
    let mut timeout = None;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--for" => {
                wanted = it
                    .next()
                    .context("--for needs states")?
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .collect()
            }
            "--timeout" => {
                timeout = Some(Duration::from_secs_f64(
                    it.next().context("--timeout needs seconds")?.parse()?,
                ))
            }
            _ => id = Some(a.clone()),
        }
    }
    let id = id.context("usage: haze wait <id>")?;
    let client = client();
    let id = resolve(&client, &id)?.id;
    let started = crate::pty::now_ms();
    let begin = Instant::now();
    loop {
        let Some(s) = sessions(&client)?.into_iter().find(|s| s.id == id) else {
            bail!("terminal {id} was closed");
        };
        // Only a state reported after `wait` started: the last turn's "done" does not count.
        if let Some(a) = s
            .agent
            .as_ref()
            .filter(|a| a.at >= started && wanted.contains(&a.state))
        {
            println!("{}", a.state);
            return Ok(0);
        }
        if !s.running {
            println!("exited");
            return Ok(2);
        }
        if timeout.is_some_and(|t| begin.elapsed() > t) {
            eprintln!("haze: timed out");
            return Ok(1);
        }
        std::thread::sleep(Duration::from_millis(400));
    }
}

fn read(args: &[String]) -> Result<i32> {
    let mut id = None;
    let mut lines = 40usize;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--lines" | "-n" => lines = it.next().context("--lines needs a number")?.parse()?,
            _ => id = Some(a.clone()),
        }
    }
    let (tx, rx) = mpsc::channel::<(String, String)>();
    let client = PtyClient::new(Arc::new(move |ev| {
        if let Some(Event::Snapshot { id, data, .. }) = ev {
            let _ = tx.send((id, data));
        }
    }));
    let id = resolve(&client, &id.context("usage: haze read <id>")?)?.id;
    client.notify(Request::Attach { id: id.clone() })?;
    let data = loop {
        let (got, data) = rx
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| anyhow!("the terminal host did not answer"))?;
        if got == id {
            break data;
        }
    };
    let _ = client.notify(Request::Detach { id });
    let bytes = base64::engine::general_purpose::STANDARD.decode(data)?;
    let text = plain_text(&String::from_utf8_lossy(&bytes));
    let all: Vec<&str> = text.lines().collect();
    let end = all
        .iter()
        .rposition(|l| !l.trim().is_empty())
        .map_or(0, |i| i + 1);
    for l in &all[end.saturating_sub(lines)..end] {
        println!("{l}");
    }
    Ok(0)
}

/// Terminal output without escape sequences; a carriage return starts its
/// line over, as on screen.
pub fn plain_text(s: &str) -> String {
    let mut out = String::new();
    let mut line = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\u{1b}' => match chars.next() {
                // CSI: parameters, then a final byte in @..~.
                Some('[') => {
                    for c in chars.by_ref() {
                        if ('@'..='~').contains(&c) {
                            break;
                        }
                    }
                }
                // OSC and other strings: up to BEL or ST.
                Some(']' | 'P' | '_' | '^') => {
                    while let Some(c) = chars.next() {
                        if c == '\u{7}' || (c == '\u{1b}' && chars.peek() == Some(&'\\')) {
                            if c == '\u{1b}' {
                                chars.next();
                            }
                            break;
                        }
                    }
                }
                // Charset selection takes one more character.
                Some('(' | ')' | '*' | '+') => {
                    chars.next();
                }
                _ => {}
            },
            '\r' if chars.peek() == Some(&'\n') => {}
            '\r' => line.clear(),
            '\n' => {
                out.push_str(line.trim_end());
                out.push('\n');
                line.clear();
            }
            '\u{8}' => {
                line.pop();
            }
            c if c.is_control() && c != '\t' => {}
            c => line.push(c),
        }
    }
    out.push_str(line.trim_end());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|a| a.to_string()).collect()
    }

    #[test]
    fn tells_subcommands_from_folders() {
        let dir = tempfile::tempdir().unwrap();
        assert!(is_subcommand(&s(&["haze", "agent", "claude"]), dir.path()));
        assert!(is_subcommand(&s(&["haze", "--help"]), dir.path()));
        assert!(!is_subcommand(&s(&["haze", "src"]), dir.path()));
        std::fs::create_dir(dir.path().join("run")).unwrap();
        assert!(!is_subcommand(&s(&["haze", "run"]), dir.path()));
    }

    #[test]
    fn parses_start_options() {
        let o = parse_start(&s(&[
            "claude",
            "--worktree",
            "fix/login",
            "-p",
            "Fix the login",
            "--no-ui",
        ]))
        .unwrap();
        assert_eq!(o.words, s(&["claude"]));
        assert_eq!(o.worktree.as_deref(), Some("fix/login"));
        assert_eq!(o.prompt.as_deref(), Some("Fix the login"));
        assert!(o.no_ui);
        let o = parse_start(&s(&["--dir", "app", "--", "dotnet", "test", "--no-build"])).unwrap();
        assert_eq!(
            (o.dir.as_deref(), o.words),
            (Some("app"), s(&["dotnet", "test", "--no-build"]))
        );
        assert!(parse_start(&s(&["--worktree"])).is_err());
    }

    #[test]
    fn builds_agent_commands() {
        assert_eq!(
            agent_command("claude", Some("fix it")),
            s(&["claude", "fix it"])
        );
        assert_eq!(agent_command("codex", None), s(&["codex"]));
        assert_eq!(
            agent_command("gemini", Some("go")),
            s(&["gemini", "-i", "go"])
        );
        assert_eq!(
            agent_command("opencode", Some("go")),
            s(&["opencode", "--prompt", "go"])
        );
        assert_eq!(agent_command("claude", Some("")), s(&["claude"]));
    }

    #[test]
    fn quotes_shell_words() {
        let line = shell_line(&s(&["claude", "it's a \"test\"", "--x=1"]));
        if cfg!(windows) {
            assert_eq!(line, r#"claude 'it''s a "test"' --x=1"#);
        } else {
            assert_eq!(line, r#"claude 'it'\''s a "test"' --x=1"#);
        }
        assert_eq!(shell_line(&s(&["a", ""])), "a ''");
    }

    #[test]
    fn strips_escape_sequences() {
        let raw = "\u{1b}]0;title\u{7}\u{1b}[1;32mok\u{1b}[0m done\r\nprogress 10%\rprogress 100%\nab\u{8}c\n\u{1b}(Bx\u{1b}]8;;http://a\u{1b}\\link";
        assert_eq!(plain_text(raw), "ok done\nprogress 100%\nac\nxlink");
    }
}
