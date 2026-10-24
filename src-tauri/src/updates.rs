//! "Check for Updates": compares this build's version with the latest GitHub
//! release, and installs it. A Homebrew install updates through the bundled
//! `haze update` in Terminal, so brew keeps track of the version. Otherwise Haze
//! downloads the release itself and swaps it in place: the DMG's Haze.app (macOS),
//! the AppImage (Linux) or haze.exe (Windows). A running file can be renamed but
//! not overwritten, so the terminal host, started from the old file, keeps running.
//! A .deb/.rpm install or a read-only folder opens the release page.

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const LATEST_RELEASE: &str = "https://api.github.com/repos/aprius/Haze/releases/latest";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    /// The release page on GitHub.
    pub url: String,
    pub available: bool,
}

#[derive(Deserialize)]
struct ReleaseJson {
    tag_name: String,
    html_url: String,
    #[serde(default)]
    assets: Vec<AssetJson>,
}

#[derive(Deserialize)]
struct AssetJson {
    name: String,
    browser_download_url: String,
    size: u64,
    /// `sha256:<hex>`, computed by GitHub on upload.
    digest: Option<String>,
}

/// How this copy of Haze can be updated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InstallKind {
    /// Installed by the Homebrew cask: `haze update` in Terminal.
    Brew,
    /// Downloaded and installed by Haze: a Haze.app, AppImage or haze.exe in a writable folder.
    Bundle,
    /// Anything else (.deb, .rpm, a dev build, a read-only folder): the release page.
    Manual,
}

#[derive(Debug, Clone, Serialize)]
pub struct Progress {
    pub received: u64,
    pub total: u64,
}

/// `v1.2.3` → `[1, 2, 3]`; anything after `-` or `+` (pre-release, build) is ignored.
fn parse(version: &str) -> Vec<u64> {
    let v = version.trim().trim_start_matches(['v', 'V']);
    let core = v.split(['-', '+']).next().unwrap_or_default();
    core.split('.').map(|n| n.parse().unwrap_or(0)).collect()
}

fn newer(latest: &str, current: &str) -> bool {
    let (mut a, mut b) = (parse(latest), parse(current));
    let len = a.len().max(b.len());
    a.resize(len, 0);
    b.resize(len, 0);
    a > b
}

fn agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .tls_config(
            ureq::tls::TlsConfig::builder()
                .root_certs(ureq::tls::RootCerts::PlatformVerifier)
                .build(),
        )
        .http_status_as_error(false)
        .timeout_global(Some(timeout))
        .user_agent("Haze")
        .build()
        .into()
}

fn latest_release() -> Result<ReleaseJson> {
    // Short: a slow network should not hold a blocking thread for long.
    let mut resp = agent(Duration::from_secs(10))
        .get(LATEST_RELEASE)
        .header("Accept", "application/vnd.github+json")
        .call()
        .context("cannot reach GitHub")?;
    match resp.status().as_u16() {
        200 => {}
        404 => bail!("no release has been published yet"),
        403 | 429 => bail!("GitHub is rate limiting requests, try again later"),
        s => bail!("GitHub answered HTTP {s}"),
    }
    resp.body_mut().read_json().context("unexpected answer from GitHub")
}

fn current_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

pub fn check() -> Result<UpdateInfo> {
    let current = current_version();
    let release = latest_release()?;
    let latest = release.tag_name.trim_start_matches(['v', 'V']).to_string();
    Ok(UpdateInfo {
        available: newer(&latest, &current),
        current,
        latest,
        url: release.html_url,
    })
}

// ---------------------------------------------------------------- installing

/// What Haze replaces when it updates itself.
enum Target {
    /// The running Haze.app (macOS), swapped for the one in the release's DMG.
    #[cfg(target_os = "macos")]
    Bundle(PathBuf),
    /// The running AppImage file (Linux, `$APPIMAGE`), replaced by the new one.
    #[cfg(target_os = "linux")]
    AppImage(PathBuf),
    /// The running haze.exe (Windows), renamed aside for the new one.
    #[cfg(windows)]
    Exe(PathBuf),
}

impl Target {
    fn asset(&self, version: &str) -> String {
        match self {
            #[cfg(target_os = "macos")]
            Target::Bundle(_) => format!("Haze_{version}_universal.dmg"),
            #[cfg(target_os = "linux")]
            Target::AppImage(_) => format!("Haze_{version}_amd64.AppImage"),
            #[cfg(windows)]
            Target::Exe(_) => format!("Haze_{version}_x64.exe"),
        }
    }
}

