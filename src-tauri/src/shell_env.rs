//! Apps started from Finder/Dock get launchd's minimal PATH
//! (/usr/bin:/bin:/usr/sbin:/sbin), so `dotnet`, the C# language server and
//! git from Homebrew are not found. Take PATH from the user's login shell,
//! like a terminal would, before anything spawns a process.
//!
//! An interactive login shell takes a few hundred milliseconds (more with a
//! heavy profile), so launches use the PATH the last run saw and ask the
//! shell again in the background for the next one. Only the first launch waits.
//!
//! Every platform also gets the folders .NET installs to (see `set_path`).

#[cfg(target_os = "macos")]
pub fn load_login_path() {
    match read_cache() {
        Some(cached) => {
            apply(Some(cached));
            std::thread::spawn(|| {
                // Not while the window is starting up.
                std::thread::sleep(std::time::Duration::from_secs(3));
                if let Some(path) = query_shell() {
                    write_cache(&path);
                }
            });
        }
        None => {
            let path = query_shell();
            if let Some(p) = &path {
                write_cache(p);
            }
            apply(path);
        }
    }
}

#[cfg(target_os = "macos")]
fn cache_path() -> Option<std::path::PathBuf> {
    Some(dirs::cache_dir()?.join("dev.haze.app").join("login-path"))
}

#[cfg(target_os = "macos")]
fn read_cache() -> Option<String> {
    let path = std::fs::read_to_string(cache_path()?).ok()?;
    Some(path).filter(|p| !p.is_empty())
}

#[cfg(target_os = "macos")]
fn write_cache(path: &str) {
    let Some(file) = cache_path() else { return };
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // Written aside then renamed: a launch never reads half a PATH.
    let tmp = file.with_extension("tmp");
    if std::fs::write(&tmp, path).is_ok() {
        let _ = std::fs::rename(&tmp, &file);
    }
}

/// PATH as the user's interactive login shell sets it up.
#[cfg(target_os = "macos")]
fn query_shell() -> Option<String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    const MARK: &str = "__HAZE_PATH__";
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut child = Command::new(&shell)
        .args(["-ilc", &format!("printf '{MARK}%s{MARK}' \"$PATH\"")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    // A broken shell profile must not keep the app from starting.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
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
    out.split(MARK)
        .nth(1)
        .filter(|p| !p.is_empty())
        .map(str::to_owned)
}

#[cfg(target_os = "macos")]
fn apply(from_shell: Option<String>) {
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
    for d in ["/opt/homebrew/bin", "/usr/local/bin"] {
        dirs.push(d.into());
    }
    set_path(dirs);
}

/// PATH as given, plus where .NET installs: found when the profile does not
/// set them up, or when .NET was installed after Haze started.
#[cfg(not(target_os = "macos"))]
pub fn load_login_path() {
    let dirs = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    set_path(dirs);
}

fn set_path(mut dirs: Vec<std::path::PathBuf>) {
    // `dotnet-install` installs per user, under ~/.dotnet.
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".dotnet").join("tools"));
        dirs.push(home.join(".dotnet"));
    }
    #[cfg(target_os = "macos")]
    dirs.push("/usr/local/share/dotnet".into());
    #[cfg(windows)]
    if let Some(p) = std::env::var_os("ProgramFiles") {
        dirs.push(std::path::PathBuf::from(p).join("dotnet"));
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    for d in ["/usr/share/dotnet", "/usr/lib/dotnet", "/snap/bin"] {
        dirs.push(d.into());
    }
    let mut seen = std::collections::HashSet::new();
    dirs.retain(|d| !d.as_os_str().is_empty() && seen.insert(d.clone()));
    if let Ok(path) = std::env::join_paths(dirs) {
        std::env::set_var("PATH", path);
    }
}
