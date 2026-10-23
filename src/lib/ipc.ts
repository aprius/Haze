// Typed wrappers around the Rust commands in src-tauri/src/lib.rs.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  nestedUnder: string | null;
}

/** `*-invalid`: UTF-8 with a few invalid bytes, kept as U+F780–U+F7FF and saved back as those bytes. */
export type TextEncoding = "utf8" | "utf8-bom" | "utf16le" | "utf16be" | "windows1252" | "utf8-invalid" | "utf8-bom-invalid";
export type Eol = "lf" | "crlf";

/** The latest GitHub release compared with this build. */
export interface UpdateInfo {
  current: string;
  latest: string;
  /** The release page. */
  url: string;
  available: boolean;
}

export type FileContent =
  | { kind: "text"; content: string; encoding: TextEncoding; eol: Eol; mtime: number }
  | { kind: "binary"; size: number }
  | { kind: "tooLarge"; size: number };

export type WriteResult = { kind: "saved"; mtime: number } | { kind: "conflict"; mtime: number };

export type GitFileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "ignored"
  | "conflict";

export interface GitStatus {
  isRepo: boolean;
  root: string | null;
  branch: string | null;
  files: Record<string, GitFileStatus>;
  /** The same status as the Commit window lists it. */
  changes: GitChange[];
}

export interface FsChange {
  root: string;
  dirs: string[];
  files: string[];
  created: string[];
  removed: string[];
  /** Too much changed: refresh everything. files/created/removed then list only sources and project files. */
  overflow: boolean;
  /** Events were dropped, so even those lists are incomplete. */
  lost: boolean;
  git: boolean;
}

export interface SessionSpec {
  projectId: string | null;
  cwd: string;
  cols: number;
  rows: number;
  title?: string | null;
  command?: string[] | null;
  env?: [string, string][];
}

export interface SessionInfo {
  id: string;
  projectId: string | null;
  cwd: string;
  title: string;
  pid: number | null;
  createdAt: number;
  running: boolean;
  exitCode: number | null;
  agent: AgentStatus | null;
  /** A program runs in it, beyond a shell at its prompt (from `ptyList`; absent from an older host). */
  busy?: boolean | null;
}

export type AgentState = "idle" | "working" | "waiting" | "done" | "error";

export interface AgentStatus {
  agent: HookAgent | string;
  state: AgentState;
  message: string | null;
  at: number;
}

export type GitProvider = "github" | "gitlab";

/** A GitHub/GitLab account from Settings; its token stays in the OS keychain. */
export interface GitAccount {
  id: string;
  provider: GitProvider;
  server: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface GitAccountsInfo {
  accounts: GitAccount[];
  /** "Log In via GitHub…" (browser) is available in this build. */
  githubOauth: boolean;
}

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresIn: number;
}

export interface HookStatus {
  installed: boolean;
  stale: boolean;
  configPath: string;
  conflict: string | null;
}

export type PtyEvent =
  | { t: "snapshot"; id: string; data: string; /** PTY [cols, rows]; absent from an older host. */ size?: [number, number] | null }
  | { t: "output"; id: string; data: string }
  | { t: "exit"; id: string; code: number | null }
  | { t: "agent"; id: string; status: AgentStatus | null }
  | { t: "disconnected" };

export type SearchContext =
  | "anywhere"
  | "inComments"
  | "inStrings"
  | "exceptComments"
  | "exceptStrings"
  | "exceptCommentsAndStrings";

export interface SearchQuery {
  query: string;
  isRegex: boolean;
  matchCase: boolean;
  wholeWord: boolean;
  context: SearchContext;
  replacement: string | null;
  preserveCase: boolean;
}

export interface SearchScope {
  dirs: string[];
  files: string[];
  fileMask: string | null;
  includeIgnored: boolean;
  /** `.csproj` files whose items are searched ("In Solution" without non-solution items). */
  projects?: string[];
  overrides: Record<string, string>;
}

