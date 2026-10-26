// C# language support through Roslyn's language server: one session per open
// project, kept in sync with the editor's models, feeding Monaco providers.
//
// Diagnostics are pulled as files change, like Rider's on-the-fly analysis,
// once the projects have loaded (lib/lsp/diagnostics.ts says what is left out
// so nothing "phantom" shows up). A build's own errors (store/dotnet.ts) win.
import { errorMessage, type FsChange, type OutlineSymbol } from "../ipc";
import { api } from "../ipc";
import { monaco } from "../monaco";
import { isWithin } from "../path";
import { setCsharpStatus, useDotnet } from "../../store/dotnet";
import { useWorkspace } from "../../store/workspace";
import { LspClient } from "./client";
import {
  markupToString,
  pathToUri,
  toCompletionKind,
  toLocations,
  toLspPosition,
  toLspRange,
  toMonacoRange,
  toSymbolKind,
  uriToPath,
  type LspLocation,
  type LspRange,
  type LspTextEdit,
} from "./convert";
import { applyWorkspaceEdit, type WorkspaceEdit } from "../workspaceEdit";
import { isVirtualPath, setVirtualSource } from "../buffers";
import { MIN_PREFIX, pickInline, typedEdit, type LspCompletionItem } from "./inline";
import { buildHover, declarationAt, type Declaration } from "./hoverDoc";
import { SEMANTIC_LEGEND, semanticTranslator, type LspSemanticLegend } from "./semantic";
import { useUnity, type TestResult } from "../../store/unity";
import { unityMessage } from "../unity/messages";
import { assetUsagesFor, onUnityCodeChanged, unityBaseFor, unityGenerateActive, unityRootFor } from "../unity/scripts";
import { fixtureName, isTestHead, testPattern, typeName } from "../unity/tests";
import { bumpVisionGeneration, setVisionRefresh, visionAnswer, type VisionAnswer } from "./visionCache";
import { isImportFix, PULLED_KINDS, referencesMissing, shownByBuild, toMarker, touches, unitySuppressed, type LspDiagnostic } from "./diagnostics";

// What Roslyn reloads on: sources, project files and restore output. Other
// JSON (Unity's Library writes plenty) would only be parsed and dropped.
const WATCHED = /(\.(cs|csx|razor|cshtml|csproj|props|targets|sln|slnx|editorconfig)|[\\/](project\.assets|global)\.json)$/i;

interface ServerCapabilities {
  textDocumentSync?: number | { change?: number };
  completionProvider?: { triggerCharacters?: string[]; allCommitCharacters?: string[]; resolveProvider?: boolean };
  signatureHelpProvider?: { triggerCharacters?: string[] };
  semanticTokensProvider?: { legend: LspSemanticLegend; full?: boolean | object; range?: boolean };
  codeLensProvider?: { resolveProvider?: boolean };
  diagnosticProvider?: { identifier?: string };
  [k: string]: unknown;
}

/** Owner of live diagnostics' markers (build results use "build"). */
const LIVE = "csharp";
/** Pause after typing before diagnostics are asked again. */
const PULL_DELAY = 300;

interface Pulled {
  /** Per kind of diagnostics: the server's result id and items, kept when it answers "unchanged". */
  results: Map<string, { resultId?: string; items: LspDiagnostic[] }>;
  timer?: ReturnType<typeof setTimeout>;
  /** What is shown, for code actions. */
  shown: LspDiagnostic[];
  /** The build markers it was shown against. */
  build?: string;
}

export class CsharpSession {
  client!: LspClient;
  kind = "";
  caps: ServerCapabilities = {};
  /** Projects loaded (status only: queries are answered from whatever is loaded). */
  ready = false;
  /** Initialized and able to answer queries. */
  usable = false;
  private progress = new Map<string | number, string>();
  private readyWaiters: (() => void)[] = [];
  private synced = new Map<string, monaco.IDisposable>();
  private disposed = false;
  /** Kinds of pulled diagnostics the server registered ("" when it has one unnamed kind). */
  private diagnosticKinds: string[] = [];
  private pulled = new Map<string, Pulled>();
  /** Files whose project lost its references, reported once. */
  private brokenReported = false;
  /** Scripts checked against Unity's generated projects (unity_csproj.rs). */
  private projectChecked = new Set<string>();
  /** Server semantic tokens in Haze's legend (none when the server has none). */
  semanticTokens?: (data: ArrayLike<number>) => Uint32Array;
  /** Called when the server exits on its own after starting (see startCsharp). */
  onCrash?: () => void;

  constructor(
    readonly projectId: string,
    readonly root: string,
  ) {}

  async start(): Promise<void> {
    setCsharpStatus(this.projectId, { state: "starting" });
    const server = await api.lspFindServer();
    if (!server) {
      setCsharpStatus(this.projectId, { state: "missing" });
      return;
    }
    const started = await api.lspStart(this.root);
    this.kind = started.kind;
    this.client = await LspClient.attach(started.id);
    this.installHandlers();
    const rootUri = pathToUri(this.root);
    const init = await this.client.request<{ capabilities: ServerCapabilities }>("initialize", {
      processId: null,
      clientInfo: { name: "Haze" },
      rootUri,
      rootPath: this.root,
      workspaceFolders: [{ uri: rootUri, name: this.root.split(/[\\/]/).pop() }],
      capabilities: {
        workspace: {
          workspaceFolders: true,
          configuration: true,
          applyEdit: true,
          workspaceEdit: { documentChanges: true },
          didChangeWatchedFiles: { dynamicRegistration: true },
          symbol: { dynamicRegistration: false },
          semanticTokens: { refreshSupport: true },
          diagnostics: { refreshSupport: true },
        },
        textDocument: {
          synchronization: { didSave: true, dynamicRegistration: false },
          // Roslyn registers its kinds of diagnostics (syntax, compiler, analyzers) dynamically.
          diagnostic: { dynamicRegistration: true, relatedDocumentSupport: false },
          completion: {
            completionItem: { snippetSupport: true, documentationFormat: ["markdown", "plaintext"], resolveSupport: { properties: ["documentation", "detail", "additionalTextEdits"] } },
          },
          hover: { contentFormat: ["markdown", "plaintext"] },
          signatureHelp: { signatureInformation: { documentationFormat: ["markdown", "plaintext"] } },
          definition: { linkSupport: false },
          implementation: { linkSupport: false },
          references: {},
          documentHighlight: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          codeAction: {
            codeActionLiteralSupport: { codeActionKind: { valueSet: ["", "quickfix", "refactor", "refactor.extract", "refactor.inline", "refactor.rewrite", "source"] } },
            resolveSupport: { properties: ["edit"] },
            dataSupport: true,
          },
          formatting: {},
          rename: { prepareSupport: true },
          semanticTokens: {
            requests: { full: true, range: true },
            tokenTypes: [
              "namespace", "type", "class", "enum", "interface", "struct", "typeParameter", "parameter", "variable", "property", "enumMember",
              "event", "function", "method", "macro", "keyword", "modifier", "comment", "string", "number", "regexp", "operator",
            ],
            tokenModifiers: ["declaration", "definition", "readonly", "static", "deprecated", "abstract", "async", "modification", "documentation", "defaultLibrary"],
            formats: ["relative"],
            overlappingTokenSupport: false,
            multilineTokenSupport: false,
          },
        },
        window: { workDoneProgress: true, showMessage: {} },
      },
    });
    this.caps = init.capabilities;
    if (this.caps.diagnosticProvider && !this.diagnosticKinds.length) this.diagnosticKinds = [this.caps.diagnosticProvider.identifier ?? ""];
    const legend = this.caps.semanticTokensProvider?.legend;
    if (legend) this.semanticTokens = semanticTranslator(legend);
    await this.client.notify("initialized", {});
    this.usable = true;
    // Usage counts can be asked now (until the projects load, those from before stay).
    refreshCodeVision();
    setCsharpStatus(this.projectId, { state: "loading", kind: this.kind, message: "Loading projects…" });
    // csharp-ls has no "projects loaded" notification; it answers once ready.
    if (this.kind !== "roslyn") this.markReady();
    this.syncAllModels();
  }

