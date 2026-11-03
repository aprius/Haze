//! "Generate" in the Commit window: the diff of the ticked files goes to a
//! command the user chose in Settings › AI Models (Claude Code, Codex,
//! OpenCode, Gemini or any CLI), and its answer becomes the commit message.
//!
//! The command runs in the user's login shell (so PATH and the CLI's own
//! login work) from an empty temp directory, so an agent CLI has no repo to
//! edit. The prompt reaches it on stdin. On Unix `{prompt}` and `{model}` may
//! also appear in the command: they become `$HAZE_PROMPT` / `$HAZE_MODEL`,
//! quoted for where they stand, so the text is never parsed by the shell.
//! On Windows `cmd` would expand such a variable before parsing the line, so
//! `{prompt}` is refused there and `{model}` must be a plain model id.

use std::io::{Read, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use serde::Deserialize;

const DIFF_LIMIT: usize = 30_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub command: String,
    pub model: String,
    /// Instructions put before the diff.
    pub prompt: String,
    pub timeout_secs: u64,
}

pub fn generate(root: &Path, paths: &[String], req: &Request) -> Result<String> {
    if req.command.trim().is_empty() {
        bail!("No command set. Choose a generator in Settings › AI Models.");
    }
    if req.command.contains("{model}") && req.model.trim().is_empty() {
        bail!("No model set. Enter a model id in Settings › AI Models.");
    }
    let (recent, diff) = crate::git_ops::diff_for_message(root, paths, DIFF_LIMIT)?;
    let mut prompt = req.prompt.trim().to_owned();
    if !recent.trim().is_empty() {
        prompt.push_str(&format!("\n\nRecent commit subjects in this repository (match their style):\n{}", recent.trim()));
    }
    prompt.push_str(&format!("\n\nChanges:\n\n{diff}\n"));
    let raw = run(&req.command, req.model.trim(), &prompt, Duration::from_secs(req.timeout_secs.clamp(5, 600)))?;
    let msg = clean(&raw);
    if msg.is_empty() {
        bail!("The command printed no message.");
    }
    Ok(msg)
}

/// The command line with `{prompt}` / `{model}` turned into shell variables,
/// quoted to suit the spot: bare → `"$V"`, inside "…" → `$V`, inside '…' →
/// `'"$V"'`. So `{prompt}`, `"{prompt}"` and `"Text: {prompt}"` all pass the
/// text as it is, with no word splitting or globbing.
#[cfg_attr(windows, allow(dead_code))]
fn expand(command: &str) -> String {
    #[derive(PartialEq)]
    enum Q {
        None,
        Double,
        Single,
    }
    let mut out = String::with_capacity(command.len() + 32);
    let mut state = Q::None;
    let mut rest = command;
    while let Some(c) = rest.chars().next() {
        let var = [("{prompt}", "HAZE_PROMPT"), ("{model}", "HAZE_MODEL")]
            .into_iter()
            .find(|(p, _)| rest.starts_with(p));
        if let Some((p, v)) = var {
            match state {
                Q::None => out.push_str(&format!("\"${v}\"")),
                Q::Double => out.push_str(&format!("${v}")),
                Q::Single => out.push_str(&format!("'\"${v}\"'")),
            }
            rest = &rest[p.len()..];
            continue;
        }
        out.push(c);
        rest = &rest[c.len_utf8()..];
        match (&state, c) {
            (Q::None | Q::Double, '\\') => {
                if let Some(n) = rest.chars().next() {
                    out.push(n);
                    rest = &rest[n.len_utf8()..];
                }
            }
            (Q::None, '"') => state = Q::Double,
            (Q::None, '\'') => state = Q::Single,
            (Q::Double, '"') | (Q::Single, '\'') => state = Q::None,
            _ => {}
        }
    }
    out
}

#[cfg(not(windows))]
fn shell_command(command: &str, _model: &str) -> Result<Command> {
    use std::os::unix::process::CommandExt;
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/sh".into());
    let mut c = Command::new(shell);
    // Its own process group, so a timeout can stop the CLI and its helpers too.
    c.arg("-lc").arg(expand(command)).process_group(0);
    Ok(c)
}

#[cfg(windows)]
fn shell_command(command: &str, model: &str) -> Result<Command> {
    use std::os::windows::process::CommandExt;
    if command.contains("{prompt}") {
        bail!("On Windows the prompt goes to the command on stdin: remove {{prompt}} from the command.");
    }
    if command.contains("{model}") && !model.chars().all(|c| c.is_ascii_alphanumeric() || "._:/@#+-".contains(c)) {
        bail!("The model id {model:?} may only use letters, digits and . _ : / @ # + -");
    }
    let mut c = Command::new("cmd");
    // `/S /C "…"`: cmd drops the outer quotes and runs the rest as typed.
    c.args(["/D", "/S", "/C"])
        .raw_arg(format!("\"{}\"", command.replace("{model}", model)))
        .creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    Ok(c)
}

