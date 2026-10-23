//! File list per project for "Go to File" / Search Everywhere, fuzzy-matched
//! with nucleo (the matcher behind Helix). The list is rebuilt lazily after
//! the watcher reports structural changes in the directories it lists.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};
use parking_lot::Mutex;
use serde::Serialize;

use crate::search::walker;
use crate::watcher::FsChange;

const MAX_FILES: usize = 300_000;

/// Root, and whether ignored files (bin/, .gitignore'd, …) are in.
type CacheKey = (String, bool);

struct Listing {
    files: Arc<Vec<String>>,
    /// Directories the walk went into, relative and `/`-separated (`""` is
    /// the root). Changes elsewhere (Unity's `Library/`, `bin/`, `obj/`)
    /// cannot change the list.
    dirs: HashSet<String>,
}

/// Directories changed while a walk runs, checked before its list is kept.
enum Missed {
    Dirs(Vec<String>),
    All,
}

#[derive(Default)]
struct State {
    lists: HashMap<CacheKey, Listing>,
    walking: HashMap<CacheKey, Missed>,
}

#[derive(Default)]
pub struct FileIndex {
    state: Mutex<State>,
    /// One walk per key at a time: each keystroke of Go to File asks, and
    /// on a cold index every one of them walked the whole tree.
    building: Mutex<HashMap<CacheKey, Arc<Mutex<()>>>>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileHit {
    pub path: String,
    /// Path relative to the root, `/`-separated.
    pub rel: String,
    pub score: u32,
    /// Matched character positions in the file name (empty when the match was in the directory part).
    pub name_indices: Vec<u32>,
}

fn rel_of(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    Some(rel.to_string_lossy().replace('\\', "/"))
}

fn build(root: &Path, include_ignored: bool) -> Listing {
    let mut files = Vec::new();
    let mut dirs = HashSet::new();
    for entry in walker(root, include_ignored).build().flatten() {
        let Some(t) = entry.file_type() else { continue };
        let Some(rel) = rel_of(root, entry.path()) else {
            continue;
        };
        if t.is_dir() {
            dirs.insert(rel);
        } else if t.is_file() {
            files.push(rel);
            if files.len() >= MAX_FILES {
                break;
            }
        }
    }
    Listing {
        files: Arc::new(files),
        dirs,
    }
}

/// Whether a change in `dir` (absolute) can change `listing`. Paths the
/// root does not prefix count, to be safe.
fn affects(root: &Path, listing: &Listing, dir: &str) -> bool {
    rel_of(root, Path::new(dir)).is_none_or(|rel| listing.dirs.contains(&rel))
}

/// Edits to these change what the walk skips, without changing a listing.
fn is_ignore_file(path: &str) -> bool {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    name == ".gitignore" || name == ".ignore"
}

impl FileIndex {
    fn files(&self, root: &str, include_ignored: bool) -> Arc<Vec<String>> {
        let key = (root.to_string(), include_ignored);
        if let Some(l) = self.state.lock().lists.get(&key) {
            return l.files.clone();
        }
        let gate = self.building.lock().entry(key.clone()).or_default().clone();
        let _building = gate.lock();
        // Built by the query this one waited for.
        {
            let mut state = self.state.lock();
            if let Some(l) = state.lists.get(&key) {
                return l.files.clone();
            }
            state.walking.insert(key.clone(), Missed::Dirs(Vec::new()));
        }
        let root_path = Path::new(root);
        let listing = build(root_path, include_ignored);
        let files = listing.files.clone();
        let mut state = self.state.lock();
        // A change during the walk may have come after it passed that directory.
        let stale = match state.walking.remove(&key) {
            Some(Missed::Dirs(dirs)) => dirs.iter().any(|d| affects(root_path, &listing, d)),
            Some(Missed::All) | None => true,
        };
        if !stale {
            state.lists.insert(key, listing);
        }
        files
    }

