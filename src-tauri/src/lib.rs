pub mod agent_hooks;
pub mod cli;
mod cli_open;
mod dotnet;
mod file_index;
mod fs_ops;
mod git;
pub mod git_auth;
mod git_log;
mod git_ops;
mod lsp;
mod nesting;
mod procinfo;
pub mod pty;
mod search;
mod shell_env;
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

/// `pid` is the terminal's process: its current directory (after `cd`) comes
/// first, then `cwds` (one the shell reported, the one it started in).
#[tauri::command]
async fn resolve_paths(
    cwds: Vec<String>,
    pid: Option<u32>,
    candidates: Vec<String>,
) -> CmdResult<Vec<Option<String>>> {
    blocking(move || {
        let bases: Vec<PathBuf> = pid
            .and_then(procinfo::cwd_of)
            .into_iter()
            .chain(cwds.into_iter().map(PathBuf::from))
            .collect();
        Ok(fs_ops::resolve_paths(&bases, &candidates))
    })
    .await
}

#[derive(serde::Deserialize)]
struct LinesRequest {
    path: String,
    lines: Vec<u32>,
}

#[tauri::command]
async fn read_lines(requests: Vec<LinesRequest>) -> CmdResult<Vec<Vec<String>>> {
    blocking(move || {
        Ok(requests
            .iter()
            .map(|r| {
                fs_ops::read_lines(r.path.as_ref(), &r.lines)
                    .unwrap_or_else(|_| vec![String::new(); r.lines.len()])
            })
            .collect())
    })
    .await
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
    // Ordered with unwatch_project (both run on the main thread); the slow part runs on its own thread.
    watchers.watch(&root, sink);
    Ok(())
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

/// Like `SearchGeneration`, for the text searches behind Ctrl+Click when no
/// language server answers: they replace each other, not a Find in Files.
#[derive(Default)]
struct NavSearchGeneration(Arc<AtomicU64>);

#[tauri::command]
async fn search_nav(
    generation: State<'_, NavSearchGeneration>,
    id: u64,
    query: search::SearchQuery,
    scope: search::SearchScope,
    max_matches: Option<usize>,
) -> CmdResult<search::SearchResults> {
    let current = generation.0.clone();
    current.store(id, Ordering::Relaxed);
    blocking(move || search::search(&query, &scope, id, &current, max_matches.unwrap_or(500))).await
}

/// Stops nav search `id` if it is still running (Monaco no longer wants it).
#[tauri::command]
fn cancel_nav(generation: State<'_, NavSearchGeneration>, id: u64) {
    let _ = generation
        .0
        .compare_exchange(id, 0, Ordering::Relaxed, Ordering::Relaxed);
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

/// Files copied in Finder: the webview hides their paths from a paste, and
/// a terminal pastes them as paths.
#[tauri::command]
async fn clipboard_file_paths() -> CmdResult<Vec<String>> {
    blocking(|| {
        #[cfg(target_os = "macos")]
        {
            const SCRIPT: &str = r#"ObjC.import("AppKit");
const urls = $.NSPasteboard.generalPasteboard.readObjectsForClassesOptions($([$.NSURL]), $({ NSPasteboardURLReadingFileURLsOnlyKey: true }));
const out = [];
for (let i = 0; i < urls.count; i++) out.push(urls.objectAtIndex(i).path.js);
out.join("\n");"#;
            let out = std::process::Command::new("osascript")
                .args(["-l", "JavaScript", "-e", SCRIPT])
                .output()?;
            anyhow::ensure!(out.status.success(), "could not read the clipboard");
            Ok(String::from_utf8_lossy(&out.stdout)
                .lines()
                .filter(|l| !l.is_empty())
                .map(str::to_owned)
                .collect())
        }
        #[cfg(not(target_os = "macos"))]
        Ok(Vec::new())
    })
    .await
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

// ---------------------------------------------------------------- git tool windows

#[tauri::command]
async fn git_log(root: String, query: git_log::LogQuery) -> CmdResult<git_log::LogPage> {
    blocking(move || git_log::log(root.as_ref(), &query)).await
}

#[tauri::command]
async fn git_toplevel(root: String) -> CmdResult<String> {
    blocking(move || {
        Ok(git_ops::toplevel(root.as_ref())?
            .to_string_lossy()
            .into_owned())
    })
    .await
}

#[tauri::command]
async fn git_commit(
    root: String,
    message: String,
    paths: Vec<String>,
    amend: bool,
) -> CmdResult<git_ops::GitOutput> {
    blocking(move || git_ops::commit(root.as_ref(), &message, &paths, amend)).await
}

#[tauri::command]
async fn git_rollback(root: String, paths: Vec<String>) -> CmdResult<()> {
    blocking(move || git_ops::rollback(root.as_ref(), &paths)).await
}

#[tauri::command]
async fn git_commit_details(root: String, hash: String) -> CmdResult<git_ops::CommitDetails> {
    blocking(move || git_ops::commit_details(root.as_ref(), &hash)).await
}

#[tauri::command]
async fn git_file_at(root: String, rev: String, rel: String) -> CmdResult<Option<String>> {
    blocking(move || git_ops::file_at(root.as_ref(), &rev, &rel)).await
}

#[tauri::command]
async fn git_branches(root: String) -> CmdResult<git_ops::Branches> {
    blocking(move || git_ops::branches(root.as_ref())).await
}

#[tauri::command]
async fn git_stashes(root: String) -> CmdResult<Vec<git_ops::StashEntry>> {
    blocking(move || git_ops::stashes(root.as_ref())).await
}

#[tauri::command]
async fn git_blame(
    root: String,
    rel: String,
    contents: Option<String>,
    encoding: Option<text::TextEncoding>,
) -> CmdResult<Vec<git_ops::BlameLine>> {
    blocking(move || {
        // git compares bytes: UTF-16 or BOM text sent as UTF-8 would match no line.
        let bytes = contents
            .map(|c| text::encode(&c, encoding.unwrap_or(text::TextEncoding::Utf8)))
            .transpose()?;
        git_ops::blame(root.as_ref(), &rel, bytes.as_deref())
    })
    .await
}

#[tauri::command]
async fn git_rebase_interactive(
    root: String,
    base: Option<String>,
    steps: Vec<git_ops::RebaseStep>,
) -> CmdResult<git_ops::GitOutput> {
    blocking(move || git_ops::rebase_interactive(root.as_ref(), base.as_deref(), &steps)).await
}

#[tauri::command]
async fn git_checkpoint(root: String, label: String) -> CmdResult<String> {
    blocking(move || git_ops::checkpoint(root.as_ref(), &label)).await
}

#[tauri::command]
async fn git_checkpoints(root: String) -> CmdResult<Vec<git_ops::Checkpoint>> {
    blocking(move || git_ops::checkpoints(root.as_ref())).await
}

#[tauri::command]
async fn git_changes_since(
    root: String,
    checkpoint: String,
) -> CmdResult<Vec<git_ops::ChangedFile>> {
    blocking(move || git_ops::changes_since(root.as_ref(), &checkpoint)).await
}

#[tauri::command]
async fn git_delete_checkpoints(root: String) -> CmdResult<()> {
    blocking(move || git_ops::delete_checkpoints(root.as_ref())).await
}

#[tauri::command]
async fn git_fingerprints(root: String, rels: Vec<String>) -> CmdResult<Vec<Option<String>>> {
    blocking(move || Ok(git_ops::fingerprints(root.as_ref(), &rels))).await
}

#[tauri::command]
fn git_accounts() -> git_auth::AccountsInfo {
    git_auth::info()
}

#[tauri::command]
async fn git_account_login(
    provider: git_auth::Provider,
    server: String,
    token: String,
) -> CmdResult<git_auth::Account> {
    blocking(move || git_auth::login_with_token(provider, &server, &token)).await
}

#[tauri::command]
async fn git_account_remove(id: String) -> CmdResult<()> {
    blocking(move || git_auth::remove(&id)).await
}

#[tauri::command]
async fn git_device_start() -> CmdResult<git_auth::DeviceCode> {
    blocking(git_auth::device_start).await
}

#[tauri::command]
async fn git_device_poll(code: git_auth::DeviceCode) -> CmdResult<git_auth::Account> {
    blocking(move || git_auth::device_poll(&code)).await
}

#[tauri::command]
fn git_device_cancel() {
    git_auth::device_cancel();
}

#[tauri::command]
async fn git_run(root: String, args: Vec<String>) -> CmdResult<git_ops::GitOutput> {
    blocking(move || git_ops::run(root.as_ref(), &args)).await
}

// ---------------------------------------------------------------- AI agent hooks

#[tauri::command]
async fn agent_hooks_status(agent: String) -> CmdResult<agent_hooks::HookStatus> {
    blocking(move || agent_hooks::status_of(&agent)).await
}

#[tauri::command]
async fn agent_hooks_install(agent: String) -> CmdResult<agent_hooks::HookStatus> {
    blocking(move || agent_hooks::install(&agent)).await
}

#[tauri::command]
async fn agent_hooks_uninstall(agent: String) -> CmdResult<agent_hooks::HookStatus> {
    blocking(move || agent_hooks::uninstall(&agent)).await
}

// ---------------------------------------------------------------- .NET and language servers

#[tauri::command]
async fn dotnet_info(root: String) -> CmdResult<dotnet::DotnetInfo> {
    blocking(move || Ok(dotnet::info(root.as_ref()))).await
}

#[tauri::command]
fn build_start(
    app: AppHandle,
    builds: State<'_, dotnet::Builds>,
    verb: String,
    target: Option<String>,
    cwd: String,
) -> CmdResult<u64> {
    let (verb, extra): (&str, &[&str]) = match verb.as_str() {
        "build" | "clean" | "test" | "restore" => (verb.as_str(), &[]),
        "rebuild" => ("build", &["--no-incremental"]),
        other => return Err(format!("unsupported verb {other}")),
    };
    let sink: dotnet::BuildSink = Arc::new(move |e| {
        let _ = app.emit("build://event", e);
    });
    builds
        .start(verb, target.as_deref(), extra, cwd.as_ref(), sink)
        .map_err(err)
}

#[tauri::command]
fn build_cancel(builds: State<'_, dotnet::Builds>, id: u64) {
    builds.cancel(id);
}

#[tauri::command]
async fn lsp_find_server() -> CmdResult<Option<lsp::ServerCommand>> {
    blocking(|| Ok(lsp::find_csharp_server())).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartedServer {
    id: u64,
    kind: &'static str,
}

#[tauri::command]
async fn lsp_start(
    app: AppHandle,
    servers: State<'_, Arc<lsp::LspServers>>,
    cwd: String,
) -> CmdResult<StartedServer> {
    let servers = servers.inner().clone();
    blocking(move || {
        let cmd = lsp::find_csharp_server()
            .ok_or_else(|| anyhow::anyhow!("no C# language server installed"))?;
        let sink: lsp::MessageSink = Arc::new(move |e| {
            let _ = app.emit("lsp://event", e);
        });
        let id = servers.start(&cmd, cwd.as_ref(), sink)?;
        Ok(StartedServer { id, kind: cmd.kind })
    })
    .await
}

#[tauri::command]
fn lsp_send(
    servers: State<'_, Arc<lsp::LspServers>>,
    id: u64,
    message: serde_json::Value,
) -> CmdResult<()> {
    servers.send(id, &message).map_err(err)
}

#[tauri::command]
fn lsp_stop(servers: State<'_, Arc<lsp::LspServers>>, id: u64) {
    servers.stop(id);
}

// ---------------------------------------------------------------- terminals

struct Pty {
    client: Arc<PtyClient>,
    /// Input, resizes, attach and detach, applied in the order the UI sent
    /// them. As async commands each ran on its own blocking task, so two
    /// keystrokes could reach the shell swapped when the machine was busy.
    queue: std::sync::mpsc::Sender<Request>,
}

impl Pty {
    fn new(client: Arc<PtyClient>) -> Self {
        let (queue, requests) = std::sync::mpsc::channel::<Request>();
        let sender = client.clone();
        std::thread::spawn(move || {
            for req in requests {
                // Like before, failures are not reported (the UI ignored them).
                let _ = sender.notify(req);
            }
        });
        Self { client, queue }
    }

    fn send(&self, req: Request) -> CmdResult<()> {
        self.queue
            .send(req)
            .map_err(|_| "terminal input stopped".to_string())
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "t")]
enum PtyUiEvent {
    Snapshot {
        id: String,
        data: String,
        size: Option<(u16, u16)>,
    },
    Output {
        id: String,
        data: String,
    },
    Exit {
        id: String,
        code: Option<u32>,
    },
    Agent {
        id: String,
        status: Option<pty::protocol::AgentStatus>,
    },
    Disconnected,
}

#[tauri::command]
async fn pty_list(pty: State<'_, Pty>) -> CmdResult<Vec<SessionInfo>> {
    let client = pty.client.clone();
    blocking(move || match client.request(Request::List)? {
        Reply::Sessions { sessions } => Ok(sessions),
        other => anyhow::bail!("unexpected reply {other:?}"),
    })
    .await
}

#[tauri::command]
async fn pty_create(pty: State<'_, Pty>, mut spec: SessionSpec) -> CmdResult<SessionInfo> {
    pty::add_utf8_locale(&mut spec.env);
    let client = pty.client.clone();
    blocking(move || match client.request(Request::Create { spec })? {
        Reply::Created { session } => Ok(session),
        other => anyhow::bail!("unexpected reply {other:?}"),
    })
    .await
}

#[tauri::command]
fn pty_attach(pty: State<'_, Pty>, id: String) -> CmdResult<()> {
    pty.send(Request::Attach { id })
}

#[tauri::command]
fn pty_detach(pty: State<'_, Pty>, id: String) -> CmdResult<()> {
    pty.send(Request::Detach { id })
}

#[tauri::command]
fn pty_write(pty: State<'_, Pty>, id: String, data: String) -> CmdResult<()> {
    pty.send(Request::Write { id, data })
}

#[tauri::command]
fn pty_resize(pty: State<'_, Pty>, id: String, cols: u16, rows: u16) -> CmdResult<()> {
    pty.send(Request::Resize { id, cols, rows })
}

#[tauri::command]
async fn pty_close(pty: State<'_, Pty>, id: String) -> CmdResult<()> {
    let client = pty.client.clone();
    blocking(move || client.request(Request::Close { id }).map(|_| ())).await
}

// ---------------------------------------------------------------- command line

/// Projects/files asked for on the command line or by a second launch.
#[tauri::command]
fn take_open_requests(pending: State<cli_open::PendingOpens>) -> Vec<cli_open::OpenRequest> {
    std::mem::take(&mut *pending.0.lock())
}

fn forward_pty_event(app: &AppHandle, event: Option<PtyEvent>) {
    let ui = match event {
        Some(PtyEvent::Snapshot { id, data, size }) => PtyUiEvent::Snapshot { id, data, size },
        Some(PtyEvent::Output { id, data }) => PtyUiEvent::Output { id, data },
        Some(PtyEvent::Exit { id, code }) => PtyUiEvent::Exit { id, code },
        Some(PtyEvent::Agent { id, status }) => PtyUiEvent::Agent { id, status },
        None => PtyUiEvent::Disconnected,
    };
    let _ = app.emit("pty://event", ui);
}

/// The main window, built here rather than from the config so that
/// `window.open` gets real windows: the Commit and Diff windows render into
/// them from the main webview (same JS context, like VS Code's auxiliary
/// windows). The page names the window in the URL fragment, `about:blank#<label>`,
/// so it can close it: WebKit does not act on `window.close()` here.
fn create_main_window(app: &tauri::App) -> tauri::Result<()> {
    let Some(config) = app.config().app.windows.iter().find(|w| w.label == "main").cloned() else {
        return Ok(());
    };
    let handle = app.handle().clone();
    tauri::WebviewWindowBuilder::from_config(app, &config)?
        .on_new_window(move |url, features| {
            let label = url.fragment().filter(|f| f.starts_with("float-")).map(str::to_owned);
            let Some(label) = label.filter(|l| handle.get_webview_window(l).is_none()) else {
                return tauri::webview::NewWindowResponse::Deny;
            };
            let built = tauri::WebviewWindowBuilder::new(&handle, label, tauri::WebviewUrl::External(url))
                .window_features(features)
                .title("Haze")
                .on_document_title_changed(|w, title| {
                    let _ = w.set_title(&title);
                })
                .build();
            match built {
                Ok(window) => tauri::webview::NewWindowResponse::Create { window },
                Err(_) => tauri::webview::NewWindowResponse::Deny,
            }
        })
        .build()?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    shell_env::load_login_path();
    let pending = cli_open::PendingOpens::default();
    if let Ok(cwd) = std::env::current_dir() {
        let argv: Vec<String> = std::env::args().collect();
        pending.0.lock().extend(cli_open::parse(&argv, &cwd));
    }
    tauri::Builder::default()
        // First: a second `haze <path>` hands its request to this instance and exits.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            if let Some(req) = cli_open::parse(&argv, cwd.as_ref()) {
                app.state::<cli_open::PendingOpens>().0.lock().push(req);
                let _ = app.emit("app://open", ());
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .manage(pending)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(watcher::Watchers::default())
        .manage(Arc::new(file_index::FileIndex::default()))
        .manage(Arc::new(search::ReplaceHistory::default()))
        .manage(SearchGeneration::default())
        .manage(NavSearchGeneration::default())
        .manage(Arc::new(lsp::LspServers::default()))
        .manage(dotnet::Builds::default())
        .setup(|app| {
            create_main_window(app)?;
            if let Ok(dir) = app.path().app_config_dir() {
                git_auth::init(git_auth::accounts_path(&dir));
            }
            let handle = app.handle().clone();
            let client = PtyClient::new(pty::client::batched(Arc::new(move |ev| {
                forward_pty_event(&handle, ev)
            })));
            let client = Arc::new(client);
            // Starting the host overlaps with the webview loading.
            let warm = client.clone();
            std::thread::spawn(move || warm.warm());
            app.manage(Pty::new(client));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            take_open_requests,
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
            read_lines,
            git_status,
            watch_project,
            unwatch_project,
            search_text,
            search_nav,
            cancel_nav,
            replace_in_files,
            undo_replace,
            find_files,
            read_image,
            clipboard_file_paths,
            git_log,
            git_toplevel,
            git_commit,
            git_rollback,
            git_commit_details,
            git_file_at,
            git_branches,
            git_stashes,
            git_blame,
            git_run,
            git_accounts,
            git_account_login,
            git_account_remove,
            git_device_start,
            git_device_poll,
            git_device_cancel,
            git_rebase_interactive,
            git_checkpoint,
            git_checkpoints,
            git_changes_since,
            git_delete_checkpoints,
            git_fingerprints,
            agent_hooks_status,
            agent_hooks_install,
            agent_hooks_uninstall,
            dotnet_info,
            build_start,
            build_cancel,
            lsp_find_server,
            lsp_start,
            lsp_send,
            lsp_stop,
            pty_list,
            pty_create,
            pty_attach,
            pty_detach,
            pty_write,
            pty_resize,
            pty_close,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Haze")
        .run(|app, event| {
            // Language servers are children of this window process; stop them with it.
            if let tauri::RunEvent::Exit = event {
                app.state::<Arc<lsp::LspServers>>().stop_all();
            }
        });
}
