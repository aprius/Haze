//! GitHub and GitLab accounts (Settings › Version Control). The account list
//! lives in `git-accounts.json` (no secrets); tokens live in the OS keychain
//! (Keychain, Credential Manager, Secret Service).
//!
//! Git gets the token from Haze itself, through a built-in helper:
//! for every account's host, git commands Haze runs replace that host's
//! credential helpers with `haze --haze-git-credential` (see
//! `run_credential_helper`), so a stale stored password cannot win over the
//! account. Other hosts keep the user's own git configuration.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

/// First argument when git runs Haze as a credential helper.
pub const CREDENTIAL_FLAG: &str = "--haze-git-credential";
/// The accounts (without tokens) handed to the credential helper.
const ACCOUNTS_ENV: &str = "HAZE_GIT_ACCOUNTS";
const KEYCHAIN_SERVICE: &str = "dev.haze.app.git";

/// OAuth app for "Log In via GitHub…" (device flow, no client secret). Set
/// at build time; without it only token login is offered.
const GITHUB_CLIENT_ID: Option<&str> = option_env!("HAZE_GITHUB_CLIENT_ID");
/// Scopes requested: push/pull private repos, Actions workflows, orgs, gists.
const GITHUB_SCOPES: &str = "repo workflow read:org gist";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Github,
    Gitlab,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub provider: Provider,
    /// Web URL without a trailing slash, e.g. `https://github.com`.
    pub server: String,
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountsInfo {
    pub accounts: Vec<Account>,
    /// "Log In via GitHub…" is available (an OAuth app was built in).
    pub github_oauth: bool,
}

static ACCOUNTS: RwLock<Option<(PathBuf, Vec<Account>)>> = RwLock::new(None);

pub fn init(path: PathBuf) {
    let accounts = std::fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    *ACCOUNTS.write() = Some((path, accounts));
}

pub fn info() -> AccountsInfo {
    AccountsInfo {
        accounts: accounts(),
        github_oauth: GITHUB_CLIENT_ID.is_some_and(|id| !id.is_empty()),
    }
}

fn accounts() -> Vec<Account> {
    ACCOUNTS
        .read()
        .as_ref()
        .map(|(_, a)| a.clone())
        .unwrap_or_default()
}

fn update(f: impl FnOnce(&mut Vec<Account>)) -> Result<()> {
    let mut guard = ACCOUNTS.write();
    let (path, accounts) = guard.as_mut().context("accounts not loaded")?;
    f(accounts);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    crate::state::save(path, &serde_json::to_value(&*accounts)?)
}

/// `github.com`, `HTTPS://GitLab.example.com/x/` → `https://github.com`,
/// `https://gitlab.example.com/x`.
pub fn normalize_server(server: &str) -> String {
    let s = server.trim().trim_end_matches('/');
    let s = if s.contains("://") {
        s.to_string()
    } else {
        format!("https://{s}")
    };
    let path = s
        .split_once("://")
        .and_then(|(_, rest)| rest.find('/').map(|i| &rest[i..]))
        .unwrap_or_default();
    format!("{}{path}", origin(&s))
}

fn api_base(provider: Provider, server: &str) -> String {
    match provider {
        Provider::Github if server == "https://github.com" => "https://api.github.com".into(),
        Provider::Github => format!("{server}/api/v3"),
        Provider::Gitlab => format!("{server}/api/v4"),
    }
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .tls_config(
            ureq::tls::TlsConfig::builder()
                .root_certs(ureq::tls::RootCerts::PlatformVerifier)
                .build(),
        )
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(30)))
        .user_agent("Haze")
        .build()
        .into()
}

#[derive(Deserialize)]
struct UserJson {
    login: Option<String>,
    username: Option<String>,
    name: Option<String>,
    avatar_url: Option<String>,
}

/// Checks the token against the server's API and returns who it belongs to.
fn whoami(provider: Provider, server: &str, token: &str) -> Result<Account> {
    let url = format!("{}/user", api_base(provider, server));
    let mut resp = agent()
        .get(&url)
        .header("Authorization", &format!("Bearer {token}"))
        .header("Accept", "application/json")
        .call()
        .with_context(|| format!("cannot reach {server}"))?;
    match resp.status().as_u16() {
        200 => {}
        401 => bail!("the token is not valid (or has expired)"),
        403 => bail!(
            "the token is not allowed to read the user profile (add the read_user / user scope)"
        ),
        404 => bail!("{url} was not found. Is {server} a {provider:?} server?"),
        s => bail!("{url} answered HTTP {s}"),
    }
    let user: UserJson = resp.body_mut().read_json().context("unexpected answer")?;
    let login = user
        .login
        .or(user.username)
        .context("the answer has no user name")?;
    Ok(Account {
        id: uuid::Uuid::new_v4().to_string(),
        provider,
        server: server.to_string(),
        login,
        name: user.name.filter(|n| !n.is_empty()),
        avatar_url: user.avatar_url,
    })
}

