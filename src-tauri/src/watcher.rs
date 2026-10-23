//! Watches open projects and tells the UI which directories changed.

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::Result;
use notify::event::{AccessKind, AccessMode, ModifyKind, RenameMode};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use serde::Serialize;

const DEBOUNCE: Duration = Duration::from_millis(200);
/// Above this many changed directories the UI just refreshes everything.
const MAX_DIRS: usize = 300;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsChange {
    pub root: String,
    /// Directories whose listing may have changed.
    pub dirs: Vec<String>,
    /// Files whose content may have changed (includes created/removed ones).
    pub files: Vec<String>,
    /// Paths that appeared (created, or renamed to).
    pub created: Vec<String>,
    /// Paths that disappeared (deleted, or renamed from).
    pub removed: Vec<String>,
    /// Too much changed for per-directory updates: the UI refreshes
    /// everything. `files`, `created` and `removed` then keep only what
    /// language servers reload on (see `keep_on_overflow`).
    pub overflow: bool,
    /// Events were dropped (the OS queue overflowed): even those lists are
    /// incomplete.
    pub lost: bool,
    /// Git metadata (index, HEAD, refs) changed. Edits in the working tree are
    /// only in `files`: the UI knows which of them git ignores.
    pub git: bool,
}

pub type ChangeSink = std::sync::Arc<dyn Fn(FsChange) + Send + Sync>;

struct Watch {
    /// Tells a watch apart from a later one of the same root.
    id: u64,
    /// `None` while it is being set up.
    watcher: Option<RecommendedWatcher>,
}

#[derive(Default)]
pub struct Watchers {
    active: Arc<Mutex<HashMap<String, Watch>>>,
    next: AtomicU64,
}

impl Watchers {
    /// Returns at once: watching recursively walks the whole tree (seconds for
    /// a large repository on Linux), which must not hold up the caller.
    pub fn watch(&self, root: &str, sink: ChangeSink) {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        {
            let mut active = self.active.lock();
            if active.contains_key(root) {
                return;
            }
            active.insert(root.to_string(), Watch { id, watcher: None });
        }
        let active = self.active.clone();
        let root = root.to_string();
        thread::spawn(move || {
            let watcher = start(&root, sink);
            let mut active = active.lock();
            match (active.get_mut(&root), watcher) {
                // Unwatched (and maybe watched again) meanwhile: drop this one.
                (Some(w), Ok(watcher)) if w.id == id => w.watcher = Some(watcher),
                (Some(w), Err(e)) if w.id == id => {
                    eprintln!("watching {root} failed: {e:#}");
                    active.remove(&root);
                }
                _ => {}
            }
        });
    }

    pub fn unwatch(&self, root: &str) {
        // Dropping the watcher closes the channel, which ends the debounce thread.
        self.active.lock().remove(root);
    }
}

fn start(root: &str, sink: ChangeSink) -> Result<RecommendedWatcher> {
    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(tx)?;
    watcher.watch(Path::new(root), RecursiveMode::Recursive)?;
    // A linked worktree (or a project inside a repository) keeps its git
    // metadata outside the root; commits made in a terminal show up there.
    let git_dirs = outside_git_dirs(Path::new(root));
    for dir in &git_dirs {
        // A worktree's own git dir is inside the common one.
        if !git_dirs.iter().any(|o| o != dir && dir.starts_with(o)) {
            let _ = watcher.watch(dir, RecursiveMode::Recursive);
        }
    }
    let root = root.to_string();
    thread::spawn(move || debounce_loop(root, git_dirs, rx, sink));
    Ok(watcher)
}