  private installHandlers() {
    const c = this.client;
    c.onRequest("workspace/configuration", (p) => ((p as { items: { section?: string }[] }).items ?? []).map((i) => this.setting(i.section)));
    c.onRequest("workspace/applyEdit", async (p) => {
      await applyWorkspaceEdit((p as { edit: WorkspaceEdit }).edit);
      return { applied: true };
    });
    c.onRequest("workspace/semanticTokens/refresh", () => {
      semanticTokensChanged.fire();
      return null;
    });
    c.onRequest("client/registerCapability", (p) => {
      for (const r of (p as { registrations: { method: string; registerOptions?: { identifier?: string; documentSelector?: unknown } }[] }).registrations ?? []) {
        // Razor's own registration has a selector; C#'s have none.
        if (r.method !== "textDocument/diagnostic" || r.registerOptions?.documentSelector) continue;
        const kind = r.registerOptions?.identifier ?? "";
        if (kind && !PULLED_KINDS.includes(kind)) continue;
        if (!this.diagnosticKinds.includes(kind)) this.diagnosticKinds.push(kind);
      }
      // Named kinds cover what the unnamed one would.
      if (this.diagnosticKinds.some((k) => k)) this.diagnosticKinds = this.diagnosticKinds.filter((k) => k);
      return null;
    });
    // A project reloaded, an analyzer changed: what is shown may be stale.
    c.onRequest("workspace/diagnostic/refresh", () => {
      this.pullAll();
      return null;
    });
    c.onNotification("workspace/projectInitializationComplete", () => this.markReady());
    c.onNotification("$/progress", (p) => {
      const { token, value: v } = p as { token: string | number; value?: { kind?: string; title?: string; message?: string } };
      if (v?.kind === "begin") this.progress.set(token, v.title ?? "");
      if (this.ready) return;
      if (v?.kind === "end") {
        // Roslyn sends projectInitializationComplete only when every project
        // loaded; the end of its "Loading…" progress also covers failures.
        if (/^Load/i.test(this.progress.get(token) ?? "")) this.markReady(v.message);
        this.progress.delete(token);
      } else if (v?.message || v?.title) {
        setCsharpStatus(this.projectId, { state: "loading", kind: this.kind, message: v.message ?? v.title });
      }
    });
    const showError = (p: unknown) => {
      const m = p as { type: number; message: string };
      if (m.type === 1) setCsharpStatus(this.projectId, { state: this.ready ? "ready" : "loading", kind: this.kind, message: m.message.split("\n")[0] });
    };
    c.onNotification("window/showMessage", showError);
    c.onNotification("window/logMessage", showError);
    c.onExit((reason) => {
      this.ready = false;
      this.usable = false;
      this.synced.forEach((d) => d.dispose());
      this.synced.clear();
      this.clearDiagnostics();
      if (!this.disposed) {
        setCsharpStatus(this.projectId, { state: "stopped", kind: this.kind, message: exitMessage(reason) });
        this.onCrash?.();
      }
    });
  }

  /** A Roslyn setting Haze sets (`null` keeps the server's default). */
  private setting(section?: string): unknown {
    switch (section) {
      // Haze's own Code Vision runs Unity tests; Roslyn's "Run Test" lenses would sit on the names the usage counts are read from.
      case "csharp|code_lens.dotnet_enable_tests_code_lens":
        return false;
      // Unity's generated projects reference DLLs, never NuGet packages: a restore would only load every project a second time.
      case "projects.dotnet_enable_automatic_restore":
        return unityRootFor(this.root) ? false : null;
      default:
        return null;
    }
  }

  private markReady(message?: string) {
    if (this.ready) return;
    this.ready = true;
    setCsharpStatus(this.projectId, { state: "ready", kind: this.kind, message });
    this.readyWaiters.splice(0).forEach((r) => r());
    // Counts from before the projects loaded were partial.
    bumpVisionGeneration();
    semanticTokensChanged.fire();
    refreshCodeVision();
    this.pullAll();
  }

  /** Waits for the projects to load, at most `ms`: a project that never loads must not block queries. */
  whenReady(ms = 15000): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((r) => {
      this.readyWaiters.push(r);
      setTimeout(r, ms);
    });
  }

  owns(path: string): boolean {
    return isWithin(path, this.root);
  }

  // -------------------------------------------------------------- document sync

  syncAllModels(): void {
    for (const m of monaco.editor.getModels()) this.syncModel(m);
  }

  syncModel(model: monaco.editor.ITextModel): void {
    const path = modelPath(model);
    if (!this.client?.alive || !path || model.getLanguageId() !== "csharp") return;
    const uri = serverUri(model);
    if (this.synced.has(uri) || !this.owns(path)) return;
    void this.client.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: "csharp", version: model.getVersionId(), text: model.getValue() },
    });
    const incremental = (typeof this.caps.textDocumentSync === "number" ? this.caps.textDocumentSync : this.caps.textDocumentSync?.change) === 2;
    const changeSub = model.onDidChangeContent((e) => {
      const contentChanges = incremental
        ? e.changes.map((c) => ({ range: toLspRange(c.range), rangeLength: c.rangeLength, text: c.text }))
        : [{ text: model.getValue() }];
      void this.client.notify("textDocument/didChange", { textDocument: { uri, version: model.getVersionId() }, contentChanges });
      if (model.uri.scheme === "file") this.schedulePull(model, PULL_DELAY);
    });
    // Decompiled and generated code (csharp: URIs) has nothing to fix.
    if (model.uri.scheme === "file") {
      this.addToUnityProject(path);
      this.schedulePull(model, 0);
    }
    const disposeSub = model.onWillDispose(() => this.unsync(uri));
    this.synced.set(uri, {
      dispose: () => {
        changeSub.dispose();
        disposeSub.dispose();
      },
    });
  }

  private unsync(uri: string) {
    const sub = this.synced.get(uri);
    if (!sub) return;
    sub.dispose();
    this.synced.delete(uri);
    clearTimeout(this.pulled.get(uri)?.timer);
    this.pulled.delete(uri);
    void this.client.notify("textDocument/didClose", { textDocument: { uri } });
  }

  /** Tells the server about files changed on disk (by an AI agent, git…). */
  fileChanges(change: FsChange): void {
    if (!this.client?.alive) return;
    const created = new Set(change.created);
    const removed = new Set(change.removed);
    const changes = change.files
      .filter((f) => WATCHED.test(f) && this.owns(f))
      .map((f) => ({ uri: pathToUri(f), type: created.has(f) ? 1 : removed.has(f) ? 3 : 2 }));
    if (changes.length) void this.client.notify("workspace/didChangeWatchedFiles", { changes });
  }

  /**
   * A Unity script no generated project lists (just created, Unity not
   * reimported yet) is a loose file to Roslyn: no errors, no "using" fixes.
   * It goes into its assembly's project, as Rider does.
   */
  private addToUnityProject(path: string) {
    const root = unityRootFor(path);
    if (!root || !path.toLowerCase().endsWith(".cs") || this.projectChecked.has(path)) return;
    this.projectChecked.add(path);
    void api
      .unityAddToProject(root, path)
      .then((project) => {
        if (project && this.client.alive) void this.client.notify("workspace/didChangeWatchedFiles", { changes: [{ uri: pathToUri(project), type: 2 }] });
      })
      .catch((e) => console.warn("adding to the Unity project", e));
  }

  // -------------------------------------------------------------- diagnostics

  private schedulePull(model: monaco.editor.ITextModel, delay: number) {
    const uri = serverUri(model);
    let state = this.pulled.get(uri);
    if (!state) this.pulled.set(uri, (state = { results: new Map(), shown: [] }));
    clearTimeout(state.timer);
    state.timer = setTimeout(() => void this.pull(model).catch(() => {}), delay);
  }

  /** Asks again for every open document (projects loaded or reloaded). */
  private pullAll() {
    for (const m of monaco.editor.getModels()) if (m.uri.scheme === "file" && this.synced.has(serverUri(m))) this.schedulePull(m, 0);
  }

  private async pull(model: monaco.editor.ITextModel) {
    // Before the projects load every name is unknown.
    if (!this.ready || !this.client.alive || model.isDisposed() || !this.diagnosticKinds.length) return;
    const uri = serverUri(model);
    const state = this.pulled.get(uri);
    if (!state) return;
    const version = model.getVersionId();
    await Promise.all(
      this.diagnosticKinds.map(async (kind) => {
        const prev = state.results.get(kind);
        const res = await this.client.request<{ kind: "full" | "unchanged"; resultId?: string; items?: LspDiagnostic[] } | null>("textDocument/diagnostic", {
          textDocument: { uri },
          ...(kind ? { identifier: kind } : {}),
          ...(prev?.resultId ? { previousResultId: prev.resultId } : {}),
        });
        if (!res) return;
        state.results.set(kind, { resultId: res.resultId, items: res.kind === "unchanged" ? (prev?.items ?? []) : (res.items ?? []) });
      }),
    );
    // Edited meanwhile: the next pull is on its way.
    if (model.isDisposed() || model.getVersionId() !== version || this.pulled.get(uri) !== state) return;
    this.showDiagnostics(model, state);
  }

  private showDiagnostics(model: monaco.editor.ITextModel, state: Pulled) {
    let items = [...state.results.values()].flatMap((r) => r.items);
    if (referencesMissing(items)) {
      // Only what the parser says is still true.
      items = state.results.get("syntax")?.items ?? [];
      if (!this.brokenReported) {
        this.brokenReported = true;
        setCsharpStatus(this.projectId, {
          state: "ready",
          kind: this.kind,
          message: unityRootFor(this.root)
            ? "References are missing from the project files (the Unity Editor that generated them was moved or removed?): regenerate them in Unity, External Tools"
            : "References are missing from the project: restore or build it",
        });
      }
    }
    if (model.uri.scheme === "file" && unityRootFor(model.uri.fsPath)) {
      const src = { line: (n: number) => (n >= 1 && n <= model.getLineCount() ? model.getLineContent(n) : ""), isMessage: (n: string) => UNITY_MESSAGES.has(n) };
      items = items.filter((d) => !unitySuppressed(d, src));
    }
    // Code Vision greys unused members itself (Unity messages left alone).
    if (useWorkspace.getState().codeVision) items = items.filter((d) => d.code !== "IDE0051");
    const build = monaco.editor.getModelMarkers({ owner: "build", resource: model.uri });
    state.build = buildKey(build);
    items = items.filter((d) => !shownByBuild(d, build));
    state.shown = items;
    monaco.editor.setModelMarkers(
      model,
      LIVE,
      items.map((d) => {
        const m = toMarker(d);
        // The code links to the rule's documentation.
        return { ...m, code: typeof m.code === "object" ? { value: m.code.value, target: monaco.Uri.parse(m.code.target) } : m.code };
      }),
    );
  }

  /** A build's markers on the model changed: what they show is not shown twice. */
  buildMarkersChanged(model: monaco.editor.ITextModel) {
    const state = this.pulled.get(serverUri(model));
    if (!state || state.results.size === 0) return;
    if (state.build !== buildKey(monaco.editor.getModelMarkers({ owner: "build", resource: model.uri }))) this.showDiagnostics(model, state);
  }

  /** The live diagnostics shown in a range, for the code actions that fix them. */
  diagnosticsAt(model: monaco.editor.ITextModel, range: LspRange): LspDiagnostic[] {
    return (this.pulled.get(serverUri(model))?.shown ?? []).filter((d) => touches(d.range, range));
  }

  private clearDiagnostics() {
    for (const state of this.pulled.values()) clearTimeout(state.timer);
    this.pulled.clear();
    for (const m of monaco.editor.getModels()) {
      const path = modelPath(m);
      if (path && this.owns(path)) monaco.editor.setModelMarkers(m, LIVE, []);
    }
  }

  async stop(): Promise<void> {
    this.disposed = true;
    this.synced.forEach((d) => d.dispose());
    this.synced.clear();
    this.clearDiagnostics();
    if (this.client) await this.client.shutdown();
    setCsharpStatus(this.projectId, { state: "off" });
  }

  request<T>(method: string, params: unknown, token?: monaco.CancellationToken): Promise<T> {
    return this.client.request<T>(method, params, token);
  }
}

