//! Terminal sessions.
//!
//! Shells run inside a separate, detached "PTY host" process (the same Haze
//! executable started with `--pty-host`). The UI talks to it over a local
//! socket, so closing or updating the Haze window never kills a running shell
//! or AI agent: reopening Haze reattaches and replays the recent output.

pub mod client;
pub mod host;
pub mod protocol;

#[cfg(not(windows))]
use std::path::PathBuf;

use interprocess::local_socket::Name;

pub const HOST_FLAG: &str = "--pty-host";

/// Location of the host socket for the current user and protocol version.
pub fn socket_name() -> std::io::Result<Name<'static>> {
    #[cfg(windows)]
    {
        use interprocess::local_socket::{GenericNamespaced, ToNsName};
        let user = std::env::var("USERNAME").unwrap_or_else(|_| "user".into());
        format!("haze-pty-v{}-{}", protocol::PROTOCOL_VERSION, user)
            .to_ns_name::<GenericNamespaced>()
    }
    #[cfg(not(windows))]
    {
        use interprocess::local_socket::{GenericFilePath, ToFsName};
        socket_path()?.to_fs_name::<GenericFilePath>()
    }
}

#[cfg(not(windows))]
pub fn socket_path() -> std::io::Result<PathBuf> {
    let dir = runtime_dir();
    std::fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(dir.join(format!("pty-v{}.sock", protocol::PROTOCOL_VERSION)))
}

#[cfg(not(windows))]
fn runtime_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("HAZE_RUNTIME_DIR") {
        return PathBuf::from(dir);
    }
    dirs::runtime_dir()
        .map(|d| d.join("haze"))
        .or_else(|| dirs::home_dir().map(|h| h.join(".haze").join("run")))
        .unwrap_or_else(|| std::env::temp_dir().join("haze"))
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Apps started from Finder/Dock get no locale, so a shell would run in the C
/// locale and edit UTF-8 input byte by byte: Vietnamese shows as <0303> and
/// IME backspaces split characters. Terminal.app sets one too. Added on the UI
/// side so it also reaches shells started by a host left over from an older build.
pub fn add_utf8_locale(env: &mut Vec<(String, String)>) {
    #[cfg(unix)]
    if !["LC_ALL", "LC_CTYPE", "LANG"].iter().any(|k| {
        std::env::var_os(k).is_some_and(|v| !v.is_empty()) || env.iter().any(|(n, _)| n == k)
    }) {
        let ctype = if cfg!(target_os = "macos") {
            "UTF-8"
        } else {
            "C.UTF-8"
        };
        env.push(("LC_CTYPE".into(), ctype.into()));
    }
    #[cfg(not(unix))]
    let _ = env;
}
