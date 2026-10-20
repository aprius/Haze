//! Git status for the file tree, via the system git CLI.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Result};
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileStatus {
    Modified,
    Added,
    Deleted,
    Renamed,
    Untracked,
    Ignored,
    Conflict,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub is_repo: bool,
    pub root: Option<String>,
    pub branch: Option<String>,
    /// Absolute path -> status. Ignored directories appear once, not per file.
    pub files: HashMap<String, FileStatus>,
}

pub fn git_command() -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new("git");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.env("GIT_OPTIONAL_LOCKS", "0");
    // Paths are always literal: `Pages/[id].razor` must not act as a glob
    // (newer git no longer prefers an exact match over the pattern).
    cmd.env("GIT_LITERAL_PATHSPECS", "1");
    cmd
}

fn run(dir: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let out = git_command().arg("-C").arg(dir).args(args).output()?;
    if !out.status.success() {
        bail!("{}", String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(out.stdout)
}

pub fn status(dir: &Path) -> Result<GitStatus> {
    let Ok(top) = run(dir, &["rev-parse", "--show-toplevel"]) else {
        return Ok(GitStatus::default());
    };
    let top = PathBuf::from(String::from_utf8_lossy(&top).trim());
    let out = run(
        &top,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--branch",
            "--ignored=matching",
            "--untracked-files=all",
        ],
    )?;
    let (branch, files) = parse_porcelain(&out);
    let files = files
        .into_iter()
        .map(|(rel, st)| (to_native(&top, &rel), st))
        .collect();
    Ok(GitStatus {
        is_repo: true,
        root: Some(top.to_string_lossy().into_owned()),
        branch,
        files,
    })
}

fn to_native(top: &Path, rel: &str) -> String {
    let rel = rel.trim_end_matches('/');
    let mut p = top.to_path_buf();
    for part in rel.split('/') {
        p.push(part);
    }
    p.to_string_lossy().into_owned()
}

fn classify(xy: &str) -> Option<FileStatus> {
    let b = xy.as_bytes();
    let (x, y) = (b[0], b[1]);
    Some(match (x, y) {
        (b'?', b'?') => FileStatus::Untracked,
        (b'!', b'!') => FileStatus::Ignored,
        (b'U', _) | (_, b'U') | (b'A', b'A') | (b'D', b'D') => FileStatus::Conflict,
        (b'R', _) => FileStatus::Renamed,
        (b'A', _) => FileStatus::Added,
        (b'D', _) | (_, b'D') => FileStatus::Deleted,
        (b' ', b' ') => return None,
        _ => FileStatus::Modified,
    })
}

/// Parses `git status --porcelain=v1 -z --branch`.
pub fn parse_porcelain(out: &[u8]) -> (Option<String>, Vec<(String, FileStatus)>) {
    let text = String::from_utf8_lossy(out);
    let mut records = text.split('\0').filter(|r| !r.is_empty());
    let mut branch = None;
    let mut files = Vec::new();
    while let Some(rec) = records.next() {
        if let Some(head) = rec.strip_prefix("## ") {
            let name = head.split("...").next().unwrap_or(head);
            let name = name.strip_prefix("No commits yet on ").unwrap_or(name);
            branch = Some(name.trim().to_string());
            continue;
        }
        if rec.len() < 4 {
            continue;
        }
        let (xy, path) = (&rec[..2], &rec[3..]);
        if xy.starts_with('R') || xy.starts_with('C') {
            // The original path follows as its own record.
            records.next();
        }
        if let Some(st) = classify(xy) {
            files.push((path.to_string(), st));
        }
    }
    (branch, files)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_status() {
        let raw = b"## main...origin/main [ahead 1]\0 M src/A.cs\0R  src/New.cs\0src/Old.cs\0?? notes.txt\0!! bin/\0UU src/C.cs\0A  src/D.cs\0";
        let (branch, files) = parse_porcelain(raw);
        assert_eq!(branch.as_deref(), Some("main"));
        assert_eq!(
            files,
            vec![
                ("src/A.cs".into(), FileStatus::Modified),
                ("src/New.cs".into(), FileStatus::Renamed),
                ("notes.txt".into(), FileStatus::Untracked),
                ("bin/".into(), FileStatus::Ignored),
                ("src/C.cs".into(), FileStatus::Conflict),
                ("src/D.cs".into(), FileStatus::Added),
            ]
        );
    }

    #[test]
    fn status_on_real_repo() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        run(root, &["init", "-q", "-b", "main"]).unwrap();
        std::fs::write(root.join(".gitignore"), "bin/\n").unwrap();
        std::fs::create_dir(root.join("bin")).unwrap();
        std::fs::write(root.join("bin/x.dll"), "").unwrap();
        std::fs::write(root.join("A.cs"), "").unwrap();
        let st = status(root).unwrap();
        assert!(st.is_repo);
        assert_eq!(st.branch.as_deref(), Some("main"));
        let top = PathBuf::from(st.root.unwrap());
        assert_eq!(
            st.files.get(&to_native(&top, "A.cs")),
            Some(&FileStatus::Untracked)
        );
        assert_eq!(
            st.files.get(&to_native(&top, "bin")),
            Some(&FileStatus::Ignored)
        );
    }
}