const buildKey = (markers: monaco.editor.IMarker[]) => markers.map((m) => `${m.startLineNumber}:${typeof m.code === "object" ? m.code.value : m.code}`).join(",");

/** Why the server stopped, with the fix for the usual cause. */
export function exitMessage(reason: string | null): string {
  if (!reason) return "C# server stopped";
  // roslyn-language-server runs on .NET 10; an older runtime makes it exit at once.
  if (/install or update \.NET|framework .* was not found|Microsoft\.NETCore\.App/i.test(reason))
    return `C# server needs the .NET 10 runtime (or newer): install it from https://dot.net, then restart C#. ${reason}`;
  if (/install \.NET|DOTNET_ROOT/i.test(reason)) return `C# server could not find .NET: ${reason}`;
  return `C# server stopped: ${reason}`;
}

// ------------------------------------------------------------------ sessions

const sessions = new Map<string, CsharpSession>();

export function sessionForProject(projectId: string): CsharpSession | undefined {
  return sessions.get(projectId);
}

export function sessionForPath(path: string): CsharpSession | undefined {
  let best: CsharpSession | undefined;
  for (const s of sessions.values()) if (s.owns(path) && (!best || s.root.length > best.root.length)) best = s;
  return best;
}

// A server that crashes after starting is started again, a few times in a row
// at most (one that fails at startup has a cause a restart will not fix).
// A server that ran for a while before crashing starts the count again.
const MAX_RESTARTS = 3;
const STABLE_MS = 5 * 60_000;
const crashes = new Map<string, number>();
const restartTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleRestart(projectId: string, root: string, delay: number, message?: string): void {
  clearTimeout(restartTimers.get(projectId));
  if (message) setCsharpStatus(projectId, { state: "loading", message });
  restartTimers.set(
    projectId,
    setTimeout(() => {
      restartTimers.delete(projectId);
      // Closed (or stopped by hand) meanwhile.
      if (sessions.get(projectId)?.root !== root) return;
      void restartCsharp(projectId, root);
    }, delay),
  );
}

export async function startCsharp(projectId: string, root: string): Promise<void> {
  registerProviders();
  if (sessions.has(projectId)) return;
  const s = new CsharpSession(projectId, root);
  sessions.set(projectId, s);
  // Usage lenses show from now on, with the counts from before until the server answers.
  refreshCodeVision();
  try {
    await s.start();
    if (!s.client) {
      sessions.delete(projectId);
      refreshCodeVision();
      return;
    }
    const startedAt = Date.now();
    s.onCrash = () => {
      const n = (Date.now() - startedAt > STABLE_MS ? 0 : (crashes.get(projectId) ?? 0)) + 1;
      if (n > MAX_RESTARTS) return;
      crashes.set(projectId, n);
      scheduleRestart(projectId, root, 1000 * 2 ** n, `C# server stopped, restarting (${n}/${MAX_RESTARTS})…`);
    };
  } catch (e) {
    sessions.delete(projectId);
    refreshCodeVision();
    // A server that died while starting has already reported why (see onExit).
    if (!s.client || s.client.alive) setCsharpStatus(projectId, { state: "error", message: errorMessage(e) });
  }
}

export async function stopCsharp(projectId: string): Promise<void> {
  clearTimeout(restartTimers.get(projectId));
  restartTimers.delete(projectId);
  const s = sessions.get(projectId);
  sessions.delete(projectId);
  await s?.stop();
}

export async function restartCsharp(projectId: string, root: string): Promise<void> {
  await stopCsharp(projectId);
  await startCsharp(projectId, root);
}

export function notifyFileChanges(change: FsChange): void {
  // Usages and authors elsewhere may have changed (agents' edits, a checkout, a commit).
  if (change.git || change.overflow || [...change.files, ...change.created, ...change.removed].some((f) => WATCHED.test(f))) bumpVisionGeneration();
  for (const s of sessions.values()) {
    if (!isWithin(change.root, s.root) && !isWithin(s.root, change.root)) continue;
    // Lost events leave no list of what changed, so Roslyn cannot catch up:
    // load everything again once things have settled (textNav.ts covers
    // navigation meanwhile). An overflow still lists the sources.
    if (change.lost) scheduleRestart(s.projectId, s.root, 3000);
    else s.fileChanges(change);
  }
}

