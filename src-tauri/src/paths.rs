//! Paths as the OS usually spells them. On Windows `std::fs::canonicalize`
//! returns verbatim paths (`\\?\D:\Game`), which the UI takes for another
//! folder than `D:\Game` and turns into file URIs (`file:///c%3A/%3F/D%3A/...`)
//! the C# server cannot resolve: it then loads no project (issue #41).

use std::path::{Path, PathBuf};

/// `\\?\D:\x` → `D:\x`, `\\?\UNC\server\share` → `\\server\share`; anything
/// else as it is. Works on the text, so it is the same on every platform.
pub fn plain_str(s: &str) -> Option<String> {
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return Some(format!(r"\\{rest}"));
    }
    let rest = s.strip_prefix(r"\\?\")?;
    let b = rest.as_bytes();
    (b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':').then(|| rest.to_string())
}

pub fn plain(p: &Path) -> PathBuf {
    match plain_str(&p.to_string_lossy()) {
        Some(s) => PathBuf::from(s),
        None => p.to_path_buf(),
    }
}

/// `std::fs::canonicalize` without the verbatim prefix.
pub fn canonicalize(p: &Path) -> std::io::Result<PathBuf> {
    p.canonicalize().map(|c| plain(&c))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drops_the_verbatim_prefix() {
        assert_eq!(
            plain_str(r"\\?\D:\Projects\Game").as_deref(),
            Some(r"D:\Projects\Game")
        );
        assert_eq!(
            plain_str(r"\\?\UNC\server\share\Game").as_deref(),
            Some(r"\\server\share\Game")
        );
        // Not a drive: a volume GUID path has no other spelling.
        assert_eq!(plain_str(r"\\?\Volume{1234}\x"), None);
        assert_eq!(plain_str(r"D:\Projects\Game"), None);
        assert_eq!(plain_str("/Users/me/Game"), None);
        assert_eq!(
            plain(Path::new("/Users/me/Game")),
            PathBuf::from("/Users/me/Game")
        );
    }
}