/// Whether a file can be created in `dir` (the new copy is staged next to the old one,
/// so the swap is a rename).
#[cfg(unix)]
fn writable(dir: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Ok(dir) = std::ffi::CString::new(dir.as_os_str().as_bytes()) else { return false };
    // SAFETY: a valid NUL-terminated path.
    unsafe { libc::access(dir.as_ptr(), libc::W_OK) == 0 }
}

/// Windows has no cheap equivalent of `access`: try creating a file.
#[cfg(windows)]
fn writable(dir: &Path) -> bool {
    tempfile::tempfile_in(dir).is_ok()
}

/// The running Haze.app.
#[cfg(target_os = "macos")]
fn bundle() -> Result<PathBuf> {
    let exe = std::env::current_exe().context("cannot locate Haze")?;
    exe.ancestors()
        .find(|p| p.extension().is_some_and(|e| e == "app"))
        .map(Path::to_path_buf)
        .context("Haze is not running from an app bundle")
}

/// The `haze` command inside the bundle (src-tauri/cli/haze).
#[cfg(target_os = "macos")]
fn bundled_cli(bundle: &Path) -> PathBuf {
    bundle.join("Contents/Resources/haze")
}

#[cfg(target_os = "macos")]
fn is_brew_install() -> bool {
    let caskroom = ["/opt/homebrew/Caskroom/haze", "/usr/local/Caskroom/haze"];
    caskroom.iter().any(|p| Path::new(p).is_dir()) && bundle().is_ok_and(|b| bundled_cli(&b).is_file())
}

#[cfg(not(target_os = "macos"))]
fn is_brew_install() -> bool {
    false
}

fn target() -> Option<Target> {
    if cfg!(debug_assertions) {
        return None;
    }
    #[cfg(target_os = "macos")]
    {
        let bundle = bundle().ok()?;
        writable(bundle.parent()?).then_some(Target::Bundle(bundle))
    }
    #[cfg(target_os = "linux")]
    {
        // A .deb or .rpm install needs root; only the AppImage (x64 only) is replaced.
        let image = PathBuf::from(std::env::var_os("APPIMAGE")?);
        (cfg!(target_arch = "x86_64") && image.is_file() && writable(image.parent()?))
            .then_some(Target::AppImage(image))
    }
    #[cfg(windows)]
    {
        // The NSIS install (per user) is writable; an MSI one under Program Files is not.
        let exe = std::env::current_exe().ok()?;
        writable(exe.parent()?).then_some(Target::Exe(exe))
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    None
}

pub fn install_kind() -> InstallKind {
    if is_brew_install() {
        InstallKind::Brew
    } else if target().is_some() {
        InstallKind::Bundle
    } else {
        InstallKind::Manual
    }
}

/// Opens Terminal running `haze update`, which upgrades the cask and restarts Haze.
#[cfg(target_os = "macos")]
pub fn update_in_terminal() -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let cli = bundled_cli(&bundle()?);
    let dir = std::env::temp_dir().join("haze-update");
    std::fs::create_dir_all(&dir)?;
    // A .command file opens in Terminal without asking for Automation access.
    let script = dir.join("Update Haze.command");
    let quoted = cli.to_string_lossy().replace('\'', r"'\''");
    std::fs::write(&script, format!("#!/bin/sh\nexec '{quoted}' update\n"))?;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))?;
    let status = Command::new("open").arg(&script).status().context("cannot open Terminal")?;
    if !status.success() {
        bail!("cannot open Terminal");
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn update_in_terminal() -> Result<()> {
    bail!("Homebrew updates are macOS only")
}

/// Downloads the latest release for this install, checks it against GitHub's digest
/// and puts it in place.
pub fn download_and_install(progress: impl Fn(Progress)) -> Result<()> {
    let target = target().context("this copy of Haze cannot update itself")?;
    let release = latest_release()?;
    let latest = release.tag_name.trim_start_matches(['v', 'V']);
    if !newer(latest, &current_version()) {
        bail!("Haze {} is the latest version", current_version());
    }
    let name = target.asset(latest);
    let asset = release
        .assets
        .iter()
        .find(|a| a.name == name)
        .with_context(|| format!("the release has no {name}"))?;
    let expected = asset
        .digest
        .as_deref()
        .and_then(|d| d.strip_prefix("sha256:"))
        .context("the release does not publish a checksum for the download")?
        .to_ascii_lowercase();
    let fetch = |to: &Path| download(&asset.browser_download_url, to, asset.size, &expected, &progress);

    match target {
        #[cfg(target_os = "macos")]
        Target::Bundle(bundle) => {
            let tmp = tempfile::tempdir()?;
            let dmg = tmp.path().join(&name);
            fetch(&dmg)?;
            install_dmg(&dmg, tmp.path(), &bundle)
        }
        #[cfg(target_os = "linux")]
        Target::AppImage(image) => {
            use std::os::unix::fs::PermissionsExt;
            let staged = image.with_file_name(".Haze-update.AppImage");
            let installed = fetch(&staged).and_then(|()| {
                std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755))?;
                // The running AppImage stays mounted from the old file.
                std::fs::rename(&staged, &image).context("cannot replace the AppImage")
            });
            if installed.is_err() {
                let _ = std::fs::remove_file(&staged);
            }
            installed
        }
        #[cfg(windows)]
        Target::Exe(exe) => {
            let staged = exe.with_file_name(".haze-update.exe");
            let installed = fetch(&staged).and_then(|()| replace_exe(&exe, &staged));
            if installed.is_err() {
                let _ = std::fs::remove_file(&staged);
            }
            installed
        }
    }
}

