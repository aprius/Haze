//! Wire protocol between the Haze UI process and the detached PTY host.
//!
//! Frames are a little-endian `u32` byte length followed by a JSON document.
//! Terminal output travels as base64 so arbitrary bytes survive JSON.

use std::io::{self, Read, Write};

use serde::{Deserialize, Serialize};

/// Bumped whenever the protocol changes incompatibly. It is part of the socket
/// name, so a new Haze build never talks to an older host.
pub const PROTOCOL_VERSION: u32 = 2;

const MAX_FRAME: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionSpec {
    pub project_id: Option<String>,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub title: Option<String>,
    /// Program and arguments. `None` starts the user's default shell.
    pub command: Option<Vec<String>>,
    #[serde(default)]
    pub env: Vec<(String, String)>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub project_id: Option<String>,
    pub cwd: String,
    pub title: String,
    pub pid: Option<u32>,
    pub created_at: u64,
    pub running: bool,
    pub exit_code: Option<u32>,
    /// AI agent running in this terminal, as reported by its hooks.
    #[serde(default)]
    pub agent: Option<AgentStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    /// `claude` or `codex`.
    pub agent: String,
    /// idle | working | waiting | done | error
    pub state: String,
    pub message: Option<String>,
    pub at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum Request {
    Hello {
        version: u32,
    },
    List,
    Create {
        spec: SessionSpec,
    },
    Attach {
        id: String,
    },
    Detach {
        id: String,
    },
    Write {
        id: String,
        data: String,
    },
    Resize {
        id: String,
        cols: u16,
        rows: u16,
    },
    /// Kills the process (if still running) and forgets the session.
    Close {
        id: String,
    },
    /// Sent by `haze --agent-hook` from inside a terminal; `None` clears it.
    Agent {
        id: String,
        status: Option<AgentStatus>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClientMsg {
    /// Correlation id; `0` means the client does not want a reply.
    pub req: u64,
    pub body: Request,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum Reply {
    Hello { version: u32, pid: u32 },
    Sessions { sessions: Vec<SessionInfo> },
    Created { session: SessionInfo },
    Ok,
    Error { message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum Event {
    /// Everything the session printed so far (bounded); sent once per attach,
    /// strictly before any `Output` for that attach.
    Snapshot {
        id: String,
        data: String,
    },
    Output {
        id: String,
        data: String,
    },
    Exit {
        id: String,
        code: Option<u32>,
    },
    /// An agent's state changed (sent to every client, attached or not).
    Agent {
        id: String,
        status: Option<AgentStatus>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "k", rename_all = "camelCase")]
pub enum ServerMsg {
    Reply { req: u64, body: Reply },
    Event { body: Event },
}

pub fn write_frame<W: Write, T: Serialize>(w: &mut W, msg: &T) -> io::Result<()> {
    let bytes = serde_json::to_vec(msg).map_err(io::Error::other)?;
    let len = u32::try_from(bytes.len()).map_err(io::Error::other)?;
    let mut frame = Vec::with_capacity(4 + bytes.len());
    frame.extend_from_slice(&len.to_le_bytes());
    frame.extend_from_slice(&bytes);
    w.write_all(&frame)?;
    w.flush()
}

/// Returns `Ok(None)` on a clean end of stream.
pub fn read_frame<R: Read, T: for<'de> Deserialize<'de>>(r: &mut R) -> io::Result<Option<T>> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_le_bytes(len) as usize;
    if len > MAX_FRAME {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "frame too large",
        ));
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf)?;
    serde_json::from_slice(&buf)
        .map(Some)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_round_trip() {
        let msgs = vec![
            ClientMsg {
                req: 1,
                body: Request::Hello {
                    version: PROTOCOL_VERSION,
                },
            },
            ClientMsg {
                req: 0,
                body: Request::Write {
                    id: "a".into(),
                    data: "ls\r".into(),
                },
            },
        ];
        let mut buf = Vec::new();
        for m in &msgs {
            write_frame(&mut buf, m).unwrap();
        }
        let mut cur = io::Cursor::new(buf);
        let mut got = Vec::new();
        while let Some(m) = read_frame::<_, ClientMsg>(&mut cur).unwrap() {
            got.push(m);
        }
        assert_eq!(got, msgs);
    }

    #[test]
    fn rejects_oversized_frame() {
        let mut buf = Vec::new();
        buf.extend_from_slice(&(u32::MAX).to_le_bytes());
        let err = read_frame::<_, ClientMsg>(&mut io::Cursor::new(buf)).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }
}