export interface SearchMatch {
  start: number;
  end: number;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  lineText: string;
  previewStart: number;
  previewEnd: number;
  replacement: string | null;
}

export interface FileMatches {
  path: string;
  mtime: number;
  hash: string;
  fromBuffer: boolean;
  matches: SearchMatch[];
}

export interface SearchResults {
  files: FileMatches[];
  totalMatches: number;
  filesSearched: number;
  truncated: boolean;
  cancelled: boolean;
}

export interface ReplaceTarget {
  path: string;
  hash: string;
  starts: number[];
}

export interface ReplaceOutcome {
  replaced: { path: string; count: number }[];
  skipped: { path: string; reason: string }[];
  undoId: number | null;
}

export interface FileHit {
  path: string;
  rel: string;
  score: number;
  nameIndices: number[];
}

export interface LaunchProfile {
  name: string;
  commandName: string;
  applicationUrl: string | null;
}

export interface DotnetProject {
  path: string;
  name: string;
  isTest: boolean;
  runnable: boolean;
  launchProfiles: LaunchProfile[];
}

export interface DotnetInfo {
  dotnetVersion: string | null;
  solutions: string[];
  projects: DotnetProject[];
}

export interface BuildDiagnostic {
  severity: "error" | "warning";
  code: string | null;
  message: string;
  file: string | null;
  line: number | null;
  column: number | null;
  endLine: number | null;
  endColumn: number | null;
  project: string | null;
}

export type BuildEvent =
  | { t: "line"; id: number; text: string; diagnostic: BuildDiagnostic | null }
  | { t: "done"; id: number; code: number | null; cancelled: boolean; millis: number };

export type BuildVerb = "build" | "rebuild" | "clean" | "test" | "restore";

export type UnityLogType = "log" | "warning" | "error" | "exception" | "assert";

/** Diagnostics from Unity's compiler; no end positions. */
export type UnityDiagnostic = Omit<BuildDiagnostic, "endLine" | "endColumn">;

/** A message from the Unity Editor's `com.aprius.ide.haze` link (HazeLink.cs), or the link's own state. */
export type UnityMessage =
  | { t: "link"; connected: boolean }
  | { t: "state"; unity: string; playing: boolean; paused: boolean; compiling: boolean }
  | { t: "compileStarted" }
  | { t: "compileFinished"; messages: UnityDiagnostic[] }
  | { t: "log"; type: UnityLogType; message: string; stack: string | null }
  | { t: "clear" }
  | { t: "testRunStarted"; pattern: string }
  | { t: "testStarted"; fullName: string }
  | {
      t: "testFinished";
      fullName: string;
      name: string;
      status: TestStatus;
      duration: number;
      message: string | null;
      stack: string | null;
      output: string | null;
    }
  | { t: "testRunFinished"; passed: number; failed: number; skipped: number; error: string | null };

export type UnityCommand = "refresh" | "compile" | "play" | "pause" | "step";

/** What Haze sends Unity: a command, or one with arguments. */
export type UnityRequest =
  | { t: UnityCommand }
  /** Selects an asset (and the component `fileId` in it, when its scene is open) in Unity. */
  | { t: "show"; path: string; fileId: string | null }
  /** Runs the tests whose full names match the regex, in Edit and/or Play Mode as they are. */
  | { t: "runTests"; pattern: string };

export type TestStatus = "passed" | "failed" | "skipped" | "inconclusive";

/** A place in a scene, prefab or asset (unity_index.rs). */
export interface AssetUsage {
  path: string;
  line: number;
  object: string | null;
  /** Text: local file ids pass 2^53. */
  fileId: string | null;
}

export interface AssetUsages {
  scripts: AssetUsage[];
  methods: Record<string, AssetUsage[]>;
}

/** A type or member of C# source (syntax.rs), shaped like LSP's DocumentSymbol; 0-based lines, UTF-16 columns. */
export interface OutlineSymbol {
  /** Plain: "Jump", "IFoo.Bar" (explicit implementation), "this[]". */
  name: string;
  /** LSP SymbolKind. */
  kind: number;
  /** The whole declaration, attributes included. */
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  /** The name. */
  selectionRange: { start: { line: number; character: number }; end: { line: number; character: number } };
  children: OutlineSymbol[];
}