/// Stops the command and whatever it started.
fn kill_tree(child: &mut Child) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &child.id().to_string()])
            .creation_flags(0x0800_0000)
            .output();
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn run(command: &str, model: &str, prompt: &str, timeout: Duration) -> Result<String> {
    let dir = tempfile::tempdir().context("creating a work folder")?;
    let mut child = shell_command(command, model)?
        .current_dir(dir.path())
        .env("HAZE_PROMPT", prompt)
        .env("HAZE_MODEL", model)
        .env("NO_COLOR", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("starting the command")?;
    let mut stdin = child.stdin.take().context("stdin")?;
    let input = prompt.to_owned();
    // A command that ignores stdin closes it early: ignore the broken pipe.
    std::thread::spawn(move || {
        let _ = stdin.write_all(input.as_bytes());
    });
    let (tx, rx) = mpsc::channel::<(bool, String)>();
    let read = |is_out: bool, mut s: Box<dyn Read + Send>| {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = s.read_to_end(&mut buf);
            let _ = tx.send((is_out, String::from_utf8_lossy(&buf).into_owned()));
        });
    };
    read(true, Box::new(child.stdout.take().context("stdout")?));
    read(false, Box::new(child.stderr.take().context("stderr")?));
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(s) = child.try_wait()? {
            break s;
        }
        if Instant::now() > deadline {
            kill_tree(&mut child);
            bail!("The command took longer than {} seconds.", timeout.as_secs());
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    // The output ends when every process holding the pipes is gone. A helper
    // the CLI left running may keep them open: wait until the deadline, then
    // stop the whole group and take what was printed.
    let (mut out, mut err) = (None, None);
    let mut killed = false;
    while out.is_none() || err.is_none() {
        let wait = deadline.saturating_duration_since(Instant::now()).max(Duration::from_millis(500));
        match rx.recv_timeout(if killed { Duration::from_secs(1) } else { wait }) {
            Ok((true, s)) => out = Some(s),
            Ok((false, s)) => err = Some(s),
            Err(_) if !killed => {
                kill_tree(&mut child);
                killed = true;
            }
            Err(_) => break,
        }
    }
    let (out, err) = (out.unwrap_or_default(), err.unwrap_or_default());
    if !status.success() {
        let why = err.trim();
        let why = if why.is_empty() { out.trim() } else { why };
        let tail: String = why.chars().rev().take(600).collect::<Vec<_>>().into_iter().rev().collect();
        bail!("The command failed ({status}): {tail}");
    }
    Ok(out)
}

/// The message out of a CLI's output: no colour codes, no code fence, no
/// `<think>` block, no quotes around it.
fn clean(raw: &str) -> String {
    let mut s = String::new();
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for n in chars.by_ref() {
                    if n.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
        } else {
            s.push(c);
        }
    }
    while let (Some(a), Some(b)) = (s.find("<think>"), s.find("</think>")) {
        if b < a {
            break;
        }
        s.replace_range(a..b + "</think>".len(), "");
    }
    let mut text = s.trim();
    if let Some(rest) = text.strip_prefix("```") {
        let rest = rest.split_once('\n').map_or("", |(_, r)| r);
        text = rest.rsplit_once("```").map_or(rest, |(m, _)| m).trim();
    }
    text.to_owned()
}

/// Model ids `opencode models` lists (provider/model), for the picker.
pub fn opencode_models() -> Result<Vec<String>> {
    #[cfg(windows)]
    let out = {
        use std::os::windows::process::CommandExt;
        Command::new("cmd").args(["/D", "/C", "opencode models"]).creation_flags(0x0800_0000).output()?
    };
    #[cfg(not(windows))]
    let out = {
        let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/sh".into());
        Command::new(shell).args(["-lc", "opencode models"]).output()?
    };
    if !out.status.success() {
        bail!("opencode models failed: {}", String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| l.trim().to_owned())
        .filter(|l| l.contains('/') && !l.contains(' '))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_output() {
        assert_eq!(clean("```\nfix: a\n```\n"), "fix: a");
        assert_eq!(clean("<think>hm</think>\nfix: a"), "fix: a");
        assert_eq!(clean("\u{1b}[32mfix: a\u{1b}[0m"), "fix: a");
    }

    #[test]
    fn expands_placeholders_for_their_quoting() {
        assert_eq!(expand("x {prompt}"), r#"x "$HAZE_PROMPT""#);
        assert_eq!(expand(r#"x "{prompt}""#), r#"x "$HAZE_PROMPT""#);
        assert_eq!(expand(r#"x "Text: {prompt}""#), r#"x "Text: $HAZE_PROMPT""#);
        assert_eq!(expand("x '{model}'"), r#"x ''"$HAZE_MODEL"''"#);
        assert_eq!(expand(r#"x "a\"{model}""#), r#"x "a\"$HAZE_MODEL""#);
    }

    /// Every quoting a user might write gives one argument, untouched, even in sh.
    #[cfg(unix)]
    #[test]
    fn expanded_text_is_not_split_or_globbed() {
        for cmd in [r#"printf '[%s]' {prompt}"#, r#"printf '[%s]' "{prompt}""#, r#"printf '[%s]' '{prompt}'"#] {
            let out = Command::new("/bin/sh")
                .args(["-c", &expand(cmd)])
                .env("HAZE_PROMPT", "a  b * $HOME `x`")
                .output()
                .unwrap();
            assert_eq!(String::from_utf8_lossy(&out.stdout), "[a  b * $HOME `x`]", "{cmd}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn runs_with_stdin_and_env() {
        let out = run("cat", "", "hello", Duration::from_secs(10)).unwrap();
        assert_eq!(out, "hello");
        let out = run("echo {model} {prompt}", "m", "p q", Duration::from_secs(10)).unwrap();
        assert_eq!(out.trim(), "m p q");
        assert!(run("sleep 5", "", "", Duration::from_millis(200)).is_err());
    }

    /// A helper left holding stdout doesn't keep Generate waiting past the timeout.
    #[cfg(unix)]
    #[test]
    fn lingering_helper_does_not_hang() {
        let start = Instant::now();
        // The timeout also covers login-shell startup, which is slow on CI runners.
        let out = run("(sleep 120 &) ; echo done", "", "", Duration::from_secs(5)).unwrap();
        assert_eq!(out.trim(), "done");
        assert!(start.elapsed() < Duration::from_secs(15));
    }
}