fn download(url: &str, to: &Path, size: u64, sha256: &str, progress: impl Fn(Progress)) -> Result<()> {
    let result = download_to(url, to, size, sha256, progress);
    if result.is_err() {
        let _ = std::fs::remove_file(to);
    }
    result
}

fn download_to(url: &str, to: &Path, size: u64, sha256: &str, progress: impl Fn(Progress)) -> Result<()> {
    let mut resp = agent(Duration::from_secs(30 * 60)).get(url).call().context("cannot download the update")?;
    if resp.status().as_u16() != 200 {
        bail!("download failed: HTTP {}", resp.status().as_u16());
    }
    let mut reader = resp.body_mut().as_reader();
    let mut file = File::create(to)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0; 64 * 1024];
    let (mut received, mut reported) = (0u64, 0u64);
    progress(Progress { received, total: size });
    loop {
        let n = reader.read(&mut buf).context("download interrupted")?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])?;
        hasher.update(&buf[..n]);
        received += n as u64;
        // About every 1%: enough for a smooth bar without flooding the page.
        if received - reported >= (size / 100).max(256 * 1024) {
            reported = received;
            progress(Progress { received, total: size });
        }
    }
    file.sync_all()?;
    progress(Progress { received, total: size });
    let actual: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if actual != sha256 {
        bail!("the download is corrupt (checksum mismatch)");
    }
    Ok(())
}

/// The suffix of a replaced haze.exe, removed by `remove_replaced_exes`.
#[cfg(windows)]
const REPLACED: &str = ".replaced";

/// Moves the running haze.exe aside (Windows allows renaming it, not overwriting it)
/// and puts `staged` in its place. The old file stays in use while this process or
/// the terminal host started from it runs.
#[cfg(windows)]
fn replace_exe(exe: &Path, staged: &Path) -> Result<()> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    let mut aside = exe.as_os_str().to_owned();
    aside.push(format!(".{stamp}{REPLACED}"));
    std::fs::rename(exe, &aside).context("cannot replace haze.exe")?;
    if let Err(e) = std::fs::rename(staged, exe) {
        let _ = std::fs::rename(&aside, exe);
        return Err(e).context("cannot replace haze.exe");
    }
    Ok(())
}

/// Deletes the haze.exe copies earlier updates moved aside; one still running
/// (an old terminal host) cannot be deleted and is tried again at the next start.
#[cfg(windows)]
pub fn remove_replaced_exes() {
    let Ok(exe) = std::env::current_exe() else { return };
    let (Some(dir), Some(name)) = (exe.parent(), exe.file_name().and_then(|n| n.to_str())) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let file = entry.file_name();
        let file = file.to_string_lossy();
        if file.starts_with(name) && file.ends_with(REPLACED) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Detaches the mounted DMG however the install ends.
#[cfg(target_os = "macos")]
struct Mounted<'a>(&'a Path);

