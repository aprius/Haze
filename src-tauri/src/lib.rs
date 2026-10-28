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
mod media;
mod nesting;
mod opencode_config;
mod procinfo;
pub mod pty;
mod search;
mod shell_env;
mod state;
mod syntax;
mod text;
mod unity;
mod unity_csproj;
mod unity_data;
mod unity_index;
mod updates;
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
async fn git_status_paths(top: String, paths: Vec<String>) -> CmdResult<git::GitStatus> {
    blocking(move || git::status_paths(top.as_ref(), &paths)).await
}

#[tauri::command]
fn watch_project(
    app: AppHandle,
    watchers: State<'_, watcher::Watchers>,
    index: State<'_, Arc<file_index::FileIndex>>,
    unity: State<'_, Arc<unity_index::UnityIndexes>>,
    root: String,
) -> CmdResult<()> {
    let index = index.inner().clone();
    let unity = unity.inner().clone();
    let sink: watcher::ChangeSink = Arc::new(move |change: watcher::FsChange| {
        index.changed(&change);
        unity.changed(&change);
        let _ = app.emit("fs://changed", change);
    });
    // Ordered with unwatch_project (both run on the main thread); the slow part runs on its own thread.
    watchers.watch(&root, sink);
    Ok(())
}

#[tauri::command]
fn unwatch_project(
    watchers: State<'_, watcher::Watchers>,
    unity: State<'_, Arc<unity_index::UnityIndexes>>,
    root: String,
) {
    watchers.unwatch(&root);
    // Its changes are no longer reported.
    unity.forget(root.as_ref());
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
    include_ignored: Option<bool>,
) -> CmdResult<Vec<file_index::FileHit>> {
    let index = index.inner().clone();
    let include_ignored = include_ignored.unwrap_or(false);
    blocking(move || Ok(index.find(&root, &query, limit.unwrap_or(50), include_ignored))).await
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

/// A background image or video (Settings > Appearance) as raw bytes: a video is
/// too big to go through base64 like read_image's previews.
#[tauri::command]
async fn read_media(path: String) -> CmdResult<tauri::ipc::Response> {
    blocking(move || {
        let meta = std::fs::metadata(&path)?;
        anyhow::ensure!(
            meta.len() <= 512 * 1024 * 1024,
            "the file is too large (over 512 MB)"
        );
        Ok(tauri::ipc::Response::new(std::fs::read(&path)?))
    })
    .await
}

/// Keeps a copy of a background video in the app's cache (src-tauri/src/media.rs),
/// or with no path drops the one kept; returns the copy.
#[tauri::command]
async fn cache_backdrop(app: AppHandle, path: Option<String>) -> CmdResult<Option<String>> {
    blocking(move || {
        Ok(media::cache(&backdrop_cache_dir(&app)?, path.as_deref().map(std::path::Path::new))?
            .map(|p| p.to_string_lossy().into_owned()))
    })
    .await
}

fn backdrop_cache_dir(app: &AppHandle) -> anyhow::Result<std::path::PathBuf> {
    Ok(app.path().app_cache_dir().map_err(|e| anyhow::anyhow!("no cache directory: {e}"))?.join("backdrop"))
}

/// A loopback URL that plays a background video (src-tauri/src/media.rs): only
/// the copy cache_backdrop keeps, never any other file.
#[tauri::command]
async fn media_url(app: AppHandle, path: String) -> CmdResult<String> {
    blocking(move || {
        let path = std::path::Path::new(&path);
        let inside = match (path.canonicalize(), backdrop_cache_dir(&app)?.canonicalize()) {
            (Ok(p), Ok(dir)) => p.starts_with(dir),
            _ => false,
        };
        anyhow::ensure!(inside, "the video is gone");
        media::url(path)
    })
    .await
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
    rev: Option<String>,
) -> CmdResult<Vec<git_ops::BlameLine>> {
    blocking(move || {
        // git compares bytes: UTF-16 or BOM text sent as UTF-8 would match no line.
        let bytes = contents
            .map(|c| text::encode(&c, encoding.unwrap_or(text::TextEncoding::Utf8)))
            .transpose()?;
        git_ops::blame(root.as_ref(), &rel, bytes.as_deref(), rev.as_deref())
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

// ---------------------------------------------------------------- OpenCode providers

#[tauri::command]
async fn opencode_config() -> CmdResult<opencode_config::OpenCodeConfig> {
    blocking(move || opencode_config::read(&opencode_config::config_dir()?)).await
}

#[tauri::command]
async fn opencode_save_provider(
    input: opencode_config::ProviderInput,
) -> CmdResult<opencode_config::OpenCodeConfig> {
    blocking(move || opencode_config::save_provider(&opencode_config::config_dir()?, input)).await
}

#[tauri::command]
async fn opencode_remove_provider(id: String) -> CmdResult<opencode_config::OpenCodeConfig> {
    blocking(move || opencode_config::remove_provider(&opencode_config::config_dir()?, &id)).await
}

#[tauri::command]
async fn opencode_set_models(
    model: String,
    small_model: String,
) -> CmdResult<opencode_config::OpenCodeConfig> {
    blocking(move || {
        opencode_config::set_models(&opencode_config::config_dir()?, &model, &small_model)
    })
    .await
}

#[tauri::command]
async fn opencode_fetch_models(
    base_url: String,
    api_key: Option<String>,
    id: String,
    npm: String,
) -> CmdResult<Vec<String>> {
    blocking(move || {
        opencode_config::fetch_models(
            &opencode_config::config_dir()?,
            &base_url,
            api_key.as_deref(),
            &id,
            &npm,
        )
    })
    .await
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
fn unity_connect(app: AppHandle, links: State<'_, unity::UnityLinks>, root: String) -> bool {
    let sink: unity::UnitySink = Arc::new(move |e| {
        let _ = app.emit("unity://event", e);
    });
    links.connect(&root, sink)
}

#[tauri::command]
fn unity_disconnect(links: State<'_, unity::UnityLinks>, root: String) {
    links.disconnect(&root);
}

#[tauri::command]
fn unity_send(links: State<'_, unity::UnityLinks>, root: String, message: serde_json::Value) -> bool {
    links.send(&root, &message)
}

/// Adds a script Unity's projects do not list yet to its assembly's `.csproj`; the project changed, if any.
#[tauri::command]
async fn unity_add_to_project(root: String, file: String) -> CmdResult<Option<String>> {
    blocking(move || {
        let changed = unity_csproj::add_to_project(root.as_ref(), file.as_ref())?;
        Ok(changed.map(|p| p.to_string_lossy().into_owned()))
    })
    .await
}

#[tauri::command]
async fn unity_classes(
    indexes: State<'_, Arc<unity_index::UnityIndexes>>,
    root: String,
) -> CmdResult<std::collections::HashMap<String, Vec<String>>> {
    let indexes = indexes.inner().clone();
    blocking(move || Ok(indexes.classes(root.as_ref()))).await
}

/// Indexes a Unity project's scripts and assets ahead of Code Vision asking.
#[tauri::command]
async fn unity_warm_index(
    indexes: State<'_, Arc<unity_index::UnityIndexes>>,
    root: String,
) -> CmdResult<()> {
    let indexes = indexes.inner().clone();
    blocking(move || {
        indexes.warm(root.as_ref());
        Ok(())
    })
    .await
}

/// Tags, layers, scenes, Resources, Animator states, shaders and assemblies of a Unity project.
#[tauri::command]
async fn unity_project_data(
    indexes: State<'_, Arc<unity_index::UnityIndexes>>,
    root: String,
) -> CmdResult<unity_data::ProjectData> {
    let indexes = indexes.inner().clone();
    blocking(move || Ok(indexes.project_data(root.as_ref()))).await
}

#[tauri::command]
async fn unity_asset_usages(
    indexes: State<'_, Arc<unity_index::UnityIndexes>>,
    root: String,
    script: String,
    classes: Vec<String>,
) -> CmdResult<unity_index::AssetUsages> {
    let indexes = indexes.inner().clone();
    blocking(move || Ok(indexes.asset_usages(root.as_ref(), script.as_ref(), &classes))).await
}

/// Types and members of C# source, for Code Vision before (and without) a language server.
/// Methods and their calls, for Unity's performance-critical context.
#[tauri::command]
async fn csharp_perf(text: String) -> CmdResult<Vec<syntax::PerfMethod>> {
    blocking(move || Ok(syntax::csharp_perf(&text))).await
}

/// Strings naming tags, layers, scenes… and Instantiate calls, for Unity's inspections.
#[tauri::command]
async fn csharp_unity(text: String) -> CmdResult<syntax::UnityCode> {
    blocking(move || Ok(syntax::csharp_unity(&text))).await
}

#[tauri::command]
async fn csharp_outline(text: String) -> CmdResult<Vec<syntax::OutlineSymbol>> {
    blocking(move || Ok(syntax::csharp_outline(&text))).await
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

// ---------------------------------------------------------------- updates

#[tauri::command]
async fn check_update() -> CmdResult<updates::UpdateInfo> {
    blocking(updates::check).await
}

#[tauri::command]
async fn update_install_kind() -> CmdResult<updates::InstallKind> {
    blocking(|| Ok(updates::install_kind())).await
}

#[tauri::command]
async fn update_in_terminal() -> CmdResult<()> {
    blocking(updates::update_in_terminal).await
}

#[tauri::command]
async fn install_update(on_progress: tauri::ipc::Channel<updates::Progress>) -> CmdResult<()> {
    blocking(move || {
        updates::download_and_install(|p| {
            let _ = on_progress.send(p);
        })
    })
    .await
}

/// After `install_update`; the page has saved the workspace first.
#[tauri::command]
fn relaunch_updated(app: AppHandle) -> CmdResult<()> {
    updates::spawn_relaunch().map_err(err)?;
    app.exit(0);
    Ok(())
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
    let drop_handle = app.handle().clone();
    let window = tauri::WebviewWindowBuilder::from_config(app, &config)?
        .on_new_window(move |url, features| {
            let label = url.fragment().filter(|f| f.starts_with("float-")).map(str::to_owned);
            let Some(label) = label.filter(|l| handle.get_webview_window(l).is_none()) else {
                return tauri::webview::NewWindowResponse::Deny;
            };
            let size = features.size();
            let mut builder = tauri::WebviewWindowBuilder::new(&handle, label, tauri::WebviewUrl::External(url))
                .window_features(features);
            if let Some((x, y)) = float_position(&handle, size) {
                builder = builder.position(x, y);
            }
            // Hidden until the page has drawn into it, or it shows white first.
            let built = builder
                .visible(false)
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
    // Files and folders dropped from Finder or Explorer open like `haze <path>`.
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
            if paths.is_empty() {
                return;
            }
            let reqs = paths.iter().map(|p| cli_open::dropped(p));
            drop_handle.state::<cli_open::PendingOpens>().0.lock().extend(reqs);
            let _ = drop_handle.emit("app://open", ());
        }
    });
    Ok(())
}

/// Where a Commit or Diff window opens: centred over the main window, a third
/// of the way down, kept inside the main window's screen. WebKit's own
/// `left`/`top` (from `window.screenX/Y`) can land off screen.
fn float_position(handle: &AppHandle, size: Option<tauri::LogicalSize<f64>>) -> Option<(f64, f64)> {
    let main = handle.get_webview_window("main")?;
    let scale = main.scale_factor().ok()?;
    let pos = main.outer_position().ok()?.to_logical::<f64>(scale);
    let outer = main.outer_size().ok()?.to_logical::<f64>(scale);
    let size = size.unwrap_or(tauri::LogicalSize::new(800.0, 600.0));
    let mut x = pos.x + ((outer.width - size.width) / 2.0).max(0.0);
    let mut y = pos.y + ((outer.height - size.height) / 3.0).max(40.0);
    if let Some(monitor) = main.current_monitor().ok().flatten() {
        let area = monitor.work_area();
        let at = area.position.to_logical::<f64>(monitor.scale_factor());
        let room = area.size.to_logical::<f64>(monitor.scale_factor());
        x = x.min(at.x + room.width - size.width).max(at.x);
        y = y.min(at.y + room.height - size.height).max(at.y);
    }
    Some((x, y))
}

/// Menu item id of "Check for Updates…"; the page runs the check.
const CHECK_UPDATES_MENU: &str = "check-updates";

/// Menu item id of "About Haze"; it opens Haze's own About window, as the
/// native panel is small and fixed (its icon, its text size).
const ABOUT_MENU_ID: &str = "haze-about";

/// Tauri's default menu with Haze's About window and "Check for Updates…"
/// under it.
fn app_menu(handle: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let menu = tauri::menu::Menu::default(handle)?;
    #[cfg(target_os = "macos")]
    if let Some(app) = menu.items()?.first().and_then(|i| i.as_submenu().cloned()) {
        use tauri::menu::MenuItem;
        app.remove_at(0)?;
        app.insert(&MenuItem::with_id(handle, ABOUT_MENU_ID, "About Haze", true, None::<&str>)?, 0)?;
        let check = MenuItem::with_id(handle, CHECK_UPDATES_MENU, "Check for Updates…", true, None::<&str>)?;
        app.insert(&check, 1)?;
    }
    Ok(menu)
}

/// Opens the About window (public/about.html), or brings it forward. It
/// starts hidden and is shown once the page has loaded, or it flashes white.
/// Not from the page: WebKit runs no animation frames in a hidden window.
fn open_about(handle: &AppHandle) -> tauri::Result<()> {
    use base64::Engine;
    if let Some(w) = handle.get_webview_window("about") {
        return w.set_focus();
    }
    let info = serde_json::json!({
        "version": handle.package_info().version.to_string(),
        "commit": env!("HAZE_COMMIT"),
        "icon": format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(include_bytes!("../icons/128x128@2x.png"))
        ),
    });
    let size = tauri::LogicalSize::new(440.0, 340.0);
    let mut builder = tauri::WebviewWindowBuilder::new(handle, "about", tauri::WebviewUrl::App("about.html".into()))
        .title("")
        .inner_size(size.width, size.height)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .visible(false)
        .initialization_script(format!("window.__HAZE_ABOUT__ = {info};"))
        .on_page_load(|w, p| {
            if matches!(p.event(), tauri::webview::PageLoadEvent::Finished) {
                let _ = w.show();
                let _ = w.set_focus();
            }
        });
    #[cfg(target_os = "macos")]
    {
        builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
    }
    builder = match float_position(handle, Some(size)) {
        Some((x, y)) => builder.position(x, y),
        None => builder.center(),
    };
    builder.build()?;
    Ok(())
}

#[tauri::command]
fn about_close(window: tauri::WebviewWindow) {
    if window.label() == "about" {
        let _ = window.close();
    }
}

/// Whether any Haze window has focus, for what slows down or pauses while Haze
/// is in the background (a background video): `app://active` when it changes.
fn track_focus(window: &tauri::Window, event: &tauri::WindowEvent) {
    static FOCUSED: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());
    let label = window.label().to_owned();
    let mut focused = FOCUSED.lock().unwrap();
    let was = !focused.is_empty();
    match event {
        tauri::WindowEvent::Focused(true) if !focused.contains(&label) => focused.push(label),
        tauri::WindowEvent::Focused(false) | tauri::WindowEvent::Destroyed => focused.retain(|l| *l != label),
        _ => return,
    }
    let now = !focused.is_empty();
    drop(focused);
    if now != was {
        let _ = window.app_handle().emit("app://active", now);
    }
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
        .menu(app_menu)
        .on_menu_event(|app, event| {
            // One handler: a second on_menu_event would replace this one.
            if event.id() == ABOUT_MENU_ID {
                let _ = open_about(app);
            } else if event.id() == CHECK_UPDATES_MENU {
                let _ = app.emit("app://check-updates", ());
            }
        })
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
        .manage(unity::UnityLinks::default())
        .manage(Arc::new(unity_index::UnityIndexes::default()))
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
            #[cfg(windows)]
            std::thread::spawn(updates::remove_replaced_exes);
            app.manage(Pty::new(client));
            Ok(())
        })
        .on_window_event(track_focus)
        .invoke_handler(tauri::generate_handler![
            take_open_requests,
            check_update,
            update_install_kind,
            update_in_terminal,
            install_update,
            relaunch_updated,
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
            git_status_paths,
            watch_project,
            unwatch_project,
            search_text,
            search_nav,
            cancel_nav,
            replace_in_files,
            undo_replace,
            find_files,
            read_image,
            read_media,
            cache_backdrop,
            media_url,
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
            opencode_config,
            opencode_save_provider,
            opencode_remove_provider,
            opencode_set_models,
            opencode_fetch_models,
            dotnet_info,
            build_start,
            build_cancel,
            unity_connect,
            unity_disconnect,
            unity_send,
            unity_classes,
            unity_add_to_project,
            unity_asset_usages,
            unity_project_data,
            unity_warm_index,
            csharp_outline,
            csharp_perf,
            csharp_unity,
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
            about_close,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Haze")
        .run(|app, event| match event {
            // Language servers are children of this window process; stop them with it.
            tauri::RunEvent::Exit => app.state::<Arc<lsp::LspServers>>().stop_all(),
            // Finder's "Open With" and drops on the Dock icon open like `haze <path>`.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Opened { urls } => {
                let reqs: Vec<_> = urls
                    .iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .map(|p| cli_open::dropped(&p))
                    .collect();
                if reqs.is_empty() {
                    return;
                }
                app.state::<cli_open::PendingOpens>().0.lock().extend(reqs);
                let _ = app.emit("app://open", ());
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.unminimize();
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            _ => {}
        });
}
