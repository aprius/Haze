//! Watches open projects and tells the UI which directories changed.

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc;
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
    pub overflow: bool,
    /// Git metadata (index, HEAD, refs) changed.
    pub git: bool,
}

pub type ChangeSink = std::sync::Arc<dyn Fn(FsChange) + Send + Sync>;

#[derive(Default)]
pub struct Watchers {
    active: Mutex<HashMap<String, RecommendedWatcher>>,
}

impl Watchers {
    pub fn watch(&self, root: &str, sink: ChangeSink) -> Result<()> {
        let mut active = self.active.lock();
        if active.contains_key(root) {
            return Ok(());
        }
        let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
        let mut watcher = notify::recommended_watcher(tx)?;
        watcher.watch(Path::new(root), RecursiveMode::Recursive)?;
        let root_owned = root.to_string();
        thread::spawn(move || debounce_loop(root_owned, rx, sink));
        active.insert(root.to_string(), watcher);
        Ok(())
    }

    pub fn unwatch(&self, root: &str) {
        // Dropping the watcher closes the channel, which ends the debounce thread.
        self.active.lock().remove(root);
    }
}

fn debounce_loop(
    root: String,
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
        let mut overflow = false;
        for ev in batch {
            let Ok(ev) = ev else {
                overflow = true;
                continue;
            };
            if ev.need_rescan() {
                overflow = true;
            }
            if !changes_content(&ev.kind) {
                continue;
            }
            let n = ev.paths.len();
            for (i, p) in ev.paths.into_iter().enumerate() {
                match classify(&root_path, &p) {
                    Kind::Git => git = true,
                    Kind::GitInternal => {}
                    Kind::Work => {
                        if let Some(parent) = p.parent() {
                            dirs.insert(parent.to_string_lossy().into_owned());
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
        if dirs.is_empty() && !git && !overflow {
            continue;
        }
        overflow |= dirs.len() > MAX_DIRS;
        // Working tree edits change `git status` too.
        let git = git || overflow || !dirs.is_empty();
        let change = FsChange {
            root: root.clone(),
            dirs: if overflow {
                vec![]
            } else {
                dirs.into_iter().collect()
            },
            created: if overflow {
                vec![]
            } else {
                created.into_iter().collect()
            },
            removed: if overflow {
                vec![]
            } else {
                removed.into_iter().collect()
            },
            files: if overflow {
                vec![]
            } else {
                files.into_iter().collect()
            },
            overflow,
            git,
        };
        sink(change);
    }
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
    Work,
}

fn classify(root: &Path, p: &Path) -> Kind {
    let rel = p.strip_prefix(root).unwrap_or(p);
    let mut comps = rel.components();
    match comps.next() {
        Some(Component::Normal(first)) if first == ".git" => {
            let rest: PathBuf = comps.collect();
            let s = rest.to_string_lossy();
            if s == "index" || s == "HEAD" || s.starts_with("refs") || s == "MERGE_HEAD" {
                Kind::Git
            } else {
                Kind::GitInternal
            }
        }
        _ => Kind::Work,
    }
}
