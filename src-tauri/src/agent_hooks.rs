//! AI agent hooks. Claude Code and Codex call `haze --agent-hook <agent>`
//! (installed into their user config on request); the hook reports the
//! agent's state for the terminal it runs in (`HAZE_TERMINAL_ID`) to the PTY
//! host, which keeps it with the session and tells every Haze window.
//!
//! State is only ever taken from these lifecycle events — never guessed from
//! terminal output — and nothing from the prompt or transcript is stored.

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
        "Stop" => Some(("done", None)),
        "StopFailure" => Some(("error", message)),
        "SessionEnd" => None,
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
    let status = match agent {
        // Codex passes its notification JSON as the last argument.
        "codex" => {
            let payload: serde_json::Value = args
                .last()
                .and_then(|a| serde_json::from_str(a).ok())
                .unwrap_or_default();
            let kind = payload.get("type").and_then(|t| t.as_str()).unwrap_or("");
            match kind {
                "agent-turn-complete" => Some(status("codex", "done", None)),
                "approval-requested" => Some(status("codex", "waiting", None)),
                _ => return Ok(()),
            }
        }
        _ => {
            let mut input = String::new();
            std::io::stdin().take(1 << 20).read_to_string(&mut input)?;
            let payload: serde_json::Value = serde_json::from_str(&input)?;
            match claude_state(&payload) {
                None => return Ok(()),
                Some(None) => None,
                Some(Some((state, message))) => Some(status("claude", state, message)),
            }
        }
    };
    // Only talk to a host that is already running; a hook must not start one.
    let mut stream = Stream::connect(socket_name()?)?;
    write_frame(
        &mut stream,
        &ClientMsg {
            req: 0,
            body: Request::Agent { id, status },
        },
    )?;
    Ok(())
}

fn status(agent: &str, state: &str, message: Option<String>) -> AgentStatus {
    AgentStatus {
        agent: agent.into(),
        state: state.into(),
        message: message.map(|m| m.chars().take(200).collect()),
        at: now_ms(),
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
    /// Why it cannot be installed automatically (e.g. Codex already has a notify program).
    pub conflict: Option<String>,
}

fn exe() -> Result<String> {
    Ok(std::env::current_exe()?.to_string_lossy().into_owned())
}

fn claude_settings_path() -> Result<PathBuf> {
    Ok(dirs::home_dir()
        .context("no home directory")?
        .join(".claude")
        .join("settings.json"))
}

fn codex_config_path() -> Result<PathBuf> {
    let base = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".codex")))
        .context("no home directory")?;
    Ok(base.join("config.toml"))
}

pub fn claude_command(exe: &str) -> String {
    format!("\"{}\" {HOOK_FLAG} claude", exe.replace('"', "\\\""))
}

fn is_ours(hook: &serde_json::Value) -> bool {
    hook.get("command")
        .and_then(|c| c.as_str())
        .is_some_and(|c| c.contains(HOOK_FLAG))
}

/// Removes Haze's hook groups from a Claude settings document.
fn strip_claude(settings: &mut serde_json::Value) {
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

pub fn install_claude_in(settings: &mut serde_json::Value, command: &str) {
    strip_claude(settings);
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
    for e in CLAUDE_EVENTS {
        let list = hooks
            .as_object_mut()
            .unwrap()
            .entry(*e)
            .or_insert_with(|| serde_json::json!([]));
        if let Some(arr) = list.as_array_mut() {
            arr.push(serde_json::json!({ "hooks": [{ "type": "command", "command": command, "timeout": 10 }] }));
        }
    }
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

fn write_with_backup(path: &Path, text: &str) -> Result<()> {
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

pub fn status_of(agent: &str) -> Result<HookStatus> {
    let me = exe()?;
    match agent {
        "claude" => {
            let path = claude_settings_path()?;
            let settings = read_json(&path)?;
            let commands: Vec<String> = settings
                .get("hooks")
                .and_then(|h| h.as_object())
                .into_iter()
                .flat_map(|h| h.values())
                .filter_map(|g| g.as_array())
                .flatten()
                .filter_map(|g| g.get("hooks").and_then(|h| h.as_array()))
                .flatten()
                .filter(|h| is_ours(h))
                .filter_map(|h| {
                    h.get("command")
                        .and_then(|c| c.as_str())
                        .map(str::to_string)
                })
                .collect();
            // Installed by an older Haze that listened to fewer events.
            let missing = CLAUDE_EVENTS.iter().any(|e| {
                !settings["hooks"][*e]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|g| g.get("hooks").and_then(|h| h.as_array()))
                    .flatten()
                    .any(is_ours)
            });
            Ok(HookStatus {
                installed: !commands.is_empty(),
                stale: !commands.is_empty()
                    && (missing || commands.iter().any(|c| *c != claude_command(&me))),
                config_path: path.to_string_lossy().into_owned(),
                conflict: None,
            })
        }
        "codex" => {
            let path = codex_config_path()?;
            let text = std::fs::read_to_string(&path).unwrap_or_default();
            let doc: toml_edit::DocumentMut =
                text.parse().context("config.toml is not valid TOML")?;
            let notify: Vec<String> = doc
                .get("notify")
                .and_then(|n| n.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            let ours = notify.iter().any(|a| a == HOOK_FLAG);
            Ok(HookStatus {
                installed: ours,
                stale: ours && notify.first() != Some(&me),
                config_path: path.to_string_lossy().into_owned(),
                conflict: (!notify.is_empty() && !ours)
                    .then(|| format!("Codex already runs `{}` on notify", notify.join(" "))),
            })
        }
        other => bail!("unknown agent {other}"),
    }
}

pub fn install(agent: &str) -> Result<HookStatus> {
    let me = exe()?;
    match agent {
        "claude" => {
            let path = claude_settings_path()?;
            let mut settings = read_json(&path)?;
            install_claude_in(&mut settings, &claude_command(&me));
            write_with_backup(&path, &(serde_json::to_string_pretty(&settings)? + "\n"))?;
        }
        "codex" => {
            let path = codex_config_path()?;
            let text = std::fs::read_to_string(&path).unwrap_or_default();
            let mut doc: toml_edit::DocumentMut =
                text.parse().context("config.toml is not valid TOML")?;
            if let Some(c) = status_of("codex")?.conflict {
                bail!("{c}; not changed");
            }
            let mut arr = toml_edit::Array::new();
            for a in [me.as_str(), HOOK_FLAG, "codex"] {
                arr.push(a);
            }
            // `notify` must be a top-level key, so insert it before any table.
            doc.insert("notify", toml_edit::value(arr));
            write_with_backup(&path, &doc.to_string())?;
        }
        other => bail!("unknown agent {other}"),
    }
    status_of(agent)
}

pub fn uninstall(agent: &str) -> Result<HookStatus> {
    match agent {
        "claude" => {
            let path = claude_settings_path()?;
            if path.exists() {
                let mut settings = read_json(&path)?;
                strip_claude(&mut settings);
                write_with_backup(&path, &(serde_json::to_string_pretty(&settings)? + "\n"))?;
            }
        }
        "codex" => {
            let path = codex_config_path()?;
            if path.exists() && status_of("codex")?.installed {
                let mut doc: toml_edit::DocumentMut = std::fs::read_to_string(&path)?.parse()?;
                doc.remove("notify");
                write_with_backup(&path, &doc.to_string())?;
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
        strip_claude(&mut s);
        assert_eq!(s["hooks"]["Stop"].as_array().unwrap().len(), 1);
        assert!(s["hooks"].get("PreToolUse").is_none());
    }
}
