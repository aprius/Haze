//! Agent state from the escape sequences agents print, so a terminal shows
//! it without any hook installed:
//!
//! - `OSC 6973 ; <state> [; <agent> [; <message>]]`, Haze's own, for any tool
//!   or script: state is idle, working, waiting, done, error or clear.
//! - `OSC 9 ; <text>` (iTerm2) and `OSC 777 ; notify ; <title> ; <body>`
//!   notifications: waiting when they ask for a permission or approval, else
//!   done.
//! - `OSC 9 ; 4 ; <st> ; <pr>` progress (ConEmu / Windows Terminal): 1 or 3 =
//!   working, 2 = error, 0 = cleared (done if it was working).
//!
//! Notifications and progress bars also come from other programs (`dotnet
//! build`'s terminal logger draws one), so the host only lets them update an
//! agent it already knows of (see `next_status`).
//!
//! Sequences end with BEL or ST (`ESC \`) and may be split across reads.

use super::protocol::AgentStatus;

/// What a sequence says about the agent.
#[derive(Debug, Clone, PartialEq)]
pub enum Signal {
    /// Haze's own sequence: a state, from an agent it may name.
    Haze {
        state: &'static str,
        agent: Option<String>,
        message: Option<String>,
    },
    /// Haze's sequence asked to clear the agent.
    Clear,
    /// A desktop notification; `agent` when it names a known one.
    Notification {
        state: &'static str,
        agent: Option<String>,
        message: Option<String>,
    },
    /// A progress bar running (working) or failed (error).
    Progress(&'static str),
    /// Progress cleared: done, if the agent was working.
    ProgressEnd,
}

/// The agent state after `signal`, given the agent the output named while
/// the same program is in front (`known`); `None` when the signal changes
/// nothing (it cannot be told from another program's).
pub fn next_status(
    signal: Signal,
    known: Option<AgentStatus>,
    at: u64,
) -> Option<Option<AgentStatus>> {
    let status = |agent: String, state: &str, message: Option<String>| AgentStatus {
        agent,
        state: state.into(),
        message,
        at,
        checks: Vec::new(),
    };
    Some(match signal {
        Signal::Clear => None,
        Signal::Haze {
            state,
            agent,
            message,
        } => Some(status(
            agent
                .or(known.map(|a| a.agent))
                .unwrap_or_else(|| "agent".into()),
            state,
            message,
        )),
        Signal::Notification {
            state,
            agent,
            message,
        } => Some(status(agent.or(known.map(|a| a.agent))?, state, message)),
        Signal::Progress(state) => Some(status(known?.agent, state, None)),
        Signal::ProgressEnd => match known {
            Some(a) if a.state == "working" => Some(status(a.agent, "done", None)),
            _ => return None,
        },
    })
}

/// A started sequence longer than this is not one of ours; it is dropped.
const MAX_OSC: usize = 4096;

#[derive(Default)]
pub struct OscScanner {
    /// The unfinished sequence carried over from the previous read, after `ESC ]`.
    pending: Option<Vec<u8>>,
    /// The previous read ended with ESC.
    esc: bool,
}

impl OscScanner {
    /// Feeds terminal output; returns the signals of the sequences it completes.
    pub fn feed(&mut self, data: &[u8]) -> Vec<Signal> {
        let mut out = Vec::new();
        for &b in data {
            match &mut self.pending {
                None => {
                    if self.esc && b == b']' {
                        self.pending = Some(Vec::new());
                    }
                    self.esc = b == 0x1b;
                }
                Some(buf) => {
                    let end = b == 0x07 || (self.esc && b == b'\\');
                    if end {
                        if self.esc {
                            buf.pop();
                        }
                        if let Some(s) = parse(buf) {
                            out.push(s);
                        }
                        self.pending = None;
                        self.esc = false;
                        continue;
                    }
                    self.esc = b == 0x1b;
                    // A lone ESC that is not part of ST aborts the sequence.
                    if buf.last() == Some(&0x1b) && b != b'\\' {
                        self.pending = None;
                        self.esc = b == 0x1b;
                        continue;
                    }
                    buf.push(b);
                    if buf.len() > MAX_OSC {
                        self.pending = None;
                    }
                }
            }
        }
        out
    }
}

fn parse(body: &[u8]) -> Option<Signal> {
    let text = String::from_utf8_lossy(body);
    let (code, rest) = text.split_once(';')?;
    match code {
        "9" => {
            if let Some(progress) = rest.strip_prefix("4;") {
                return match progress.split(';').next()? {
                    "1" | "3" => Some(Signal::Progress("working")),
                    "2" => Some(Signal::Progress("error")),
                    "0" => Some(Signal::ProgressEnd),
                    _ => None,
                };
            }
            // `9;9;<cwd>` (ConEmu) and other numeric subcommands are not notifications.
            if rest.split(';').next()?.chars().all(|c| c.is_ascii_digit()) {
                return None;
            }
            Some(notification(rest))
        }
        "777" => {
            let mut parts = rest.splitn(3, ';');
            if parts.next()? != "notify" {
                return None;
            }
            let title = parts.next().unwrap_or("");
            let body = parts.next().unwrap_or("");
            Some(notification(&format!("{title}: {body}")))
        }
        "6973" => {
            let mut parts = rest.splitn(3, ';');
            let st = match parts.next()? {
                "idle" => "idle",
                "working" => "working",
                "waiting" => "waiting",
                "done" => "done",
                "error" => "error",
                "clear" => return Some(Signal::Clear),
                _ => return None,
            };
            let agent = parts
                .next()
                .filter(|a| !a.is_empty())
                .map(|a| a.chars().take(32).collect());
            let message = parts.next().filter(|m| !m.is_empty()).map(clip);
            Some(Signal::Haze {
                state: st,
                agent,
                message,
            })
        }
        _ => None,
    }
}

fn clip(message: &str) -> String {
    message.chars().take(200).collect()
}

/// A notification asks for the user when it mentions a permission or an
/// approval; otherwise the agent finished its turn.
fn notification(text: &str) -> Signal {
    let lower = text.to_lowercase();
    let state = if lower.contains("permission") || lower.contains("approv") {
        "waiting"
    } else {
        "done"
    };
    let agent = [
        ("claude", "claude"),
        ("codex", "codex"),
        ("gemini", "gemini"),
        ("opencode", "opencode"),
        ("deepcode", "deepcode"),
        ("deep code", "deepcode"),
    ]
    .into_iter()
    .find(|(name, _)| lower.contains(name))
    .map(|(_, agent)| agent.to_string());
    let text = text.trim();
    Signal::Notification {
        state,
        agent,
        message: (!text.is_empty()).then(|| clip(text)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn st(s: &Signal) -> (&str, Option<&str>) {
        match s {
            Signal::Haze { state, agent, .. } => (state, agent.as_deref()),
            Signal::Notification { state, agent, .. } => (state, agent.as_deref()),
            Signal::Progress(state) => (state, None),
            Signal::ProgressEnd => ("progress-end", None),
            Signal::Clear => ("clear", None),
        }
    }

    #[test]
    fn reads_progress_notifications_and_haze_sequences() {
        let mut sc = OscScanner::default();
        let got = sc.feed(
            b"text\x1b]9;4;3;0\x07more\x1b]9;4;0;0\x1b\\\x1b]9;Claude needs your permission to use Bash\x07\
              \x1b]777;notify;Codex;Turn complete\x07\x1b]6973;working;gemini;Reading files\x07\x1b]6973;clear\x07",
        );
        let states: Vec<_> = got.iter().map(st).collect();
        assert_eq!(
            states,
            vec![
                ("working", None),
                ("progress-end", None),
                ("waiting", Some("claude")),
                ("done", Some("codex")),
                ("working", Some("gemini")),
                ("clear", None),
            ]
        );
        assert!(matches!(got[0], Signal::Progress(_)));
        assert!(matches!(got[2], Signal::Notification { .. }));
        let Signal::Haze { message, .. } = &got[4] else {
            panic!()
        };
        assert_eq!(message.as_deref(), Some("Reading files"));
    }

    #[test]
    fn names_deep_code_in_notifications() {
        for text in ["DeepCode: task completed", "Deep Code: task failed"] {
            match notification(text) {
                Signal::Notification { agent, .. } => {
                    assert_eq!(agent.as_deref(), Some("deepcode"), "{text}")
                }
                other => panic!("{other:?}"),
            }
        }
    }

    #[test]
    fn handles_sequences_split_across_reads() {
        let mut sc = OscScanner::default();
        assert!(sc.feed(b"abc\x1b").is_empty());
        assert!(sc.feed(b"]9;4;").is_empty());
        assert!(sc.feed(b"1;50\x1b").is_empty());
        assert_eq!(
            sc.feed(b"\\rest").iter().map(st).collect::<Vec<_>>(),
            vec![("working", None)]
        );
    }

    #[test]
    fn ignores_other_sequences() {
        let mut sc = OscScanner::default();
        // Title, cwd (OSC 7 and ConEmu's 9;9), hyperlinks, colors.
        let got = sc.feed(
            b"\x1b]0;title\x07\x1b]7;file:///tmp\x07\x1b]9;9;C:\\x\x07\x1b]8;;http://a\x1b\\link\x1b]8;;\x1b\\\x1b]11;?\x07\x1b]6973;bogus\x07",
        );
        assert!(got.is_empty(), "{got:?}");
    }

    #[test]
    fn only_lets_known_agents_be_updated_by_progress_and_plain_notifications() {
        let agent = |state: &str| AgentStatus {
            agent: "claude".into(),
            state: state.into(),
            message: None,
            at: 1,
            checks: Vec::new(),
        };
        let state = |r: Option<Option<AgentStatus>>| r.map(|s| s.map(|a| (a.agent, a.state)));
        let pair = |a: &str, s: &str| Some(Some((a.to_string(), s.to_string())));
        let notify = |agent: Option<&str>| Signal::Notification {
            state: "done",
            agent: agent.map(str::to_string),
            message: None,
        };
        // A progress bar or an unnamed notification alone (`dotnet build`) changes nothing.
        assert_eq!(
            state(next_status(Signal::Progress("working"), None, 2)),
            None
        );
        assert_eq!(state(next_status(Signal::ProgressEnd, None, 2)), None);
        assert_eq!(state(next_status(notify(None), None, 2)), None);
        // A notification naming an agent, or Haze's sequence, starts one.
        assert_eq!(
            state(next_status(notify(Some("codex")), None, 2)),
            pair("codex", "done")
        );
        let haze = Signal::Haze {
            state: "working",
            agent: None,
            message: None,
        };
        assert_eq!(state(next_status(haze, None, 2)), pair("agent", "working"));
        // Then progress updates it, and ending progress finishes a working agent only.
        assert_eq!(
            state(next_status(
                Signal::Progress("working"),
                Some(agent("done")),
                2
            )),
            pair("claude", "working")
        );
        assert_eq!(
            state(next_status(Signal::ProgressEnd, Some(agent("working")), 2)),
            pair("claude", "done")
        );
        assert_eq!(
            state(next_status(Signal::ProgressEnd, Some(agent("waiting")), 2)),
            None
        );
        assert_eq!(
            state(next_status(notify(None), Some(agent("working")), 2)),
            pair("claude", "done")
        );
        assert_eq!(
            state(next_status(Signal::Clear, Some(agent("done")), 2)),
            Some(None)
        );
    }

    #[test]
    fn drops_runaway_and_aborted_sequences() {
        let mut sc = OscScanner::default();
        let mut long = b"\x1b]9;".to_vec();
        long.extend(std::iter::repeat_n(b'x', MAX_OSC + 10));
        assert!(sc.feed(&long).is_empty());
        // The overlong one was dropped; the next sequence is read normally.
        assert_eq!(
            sc.feed(b"\x07\x1b]9;4;1;0\x07")
                .iter()
                .map(st)
                .collect::<Vec<_>>(),
            vec![("working", None)]
        );
        // ESC followed by something other than `\` aborts.
        assert!(sc.feed(b"\x1b]9;4;1;0\x1b[0m\x07").is_empty());
    }
}