// csharp-ls shows code from DLLs (decompiled) and from source generators under
// csharp: URIs; they open as read-only tabs (lib/buffers.ts) read with csharp/metadata.
const serverUris = new Map<string, string>();

/** A location's path in Haze: the OS path, or the csharp: URI of decompiled and generated code. */
function locationPath(uri: string): string {
  if (!uri.startsWith("csharp:")) return uriToPath(uri);
  const path = monaco.Uri.parse(uri).toString(true);
  serverUris.set(path, uri);
  return path;
}

function locationUri(uri: string): monaco.Uri {
  const path = locationPath(uri);
  return isVirtualPath(path) ? monaco.Uri.parse(path) : monaco.Uri.file(path);
}

/** A model's URI as the server wrote it. */
function serverUri(model: monaco.editor.ITextModel): string {
  if (model.uri.scheme === "file") return model.uri.toString();
  const path = model.uri.toString(true);
  return serverUris.get(path) ?? path;
}

/** The file a csharp: URI belongs to (`csharp:/…/Game.csproj/decompiled/…`), to find its session. */
const virtualOwner = (uri: monaco.Uri) => monaco.Uri.file(uri.path).fsPath;

function modelPath(model: monaco.editor.ITextModel): string | null {
  if (model.uri.scheme === "file") return model.uri.fsPath;
  return model.uri.scheme === "csharp" ? virtualOwner(model.uri) : null;
}

/** Session for a model if its server is ready for queries. */
function ready(model: monaco.editor.ITextModel): CsharpSession | undefined {
  const path = modelPath(model);
  const s = path ? sessionForPath(path) : undefined;
  return s?.usable && s.client.alive ? s : undefined;
}

/** Whether Roslyn has loaded the model's projects and answers navigation (else lib/textNav.ts guesses). */
export function csharpAnswers(model: monaco.editor.ITextModel): boolean {
  return !!ready(model)?.ready;
}

