mod file_index;
mod fs_ops;
mod git;
mod nesting;
pub mod pty;
mod search;
mod state;
mod syntax;
mod text;
mod watcher;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use pty::client::PtyClient;
use pty::protocol::{Event as PtyEvent, Reply, Request, SessionInfo, SessionSpec};

type CmdResult<T> = Result<T, String>;

fn err(e: anyhow::Error) -> String {
    format!("{e:#}")
}

/// Runs blocking work off the UI thread.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
        .map_err(err)
}

// ---------------------------------------------------------------- state

#[tauri::command]
async fn load_state(app: AppHandle) -> CmdResult<serde_json::Value> {
    blocking(move || state::load(&state::state_path(&app)?)).await
}

#[tauri::command]
async fn save_state(app: AppHandle, value: serde_json::Value) -> CmdResult<()> {
    blocking(move || state::save(&state::state_path(&app)?, &value)).await
}

// ---------------------------------------------------------------- files

#[tauri::command]
async fn list_dir(path: String, nest: bool) -> CmdResult<Vec<fs_ops::DirEntry>> {
    blocking(move || fs_ops::list_dir(path.as_ref(), nest)).await
}

#[tauri::command]
async fn read_file(path: String) -> CmdResult<fs_ops::FileContent> {
    blocking(move || fs_ops::read_file(path.as_ref())).await
}

#[tauri::command]
async fn write_file(
    path: String,
    content: String,
    encoding: text::TextEncoding,
    expected_mtime: Option<u64>,
) -> CmdResult<fs_ops::WriteResult> {
    blocking(move || fs_ops::write_file(path.as_ref(), &content, encoding, expected_mtime)).await
}

#[tauri::command]
async fn create_file(dir: String, name: String) -> CmdResult<String> {
    blocking(move || fs_ops::create_file(dir.as_ref(), &name)).await
}

#[tauri::command]
async fn create_dir(dir: String, name: String) -> CmdResult<String> {
    blocking(move || fs_ops::create_dir(dir.as_ref(), &name)).await
}

#[tauri::command]
async fn rename_path(path: String, new_name: String) -> CmdResult<String> {
    blocking(move || fs_ops::rename(path.as_ref(), &new_name)).await
}

#[tauri::command]
async fn trash_paths(paths: Vec<String>) -> CmdResult<()> {
    blocking(move || fs_ops::trash(&paths.iter().map(PathBuf::from).collect::<Vec<_>>())).await
}

#[tauri::command]
async fn copy_paths(sources: Vec<String>, dest_dir: String) -> CmdResult<Vec<String>> {
    blocking(move || {
        fs_ops::copy_into(
            &sources.iter().map(PathBuf::from).collect::<Vec<_>>(),
            dest_dir.as_ref(),
        )
    })
    .await
}

#[tauri::command]
async fn move_paths(sources: Vec<String>, dest_dir: String) -> CmdResult<Vec<String>> {
    blocking(move || {
        fs_ops::move_into(
            &sources.iter().map(PathBuf::from).collect::<Vec<_>>(),
            dest_dir.as_ref(),
        )
    })
    .await
}

#[tauri::command]
async fn resolve_paths(cwd: String, candidates: Vec<String>) -> CmdResult<Vec<Option<String>>> {
    blocking(move || Ok(fs_ops::resolve_paths(cwd.as_ref(), &candidates))).await
}

#[tauri::command]
async fn git_status(dir: String) -> CmdResult<git::GitStatus> {
    blocking(move || git::status(dir.as_ref())).await
}

#[tauri::command]
fn watch_project(
    app: AppHandle,
    watchers: State<'_, watcher::Watchers>,
    index: State<'_, Arc<file_index::FileIndex>>,
    root: String,
) -> CmdResult<()> {
    let index = index.inner().clone();
    let sink: watcher::ChangeSink = Arc::new(move |change: watcher::FsChange| {
        if change.overflow || !change.dirs.is_empty() {
            index.invalidate(&change.root);
        }
        let _ = app.emit("fs://changed", change);
    });
    watchers.watch(&root, sink).map_err(err)
}

#[tauri::command]
fn unwatch_project(watchers: State<'_, watcher::Watchers>, root: String) {
    watchers.unwatch(&root);
}

// ---------------------------------------------------------------- search

/// Id of the newest text search; older ones stop as soon as they notice.
#[derive(Default)]
struct SearchGeneration(Arc<AtomicU64>);

#[tauri::command]
async fn search_text(
    generation: State<'_, SearchGeneration>,
    id: u64,
    query: search::SearchQuery,
    scope: search::SearchScope,
    max_matches: Option<usize>,
) -> CmdResult<search::SearchResults> {
    let current = generation.0.clone();
    current.store(id, Ordering::Relaxed);
    blocking(move || search::search(&query, &scope, id, &current, max_matches.unwrap_or(5000)))
        .await
}

#[tauri::command]
async fn replace_in_files(
    history: State<'_, Arc<search::ReplaceHistory>>,
    query: search::SearchQuery,
    targets: Vec<search::ReplaceTarget>,
) -> CmdResult<search::ReplaceOutcome> {
    let history = history.inner().clone();
    blocking(move || search::replace_in_files(&query, &targets, &history)).await
}

