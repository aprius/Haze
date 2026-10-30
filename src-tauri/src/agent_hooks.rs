//! AI agent hooks. Claude Code, Codex, Gemini CLI and OpenCode call
//! `haze --agent-hook <agent> …` (installed into their user config on
//! request); the hook reports the agent's state for the terminal it runs in
//! (`HAZE_TERMINAL_ID`) to the PTY host, which keeps it with the session and
//! tells every Haze window.
//!
//! State is only ever taken from these lifecycle events (or from the status
//! sequences an agent prints, see `pty::osc`), and nothing from the prompt or
//! transcript is stored.

use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use interprocess::local_socket::{prelude::*, Stream};
use serde::Serialize;

use crate::pty::protocol::{write_frame, AgentStatus, ClientMsg, Request};
use crate::pty::{now_ms, socket_name};

pub const HOOK_FLAG: &str = "--agent-hook";

/// Claude Code events Haze listens to.
const CLAUDE_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PermissionRequest",
    "Notification",
    "Stop",
    "StopFailure",
    "SessionEnd",
];

/// Codex lifecycle hooks (`hooks.json`), named like Claude Code's.
const CODEX_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PermissionRequest",
    "Stop",
    "Interrupt",
    "SessionEnd",
];

/// Gemini CLI hooks (`settings.json`). Model events fire too often to be worth it.
const GEMINI_EVENTS: &[&str] = &[
    "SessionStart",
    "BeforeAgent",
    "BeforeTool",
    "AfterTool",
    "Notification",
    "AfterAgent",
    "SessionEnd",
];

/// Maps a Claude Code hook payload to a state (`None` = clear the agent).
pub fn claude_state(payload: &serde_json::Value) -> Option<Option<(&'static str, Option<String>)>> {
    let event = payload.get("hook_event_name")?.as_str()?;
    let message = payload
        .get("message")
        .and_then(|m| m.as_str())
        .map(str::to_string);
    Some(match event {
        "SessionStart" => Some(("idle", None)),
        // PostToolUse also ends "waiting" once a permission was granted and the tool ran.
        "UserPromptSubmit" | "PreToolUse" | "PostToolUse" => Some(("working", None)),
        "PermissionRequest" => Some(("waiting", Some("Waiting for permission".into()))),
        "Notification" => {
            let kind = payload
                .get("notification_type")
                .or_else(|| payload.get("type"))
                .and_then(|k| k.as_str())
                .unwrap_or("");
            let text = message.clone().unwrap_or_default().to_lowercase();
            match kind {
                "idle_prompt" | "agent_completed" => Some(("done", message)),
                "permission_prompt"
                | "elicitation_dialog"
                | "elicitation_url_dialog"
                | "agent_needs_input" => Some(("waiting", message)),
                // No type: older versions only send a message.
                "" if text.contains("waiting for your input") => Some(("done", message)),
                "" if text.contains("permission") || text.contains("approv") => {
                    Some(("waiting", message))
                }
                // Informational notifications (auth, quota…) do not change the state.
                _ => return None,
            }
        }
        // Codex: the user stopped the turn.
        "Stop" | "Interrupt" => Some(("done", None)),
        "StopFailure" => Some(("error", message)),
        "SessionEnd" => None,
        _ => return None,
    })
}

/// Maps a Gemini CLI hook event to a state (`None` = clear the agent).
pub fn gemini_state(
    event: &str,
    payload: &serde_json::Value,
) -> Option<Option<(&'static str, Option<String>)>> {
    let message = payload
        .get("message")
        .and_then(|m| m.as_str())
        .map(str::to_string);
    Some(match event {
        "SessionStart" => Some(("idle", None)),
        // AfterTool also ends "waiting" once a tool was allowed and ran.
        "BeforeAgent" | "BeforeTool" | "AfterTool" => Some(("working", None)),
        "Notification" => match payload.get("notification_type").and_then(|t| t.as_str()) {
            Some("ToolPermission") => {
                Some(("waiting", message.or(Some("Waiting for permission".into()))))
            }
            _ => return None,
        },
        "AfterAgent" => Some(("done", None)),
        "SessionEnd" => None,
        _ => return None,
    })
}

