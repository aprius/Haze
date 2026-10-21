//! File system commands used by the file tree and the editor.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use anyhow::{bail, Context, Result};
use serde::Serialize;

use crate::nesting;
use crate::text::{self, Decoded, Eol, TextEncoding};

/// Files larger than this are not opened in the editor.
const MAX_EDITOR_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    /// Name of the sibling file this one is nested under (Rider-style nesting).
    pub nested_under: Option<String>,
}

pub fn list_dir(path: &Path, nest: bool) -> Result<Vec<DirEntry>> {
    let mut entries = Vec::new();
    for e in fs::read_dir(path).with_context(|| format!("reading {}", path.display()))? {
        let Ok(e) = e else { continue };
        let name = e.file_name().to_string_lossy().into_owned();
        if name == ".git" {
            continue;
        }
        let ft = match e.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        let is_symlink = ft.is_symlink();
        // Symlinked directories are listed but never followed into by the tree.
        let is_dir = if is_symlink {
            e.path().is_dir()
        } else {
            ft.is_dir()
        };
        entries.push(DirEntry {
            name,
            path: e.path().to_string_lossy().into_owned(),
            is_dir,
            is_symlink,
            nested_under: None,
        });
    }
    if nest {
        let files: Vec<&str> = entries
            .iter()
            .filter(|e| !e.is_dir)
            .map(|e| e.name.as_str())
            .collect();
        let map = nesting::compute(&files);
        for e in &mut entries {
            e.nested_under = map.get(&e.name).cloned();
        }
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| natural_cmp(&a.name.to_lowercase(), &b.name.to_lowercase()))
    });
    Ok(entries)
}

