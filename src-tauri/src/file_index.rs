//! File list per project for "Go to File" / Search Everywhere, fuzzy-matched
//! with nucleo (the matcher behind Helix). The list is rebuilt lazily after
//! the watcher reports structural changes.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};
use parking_lot::Mutex;
use serde::Serialize;

use crate::search::walker;

const MAX_FILES: usize = 300_000;

/// Root, and whether ignored files (bin/, .gitignore'd, …) are in.
type CacheKey = (String, bool);

#[derive(Default)]
pub struct FileIndex {
    cache: Mutex<HashMap<CacheKey, Arc<Vec<String>>>>,
    /// Bumped per root by `invalidate`: a list whose walk started before
    /// then may miss the change and is not cached.
    generations: Mutex<HashMap<String, u64>>,
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

fn build(root: &Path, include_ignored: bool) -> Vec<String> {
    let mut out = Vec::new();
    for entry in walker(root, include_ignored).build().flatten() {
        if !entry.file_type().is_some_and(|t| t.is_file()) {
            continue;
        }
        if let Ok(rel) = entry.path().strip_prefix(root) {
            out.push(rel.to_string_lossy().replace('\\', "/"));
        }
        if out.len() >= MAX_FILES {
            break;
        }
    }
    out
}

impl FileIndex {
    fn files(&self, root: &str, include_ignored: bool) -> Arc<Vec<String>> {
        let key = (root.to_string(), include_ignored);
        if let Some(f) = self.cache.lock().get(&key) {
            return f.clone();
        }
        let gate = self.building.lock().entry(key.clone()).or_default().clone();
        let _building = gate.lock();
        // Built by the query this one waited for.
        if let Some(f) = self.cache.lock().get(&key) {
            return f.clone();
        }
        let generation = self.generation(root);
        let files = Arc::new(build(Path::new(root), include_ignored));
        if self.generation(root) == generation {
            self.cache.lock().insert(key, files.clone());
        }
        files
    }

    fn generation(&self, root: &str) -> u64 {
        self.generations.lock().get(root).copied().unwrap_or(0)
    }

    pub fn invalidate(&self, root: &str) {
        *self.generations.lock().entry(root.to_string()).or_default() += 1;
        let mut cache = self.cache.lock();
        cache.remove(&(root.to_string(), false));
        cache.remove(&(root.to_string(), true));
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
}