/// The repository's git dirs that are not `<root>/.git`, most specific
/// first: a linked worktree's own (its HEAD and index), then the common one,
/// where branches, tags and stashes are (`git branch` or `git fetch` in a
/// worktree's terminal write there).
fn outside_git_dirs(root: &Path) -> Vec<PathBuf> {
    let Ok(out) = crate::git::git_command()
        .arg("-C")
        .arg(root)
        .args(["rev-parse", "--absolute-git-dir", "--git-common-dir"])
        .output()
    else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    let inside = root.join(".git").canonicalize().ok();
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut seen = Vec::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        // The common dir is printed relative to the root when it is near.
        let dir = root.join(line.trim());
        let Ok(real) = dir.canonicalize() else {
            continue;
        };
        if Some(&real) == inside.as_ref() || seen.contains(&real) {
            continue;
        }
        seen.push(real.clone());
        // Relative ones resolved: event paths name the real directories.
        dirs.push(if Path::new(line.trim()).is_absolute() {
            dir
        } else {
            real
        });
    }
    dirs
}

fn debounce_loop(
    root: String,
    git_dirs: Vec<PathBuf>,
    rx: mpsc::Receiver<notify::Result<notify::Event>>,
    sink: ChangeSink,
) {
    let root_path = PathBuf::from(&root);
    loop {
        // Block for the first event, then gather everything within the window.
        let Ok(first) = rx.recv() else { return };
        let mut batch = vec![first];
        let deadline = Instant::now() + DEBOUNCE;
        while let Some(left) = deadline.checked_duration_since(Instant::now()) {
            match rx.recv_timeout(left) {
                Ok(ev) => batch.push(ev),
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
        let mut dirs = HashSet::new();
        let mut files = HashSet::new();
        let mut created = HashSet::new();
        let mut removed = HashSet::new();
        let mut git = false;
        let mut lost = false;
        for ev in batch {
            let Ok(ev) = ev else {
                lost = true;
                continue;
            };
            if ev.need_rescan() {
                lost = true;
            }
            if !changes_content(&ev.kind) {
                continue;
            }
            let n = ev.paths.len();
            for (i, p) in ev.paths.into_iter().enumerate() {
                let kind = match git_dirs.iter().find(|g| p.starts_with(g)) {
                    Some(g) => classify_git(p.strip_prefix(g).unwrap_or(&p)),
                    None => classify(&root_path, &p),
                };
                match kind {
                    Kind::Git => git = true,
                    Kind::GitInternal | Kind::Package => {}
                    Kind::Work => {
                        // Editing a file leaves its directory listing (and the
                        // Go to File index) as it was.
                        if changes_entries(&ev.kind) {
                            if let Some(parent) = p.parent() {
                                dirs.insert(parent.to_string_lossy().into_owned());
                            }
                        }
                        let key = p.to_string_lossy().into_owned();
                        match lifecycle(&ev.kind, i, n) {
                            Some(true) => {
                                removed.remove(&key);
                                created.insert(key.clone());
                            }
                            Some(false) => {
                                created.remove(&key);
                                removed.insert(key.clone());
                            }
                            None => {}
                        }
                        files.insert(key);
                    }
                }
            }
        }
        if files.is_empty() && !git && !lost {
            continue;
        }
        let overflow = lost || dirs.len() > MAX_DIRS;
        let keep = |set: HashSet<String>| -> Vec<String> {
            if overflow {
                set.into_iter().filter(|f| keep_on_overflow(f)).collect()
            } else {
                set.into_iter().collect()
            }
        };
        let change = FsChange {
            root: root.clone(),
            dirs: if overflow {
                vec![]
            } else {
                dirs.into_iter().collect()
            },
            created: keep(created),
            removed: keep(removed),
            files: keep(files),
            overflow,
            lost,
            git,
        };
        sink(change);
    }
}

/// Files language servers reload on (sources, project files, restore
/// output), still listed when a change is too large for anything else: a
/// checkout or a Unity reimport must not leave Roslyn on the old code.
fn keep_on_overflow(path: &str) -> bool {
    const EXTS: &[&str] = &[
        ".cs",
        ".csx",
        ".razor",
        ".cshtml",
        ".csproj",
        ".props",
        ".targets",
        ".sln",
        ".slnx",
        ".editorconfig",
    ];
    let lower = path.to_ascii_lowercase();
    let name = lower.rsplit(['/', '\\']).next().unwrap_or(&lower);
    EXTS.iter().any(|e| name.ends_with(e)) || name == "project.assets.json" || name == "global.json"
}

/// Reads (open, close-after-read) are reported too; reacting to them would
/// loop, since `git status` and our own file reads open files.
fn changes_content(kind: &EventKind) -> bool {
    match kind {
        EventKind::Access(AccessKind::Close(AccessMode::Write)) => true,
        EventKind::Access(_) => false,
        _ => true,
    }
}

/// Whether the event can add, remove or rename directory entries (anything
/// but a content or metadata change of an existing path).
fn changes_entries(kind: &EventKind) -> bool {
    match kind {
        EventKind::Access(_) | EventKind::Modify(ModifyKind::Data(_) | ModifyKind::Metadata(_)) => {
            false
        }
        // Windows reports content edits this way (adds, removals and renames have
        // their own kinds); kqueue uses it for a directory whose entries changed.
        EventKind::Modify(ModifyKind::Any) => !cfg!(windows),
        _ => true,
    }
}

/// `Some(true)` when the path appeared, `Some(false)` when it went away.
fn lifecycle(kind: &EventKind, index: usize, count: usize) -> Option<bool> {
    match kind {
        EventKind::Create(_) => Some(true),
        EventKind::Remove(_) => Some(false),
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => Some(false),
        EventKind::Modify(ModifyKind::Name(RenameMode::To)) => Some(true),
        // Both paths in one event: [from, to].
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) if count == 2 => Some(index == 1),
        _ => None,
    }
}

enum Kind {
    /// A change git status should reflect (index, HEAD, refs).
    Git,
    /// Other noise inside `.git` (objects, logs, lock files).
    GitInternal,
    /// Inside an installed package (`node_modules/<pkg>/…`), like VS Code's
    /// default watcher exclude: an install touches tens of thousands of files,
    /// and past `MAX_DIRS` the UI re-lists every directory, refreshes git and
    /// rereads every open file, again for each batch. Adding or removing a
    /// package (`node_modules/<pkg>`) still shows.
    Package,
    Work,
}

fn classify(root: &Path, p: &Path) -> Kind {
    let rel = p.strip_prefix(root).unwrap_or(p);
    let mut comps = rel.components();
    match comps.next() {
        Some(Component::Normal(first)) if first == ".git" => classify_git(comps.as_path()),
        _ if in_package(rel) => Kind::Package,
        _ => Kind::Work,
    }
}

fn in_package(rel: &Path) -> bool {
    let parts: Vec<_> = rel.components().collect();
    parts
        .iter()
        .position(|c| matches!(c, Component::Normal(n) if *n == "node_modules"))
        .is_some_and(|i| parts.len() > i + 2)
}

/// `rel` is relative to the git dir. Like Rider's GitRepositoryUpdater: the
/// UI reloads branches, stashes and checkpoints only for these, so each file
/// they are read from counts (`git remote` reads `config`, branch deletes and
/// `git pack-refs` rewrite `packed-refs`, the operation in progress is its
/// marker file or directory).
fn classify_git(rel: &Path) -> Kind {
    const FILES: &[&str] = &[
        "index",
        "HEAD",
        "config",
        "packed-refs",
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
    ];
    const DIRS: &[&str] = &["refs", "rebase-merge", "rebase-apply"];
    let mut comps = rel.components();
    let Some(Component::Normal(first)) = comps.next() else {
        return Kind::GitInternal;
    };
    let first = first.to_string_lossy();
    let top_file = comps.next().is_none() && FILES.contains(&first.as_ref());
    if top_file || DIRS.contains(&first.as_ref()) {
        Kind::Git
    } else {
        Kind::GitInternal
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_sources_on_overflow() {
        assert!(keep_on_overflow("/p/Assets/Player.cs"));
        assert!(keep_on_overflow(r"C:\p\Game.CSPROJ"));
        assert!(keep_on_overflow("/p/obj/project.assets.json"));
        assert!(!keep_on_overflow("/p/Library/Bee/tundra.json"));
        assert!(!keep_on_overflow("/p/Assets/Player.cs.meta"));
    }

    fn git(dir: &Path, args: &[&str]) {
        let ok = crate::git::git_command()
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=T", "-c", "user.email=t@t"])
            .args(args)
            .status()
            .unwrap()
            .success();
        assert!(ok, "{args:?}");
    }

    #[test]
    fn skips_files_inside_packages() {
        let root = Path::new("/r");
        let kind = |p: &str| classify(root, &root.join(p));
        assert!(matches!(kind("node_modules/react/index.js"), Kind::Package));
        assert!(matches!(
            kind("web/node_modules/@types/node/fs.d.ts"),
            Kind::Package
        ));
        assert!(matches!(kind("node_modules/react"), Kind::Work));
        assert!(matches!(
            kind("node_modules/.package-lock.json"),
            Kind::Work
        ));
        assert!(matches!(kind("src/node_modules.cs"), Kind::Work));
        assert!(matches!(kind("bin/Debug/App.dll"), Kind::Work));
    }

    #[test]
    fn only_entry_changes_relist_directories() {
        use notify::event::{CreateKind, DataChange, MetadataKind, RemoveKind};
        assert!(changes_entries(&EventKind::Create(CreateKind::File)));
        assert!(changes_entries(&EventKind::Remove(RemoveKind::Any)));
        assert!(changes_entries(&EventKind::Modify(ModifyKind::Name(
            RenameMode::Both
        ))));
        assert!(changes_entries(&EventKind::Any));
        assert!(!changes_entries(&EventKind::Modify(ModifyKind::Data(
            DataChange::Content
        ))));
        assert!(!changes_entries(&EventKind::Modify(ModifyKind::Metadata(
            MetadataKind::Any
        ))));
        assert!(!changes_entries(&EventKind::Access(AccessKind::Close(
            AccessMode::Write
        ))));
    }

    #[test]
    fn finds_git_dir_of_linked_worktrees() {
        let tmp = tempfile::tempdir().unwrap();
        let main = tmp.path().join("app");
        std::fs::create_dir(&main).unwrap();
        git(&main, &["init", "-q", "-b", "main"]);
        git(&main, &["commit", "-q", "--allow-empty", "-m", "init"]);
        let wt = tmp.path().join("app-task");
        git(
            &main,
            &["worktree", "add", "-q", "-b", "task", wt.to_str().unwrap()],
        );
        assert_eq!(outside_git_dirs(&main), Vec::<PathBuf>::new());
        assert_eq!(
            outside_git_dirs(&main.join("sub-not-there")),
            Vec::<PathBuf>::new()
        );
        // A project inside the repository: git prints the common dir relative to it.
        std::fs::create_dir_all(main.join("sub/deep")).unwrap();
        let in_sub = outside_git_dirs(&main.join("sub/deep"));
        assert_eq!(in_sub.len(), 1, "{in_sub:?}");
        let dirs = outside_git_dirs(&wt);
        assert_eq!(dirs.len(), 2, "{dirs:?}");
        assert!(dirs[0].ends_with("worktrees/app-task"), "{dirs:?}");
        // Branches made in the worktree are written to the common dir.
        assert_eq!(
            dirs[1].canonicalize().unwrap(),
            main.join(".git").canonicalize().unwrap()
        );
        assert!(matches!(classify_git(Path::new("index")), Kind::Git));
        assert!(matches!(
            classify_git(Path::new("refs/heads/task")),
            Kind::Git
        ));
        assert!(matches!(
            classify_git(Path::new("logs/HEAD")),
            Kind::GitInternal
        ));
        for git in [
            "packed-refs",
            "config",
            "rebase-merge/done",
            "CHERRY_PICK_HEAD",
        ] {
            assert!(matches!(classify_git(Path::new(git)), Kind::Git), "{git}");
        }
        for internal in ["objects/ab/cdef", "index.lock", "refsx", "FETCH_HEAD"] {
            assert!(
                matches!(classify_git(Path::new(internal)), Kind::GitInternal),
                "{internal}"
            );
        }
    }
}
