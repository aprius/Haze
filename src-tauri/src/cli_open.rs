//! Opening a project or file from the command line, as code editors do:
//! `haze <project-dir> [<file>] [--line N] [--column N]`. Used by the Unity
//! integration; a second launch forwards its arguments to the running Haze.
//! `--terminal <id>` shows a terminal `haze agent` / `haze run` started there.

use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use serde::Serialize;

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    pub project: Option<String>,
    pub file: Option<String>,
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub terminal: Option<String>,
}

/// Requests the UI has not picked up yet (it may still be loading).
#[derive(Default)]
pub struct PendingOpens(pub Mutex<Vec<OpenRequest>>);

/// Parses `argv` (program name included); `None` when nothing is to be opened.
pub fn parse(argv: &[String], cwd: &Path) -> Option<OpenRequest> {
    let mut req = OpenRequest::default();
    let mut args = argv.iter().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--line" | "-l" => req.line = args.next().and_then(|v| v.parse().ok()),
            "--column" | "-c" => req.column = args.next().and_then(|v| v.parse().ok()),
            "--terminal" => req.terminal = args.next().cloned(),
            // macOS adds a process serial number when started by Finder.
            _ if a.starts_with("-psn_") || a.starts_with('-') => {}
            _ => set_path(&mut req, &cwd.join(a)),
        }
    }
    (req.project.is_some() || req.file.is_some()).then_some(req)
}

/// A file or folder dropped on the window: opened like `haze <path>`.
pub fn dropped(path: &Path) -> OpenRequest {
    let mut req = OpenRequest::default();
    set_path(&mut req, path);
    req
}

/// `path` resolved, as the folder picker gives it. On Windows `canonicalize`
/// returns `\\?\C:\…`, which the UI takes for another project and turns into
/// file URIs the C# server does not match with its projects.
pub fn canonical(path: &Path) -> PathBuf {
    let path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    match s.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => PathBuf::from(rest),
        _ => path,
    }
}

/// A folder is the project to open, anything else the file.
fn set_path(req: &mut OpenRequest, path: &Path) {
    let path = canonical(path);
    let s = path.to_string_lossy().into_owned();
    if path.is_dir() {
        req.project = Some(s);
    } else {
        req.file = Some(s);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drops_the_windows_verbatim_prefix() {
        let plain = |s: &str| canonical(Path::new(s)).to_string_lossy().into_owned();
        assert_eq!(plain(r"\\?\C:\Game\Assets\A.cs"), r"C:\Game\Assets\A.cs");
        assert_eq!(plain(r"\\?\UNC\server\share\Game"), r"\\server\share\Game");
    }

    #[test]
    fn parses_project_file_and_position() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical(dir.path());
        std::fs::create_dir(root.join("Assets")).unwrap();
        std::fs::write(root.join("Assets/A.cs"), "").unwrap();
        let argv: Vec<String> = ["haze", ".", "Assets/A.cs", "--line", "12", "--column", "3"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let req = parse(&argv, &root).unwrap();
        assert_eq!(req.project.as_deref(), Some(root.to_str().unwrap()));
        assert_eq!(
            req.file.as_deref(),
            Some(root.join("Assets").join("A.cs").to_str().unwrap())
        );
        assert_eq!((req.line, req.column), (Some(12), Some(3)));
        assert_eq!(parse(&["haze".into(), "-psn_0_1".into()], &root), None);
        let argv: Vec<String> = ["haze", ".", "--terminal", "abc"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let req = parse(&argv, &root).unwrap();
        assert_eq!(
            (req.project.as_deref(), req.terminal.as_deref()),
            (Some(root.to_str().unwrap()), Some("abc"))
        );
    }
}
