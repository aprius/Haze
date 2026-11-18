//! Pull requests (GitHub) and merge requests (GitLab) of a repository's
//! remote, for *Review Pull Request…*: the frontend checks the one picked out
//! into a worktree of its own. The list comes from the server's API, with the
//! account saved in Settings for that host; public GitHub and GitLab.com
//! repositories are listed without one.

use std::path::Path;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::git::git_command;
use crate::git_auth::{self, Provider};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewList {
    pub provider: Provider,
    /// The remote the requests are on, fetched from.
    pub remote: String,
    /// `owner/repo` (or `group/subgroup/project`).
    pub repo: String,
    pub requests: Vec<ReviewRequest>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRequest {
    pub number: u64,
    pub title: String,
    pub author: String,
    pub source_branch: String,
    pub target_branch: String,
    pub draft: bool,
    pub url: String,
    pub updated_at: String,
    /// The ref on the remote holding the request's head commit.
    pub head_ref: String,
}

/// The remote's web origin and repository path: `git@github.com:o/r.git`,
/// `https://me@github.com/o/r`, `ssh://git@host:2222/g/s/p.git` →
/// (`https://github.com`, `o/r`), …, (`https://host`, `g/s/p`).
pub fn parse_remote(url: &str) -> Option<(String, String)> {
    let url = url.trim();
    let (scheme, host, path) = if let Some((scheme, rest)) = url.split_once("://") {
        let (authority, path) = rest.split_once('/')?;
        let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
        let host = match scheme {
            // An SSH port is not the web server's.
            "ssh" | "git" | "git+ssh" | "ssh+git" => host.split(':').next().unwrap_or(host),
            _ => host,
        };
        let scheme = if scheme == "http" { "http" } else { "https" };
        (scheme, host.to_string(), path.to_string())
    } else {
        // scp-like: [user@]host:path
        let (authority, path) = url.split_once(':')?;
        if authority.contains('/') {
            return None;
        }
        let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
        ("https", host.to_string(), path.to_string())
    };
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path).trim_matches('/');
    if host.is_empty() || !path.contains('/') {
        return None;
    }
    Some((format!("{scheme}://{}", host.to_ascii_lowercase()), path.to_string()))
}

/// `upstream` first (a fork's pull requests are on the repository it was
/// forked from), then `origin`, then the first remote.
fn pick_remote(root: &Path) -> Result<(String, String)> {
    let out = git_command().arg("-C").arg(root).arg("remote").output()?;
    let names: Vec<String> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::to_string)
        .filter(|l| !l.is_empty())
        .collect();
    let name = ["upstream", "origin"]
        .iter()
        .find_map(|n| names.iter().find(|r| r == n))
        .or(names.first())
        .context("the repository has no remote")?
        .clone();
    let out = git_command()
        .arg("-C")
        .arg(root)
        .args(["remote", "get-url", &name])
        .output()?;
    Ok((name, String::from_utf8_lossy(&out.stdout).trim().to_string()))
}