/** Messages from one Unity Editor, a burst at a time. */
export interface UnityEvent {
  root: string;
  events: UnityMessage[];
}

export interface ServerCommand {
  kind: "roslyn" | "csharp-ls";
  program: string;
  args: string[];
}

export type LspEvent = { t: "message"; server: number; message: unknown } | { t: "exit"; server: number; code: number | null; reason: string | null };

export interface LogQuery {
  limit: number;
  refs: string[];
  text: string | null;
  author: string | null;
  path: string | null;
  firstParent: boolean;
  /** Continue after this many commits, from `lanes` (a page's `next` and `lanes`). */
  skip?: number;
  lanes?: unknown;
}

export interface Commit {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  time: number;
  refs: string[];
  subject: string;
}

export interface GraphEdge {
  from: number;
  to: number;
  color: number;
}

export interface GraphRow {
  lane: number;
  color: number;
  edges: GraphEdge[];
}

export interface LogPage {
  commits: Commit[];
  graph: GraphRow[];
  hasMore: boolean;
  next: number;
  lanes: unknown;
}

export type ChangeStatus = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflict";

export interface GitChange {
  rel: string;
  oldRel: string | null;
  status: ChangeStatus;
  staged: boolean;
}

export interface GitOutput {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ChangedFile {
  status: string;
  rel: string;
  oldRel: string | null;
}

export interface CommitDetails {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  time: number;
  committer: string;
  commitTime: number;
  message: string;
  files: ChangedFile[];
}

export interface Branch {
  name: string;
  refname: string;
  hash: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  current: boolean;
  kind: "local" | "remote" | "tag";
}

export interface BranchesInfo {
  current: string | null;
  detached: boolean;
  /** Commit HEAD points to (null before the first commit). */
  head: string | null;
  branches: Branch[];
  remotes: string[];
  operation: string | null;
}

export interface StashEntry {
  index: number;
  hash: string;
  time: number;
  message: string;
}

export interface BlameLine {
  line: number;
  hash: string;
  author: string;
  time: number;
  summary: string;
}

export interface RebaseStep {
  action: "pick" | "reword" | "edit" | "squash" | "fixup" | "drop";
  hash: string;
  message: string | null;
}

export interface Checkpoint {
  hash: string;
  time: number;
  label: string;
}

/** A project and/or file to open, from the command line (see cli_open.rs). */
export type HookAgent = "claude" | "codex" | "gemini" | "opencode";

export interface OpenRequest {
  project: string | null;
  file: string | null;
  line: number | null;
  column: number | null;
  /** A terminal `haze agent` / `haze run` started in `project`, to show. */
  terminal: string | null;
}

export const api = {
  takeOpenRequests: () => invoke<OpenRequest[]>("take_open_requests"),
  loadState: () => invoke<unknown>("load_state"),
  saveState: (value: unknown) => invoke<void>("save_state", { value }),

  listDir: (path: string, nest: boolean) => invoke<DirEntry[]>("list_dir", { path, nest }),
  readFile: (path: string) => invoke<FileContent>("read_file", { path }),
  writeFile: (path: string, content: string, encoding: TextEncoding, expectedMtime: number | null) =>
    invoke<WriteResult>("write_file", { path, content, encoding, expectedMtime }),
  createFile: (dir: string, name: string) => invoke<string>("create_file", { dir, name }),
  createDir: (dir: string, name: string) => invoke<string>("create_dir", { dir, name }),
  renamePath: (path: string, newName: string) => invoke<string>("rename_path", { path, newName }),
  trashPaths: (paths: string[]) => invoke<void>("trash_paths", { paths }),
  copyPaths: (sources: string[], destDir: string) => invoke<string[]>("copy_paths", { sources, destDir }),
  movePaths: (sources: string[], destDir: string) => invoke<string[]>("move_paths", { sources, destDir }),
  /** Relative candidates are tried in `pid`'s current directory first, then in `cwds`. */
  resolvePaths: (cwds: string[], pid: number | null, candidates: string[]) =>
    invoke<(string | null)[]>("resolve_paths", { cwds, pid, candidates }),

  searchText: (id: number, query: SearchQuery, scope: SearchScope, maxMatches?: number) =>
    invoke<SearchResults>("search_text", { id, query, scope, maxMatches: maxMatches ?? null }),
  /** A search of its own generation, so it never cancels Find in Files (see textNav.ts). */
  searchNav: (id: number, query: SearchQuery, scope: SearchScope, maxMatches?: number) =>
    invoke<SearchResults>("search_nav", { id, query, scope, maxMatches: maxMatches ?? null }),
  cancelNav: (id: number) => invoke<void>("cancel_nav", { id }),
  replaceInFiles: (query: SearchQuery, targets: ReplaceTarget[]) =>
    invoke<ReplaceOutcome>("replace_in_files", { query, targets }),
  undoReplace: (id: number) => invoke<{ path: string; reason: string }[]>("undo_replace", { id }),
  findFiles: (root: string, query: string, limit?: number, includeIgnored = false) =>
    invoke<FileHit[]>("find_files", { root, query, limit: limit ?? null, includeIgnored }),
  readImage: (path: string) => invoke<{ mime: string; base64: string }>("read_image", { path }),
  clipboardFilePaths: () => invoke<string[]>("clipboard_file_paths"),

  readLines: (requests: { path: string; lines: number[] }[]) => invoke<string[][]>("read_lines", { requests }),

  agentHooksStatus: (agent: HookAgent) => invoke<HookStatus>("agent_hooks_status", { agent }),
  agentHooksInstall: (agent: HookAgent) => invoke<HookStatus>("agent_hooks_install", { agent }),
  agentHooksUninstall: (agent: HookAgent) => invoke<HookStatus>("agent_hooks_uninstall", { agent }),

  gitLog: (root: string, query: LogQuery) => invoke<LogPage>("git_log", { root, query }),
  gitToplevel: (root: string) => invoke<string>("git_toplevel", { root }),
  gitCommit: (root: string, message: string, paths: string[], amend: boolean) =>
    invoke<GitOutput>("git_commit", { root, message, paths, amend }),
  gitRollback: (root: string, paths: string[]) => invoke<void>("git_rollback", { root, paths }),
  gitCommitDetails: (root: string, hash: string) => invoke<CommitDetails>("git_commit_details", { root, hash }),
  gitFileAt: (root: string, rev: string, rel: string) => invoke<string | null>("git_file_at", { root, rev, rel }),
  gitBranches: (root: string) => invoke<BranchesInfo>("git_branches", { root }),
  gitStashes: (root: string) => invoke<StashEntry[]>("git_stashes", { root }),
  gitBlame: (root: string, rel: string, contents: string | null, encoding: TextEncoding | null) =>
    invoke<BlameLine[]>("git_blame", { root, rel, contents, encoding }),
  gitRun: (root: string, args: string[]) => invoke<GitOutput>("git_run", { root, args }),
  gitAccounts: () => invoke<GitAccountsInfo>("git_accounts"),
  gitAccountLogin: (provider: GitProvider, server: string, token: string) =>
    invoke<GitAccount>("git_account_login", { provider, server, token }),
  gitAccountRemove: (id: string) => invoke<void>("git_account_remove", { id }),
  gitDeviceStart: () => invoke<DeviceCode>("git_device_start"),
  gitDevicePoll: (code: DeviceCode) => invoke<GitAccount>("git_device_poll", { code }),
  gitDeviceCancel: () => invoke<void>("git_device_cancel"),
  gitRebaseInteractive: (root: string, base: string | null, steps: RebaseStep[]) =>
    invoke<GitOutput>("git_rebase_interactive", { root, base, steps }),
  gitCheckpoint: (root: string, label: string) => invoke<string>("git_checkpoint", { root, label }),
  gitCheckpoints: (root: string) => invoke<Checkpoint[]>("git_checkpoints", { root }),
  gitChangesSince: (root: string, checkpoint: string) => invoke<ChangedFile[]>("git_changes_since", { root, checkpoint }),
  gitDeleteCheckpoints: (root: string) => invoke<void>("git_delete_checkpoints", { root }),
  gitFingerprints: (root: string, rels: string[]) => invoke<(string | null)[]>("git_fingerprints", { root, rels }),

  dotnetInfo: (root: string) => invoke<DotnetInfo>("dotnet_info", { root }),
  buildStart: (verb: BuildVerb, target: string | null, cwd: string) => invoke<number>("build_start", { verb, target, cwd }),
  buildCancel: (id: number) => invoke<void>("build_cancel", { id }),
  unityConnect: (root: string) => invoke<boolean>("unity_connect", { root }),
  unityDisconnect: (root: string) => invoke<void>("unity_disconnect", { root }),
  unitySend: (root: string, message: UnityRequest) => invoke<boolean>("unity_send", { root, message }),
  unityClasses: (root: string) => invoke<Record<string, string[]>>("unity_classes", { root }),
  unityAssetUsages: (root: string, script: string, classes: string[]) => invoke<AssetUsages>("unity_asset_usages", { root, script, classes }),
  unityWarmIndex: (root: string) => invoke<void>("unity_warm_index", { root }),
  csharpOutline: (text: string) => invoke<OutlineSymbol[]>("csharp_outline", { text }),
  lspFindServer: () => invoke<ServerCommand | null>("lsp_find_server"),
  lspStart: (cwd: string) => invoke<{ id: number; kind: ServerCommand["kind"] }>("lsp_start", { cwd }),
  lspSend: (id: number, message: unknown) => invoke<void>("lsp_send", { id, message }),
  lspStop: (id: number) => invoke<void>("lsp_stop", { id }),

  gitStatus: (dir: string) => invoke<GitStatus>("git_status", { dir }),
  watchProject: (root: string) => invoke<void>("watch_project", { root }),
  unwatchProject: (root: string) => invoke<void>("unwatch_project", { root }),

  checkUpdate: () => invoke<UpdateInfo>("check_update"),

  ptyList: () => invoke<SessionInfo[]>("pty_list"),
  ptyCreate: (spec: SessionSpec) => invoke<SessionInfo>("pty_create", { spec }),
  ptyAttach: (id: string) => invoke<void>("pty_attach", { id }),
  ptyDetach: (id: string) => invoke<void>("pty_detach", { id }),
  ptyWrite: (id: string, data: string) => invoke<void>("pty_write", { id, data }),
  ptyResize: (id: string, cols: number, rows: number) => invoke<void>("pty_resize", { id, cols, rows }),
  ptyClose: (id: string) => invoke<void>("pty_close", { id }),
};

export function onOpenRequest(cb: () => void): Promise<UnlistenFn> {
  return listen("app://open", () => cb());
}

export function onFsChange(cb: (c: FsChange) => void): Promise<UnlistenFn> {
  return listen<FsChange>("fs://changed", (e) => cb(e.payload));
}

export function onBuildEvent(cb: (e: BuildEvent) => void): Promise<UnlistenFn> {
  return listen<BuildEvent>("build://event", (e) => cb(e.payload));
}

export function onUnityEvent(cb: (e: UnityEvent) => void): Promise<UnlistenFn> {
  return listen<UnityEvent>("unity://event", (e) => cb(e.payload));
}

export function onLspEvent(cb: (e: LspEvent) => void): Promise<UnlistenFn> {
  return listen<LspEvent>("lsp://event", (e) => cb(e.payload));
}

export function onPtyEvent(cb: (e: PtyEvent) => void): Promise<UnlistenFn> {
  return listen<PtyEvent>("pty://event", (e) => cb(e.payload));
}

export function errorMessage(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
}