fn keychain(id: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SERVICE, id).context("system keychain unavailable")
}

/// Validates the token and saves the account. One account per host (git asks
/// for credentials per host): a new login replaces the previous one.
pub fn login_with_token(provider: Provider, server: &str, token: &str) -> Result<Account> {
    let server = normalize_server(server);
    let token = token.trim();
    if token.is_empty() {
        bail!("enter a token");
    }
    let account = whoami(provider, &server, token)?;
    keychain(&account.id)?
        .set_password(token)
        .context("cannot save the token in the system keychain")?;
    let mut replaced = Vec::new();
    update(|list| {
        list.retain(|a| {
            let same = origin(&a.server) == origin(&account.server);
            if same {
                replaced.push(a.id.clone());
            }
            !same
        });
        list.push(account.clone());
    })?;
    for id in replaced {
        let _ = keychain(&id).and_then(|e| Ok(e.delete_credential()?));
    }
    Ok(account)
}

pub fn remove(id: &str) -> Result<()> {
    update(|list| list.retain(|a| a.id != id))?;
    match keychain(id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

// ---------------------------------------------------------------- GitHub device flow

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCode {
    #[serde(alias = "device_code")]
    pub device_code: String,
    #[serde(alias = "user_code")]
    pub user_code: String,
    #[serde(alias = "verification_uri")]
    pub verification_uri: String,
    pub interval: u64,
    #[serde(alias = "expires_in")]
    pub expires_in: u64,
}

/// Bumped to stop a pending `device_poll` (dialog closed, new attempt).
static DEVICE_GENERATION: AtomicU64 = AtomicU64::new(0);

/// Starts "Log In via GitHub…": returns the code the user types at
/// `verification_uri`, which the frontend opens in the browser.
pub fn device_start() -> Result<DeviceCode> {
    let client_id = GITHUB_CLIENT_ID.context("browser login is not configured in this build")?;
    let mut resp = agent()
        .post("https://github.com/login/device/code")
        .header("Accept", "application/json")
        .send_form([("client_id", client_id), ("scope", GITHUB_SCOPES)])
        .context("cannot reach github.com")?;
    if resp.status() != 200 {
        bail!("github.com answered HTTP {}", resp.status());
    }
    Ok(resp.body_mut().read_json()?)
}

#[derive(Deserialize)]
struct TokenJson {
    access_token: Option<String>,
    error: Option<String>,
    interval: Option<u64>,
}

/// Waits until the user approves the code in the browser, then saves the account.
pub fn device_poll(code: &DeviceCode) -> Result<Account> {
    let client_id = GITHUB_CLIENT_ID.context("browser login is not configured in this build")?;
    let generation = DEVICE_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let deadline = Instant::now() + Duration::from_secs(code.expires_in);
    let mut interval = code.interval.max(1);
    loop {
        // Sleep in small steps so a cancel is noticed quickly.
        let wake = Instant::now() + Duration::from_secs(interval);
        while Instant::now() < wake {
            std::thread::sleep(Duration::from_millis(200));
            if DEVICE_GENERATION.load(Ordering::SeqCst) != generation {
                bail!("cancelled");
            }
        }
        if Instant::now() > deadline {
            bail!("the code expired, try again");
        }
        let mut resp = agent()
            .post("https://github.com/login/oauth/access_token")
            .header("Accept", "application/json")
            .send_form([
                ("client_id", client_id),
                ("device_code", code.device_code.as_str()),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ])
            .context("cannot reach github.com")?;
        let answer: TokenJson = resp.body_mut().read_json()?;
        if let Some(token) = answer.access_token {
            return login_with_token(Provider::Github, "https://github.com", &token);
        }
        match answer.error.as_deref() {
            Some("authorization_pending") => {}
            Some("slow_down") => interval = answer.interval.unwrap_or(interval + 5),
            Some("expired_token") => bail!("the code expired, try again"),
            Some("access_denied") => bail!("the login was cancelled in the browser"),
            Some(e) => bail!("GitHub refused the login: {e}"),
            None => bail!("unexpected answer from github.com"),
        }
    }
}

pub fn device_cancel() {
    DEVICE_GENERATION.fetch_add(1, Ordering::SeqCst);
}

// ---------------------------------------------------------------- git

#[derive(Serialize, Deserialize)]
struct HelperAccount {
    id: String,
    server: String,
    login: String,
}

/// `!"/path/to/haze" --haze-git-credential`: git runs a helper starting
/// with `!` through its shell (also on Windows), appending get/store/erase.
fn helper_command(exe: &Path) -> String {
    let path = exe.to_string_lossy().replace('\\', "/");
    let mut quoted = String::new();
    for c in path.chars() {
        if matches!(c, '"' | '$' | '`' | '\\') {
            quoted.push('\\');
        }
        quoted.push(c);
    }
    format!("!\"{quoted}\" {CREDENTIAL_FLAG}")
}

/// Makes `cmd` (a git command) use the saved accounts for their hosts.
/// The `-c` options must come before the git subcommand.
pub fn configure(cmd: &mut Command) {
    let list = accounts();
    if list.is_empty() {
        return;
    }
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let helper = helper_command(&exe);
    for a in &list {
        // The empty helper drops the user's helpers for this host only.
        let host = origin(&a.server);
        cmd.arg("-c")
            .arg(format!("credential.{host}.helper="))
            .arg("-c")
            .arg(format!("credential.{host}.helper={helper}"));
    }
    let pass: Vec<HelperAccount> = list
        .into_iter()
        .map(|a| HelperAccount {
            id: a.id,
            server: a.server,
            login: a.login,
        })
        .collect();
    cmd.env(
        ACCOUNTS_ENV,
        serde_json::to_string(&pass).unwrap_or_default(),
    );
}

/// `https://example.com/gitlab` → `https://example.com`: git asks for
/// credentials per host (the path is left out unless credential.useHttpPath).
fn origin(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else {
        return url.to_string();
    };
    let host = rest.split('/').next().unwrap_or_default();
    let host = host.rsplit_once('@').map_or(host, |(_, h)| h);
    format!("{scheme}://{host}").to_ascii_lowercase()
}

/// The account for a URL on its host (`https://me@github.com/o/r.git`).
fn account_for<'a>(list: &'a [HelperAccount], url: &str) -> Option<&'a HelperAccount> {
    let url = origin(url);
    list.iter().find(|a| origin(&a.server) == url)
}

