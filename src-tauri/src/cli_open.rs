//! Opening a project or file from the command line, as code editors do:
//! `haze <project-dir> [<file>] [--line N] [--column N]`. Used by the Unity
//! integration; a second launch forwards its arguments to the running Haze.
//! `--terminal <id>` shows a terminal `haze agent` / `haze run` started there.

use std::path::Path;

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
            _ => {
                let path = cwd.join(a);
                let path = path.canonicalize().unwrap_or(path);
                let s = path.to_string_lossy().into_owned();
                if path.is_dir() {
                    req.project = Some(s);
                } else {
                    req.file = Some(s);
                }
            }
        }
    }
    (req.project.is_some() || req.file.is_some()).then_some(req)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_project_file_and_position() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
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
            Some(root.join("Assets/A.cs").to_str().unwrap())
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