/// States the OpenCode plugin reports as they are.
fn opencode_state(state: &str) -> Option<Option<&'static str>> {
    Some(match state {
        "idle" => Some("idle"),
        "working" => Some("working"),
        "waiting" => Some("waiting"),
        "done" => Some("done"),
        "error" => Some("error"),
        "clear" => None,
        _ => return None,
    })
}

/// Entry point for `haze --agent-hook <agent> [payload]`. Never fails loudly:
/// a hook must not disturb the agent.
pub fn run_hook(args: &[String]) {
    let _ = try_run_hook(args);
}

fn try_run_hook(args: &[String]) -> Result<()> {
    let Ok(id) = std::env::var("HAZE_TERMINAL_ID") else {
        return Ok(());
    };
    let agent = args.first().map(String::as_str).unwrap_or("claude");
    let arg = args.get(1).map(String::as_str);
    // Where the agent works, when this hook is it getting a prompt.
    let mut prompt_in: Option<PathBuf> = None;
    let status = match (agent, arg) {
        // Codex `notify` passes its notification JSON as the last argument.
        ("codex", Some(a)) if a.starts_with('{') => {
            let payload: serde_json::Value = serde_json::from_str(a).unwrap_or_default();
            let kind = payload.get("type").and_then(|t| t.as_str()).unwrap_or("");
            match kind {
                "agent-turn-complete" => Some(status("codex", "done", None)),
                "approval-requested" => Some(status("codex", "waiting", None)),
                _ => return Ok(()),
            }
        }
        ("opencode", Some(state)) => match opencode_state(state) {
            None => return Ok(()),
            Some(None) => None,
            Some(Some(state)) => Some(status("opencode", state, args.get(2).cloned())),
        },
        // Claude Code and Codex hooks: the payload names the event, as does
        // the argument Haze installs for Codex and Gemini.
        _ => {
            let mut input = String::new();
            let _ = std::io::stdin().take(1 << 20).read_to_string(&mut input);
            let mut payload: serde_json::Value =
                serde_json::from_str(&input).unwrap_or_else(|_| serde_json::json!({}));
            if let (Some(event), Some(obj)) = (arg, payload.as_object_mut()) {
                obj.insert("hook_event_name".into(), event.into());
            }
            let event = payload
                .get("hook_event_name")
                .and_then(|e| e.as_str())
                .unwrap_or("")
                .to_string();
            if matches!(event.as_str(), "UserPromptSubmit" | "BeforeAgent") {
                prompt_in = payload
                    .get("cwd")
                    .and_then(|c| c.as_str())
                    .map(PathBuf::from)
                    .or_else(|| std::env::current_dir().ok());
            }
            let state = match agent {
                "gemini" => gemini_state(&event, &payload),
                _ => claude_state(&payload),
            };
            match state {
                None => return Ok(()),
                Some(None) => None,
                Some(Some((state, message))) => Some(status(agent, state, message)),
            }
        }
    };
    // Only talk to a host that is already running; a hook must not start one.
    let sent = Stream::connect(socket_name()?).and_then(|mut stream| {
        write_frame(
            &mut stream,
            &ClientMsg {
                req: 0,
                body: Request::Agent { id, status },
            },
        )
    });
    // After the state, so the badge does not wait for the snapshot.
    if let Some(dir) = prompt_in {
        let _ = checkpoint_turn(&dir, agent);
    }
    Ok(sent?)
}

