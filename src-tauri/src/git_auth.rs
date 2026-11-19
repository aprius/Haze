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

/// OAuth app on github.com for "Log In via GitHub…" (device flow, which
/// needs no client secret, so its ID is no secret); a build can name another
/// with `HAZE_GITHUB_CLIENT_ID`. GitHub Enterprise needs an app of its own,
/// whose client ID the user enters.
const GITHUB_CLIENT_ID: Option<&str> = match option_env!("HAZE_GITHUB_CLIENT_ID") {
    Some(id) => Some(id),
    None => Some("Ov23lio4MCxgMt3usQHp"),
};
/// Scopes requested: push/pull private repos, Actions workflows, orgs, gists.
const GITHUB_SCOPES: &str = "repo workflow read:org gist";
/// OAuth application on gitlab.com for "Log In via GitLab…" (device flow,
/// not confidential, so its ID is no secret); a build can name another with
/// `HAZE_GITLAB_CLIENT_ID`. A self-hosted GitLab needs its own application,
/// whose ID the user enters.
const GITLAB_CLIENT_ID: Option<&str> = match option_env!("HAZE_GITLAB_CLIENT_ID") {
    Some(id) => Some(id),
    None => Some("8c47cd58d3590e268b19cb88c0d70e91c9164d9ca5e03a199f9da3e1279ad0a8"),
};
/// The API (merge requests), the profile, and git over HTTPS.
const GITLAB_SCOPES: &str = "api read_user";

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
    /// The github.com OAuth app built in, if any (GitHub Enterprise needs its own).
    pub github_client_id: Option<String>,
    /// The gitlab.com application built in, if any (self-hosted servers need their own).
    pub gitlab_client_id: Option<String>,
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
        github_client_id: GITHUB_CLIENT_ID
            .filter(|id| !id.is_empty())
            .map(str::to_string),
        gitlab_client_id: GITLAB_CLIENT_ID
            .filter(|id| !id.is_empty())
            .map(str::to_string),
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

pub(crate) fn api_base(provider: Provider, server: &str) -> String {
    match provider {
        Provider::Github if server == "https://github.com" => "https://api.github.com".into(),
        Provider::Github => format!("{server}/api/v3"),
        Provider::Gitlab => format!("{server}/api/v4"),
    }
}

pub(crate) fn agent() -> ureq::Agent {
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
    let token = token.trim();
    if token.is_empty() {
        bail!("enter a token");
    }
    save_account(provider, server, token, token)
}

/// Saves the account `token` belongs to, with `secret` (the token itself, or
/// an OAuth grant as JSON) in the keychain.
fn save_account(provider: Provider, server: &str, token: &str, secret: &str) -> Result<Account> {
    let server = normalize_server(server);
    let account = whoami(provider, &server, token)?;
    keychain(&account.id)?
        .set_password(secret)
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
    /// The page to open: with the code filled in when the server offers it
    /// (GitLab's `verification_uri_complete`).
    #[serde(alias = "verification_uri")]
    pub verification_uri: String,
    #[serde(default, alias = "verification_uri_complete")]
    pub verification_uri_complete: Option<String>,
    #[serde(default = "five")]
    pub interval: u64,
    #[serde(alias = "expires_in")]
    pub expires_in: u64,
    /// Filled in by `device_start`, handed back to `device_poll`.
    #[serde(default = "github")]
    pub provider: Provider,
    #[serde(default)]
    pub server: String,
    #[serde(default)]
    pub client_id: String,
}

fn five() -> u64 {
    5
}
fn github() -> Provider {
    Provider::Github
}

/// An OAuth grant that expires (GitLab's last two hours), kept in the
/// keychain as JSON in place of a plain token.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct OAuthGrant {
    access: String,
    refresh: String,
    /// Unix seconds.
    expires_at: u64,
    client_id: String,
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

#[derive(Deserialize)]
struct GrantJson {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
    error: Option<String>,
    error_description: Option<String>,
    interval: Option<u64>,
}

impl GrantJson {
    /// The grant to keep: an OAuth grant when it can be refreshed, else the bare token.
    fn into_secret(self, client_id: &str) -> Option<(String, String)> {
        let access = self.access_token?;
        let secret = match (self.refresh_token, self.expires_in) {
            (Some(refresh), Some(expires_in)) => serde_json::to_string(&OAuthGrant {
                access: access.clone(),
                refresh,
                expires_at: now() + expires_in,
                client_id: client_id.to_string(),
            })
            .ok()?,
            _ => access.clone(),
        };
        Some((access, secret))
    }
}