    /// Drops the lists `change` can make out of date.
    pub fn changed(&self, change: &FsChange) {
        let all = change.overflow || change.files.iter().any(|f| is_ignore_file(f));
        if !all && change.dirs.is_empty() {
            return;
        }
        let root = Path::new(&change.root);
        let mut state = self.state.lock();
        for include_ignored in [false, true] {
            let key = (change.root.clone(), include_ignored);
            // The list with ignored files has every directory in it.
            let all = all || include_ignored;
            if let Some(l) = state.lists.get(&key) {
                if all || change.dirs.iter().any(|d| affects(root, l, d)) {
                    state.lists.remove(&key);
                }
            }
            match state.walking.get_mut(&key) {
                Some(missed) if all => *missed = Missed::All,
                Some(Missed::Dirs(dirs)) => dirs.extend(change.dirs.iter().cloned()),
                _ => {}
            }
        }
    }

    pub fn find(
        &self,
        root: &str,
        query: &str,
        limit: usize,
        include_ignored: bool,
    ) -> Vec<FileHit> {
        let query = query.trim();
        if query.is_empty() {
            return Vec::new();
        }
        let files = self.files(root, include_ignored);
        rank(root, &files, query, limit)
    }
}

/// Scripts first, then text assets, then everything else (textures, models, …).
const SCRIPTS: &[&str] = &[
    "cs", "shader", "hlsl", "cginc", "compute", "ts", "tsx", "js", "jsx", "rs", "py", "go", "java",
    "kt", "swift", "c", "cc", "cpp", "h", "hpp", "m", "mm", "lua", "sh",
];
const TEXT_ASSETS: &[&str] = &[
    "json", "txt", "md", "xml", "yaml", "yml", "csv", "toml", "ini", "uxml", "uss", "asmdef",
    "asmref", "html", "css", "csproj", "sln", "props", "targets", "config", "bytes",
];

fn kind_bonus(name: &str) -> u32 {
    let ext = name
        .rsplit_once('.')
        .map_or("", |(_, e)| e)
        .to_ascii_lowercase();
    if SCRIPTS.contains(&ext.as_str()) {
        40
    } else if TEXT_ASSETS.contains(&ext.as_str()) {
        20
    } else {
        0
    }
}

pub fn rank(root: &str, files: &[String], query: &str, limit: usize) -> Vec<FileHit> {
    let path_query = query.contains('/') || query.contains('\\');
    // Unity's `.meta` sidecars (one per folder too) only when asked for.
    let want_meta = query.to_ascii_lowercase().contains(".meta");
    let query = query.replace('\\', "/");
    let pattern = Pattern::parse(&query, CaseMatching::Smart, Normalization::Smart);
    let mut matcher = Matcher::new(Config::DEFAULT.match_paths());
    let mut buf = Vec::new();
    let mut hits: Vec<(u32, &String, usize)> = Vec::new();
    for (i, rel) in files.iter().enumerate() {
        let name = rel.rsplit('/').next().unwrap_or(rel);
        if !want_meta && name.ends_with(".meta") {
            continue;
        }
        // Go to File matches the file name only, unless the query has a
        // `/` — a folder's name alone doesn't list everything inside it.
        let score = if path_query {
            pattern.score(Utf32Str::new(rel, &mut buf), &mut matcher)
        } else {
            pattern.score(Utf32Str::new(name, &mut buf), &mut matcher)
        }
        .map(|s| s + kind_bonus(name));
        if let Some(s) = score {
            hits.push((s, rel, i));
        }
    }
    // Ties: shorter file name first (`Orders.cs` before `OrdersTests.cs`), then shorter path.
    let name_len = |rel: &str| rel.rsplit('/').next().map_or(rel.len(), str::len);
    hits.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then(name_len(a.1).cmp(&name_len(b.1)))
            .then(a.1.len().cmp(&b.1.len()))
            .then(a.1.cmp(b.1))
    });
    hits.truncate(limit);
    let sep = if root.contains('\\') && !root.contains('/') {
        "\\"
    } else {
        "/"
    };
    hits.into_iter()
        .map(|(score, rel, _)| {
            let name = rel.rsplit('/').next().unwrap_or(rel);
            let mut indices = Vec::new();
            if !path_query {
                pattern.indices(Utf32Str::new(name, &mut buf), &mut matcher, &mut indices);
                indices.sort_unstable();
                indices.dedup();
            }
            let native_rel = if sep == "/" {
                rel.clone()
            } else {
                rel.replace('/', sep)
            };
            let path = format!(
                "{}{}{}",
                root.trim_end_matches(['/', '\\']),
                sep,
                native_rel
            );
            FileHit {
                path,
                rel: rel.clone(),
                score,
                name_indices: indices,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranks_file_names_first() {
        let files: Vec<String> = [
            "ShopApi/Controllers/OrdersController.cs",
            "ShopApi/Orders/Readme.md",
            "ShopApi/Program.cs",
            "tests/OrdersControllerTests.cs",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let hits = rank("/r", &files, "ordcon", 10);
        assert_eq!(hits[0].rel, "ShopApi/Controllers/OrdersController.cs");
        assert_eq!(hits[0].path, "/r/ShopApi/Controllers/OrdersController.cs");
        assert_eq!(hits[1].rel, "tests/OrdersControllerTests.cs");
        assert!(!hits[0].name_indices.is_empty());
        let by_path = rank("/r", &files, "orders/read", 10);
        assert_eq!(by_path[0].rel, "ShopApi/Orders/Readme.md");
    }

    #[test]
    fn scripts_first_without_meta_or_folder_matches() {
        let files: Vec<String> = [
            "Assets/Player.meta",
            "Assets/Player/Idle.png",
            "Assets/Player/Player.png",
            "Assets/Player/Player.json",
            "Assets/Player/Player.cs",
            "Assets/Player/Player.cs.meta",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let rels: Vec<_> = rank("/r", &files, "player", 10)
            .into_iter()
            .map(|h| h.rel)
            .collect();
        assert_eq!(
            rels,
            [
                "Assets/Player/Player.cs",
                "Assets/Player/Player.json",
                "Assets/Player/Player.png"
            ]
        );
        assert_eq!(
            rank("/r", &files, "player.meta", 10)[0].rel,
            "Assets/Player.meta"
        );
    }

    #[test]
    fn builds_from_disk_skipping_bin() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("bin")).unwrap();
        std::fs::write(dir.path().join("bin/x.cs"), "").unwrap();
        std::fs::write(dir.path().join("A.cs"), "").unwrap();
        let idx = FileIndex::default();
        let root = dir.path().to_string_lossy().into_owned();
        let hits = idx.find(&root, "cs", 10, false);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].rel, "A.cs");
        assert_eq!(idx.find(&root, "cs", 10, true).len(), 2);
    }

    fn change(root: &Path, dirs: &[&Path], files: &[&Path]) -> FsChange {
        let s = |p: &&Path| p.to_string_lossy().into_owned();
        FsChange {
            root: root.to_string_lossy().into_owned(),
            dirs: dirs.iter().map(s).collect(),
            files: files.iter().map(s).collect(),
            created: vec![],
            removed: vec![],
            overflow: false,
            lost: false,
            git: false,
        }
    }

    #[test]
    fn only_changes_in_listed_directories_rebuild() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let (src, lib) = (root.join("src"), root.join("Library"));
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(lib.join("Bee")).unwrap();
        std::fs::write(root.join(".ignore"), "Library/\n").unwrap();
        std::fs::write(src.join("A.cs"), "").unwrap();
        let idx = FileIndex::default();
        let r = root.to_string_lossy().into_owned();
        let names = |idx: &FileIndex| -> Vec<String> {
            idx.find(&r, "cs", 10, false)
                .into_iter()
                .map(|h| h.rel)
                .collect()
        };
        assert_eq!(names(&idx), ["src/A.cs"]);

        // Unity writing its cache leaves the list as it was.
        std::fs::write(lib.join("Bee/x.cs"), "").unwrap();
        std::fs::write(src.join("B.cs"), "").unwrap();
        idx.changed(&change(root, &[&lib.join("Bee")], &[&lib.join("Bee/x.cs")]));
        assert_eq!(names(&idx), ["src/A.cs"]);

        // A listed directory changing rebuilds it.
        idx.changed(&change(root, &[&src], &[&src.join("B.cs")]));
        assert_eq!(names(&idx), ["src/A.cs", "src/B.cs"]);

        // So does a change to what is ignored.
        std::fs::write(root.join(".ignore"), "").unwrap();
        idx.changed(&change(root, &[], &[&root.join(".ignore")]));
        assert_eq!(names(&idx).len(), 3);
    }
}