#[tauri::command]
async fn undo_replace(
    history: State<'_, Arc<search::ReplaceHistory>>,
    id: u64,
) -> CmdResult<Vec<search::Skipped>> {
    let history = history.inner().clone();
    blocking(move || search::undo_replace(&history, id)).await
}

#[tauri::command]
async fn find_files(
    index: State<'_, Arc<file_index::FileIndex>>,
    root: String,
    query: String,
    limit: Option<usize>,
) -> CmdResult<Vec<file_index::FileHit>> {
    let index = index.inner().clone();
    blocking(move || Ok(index.find(&root, &query, limit.unwrap_or(50)))).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageData {
    mime: &'static str,
    base64: String,
}

#[tauri::command]
async fn read_image(path: String) -> CmdResult<ImageData> {
    blocking(move || {
        use base64::Engine;
        let meta = std::fs::metadata(&path)?;
        anyhow::ensure!(
            meta.len() <= 20 * 1024 * 1024,
            "image is too large to preview"
        );
        let ext = std::path::Path::new(&path)
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let mime = match ext.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "bmp" => "image/bmp",
            "ico" => "image/x-icon",
            "svg" => "image/svg+xml",
            _ => "application/octet-stream",
        };
        let base64 = base64::engine::general_purpose::STANDARD.encode(std::fs::read(&path)?);
        Ok(ImageData { mime, base64 })
    })
    .await
}

// ---------------------------------------------------------------- terminals

struct Pty(Arc<PtyClient>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "t")]
enum PtyUiEvent {
    Snapshot { id: String, data: String },
    Output { id: String, data: String },
    Exit { id: String, code: Option<u32> },
    Disconnected,
}

#[tauri::command]
async fn pty_list(pty: State<'_, Pty>) -> CmdResult<Vec<SessionInfo>> {
    let client = pty.0.clone();
    blocking(move || match client.request(Request::List)? {
        Reply::Sessions { sessions } => Ok(sessions),
        other => anyhow::bail!("unexpected reply {other:?}"),
    })
    .await
}

#[tauri::command]
async fn pty_create(pty: State<'_, Pty>, spec: SessionSpec) -> CmdResult<SessionInfo> {
    let client = pty.0.clone();
    blocking(move || match client.request(Request::Create { spec })? {
        Reply::Created { session } => Ok(session),
        other => anyhow::bail!("unexpected reply {other:?}"),
    })
    .await
}

#[tauri::command]
async fn pty_attach(pty: State<'_, Pty>, id: String) -> CmdResult<()> {
    let client = pty.0.clone();
    blocking(move || client.notify(Request::Attach { id })).await
}

#[tauri::command]
async fn pty_detach(pty: State<'_, Pty>, id: String) -> CmdResult<()> {
    let client = pty.0.clone();
    blocking(move || client.notify(Request::Detach { id })).await
}

#[tauri::command]
async fn pty_write(pty: State<'_, Pty>, id: String, data: String) -> CmdResult<()> {
    let client = pty.0.clone();
    blocking(move || client.notify(Request::Write { id, data })).await
}

#[tauri::command]
async fn pty_resize(pty: State<'_, Pty>, id: String, cols: u16, rows: u16) -> CmdResult<()> {
    let client = pty.0.clone();
    blocking(move || client.notify(Request::Resize { id, cols, rows })).await
}

#[tauri::command]
async fn pty_close(pty: State<'_, Pty>, id: String) -> CmdResult<()> {
    let client = pty.0.clone();
    blocking(move || client.request(Request::Close { id }).map(|_| ())).await
}

fn forward_pty_event(app: &AppHandle, event: Option<PtyEvent>) {
    let ui = match event {
        Some(PtyEvent::Snapshot { id, data }) => PtyUiEvent::Snapshot { id, data },
        Some(PtyEvent::Output { id, data }) => PtyUiEvent::Output { id, data },
        Some(PtyEvent::Exit { id, code }) => PtyUiEvent::Exit { id, code },
        None => PtyUiEvent::Disconnected,
    };
    let _ = app.emit("pty://event", ui);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(watcher::Watchers::default())
        .manage(Arc::new(file_index::FileIndex::default()))
        .manage(Arc::new(search::ReplaceHistory::default()))
        .manage(SearchGeneration::default())
        .setup(|app| {
            let handle = app.handle().clone();
            let client = PtyClient::new(Arc::new(move |ev| forward_pty_event(&handle, ev)));
            app.manage(Pty(Arc::new(client)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_state,
            save_state,
            list_dir,
            read_file,
            write_file,
            create_file,
            create_dir,
            rename_path,
            trash_paths,
            copy_paths,
            move_paths,
            resolve_paths,
            git_status,
            watch_project,
            unwatch_project,
            search_text,
            replace_in_files,
            undo_replace,
            find_files,
            read_image,
            pty_list,
            pty_create,
            pty_attach,
            pty_detach,
            pty_write,
            pty_resize,
            pty_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Haze");
}