fn same_dir(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// Auto checkpoints a repository keeps: enough to look a few prompts back.
const AUTO_CHECKPOINTS: usize = 10;

/// Snapshots the agent's repository as it gets a prompt, so the Commit window
/// can show what that turn changed.
fn checkpoint_turn(dir: &Path, agent: &str) -> Result<()> {
    let root = crate::git_ops::toplevel(dir)?;
    // A home folder kept in git (dotfiles) would snapshot everything under it.
    if dirs::home_dir().is_some_and(|home| same_dir(&home, &root)) || root.parent().is_none() {
        return Ok(());
    }
    let name = match agent {
        "claude" => "Claude Code",
        "codex" => "Codex",
        "gemini" => "Gemini CLI",
        other => other,
    };
    crate::git_ops::auto_checkpoint(&root, &format!("{name} prompt"), AUTO_CHECKPOINTS)?;
    Ok(())
}

fn status(agent: &str, state: &str, message: Option<String>) -> AgentStatus {
    AgentStatus {
        agent: agent.into(),
        state: state.into(),
        message: message.map(|m| m.chars().take(200).collect()),
        at: now_ms(),
        checks: Vec::new(),
    }
}

// ---------------------------------------------------------------- install

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HookStatus {
    pub installed: bool,
    /// Installed, but by another Haze executable or an older Haze (fewer events).
    pub stale: bool,
    pub config_path: String,
    /// Why it cannot be installed automatically.
    pub conflict: Option<String>,
}

fn exe() -> Result<String> {
    Ok(std::env::current_exe()?.to_string_lossy().into_owned())
}

fn home() -> Result<PathBuf> {
    dirs::home_dir().context("no home directory")
}

fn claude_settings_path() -> Result<PathBuf> {
    Ok(home()?.join(".claude").join("settings.json"))
}

fn codex_home() -> Result<PathBuf> {
    match std::env::var_os("CODEX_HOME") {
        Some(dir) => Ok(PathBuf::from(dir)),
        None => Ok(home()?.join(".codex")),
    }
}

fn gemini_settings_path() -> Result<PathBuf> {
    Ok(home()?.join(".gemini").join("settings.json"))
}

/// OpenCode loads every file in its global plugins directory at startup.
fn opencode_plugin_path() -> Result<PathBuf> {
    let config = match std::env::var_os("XDG_CONFIG_HOME") {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => home()?.join(".config"),
    };
    Ok(config.join("opencode").join("plugins").join("haze.js"))
}

fn quoted(exe: &str) -> String {
    format!("\"{}\"", exe.replace('"', "\\\""))
}

pub fn claude_command(exe: &str) -> String {
    format!("{} {HOOK_FLAG} claude", quoted(exe))
}

/// Codex and Gemini hooks name their event on the command line.
fn event_command(exe: &str, agent: &str, event: &str) -> String {
    format!("{} {HOOK_FLAG} {agent} {event}", quoted(exe))
}

/// Where an agent's hooks go and what they run. Claude Code, Codex
/// (`hooks.json`) and Gemini CLI (`settings.json`) share one layout:
/// `{"hooks": {"<Event>": [{"hooks": [{"type": "command", "command": …}]}]}}`.
struct HookFile {
    path: PathBuf,
    events: &'static [&'static str],
    command: Box<dyn Fn(&str) -> String>,
    /// In the agent's unit (seconds for Claude and Codex, milliseconds for Gemini).
    timeout: u64,
}

fn hook_file(agent: &str, exe: &str) -> Result<HookFile> {
    let exe = exe.to_string();
    Ok(match agent {
        "claude" => HookFile {
            path: claude_settings_path()?,
            events: CLAUDE_EVENTS,
            command: Box::new(move |_| claude_command(&exe)),
            timeout: 10,
        },
        "codex" => HookFile {
            path: codex_home()?.join("hooks.json"),
            events: CODEX_EVENTS,
            command: Box::new(move |e| event_command(&exe, "codex", e)),
            timeout: 10,
        },
        "gemini" => HookFile {
            path: gemini_settings_path()?,
            events: GEMINI_EVENTS,
            command: Box::new(move |e| event_command(&exe, "gemini", e)),
            timeout: 10_000,
        },
        other => bail!("unknown agent {other}"),
    })
}

fn is_ours(hook: &serde_json::Value) -> bool {
    hook.get("command")
        .and_then(|c| c.as_str())
        .is_some_and(|c| c.contains(HOOK_FLAG))
}

/// Removes Haze's hook groups from a settings document.
fn strip_hooks(settings: &mut serde_json::Value) {
    let Some(hooks) = settings.get_mut("hooks").and_then(|h| h.as_object_mut()) else {
        return;
    };
    for groups in hooks.values_mut() {
        if let Some(list) = groups.as_array_mut() {
            list.retain(|g| {
                !g.get("hooks")
                    .and_then(|h| h.as_array())
                    .is_some_and(|hs| hs.iter().any(is_ours))
            });
        }
    }
    hooks.retain(|_, v| v.as_array().is_none_or(|a| !a.is_empty()));
}