/// The token stored for an account, refreshed first when it is an OAuth
/// grant about to expire. Also called by the credential helper (its own
/// process): a refresh token works once, so a refresh that fails reads the
/// keychain again, in case another process has just refreshed it.
fn token_of(id: &str, server: &str) -> Result<String> {
    let entry = keychain(id)?;
    let stored = entry.get_password()?;
    let Ok(grant) = serde_json::from_str::<OAuthGrant>(&stored) else {
        return Ok(stored);
    };
    if grant.expires_at > now() + 60 {
        return Ok(grant.access);
    }
    match refresh(server, &grant) {
        Ok(fresh) => {
            entry.set_password(&serde_json::to_string(&fresh)?)?;
            Ok(fresh.access)
        }
        Err(e) => match serde_json::from_str::<OAuthGrant>(&entry.get_password()?) {
            Ok(other) if other != grant && other.expires_at > now() => Ok(other.access),
            _ => Err(e.context(format!(
                "log in to {server} again in Settings › Version Control"
            ))),
        },
    }
}

/// Where `grant` is renewed: GitHub's tokens (`gho_`, `ghu_`) at
/// `/login/oauth/access_token`, GitLab's at `/oauth/token`.
fn token_url(server: &str, grant: &OAuthGrant) -> String {
    if grant.access.starts_with("gho_") || grant.access.starts_with("ghu_") {
        format!("{server}/login/oauth/access_token")
    } else {
        format!("{server}/oauth/token")
    }
}

fn refresh(server: &str, grant: &OAuthGrant) -> Result<OAuthGrant> {
    let mut resp = agent()
        .post(&token_url(server, grant))
        .header("Accept", "application/json")
        .send_form([
            ("grant_type", "refresh_token"),
            ("refresh_token", grant.refresh.as_str()),
            ("client_id", grant.client_id.as_str()),
        ])
        .with_context(|| format!("cannot reach {server}"))?;
    let answer: GrantJson = resp.body_mut().read_json().context("unexpected answer")?;
    if let Some(e) = &answer.error {
        bail!(
            "{server} did not renew the login: {}",
            answer.error_description.as_deref().unwrap_or(e)
        );
    }
    let (_, secret) = answer
        .into_secret(&grant.client_id)
        .context("unexpected answer")?;
    serde_json::from_str(&secret).context("the renewed login does not expire")
}

/// Bumped to stop a pending `device_poll` (dialog closed, new attempt).
static DEVICE_GENERATION: AtomicU64 = AtomicU64::new(0);

/// Starts "Log In via GitHub…" / "Log In via GitLab…": returns the code the
/// user types at `verification_uri`, which the frontend opens in the browser.
/// `client_id` is the OAuth app on a GitHub Enterprise or self-hosted
/// GitLab server; empty for the one built in for github.com / gitlab.com.
pub fn device_start(provider: Provider, server: &str, client_id: &str) -> Result<DeviceCode> {
    let server = normalize_server(server);
    let (built_in, dot_com, what) = match provider {
        Provider::Github => (GITHUB_CLIENT_ID, "https://github.com", "Client ID"),
        Provider::Gitlab => (GITLAB_CLIENT_ID, "https://gitlab.com", "Application ID"),
    };
    let client_id = match client_id.trim() {
        "" if server == dot_com => built_in
            .filter(|id| !id.is_empty())
            .with_context(|| format!("enter the {what} of an OAuth application"))?
            .to_string(),
        "" => bail!("enter the {what} of an OAuth application on {server}"),
        id => id.to_string(),
    };
    let (url, scopes) = match provider {
        Provider::Github => (format!("{server}/login/device/code"), GITHUB_SCOPES),
        Provider::Gitlab => (format!("{server}/oauth/authorize_device"), GITLAB_SCOPES),
    };
    let mut resp = agent()
        .post(&url)
        .header("Accept", "application/json")
        .send_form([("client_id", client_id.as_str()), ("scope", scopes)])
        .with_context(|| format!("cannot reach {server}"))?;
    match resp.status().as_u16() {
        200 => {}
        401 if provider == Provider::Gitlab => bail!(
            "{server} does not know this Application ID (or the application is confidential: untick Confidential)"
        ),
        404 if provider == Provider::Gitlab => {
            bail!("{server} does not offer browser login (GitLab 17.9 or later is needed): use a token")
        }
        400 if provider == Provider::Gitlab => {
            let e: GrantJson = resp.body_mut().read_json().context("unexpected answer")?;
            match e.error.as_deref() {
                // Whatever the scopes: the application itself is refused.
                Some("access_denied") => bail!(
                    "{server} refused this application: edit it in GitLab (User Settings › Applications), enable the device authorization grant and untick Confidential"
                ),
                Some("invalid_scope") => bail!(
                    "the application on {server} lacks scopes: tick {} in its settings",
                    GITLAB_SCOPES.replace(' ', " and ")
                ),
                _ => bail!(
                    "{server} refused: {}",
                    e.error_description.or(e.error).unwrap_or_default()
                ),
            }
        }
        404 => bail!("{server} does not know this {what}, or does not offer browser login: use a token"),
        s if provider == Provider::Gitlab => bail!("{server} answered HTTP {s}"),
        _ => {}
    }
    // GitHub answers some refusals with an `error` field, whatever the status.
    let body: serde_json::Value = resp.body_mut().read_json().context("unexpected answer")?;
    match body.get("error").and_then(|e| e.as_str()) {
        None => {}
        Some("device_flow_disabled") => bail!(
            "Device Flow is off for this OAuth app: tick Enable Device Flow in its settings on {server}"
        ),
        Some("incorrect_client_credentials") => bail!("{server} does not know this {what}"),
        Some(e) => bail!("{server} refused: {e}"),
    }
    let mut code: DeviceCode = serde_json::from_value(body).context("unexpected answer")?;
    code.provider = provider;
    code.server = server;
    code.client_id = client_id;
    Ok(code)
}