/// GitLab's `:id` for a project path: `g/s/p` → `g%2Fs%2Fp`.
fn encode_path(path: &str) -> String {
    let mut out = String::new();
    for b in path.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[derive(Deserialize)]
struct GhUser {
    login: String,
}
#[derive(Deserialize)]
struct GhRef {
    #[serde(rename = "ref")]
    name: String,
}
#[derive(Deserialize)]
struct GhPull {
    number: u64,
    title: String,
    user: Option<GhUser>,
    head: GhRef,
    base: GhRef,
    #[serde(default)]
    draft: bool,
    html_url: String,
    updated_at: String,
}

#[derive(Deserialize)]
struct GlUser {
    username: String,
}
#[derive(Deserialize)]
struct GlMerge {
    iid: u64,
    title: String,
    author: Option<GlUser>,
    source_branch: String,
    target_branch: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    work_in_progress: bool,
    web_url: String,
    updated_at: String,
}

pub fn list(root: &Path) -> Result<ReviewList> {
    let (remote, url) = pick_remote(root)?;
    let (web, path) =
        parse_remote(&url).with_context(|| format!("cannot read the remote URL {url}"))?;
    let (provider, server, token, repo) = match git_auth::account_with_token(&web) {
        Some((a, token)) => {
            let repo = strip_server_path(&a.server, &path);
            (a.provider, a.server, token, repo)
        }
        None if web == "https://github.com" => (Provider::Github, web, None, path),
        None if web.contains("gitlab") => (Provider::Gitlab, web, None, path),
        None => bail!(
            "log in to {web} in Settings › Version Control to list its pull or merge requests"
        ),
    };
    let api = git_auth::api_base(provider, &server);
    let url = match provider {
        Provider::Github => format!("{api}/repos/{repo}/pulls?state=open&per_page=100"),
        Provider::Gitlab => format!(
            "{api}/projects/{}/merge_requests?state=opened&per_page=100&order_by=updated_at",
            encode_path(&repo)
        ),
    };
    let mut req = git_auth::agent().get(&url).header("Accept", "application/json");
    if let Some(t) = &token {
        req = req.header("Authorization", &format!("Bearer {t}"));
    }
    let mut resp = req.call().with_context(|| format!("cannot reach {server}"))?;
    let login_hint = if token.is_some() {
        ""
    } else {
        " (log in to it in Settings › Version Control)"
    };
    match resp.status().as_u16() {
        200 => {}
        401 => bail!("{server} did not accept the token: it is not valid or has expired"),
        403 if token.is_none() => bail!("{server} refused the request{login_hint}"),
        403 => bail!("the token is not allowed to read {repo}'s pull or merge requests"),
        404 => bail!("{repo} was not found on {server}, or is private{login_hint}"),
        s => bail!("{url} answered HTTP {s}"),
    }
    let requests = match provider {
        Provider::Github => resp
            .body_mut()
            .read_json::<Vec<GhPull>>()
            .context("unexpected answer")?
            .into_iter()
            .map(|p| ReviewRequest {
                head_ref: format!("refs/pull/{}/head", p.number),
                number: p.number,
                title: p.title,
                author: p.user.map(|u| u.login).unwrap_or_default(),
                source_branch: p.head.name,
                target_branch: p.base.name,
                draft: p.draft,
                url: p.html_url,
                updated_at: p.updated_at,
            })
            .collect(),
        Provider::Gitlab => resp
            .body_mut()
            .read_json::<Vec<GlMerge>>()
            .context("unexpected answer")?
            .into_iter()
            .map(|m| ReviewRequest {
                head_ref: format!("refs/merge-requests/{}/head", m.iid),
                number: m.iid,
                title: m.title,
                author: m.author.map(|u| u.username).unwrap_or_default(),
                source_branch: m.source_branch,
                target_branch: m.target_branch,
                draft: m.draft || m.work_in_progress,
                url: m.web_url,
                updated_at: m.updated_at,
            })
            .collect(),
    };
    Ok(ReviewList {
        provider,
        remote,
        repo,
        requests,
    })
}

/// A GitLab served under a sub-path (`https://host/gitlab`) has it in its
/// remote URLs too: `gitlab/g/p` → `g/p`.
fn strip_server_path(server: &str, path: &str) -> String {
    let sub = server
        .strip_prefix(&git_auth::origin(server))
        .unwrap_or("")
        .trim_matches('/');
    if sub.is_empty() {
        return path.to_string();
    }
    match path.strip_prefix(sub) {
        Some(rest) if rest.starts_with('/') => rest.trim_matches('/').to_string(),
        _ => path.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_remote_urls() {
        let p = |u: &str| parse_remote(u);
        let gh = Some(("https://github.com".to_string(), "o/r".to_string()));
        assert_eq!(p("git@github.com:o/r.git"), gh);
        assert_eq!(p("https://me@GitHub.com/o/r"), gh);
        assert_eq!(p("https://github.com/o/r.git/"), gh);
        assert_eq!(p("ssh://git@github.com/o/r.git"), gh);
        assert_eq!(
            p("ssh://git@host:2222/g/s/p.git"),
            Some(("https://host".to_string(), "g/s/p".to_string()))
        );
        assert_eq!(
            p("http://git.local:8080/g/p"),
            Some(("http://git.local:8080".to_string(), "g/p".to_string()))
        );
        assert_eq!(p("/local/path/repo"), None);
        assert_eq!(p("../other"), None);
        assert_eq!(p("https://github.com/only"), None);
    }

    #[test]
    fn strips_gitlab_sub_path() {
        assert_eq!(strip_server_path("https://h.com/gitlab", "gitlab/g/p"), "g/p");
        assert_eq!(strip_server_path("https://h.com/gitlab", "gitlabx/p"), "gitlabx/p");
        assert_eq!(strip_server_path("https://github.com", "o/r"), "o/r");
        assert_eq!(encode_path("g/s/p.x"), "g%2Fs%2Fp.x");
    }
}