/** Session for a model's file, or an error saying why there is none. */
function requireSession(model: monaco.editor.ITextModel): CsharpSession {
  const path = modelPath(model) ?? model.uri.fsPath;
  const s = sessionForPath(path);
  if (s) return s;
  const project = useWorkspace
    .getState()
    .projects.filter((p) => p.open && isWithin(path, p.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
  const { info, csharp } = useDotnet.getState();
  const status = project && csharp[project.id];
  let why = "C# support is not running for this project";
  if (project && !info[project.id]?.projects.length) why += ": no .csproj or .sln was found in it";
  else if (project && !info[project.id]?.dotnetVersion && status?.state !== "ready")
    why += ": the .NET SDK is not installed. Install it with “Install .NET” in the run bar";
  else if (status?.state === "missing")
    why += ": no C# language server was found. Install it with “dotnet tool install --global roslyn-language-server --prerelease”, then restart C# from the run bar";
  else if (status?.message) why += `: ${status.message}`;
  throw new Error(why);
}

const docParams = (model: monaco.editor.ITextModel, position: monaco.IPosition) => ({
  textDocument: { uri: serverUri(model) },
  position: toLspPosition(position),
});

/** The declaration at a definition: from its open model, else from disk (Roslyn's metadata-as-source files too). */
async function hoverDeclaration(loc: LspLocation | undefined): Promise<Declaration | null> {
  if (!loc) return null;
  const uri = locationUri(loc.uri);
  let text = monaco.editor.getModel(uri)?.getValue();
  if (text === undefined && uri.scheme === "file") {
    const file = await api.readFile(uri.fsPath);
    if (file.kind === "text") text = file.content;
  }
  return text === undefined ? null : declarationAt(text.split(/\r?\n/), loc.range.start.line);
}

// ------------------------------------------------------------------ queries used by commands

export interface FoundLocation {
  path: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

function toFound(l: LspLocation): FoundLocation {
  const r = toMonacoRange(l.range);
  return { path: locationPath(l.uri), line: r.startLineNumber, column: r.startColumn, endLine: r.endLineNumber, endColumn: r.endColumn };
}

async function locationsQuery(method: string, model: monaco.editor.ITextModel, pos: monaco.IPosition, extra: object = {}): Promise<FoundLocation[]> {
  const s = requireSession(model);
  await s.whenReady();
  const res = await s.request<unknown>(method, { ...docParams(model, pos), ...extra });
  return toLocations(res).map(toFound);
}

export const findUsages = (model: monaco.editor.ITextModel, pos: monaco.IPosition) =>
  locationsQuery("textDocument/references", model, pos, { context: { includeDeclaration: true } });

export const findImplementations = (model: monaco.editor.ITextModel, pos: monaco.IPosition) =>
  locationsQuery("textDocument/implementation", model, pos);

export async function prepareRename(model: monaco.editor.ITextModel, pos: monaco.IPosition): Promise<{ range: monaco.IRange; placeholder: string } | null> {
  const s = requireSession(model);
  await s.whenReady();
  const res = await s
    .request<{ range?: LspRange; placeholder?: string; start?: unknown } | null>("textDocument/prepareRename", docParams(model, pos))
    .catch(() => undefined);
  if (res === null) return null;
  const word = model.getWordAtPosition(pos);
  if (res && "range" in res && res.range) {
    const range = toMonacoRange(res.range);
    return { range, placeholder: res.placeholder ?? model.getValueInRange(range) };
  }
  if (res && "start" in res) {
    const range = toMonacoRange(res as unknown as LspRange);
    return { range, placeholder: model.getValueInRange(range) };
  }
  if (!word) return null;
  return {
    range: { startLineNumber: pos.lineNumber, startColumn: word.startColumn, endLineNumber: pos.lineNumber, endColumn: word.endColumn },
    placeholder: word.word,
  };
}

export async function renameSymbol(model: monaco.editor.ITextModel, pos: monaco.IPosition, newName: string): Promise<WorkspaceEdit | null> {
  const s = requireSession(model);
  return s.request<WorkspaceEdit | null>("textDocument/rename", { ...docParams(model, pos), newName });
}

export interface WorkspaceSymbolHit {
  name: string;
  kind: number;
  container: string | null;
  path: string;
  line: number;
  column: number;
}

export async function workspaceSymbols(projectId: string, query: string): Promise<WorkspaceSymbolHit[]> {
  const s = sessions.get(projectId);
  if (!s?.usable || !query) return [];
  const res = await s.request<{ name: string; kind: number; containerName?: string; location: LspLocation | { uri: string } }[] | null>(
    "workspace/symbol",
    { query },
  );
  return (res ?? [])
    .filter((x) => "range" in x.location)
    .map((x) => {
      const l = x.location as LspLocation;
      return {
        name: x.name,
        kind: x.kind,
        container: x.containerName ?? null,
        path: locationPath(l.uri),
        line: l.range.start.line + 1,
        column: l.range.start.character + 1,
      };
    });
}

// ------------------------------------------------------------------ Monaco providers

let registered = false;

// Asks open C# editors for their semantic tokens again (projects loaded, server refresh).
const semanticTokensChanged = new monaco.Emitter<void>();

// Asks open C# editors for their Code Vision again (projects loaded: usages count now).
const codeVisionChanged = new monaco.Emitter<monaco.languages.CodeLensProvider>();
let codeVisionProvider: monaco.languages.CodeLensProvider | null = null;

function refreshCodeVision() {
  if (codeVisionProvider) codeVisionChanged.fire(codeVisionProvider);
}

/** Who wrote lines `from`..`to` of a model, for Code Vision ("aprius +2"); set by the editor, which knows git. */
type CodeVisionAuthor = (model: monaco.editor.ITextModel, from: number, to: number) => Promise<{ title: string; tooltip: string } | null>;
let codeVisionAuthor: CodeVisionAuthor | null = null;

export function setCodeVisionAuthor(f: CodeVisionAuthor): void {
  codeVisionAuthor = f;
}

// LSP SymbolKind: Class, Method, Property, Constructor, Enum, Interface, Struct, Event.
const CODE_VISION_KINDS = new Set([5, 6, 7, 9, 10, 11, 23, 24]);
// Members greyed out when nothing uses them: Method, Property, Event.
const GREY_WHEN_UNUSED = new Set([6, 7, 24]);
// Unity calls these by name, so "no usages" does not make them dead.
const UNITY_MESSAGES = new Set(
  (
    "Awake Start Update FixedUpdate LateUpdate OnEnable OnDisable OnDestroy OnValidate Reset OnGUI OnApplicationQuit " +
    "OnApplicationPause OnApplicationFocus OnBecameVisible OnBecameInvisible OnDrawGizmos OnDrawGizmosSelected " +
    "OnTriggerEnter OnTriggerExit OnTriggerStay OnTriggerEnter2D OnTriggerExit2D OnTriggerStay2D OnCollisionEnter " +
    "OnCollisionExit OnCollisionStay OnCollisionEnter2D OnCollisionExit2D OnCollisionStay2D OnControllerColliderHit " +
    "OnMouseDown OnMouseUp OnMouseUpAsButton OnMouseEnter OnMouseExit OnMouseOver OnMouseDrag OnAnimatorMove OnAnimatorIK " +
    "OnRenderObject OnWillRenderObject OnPreRender OnPostRender OnPreCull OnRenderImage OnTransformParentChanged " +
    "OnTransformChildrenChanged OnRectTransformDimensionsChange OnParticleCollision OnParticleTrigger OnJointBreak OnJointBreak2D"
  ).split(" "),
);

/** Line Code Vision sits above: the name's, or the attributes just over it. */
function declarationLine(model: monaco.editor.ITextModel, range: monaco.IRange, name: monaco.IRange): number {
  let line = name.startLineNumber;
  while (line > range.startLineNumber && model.getLineContent(line - 1).trimStart().startsWith("[")) line--;
  return line;
}

/** Whether a member with no usages is dead, and so greyed: private, no attribute, not called by name by Unity or an interface. */
function deadWhenUnused(model: monaco.editor.ITextModel, kind: number, name: string, declStart: number, nameLine: number, nameColumn: number): boolean {
  if (!GREY_WHEN_UNUSED.has(kind) || name.includes(".") || UNITY_MESSAGES.has(name)) return false;
  const head = model.getValueInRange(new monaco.Range(declStart, 1, nameLine, nameColumn));
  return !/\[|\b(public|protected|internal|override|abstract|virtual|extern|partial)\b/.test(head);
}

/** Removes every grey (Code Vision turned off: nothing keeps it current any more). */
export function clearUnusedMarks(): void {
  for (const m of monaco.editor.getModels()) pruneUnused(m, new Set());
}

// The grey on unused members, per model and symbol, kept in step with Code Vision.
const unusedMarks = new WeakMap<monaco.editor.ITextModel, Map<string, string>>();

function markUnused(model: monaco.editor.ITextModel, key: string, range: monaco.IRange | null) {
  let marks = unusedMarks.get(model);
  if (!marks) unusedMarks.set(model, (marks = new Map()));
  const old = marks.get(key);
  const [id] = model.deltaDecorations(old ? [old] : [], range ? [{ range, options: { inlineClassName: "unused-symbol", stickiness: 1 } }] : []);
  if (id) marks.set(key, id);
  else marks.delete(key);
}

/** Drops the grey of symbols that are gone (renamed, deleted, or Code Vision off). */
function pruneUnused(model: monaco.editor.ITextModel, keep: Set<string>) {
  const marks = unusedMarks.get(model);
  if (!marks) return;
  for (const [key, id] of marks) {
    if (keep.has(key)) continue;
    model.deltaDecorations([id], []);
    marks.delete(key);
  }
}

type DefinitionFallback = (
  model: monaco.editor.ITextModel,
  position: monaco.IPosition,
  token: monaco.CancellationToken,
) => Promise<monaco.languages.Location[] | null>;
let definitionFallback: DefinitionFallback | null = null;

/** Asked when Roslyn finds no definition (lib/textNav.ts; set there to keep this module free of it). */
export function setDefinitionFallback(f: DefinitionFallback): void {
  definitionFallback = f;
}

interface LspCodeAction {
  title: string;
  kind?: string;
  edit?: WorkspaceEdit;
  command?: { command: string; arguments?: unknown[]; title: string };
  data?: unknown;
  isPreferred?: boolean;
}

async function runCodeAction(session: CsharpSession, action: LspCodeAction) {
  let a = action;
  if (!a.edit && a.data !== undefined) a = await session.request<LspCodeAction>("codeAction/resolve", action);
  if (a.edit) await applyWorkspaceEdit(a.edit);
  if (a.command) await session.request("workspace/executeCommand", { command: a.command.command, arguments: a.command.arguments });
}

/** Each model's version after its last edit that was not typing (an accepted completion, a paste), when it has no ghost text. */
const untyped = new WeakMap<monaco.editor.ITextModel, number>();

export function registerProviders(): void {
  if (registered) return;
  registered = true;
  const L = monaco.languages;

  const watchEdits = (m: monaco.editor.ITextModel) =>
    m.onDidChangeContent((e) => {
      if (m.getLanguageId() !== "csharp") return;
      bumpVisionGeneration();
      if (!typedEdit(e.changes)) untyped.set(m, e.versionId);
    });
  monaco.editor.getModels().forEach(watchEdits);
  monaco.editor.onDidCreateModel((m) => {
    watchEdits(m);
    // Models get their language right after creation.
    setTimeout(() => {
      const path = modelPath(m);
      if (path) sessionForPath(path)?.syncModel(m);
    }, 0);
  });

  setVirtualSource(async (path) => {
    const s = sessionForPath(virtualOwner(monaco.Uri.parse(path)));
    if (!s?.usable || !s.client.alive) throw new Error("C# support is not running for this project");
    const res = await s.request<{ source?: string } | null>("csharp/metadata", { textDocument: { uri: serverUris.get(path) ?? path } });
    if (typeof res?.source !== "string") throw new Error("The C# server has no source for this code");
    return res.source;
  });

  monaco.editor.onDidChangeMarkers((uris) => {
    for (const uri of uris) {
      const model = monaco.editor.getModel(uri);
      const path = model && modelPath(model);
      if (path) sessionForPath(path)?.buildMarkersChanged(model);
    }
  });

  monaco.editor.registerCommand("haze.applyCodeAction", (_accessor, path: string, action: LspCodeAction) => {
    const s = sessionForPath(path);
    if (s) void runCodeAction(s, action).catch((e) => console.error("code action failed", e));
  });

  L.registerDefinitionProvider("csharp", {
    async provideDefinition(model, position, token) {
      const s = ready(model);
      if (!s) return null;
      const res = await s.request<unknown>("textDocument/definition", docParams(model, position), token).catch(() => null);
      const found = toLocations(res).map((l) => ({ uri: locationUri(l.uri), range: toMonacoRange(l.range) }));
      if (found.length || token.isCancellationRequested || !s.ready) return found;
      return (await definitionFallback?.(model, position, token)) ?? [];
    },
  });

  // Ctrl+Click on a declaration falls back to Go to References (Monaco's
  // alternativeDefinitionCommand), which lists the usages in a popup (see
  // installResultLists in EditorArea).
  L.registerReferenceProvider("csharp", {
    async provideReferences(model, position, context, token) {
      const s = ready(model);
      if (!s) return null;
      const res = await s.request<unknown>(
        "textDocument/references",
        { ...docParams(model, position), context: { includeDeclaration: context.includeDeclaration } },
        token,
      );
      return toLocations(res).map((l) => ({ uri: locationUri(l.uri), range: toMonacoRange(l.range) }));
    },
  });

  L.registerHoverProvider("csharp", {
    async provideHover(model, position, token) {
      const s = ready(model);
      if (!s) return null;
      // The declaration fills in what Roslyn's hover leaves out (see hoverDoc.ts).
      const [res, decl] = await Promise.all([
        s.request<{ contents: unknown; range?: LspRange } | null>("textDocument/hover", docParams(model, position), token),
        s
          .request<unknown>("textDocument/definition", docParams(model, position), token)
          .then((d) => hoverDeclaration(toLocations(d)[0]))
          .catch(() => null),
      ]);
      if (!res) return null;
      const value = markupToString(res.contents);
      if (!value) return null;
      // supportHtml: the docs table and the codicons in the "in class Player" line.
      const contents = buildHover(value, decl).map((part) => ({ value: part, supportHtml: true }));
      return { contents, range: res.range ? toMonacoRange(res.range) : undefined };
    },
  });

  L.registerDocumentHighlightProvider("csharp", {
    async provideDocumentHighlights(model, position, token) {
      const s = ready(model);
      if (!s) return null;
      const res = await s.request<{ range: LspRange; kind?: number }[] | null>("textDocument/documentHighlight", docParams(model, position), token);
      return (res ?? []).map((h) => ({ range: toMonacoRange(h.range), kind: ((h.kind ?? 1) - 1) as monaco.languages.DocumentHighlightKind }));
    },
  });

  interface LspDocSymbol {
    name: string;
    detail?: string;
    kind: number;
    range: LspRange;
    selectionRange: LspRange;
    children?: LspDocSymbol[];
  }
  const toDocSymbol = (d: LspDocSymbol): monaco.languages.DocumentSymbol => ({
    name: d.name,
    detail: d.detail ?? "",
    kind: toSymbolKind(d.kind),
    tags: [],
    range: toMonacoRange(d.range),
    selectionRange: toMonacoRange(d.selectionRange),
    children: (d.children ?? []).map(toDocSymbol),
  });
  L.registerDocumentSymbolProvider("csharp", {
    displayName: "C#",
    async provideDocumentSymbols(model, token) {
      const s = ready(model);
      if (!s) return null;
      const res = await s.request<LspDocSymbol[] | null>("textDocument/documentSymbol", { textDocument: { uri: serverUri(model) } }, token);
      return (res ?? []).filter((d) => "selectionRange" in d).map(toDocSymbol);
    },
  });

  // Code Vision: "3 usages | aprius +1" above types and members. Lenses are
  // resolved only when scrolled into view, so a long file asks only for what is shown.
  // In Unity projects also "Event function", "2 asset usages" and "Run" for tests (see unityLenses).
  // Types and members come from Haze's own parse (syntax.rs), so lenses show as a file opens:
  // the server's symbols wait for its projects to load (csharp-ls's, for them to compile).
  interface Vision {
    kind: "usages" | "author" | "unity";
    symbol: number;
    name: string;
    key: string;
    /** Survives edits that move it (no line): "Game.Player/6:Jump#0", for the answer cache. */
    stable: string;
    nameRange: monaco.IRange;
    end: number;
    /** The model version the lens was made for. */
    version: number;
  }
  type VisionLens = monaco.languages.CodeLens & { vision: Vision };
  // Unity's answers (base classes, asset usages, test results) arrive later than Roslyn's.
  setVisionRefresh(refreshCodeVision);
  onUnityCodeChanged(refreshCodeVision);

  // The outline of a model's current text: parsed again only after an edit (Code Vision redraws often).
  const outlineCache = new WeakMap<monaco.editor.ITextModel, { version: number; symbols: Promise<OutlineSymbol[]> }>();
  const outline = (model: monaco.editor.ITextModel): Promise<OutlineSymbol[]> => {
    const version = model.getVersionId();
    const hit = outlineCache.get(model);
    if (hit?.version === version) return hit.symbols;
    const symbols = api.csharpOutline(model.getValue()).catch(() => {
      // A failed parse is not kept.
      if (outlineCache.get(model)?.symbols === symbols) outlineCache.delete(model);
      return [];
    });
    outlineCache.set(model, { version, symbols });
    return symbols;
  };

  interface LspCodeLens {
    range: LspRange;
    command?: { title: string };
    data?: unknown;
  }
  // The server's own code lenses of a model's current text, for their usage counts.
  const serverLensCache = new WeakMap<monaco.editor.ITextModel, { session: CsharpSession; version: number; lenses: Promise<LspCodeLens[] | null> }>();
  const serverLenses = (s: CsharpSession, model: monaco.editor.ITextModel): Promise<LspCodeLens[] | null> => {
    const version = model.getVersionId();
    const hit = serverLensCache.get(model);
    if (hit?.session === s && hit.version === version) return hit.lenses;
    const lenses = s.request<LspCodeLens[] | null>("textDocument/codeLens", { textDocument: { uri: model.uri.toString() } }).catch(() => null);
    serverLensCache.set(model, { session: s, version, lenses });
    return lenses;
  };

  /**
   * The usages the server's code lens on the name at `at` counts: Roslyn counts
   * them in about a millisecond, and takes half a second to list the references.
   * Undefined when it has no lens there or does not say.
   */
  const lensCount = async (s: CsharpSession, model: monaco.editor.ITextModel, at: monaco.IPosition): Promise<number | undefined> => {
    const line = at.lineNumber - 1;
    const character = at.column - 1;
    // Asked again once: Roslyn forgets the lenses of a document whose project reloaded.
    for (let attempt = 0; attempt < 2; attempt++) {
      const lenses = serverLenses(s, model);
      const lens = (await lenses)?.find((l) => l.range.start.line === line && l.range.start.character === character && !l.command);
      if (!lens) return undefined;
      const resolved = await s.request<LspCodeLens | null>("codeLens/resolve", lens).catch(() => null);
      // "5 references", "99+ references", in the server's language.
      const n = /\d+/.exec(resolved?.command?.title ?? "");
      if (n) return Number(n[0]);
      if (serverLensCache.get(model)?.lenses === lenses) serverLensCache.delete(model);
    }
    return undefined;
  };

  useUnity.subscribe((s, prev) => {
    if (Object.keys(s.projects).some((id) => s.projects[id]?.tests.results !== prev.projects[id]?.tests.results)) refreshCodeVision();
  });
  codeVisionProvider = {
    onDidChange: codeVisionChanged.event,
    async provideCodeLenses(model, token) {
      if (model.uri.scheme !== "file") return null;
      // Usage counts once C# starts for the project (until the server answers, those from before).
      const counts = !!sessionForPath(model.uri.fsPath);
      if (!counts && !unityRootFor(model.uri.fsPath)) return null;
      const version = model.getVersionId();
      const res = await outline(model);
      if (token.isCancellationRequested || model.isDisposed() || model.getVersionId() !== version) return null;
      const lenses: VisionLens[] = [];
      const unity = unityContext(model, res);
      const seen = new Map<string, number>();
      const walk = (ds: OutlineSymbol[], parents: OutlineSymbol[]) => {
        for (const d of ds) {
          if (CODE_VISION_KINDS.has(d.kind)) {
            const r = toMonacoRange(d.range);
            const sel = toMonacoRange(d.selectionRange);
            const line = declarationLine(model, r, sel);
            const range = new monaco.Range(line, 1, line, 1);
            // Overloads share a name: told apart by their order in the file.
            const base = `${parents.map((p) => p.name).join(".")}/${d.kind}:${d.name}`;
            const nth = seen.get(base) ?? 0;
            seen.set(base, nth + 1);
            const vision = { symbol: d.kind, name: d.name, key: `${d.kind}:${d.name}:${sel.startLineNumber}`, stable: `${base}#${nth}`, nameRange: sel, end: r.endLineNumber, version };
            const extra = unity ? unityLenses(model, unity, d, parents, range, sel) : null;
            // An event function is called by Unity, not by code: no "no usages", never greyed.
            if (extra?.eventFunction) lenses.push({ range, vision: { ...vision, kind: "unity" }, command: extra.eventFunction });
            else if (counts) lenses.push({ range, vision: { kind: "usages", ...vision } });
            for (const command of extra?.more ?? []) lenses.push({ range, vision: { ...vision, kind: "unity" }, command });
            if (codeVisionAuthor) lenses.push({ range, vision: { kind: "author", ...vision } });
          }
          walk(d.children, [...parents, d]);
        }
      };
      walk(res, []);
      pruneUnused(model, new Set(lenses.map((l) => l.vision.key)));
      return { lenses, dispose() {} };
    },
    // Answered from visionCache.ts at once when possible; the server and git are asked in the background.
    async resolveCodeLens(model, lens) {
      const { vision: v } = lens as VisionLens;
      if (v.kind === "unity") return lens;
      const key = `${model.uri.fsPath}\n${v.stable}\n${v.kind}`;
      const empty = { ...lens, command: { id: "", title: "" } };
      if (v.kind === "author") {
        const from = lens.range.startLineNumber;
        const a = await visionAnswer(key, async () => {
          // No blame (a new file) is an answer too: empty, not asked again until something changes.
          const r = await codeVisionAuthor?.(model, from, v.end);
          return { title: r?.title ?? "", tooltip: r?.tooltip, real: true };
        });
        return a ? { ...lens, command: { id: "", title: a.title, tooltip: a.tooltip } } : empty;
      }
      const at = { lineNumber: v.nameRange.startLineNumber, column: v.nameRange.startColumn };
      const s = ready(model);
      const count = async (): Promise<VisionAnswer | null> => {
        // Edited since: the name may have moved, and Monaco asks again for the new text.
        if (!s || model.isDisposed() || model.getVersionId() !== v.version) return null;
        const loaded = s.ready;
        // Roslyn's lens also counts an override's calls through the base member (like Visual Studio's
        // CodeLens), which the usages list it opens leaves out; csharp-ls lists references quickly anyway.
        const viaLens =
          s.kind === "roslyn" &&
          !!s.caps.codeLensProvider?.resolveProvider &&
          !/\boverride\b/.test(model.getValueInRange(new monaco.Range(lens.range.startLineNumber, 1, at.lineNumber, at.column)));
        let n = viaLens ? await lensCount(s, model, at) : undefined;
        if (n === undefined) {
          const res = await s.request<unknown>("textDocument/references", { ...docParams(model, at), context: { includeDeclaration: false } });
          n = toLocations(res ?? null).length;
        }
        // Edited while counting: the position may be another name's by now.
        if (model.getVersionId() !== v.version) return null;
        return { title: n === 0 ? "no usages" : n === 1 ? "1 usage" : `${n} usages`, n, real: loaded };
      };
      // Until the projects load, the server counts too few (and before it starts, nothing):
      // a count from before (this session or the last) stays.
      const a = await visionAnswer(key, count, !!s?.ready);
      if (!a) return empty;
      // Only a real answer from loaded projects may grey a name.
      if (a.real && !model.isDisposed())
        markUnused(model, v.key, a.n === 0 && deadWhenUnused(model, v.symbol, v.name, lens.range.startLineNumber, at.lineNumber, at.column) ? v.nameRange : null);
      return { ...lens, command: { id: "haze.codeVisionUsages", title: a.title, arguments: [model.uri.fsPath, at.lineNumber, at.column, v.name] } };
    },
  };
  L.registerCodeLensProvider("csharp", codeVisionProvider);

  interface UnityContext {
    root: string;
    projectId: string | null;
    path: string;
    /** Namespace declarations by line, first to last. */
    namespaces: { line: number; name: string }[];
    /** Asset usages of this script and its classes' methods; null while the index loads. */
    assets: ReturnType<typeof assetUsagesFor>;
  }

  function unityContext(model: monaco.editor.ITextModel, symbols: OutlineSymbol[]): UnityContext | null {
    const path = model.uri.fsPath;
    const root = unityRootFor(path);
    if (!root) return null;
    const classes: string[] = [];
    const collect = (ds: OutlineSymbol[]) => ds.forEach((d) => (d.kind === 5 && classes.push(typeName(d.name)), collect(d.children)));
    collect(symbols);
    const projectId = Object.entries(useUnity.getState().projects).find(([, u]) => u.root === root)?.[0] ?? null;
    const namespaces = model
      .findMatches("^\\s*namespace\\s+([\\w.]+)", false, true, true, null, true)
      .map((m) => ({ line: m.range.startLineNumber, name: m.matches?.[1] ?? "" }));
    return { root, projectId, path, namespaces, assets: classes.length ? assetUsagesFor(root, path, classes) : null };
  }

  const plural = (n: number, one: string) => (n === 1 ? `1 ${one}` : `${n} ${one}s`);

  /** The aggregate result of the tests matching a pattern: failed wins, then running, then passed. */
  function testsStatus(projectId: string | null, pattern: string): { title: string; tooltip: string } | null {
    const results = projectId ? useUnity.getState().projects[projectId]?.tests.results : undefined;
    if (!results) return null;
    const re = new RegExp(pattern);
    const hits: TestResult[] = Object.values(results).filter((r) => re.test(r.fullName));
    if (!hits.length) return null;
    const failed = hits.filter((r) => r.status === "failed");
    if (failed.length) return { title: hits.length > 1 ? `✗ ${failed.length}/${hits.length} failed` : "✗ failed", tooltip: failed[0].message ?? "Failed" };
    if (hits.some((r) => r.status === "running")) return { title: "… running", tooltip: "Running in Unity" };
    if (hits.every((r) => r.status === "passed")) {
      const ms = hits.reduce((n, r) => n + r.duration, 0);
      return { title: hits.length > 1 ? `✓ ${hits.length} passed` : "✓ passed", tooltip: `${Math.round(ms)} ms` };
    }
    return { title: hits.some((r) => r.status === "skipped") ? "skipped" : "inconclusive", tooltip: hits[0].message ?? "" };
  }

  /** Unity Code Vision for a type or member of a Unity script. */
  function unityLenses(
    model: monaco.editor.ITextModel,
    u: UnityContext,
    d: OutlineSymbol,
    parents: OutlineSymbol[],
    range: monaco.IRange,
    sel: monaco.IRange,
  ): { eventFunction?: monaco.languages.Command; more: monaco.languages.Command[] } {
    const more: monaco.languages.Command[] = [];
    const name = d.name;
    const classes = [...parents.filter((p) => p.kind === 5).map((p) => p.name), ...(d.kind === 5 ? [d.name] : [])];
    const namespace = u.namespaces.filter((n) => n.line <= sel.startLineNumber).pop()?.name ?? "";
    const fixture = classes.length ? fixtureName(namespace, classes) : "";
    const runTests = (pattern: string, label: string) => {
      more.push({ id: "haze.unityRunTests", title: "▶ Run", tooltip: `Run ${label} in Unity`, arguments: [u.path, pattern, label] });
      const status = testsStatus(u.projectId, pattern);
      if (status) more.push({ id: "haze.unityShowTests", title: status.title, tooltip: status.tooltip, arguments: [u.path] });
    };

    if (d.kind === 5) {
      const base = unityBaseFor(u.root, typeName(d.name));
      if ((base === "MonoBehaviour" || base === "ScriptableObject") && u.assets) {
        const n = u.assets.scripts.length;
        more.push(
          n
            ? { id: "haze.unityAssetUsages", title: plural(n, "asset usage"), tooltip: "Scenes, prefabs and assets using this script", arguments: [u.path, `Asset usages of ${name}`, u.assets.scripts] }
            : { id: "", title: "no asset usages" },
        );
      }
      // A fixture: a class with a test method among its own members.
      const hasTests = d.children.some((c) => c.kind === 6 && isTestHead(model.getValueInRange({ ...toMonacoRange(c.range), endLineNumber: toMonacoRange(c.selectionRange).startLineNumber, endColumn: toMonacoRange(c.selectionRange).startColumn })));
      if (hasTests) runTests(testPattern(fixture), name);
      return { more };
    }
    if (d.kind !== 6) return { more };
    const owner = parents.filter((p) => p.kind === 5).pop();
    const base = owner ? unityBaseFor(u.root, typeName(owner.name)) : null;
    const msg = base ? unityMessage(base, name) : undefined;
    const eventFunction = msg ? { id: "", title: "Event function", tooltip: `Unity ${base} message: ${msg.description}` } : undefined;
    const calls = u.assets?.methods[name];
    if (calls?.length)
      more.push({ id: "haze.unityAssetUsages", title: plural(calls.length, "asset usage"), tooltip: "UnityEvents calling this method", arguments: [u.path, `Asset usages of ${name}`, calls] });
    const head = model.getValueInRange({ startLineNumber: range.startLineNumber, startColumn: 1, endLineNumber: sel.startLineNumber, endColumn: sel.startColumn });
    if (fixture && isTestHead(head)) runTests(testPattern(fixture, name), `${name}`);
    return { eventFunction, more };
  }

  type HazeCompletion = monaco.languages.CompletionItem & { lsp: LspCompletionItem; path: string };
  L.registerCompletionItemProvider("csharp", {
    triggerCharacters: [".", "<", " ", "(", "[", ":", "\"", "#"],
    async provideCompletionItems(model, position, context, token) {
      const s = ready(model);
      // Generate lists Unity's event functions alone (lib/unity/generate.ts).
      if (!s || unityGenerateActive()) return { suggestions: [] };
      const res = await s.request<{ items: LspCompletionItem[]; isIncomplete?: boolean } | LspCompletionItem[] | null>(
        "textDocument/completion",
        {
          ...docParams(model, position),
          context: context.triggerCharacter ? { triggerKind: 2, triggerCharacter: context.triggerCharacter } : { triggerKind: 1 },
        },
        token,
      );
      const items = Array.isArray(res) ? res : (res?.items ?? []);
      const word = model.getWordUntilPosition(position);
      const fallback = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, position.column);
      const suggestions: HazeCompletion[] = items.map((it) => {
        const editRange = it.textEdit?.range ?? it.textEdit?.insert;
        return {
          label: it.label,
          kind: toCompletionKind(it.kind),
          detail: it.detail,
          documentation: it.documentation ? { value: markupToString(it.documentation) } : undefined,
          sortText: it.sortText,
          filterText: it.filterText,
          preselect: it.preselect,
          // Roslyn leaves the usual commit characters off each item for the client to take from its capabilities:
          // `Debug.Lo` then `(` gives `Debug.Log(`, as in Rider. An empty list (a new name being typed) commits only on Tab/Enter.
          commitCharacters: it.commitCharacters ?? s.caps.completionProvider?.allCommitCharacters,
          insertText: it.textEdit?.newText ?? it.insertText ?? it.label,
          insertTextRules: it.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
          range: editRange ? toMonacoRange(editRange) : fallback,
          additionalTextEdits: it.additionalTextEdits?.map((e) => ({ range: toMonacoRange(e.range), text: e.newText })),
          lsp: it,
          path: model.uri.fsPath,
        };
      });
      return { suggestions, incomplete: !Array.isArray(res) && !!res?.isIncomplete };
    },
    async resolveCompletionItem(item, token) {
      const h = item as HazeCompletion;
      const s = sessionForPath(h.path);
      if (!s?.usable || !s.caps.completionProvider?.resolveProvider) return item;
      const r = await s.request<LspCompletionItem>("completionItem/resolve", h.lsp, token).catch(() => null);
      if (!r) return item;
      return {
        ...item,
        detail: r.detail ?? item.detail,
        documentation: r.documentation ? { value: markupToString(r.documentation) } : item.documentation,
        additionalTextEdits: r.additionalTextEdits?.map((e) => ({ range: toMonacoRange(e.range), text: e.newText })) ?? item.additionalTextEdits,
      };
    },
  });

  // Ghost text: the rest of Roslyn's best completion for the word being typed; Tab accepts it.
  L.registerInlineCompletionsProvider("csharp", {
    debounceDelayMs: 100,
    async provideInlineCompletions(model, position, _context, token) {
      const s = ready(model);
      const word = model.getWordUntilPosition(position);
      // Not in the middle of a word.
      const next = model.getLineContent(position.lineNumber).charAt(position.column - 1);
      // Not right after a completion was accepted either: `GameObject` taken with Tab would offer `GameObjectUtility`.
      if (!s || word.word.length < MIN_PREFIX || /\w/.test(next) || untyped.get(model) === model.getVersionId()) return { items: [] };
      const res = await s
        .request<{ items: LspCompletionItem[] } | LspCompletionItem[] | null>("textDocument/completion", { ...docParams(model, position), context: { triggerKind: 1 } }, token)
        .catch(() => null);
      const items = Array.isArray(res) ? res : (res?.items ?? []);
      const pick = pickInline(items, word.word, position.lineNumber - 1, word.startColumn - 1, position.column - 1);
      if (!pick || token.isCancellationRequested) return { items: [] };
      // Edits such as a `using` for a type from another namespace often come only with the resolved item.
      const resolved = s.caps.completionProvider?.resolveProvider
        ? await s.request<LspCompletionItem>("completionItem/resolve", pick.item, token).catch(() => null)
        : null;
      const edits = resolved?.additionalTextEdits ?? pick.item.additionalTextEdits;
      return {
        items: [
          {
            insertText: pick.text,
            range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, position.column),
            additionalTextEdits: edits?.map((e) => ({ range: toMonacoRange(e.range), text: e.newText })),
          },
        ],
      };
    },
    disposeInlineCompletions() {},
  });

  L.registerSignatureHelpProvider("csharp", {
    signatureHelpTriggerCharacters: ["(", ","],
    signatureHelpRetriggerCharacters: [","],
    async provideSignatureHelp(model, position, token) {
      const s = ready(model);
      if (!s) return null;
      const res = await s.request<{
        signatures: { label: string; documentation?: unknown; parameters?: { label: string | [number, number]; documentation?: unknown }[] }[];
        activeSignature?: number;
        activeParameter?: number;
      } | null>("textDocument/signatureHelp", docParams(model, position), token);
      if (!res?.signatures?.length) return null;
      return {
        value: {
          signatures: res.signatures.map((sig) => ({
            label: sig.label,
            documentation: sig.documentation ? { value: markupToString(sig.documentation) } : undefined,
            parameters: (sig.parameters ?? []).map((p) => ({
              label: p.label,
              documentation: p.documentation ? { value: markupToString(p.documentation) } : undefined,
            })),
          })),
          activeSignature: res.activeSignature ?? 0,
          activeParameter: res.activeParameter ?? 0,
        },
        dispose() {},
      };
    },
  });

  L.registerCodeActionProvider("csharp", {
    async provideCodeActions(model, range, _context, token) {
      const s = ready(model);
      if (!s || model.uri.scheme !== "file") return { actions: [], dispose() {} };
      const lspRange = toLspRange(range);
      const diagnostics = s.diagnosticsAt(model, lspRange);
      const res = await s.request<LspCodeAction[] | null>(
        "textDocument/codeAction",
        { textDocument: { uri: serverUri(model) }, range: lspRange, context: { diagnostics } },
        token,
      );
      const actions: monaco.languages.CodeAction[] = (res ?? []).map((a) => ({
        title: a.title,
        // Everything is offered as a quick fix so Alt+Enter lists all of it.
        kind: "quickfix",
        // "using UnityEngine;" first for a missing namespace, as in Rider.
        isPreferred: a.isPreferred || isImportFix(a.title),
        command: { id: "haze.applyCodeAction", title: a.title, arguments: [model.uri.fsPath, a] },
      }));
      return { actions, dispose() {} };
    },
  });

  // Colours by meaning, once the projects are loaded (before
  // that Roslyn knows no symbols and would undo the grammar's guesses).
  const semanticSession = (model: monaco.editor.ITextModel) => {
    const s = ready(model);
    return s?.ready && s.semanticTokens ? s : undefined;
  };
  L.registerDocumentSemanticTokensProvider("csharp", {
    onDidChange: semanticTokensChanged.event,
    getLegend: () => SEMANTIC_LEGEND,
    async provideDocumentSemanticTokens(model, _lastResultId, token) {
      const s = semanticSession(model);
      if (!s?.caps.semanticTokensProvider?.full) return null;
      const res = await s.request<{ data: number[] } | null>("textDocument/semanticTokens/full", { textDocument: { uri: serverUri(model) } }, token);
      return res ? { data: s.semanticTokens!(res.data) } : null;
    },
    releaseDocumentSemanticTokens() {},
  });
  L.registerDocumentRangeSemanticTokensProvider("csharp", {
    onDidChange: semanticTokensChanged.event,
    getLegend: () => SEMANTIC_LEGEND,
    async provideDocumentRangeSemanticTokens(model, range, token) {
      const s = semanticSession(model);
      if (!s?.caps.semanticTokensProvider?.range) return null;
      const res = await s.request<{ data: number[] } | null>(
        "textDocument/semanticTokens/range",
        { textDocument: { uri: serverUri(model) }, range: toLspRange(range) },
        token,
      );
      return res ? { data: s.semanticTokens!(res.data) } : null;
    },
  });

  L.registerDocumentFormattingEditProvider("csharp", {
    async provideDocumentFormattingEdits(model, options, token) {
      const s = ready(model);
      if (!s) return null;
      const res = await s.request<LspTextEdit[] | null>(
        "textDocument/formatting",
        { textDocument: { uri: serverUri(model) }, options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces } },
        token,
      );
      return (res ?? []).map((e) => ({ range: toMonacoRange(e.range), text: e.newText }));
    },
  });
}
