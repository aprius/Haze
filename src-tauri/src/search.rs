//! Find in Files / Replace in Files.
//!
//! Files are walked with the `ignore` crate (ripgrep's walker), decoded with
//! the same code the editor uses (so UTF-16 and BOM files are searched
//! correctly) and matched with `fancy-regex` (lookaround and backreferences).
//! Replacing re-runs the search on the current file content and only touches
//! matches that are still where the preview showed them.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use globset::{Glob, GlobSet, GlobSetBuilder};
use ignore::{WalkBuilder, WalkState};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::fs_ops;
use crate::syntax;
use crate::text::{self, Decoded};

const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;
const PREVIEW_CHARS: usize = 240;

/// Directories skipped unless "include ignored" is on, like Rider's excluded folders.
pub const SKIPPED_DIRS: &[&str] = &[".git", "bin", "obj", "node_modules", ".vs", ".idea"];

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SearchContext {
    #[default]
    Anywhere,
    InComments,
    InStrings,
    ExceptComments,
    ExceptStrings,
    ExceptCommentsAndStrings,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    pub query: String,
    #[serde(default)]
    pub is_regex: bool,
    #[serde(default)]
    pub match_case: bool,
    #[serde(default)]
    pub whole_word: bool,
    #[serde(default)]
    pub context: SearchContext,
    pub replacement: Option<String>,
    #[serde(default)]
    pub preserve_case: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchScope {
    #[serde(default)]
    pub dirs: Vec<String>,
    #[serde(default)]
    pub files: Vec<String>,
    pub file_mask: Option<String>,
    #[serde(default)]
    pub include_ignored: bool,
    /// Unsaved editor content, searched instead of the file on disk.
    #[serde(default)]
    pub overrides: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Match {
    /// Byte offsets in the decoded text; used to address matches when replacing.
    pub start: usize,
    pub end: usize,
    /// 1-based line and UTF-16 column (Monaco positions).
    pub line: u32,
    pub column: u32,
    pub end_line: u32,
    pub end_column: u32,
    pub line_text: String,
    /// Highlight range within `line_text`, in UTF-16 units.
    pub preview_start: u32,
    pub preview_end: u32,
    pub replacement: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMatches {
    pub path: String,
    pub mtime: u64,
    /// Hash of the searched content, checked again before replacing.
    pub hash: String,
    pub from_buffer: bool,
    pub matches: Vec<Match>,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub files: Vec<FileMatches>,
    pub total_matches: usize,
    pub files_searched: usize,
    pub truncated: bool,
    pub cancelled: bool,
}

pub struct Compiled {
    regex: fancy_regex::Regex,
    query: SearchQuery,
}

pub fn compile(q: &SearchQuery) -> Result<Compiled> {
    if q.query.is_empty() {
        bail!("empty search");
    }
    let mut pat = if q.is_regex {
        q.query.clone()
    } else {
        fancy_regex::escape(&q.query).into_owned()
    };
    if q.whole_word {
        pat = format!(r"(?<!\w)(?:{pat})(?!\w)");
    }
    let mut flags = String::new();
    if !q.match_case {
        flags.push('i');
    }
    if q.is_regex {
        flags.push('m');
    }
    if !flags.is_empty() {
        pat = format!("(?{flags}){pat}");
    }
    let regex = fancy_regex::RegexBuilder::new(&pat)
        .backtrack_limit(1_000_000)
        .build()
        .map_err(|e| anyhow::anyhow!("invalid pattern: {e}"))?;
    Ok(Compiled {
        regex,
        query: q.clone(),
    })
}

/// Applies the case shape of `matched` to `replacement` (Rider's "Preserve case").
pub fn preserve_case(matched: &str, replacement: &str) -> String {
    let letters: Vec<char> = matched.chars().filter(|c| c.is_alphabetic()).collect();
    if letters.is_empty() {
        return replacement.to_string();
    }
    if letters.len() > 1 && letters.iter().all(|c| c.is_uppercase()) {
        return replacement.to_uppercase();
    }
    if letters.iter().all(|c| c.is_lowercase()) {
        return replacement.to_lowercase();
    }
    let mut chars = replacement.chars();
    match (letters[0].is_uppercase(), chars.next()) {
        (true, Some(first)) => first.to_uppercase().chain(chars).collect(),
        (false, Some(first)) => first.to_lowercase().chain(chars).collect(),
        _ => replacement.to_string(),
    }
}

struct Lines {
    starts: Vec<usize>,
}

impl Lines {
    fn new(text: &str) -> Self {
        let mut starts = vec![0];
        starts.extend(text.match_indices('\n').map(|(i, _)| i + 1));
        Self { starts }
    }

    /// (0-based line, line start offset)
    fn locate(&self, offset: usize) -> (usize, usize) {
        let line = self.starts.partition_point(|&s| s <= offset) - 1;
        (line, self.starts[line])
    }

    fn line_end(&self, text: &str, line: usize) -> usize {
        let end = self
            .starts
            .get(line + 1)
            .map(|&s| s - 1)
            .unwrap_or(text.len());
        if end > self.starts[line] && text.as_bytes()[end - 1] == b'\r' {
            end - 1
        } else {
            end
        }
    }
}

fn utf16_len(s: &str) -> u32 {
    s.encode_utf16().count() as u32
}

fn floor_char(s: &str, mut i: usize) -> usize {
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn ceil_char(s: &str, mut i: usize) -> usize {
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

fn context_ok(ctx: SearchContext, regions: &syntax::Regions, start: usize, end: usize) -> bool {
    let in_c = || syntax::inside(&regions.comments, start, end);
    let in_s = || syntax::inside(&regions.strings, start, end);
    match ctx {
        SearchContext::Anywhere => true,
        SearchContext::InComments => in_c(),
        SearchContext::InStrings => in_s(),
        SearchContext::ExceptComments => !in_c(),
        SearchContext::ExceptStrings => !in_s(),
        SearchContext::ExceptCommentsAndStrings => !in_c() && !in_s(),
    }
}

/// All matches in `text`, at most `limit`.
pub fn find_in_text(c: &Compiled, text: &str, path: &Path, limit: usize) -> Result<Vec<Match>> {
    let regions = if c.query.context == SearchContext::Anywhere {
        syntax::Regions::default()
    } else {
        syntax::regions(path, text)
    };
    let lines = Lines::new(text);
    let mut out = Vec::new();
    for caps in c.regex.captures_iter(text) {
        let caps = caps.map_err(|e| anyhow::anyhow!("search failed: {e}"))?;
        let m = caps.get(0).expect("group 0");
        if m.start() == m.end() || !context_ok(c.query.context, &regions, m.start(), m.end()) {
            continue;
        }
        let replacement = c.query.replacement.as_ref().map(|r| {
            let mut s = String::new();
            if c.query.is_regex {
                caps.expand(r, &mut s);
            } else {
                s.push_str(r);
            }
            if c.query.preserve_case {
                s = preserve_case(m.as_str(), &s);
            }
            s
        });

        let (line, line_start) = lines.locate(m.start());
        let (end_line, end_line_start) = lines.locate(m.end());
        let line_end = lines.line_end(text, line);
        // A window around the match keeps very long lines (minified files) readable.
        let from = floor_char(
            text,
            m.start().saturating_sub(PREVIEW_CHARS / 3).max(line_start),
        );
        let to = ceil_char(text, (m.start() + PREVIEW_CHARS).min(line_end).max(from));
        let line_text = &text[from..to];
        let hl_end = m.end().min(to);
        out.push(Match {
            start: m.start(),
            end: m.end(),
            line: line as u32 + 1,
            column: utf16_len(&text[line_start..m.start()]) + 1,
            end_line: end_line as u32 + 1,
            end_column: utf16_len(&text[end_line_start..m.end()]) + 1,
            line_text: line_text.to_string(),
            preview_start: utf16_len(&text[from..m.start()]),
            preview_end: utf16_len(&text[from..hl_end.max(m.start())]),
            replacement,
        });
        if out.len() >= limit {
            break;
        }
    }
    Ok(out)
}

/// Replaces the matches starting at `starts`; fails if any of them moved.
pub fn replace_in_text(
    c: &Compiled,
    text: &str,
    path: &Path,
    starts: &[usize],
) -> Result<(String, usize)> {
    let wanted: HashSet<usize> = starts.iter().copied().collect();
    let matches: Vec<Match> = find_in_text(c, text, path, usize::MAX)?
        .into_iter()
        .filter(|m| wanted.contains(&m.start))
        .collect();
    if matches.len() != wanted.len() {
        bail!("the matches changed since the search");
    }
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for m in &matches {
        out.push_str(&text[last..m.start]);
        out.push_str(m.replacement.as_deref().unwrap_or(""));
        last = m.end;
    }
    out.push_str(&text[last..]);
    Ok((out, matches.len()))
}

struct FileMask {
    include: Option<GlobSet>,
    exclude: Option<GlobSet>,
}

impl FileMask {
    fn parse(mask: Option<&str>) -> Result<Self> {
        let mut inc = GlobSetBuilder::new();
        let mut exc = GlobSetBuilder::new();
        let (mut has_inc, mut has_exc) = (false, false);
        for part in mask
            .unwrap_or("")
            .split([',', ';'])
            .map(str::trim)
            .filter(|p| !p.is_empty())
        {
            let (neg, pat) = match part.strip_prefix('!') {
                Some(p) => (true, p),
                None => (false, part),
            };
            let glob = Glob::new(pat).with_context(|| format!("bad file mask {pat:?}"))?;
            if neg {
                exc.add(glob);
                has_exc = true;
            } else {
                inc.add(glob);
                has_inc = true;
            }
        }
        Ok(Self {
            include: has_inc.then(|| inc.build()).transpose()?,
            exclude: has_exc.then(|| exc.build()).transpose()?,
        })
    }

    fn accepts(&self, path: &Path) -> bool {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let full = path.to_string_lossy().replace('\\', "/");
        let hit = |set: &GlobSet| set.is_match(&name) || set.is_match(&full);
        self.include.as_ref().is_none_or(hit) && !self.exclude.as_ref().is_some_and(hit)
    }
}

pub fn walker(dir: &Path, include_ignored: bool) -> WalkBuilder {
    let mut b = WalkBuilder::new(dir);
    b.hidden(false)
        .follow_links(false)
        .git_ignore(!include_ignored)
        .git_global(!include_ignored)
        .git_exclude(!include_ignored)
        .ignore(!include_ignored)
        .parents(!include_ignored)
        .filter_entry(move |e| {
            let is_dir = e.file_type().is_some_and(|t| t.is_dir());
            if !is_dir || e.depth() == 0 {
                return true;
            }
            let name = e.file_name().to_string_lossy();
            if name == ".git" {
                return false;
            }
            include_ignored || !SKIPPED_DIRS.contains(&name.as_ref())
        });
    b
}

pub fn content_hash(text: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut h);
    format!("{:016x}", h.finish())
}

pub fn read_text(path: &Path) -> Option<(String, Vec<u8>, text::TextEncoding, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() > MAX_FILE_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    match text::decode(&bytes) {
        Decoded::Text {
            content, encoding, ..
        } => Some((content, bytes, encoding, fs_ops::mtime_ms(&meta))),
        Decoded::Binary => None,
    }
}

/// Searches `scope`. Stops early when `current` no longer equals `generation`
/// (a newer search started) or after `max_matches`.
pub fn search(
    q: &SearchQuery,
    scope: &SearchScope,
    generation: u64,
    current: &AtomicU64,
    max_matches: usize,
) -> Result<SearchResults> {
    let compiled = Arc::new(compile(q)?);
    let mask = Arc::new(FileMask::parse(scope.file_mask.as_deref())?);
    let results = Mutex::new(Vec::<FileMatches>::new());
    let total = AtomicUsize::new(0);
    let searched = AtomicUsize::new(0);
    let truncated = AtomicBool::new(false);
    let cancelled = AtomicBool::new(false);
    let seen = Mutex::new(HashSet::<PathBuf>::new());
    let first_error = Mutex::new(None::<String>);

    let process = |path: &Path| -> WalkState {
        if current.load(Ordering::Relaxed) != generation {
            cancelled.store(true, Ordering::Relaxed);
            return WalkState::Quit;
        }
        if total.load(Ordering::Relaxed) >= max_matches {
            truncated.store(true, Ordering::Relaxed);
            return WalkState::Quit;
        }
        if !mask.accepts(path) || !seen.lock().insert(path.to_path_buf()) {
            return WalkState::Continue;
        }
        let key = path.to_string_lossy().into_owned();
        let (content, mtime, from_buffer) = match scope.overrides.get(&key) {
            Some(c) => (c.clone(), 0, true),
            None => match read_text(path) {
                Some((c, _, _, m)) => (c, m, false),
                None => return WalkState::Continue,
            },
        };
        searched.fetch_add(1, Ordering::Relaxed);
        let budget = max_matches
            .saturating_sub(total.load(Ordering::Relaxed))
            .max(1);
        match find_in_text(&compiled, &content, path, budget) {
            Ok(matches) if !matches.is_empty() => {
                total.fetch_add(matches.len(), Ordering::Relaxed);
                results.lock().push(FileMatches {
                    path: key,
                    mtime,
                    hash: content_hash(&content),
                    from_buffer,
                    matches,
                });
            }
            Ok(_) => {}
            Err(e) => {
                first_error
                    .lock()
                    .get_or_insert(format!("{}: {e:#}", path.display()));
            }
        }
        WalkState::Continue
    };

    for file in &scope.files {
        if let WalkState::Quit = process(Path::new(file)) {
            break;
        }
    }
    for dir in &scope.dirs {
        if cancelled.load(Ordering::Relaxed) || truncated.load(Ordering::Relaxed) {
            break;
        }
        walker(Path::new(dir), scope.include_ignored)
            .build_parallel()
            .run(|| {
                Box::new(|entry| {
                    let Ok(entry) = entry else {
                        return WalkState::Continue;
                    };
                    if !entry.file_type().is_some_and(|t| t.is_file()) {
                        return WalkState::Continue;
                    }
                    process(entry.path())
                })
            });
    }

    let mut files = results.into_inner();
    files.sort_by(|a, b| a.path.cmp(&b.path));
    if files.is_empty() {
        if let Some(e) = first_error.into_inner() {
            bail!(e);
        }
    }
    Ok(SearchResults {
        total_matches: files.iter().map(|f| f.matches.len()).sum(),
        files,
        files_searched: searched.into_inner(),
        truncated: truncated.into_inner(),
        cancelled: cancelled.into_inner(),
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceTarget {
    pub path: String,
    pub hash: String,
    pub starts: Vec<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplacedFile {
    pub path: String,
    pub count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skipped {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceOutcome {
    pub replaced: Vec<ReplacedFile>,
    pub skipped: Vec<Skipped>,
    pub undo_id: Option<u64>,
}

struct UndoEntry {
    path: PathBuf,
    original: Vec<u8>,
    written_mtime: u64,
}

/// Original bytes of replaced files, so a whole Replace All can be undone.
#[derive(Default)]
pub struct ReplaceHistory {
    next: AtomicU64,
    batches: Mutex<HashMap<u64, Vec<UndoEntry>>>,
}

pub fn replace_in_files(
    q: &SearchQuery,
    targets: &[ReplaceTarget],
    history: &ReplaceHistory,
) -> Result<ReplaceOutcome> {
    if q.replacement.is_none() {
        bail!("no replacement given");
    }
    let compiled = compile(q)?;
    let mut replaced = Vec::new();
    let mut skipped = Vec::new();
    let mut undo = Vec::new();
    for t in targets {
        let path = Path::new(&t.path);
        let skip = |reason: &str| Skipped {
            path: t.path.clone(),
            reason: reason.into(),
        };
        let Some((content, original, encoding, mtime)) = read_text(path) else {
            skipped.push(skip("file is missing or not text"));
            continue;
        };
        if content_hash(&content) != t.hash {
            skipped.push(skip("file changed since the search"));
            continue;
        }
        let (new_text, count) = match replace_in_text(&compiled, &content, path, &t.starts) {
            Ok(r) => r,
            Err(e) => {
                skipped.push(skip(&format!("{e:#}")));
                continue;
            }
        };
        match fs_ops::write_file(path, &new_text, encoding, Some(mtime)) {
            Ok(fs_ops::WriteResult::Saved { mtime: written }) => {
                replaced.push(ReplacedFile {
                    path: t.path.clone(),
                    count,
                });
                undo.push(UndoEntry {
                    path: path.to_path_buf(),
                    original,
                    written_mtime: written,
                });
            }
            Ok(fs_ops::WriteResult::Conflict { .. }) => {
                skipped.push(skip("file changed while replacing"))
            }
            Err(e) => skipped.push(skip(&format!("{e:#}"))),
        }
    }
    let undo_id = (!undo.is_empty()).then(|| {
        let id = history.next.fetch_add(1, Ordering::Relaxed) + 1;
        history.batches.lock().insert(id, undo);
        id
    });
    Ok(ReplaceOutcome {
        replaced,
        skipped,
        undo_id,
    })
}

/// Restores files of a replace batch that were not modified afterwards.
pub fn undo_replace(history: &ReplaceHistory, id: u64) -> Result<Vec<Skipped>> {
    let batch = history
        .batches
        .lock()
        .remove(&id)
        .context("nothing to undo")?;
    let mut skipped = Vec::new();
    for e in batch {
        let current = std::fs::metadata(&e.path)
            .map(|m| fs_ops::mtime_ms(&m))
            .ok();
        if current != Some(e.written_mtime) {
            skipped.push(Skipped {
                path: e.path.to_string_lossy().into_owned(),
                reason: "file changed after the replace".into(),
            });
            continue;
        }
        let existing = std::fs::metadata(&e.path).ok();
        if let Err(err) = fs_ops::atomic_write(&e.path, &e.original, existing.as_ref()) {
            skipped.push(Skipped {
                path: e.path.to_string_lossy().into_owned(),
                reason: format!("{err:#}"),
            });
        }
    }
    Ok(skipped)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(query: &str) -> SearchQuery {
        SearchQuery {
            query: query.into(),
            is_regex: false,
            match_case: false,
            whole_word: false,
            context: SearchContext::Anywhere,
            replacement: None,
            preserve_case: false,
        }
    }

    fn find(q: &SearchQuery, text: &str) -> Vec<Match> {
        find_in_text(&compile(q).unwrap(), text, Path::new("A.cs"), usize::MAX).unwrap()
    }

    #[test]
    fn literal_case_and_words() {
        let text = "order Order orders";
        assert_eq!(find(&q("order"), text).len(), 3);
        assert_eq!(
            find(
                &SearchQuery {
                    match_case: true,
                    ..q("order")
                },
                text
            )
            .len(),
            2
        );
        assert_eq!(
            find(
                &SearchQuery {
                    whole_word: true,
                    ..q("order")
                },
                text
            )
            .len(),
            2
        );
        assert_eq!(find(&q("a.b"), "a.b axb").len(), 1);
    }

    #[test]
    fn regex_with_lookaround_and_groups() {
        let rq = SearchQuery {
            is_regex: true,
            replacement: Some("${name}Async(".into()),
            ..q(r"(?<name>\w+)(?=\()\(")
        };
        let m = find(&rq, "var x = Get(1);");
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].replacement.as_deref(), Some("GetAsync("));
    }

    #[test]
    fn positions_are_utf16_and_crlf_aware() {
        let text = "line1\r\nxin chào Order\r\n";
        let m = &find(&q("Order"), text)[0];
        assert_eq!((m.line, m.column, m.end_column), (2, 10, 15));
        assert_eq!(m.line_text, "xin chào Order");
        assert_eq!((m.preview_start, m.preview_end), (9, 14));
    }

    #[test]
    fn context_filters() {
        let text = "// Order\nvar s = \"Order\"; Order();";
        let count = |ctx| {
            find(
                &SearchQuery {
                    context: ctx,
                    ..q("Order")
                },
                text,
            )
            .len()
        };
        assert_eq!(count(SearchContext::InComments), 1);
        assert_eq!(count(SearchContext::InStrings), 1);
        assert_eq!(count(SearchContext::ExceptCommentsAndStrings), 1);
        assert_eq!(count(SearchContext::ExceptComments), 2);
    }

    #[test]
    fn preserve_case_shapes() {
        assert_eq!(preserve_case("order", "customer"), "customer");
        assert_eq!(preserve_case("Order", "customer"), "Customer");
        assert_eq!(preserve_case("ORDER", "customer"), "CUSTOMER");
        assert_eq!(preserve_case("orderId", "customerId"), "customerId");
    }

    #[test]
    fn file_mask() {
        let m = FileMask::parse(Some("*.cs, !*.Designer.cs")).unwrap();
        assert!(m.accepts(Path::new("/a/B.cs")));
        assert!(!m.accepts(Path::new("/a/B.Designer.cs")));
        assert!(!m.accepts(Path::new("/a/B.json")));
        assert!(FileMask::parse(None).unwrap().accepts(Path::new("x")));
    }

    #[test]
    fn search_replace_and_undo_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("bin")).unwrap();
        let a = root.join("src/A.cs");
        let original = b"\xEF\xBB\xBFclass Order {}\r\n// Order\r\n".to_vec();
        std::fs::write(&a, &original).unwrap();
        std::fs::write(root.join("bin/A.cs"), "class Order {}").unwrap();

        let query = SearchQuery {
            replacement: Some("Customer".into()),
            ..q("Order")
        };
        let scope = SearchScope {
            dirs: vec![root.to_string_lossy().into()],
            ..Default::default()
        };
        let gen = AtomicU64::new(1);
        let res = search(&query, &scope, 1, &gen, 1000).unwrap();
        assert_eq!(res.files.len(), 1, "bin/ is skipped");
        let f = &res.files[0];
        assert_eq!(f.matches.len(), 2);

        // Replace only the first match (the class name), as if the second was unticked.
        let history = ReplaceHistory::default();
        let out = replace_in_files(
            &query,
            &[ReplaceTarget {
                path: f.path.clone(),
                hash: f.hash.clone(),
                starts: vec![f.matches[0].start],
            }],
            &history,
        )
        .unwrap();
        assert_eq!(out.replaced.len(), 1);
        assert_eq!(
            std::fs::read(&a).unwrap(),
            b"\xEF\xBB\xBFclass Customer {}\r\n// Order\r\n"
        );

        // A stale target (content changed since the search) is refused.
        let again = replace_in_files(
            &query,
            &[ReplaceTarget {
                path: f.path.clone(),
                hash: f.hash.clone(),
                starts: vec![f.matches[1].start],
            }],
            &history,
        )
        .unwrap();
        assert_eq!(again.replaced.len(), 0);
        assert_eq!(again.skipped.len(), 1);

        assert!(undo_replace(&history, out.undo_id.unwrap())
            .unwrap()
            .is_empty());
        assert_eq!(std::fs::read(&a).unwrap(), original);
    }

    #[test]
    fn cancelled_by_newer_generation() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "x").unwrap();
        let scope = SearchScope {
            dirs: vec![dir.path().to_string_lossy().into()],
            ..Default::default()
        };
        let gen = AtomicU64::new(2);
        let res = search(&q("x"), &scope, 1, &gen, 10).unwrap();
        assert!(res.cancelled);
    }
}