#[cfg(target_os = "macos")]
impl Drop for Mounted<'_> {
    fn drop(&mut self) {
        let _ = Command::new("hdiutil").args(["detach", "-force", "-quiet"]).arg(self.0).status();
    }
}

#[cfg(target_os = "macos")]
fn run(cmd: &mut Command, what: &str) -> Result<()> {
    let out = cmd.output().with_context(|| format!("cannot {what}"))?;
    if !out.status.success() {
        bail!("cannot {what}: {}", String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn install_dmg(dmg: &Path, tmp: &Path, bundle: &Path) -> Result<()> {
    let mount = tmp.join("mnt");
    std::fs::create_dir_all(&mount)?;
    run(
        Command::new("hdiutil")
            .args(["attach", "-nobrowse", "-readonly", "-noautoopen", "-quiet", "-mountpoint"])
            .arg(&mount)
            .arg(dmg),
        "open the update",
    )?;
    let mounted = Mounted(&mount);
    let source = mount.join("Haze.app");
    if !source.is_dir() {
        bail!("the update does not contain Haze.app");
    }

    let parent = bundle.parent().context("Haze.app has no parent folder")?;
    let staged = parent.join(".Haze-update.app");
    let old = parent.join(".Haze-old.app");
    for leftover in [&staged, &old] {
        if leftover.exists() {
            std::fs::remove_dir_all(leftover)?;
        }
    }
    run(Command::new("ditto").arg(&source).arg(&staged), "copy the update")?;
    drop(mounted);
    let _ = Command::new("xattr").args(["-dr", "com.apple.quarantine"]).arg(&staged).status();
    if let Err(e) = run(
        Command::new("codesign").args(["--verify", "--deep", "--strict"]).arg(&staged),
        "verify the update's signature",
    ) {
        let _ = std::fs::remove_dir_all(&staged);
        return Err(e);
    }

    std::fs::rename(bundle, &old).context("cannot replace Haze.app")?;
    if let Err(e) = std::fs::rename(&staged, bundle) {
        let _ = std::fs::rename(&old, bundle);
        return Err(e).context("cannot replace Haze.app");
    }
    // The running process keeps its mapped files; the old bundle can go.
    let _ = std::fs::remove_dir_all(&old);
    Ok(())
}

/// Starts the updated Haze once this process has exited; the caller exits right after.
/// Starting it earlier would hand the launch to this instance (single-instance plugin).
pub fn spawn_relaunch() -> Result<()> {
    let target = target().context("this copy of Haze cannot update itself")?;
    match target {
        #[cfg(target_os = "macos")]
        Target::Bundle(bundle) => relaunch_after_exit(&["open".as_ref(), bundle.as_os_str()]),
        #[cfg(target_os = "linux")]
        Target::AppImage(image) => relaunch_after_exit(&[image.as_os_str()]),
        #[cfg(windows)]
        Target::Exe(exe) => {
            use std::os::windows::process::CommandExt;
            const DETACHED_PROCESS: u32 = 0x0000_0008;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let script = format!(
                "Wait-Process -Id {} -ErrorAction SilentlyContinue; Start-Process -FilePath '{}'",
                std::process::id(),
                exe.to_string_lossy().replace('\'', "''"),
            );
            Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-Command", &script])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW)
                .spawn()
                .context("cannot restart Haze")?;
            Ok(())
        }
    }
}

/// Runs `command` from a detached shell once this process has exited.
#[cfg(unix)]
fn relaunch_after_exit(command: &[&std::ffi::OsStr]) -> Result<()> {
    use std::os::unix::process::CommandExt;
    Command::new("/bin/sh")
        .args(["-c", r#"pid=$1; shift; while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done; exec "$@""#, "sh"])
        .arg(std::process::id().to_string())
        .args(command)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .context("cannot restart Haze")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::newer;

    #[test]
    fn compares_versions() {
        assert!(newer("0.2.0", "0.1.9"));
        assert!(newer("v1.0.0", "0.9.0"));
        assert!(newer("1.10.0", "1.9.0"));
        assert!(newer("1.0.1", "1.0"));
        assert!(!newer("1.0.0", "1.0.0"));
        assert!(!newer("1.0", "1.0.0"));
        assert!(!newer("0.1.0", "0.2.0"));
        assert!(!newer("1.0.0-beta", "1.0.0"));
    }
}
