//! Persists the workspace state (projects, open tabs, drafts, layout) as JSON.
//! The UI owns the shape; the backend only stores it safely.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use tauri::{AppHandle, Manager};

pub fn state_path(app: &AppHandle) -> Result<PathBuf> {
    let dir = app.path().app_config_dir().context("no config directory")?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join("workspace.json"))
}

pub fn load(path: &Path) -> Result<serde_json::Value> {
    match fs::read(path) {
        Ok(bytes) => match serde_json::from_slice(&bytes) {
            Ok(mut v) => {
                plain_paths(&mut v);
                Ok(v)
            }
            Err(_) => {
                // Keep the unreadable file for inspection instead of silently losing it.
                let _ = fs::rename(path, path.with_extension("json.corrupt"));
                Ok(serde_json::Value::Null)
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::Value::Null),
        Err(e) => Err(e.into()),
    }
}

/// Versions before 1.0.30 saved Windows paths as `std::fs::canonicalize`
/// spells them (`\\?\D:\Game`): a project kept from then would start the C#
/// server on a root it cannot read (issue #41). Paths are values (projects,
/// tabs) and keys (drafts, per-file state), anywhere in the UI's shape.
fn plain_paths(v: &mut serde_json::Value) {
    use crate::paths::plain_str;
    match v {
        serde_json::Value::String(s) => {
            if let Some(p) = plain_str(s) {
                *s = p;
            }
        }
        serde_json::Value::Array(items) => items.iter_mut().for_each(plain_paths),
        serde_json::Value::Object(map) => {
            let old = std::mem::take(map);
            for (k, mut item) in old {
                plain_paths(&mut item);
                map.insert(plain_str(&k).unwrap_or(k), item);
            }
        }
        _ => {}
    }
}

pub fn save(path: &Path, value: &serde_json::Value) -> Result<()> {
    // Saves can overlap (debounced save + save on close); two writers on the
    // same temp file could interleave into invalid JSON and lose the drafts.
    static LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());
    let _guard = LOCK.lock();
    let tmp = path.with_extension("json.tmp");
    let mut f = fs::File::create(&tmp)?;
    std::io::Write::write_all(&mut f, &serde_json::to_vec(value)?)?;
    f.sync_all()?;
    fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_old_windows_paths_plain() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.json");
        fs::write(
            &path,
            r#"{"projects":[{"path":"\\\\?\\D:\\Projects\\Game","name":"Game"}],
                "drafts":{"\\\\?\\D:\\Projects\\Game\\A.cs":{"content":"x"}},
                "other":"/Users/me/Game","n":1}"#,
        )
        .unwrap();
        let v = load(&path).unwrap();
        assert_eq!(v["projects"][0]["path"], r"D:\Projects\Game");
        assert_eq!(v["drafts"][r"D:\Projects\Game\A.cs"]["content"], "x");
        assert_eq!(v["other"], "/Users/me/Game");
        assert_eq!(v["n"], 1);
    }
}