/// Compares runs of digits numerically, so `File2` sorts before `File10`.
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let (mut a, mut b) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (a.peek().copied(), b.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, _) => return Ordering::Less,
            (_, None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let take = |it: &mut std::iter::Peekable<std::str::Chars>| {
                    let mut s = String::new();
                    while let Some(c) = it.peek().copied().filter(char::is_ascii_digit) {
                        s.push(c);
                        it.next();
                    }
                    s
                };
                let (na, nb) = (take(&mut a), take(&mut b));
                let (ta, tb) = (na.trim_start_matches('0'), nb.trim_start_matches('0'));
                let ord = ta.len().cmp(&tb.len()).then_with(|| ta.cmp(tb));
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            (Some(x), Some(y)) => {
                if x != y {
                    return x.cmp(&y);
                }
                a.next();
                b.next();
            }
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum FileContent {
    Text {
        content: String,
        encoding: TextEncoding,
        eol: Eol,
        mtime: u64,
    },
    Binary {
        size: u64,
    },
    TooLarge {
        size: u64,
    },
}

pub fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn read_file(path: &Path) -> Result<FileContent> {
    let meta = fs::metadata(path).with_context(|| format!("opening {}", path.display()))?;
    if meta.len() > MAX_EDITOR_BYTES {
        return Ok(FileContent::TooLarge { size: meta.len() });
    }
    let bytes = fs::read(path)?;
    Ok(match text::decode(&bytes) {
        Decoded::Text {
            content,
            encoding,
            eol,
        } => FileContent::Text {
            content,
            encoding,
            eol,
            mtime: mtime_ms(&meta),
        },
        Decoded::Binary => FileContent::Binary { size: meta.len() },
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum WriteResult {
    Saved {
        mtime: u64,
    },
    /// The file changed on disk since it was loaded; nothing was written.
    Conflict {
        mtime: u64,
    },
}

/// Writes text, keeping the encoding chosen when the file was read. When
/// `expected_mtime` is given and the file changed on disk since, nothing is
/// written and `Conflict` is returned.
pub fn write_file(
    path: &Path,
    content: &str,
    encoding: TextEncoding,
    expected_mtime: Option<u64>,
) -> Result<WriteResult> {
    let existing = fs::metadata(path).ok();
    if let (Some(meta), Some(expected)) = (&existing, expected_mtime) {
        let current = mtime_ms(meta);
        if current != expected {
            return Ok(WriteResult::Conflict { mtime: current });
        }
    }
    let bytes = text::encode(content, encoding)?;
    atomic_write(path, &bytes, existing.as_ref())?;
    Ok(WriteResult::Saved {
        mtime: mtime_ms(&fs::metadata(path)?),
    })
}

pub(crate) fn atomic_write(
    path: &Path,
    bytes: &[u8],
    existing: Option<&fs::Metadata>,
) -> Result<()> {
    // Renaming over a symlink would replace the link itself; write its target instead.
    let resolved;
    let path = match fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_symlink() => {
            resolved = fs::canonicalize(path)?;
            resolved.as_path()
        }
        _ => path,
    };
    let dir = path.parent().context("file has no parent directory")?;
    let file_name = path
        .file_name()
        .context("invalid file name")?
        .to_string_lossy();
    let tmp = dir.join(format!(".{file_name}.haze-tmp-{}", std::process::id()));
    let write = || -> Result<()> {
        use std::io::Write;
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        if let Some(meta) = existing {
            fs::set_permissions(&tmp, meta.permissions())?;
        }
        if let Err(e) = fs::rename(&tmp, path) {
            // Windows refuses to replace a file another process holds open
            // (antivirus, indexers); overwriting in place still works there.
            if e.kind() != std::io::ErrorKind::PermissionDenied || existing.is_none() {
                return Err(e.into());
            }
            fs::write(path, bytes)?;
            let _ = fs::remove_file(&tmp);
        }
        Ok(())
    };
    let result = write();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result.with_context(|| format!("saving {}", path.display()))
}

fn validate_name(name: &str) -> Result<()> {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\']) {
        bail!("invalid name: {name:?}");
    }
    Ok(())
}

pub fn create_file(dir: &Path, name: &str) -> Result<String> {
    validate_name(name)?;
    let path = dir.join(name);
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .with_context(|| format!("creating {}", path.display()))?;
    Ok(path.to_string_lossy().into_owned())
}

pub fn create_dir(dir: &Path, name: &str) -> Result<String> {
    // Allows `a/b/c` to create nested folders, like Rider's "New Directory".
    if name.split(['/', '\\']).any(|p| validate_name(p).is_err()) {
        bail!("invalid name: {name:?}");
    }
    let path = dir.join(name);
    if path.exists() {
        bail!("{} already exists", path.display());
    }
    fs::create_dir_all(&path)?;
    Ok(path.to_string_lossy().into_owned())
}

pub fn rename(path: &Path, new_name: &str) -> Result<String> {
    validate_name(new_name)?;
    let target = path
        .parent()
        .context("cannot rename a root")?
        .join(new_name);
    if target.exists() && !same_entry(path, &target) {
        bail!("{} already exists", target.display());
    }
    fs::rename(path, &target).with_context(|| format!("renaming {}", path.display()))?;
    Ok(target.to_string_lossy().into_owned())
}

/// True when `a` and `b` name the same directory entry, as a case-only
/// rename does on a case-insensitive file system. On a case-sensitive one
/// `Foo.cs` and `foo.cs` are different files and must not be overwritten.
fn same_entry(a: &Path, b: &Path) -> bool {
    if a.to_string_lossy().to_lowercase() != b.to_string_lossy().to_lowercase() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match (fs::symlink_metadata(a), fs::symlink_metadata(b)) {
            (Ok(x), Ok(y)) => x.dev() == y.dev() && x.ino() == y.ino(),
            _ => false,
        }
    }
    #[cfg(not(unix))]
    {
        // NTFS is case-insensitive (per-directory case sensitivity is rare).
        true
    }
}

pub fn trash(paths: &[PathBuf]) -> Result<()> {
    trash::delete_all(paths).context("moving to trash")
}

fn ensure_not_inside(src: &Path, dest_dir: &Path) -> Result<()> {
    if dest_dir.starts_with(src) {
        bail!("cannot place {} inside itself", src.display());
    }
    Ok(())
}

/// A free name in `dir`: `Foo.cs`, `Foo (1).cs`, `Foo (2).cs`, ...
fn unique_target(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (1..)
        .map(|i| dir.join(format!("{stem} ({i}){ext}")))
        .find(|p| !p.exists())
        .expect("unbounded range")
}

pub fn copy_into(sources: &[PathBuf], dest_dir: &Path) -> Result<Vec<String>> {
    let mut out = Vec::new();
    for src in sources {
        ensure_not_inside(src, dest_dir)?;
        let name = src.file_name().context("invalid source")?.to_string_lossy();
        let target = unique_target(dest_dir, &name);
        copy_recursive(src, &target)?;
        out.push(target.to_string_lossy().into_owned());
    }
    Ok(out)
}

fn copy_recursive(src: &Path, dst: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(src)?;
    if meta.is_dir() {
        fs::create_dir(dst)?;
        for e in fs::read_dir(src)? {
            let e = e?;
            copy_recursive(&e.path(), &dst.join(e.file_name()))?;
        }
    } else {
        fs::copy(src, dst).with_context(|| format!("copying {}", src.display()))?;
    }
    Ok(())
}

pub fn move_into(sources: &[PathBuf], dest_dir: &Path) -> Result<Vec<String>> {
    // Check everything first so a conflict does not leave a half-done move.
    let mut plan = Vec::new();
    for src in sources {
        ensure_not_inside(src, dest_dir)?;
        let name = src.file_name().context("invalid source")?;
        let target = dest_dir.join(name);
        if target == *src {
            continue;
        }
        if target.exists() {
            bail!("{} already exists", target.display());
        }
        plan.push((src.clone(), target));
    }
    let mut out = Vec::new();
    for (src, target) in plan {
        if fs::rename(&src, &target).is_err() {
            // Different volume: copy then remove.
            copy_recursive(&src, &target)?;
            if src.is_dir() {
                fs::remove_dir_all(&src)?;
            } else {
                fs::remove_file(&src)?;
            }
        }
        out.push(target.to_string_lossy().into_owned());
    }
    Ok(out)
}

/// Resolves path-like strings printed in a terminal (absolute, or relative
/// to the first of `bases` where they exist) to existing files.
/// Unresolvable entries become `None`.
pub fn resolve_paths(bases: &[PathBuf], candidates: &[String]) -> Vec<Option<String>> {
    candidates
        .iter()
        .map(|c| {
            let c = c.trim();
            if c.is_empty() {
                return None;
            }
            let expanded = match c.strip_prefix("~/") {
                Some(rest) => dirs::home_dir()?.join(rest),
                None => PathBuf::from(c),
            };
            if expanded.is_absolute() {
                return expanded
                    .is_file()
                    .then(|| expanded.to_string_lossy().into_owned());
            }
            bases
                .iter()
                .map(|b| b.join(&expanded))
                .find(|p| p.is_file())
                .map(|p| p.to_string_lossy().into_owned())
        })
        .collect()
}

/// Text of the given 1-based lines (empty string for lines past the end).
pub fn read_lines(path: &Path, lines: &[u32]) -> Result<Vec<String>> {
    let bytes = fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    let Decoded::Text { content, .. } = text::decode(&bytes) else {
        return Ok(vec![String::new(); lines.len()]);
    };
    let all: Vec<&str> = content.lines().collect();
    Ok(lines
        .iter()
        .map(|&n| {
            all.get((n as usize).wrapping_sub(1))
                .map(|l| l.trim_end_matches('\r').to_string())
                .unwrap_or_default()
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn case_only_rename_never_overwrites_another_file() {
        let dir = tempfile::tempdir().unwrap();
        let upper = dir.path().join("Foo.cs");
        fs::write(&upper, "upper").unwrap();
        let lower = dir.path().join("foo.cs");
        let case_sensitive = !lower.exists();
        if case_sensitive {
            fs::write(&lower, "lower").unwrap();
            assert!(rename(&upper, "foo.cs").is_err());
            assert_eq!(fs::read_to_string(&lower).unwrap(), "lower");
        } else {
            rename(&upper, "foo.cs").unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn saving_through_a_symlink_keeps_the_link() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real.json");
        let link = dir.path().join("link.json");
        fs::write(&real, "old").unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();
        write_file(&link, "new", TextEncoding::Utf8, None).unwrap();
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_to_string(&real).unwrap(), "new");
    }

    #[test]
    fn resolves_terminal_paths_against_the_first_base_that_has_them() {
        let dir = tempfile::tempdir().unwrap();
        let (now, start) = (dir.path().join("now"), dir.path().join("start"));
        fs::create_dir_all(&now).unwrap();
        fs::create_dir_all(&start).unwrap();
        fs::write(now.join("A.cs"), "").unwrap();
        fs::write(start.join("A.cs"), "").unwrap();
        fs::write(start.join("B.cs"), "").unwrap();
        let found = resolve_paths(
            &[now.clone(), start.clone()],
            &["A.cs".into(), "B.cs".into(), "C.cs".into()],
        );
        assert_eq!(
            found,
            vec![
                Some(now.join("A.cs").to_string_lossy().into_owned()),
                Some(start.join("B.cs").to_string_lossy().into_owned()),
                None
            ]
        );
    }

    #[test]
    fn reads_selected_lines() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.cs");
        fs::write(&p, "one\r\ntwo\r\nthree").unwrap();
        assert_eq!(
            read_lines(&p, &[2, 3, 9]).unwrap(),
            vec!["two", "three", ""]
        );
    }

    #[test]
    fn natural_order() {
        let mut v = vec!["file10", "file2", "File1", "a"];
        v.sort_by(|a, b| natural_cmp(&a.to_lowercase(), &b.to_lowercase()));
        assert_eq!(v, vec!["a", "File1", "file2", "file10"]);
    }

    #[test]
    fn save_detects_conflict_and_keeps_encoding() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("A.cs");
        fs::write(&p, b"\xEF\xBB\xBFclass A {}\r\n").unwrap();
        let FileContent::Text {
            content,
            encoding,
            mtime,
            ..
        } = read_file(&p).unwrap()
        else {
            panic!()
        };
        let edited = content.replace("A", "B");
        assert!(matches!(
            write_file(&p, &edited, encoding, Some(mtime)).unwrap(),
            WriteResult::Saved { .. }
        ));
        assert_eq!(fs::read(&p).unwrap(), b"\xEF\xBB\xBFclass B {}\r\n");
        assert!(matches!(
            write_file(&p, "x", encoding, Some(mtime.wrapping_sub(5000))).unwrap(),
            WriteResult::Conflict { .. }
        ));
    }

    #[test]
    fn copy_makes_unique_names_and_move_refuses_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a");
        let b = dir.path().join("b");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        fs::write(a.join("X.cs"), "1").unwrap();
        fs::write(b.join("X.cs"), "2").unwrap();
        let copied = copy_into(&[a.join("X.cs")], &b).unwrap();
        assert!(copied[0].ends_with("X (1).cs"));
        assert!(move_into(&[a.join("X.cs")], &b).is_err());
        assert!(move_into(std::slice::from_ref(&a), &a.join("sub")).is_err());
    }

    #[test]
    fn listing_nests_and_sorts() {
        let dir = tempfile::tempdir().unwrap();
        for f in [
            "appsettings.json",
            "appsettings.Development.json",
            "Program.cs",
        ] {
            fs::write(dir.path().join(f), "").unwrap();
        }
        fs::create_dir(dir.path().join("Controllers")).unwrap();
        fs::create_dir(dir.path().join(".git")).unwrap();
        let entries = list_dir(dir.path(), true).unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "Controllers",
                "appsettings.Development.json",
                "appsettings.json",
                "Program.cs"
            ]
        );
        assert_eq!(entries[1].nested_under.as_deref(), Some("appsettings.json"));
    }
}
