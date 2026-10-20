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
            Ok(v) => Ok(v),
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

pub fn save(path: &Path, value: &serde_json::Value) -> Result<()> {
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec(value)?)?;
    fs::rename(&tmp, path)?;
    Ok(())
}
