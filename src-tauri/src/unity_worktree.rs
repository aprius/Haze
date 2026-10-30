//! A new worktree of a Unity project starts without `Library`, and Unity then
//! imports every asset again (many minutes, gigabytes). Where the disk can
//! clone files (APFS, Btrfs, XFS), the worktree gets the main checkout's
//! `Library` and `UserSettings` as copy-on-write clones: instant, and no space
//! used until either side changes a file. Elsewhere nothing is copied; a full
//! copy would cost as much as the import it saves.
//!
//! The Editors tool window lists those copies (worktrees, and clones such as
//! a `<project>Play` folder next to it) with the Editor each has open.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::Serialize;

use crate::unity::is_unity_project;

/// Folders the import builds and git ignores, cloned into a new worktree.
const SEEDED: &[&str] = &["Library", "UserSettings"];

/// Files in the clone that belong to the main checkout's running Editor. Left
/// in place, the worktree would look open in that Editor: Haze's link and the
/// `unity` CLI (`unity command --project-path <worktree>`) would drive it.
const EDITOR_INSTANCE: &[&str] = &[
    "Library/EditorInstance.json",
    "Library/burst.pid",
    "Library/Haze/EditorInstance.json",
    "Library/Pipeline/.unity-pipeline-port",
    "Library/ArtifactDB-lock",
    "Library/SourceAssetDB-lock",
    "Library/ClaudeHooks",
];

#[derive(Debug, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Seeded {
    /// The Unity project inside the new worktree, when the project is one.
    pub unity_root: Option<String>,
    /// Folders cloned.
    pub cloned: Vec<String>,
    /// Why a folder was not cloned, when one was not.
    pub skipped: Option<String>,
}

