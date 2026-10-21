//! Apps started from Finder/Dock get launchd's minimal PATH
//! (/usr/bin:/bin:/usr/sbin:/sbin), so `dotnet`, the C# language server and
//! git from Homebrew are not found. Take PATH from the user's login shell,
//! like a terminal would, before anything spawns a process.

#[cfg(target_os = "macos")]
pub fn load_login_path() {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    const MARK: &str = "__HAZE_PATH__";
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let child = Command::new(&shell)
        .args(["-ilc", &format!("printf '{MARK}%s{MARK}' \"$PATH\"")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn();
    let mut from_shell = None;
    if let Ok(mut child) = child {
        // A broken shell profile must not keep the app from starting.
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20))
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
            }
        }
        let mut out = String::new();
        if let Some(mut stdout) = child.stdout.take() {
            let _ = stdout.read_to_string(&mut out);
        }
        from_shell = out
            .split(MARK)
            .nth(1)
            .filter(|p| !p.is_empty())
            .map(str::to_owned);
    }

    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    for source in [
        from_shell.map(std::ffi::OsString::from),
        std::env::var_os("PATH"),
    ]
    .into_iter()
    .flatten()
    {
        dirs.extend(std::env::split_paths(&source));
    }
    // Usual install locations, in case the profile does not set them up.
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".dotnet").join("tools"));
        dirs.push(home.join(".dotnet"));
    }
    for d in [
        "/usr/local/share/dotnet",
        "/opt/homebrew/bin",
        "/usr/local/bin",
    ] {
        dirs.push(d.into());
    }
    let mut seen = std::collections::HashSet::new();
    dirs.retain(|d| !d.as_os_str().is_empty() && seen.insert(d.clone()));
    if let Ok(path) = std::env::join_paths(dirs) {
        std::env::set_var("PATH", path);
    }
}

#[cfg(not(target_os = "macos"))]
pub fn load_login_path() {}