fn install_hooks_in(
    settings: &mut serde_json::Value,
    events: &[&str],
    command: &dyn Fn(&str) -> String,
    timeout: u64,
) {
    strip_hooks(settings);
    if !settings.is_object() {
        *settings = serde_json::json!({});
    }
    let hooks = settings
        .as_object_mut()
        .unwrap()
        .entry("hooks")
        .or_insert_with(|| serde_json::json!({}));
    if !hooks.is_object() {
        *hooks = serde_json::json!({});
    }
    for e in events {
        let list = hooks
            .as_object_mut()
            .unwrap()
            .entry(*e)
            .or_insert_with(|| serde_json::json!([]));
        if let Some(arr) = list.as_array_mut() {
            arr.push(serde_json::json!({ "hooks": [{ "type": "command", "command": command(e), "timeout": timeout }] }));
        }
    }
}

pub fn install_claude_in(settings: &mut serde_json::Value, command: &str) {
    install_hooks_in(settings, CLAUDE_EVENTS, &|_| command.to_string(), 10);
}

/// Haze's commands per event in a settings document.
fn our_commands(settings: &serde_json::Value) -> Vec<(String, String)> {
    let Some(hooks) = settings.get("hooks").and_then(|h| h.as_object()) else {
        return Vec::new();
    };
    hooks
        .iter()
        .flat_map(|(event, groups)| {
            groups
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|g| g.get("hooks").and_then(|h| h.as_array()))
                .flatten()
                .filter(|h| is_ours(h))
                .filter_map(move |h| Some((event.clone(), h.get("command")?.as_str()?.to_string())))
        })
        .collect()
}

/// Installed, and whether every event runs this Haze's command.
fn hooks_state(settings: &serde_json::Value, file: &HookFile) -> (bool, bool) {
    let ours = our_commands(settings);
    let complete = ours.len() == file.events.len()
        && file.events.iter().all(|e| {
            ours.iter()
                .any(|(ev, cmd)| ev == e && *cmd == (file.command)(e))
        });
    (!ours.is_empty(), complete)
}

fn read_json(path: &Path) -> Result<serde_json::Value> {
    match std::fs::read_to_string(path) {
        Ok(t) if !t.trim().is_empty() => serde_json::from_str(&t)
            .with_context(|| format!("{} is not valid JSON", path.display())),
        Ok(_) => Ok(serde_json::json!({})),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::json!({})),
        Err(e) => Err(e.into()),
    }
}

pub(crate) fn write_with_backup(path: &Path, text: &str) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let backup = path.with_extension(format!(
        "{}.haze-backup",
        path.extension().and_then(|e| e.to_str()).unwrap_or("bak")
    ));
    if path.exists() && !backup.exists() {
        std::fs::copy(path, &backup)?;
    }
    std::fs::write(path, text)?;
    Ok(())
}

// Codex `notify`: older Codex versions have no lifecycle hooks, only this.