/// Waits until the user approves the code in the browser, then saves the account.
pub fn device_poll(code: &DeviceCode) -> Result<Account> {
    let generation = DEVICE_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let deadline = Instant::now() + Duration::from_secs(code.expires_in);
    let mut interval = code.interval.max(1);
    let (url, name) = match code.provider {
        Provider::Github => (
            format!("{}/login/oauth/access_token", code.server),
            "GitHub",
        ),
        Provider::Gitlab => (format!("{}/oauth/token", code.server), "GitLab"),
    };
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
            .post(&url)
            .header("Accept", "application/json")
            .send_form([
                ("client_id", code.client_id.as_str()),
                ("device_code", code.device_code.as_str()),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ])
            .with_context(|| format!("cannot reach {}", code.server))?;
        let answer: GrantJson = resp.body_mut().read_json().context("unexpected answer")?;
        let error = answer.error.clone();
        let next = answer.interval;
        if let Some((token, secret)) = answer.into_secret(&code.client_id) {
            return save_account(code.provider, &code.server, &token, &secret);
        }
        match error.as_deref() {
            Some("authorization_pending") => {}
            Some("slow_down") => interval = next.unwrap_or(interval + 5),
            Some("expired_token") => bail!("the code expired, try again"),
            Some("access_denied") => bail!("the login was cancelled in the browser"),
            Some(e) => bail!("{name} refused the login: {e}"),
            None => bail!("unexpected answer from {}", code.server),
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
pub(crate) fn origin(url: &str) -> String {
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
    let oauth = keychain(&account.id)
        .and_then(|e| Ok(e.get_password()?))
        .is_ok_and(|s| serde_json::from_str::<OAuthGrant>(&s).is_ok());
    match token_of(&account.id, &account.server) {
        Ok(token) => {
            // GitLab takes an OAuth token only with the user name oauth2;
            // otherwise a user name already in the remote URL stays (tokens ignore it).
            if oauth {
                println!("username=oauth2");
            } else if field("username").is_empty() {
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

/// The saved account for `url`'s host, with its token from the keychain.
pub(crate) fn account_with_token(url: &str) -> Option<(Account, Option<String>)> {
    let host = origin(url);
    let account = accounts().into_iter().find(|a| origin(&a.server) == host)?;
    let token = token_of(&account.id, &account.server).ok();
    Some((account, token))
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
    fn keeps_refreshable_grants() {
        let grant = |refresh: Option<&str>, expires_in: Option<u64>| GrantJson {
            access_token: Some("a".into()),
            refresh_token: refresh.map(str::to_string),
            expires_in,
            error: None,
            error_description: None,
            interval: None,
        };
        let (token, secret) = grant(Some("r"), Some(7200)).into_secret("cid").unwrap();
        assert_eq!(token, "a");
        let g: OAuthGrant = serde_json::from_str(&secret).unwrap();
        assert_eq!((g.refresh.as_str(), g.client_id.as_str()), ("r", "cid"));
        assert!(g.expires_at >= now() + 7199);
        // GitHub's device tokens do not expire: kept as the bare token.
        assert_eq!(grant(None, None).into_secret("cid").unwrap().1, "a");
        // A plain token is not mistaken for a grant.
        assert!(serde_json::from_str::<OAuthGrant>("glpat-xyz").is_err());
    }

    #[test]
    fn renews_at_the_provider_token_url() {
        let grant = |access: &str| OAuthGrant {
            access: access.into(),
            refresh: "r".into(),
            expires_at: 0,
            client_id: "cid".into(),
        };
        assert_eq!(
            token_url("https://github.com", &grant("gho_x")),
            "https://github.com/login/oauth/access_token"
        );
        assert_eq!(
            token_url("https://gitlab.com", &grant("abc")),
            "https://gitlab.com/oauth/token"
        );
    }

    #[test]
    fn reads_gitlab_device_code() {
        let c: DeviceCode = serde_json::from_str(
            r#"{"device_code":"d","user_code":"U","verification_uri":"https://gitlab.com/oauth/device","verification_uri_complete":"https://gitlab.com/oauth/device?user_code=U","expires_in":300,"interval":5}"#,
        )
        .unwrap();
        assert_eq!(
            c.verification_uri_complete.as_deref(),
            Some("https://gitlab.com/oauth/device?user_code=U")
        );
        // Handed back by the frontend in camelCase.
        let back: DeviceCode = serde_json::from_str(&serde_json::to_string(&c).unwrap()).unwrap();
        assert_eq!(back.device_code, "d");
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
