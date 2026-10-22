// C# language support through Roslyn's language server: one session per open
// project, kept in sync with the editor's models, feeding Monaco providers.
//
// Diagnostics are deliberately never requested from the server: errors come
// only from real builds (store/dotnet.ts), so nothing "phantom" shows up.
import { errorMessage, type FsChange } from "../ipc";
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
import { MIN_PREFIX, pickInline, type LspCompletionItem } from "./inline";
import { SEMANTIC_LEGEND, semanticTranslator, type LspSemanticLegend } from "./semantic";

// What Roslyn reloads on: sources, project files and restore output. Other
// JSON (Unity's Library writes plenty) would only be parsed and dropped.
const WATCHED = /(\.(cs|csx|razor|cshtml|csproj|props|targets|sln|slnx|editorconfig)|[\\/](project\.assets|global)\.json)$/i;

interface ServerCapabilities {
  textDocumentSync?: number | { change?: number };
  completionProvider?: { triggerCharacters?: string[]; resolveProvider?: boolean };
  signatureHelpProvider?: { triggerCharacters?: string[] };
  semanticTokensProvider?: { legend: LspSemanticLegend; full?: boolean | object; range?: boolean };
  [k: string]: unknown;
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
        },
        textDocument: {
          synchronization: { didSave: true, dynamicRegistration: false },
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
    const legend = this.caps.semanticTokensProvider?.legend;
    if (legend) this.semanticTokens = semanticTranslator(legend);
    await this.client.notify("initialized", {});
    this.usable = true;
    setCsharpStatus(this.projectId, { state: "loading", kind: this.kind, message: "Loading projects…" });
    // csharp-ls has no "projects loaded" notification; it answers once ready.
    if (this.kind !== "roslyn") this.markReady();
    this.syncAllModels();
  }

  private installHandlers() {
    const c = this.client;
    c.onRequest("workspace/configuration", (p) => ((p as { items: unknown[] }).items ?? []).map(() => null));
    c.onRequest("workspace/applyEdit", async (p) => {
      await applyWorkspaceEdit((p as { edit: WorkspaceEdit }).edit);
      return { applied: true };
    });
    c.onRequest("workspace/semanticTokens/refresh", () => {
      semanticTokensChanged.fire();
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
      if (!this.disposed) {
        setCsharpStatus(this.projectId, { state: "stopped", kind: this.kind, message: exitMessage(reason) });
        this.onCrash?.();
      }
    });
  }

  private markReady(message?: string) {
    if (this.ready) return;
    this.ready = true;
    setCsharpStatus(this.projectId, { state: "ready", kind: this.kind, message });
    this.readyWaiters.splice(0).forEach((r) => r());
    semanticTokensChanged.fire();
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
    if (!this.client?.alive || model.uri.scheme !== "file" || model.getLanguageId() !== "csharp") return;
    const path = model.uri.fsPath;
    const uri = model.uri.toString();
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
    });
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

  async stop(): Promise<void> {
    this.disposed = true;
    this.synced.forEach((d) => d.dispose());
    this.synced.clear();
    if (this.client) await this.client.shutdown();
    setCsharpStatus(this.projectId, { state: "off" });
  }

  request<T>(method: string, params: unknown, token?: monaco.CancellationToken): Promise<T> {
    return this.client.request<T>(method, params, token);
  }
}

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
  try {
    await s.start();
    if (!s.client) {
      sessions.delete(projectId);
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
  for (const s of sessions.values()) {
    if (!isWithin(change.root, s.root) && !isWithin(s.root, change.root)) continue;
    // Lost events leave no list of what changed, so Roslyn cannot catch up:
    // load everything again once things have settled (textNav.ts covers
    // navigation meanwhile). An overflow still lists the sources.
    if (change.lost) scheduleRestart(s.projectId, s.root, 3000);
    else s.fileChanges(change);
  }
}

/** Session for a model if its server is ready for queries. */
function ready(model: monaco.editor.ITextModel): CsharpSession | undefined {
  if (model.uri.scheme !== "file") return undefined;
  const s = sessionForPath(model.uri.fsPath);
  return s?.usable && s.client.alive ? s : undefined;
}

/** Whether Roslyn has loaded the model's projects and answers navigation (else lib/textNav.ts guesses). */
export function csharpAnswers(model: monaco.editor.ITextModel): boolean {
  return !!ready(model)?.ready;
}

/** Session for a model's file, or an error saying why there is none. */
function requireSession(model: monaco.editor.ITextModel): CsharpSession {
  const s = sessionForPath(model.uri.fsPath);
  if (s) return s;
  const project = useWorkspace
    .getState()
    .projects.filter((p) => p.open && isWithin(model.uri.fsPath, p.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
  const { info, csharp } = useDotnet.getState();
  const status = project && csharp[project.id];
  let why = "C# support is not running for this project";
  if (project && !info[project.id]?.projects.length) why += ": no .csproj or .sln was found in it";
  else if (status?.state === "missing")
    why += ": no C# language server was found. Install it with “dotnet tool install --global roslyn-language-server --prerelease”, then restart C# from the run bar";
  else if (status?.message) why += `: ${status.message}`;
  throw new Error(why);
}

const docParams = (model: monaco.editor.ITextModel, position: monaco.IPosition) => ({
  textDocument: { uri: model.uri.toString() },
  position: toLspPosition(position),
});

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
  return { path: uriToPath(l.uri), line: r.startLineNumber, column: r.startColumn, endLine: r.endLineNumber, endColumn: r.endColumn };
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
        path: uriToPath(l.uri),
        line: l.range.start.line + 1,
        column: l.range.start.character + 1,
      };
    });
}