fn codex_notify(doc: &toml_edit::DocumentMut) -> Vec<String> {
    doc.get("notify")
        .and_then(|n| n.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn read_codex_config() -> Result<(PathBuf, toml_edit::DocumentMut)> {
    let path = codex_home()?.join("config.toml");
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let doc = text.parse().context("config.toml is not valid TOML")?;
    Ok((path, doc))
}

// OpenCode: a plugin that reports its session events.

const OPENCODE_MARK: &str = "Installed by Haze";

pub fn opencode_plugin(exe: &str) -> String {
    let exe = serde_json::to_string(exe).unwrap_or_default();
    format!(
        r#"// {OPENCODE_MARK}: reports OpenCode's state to the Haze terminal it runs in.
// Remove it from Haze's Settings, or delete this file.
import {{ spawn, spawnSync }} from "node:child_process";

const HAZE = {exe};
const args = (state, message) => ["{HOOK_FLAG}", "opencode", state, ...(message ? [String(message).slice(0, 200)] : [])];

// Reports this process's sessions; None outside a Haze terminal.
const watch = () => {{
  if (!process.env.HAZE_TERMINAL_ID) return null;
  let last = null;
  const report = (state, message) => {{
    if (state === last && !message) return;
    last = state;
    try {{
      spawn(HAZE, args(state, message), {{ stdio: "ignore" }}).on("error", () => {{}});
    }} catch {{}}
  }};
  process.on("exit", () => {{
    try {{
      spawnSync(HAZE, args("clear"), {{ stdio: "ignore", timeout: 2000 }});
    }} catch {{}}
  }});
  report("idle");
  // Sessions at work; a subagent's session finishing must not mark its parent done.
  const busy = new Set();
  const settle = (id) => {{
    busy.delete(id);
    if (!busy.size) report("done");
  }};
  // OpenCode 2 puts the payload in `data`, OpenCode 1 in `properties`.
  return (event) => {{
    const p = event.data ?? event.properties ?? {{}};
    switch (event.type) {{
      case "session.execution.started":
        busy.add(p.sessionID);
        report("working");
        break;
      case "session.execution.succeeded":
      case "session.execution.interrupted":
        settle(p.sessionID);
        break;
      case "session.execution.failed":
        busy.delete(p.sessionID);
        report("error", p.error?.message);
        break;
      case "session.status": {{
        const type = p.status?.type;
        if (type === "busy" || type === "retry") busy.add(p.sessionID);
        else if (type === "idle") busy.delete(p.sessionID);
        else break;
        report(busy.size ? "working" : "done");
        break;
      }}
      case "session.idle":
        settle(p.sessionID);
        break;
      case "permission.asked":
      case "permission.updated":
        report("waiting", "Waiting for permission");
        break;
      // Questions: forms in OpenCode 2 (also MCP elicitations), question events in OpenCode 1.
      case "form.created":
        report("waiting", p.form?.fields?.[0]?.description ?? p.form?.title ?? "Waiting for your answer");
        break;
      case "question.asked":
        report("waiting", p.questions?.[0]?.question ?? "Waiting for your answer");
        break;
      case "permission.replied":
      case "form.replied":
      case "form.cancelled":
      case "question.replied":
      case "question.rejected":
        report(busy.size ? "working" : "done");
        break;
      case "session.error":
        report("error", p.error?.data?.message ?? p.error?.name);
        break;
    }}
  }};
}};

export default {{
  id: "haze.status",
  // OpenCode 2.
  setup: (api) => {{
    const onEvent = watch();
    if (onEvent) api.event.subscribe(onEvent);
  }},
  // OpenCode 1.
  server: async () => {{
    const onEvent = watch();
    return onEvent ? {{ event: async ({{ event }}) => onEvent(event) }} : {{}};
  }},
}};
"#
    )
}

pub fn status_of(agent: &str) -> Result<HookStatus> {
    let me = exe()?;
    match agent {
        "claude" | "gemini" => {
            let file = hook_file(agent, &me)?;
            let (installed, complete) = hooks_state(&read_json(&file.path)?, &file);
            Ok(HookStatus {
                installed,
                stale: installed && !complete,
                config_path: file.path.to_string_lossy().into_owned(),
                conflict: None,
            })
        }
        "codex" => {
            let file = hook_file("codex", &me)?;
            let (hooks, complete) = hooks_state(&read_json(&file.path)?, &file);
            let (_, doc) = read_codex_config()?;
            let notify = codex_notify(&doc);
            let ours = notify.iter().any(|a| a == HOOK_FLAG);
            Ok(HookStatus {
                installed: hooks || ours,
                // Installed by an older Haze (notify only), or by another Haze.
                stale: (hooks || ours) && (!complete || (ours && notify.first() != Some(&me))),
                config_path: file.path.to_string_lossy().into_owned(),
                conflict: None,
            })
        }
        "opencode" => {
            let path = opencode_plugin_path()?;
            let text = std::fs::read_to_string(&path).unwrap_or_default();
            let installed = text.contains(OPENCODE_MARK);
            Ok(HookStatus {
                installed,
                stale: installed && text != opencode_plugin(&me),
                config_path: path.to_string_lossy().into_owned(),
                conflict: (!text.is_empty() && !installed)
                    .then(|| format!("{} is not Haze's plugin", path.display())),
            })
        }
        other => bail!("unknown agent {other}"),
    }
}

pub fn install(agent: &str) -> Result<HookStatus> {
    let me = exe()?;
    match agent {
        "claude" | "codex" | "gemini" => {
            let file = hook_file(agent, &me)?;
            let mut settings = read_json(&file.path)?;
            install_hooks_in(&mut settings, file.events, &*file.command, file.timeout);
            write_with_backup(
                &file.path,
                &(serde_json::to_string_pretty(&settings)? + "\n"),
            )?;
            if agent == "codex" {
                // Also `notify`, for Codex versions without lifecycle hooks, unless
                // the user runs a program of their own there.
                let (path, mut doc) = read_codex_config()?;
                let notify = codex_notify(&doc);
                if notify.is_empty() || notify.iter().any(|a| a == HOOK_FLAG) {
                    let mut arr = toml_edit::Array::new();
                    for a in [me.as_str(), HOOK_FLAG, "codex"] {
                        arr.push(a);
                    }
                    // `notify` must be a top-level key, so insert it before any table.
                    doc.insert("notify", toml_edit::value(arr));
                    write_with_backup(&path, &doc.to_string())?;
                }
            }
        }
        "opencode" => {
            let path = opencode_plugin_path()?;
            if let Some(c) = status_of("opencode")?.conflict {
                bail!("{c}; not changed");
            }
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            std::fs::write(&path, opencode_plugin(&me))?;
        }
        other => bail!("unknown agent {other}"),
    }
    status_of(agent)
}

pub fn uninstall(agent: &str) -> Result<HookStatus> {
    let me = exe()?;
    match agent {
        "claude" | "codex" | "gemini" => {
            let file = hook_file(agent, &me)?;
            if file.path.exists() {
                let mut settings = read_json(&file.path)?;
                if !our_commands(&settings).is_empty() {
                    strip_hooks(&mut settings);
                    write_with_backup(
                        &file.path,
                        &(serde_json::to_string_pretty(&settings)? + "\n"),
                    )?;
                }
            }
            if agent == "codex" {
                let (path, mut doc) = read_codex_config()?;
                if codex_notify(&doc).iter().any(|a| a == HOOK_FLAG) {
                    doc.remove("notify");
                    write_with_backup(&path, &doc.to_string())?;
                }
            }
        }
        "opencode" => {
            let path = opencode_plugin_path()?;
            if status_of("opencode")?.installed {
                std::fs::remove_file(&path)?;
            }
        }
        other => bail!("unknown agent {other}"),
    }
    status_of(agent)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn maps_claude_events() {
        let st = |v: serde_json::Value| claude_state(&v).map(|s| s.map(|(st, _)| st));
        assert_eq!(
            st(json!({"hook_event_name": "UserPromptSubmit"})),
            Some(Some("working"))
        );
        assert_eq!(st(json!({"hook_event_name": "Stop"})), Some(Some("done")));
        assert_eq!(
            st(json!({"hook_event_name": "PermissionRequest"})),
            Some(Some("waiting"))
        );
        assert_eq!(
            st(
                json!({"hook_event_name": "Notification", "notification_type": "permission_prompt", "message": "Claude needs your permission to use Bash"})
            ),
            Some(Some("waiting"))
        );
        assert_eq!(
            st(
                json!({"hook_event_name": "Notification", "message": "Claude is waiting for your input"})
            ),
            Some(Some("done"))
        );
        assert_eq!(
            st(json!({"hook_event_name": "Notification", "notification_type": "auth_success"})),
            None
        );
        assert_eq!(
            st(json!({"hook_event_name": "Notification", "message": "Logged in"})),
            None
        );
        assert_eq!(st(json!({"hook_event_name": "SessionEnd"})), Some(None));
        assert_eq!(
            st(json!({"hook_event_name": "PostToolUse"})),
            Some(Some("working"))
        );
        assert_eq!(st(json!({"hook_event_name": "PreCompact"})), None);
    }

    #[test]
    fn maps_gemini_and_codex_events() {
        let gem = |e: &str, v: serde_json::Value| gemini_state(e, &v).map(|s| s.map(|(st, _)| st));
        assert_eq!(gem("BeforeAgent", json!({})), Some(Some("working")));
        assert_eq!(gem("AfterTool", json!({})), Some(Some("working")));
        assert_eq!(gem("AfterAgent", json!({})), Some(Some("done")));
        assert_eq!(
            gem(
                "Notification",
                json!({"notification_type": "ToolPermission", "message": "Allow shell?"})
            ),
            Some(Some("waiting"))
        );
        assert_eq!(
            gem("Notification", json!({"notification_type": "Other"})),
            None
        );
        assert_eq!(gem("SessionEnd", json!({})), Some(None));
        assert_eq!(gem("BeforeModel", json!({})), None);
        // Codex hooks share Claude Code's event names.
        let codex =
            |e: &str| claude_state(&json!({ "hook_event_name": e })).map(|s| s.map(|(st, _)| st));
        assert_eq!(codex("UserPromptSubmit"), Some(Some("working")));
        assert_eq!(codex("PermissionRequest"), Some(Some("waiting")));
        assert_eq!(codex("Interrupt"), Some(Some("done")));
        assert_eq!(opencode_state("working"), Some(Some("working")));
        assert_eq!(opencode_state("clear"), Some(None));
        assert_eq!(opencode_state("bogus"), None);
    }

    #[test]
    fn event_hooks_name_their_event_and_report_stale_installs() {
        let file = HookFile {
            path: PathBuf::new(),
            events: GEMINI_EVENTS,
            command: Box::new(|e| event_command("/x/haze", "gemini", e)),
            timeout: 10_000,
        };
        let mut s = json!({ "theme": "dark" });
        assert_eq!(hooks_state(&s, &file), (false, false));
        install_hooks_in(&mut s, file.events, &*file.command, file.timeout);
        assert_eq!(s["theme"], "dark");
        assert_eq!(
            s["hooks"]["AfterAgent"][0]["hooks"][0]["command"],
            "\"/x/haze\" --agent-hook gemini AfterAgent"
        );
        assert_eq!(s["hooks"]["AfterAgent"][0]["hooks"][0]["timeout"], 10_000);
        assert_eq!(hooks_state(&s, &file), (true, true));
        // Another Haze executable, or an event missing: installed but stale.
        let other = HookFile {
            command: Box::new(|e| event_command("/y/haze", "gemini", e)),
            ..file
        };
        assert_eq!(hooks_state(&s, &other), (true, false));
        s["hooks"].as_object_mut().unwrap().remove("BeforeTool");
        assert_eq!(hooks_state(&s, &other), (true, false));
        strip_hooks(&mut s);
        assert!(s["hooks"].as_object().unwrap().is_empty());
    }

    #[test]
    fn opencode_plugin_embeds_the_executable_safely() {
        let js = opencode_plugin(r#"C:\Program Files\Haze "x"\haze.exe"#);
        assert!(js.contains(OPENCODE_MARK));
        assert!(js.contains(r#"const HAZE = "C:\\Program Files\\Haze \"x\"\\haze.exe";"#));
        assert!(js.contains("\"--agent-hook\", \"opencode\""));
        assert!(js.contains("export default {"));
        assert!(js.contains("setup: (api) =>"));
        assert!(js.contains("case \"question.asked\":"));
        assert!(js.contains("case \"form.created\":"));
    }

    #[test]
    fn installs_and_removes_claude_hooks_keeping_user_settings() {
        let mut s = json!({
            "model": "opus",
            "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "say done" }] }] }
        });
        install_claude_in(&mut s, "\"/x/haze\" --agent-hook claude");
        install_claude_in(&mut s, "\"/x/haze\" --agent-hook claude");
        assert_eq!(s["model"], "opus");
        let stop = s["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2, "user hook kept, ours added once");
        assert_eq!(s["hooks"]["PreToolUse"].as_array().unwrap().len(), 1);
        strip_hooks(&mut s);
        assert_eq!(s["hooks"]["Stop"].as_array().unwrap().len(), 1);
        assert!(s["hooks"].get("PreToolUse").is_none());
    }
}
