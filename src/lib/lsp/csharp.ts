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

const WATCHED = /\.(cs|csx|csproj|props|targets|sln|slnx|editorconfig|json)$/i;

interface ServerCapabilities {
  textDocumentSync?: number | { change?: number };
  completionProvider?: { triggerCharacters?: string[]; resolveProvider?: boolean };
  signatureHelpProvider?: { triggerCharacters?: string[] };
  [k: string]: unknown;
}

export class CsharpSession {
  client!: LspClient;
  kind = "";
  caps: ServerCapabilities = {};
  ready = false;
  private readyWaiters: (() => void)[] = [];
  private synced = new Map<string, monaco.IDisposable>();
  private disposed = false;

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
        },
        window: { workDoneProgress: true, showMessage: {} },
      },
    });
    this.caps = init.capabilities;
    await this.client.notify("initialized", {});
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
    c.onNotification("workspace/projectInitializationComplete", () => this.markReady());
    c.onNotification("$/progress", (p) => {
      const v = (p as { value?: { kind?: string; title?: string; message?: string } }).value;
      if (!this.ready && v?.kind !== "end" && (v?.message || v?.title)) {
        setCsharpStatus(this.projectId, { state: "loading", kind: this.kind, message: v.message ?? v.title });
      }
    });
    c.onNotification("window/showMessage", (p) => {
      const m = p as { type: number; message: string };
      if (m.type === 1) setCsharpStatus(this.projectId, { state: this.ready ? "ready" : "loading", kind: this.kind, message: m.message });
    });
    c.onExit(() => {
      this.ready = false;
      this.synced.forEach((d) => d.dispose());
      this.synced.clear();
      if (!this.disposed) setCsharpStatus(this.projectId, { state: "stopped", kind: this.kind, message: "C# server stopped" });
    });
  }

  private markReady() {
    if (this.ready) return;
    this.ready = true;
    setCsharpStatus(this.projectId, { state: "ready", kind: this.kind });
    this.readyWaiters.splice(0).forEach((r) => r());
  }

  whenReady(): Promise<void> {
    return this.ready ? Promise.resolve() : new Promise((r) => this.readyWaiters.push(r));
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

export async function startCsharp(projectId: string, root: string): Promise<void> {
  registerProviders();
  if (sessions.has(projectId)) return;
  const s = new CsharpSession(projectId, root);
  sessions.set(projectId, s);
  try {
    await s.start();
    if (!s.client) sessions.delete(projectId);
  } catch (e) {
    sessions.delete(projectId);
    setCsharpStatus(projectId, { state: "error", message: errorMessage(e) });
  }
}

export async function stopCsharp(projectId: string): Promise<void> {
  const s = sessions.get(projectId);
  sessions.delete(projectId);
  await s?.stop();
}

export async function restartCsharp(projectId: string, root: string): Promise<void> {
  await stopCsharp(projectId);
  await startCsharp(projectId, root);
}

export function notifyFileChanges(change: FsChange): void {
  for (const s of sessions.values()) if (isWithin(change.root, s.root) || isWithin(s.root, change.root)) s.fileChanges(change);
}

/** Session for a model if its server is ready for queries. */
function ready(model: monaco.editor.ITextModel): CsharpSession | undefined {
  if (model.uri.scheme !== "file") return undefined;
  const s = sessionForPath(model.uri.fsPath);
  return s?.ready && s.client.alive ? s : undefined;
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
  if (!s?.ready || !query) return [];
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
      const res = await s.request<unknown>("textDocument/definition", docParams(model, position), token);
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

  interface LspCompletionItem {
    label: string;
    kind?: number;
    detail?: string;
    documentation?: unknown;
    sortText?: string;
    filterText?: string;
    insertText?: string;
    insertTextFormat?: number;
    textEdit?: { range?: LspRange; insert?: LspRange; newText: string };
    additionalTextEdits?: LspTextEdit[];
    commitCharacters?: string[];
    preselect?: boolean;
  }
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
      if (!s?.ready || !s.caps.completionProvider?.resolveProvider) return item;
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