// ------------------------------------------------------------------ Monaco providers

let registered = false;

// Asks open C# editors for their semantic tokens again (projects loaded, server refresh).
const semanticTokensChanged = new monaco.Emitter<void>();

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

export function registerProviders(): void {
  if (registered) return;
  registered = true;
  const L = monaco.languages;

  monaco.editor.onDidCreateModel((m) => {
    // Models get their language right after creation.
    setTimeout(() => sessionForPath(m.uri.fsPath)?.syncModel(m), 0);
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
      const found = toLocations(res).map((l) => ({ uri: monaco.Uri.file(uriToPath(l.uri)), range: toMonacoRange(l.range) }));
      if (found.length || token.isCancellationRequested || !s.ready) return found;
      return (await definitionFallback?.(model, position, token)) ?? [];
    },
  });

  // Ctrl+Click on a declaration falls back to Go to References (Monaco's
  // alternativeDefinitionCommand), which lists the usages like Rider.
  L.registerReferenceProvider("csharp", {
    async provideReferences(model, position, context, token) {
      const s = ready(model);
      if (!s) return null;
      const res = await s.request<unknown>(
        "textDocument/references",
        { ...docParams(model, position), context: { includeDeclaration: context.includeDeclaration } },
        token,
      );
      return toLocations(res).map((l) => ({ uri: monaco.Uri.file(uriToPath(l.uri)), range: toMonacoRange(l.range) }));
    },
  });

  L.registerHoverProvider("csharp", {
    async provideHover(model, position, token) {
      const s = ready(model);
      if (!s) return null;
      const res = await s.request<{ contents: unknown; range?: LspRange } | null>("textDocument/hover", docParams(model, position), token);
      if (!res) return null;
      const value = markupToString(res.contents);
      return value ? { contents: [{ value }], range: res.range ? toMonacoRange(res.range) : undefined } : null;
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
      const res = await s.request<LspDocSymbol[] | null>("textDocument/documentSymbol", { textDocument: { uri: model.uri.toString() } }, token);
      return (res ?? []).filter((d) => "selectionRange" in d).map(toDocSymbol);
    },
  });

  type HazeCompletion = monaco.languages.CompletionItem & { lsp: LspCompletionItem; path: string };
  L.registerCompletionItemProvider("csharp", {
    triggerCharacters: [".", "<", " ", "(", "[", ":", "\"", "#"],
    async provideCompletionItems(model, position, context, token) {
      const s = ready(model);
      if (!s) return { suggestions: [] };
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
          commitCharacters: it.commitCharacters,
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
      if (!s || word.word.length < MIN_PREFIX || /\w/.test(next)) return { items: [] };
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
      if (!s) return { actions: [], dispose() {} };
      const res = await s.request<LspCodeAction[] | null>(
        "textDocument/codeAction",
        { textDocument: { uri: model.uri.toString() }, range: toLspRange(range), context: { diagnostics: [] } },
        token,
      );
      const actions: monaco.languages.CodeAction[] = (res ?? []).map((a) => ({
        title: a.title,
        // Everything is offered as a quick fix so Alt+Enter lists all of it, like Rider.
        kind: "quickfix",
        isPreferred: a.isPreferred,
        command: { id: "haze.applyCodeAction", title: a.title, arguments: [model.uri.fsPath, a] },
      }));
      return { actions, dispose() {} };
    },
  });

  // Rider-like colours by meaning, once the projects are loaded (before
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
      const res = await s.request<{ data: number[] } | null>("textDocument/semanticTokens/full", { textDocument: { uri: model.uri.toString() } }, token);
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
        { textDocument: { uri: model.uri.toString() }, range: toLspRange(range) },
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
        { textDocument: { uri: model.uri.toString() }, options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces } },
        token,
      );
      return (res ?? []).map((e) => ({ range: toMonacoRange(e.range), text: e.newText }));
    },
  });
}
