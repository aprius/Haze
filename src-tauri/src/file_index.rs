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

#[derive(Default)]
pub struct FileIndex {
    cache: Mutex<HashMap<String, Arc<Vec<String>>>>,
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

fn build(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    for entry in walker(root, false).build().flatten() {
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
    fn files(&self, root: &str) -> Arc<Vec<String>> {
        if let Some(f) = self.cache.lock().get(root) {
            return f.clone();
        }
        let files = Arc::new(build(Path::new(root)));
        self.cache.lock().insert(root.to_string(), files.clone());
        files
    }

    pub fn invalidate(&self, root: &str) {
        self.cache.lock().remove(root);
    }

    pub fn find(&self, root: &str, query: &str, limit: usize) -> Vec<FileHit> {
        let query = query.trim();
        if query.is_empty() {
            return Vec::new();
        }
        let files = self.files(root);
        rank(root, &files, query, limit)
    }
}

pub fn rank(root: &str, files: &[String], query: &str, limit: usize) -> Vec<FileHit> {
    let path_query = query.contains('/') || query.contains('\\');
    let query = query.replace('\\', "/");
    let pattern = Pattern::parse(&query, CaseMatching::Smart, Normalization::Smart);
    let mut matcher = Matcher::new(Config::DEFAULT.match_paths());
    let mut buf = Vec::new();
    let mut hits: Vec<(u32, &String, usize)> = Vec::new();
    for (i, rel) in files.iter().enumerate() {
        let name = rel.rsplit('/').next().unwrap_or(rel);
        // Prefer matches in the file name, like Rider's Go to File.
        let name_score = if path_query {
            None
        } else {
            pattern
                .score(Utf32Str::new(name, &mut buf), &mut matcher)
                .map(|s| s * 2 + 1000)
        };
        let score =
            name_score.or_else(|| pattern.score(Utf32Str::new(rel, &mut buf), &mut matcher));
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
    fn builds_from_disk_skipping_bin() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("bin")).unwrap();
        std::fs::write(dir.path().join("bin/x.cs"), "").unwrap();
        std::fs::write(dir.path().join("A.cs"), "").unwrap();
        let idx = FileIndex::default();
        let root = dir.path().to_string_lossy().into_owned();
        let hits = idx.find(&root, "cs", 10);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].rel, "A.cs");
    }
}