/// git's credential helper protocol: `get` reads `protocol=…`/`host=…` lines
/// from stdin and answers `username=…`/`password=…`; `store` and `erase` are
/// ignored (the token is managed in Settings).
pub fn run_credential_helper(action: Option<&str>) -> i32 {
    let mut input = String::new();
    let _ = std::io::Read::read_to_string(&mut std::io::stdin(), &mut input);
    if action != Some("get") {
        return 0;
    }
    let field = |k: &str| {
        input
            .lines()
            .find_map(|l| l.strip_prefix(k)?.strip_prefix('='))
            .unwrap_or_default()
    };
    let url = format!("{}://{}", field("protocol"), field("host"));
    let list: Vec<HelperAccount> = std::env::var(ACCOUNTS_ENV)
        .ok()
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or_default();
    // Nothing printed: git falls back to its own (non-interactive) prompt.
    let Some(account) = account_for(&list, &url) else {
        return 0;
    };
    match keychain(&account.id).and_then(|e| Ok(e.get_password()?)) {
        Ok(token) => {
            // A user name already in the remote URL stays; tokens ignore it.
            if field("username").is_empty() {
                println!("username={}", account.login);
            }
            println!("password={token}");
            0
        }
        Err(e) => {
            eprintln!("haze: cannot read the token for {}: {e:#}", account.server);
            0
        }
    }
}

pub fn accounts_path(config_dir: &Path) -> PathBuf {
    config_dir.join("git-accounts.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn acc(server: &str) -> HelperAccount {
        HelperAccount {
            id: server.into(),
            server: server.into(),
            login: "me".into(),
        }
    }

    #[test]
    fn normalizes_servers() {
        assert_eq!(normalize_server(" github.com/ "), "https://github.com");
        assert_eq!(
            normalize_server("HTTPS://GitLab.Example.com/Sub/"),
            "https://gitlab.example.com/Sub"
        );
        assert_eq!(
            normalize_server("http://git.local:8080"),
            "http://git.local:8080"
        );
    }

    #[test]
    fn finds_account_for_prompt_url() {
        let list = [acc("https://github.com"), acc("https://example.com/gitlab")];
        let id = |u: &str| account_for(&list, u).map(|a| a.id.clone());
        assert_eq!(
            id("https://me@github.com").as_deref(),
            Some("https://github.com")
        );
        assert_eq!(
            id("https://GitHub.com/o/r.git").as_deref(),
            Some("https://github.com")
        );
        assert_eq!(id("https://github.community"), None);
        assert_eq!(
            id("https://x@example.com").as_deref(),
            Some("https://example.com/gitlab")
        );
        assert_eq!(id("http://github.com"), None);
        assert_eq!(id("https://"), None);
        assert_eq!(
            origin("https://Example.com:8443/gitlab"),
            "https://example.com:8443"
        );
    }

    #[test]
    fn quotes_helper_path() {
        assert_eq!(
            helper_command(Path::new("/opt/Haze App/haze")),
            "!\"/opt/Haze App/haze\" --haze-git-credential"
        );
        assert_eq!(
            helper_command(Path::new("/a/$x\"y/haze")),
            "!\"/a/\\$x\\\"y/haze\" --haze-git-credential"
        );
    }
}
