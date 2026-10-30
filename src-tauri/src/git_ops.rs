//! Git operations behind the Commit and Git tool windows. Everything goes
//! through the system git CLI, never prompting (GIT_TERMINAL_PROMPT=0), so a
//! missing credential fails fast with git's own message. GitHub/GitLab
//! accounts added in Settings supply their tokens (see git_auth).

use std::collections::HashSet;
use std::io::Write;
use std::path::Path;
use std::process::Stdio;

use anyhow::{bail, Context, Result};
use serde::Serialize;

use crate::git::git_command;
use crate::text::{self, Decoded};

fn git(root: &Path) -> std::process::Command {
    let mut cmd = git_command();
    crate::git_auth::configure(&mut cmd);
    cmd.arg("-C")
        .arg(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_EDITOR", "true")
        .env("GIT_MERGE_AUTOEDIT", "no")
        .stdin(Stdio::null());
    cmd
}

fn run_ok(root: &Path, args: &[&str]) -> Result<String> {
    let out = git(root).args(args).output()?;
    if !out.status.success() {
        bail!("{}", String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// `git <args> --pathspec-from-file=<list>`.
fn run_ok_os(root: &Path, args: &[&str], list: &PathList) -> Result<String> {
    let out = git(root).args(args).args(list.args()).output()?;
    if !out.status.success() {
        bail!("{}", String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitOutput {
    pub ok: bool,
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// Runs any git command and returns its output (the Git console shows it).
pub fn run(root: &Path, args: &[String]) -> Result<GitOutput> {
    let out = git(root).args(args).output().context("running git")?;
    Ok(GitOutput {
        ok: out.status.success(),
        code: out.status.code(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

pub fn toplevel(root: &Path) -> Result<std::path::PathBuf> {
    crate::git::toplevel_of(root)
}

// ---------------------------------------------------------------- local changes

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    /// Path relative to the repository root, `/`-separated.
    pub rel: String,
    pub old_rel: Option<String>,
    /// modified | added | deleted | renamed | untracked | conflict
    pub status: String,
    /// Some of the change is in the index.
    pub staged: bool,
}

/// Parses `git status --porcelain=v1 -z` (no ignored files).
pub fn parse_changes(out: &str) -> Vec<Change> {
    let mut records = out.split('\0').filter(|r| !r.is_empty());
    let mut changes = Vec::new();
    while let Some(rec) = records.next() {
        if rec.len() < 4 || rec.starts_with("##") {
            continue;
        }
        let (x, y) = (rec.as_bytes()[0], rec.as_bytes()[1]);
        let rel = rec[3..].to_string();
        let mut old_rel = None;
        if x == b'R' || x == b'C' {
            old_rel = records.next().map(str::to_string);
        }
        let status = match (x, y) {
            (b'?', b'?') => "untracked",
            (b'!', b'!') => continue,
            (b'U', _) | (_, b'U') | (b'A', b'A') | (b'D', b'D') => "conflict",
            (b'R', _) => "renamed",
            (b'A', _) => "added",
            (b'D', _) | (_, b'D') => "deleted",
            _ => "modified",
        };
        changes.push(Change {
            rel,
            old_rel,
            status: status.into(),
            staged: x != b' ' && x != b'?',
        });
    }
    changes
}

pub fn changes(root: &Path) -> Result<Vec<Change>> {
    let out = run_ok(
        root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    Ok(parse_changes(&out))
}

/// Paths handed to git as `--pathspec-from-file` (NUL-separated), deleted on drop.
struct PathList(std::path::PathBuf);

impl PathList {
    fn new(paths: &[&str]) -> Result<Self> {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let file = std::env::temp_dir().join(format!("haze-paths-{}-{n}", std::process::id()));
        let mut data = Vec::new();
        for p in paths {
            data.extend_from_slice(p.as_bytes());
            data.push(0);
        }
        std::fs::write(&file, data).context("writing the path list")?;
        Ok(Self(file))
    }

    fn args(&self) -> [std::ffi::OsString; 2] {
        let mut from = std::ffi::OsString::from("--pathspec-from-file=");
        from.push(&self.0);
        [from, "--pathspec-file-nul".into()]
    }
}

impl Drop for PathList {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Commits exactly `paths` (relative), the checkbox commit: no need
/// to stage first. Untracked paths among them are added.
pub fn commit(root: &Path, message: &str, paths: &[String], amend: bool) -> Result<GitOutput> {
    if paths.is_empty() && !amend {
        bail!("nothing selected to commit");
    }
    let wanted: HashSet<&str> = paths.iter().map(String::as_str).collect();
    // Renames need both sides in the pathspec. Only staged renames exist, and
    // diffing the index against HEAD is cheap; `git status` would walk the
    // whole working tree (every untracked file) just to find them.
    let renamed = run_ok(root, &["diff", "--cached", "-M", "--name-status", "-z"])
        .map(|out| parse_name_status(&out))
        .unwrap_or_default();
    let mut spec: Vec<&str> = paths.iter().map(String::as_str).collect();
    for c in &renamed {
        if let Some(old) = &c.old_rel {
            if c.status == "renamed" && wanted.contains(c.rel.as_str()) && !wanted.contains(old.as_str()) {
                spec.push(old);
            }
        }
    }
    let mut cmd = git(root);
    // `commit --only -- <paths>` matches every pathspec against the whole index,
    // which takes minutes for tens of thousands of files. Build the commit in a
    // scratch index from HEAD plus the paths instead, then bring the real index
    // up to date for the same paths once the commit exists.
    let scratch = if spec.is_empty() {
        None
    } else {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let file = std::env::temp_dir().join(format!("haze-index-{}-{n}", std::process::id()));
        let _ = std::fs::remove_file(&file);
        let has_head = git(root)
            .args(["rev-parse", "--verify", "-q", "HEAD"])
            .output()?
            .status
            .success();
        let mut read = git(root);
        read.env("GIT_INDEX_FILE", &file).arg("read-tree");
        // `git commit` refreshes the index first; a bare `read-tree HEAD` has
        // no stat data, so that hashed every file in the working tree. Reset a
        // copy of the real index instead: entries matching HEAD keep theirs.
        if !has_head {
            read.arg("--empty");
        } else if copy_index(root, &file)? {
            read.args(["--reset", "HEAD"]);
        } else {
            read.arg("HEAD");
        }
        let out = read.output()?;
        if !out.status.success() {
            bail!("{}", String::from_utf8_lossy(&out.stderr).trim());
        }
        update_index(root, Some(&file), &spec)?;
        cmd.env("GIT_INDEX_FILE", &file);
        Some(ScratchIndex(file))
    };
    cmd.args(["commit", "--file=-", "--cleanup=strip"]);
    if amend {
        cmd.arg("--amend");
    }
    if scratch.is_none() {
        cmd.arg("--only");
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    child
        .stdin
        .take()
        .context("no stdin")?
        .write_all(message.as_bytes())?;
    let out = child.wait_with_output()?;
    if out.status.success() && scratch.is_some() {
        update_index(root, None, &spec)?;
    }
    Ok(GitOutput {
        ok: out.status.success(),
        code: out.status.code(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

struct ScratchIndex(std::path::PathBuf);

impl Drop for ScratchIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
        let mut lock = self.0.clone().into_os_string();
        lock.push(".lock");
        let _ = std::fs::remove_file(lock);
    }
}

/// Makes the index (`index`, or the repository's) match the working tree for
/// `paths`: new files are added, changed ones updated, vanished ones removed.
/// The list goes through stdin, so its length is not limited.
fn update_index(root: &Path, index: Option<&Path>, paths: &[&str]) -> Result<()> {
    let mut cmd = git(root);
    if let Some(index) = index {
        cmd.env("GIT_INDEX_FILE", index);
    }
    cmd.args(["update-index", "--add", "--remove", "-z", "--stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    let mut stdin = child.stdin.take().context("no stdin")?;
    let mut data = Vec::new();
    for p in paths {
        data.extend_from_slice(p.as_bytes());
        data.push(0);
    }
    stdin.write_all(&data)?;
    drop(stdin);
    let out = child.wait_with_output()?;
    if !out.status.success() {
        bail!("{}", String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(())
}

/// Reverts paths to HEAD; files that are new (added or untracked) are only
/// unstaged here — deleting them is the caller's decision.
pub fn rollback(root: &Path, paths: &[String]) -> Result<()> {
    let current = changes(root)?;
    let new_rels: HashSet<&str> = current
        .iter()
        .filter(|c| c.status == "added" || c.status == "untracked")
        .map(|c| c.rel.as_str())
        .collect();
    let added_rels: HashSet<&str> = current
        .iter()
        .filter(|c| c.status == "added")
        .map(|c| c.rel.as_str())
        .collect();
    let (new, tracked): (Vec<&str>, Vec<&str>) = paths
        .iter()
        .map(String::as_str)
        .partition(|p| new_rels.contains(p));
    // Thousands of paths overflow the command line, so they go through a file.
    if !tracked.is_empty() {
        let wanted: HashSet<&str> = tracked.iter().copied().collect();
        let mut spec = tracked.clone();
        for c in &current {
            if let Some(old) = &c.old_rel {
                if wanted.contains(c.rel.as_str()) {
                    spec.push(old);
                }
            }
        }
        let list = PathList::new(&spec)?;
        run_ok_os(
            root,
            &["restore", "--source=HEAD", "--staged", "--worktree"],
            &list,
        )?;
    }
    let added: Vec<&str> = new.into_iter().filter(|p| added_rels.contains(p)).collect();
    if !added.is_empty() {
        let list = PathList::new(&added)?;
        run_ok_os(root, &["rm", "--cached", "-q"], &list)?;
    }
    Ok(())
}

// ---------------------------------------------------------------- commits

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub status: String,
    pub rel: String,
    pub old_rel: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetails {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    pub time: i64,
    pub committer: String,
    pub commit_time: i64,
    pub message: String,
    /// Changes against the first parent (or the empty tree for a root commit).
    pub files: Vec<ChangedFile>,
}

pub fn parse_name_status(out: &str) -> Vec<ChangedFile> {
    let mut parts = out.split('\0').filter(|p| !p.is_empty());
    let mut files = Vec::new();
    while let Some(code) = parts.next() {
        let kind = code.chars().next().unwrap_or('M');
        let status = match kind {
            'A' => "added",
            'D' => "deleted",
            'R' => "renamed",
            'C' => "copied",
            _ => "modified",
        };
        if kind == 'R' || kind == 'C' {
            let old = parts.next().map(str::to_string);
            let new = parts.next().unwrap_or_default().to_string();
            files.push(ChangedFile {
                status: status.into(),
                rel: new,
                old_rel: old,
            });
        } else if let Some(p) = parts.next() {
            files.push(ChangedFile {
                status: status.into(),
                rel: p.to_string(),
                old_rel: None,
            });
        }
    }
    files
}

pub fn commit_details(root: &Path, hash: &str) -> Result<CommitDetails> {
    let meta = run_ok(
        root,
        &[
            "log",
            "-1",
            "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ct%x1f%B",
            hash,
        ],
    )?;
    let f: Vec<&str> = meta.splitn(8, '\u{1f}').collect();
    if f.len() < 8 {
        bail!("unexpected git log output");
    }
    let parents: Vec<String> = f[1].split_whitespace().map(str::to_string).collect();
    let diff = match parents.first() {
        Some(p) => run_ok(
            root,
            &[
                "diff-tree",
                "-r",
                "-z",
                "-M",
                "--name-status",
                "--no-commit-id",
                p,
                hash,
            ],
        )?,
        None => run_ok(
            root,
            &[
                "diff-tree",
                "-r",
                "-z",
                "-M",
                "--name-status",
                "--no-commit-id",
                "--root",
                hash,
            ],
        )?,
    };
    Ok(CommitDetails {
        hash: f[0].to_string(),
        parents,
        author: f[2].to_string(),
        email: f[3].to_string(),
        time: f[4].parse().unwrap_or(0),
        committer: f[5].to_string(),
        commit_time: f[6].parse().unwrap_or(0),
        message: f[7].trim_end().to_string(),
        files: parse_name_status(&diff),
    })
}

/// Text of `rel` at `rev` (`HEAD`, a hash, `hash^`…); `None` when it does not exist there.
pub fn file_at(root: &Path, rev: &str, rel: &str) -> Result<Option<String>> {
    let out = git(root).args(["show", &format!("{rev}:{rel}")]).output()?;
    if !out.status.success() {
        return Ok(None);
    }
    Ok(match text::decode(&out.stdout) {
        Decoded::Text { content, .. } => Some(content),
        Decoded::Binary => Some(format!("(binary file, {} bytes)", out.stdout.len())),
    })
}

// ---------------------------------------------------------------- branches

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub name: String,
    /// `refs/heads/...`, `refs/remotes/...` or `refs/tags/...`
    pub refname: String,
    pub hash: String,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub current: bool,
    pub kind: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branches {
    pub current: Option<String>,
    pub detached: bool,
    /// Commit HEAD points to (`None` before the first commit).
    pub head: Option<String>,
    pub branches: Vec<Branch>,
    pub remotes: Vec<String>,
    /// A merge, rebase, cherry-pick or revert is in progress.
    pub operation: Option<String>,
}

pub fn parse_track(track: &str) -> (u32, u32) {
    let mut ahead = 0;
    let mut behind = 0;
    for part in track.trim_matches(['[', ']']).split(", ") {
        if let Some(n) = part.strip_prefix("ahead ") {
            ahead = n.parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            behind = n.parse().unwrap_or(0);
        }
    }
    (ahead, behind)
}

pub fn branches(root: &Path) -> Result<Branches> {
    let out = run_ok(
        root,
        &[
            "for-each-ref",
            "--format=%(refname)%1f%(refname:short)%1f%(objectname)%1f%(upstream:short)%1f%(upstream:track)%1f%(HEAD)",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ],
    )?;
    let mut list = Vec::new();
    for line in out.lines() {
        let f: Vec<&str> = line.split('\u{1f}').collect();
        if f.len() < 6 || f[0].ends_with("/HEAD") {
            continue;
        }
        let kind = if f[0].starts_with("refs/heads/") {
            "local"
        } else if f[0].starts_with("refs/remotes/") {
            "remote"
        } else {
            "tag"
        };
        let (ahead, behind) = parse_track(f[4]);
        list.push(Branch {
            name: f[1].to_string(),
            refname: f[0].to_string(),
            hash: f[2].to_string(),
            upstream: (!f[3].is_empty()).then(|| f[3].to_string()),
            ahead,
            behind,
            current: f[5] == "*",
            kind: kind.into(),
        });
    }
    let current_branch = list.iter().find(|b| b.current);
    let current = current_branch.map(|b| b.name.clone());
    let head = match current_branch {
        Some(b) => Some(b.hash.clone()),
        None => run_ok(root, &["rev-parse", "--verify", "-q", "HEAD"])
            .ok()
            .map(|h| h.trim().to_string()),
    };
    let detached = current.is_none() && head.is_some();
    let remotes = run_ok(root, &["remote"])?
        .lines()
        .map(str::to_string)
        .collect();
    let git_dir: std::path::PathBuf = run_ok(root, &["rev-parse", "--absolute-git-dir"])?
        .trim()
        .into();
    let operation = [
        ("MERGE_HEAD", "merge"),
        ("rebase-merge", "rebase"),
        ("rebase-apply", "rebase"),
        ("CHERRY_PICK_HEAD", "cherry-pick"),
        ("REVERT_HEAD", "revert"),
    ]
    .iter()
    .find(|(f, _)| git_dir.join(f).exists())
    .map(|(_, op)| op.to_string());
    Ok(Branches {
        current,
        detached,
        head,
        branches: list,
        remotes,
        operation,
    })
}

// ---------------------------------------------------------------- stash

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    pub index: u32,
    pub hash: String,
    pub time: i64,
    pub message: String,
}

pub fn stashes(root: &Path) -> Result<Vec<StashEntry>> {
    let out = run_ok(root, &["stash", "list", "--format=%gd%x1f%H%x1f%at%x1f%gs"])?;
    Ok(out
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\u{1f}').collect();
            let index = f
                .first()?
                .trim_start_matches("stash@{")
                .trim_end_matches('}')
                .parse()
                .ok()?;
            Some(StashEntry {
                index,
                hash: f.get(1)?.to_string(),
                time: f.get(2)?.parse().unwrap_or(0),
                message: f.get(3).unwrap_or(&"").to_string(),
            })
        })
        .collect())
}

// ---------------------------------------------------------------- blame

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    pub line: u32,
    pub hash: String,
    pub author: String,
    pub time: i64,
    pub summary: String,
}

/// Parses `git blame --line-porcelain` output.
pub fn parse_blame(out: &str) -> Vec<BlameLine> {
    let mut lines = Vec::new();
    let mut cur: Option<BlameLine> = None;
    for l in out.lines() {
        if let Some(rest) = l.strip_prefix('\t') {
            let _ = rest;
            if let Some(b) = cur.take() {
                lines.push(b);
            }
            continue;
        }
        let mut words = l.splitn(2, ' ');
        let key = words.next().unwrap_or("");
        let val = words.next().unwrap_or("");
        if key.len() == 40 && key.chars().all(|c| c.is_ascii_hexdigit()) {
            let final_line = val
                .split(' ')
                .nth(1)
                .and_then(|n| n.parse().ok())
                .unwrap_or(0);
            cur = Some(BlameLine {
                line: final_line,
                hash: key.to_string(),
                author: String::new(),
                time: 0,
                summary: String::new(),
            });
        } else if let Some(b) = cur.as_mut() {
            match key {
                "author" => b.author = val.to_string(),
                "author-time" => b.time = val.parse().unwrap_or(0),
                "summary" => b.summary = val.to_string(),
                _ => {}
            }
        }
    }
    lines
}

/// Blame for `rel`; `contents` (unsaved editor text, in the file's encoding)
/// is blamed instead of the disk file when given, `rev` (a commit) instead of
/// both: the file as committed there.
pub fn blame(
    root: &Path,
    rel: &str,
    contents: Option<&[u8]>,
    rev: Option<&str>,
) -> Result<Vec<BlameLine>> {
    let mut cmd = git(root);
    cmd.args(["blame", "--line-porcelain"]);
    match (rev, contents) {
        (Some(rev), _) => {
            // Never an option: it comes before the `--`.
            anyhow::ensure!(!rev.starts_with('-'), "invalid revision {rev:?}");
            cmd.arg(rev);
        }
        (None, Some(_)) => {
            cmd.args(["--contents", "-"]);
        }
        (None, None) => {}
    }
    let contents = if rev.is_some() { None } else { contents };
    cmd.args(["--", rel])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    if let Some(c) = contents {
        child.stdin.take().context("no stdin")?.write_all(c)?;
    } else {
        drop(child.stdin.take());
    }
    let out = child.wait_with_output()?;
    if !out.status.success() {
        bail!("{}", String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(parse_blame(&String::from_utf8_lossy(&out.stdout)))
}

// ---------------------------------------------------------------- interactive rebase

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseStep {
    /// pick | reword | edit | squash | fixup | drop
    pub action: String,
    pub hash: String,
    /// New message for `reword`.
    pub message: Option<String>,
}

/// Builds the rebase todo; rewording is done with an `exec git commit --amend`
/// line so no editor is ever needed.
pub fn rebase_todo(steps: &[RebaseStep], msg_dir: &Path) -> Result<String> {
    let mut todo = String::new();
    for (i, s) in steps.iter().enumerate() {
        match s.action.as_str() {
            "pick" | "edit" | "squash" | "fixup" | "drop" => {
                todo.push_str(&format!("{} {}\n", s.action, s.hash))
            }
            "reword" => {
                todo.push_str(&format!("pick {}\n", s.hash));
                let file = msg_dir.join(format!("msg-{i}.txt"));
                std::fs::write(&file, s.message.as_deref().unwrap_or_default())?;
                todo.push_str(&format!(
                    "exec git commit --amend --only --allow-empty --cleanup=strip -F {}\n",
                    shell_quote(&file)
                ));
            }
            other => bail!("unknown rebase action {other}"),
        }
    }
    Ok(todo)
}

fn shell_quote(p: &Path) -> String {
    format!(
        "'{}'",
        p.to_string_lossy()
            .replace('\\', "/")
            .replace('\'', "'\\''")
    )
}

/// `git rebase -i` onto `base` (`None` = from the root commit) with our todo.
pub fn rebase_interactive(
    root: &Path,
    base: Option<&str>,
    steps: &[RebaseStep],
) -> Result<GitOutput> {
    let dir = tempfile::Builder::new().prefix("haze-rebase").tempdir()?;
    let todo_path = dir.path().join("todo");
    std::fs::write(&todo_path, rebase_todo(steps, dir.path())?)?;
    let mut cmd = git(root);
    // git runs the sequence editor through its shell (also on Windows), so `cp` is available.
    cmd.env(
        "GIT_SEQUENCE_EDITOR",
        format!("cp {}", shell_quote(&todo_path)),
    );
    cmd.args(["rebase", "-i", "--autostash"]);
    match base {
        Some(b) => cmd.arg(b),
        None => cmd.arg("--root"),
    };
    let out = cmd.output()?;
    // Keep message files until git is done with them (it is, once rebase returns or stops).
    let result = GitOutput {
        ok: out.status.success(),
        code: out.status.code(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    };
    if !result.ok || git_dir(root)?.join("rebase-merge").exists() {
        // Stopped (edit, conflict): later `exec` lines still need the message files.
        let _ = dir.keep();
    }
    Ok(result)
}

fn git_dir(root: &Path) -> Result<std::path::PathBuf> {
    Ok(run_ok(root, &["rev-parse", "--absolute-git-dir"])?
        .trim()
        .into())
}

// ---------------------------------------------------------------- checkpoints

/// Snapshots the whole working tree (tracked and untracked, honoring
/// .gitignore) as a commit without touching the index, HEAD or any branch.
/// The commit is kept alive by a `refs/haze/checkpoints/*` ref.
pub fn checkpoint(root: &Path, label: &str) -> Result<String> {
    commit_checkpoint(root, snapshot_tree(root)?, label, CHECKPOINT_REFS)
}

const CHECKPOINT_REFS: &str = "refs/haze/checkpoints";
/// Checkpoints taken when an agent gets a prompt, apart from the user's own so
/// that only they are pruned. Per worktree (`refs/worktree/`): an agent in
/// another worktree of the repository must not move this one's "since".
const AUTO_CHECKPOINT_REFS: &str = "refs/worktree/haze/checkpoints";

/// A checkpoint taken as an agent gets a prompt; only the newest `keep` stay.
/// Nothing new when the tree and HEAD are those of the last one.
pub fn auto_checkpoint(root: &Path, label: &str, keep: usize) -> Result<String> {
    let refs = run_ok(
        root,
        &[
            "for-each-ref",
            "--sort=-refname",
            "--format=%(refname)",
            AUTO_CHECKPOINT_REFS,
        ],
    )?;
    let refs: Vec<&str> = refs.lines().collect();
    let tree = snapshot_tree(root)?;
    if let Some(last) = refs.first() {
        let same = |rev: &str, now: &str| {
            run_ok(root, &["rev-parse", "--verify", "-q", rev]).is_ok_and(|h| h.trim() == now)
        };
        let head = run_ok(root, &["rev-parse", "--verify", "-q", "HEAD"]).unwrap_or_default();
        if same(&format!("{last}^{{tree}}"), &tree) && same(&format!("{last}^"), head.trim()) {
            return Ok(run_ok(root, &["rev-parse", last])?.trim().to_string());
        }
    }
    let hash = commit_checkpoint(root, tree, label, AUTO_CHECKPOINT_REFS)?;
    // The new one sorts first, so `keep - 1` of the old ones stay.
    for r in refs.iter().skip(keep.saturating_sub(1)) {
        run_ok(root, &["update-ref", "-d", r])?;
    }
    Ok(hash)
}

fn commit_checkpoint(root: &Path, tree: String, label: &str, namespace: &str) -> Result<String> {
    let mut args = vec![
        "commit-tree".to_string(),
        tree,
        "-m".into(),
        format!("Haze checkpoint: {label}"),
    ];
    if run_ok(root, &["rev-parse", "--verify", "-q", "HEAD"]).is_ok() {
        args.push("-p".into());
        args.push("HEAD".into());
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let hash = run_ok(root, &refs)?.trim().to_string();
    let name = format!("{namespace}/{}", crate::pty::now_ms());
    run_ok(root, &["update-ref", &name, &hash])?;
    Ok(hash)
}

/// Copies the repository's index to `to`; `false` when there is none.
fn copy_index(root: &Path, to: &Path) -> Result<bool> {
    let index = git_dir(root)?.join("index");
    if !index.exists() {
        return Ok(false);
    }
    std::fs::copy(&index, to)?;
    // With the index's own mtime: git compares the content of entries
    // indexed in that instant (racy git), where their stat cannot tell an
    // edit. A copy dated now (as on Linux) had git trust them, and miss a
    // same-size edit made in the second of a `git add`.
    std::fs::File::options()
        .write(true)
        .open(to)?
        .set_modified(std::fs::metadata(&index)?.modified()?)?;
    Ok(true)
}

fn snapshot_tree(root: &Path) -> Result<String> {
    let tmp = tempfile::NamedTempFile::new()?;
    copy_index(root, tmp.path())?;
    let with_index = |args: &[&str]| -> Result<String> {
        let out = git(root)
            .env("GIT_INDEX_FILE", tmp.path())
            .args(args)
            .output()?;
        if !out.status.success() {
            bail!("{}", String::from_utf8_lossy(&out.stderr).trim());
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    };
    with_index(&["add", "-A", "--", "."])?;
    with_index(&["write-tree"])
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    pub hash: String,
    pub time: i64,
    pub label: String,
    /// Taken by an agent hook as it got a prompt.
    pub auto: bool,
}

pub fn checkpoints(root: &Path) -> Result<Vec<Checkpoint>> {
    let out = run_ok(
        root,
        &[
            "for-each-ref",
            "--sort=-creatordate",
            "--format=%(objectname)%1f%(creatordate:unix)%1f%(contents:subject)%1f%(refname)",
            CHECKPOINT_REFS,
            AUTO_CHECKPOINT_REFS,
        ],
    )?;
    Ok(out
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\u{1f}').collect();
            Some(Checkpoint {
                hash: f.first()?.to_string(),
                time: f.get(1)?.parse().unwrap_or(0),
                label: f
                    .get(2)?
                    .trim_start_matches("Haze checkpoint: ")
                    .to_string(),
                auto: f.get(3)?.starts_with(AUTO_CHECKPOINT_REFS),
            })
        })
        .collect())
}

/// Files that differ between a checkpoint and the working tree now.
pub fn changes_since(root: &Path, checkpoint: &str) -> Result<Vec<ChangedFile>> {
    let now = snapshot_tree(root)?;
    let out = run_ok(
        root,
        &[
            "diff-tree",
            "-r",
            "-z",
            "-M",
            "--name-status",
            &format!("{checkpoint}^{{tree}}"),
            &now,
        ],
    )?;
    Ok(parse_name_status(&out))
}

pub fn delete_checkpoints(root: &Path) -> Result<()> {
    let out = run_ok(
        root,
        &[
            "for-each-ref",
            "--format=%(refname)",
            CHECKPOINT_REFS,
            AUTO_CHECKPOINT_REFS,
        ],
    )?;
    for r in out.lines() {
        run_ok(root, &["update-ref", "-d", r])?;
    }
    Ok(())
}

/// Content fingerprints (or `None` for missing files), so "reviewed" marks
/// can be dropped when a file changes again.
pub fn fingerprints(root: &Path, rels: &[String]) -> Vec<Option<String>> {
    rels.iter()
        .map(|r| {
            let bytes = std::fs::read(root.join(r)).ok()?;
            use std::hash::{Hash, Hasher};
            let mut h = std::collections::hash_map::DefaultHasher::new();
            bytes.hash(&mut h);
            Some(format!("{:016x}", h.finish()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Repo(tempfile::TempDir);

    impl Repo {
        fn new() -> Self {
            let r = Repo(tempfile::tempdir().unwrap());
            r.git(&["init", "-q", "-b", "main"]);
            r.git(&["config", "user.name", "T"]);
            r.git(&["config", "user.email", "t@t"]);
            r
        }
        fn path(&self) -> &Path {
            self.0.path()
        }
        fn git(&self, args: &[&str]) -> String {
            let out = git(self.path())
                .args(["-c", "user.name=T", "-c", "user.email=t@t"])
                .args(args)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{:?}: {}",
                args,
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8_lossy(&out.stdout).into_owned()
        }
        fn write(&self, rel: &str, text: &str) {
            let p = self.path().join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        }
    }

    #[test]
    fn parses_status_with_renames() {
        let c = parse_changes(" M a.cs\0R  new.cs\0old.cs\0?? n.txt\0UU c.cs\0A  d.cs\0");
        assert_eq!(c.len(), 5);
        assert_eq!(c[1].old_rel.as_deref(), Some("old.cs"));
        assert_eq!(c[1].status, "renamed");
        assert!(c[1].staged && !c[0].staged);
        assert_eq!(c[3].status, "conflict");
    }

    #[test]
    fn commits_more_paths_than_fit_on_a_command_line() {
        let r = Repo::new();
        r.write("keep.txt", "1");
        let dir = "d".repeat(100);
        let rels: Vec<String> = (0..20_000).map(|i| format!("{dir}/file-{i:06}.txt")).collect();
        for rel in &rels {
            r.write(rel, "x");
        }
        let out = commit(r.path(), "many", &rels, false).unwrap();
        assert!(out.ok, "{}", out.stderr);
        assert_eq!(r.git(&["ls-files"]).lines().count(), rels.len());
        assert!(r.git(&["status", "--porcelain"]).contains("keep.txt"));
    }

    #[test]
    fn commits_deletions_and_renames_and_leaves_the_rest_alone() {
        let r = Repo::new();
        for f in ["gone.txt", "old.txt", "other.txt"] {
            r.write(f, "1");
        }
        r.git(&["add", "."]);
        r.git(&["commit", "-q", "-m", "init"]);
        std::fs::remove_file(r.path().join("gone.txt")).unwrap();
        std::fs::rename(r.path().join("old.txt"), r.path().join("new.txt")).unwrap();
        r.git(&["add", "-A", "new.txt", "old.txt"]);
        r.write("other.txt", "2");
        let paths = vec!["gone.txt".to_string(), "new.txt".to_string()];
        let out = commit(r.path(), "m", &paths, false).unwrap();
        assert!(out.ok, "{}", out.stderr);
        assert_eq!(r.git(&["ls-tree", "-r", "--name-only", "HEAD"]), "new.txt\nother.txt\n");
        assert_eq!(r.git(&["status", "--porcelain"]), " M other.txt\n");
    }

    #[test]
    fn leaves_staged_changes_of_unchecked_files_out_and_staged() {
        let r = Repo::new();
        r.write("a.txt", "1");
        r.write("b.txt", "1");
        r.git(&["add", "."]);
        r.git(&["commit", "-q", "-m", "init"]);
        r.write("a.txt", "2");
        r.write("b.txt", "2");
        r.git(&["add", "b.txt"]);
        let out = commit(r.path(), "m", &["a.txt".into()], false).unwrap();
        assert!(out.ok, "{}", out.stderr);
        assert_eq!(file_at(r.path(), "HEAD", "b.txt").unwrap().as_deref(), Some("1"));
        assert_eq!(r.git(&["status", "--porcelain"]), "M  b.txt\n");
    }

    #[test]
    fn rolls_back_more_paths_than_fit_on_a_command_line() {
        let r = Repo::new();
        let dir = "d".repeat(100);
        let rels: Vec<String> = (0..20_000).map(|i| format!("{dir}/file-{i:06}.txt")).collect();
        for rel in &rels {
            r.write(rel, "1");
        }
        r.git(&["add", "."]);
        r.git(&["commit", "-q", "-m", "init"]);
        for rel in &rels {
            r.write(rel, "2");
        }
        rollback(r.path(), &rels).unwrap();
        assert!(r.git(&["status", "--porcelain"]).is_empty());
    }

    #[test]
    fn commits_only_checked_files_without_staging() {
        let r = Repo::new();
        r.write("a.cs", "1");
        r.write("b.cs", "1");
        r.git(&["add", "."]);
        r.git(&["commit", "-q", "-m", "init"]);
        r.write("a.cs", "2");
        r.write("b.cs", "2");
        r.write("new.cs", "n");
        let out = commit(
            r.path(),
            "change a\n\nbody",
            &["a.cs".into(), "new.cs".into()],
            false,
        )
        .unwrap();
        assert!(out.ok, "{}", out.stderr);
        let left: Vec<String> = changes(r.path())
            .unwrap()
            .into_iter()
            .map(|c| c.rel)
            .collect();
        assert_eq!(left, vec!["b.cs"]);
        let head = commit_details(r.path(), "HEAD").unwrap();
        assert_eq!(head.message, "change a\n\nbody");
        let mut files: Vec<_> = head
            .files
            .iter()
            .map(|f| (f.status.as_str(), f.rel.as_str()))
            .collect();
        files.sort();
        assert_eq!(files, vec![("added", "new.cs"), ("modified", "a.cs")]);
        assert_eq!(
            file_at(r.path(), "HEAD~1", "a.cs").unwrap().as_deref(),
            Some("1")
        );
        assert_eq!(file_at(r.path(), "HEAD~1", "new.cs").unwrap(), None);

        // Amend with only a new message.
        let out = commit(r.path(), "change a (amended)", &[], true).unwrap();
        assert!(out.ok, "{}", out.stderr);
        assert_eq!(
            commit_details(r.path(), "HEAD").unwrap().message,
            "change a (amended)"
        );

        // Rollback restores tracked files.
        rollback(r.path(), &["b.cs".into()]).unwrap();
        assert!(changes(r.path()).unwrap().is_empty());
    }

    #[test]
    fn paths_with_glob_characters_are_literal() {
        let r = Repo::new();
        r.write("Pages/[id].razor", "1");
        r.write("Pages/i.razor", "1");
        r.git(&["add", "."]);
        r.git(&["commit", "-q", "-m", "init"]);
        r.write("Pages/[id].razor", "2");
        r.write("Pages/i.razor", "2");
        // `[id]` as a glob would match `i.razor` instead of the file itself.
        rollback(r.path(), &["Pages/[id].razor".into()]).unwrap();
        let left: Vec<String> = changes(r.path())
            .unwrap()
            .into_iter()
            .map(|c| c.rel)
            .collect();
        assert_eq!(left, vec!["Pages/i.razor"]);
    }

    #[test]
    fn branches_stash_and_blame() {
        let r = Repo::new();
        r.write("a.cs", "line1\nline2\n");
        r.git(&["add", "."]);
        r.git(&["commit", "-q", "-m", "init"]);
        r.git(&["branch", "feature"]);
        let b = branches(r.path()).unwrap();
        assert_eq!(b.current.as_deref(), Some("main"));
        assert_eq!(b.branches.iter().filter(|x| x.kind == "local").count(), 2);
        assert_eq!(b.operation, None);
        let main = r.git(&["rev-parse", "HEAD"]).trim().to_string();
        assert_eq!(b.head.as_deref(), Some(main.as_str()));
        r.git(&["checkout", "-q", "--detach"]);
        let b = branches(r.path()).unwrap();
        assert!(b.detached);
        assert_eq!(b.head.as_deref(), Some(main.as_str()));
        r.git(&["checkout", "-q", "main"]);

        r.write("a.cs", "changed\n");
        r.git(&["stash", "push", "-q", "-m", "wip"]);
        let s = stashes(r.path()).unwrap();
        assert_eq!(s.len(), 1);
        assert!(s[0].message.contains("wip"));

        let blame_of = |contents: Option<&[u8]>, rev: Option<&str>| {
            blame(r.path(), "a.cs", contents, rev).unwrap()
        };
        let blame = blame_of(Some(b"line1\nline2\nnew\n"), None);
        assert_eq!(blame.len(), 3);
        assert_eq!(
            blame.iter().map(|b| b.line).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        assert_eq!(blame[0].summary, "init");
        assert_eq!(blame[2].hash, "0".repeat(40));
        // At a commit: the file as committed, whatever the disk or the buffer holds.
        r.write("a.cs", "edited\n");
        let at_head = blame_of(Some(b"other\n"), Some("HEAD"));
        assert_eq!(at_head.len(), 2);
        assert!(at_head.iter().all(|b| b.summary == "init"));
        assert!(super::blame(r.path(), "a.cs", None, Some("--contents")).is_err());
    }

    #[test]
    fn interactive_rebase_squashes_rewords_and_drops() {
        let r = Repo::new();
        for (i, name) in ["a", "b", "c", "d"].iter().enumerate() {
            r.write(&format!("{name}.txt"), &i.to_string());
            r.git(&["add", "."]);
            r.git(&["commit", "-q", "-m", &format!("add {name}")]);
        }
        let hashes: Vec<String> = r
            .git(&["log", "--format=%H", "--reverse"])
            .lines()
            .map(str::to_string)
            .collect();
        let steps = vec![
            RebaseStep {
                action: "reword".into(),
                hash: hashes[1].clone(),
                message: Some("add b (reworded)".into()),
            },
            RebaseStep {
                action: "fixup".into(),
                hash: hashes[2].clone(),
                message: None,
            },
            RebaseStep {
                action: "drop".into(),
                hash: hashes[3].clone(),
                message: None,
            },
        ];
        let out = rebase_interactive(r.path(), Some(&hashes[0]), &steps).unwrap();
        assert!(out.ok, "{}", out.stderr);
        let log = r.git(&["log", "--format=%s"]);
        assert_eq!(
            log.lines().collect::<Vec<_>>(),
            vec!["add b (reworded)", "add a"]
        );
        assert!(r.path().join("c.txt").exists() && !r.path().join("d.txt").exists());
    }

    #[test]
    fn checkpoints_see_a_same_size_edit_made_as_the_index_was_written() {
        // Racy git: a file indexed in the same instant as the index was written,
        // then changed to the same size in that instant again, looks unchanged
        // by its stat; git compares the content because the index file's mtime
        // says so. Linux git compares whole seconds, so this is any edit in the
        // second of a `git add`. The instant is set here, ten seconds ago, and
        // ctime (which any write moves) is left out of the comparison.
        let r = Repo::new();
        r.git(&["config", "core.trustctime", "false"]);
        let past = std::time::SystemTime::now() - std::time::Duration::from_secs(10);
        let touch = |rel: &str| {
            std::fs::File::options()
                .write(true)
                .open(r.path().join(rel))
                .unwrap()
                .set_modified(past)
                .unwrap()
        };
        r.write("a.cs", "1");
        touch("a.cs");
        r.git(&["add", "."]);
        r.git(&["commit", "-q", "-m", "init"]);
        touch(".git/index");
        r.write("a.cs", "2");
        touch("a.cs");
        let cp = checkpoint(r.path(), "before agent").unwrap();
        assert_eq!(file_at(r.path(), &cp, "a.cs").unwrap().as_deref(), Some("2"));
        assert!(changes_since(r.path(), &cp).unwrap().is_empty());
    }

    #[test]
    fn auto_checkpoints_skip_repeats_and_keep_only_the_newest() {
        let r = Repo::new();
        r.write("a.cs", "0");
        r.git(&["add", "."]);
        r.git(&["commit", "-q", "-m", "init"]);
        let mine = checkpoint(r.path(), "mine").unwrap();
        let first = auto_checkpoint(r.path(), "Claude Code prompt", 2).unwrap();
        // Nothing changed: the same checkpoint again.
        assert_eq!(
            auto_checkpoint(r.path(), "Claude Code prompt", 2).unwrap(),
            first
        );
        for i in 1..=3 {
            r.write("a.cs", &i.to_string());
            std::thread::sleep(std::time::Duration::from_millis(2));
            auto_checkpoint(r.path(), "Claude Code prompt", 2).unwrap();
        }
        let all = checkpoints(r.path()).unwrap();
        let autos: Vec<&Checkpoint> = all.iter().filter(|c| c.auto).collect();
        assert_eq!(autos.len(), 2);
        assert!(autos.iter().all(|c| c.label == "Claude Code prompt"));
        assert!(
            all.iter().any(|c| c.hash == mine && !c.auto),
            "the user's own stays"
        );
        let newest = autos
            .iter()
            .find(|c| file_at(r.path(), &c.hash, "a.cs").unwrap().as_deref() == Some("3"));
        assert!(newest.is_some());

        // Another worktree's agent keeps its checkpoints to itself.
        let other = r.path().with_extension("wt");
        r.git(&[
            "worktree",
            "add",
            "-q",
            "-b",
            "task",
            other.to_str().unwrap(),
        ]);
        auto_checkpoint(&other, "Codex prompt", 2).unwrap();
        assert!(checkpoints(&other)
            .unwrap()
            .iter()
            .any(|c| c.label == "Codex prompt"));
        assert!(!checkpoints(r.path())
            .unwrap()
            .iter()
            .any(|c| c.label == "Codex prompt"));
        std::fs::remove_dir_all(&other).ok();

        delete_checkpoints(r.path()).unwrap();
        assert!(checkpoints(r.path()).unwrap().is_empty());
    }

    #[test]
    fn checkpoints_capture_untracked_files_without_touching_index() {
        let r = Repo::new();
        r.write("a.cs", "1");
        r.git(&["add", "."]);
        r.git(&["commit", "-q", "-m", "init"]);
        r.write("a.cs", "2");
        r.write("new.cs", "n");
        let before = r.git(&["status", "--porcelain"]);
        let cp = checkpoint(r.path(), "before agent").unwrap();
        assert_eq!(r.git(&["status", "--porcelain"]), before, "index untouched");
        assert_eq!(checkpoints(r.path()).unwrap()[0].label, "before agent");
        assert!(changes_since(r.path(), &cp).unwrap().is_empty());
        r.write("a.cs", "3");
        std::fs::remove_file(r.path().join("new.cs")).unwrap();
        r.write("other.cs", "o");
        let mut changed: Vec<(String, String)> = changes_since(r.path(), &cp)
            .unwrap()
            .into_iter()
            .map(|f| (f.status, f.rel))
            .collect();
        changed.sort();
        assert_eq!(
            changed,
            vec![
                ("added".into(), "other.cs".into()),
                ("deleted".into(), "new.cs".into()),
                ("modified".into(), "a.cs".into())
            ]
        );
        assert_eq!(
            file_at(r.path(), &cp, "new.cs").unwrap().as_deref(),
            Some("n")
        );
        let fp = fingerprints(r.path(), &["a.cs".into(), "missing".into()]);
        assert!(fp[0].is_some() && fp[1].is_none());
        delete_checkpoints(r.path()).unwrap();
        assert!(checkpoints(r.path()).unwrap().is_empty());
    }

    #[test]
    fn parses_track() {
        assert_eq!(parse_track("[ahead 2, behind 3]"), (2, 3));
        assert_eq!(parse_track("[behind 1]"), (0, 1));
        assert_eq!(parse_track(""), (0, 0));
    }
}