/// Seeds the worktree at `worktree` (the checkout of `repo_root`) for the
/// Unity project at `project`, which is `repo_root` or a folder inside it.
pub fn seed_worktree(project: &Path, repo_root: &Path, worktree: &Path) -> Result<Seeded> {
    if !is_unity_project(project) {
        return Ok(Seeded::default());
    }
    // Both resolved: git reports `/private/tmp/…` for `/tmp/…` on macOS.
    let (resolved, root) = (project.canonicalize()?, repo_root.canonicalize()?);
    let rel = resolved
        .strip_prefix(&root)
        .context("the project is outside its repository")?;
    let target = worktree.join(rel);
    let mut seeded = Seeded {
        unity_root: Some(target.to_string_lossy().into_owned()),
        ..Seeded::default()
    };
    for name in SEEDED {
        let (from, to) = (project.join(name), target.join(name));
        if !from.is_dir() || to.exists() {
            continue;
        }
        if let Err(e) = clone_dir(&from, &to) {
            let _ = std::fs::remove_dir_all(&to);
            seeded.skipped = Some(format!("{name} was not copied: {e:#}"));
            break;
        }
        seeded.cloned.push((*name).into());
    }
    // Only in a Library cloned here: one that was there already may belong to
    // an Editor that has this copy open.
    if !seeded.cloned.iter().any(|n| n == "Library") {
        return Ok(seeded);
    }
    for rel in EDITOR_INSTANCE {
        let path = target.join(rel);
        let _ = if path.is_dir() {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
    }
    Ok(seeded)
}

#[cfg(target_os = "macos")]
fn clone_dir(from: &Path, to: &Path) -> Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let c = |p: &Path| CString::new(p.as_os_str().as_bytes()).context("path has a NUL byte");
    let (src, dst) = (c(from)?, c(to)?);
    // One call clones the whole tree on APFS; other file systems refuse it.
    if unsafe { libc::clonefile(src.as_ptr(), dst.as_ptr(), 0) } != 0 {
        let e = std::io::Error::last_os_error();
        bail!("this disk cannot clone files ({e})");
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn clone_dir(from: &Path, to: &Path) -> Result<()> {
    let out = std::process::Command::new("cp")
        .args(["-a", "--reflink=always"])
        .arg(from)
        .arg(to)
        .output()
        .context("running cp")?;
    if !out.status.success() {
        bail!(
            "this disk cannot clone files ({})",
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn clone_dir(_from: &Path, _to: &Path) -> Result<()> {
    bail!("cloning folders is not supported on this system")
}

/// The Unity project of `dir` inside a new worktree, for the CLI: `dir` itself
/// when it is one, else the repository root.
pub fn project_of(dir: &Path, repo_root: &Path) -> PathBuf {
    if is_unity_project(dir) {
        dir.to_path_buf()
    } else {
        repo_root.to_path_buf()
    }
}

// ---------------------------------------------------------------- copies and their Editors

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCopy {
    pub root: String,
    /// project (the one asked about) | worktree | copy (a folder next to it)
    pub kind: String,
    pub branch: Option<String>,
    /// The Unity Editor that has it open.
    pub editor: Option<RunningEditor>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunningEditor {
    pub pid: u32,
    pub version: Option<String>,
    /// The `unity` CLI drives it (`com.unity.pipeline` answers for this folder).
    pub pipeline: bool,
    /// Haze's own link (`com.aprius.ide.haze`) is up.
    pub haze_link: bool,
}

/// `project`, the same Unity project in the repository's other worktrees,
/// and Unity projects next to it whose folder name starts with its own.
pub fn project_copies(project: &Path) -> Result<Vec<ProjectCopy>> {
    let project = project.canonicalize()?;
    let mut copies = vec![copy_of(&project, "project", None)];
    let seen = |copies: &[ProjectCopy], p: &Path| copies.iter().any(|c| Path::new(&c.root) == p);
    if let Ok(root) = crate::git::toplevel_of(&project).and_then(|r| Ok(r.canonicalize()?)) {
        let rel = project
            .strip_prefix(&root)
            .unwrap_or(Path::new(""))
            .to_path_buf();
        for (path, branch) in worktrees(&root) {
            let Ok(target) = path.join(&rel).canonicalize() else {
                continue;
            };
            if is_unity_project(&target) && !seen(&copies, &target) {
                copies.push(copy_of(&target, "worktree", branch));
            }
        }
    }
    let name = project
        .file_name()
        .map(|n| n.to_string_lossy().into_owned());
    if let (Some(parent), Some(name)) = (project.parent(), name) {
        let mut siblings: Vec<PathBuf> = std::fs::read_dir(parent)?
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .is_some_and(|n| n.to_string_lossy().starts_with(&name))
            })
            .collect();
        siblings.sort();
        for path in siblings {
            if is_unity_project(&path) && !seen(&copies, &path) {
                copies.push(copy_of(&path, "copy", None));
            }
        }
    }
    Ok(copies)
}

fn worktrees(root: &Path) -> Vec<(PathBuf, Option<String>)> {
    let Ok(out) = crate::git::git_command()
        .arg("-C")
        .arg(root)
        .args(["worktree", "list", "--porcelain"])
        .output()
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&out.stdout)
        .split("\n\n")
        .filter_map(|block| {
            let line = |key: &str| {
                block
                    .lines()
                    .find_map(|l| l.strip_prefix(key).map(str::to_string))
            };
            let path = PathBuf::from(line("worktree ")?);
            let branch = line("branch ").map(|b| b.trim_start_matches("refs/heads/").to_string());
            Some((path, branch))
        })
        .collect()
}

fn copy_of(root: &Path, kind: &str, branch: Option<String>) -> ProjectCopy {
    ProjectCopy {
        root: root.to_string_lossy().into_owned(),
        kind: kind.into(),
        branch,
        editor: running_editor(root),
    }
}

fn read_json(path: &Path) -> Option<serde_json::Value> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// The Editor `Library/EditorInstance.json` names, when that process still runs.
fn running_editor(root: &Path) -> Option<RunningEditor> {
    let instance = read_json(&root.join("Library/EditorInstance.json"))?;
    let pid = u32::try_from(instance.get("process_id")?.as_u64()?).ok()?;
    if !alive(pid) {
        return None;
    }
    let names_pid =
        |v: &serde_json::Value, key: &str| v.get(key).and_then(|p| p.as_u64()) == Some(pid.into());
    // A file copied from another checkout names that checkout's Editor.
    let pipeline =
        read_json(&root.join("Library/Pipeline/.unity-pipeline-port")).is_some_and(|p| {
            names_pid(&p, "pid")
                && p.get("projectPath")
                    .and_then(|r| r.as_str())
                    .and_then(|r| Path::new(r).canonicalize().ok())
                    .is_some_and(|r| r == root)
        });
    let haze_link = read_json(&root.join("Library/Haze/EditorInstance.json"))
        .is_some_and(|h| names_pid(&h, "pid"));
    Some(RunningEditor {
        pid,
        version: instance
            .get("version")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        pipeline,
        haze_link,
    })
}

/// The project's `EditorInstance.json`, else its main checkout's: a seeded
/// worktree has none of its own (see `EDITOR_INSTANCE`) until Unity opens it.
fn editor_instance(project: &Path) -> Option<serde_json::Value> {
    read_json(&project.join("Library/EditorInstance.json")).or_else(|| {
        let project = project.canonicalize().ok()?;
        let root = crate::git::toplevel_of(&project)
            .ok()?
            .canonicalize()
            .ok()?;
        let rel = project.strip_prefix(&root).ok()?;
        // `git worktree list` names the main worktree first.
        let (main, _) = worktrees(&root).into_iter().next()?;
        read_json(&main.join(rel).join("Library/EditorInstance.json"))
    })
}

#[cfg(unix)]
fn alive(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    // EPERM: it runs, as another user.
    let sent = unsafe { libc::kill(pid, 0) } == 0;
    sent || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
fn alive(pid: u32) -> bool {
    std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output()
        .is_ok_and(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()))
}

/// Opens `root` in a new Unity Editor: the one the project last ran
/// (`Library/EditorInstance.json`), which matches its Unity version.
pub fn open_in_unity(project: &Path, root: &Path) -> Result<()> {
    let instance = editor_instance(project)
        .context("open the project in Unity once first, so Haze knows which Editor it uses")?;
    let app = instance
        .get("app_path")
        .and_then(|a| a.as_str())
        .map(PathBuf::from)
        .context("the project's EditorInstance.json names no Editor")?;
    // The path comes from a file in the project: only ever start a Unity Editor.
    let name = app.file_name().map(|n| n.to_string_lossy().to_lowercase());
    if !matches!(name.as_deref(), Some("unity.app" | "unity.exe" | "unity")) || !app.exists() {
        bail!("{} is not a Unity Editor", app.display());
    }
    let mut cmd = if cfg!(target_os = "macos") {
        let mut c = std::process::Command::new("open");
        c.args(["-n", "-a"]).arg(&app).arg("--args");
        c
    } else {
        std::process::Command::new(&app)
    };
    cmd.arg("-projectPath")
        .arg(root)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .with_context(|| format!("starting {}", app.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unity_project(root: &Path) {
        for dir in [
            "Assets",
            "ProjectSettings",
            "Library/Haze",
            "Library/Pipeline",
            "Library/ScriptAssemblies",
        ] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
        }
        std::fs::write(root.join("Library/ScriptAssemblies/Game.dll"), "dll").unwrap();
        std::fs::write(root.join("Library/EditorInstance.json"), "{}").unwrap();
        std::fs::write(root.join("Library/Haze/EditorInstance.json"), "{}").unwrap();
        std::fs::write(root.join("Library/Pipeline/.unity-pipeline-port"), "{}").unwrap();
    }

    #[test]
    fn a_library_already_there_keeps_its_editor_files() {
        let repo = tempfile::tempdir().unwrap();
        unity_project(repo.path());
        let wt = tempfile::tempdir().unwrap();
        unity_project(wt.path());
        let seeded = seed_worktree(repo.path(), repo.path(), wt.path()).unwrap();
        assert!(!seeded.cloned.contains(&"Library".to_string()));
        assert!(wt
            .path()
            .join("Library/Pipeline/.unity-pipeline-port")
            .exists());
    }

    #[test]
    fn not_a_unity_project_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let wt = tempfile::tempdir().unwrap();
        assert_eq!(
            seed_worktree(dir.path(), dir.path(), wt.path()).unwrap(),
            Seeded::default()
        );
    }

    #[test]
    fn clones_library_without_the_running_editor() {
        let repo = tempfile::tempdir().unwrap();
        let project = repo.path().join("Game");
        unity_project(&project);
        let wt = tempfile::tempdir().unwrap();
        let seeded = seed_worktree(&project, repo.path(), wt.path()).unwrap();
        let target = wt.path().join("Game");
        assert_eq!(seeded.unity_root.as_deref(), Some(target.to_str().unwrap()));
        if let Some(why) = seeded.skipped {
            // A temp folder on a disk that cannot clone: nothing half-copied.
            assert!(!target.join("Library").exists(), "{why}");
            return;
        }
        assert_eq!(seeded.cloned, vec!["Library"]);
        let read = |rel: &str| std::fs::read_to_string(target.join(rel)).ok();
        assert_eq!(
            read("Library/ScriptAssemblies/Game.dll").as_deref(),
            Some("dll")
        );
        for gone in [
            "Library/EditorInstance.json",
            "Library/Haze/EditorInstance.json",
            "Library/Pipeline/.unity-pipeline-port",
        ] {
            assert!(!target.join(gone).exists(), "{gone}");
        }
        // The main checkout keeps its own.
        assert!(project
            .join("Library/Pipeline/.unity-pipeline-port")
            .exists());
    }

    #[test]
    fn lists_worktrees_and_copies_with_their_editor() {
        let parent = tempfile::tempdir().unwrap();
        let project = parent.path().join("Game");
        unity_project(&project);
        let git = |dir: &Path, args: &[&str]| {
            assert!(std::process::Command::new("git")
                .arg("-C")
                .arg(dir)
                .args(args)
                .status()
                .unwrap()
                .success())
        };
        git(&project, &["init", "-q", "-b", "main"]);
        git(
            &project,
            &[
                "-c",
                "user.name=T",
                "-c",
                "user.email=t@t",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "init",
            ],
        );
        let wt = parent.path().join("Game-task");
        git(
            &project,
            &["worktree", "add", "-q", "-b", "task", wt.to_str().unwrap()],
        );
        unity_project(&wt);
        unity_project(&parent.path().join("GamePlay"));
        std::fs::create_dir_all(parent.path().join("Other/Assets")).unwrap();

        // An Editor that runs (this test) with the pipeline answering for the project.
        let pid = std::process::id();
        std::fs::write(
            project.join("Library/EditorInstance.json"),
            format!(r#"{{"process_id":{pid},"version":"6000.6.5f1"}}"#),
        )
        .unwrap();
        let resolved = project.canonicalize().unwrap();
        std::fs::write(
            project.join("Library/Pipeline/.unity-pipeline-port"),
            serde_json::json!({"pid": pid, "projectPath": resolved}).to_string(),
        )
        .unwrap();

        let copies = project_copies(&project).unwrap();
        let kinds: Vec<(&str, &str)> = copies
            .iter()
            .map(|c| {
                (
                    c.kind.as_str(),
                    Path::new(&c.root).file_name().unwrap().to_str().unwrap(),
                )
            })
            .collect();
        assert_eq!(
            kinds,
            vec![
                ("project", "Game"),
                ("worktree", "Game-task"),
                ("copy", "GamePlay")
            ]
        );
        assert_eq!(copies[1].branch.as_deref(), Some("task"));
        let editor = copies[0].editor.as_ref().unwrap();
        assert_eq!(
            (editor.pid, editor.pipeline, editor.haze_link),
            (pid, true, false)
        );
        assert!(copies[1].editor.is_none() && copies[2].editor.is_none());
    }

    #[test]
    fn opens_only_a_unity_editor() {
        let dir = tempfile::tempdir().unwrap();
        unity_project(dir.path());
        std::fs::write(
            dir.path().join("Library/EditorInstance.json"),
            r#"{"app_path":"/bin/sh"}"#,
        )
        .unwrap();
        let err = open_in_unity(dir.path(), dir.path()).unwrap_err();
        assert!(err.to_string().contains("not a Unity Editor"), "{err}");
    }

    #[test]
    fn a_seeded_worktree_opens_with_the_main_checkouts_editor() {
        let parent = tempfile::tempdir().unwrap();
        let main = parent.path().join("Game");
        unity_project(&main);
        let git = |dir: &Path, args: &[&str]| {
            let ok = std::process::Command::new("git")
                .arg("-C")
                .arg(dir)
                .args(args)
                .status()
                .unwrap();
            assert!(ok.success());
        };
        git(&main, &["init", "-q", "-b", "main"]);
        git(
            &main,
            &[
                "-c",
                "user.name=T",
                "-c",
                "user.email=t@t",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "init",
            ],
        );
        let wt = parent.path().join("Game-task");
        git(
            &main,
            &["worktree", "add", "-q", "-b", "task", wt.to_str().unwrap()],
        );
        // A checkout has the tracked folders only, no Library.
        for dir in ["Assets", "ProjectSettings"] {
            std::fs::create_dir_all(wt.join(dir)).unwrap();
        }
        seed_worktree(&main, &main, &wt).unwrap();
        assert!(
            wt.join("Library/ScriptAssemblies/Game.dll").exists() || !wt.join("Library").exists()
        );
        assert!(!wt.join("Library/EditorInstance.json").exists());

        // Without a main checkout's file: asks to open the project once.
        std::fs::remove_file(main.join("Library/EditorInstance.json")).unwrap();
        let err = open_in_unity(&wt, &wt).unwrap_err();
        assert!(err.to_string().contains("once first"), "{err}");
        // With one: its Editor is the one used (refused here, being no Editor).
        std::fs::write(
            main.join("Library/EditorInstance.json"),
            r#"{"app_path":"/bin/sh"}"#,
        )
        .unwrap();
        let err = open_in_unity(&wt, &wt).unwrap_err();
        assert!(err.to_string().contains("not a Unity Editor"), "{err}");
    }
}
