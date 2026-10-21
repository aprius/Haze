import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { X } from "lucide-react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { disposeBuffer, ensureBuffer, getModel, reloadBuffer, reloadingFromDisk, saveBuffer, useBuffers, type BufferMeta } from "../lib/buffers";
import { api, errorMessage } from "../lib/ipc";
import { codeFontOptions, languageFor, monaco } from "../lib/monaco";
import { monacoTheme } from "../lib/theme";
import { basename, dirname, extname, relative } from "../lib/path";
import { findImplementations, findUsages, prepareRename, renameSymbol } from "../lib/lsp/csharp";
import { applyWorkspaceEdit } from "../lib/workspaceEdit";
import { recoveredDrafts } from "../store/persist";
import { setSelection } from "../store/tree";
import { activeProject, projectForPath, useWorkspace, type Project } from "../store/workspace";
import { absPath, repo } from "../store/git";
import { DiffView, diffTitle, openDiff, parseDiffPath } from "./DiffView";
import { MergeView, mergeTitle, parseMergePath } from "./MergeView";
import { showHistory } from "./GitPanel";
import { choose, openMenu, prompt, toast } from "./Overlays";
import { showLocations } from "./UsagesPopup";
import { isMac, shortcutLabel } from "../lib/keymap";

export const useCursor = create<{ line: number; column: number; selected: number }>(() => ({
  line: 1,
  column: 1,
  selected: 0,
}));

const viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>();

// The editor of the visible project, for commands run from outside (actions, shortcuts).
let currentEditor: monaco.editor.IStandaloneCodeEditor | null = null;
let currentPath: string | null = null;

const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg"];
export const isImagePath = (path: string) => IMAGE_EXTS.includes(extname(path));

/** Runs an editor action (e.g. "haze.rename") when the editor has focus. */
export function triggerEditorAction(id: string): boolean {
  const ed = currentEditor;
  if (!ed?.hasTextFocus()) return false;
  ed.trigger("keyboard", id, null);
  return true;
}

/** Text selected in the editor (single line only), to seed searches. */
export function selectedText(): string | null {
  const ed = currentEditor;
  const model = ed?.getModel();
  const sel = ed?.getSelection();
  if (!ed || !model || !sel || sel.isEmpty() || sel.startLineNumber !== sel.endLineNumber) return null;
  return model.getValueInRange(sel);
}

/**
 * Copies the selection with its path and line numbers, ready to paste into an
 * AI chat (Ctrl+Shift+C). Without a selection, copies `path:line`.
 */
export function copyContext(): void {
  const ed = currentEditor;
  const model = ed?.getModel();
  const path = currentPath;
  const project = path ? projectForPath(path) : null;
  if (!ed || !model || !path) return;
  const rel = project ? relative(project.path, path) : path;
  const sel = ed.getSelection();
  let text: string;
  if (!sel || sel.isEmpty()) {
    text = `${rel}:${ed.getPosition()?.lineNumber ?? 1}`;
  } else {
    const endLine = sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber ? sel.endLineNumber - 1 : sel.endLineNumber;
    const range = new monaco.Range(sel.startLineNumber, 1, endLine, model.getLineMaxColumn(endLine));
    const lines = sel.startLineNumber === endLine ? `${sel.startLineNumber}` : `${sel.startLineNumber}-${endLine}`;
    const lang = languageFor(path);
    text = `${rel}:${lines}\n\`\`\`${lang === "plaintext" ? "" : lang}\n${model.getValueInRange(range, monaco.editor.EndOfLinePreference.LF)}\n\`\`\``;
  }
  void navigator.clipboard.writeText(text).then(() => toast("Copied with path and line numbers"));
}

// Popups closing leave focus on <body>; give it back to the editor like Rider does.
window.addEventListener("haze:popup-closed", () =>
  requestAnimationFrame(() => {
    const el = document.activeElement;
    if (!el || el === document.body) currentEditor?.focus();
  }),
);

let keymapInstalled = false;

/**
 * IntelliJ/Rider keys that differ from Monaco's VS Code defaults. On macOS
 * they follow the user's "ReSharper (macOS)" Rider keymap (see lib/keymap).
 */
function installRiderKeymap() {
  if (keymapInstalled) return;
  keymapInstalled = true;
  const { KeyMod: M, KeyCode: K } = monaco;
  const edit = "editorTextFocus && !editorReadonly";
  const common = [
    { keybinding: M.CtrlCmd | K.KeyD, command: "-editor.action.addSelectionToNextFindMatch" },
    { keybinding: M.CtrlCmd | K.KeyD, command: "editor.action.copyLinesDownAction", when: edit },
    { keybinding: M.Alt | K.KeyJ, command: "editor.action.addSelectionToNextFindMatch", when: "editorFocus" },
    { keybinding: M.CtrlCmd | K.KeyR, command: "editor.action.startFindReplaceAction", when: "editorFocus" },
    { keybinding: M.Alt | M.Shift | K.UpArrow, command: "editor.action.moveLinesUpAction", when: edit },
    { keybinding: M.Alt | M.Shift | K.DownArrow, command: "editor.action.moveLinesDownAction", when: edit },
    { keybinding: M.CtrlCmd | M.Shift | K.Slash, command: "editor.action.blockComment", when: edit },
    { keybinding: M.CtrlCmd | M.Shift | K.KeyU, command: "editor.action.transformToUppercase", when: edit },
    // Code navigation (C# via Roslyn).
    { keybinding: M.CtrlCmd | K.KeyB, command: "editor.action.revealDefinition", when: "editorTextFocus" },
    { keybinding: M.Alt | K.Enter, command: "editor.action.quickFix", when: edit },
    { keybinding: M.CtrlCmd | M.Alt | K.KeyL, command: "editor.action.formatDocument", when: edit },
    { keybinding: M.CtrlCmd | K.F12, command: "-editor.action.goToImplementation" },
    { keybinding: M.CtrlCmd | K.F12, command: "editor.action.quickOutline", when: "editorTextFocus" },
  ];
  // Rider's Windows keys; on macOS Cmd+Y is Redo and Cmd+W closes the tab.
  const other = [
    { keybinding: M.CtrlCmd | K.KeyY, command: "editor.action.deleteLines", when: edit },
    { keybinding: M.CtrlCmd | K.KeyW, command: "editor.action.smartSelect.expand", when: "editorTextFocus" },
    { keybinding: M.CtrlCmd | M.Shift | K.KeyW, command: "editor.action.smartSelect.shrink", when: "editorTextFocus" },
  ];
  // M.CtrlCmd is Cmd here, M.WinCtrl is Ctrl.
  const mac = [
    { keybinding: M.CtrlCmd | M.Shift | K.KeyL, command: "-editor.action.selectHighlights" },
    { keybinding: M.CtrlCmd | M.Shift | K.KeyL, command: "editor.action.deleteLines", when: edit },
    { keybinding: M.Alt | K.UpArrow, command: "-editor.action.moveLinesUpAction" },
    { keybinding: M.Alt | K.DownArrow, command: "-editor.action.moveLinesDownAction" },
    { keybinding: M.Alt | K.UpArrow, command: "editor.action.smartSelect.expand", when: "editorTextFocus" },
    { keybinding: M.Alt | K.DownArrow, command: "editor.action.smartSelect.shrink", when: "editorTextFocus" },
    { keybinding: M.WinCtrl | M.Alt | M.Shift | K.UpArrow, command: "editor.action.moveLinesUpAction", when: edit },
    { keybinding: M.WinCtrl | M.Alt | M.Shift | K.DownArrow, command: "editor.action.moveLinesDownAction", when: edit },
    { keybinding: M.WinCtrl | K.KeyH, command: "editor.action.startFindReplaceAction", when: "editorFocus" },
    { keybinding: M.Alt | K.KeyH, command: "editor.action.startFindReplaceAction", when: "editorFocus" },
    { keybinding: M.Alt | M.Shift | K.Period, command: "editor.action.addSelectionToNextFindMatch", when: "editorFocus" },
    { keybinding: M.Alt | M.Shift | K.Semicolon, command: "editor.action.selectHighlights", when: "editorFocus" },
    { keybinding: M.WinCtrl | M.CtrlCmd | K.Slash, command: "editor.action.blockComment", when: edit },
    { keybinding: M.WinCtrl | M.Shift | K.KeyJ, command: "editor.action.joinLines", when: edit },
    { keybinding: M.CtrlCmd | M.Shift | K.Space, command: "-editor.action.triggerParameterHints" },
    { keybinding: M.CtrlCmd | M.Shift | K.Space, command: "editor.action.triggerSuggest", when: edit },
    { keybinding: M.Shift | K.Space, command: "editor.action.triggerSuggest", when: edit },
    { keybinding: M.CtrlCmd | K.KeyP, command: "editor.action.triggerParameterHints", when: edit },
    { keybinding: M.WinCtrl | K.KeyQ, command: "editor.action.showHover", when: "editorTextFocus" },
    { keybinding: M.CtrlCmd | M.Shift | K.KeyT, command: "editor.action.goToTypeDefinition", when: "editorTextFocus" },
    { keybinding: M.CtrlCmd | K.KeyG, command: "-editor.action.nextMatchFindAction" },
    { keybinding: M.CtrlCmd | K.KeyG, command: "editor.action.gotoLine", when: "editorFocus" },
    { keybinding: M.CtrlCmd | M.Shift | K.KeyM, command: "editor.foldAllMarkerRegions", when: "editorTextFocus" },
    { keybinding: M.CtrlCmd | M.Shift | K.KeyO, command: "-editor.action.quickOutline" },
    { keybinding: M.CtrlCmd | M.Shift | K.KeyO, command: "editor.unfoldAllMarkerRegions", when: "editorTextFocus" },
    { keybinding: M.Alt | K.PageDown, command: "editor.action.marker.nextInFiles", when: "editorFocus" },
    { keybinding: M.Alt | K.PageUp, command: "editor.action.marker.prevInFiles", when: "editorFocus" },
    { keybinding: M.Shift | K.F12, command: "editor.action.marker.prevInFiles", when: "editorFocus" },
  ];
  monaco.editor.addKeybindingRules([...common, ...(isMac ? mac : other)]);
  // Navigating to another file (Ctrl+click, F12…) opens it in Haze's tabs.
  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
      if (resource.scheme !== "file") return false;
      const path = resource.fsPath;
      // The editor asking is the visible project's; opening the file in another
      // project (one nested in this folder, say) would show nothing.
      const project = activeProject() ?? projectForPath(path);
      if (!project) return false;
      const pos =
        selectionOrPosition && "startLineNumber" in selectionOrPosition
          ? { line: selectionOrPosition.startLineNumber, column: selectionOrPosition.startColumn }
          : selectionOrPosition
            ? { line: selectionOrPosition.lineNumber, column: selectionOrPosition.column }
            : {};
      useWorkspace.getState().openFile(project.id, path, pos);
      return true;
    },
  });
}

/** Rider's Rename (Shift+F6) for C# symbols, applied across files with one Undo. */
async function renameAt(editor: monaco.editor.ICodeEditor) {
  const model = editor.getModel();
  const pos = editor.getPosition();
  if (!model || !pos) return;
  try {
    const target = await prepareRename(model, pos);
    if (!target) return toast("This element cannot be renamed.", "error");
    const name = await prompt("Rename", target.placeholder, {
      okLabel: "Rename",
      validate: (v) => (!/^@?[\p{L}_][\p{L}\p{N}_]*$/u.test(v.trim()) ? "Not a valid identifier" : null),
    });
    if (!name || name === target.placeholder) return;
    const edit = await renameSymbol(model, pos, name.trim());
    if (!edit) return toast("Nothing to rename.", "error");
    const applied = await applyWorkspaceEdit(edit);
    toast(`Renamed ${applied.edits} occurrence(s) in ${applied.files} file(s).`, "info", {
      label: "Undo",
      run: () => void applied.undo().then((failed) => failed && toast(`${failed} file(s) changed since; left as is.`, "error")),
    });
    if (applied.skipped.length) toast(`Could not edit: ${applied.skipped.map(basename).join(", ")}`, "error");
  } catch (e) {
    toast(`Rename failed: ${errorMessage(e)}`, "error");
  }
}

// Annotate (git blame): model decorations, so they survive switching tabs.
// Keyed by model: a file closed and opened again gets a new one without them.
const blameDecorations = new WeakMap<monaco.editor.ITextModel, string[]>();

async function toggleBlame(project: Project, editor: monaco.editor.ICodeEditor) {
  const model = editor.getModel();
  if (!model || model.uri.scheme !== "file") return;
  const path = model.uri.fsPath;
  const existing = blameDecorations.get(model);
  if (existing) {
    model.deltaDecorations(existing, []);
    blameDecorations.delete(model);
    return;
  }
  const root = repo(project.id).root;
  if (!root) return toast("Not a git repository.", "error");
  const rel = relative(root, path);
  try {
    const meta = useBuffers.getState().meta[path];
    const dirty = meta?.status === "text" && meta.dirty;
    const lines = await api.gitBlame(root, rel, dirty ? model.getValue() : null, meta?.status === "text" ? meta.encoding : null);
    const uncommitted = "0".repeat(40);
    const ids = model.deltaDecorations(
      [],
      lines
        .filter((l) => l.line >= 1 && l.line <= model.getLineCount())
        .map((l) => {
          const date = new Date(l.time * 1000).toISOString().slice(0, 10);
          const label = l.hash === uncommitted ? "Not committed yet".padEnd(31) : `${l.hash.slice(0, 7)} ${date} ${l.author.slice(0, 12).padEnd(12)}`;
          return {
            range: new monaco.Range(l.line, 1, l.line, 1),
            options: {
              showIfCollapsed: true,
              before: { content: label + "  ", inlineClassName: "blame-text", cursorStops: monaco.editor.InjectedTextCursorStops.None },
              hoverMessage: l.hash === uncommitted ? undefined : { value: `**${l.summary}**\n\n${l.author} · ${new Date(l.time * 1000).toLocaleString()} · \`${l.hash.slice(0, 12)}\`` },
            },
          };
        }),
    );
    blameDecorations.set(model, ids);
  } catch (e) {
    toast(`Annotate failed: ${errorMessage(e)}`, "error");
  }
}

function symbolAt(editor: monaco.editor.ICodeEditor): string {
  const model = editor.getModel();
  const pos = editor.getPosition();
  return (model && pos && model.getWordAtPosition(pos)?.word) || "symbol";
}

function ImageView({ path }: { path: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stale = false;
    setSrc(null);
    setError(null);
    api
      .readImage(path)
      .then((img) => !stale && setSrc(`data:${img.mime};base64,${img.base64}`))
      .catch((e) => !stale && setError(errorMessage(e)));
    return () => {
      stale = true;
    };
  }, [path]);
  return (
    <div className="editor-empty image-view">
      {error ? <span className="error">{error}</span> : src ? <img src={src} alt={basename(path)} /> : "Loading…"}
    </div>
  );
}

function MarkdownPreview({ path }: { path: string }) {
  const [html, setHtml] = useState("");
  useEffect(() => {
    const model = getModel(path);
    if (!model) return;
    const render = () => setHtml(DOMPurify.sanitize(marked.parse(model.getValue(), { async: false }) as string));
    render();
    let t: ReturnType<typeof setTimeout>;
    const sub = model.onDidChangeContent(() => {
      clearTimeout(t);
      t = setTimeout(render, 150);
    });
    return () => {
      clearTimeout(t);
      sub.dispose();
    };
  }, [path]);
  return <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />;
}

function isDirty(meta: BufferMeta | undefined): boolean {
  return meta?.status === "text" && meta.dirty;
}

export async function saveAll(): Promise<void> {
  const meta = useBuffers.getState().meta;
  for (const [path, m] of Object.entries(meta)) {
    if (m.status !== "text" || !m.dirty) continue;
    try {
      const ok = await saveBuffer(path);
      if (!ok) toast(`${basename(path)} changed on disk — not saved. Choose Reload or Overwrite.`, "error");
    } catch (e) {
      toast(`Saving ${basename(path)} failed: ${errorMessage(e)}`, "error");
    }
  }
}

/** The file a tab edits: the file itself, or the local side of a working-copy diff. */
function editedFile(tab: string): string | null {
  const diff = parseDiffPath(tab);
  if (diff) return diff.right === "working" ? absPath(diff.root, diff.rel) : null;
  return tab.startsWith("haze-") ? null : tab;
}

/** Closes tabs, asking about unsaved changes. Returns false if cancelled. */
export async function closeTabsWithPrompt(projectId: string, paths: string[]): Promise<boolean> {
  const closing = new Set(paths);
  // Files another tab still shows (here or in another project) keep their buffer.
  const kept = new Set(
    Object.entries(useWorkspace.getState().ui).flatMap(([id, u]) =>
      u.tabs.filter((t) => id !== projectId || !closing.has(t.path)).map((t) => editedFile(t.path)),
    ),
  );
  const files = [...new Set(paths.map(editedFile))].filter((f): f is string => !!f && !kept.has(f));
  // A restored draft is loaded in the background; wait for it so it counts as unsaved.
  for (const f of files) {
    const draft = recoveredDrafts.get(f);
    if (draft) await ensureBuffer(f, draft);
  }
  const meta = useBuffers.getState().meta;
  const dirty = files.filter((p) => isDirty(meta[p]));
  if (dirty.length) {
    const names = dirty.map(basename).join(", ");
    const answer = await choose("Unsaved changes", `Save changes to ${names}?`, [
      { label: "Cancel", value: "cancel" },
      { label: "Don't Save", value: "discard", danger: true },
      { label: "Save", value: "save", primary: true },
    ]);
    if (!answer) return false;
    if (answer === "save") {
      for (const p of dirty) {
        try {
          if (!(await saveBuffer(p))) {
            toast(`${basename(p)} changed on disk — not saved.`, "error");
            return false;
          }
        } catch (e) {
          toast(errorMessage(e), "error");
          return false;
        }
      }
    }
  }
  useWorkspace.getState().closeTabs(projectId, paths);
  for (const f of files) {
    recoveredDrafts.delete(f);
    disposeBuffer(f);
    viewStates.delete(f);
  }
  return true;
}

function TabBar({ project }: { project: Project }) {
  const ui = useWorkspace((s) => s.ui[project.id]);
  const meta = useBuffers((s) => s.meta);
  const tabs = ui?.tabs ?? [];

  const tabMenu = (path: string) => [
    { label: "Close", shortcut: shortcutLabel("closeTab"), action: () => void closeTabsWithPrompt(project.id, [path]) },
    {
      label: "Close Others",
      action: () => void closeTabsWithPrompt(project.id, tabs.filter((t) => t.path !== path).map((t) => t.path)),
    },
    { label: "Close All", action: () => void closeTabsWithPrompt(project.id, tabs.map((t) => t.path)) },
    { separator: true },
    { label: "Keep Open (Pin Preview)", action: () => useWorkspace.getState().pinTab(project.id, path) },
    { separator: true },
    { label: "Copy Path", action: () => void navigator.clipboard.writeText(path) },
    { label: "Copy Relative Path", action: () => void navigator.clipboard.writeText(relative(project.path, path)) },
    { label: "Select in Project View", shortcut: shortcutLabel("selectInProject"), action: () => revealInTree(project, path) },
    { label: "Reveal in File Manager", action: () => void revealItemInDir(path) },
  ];

  return (
    <div className="editor-tabs">
      {tabs.map((t) => {
        const m = meta[t.path];
        return (
          <div
            key={t.path}
            className={"editor-tab" + (t.path === ui?.activeTab ? " active" : "") + (t.preview ? " preview" : "")}
            title={t.path}
            onClick={() => useWorkspace.getState().updateUi(project.id, { activeTab: t.path })}
            onDoubleClick={() => useWorkspace.getState().pinTab(project.id, t.path)}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                void closeTabsWithPrompt(project.id, [t.path]);
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              openMenu(e, tabMenu(t.path));
            }}
          >
            <span className="editor-tab-name">{tabTitle(t.path)}</span>
            {isDirty(m) || isDirty(meta[editedFile(t.path) ?? ""]) ? (
              <span className="dirty-dot" title="Unsaved changes" />
            ) : null}
            <button
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                void closeTabsWithPrompt(project.id, [t.path]);
              }}
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function tabTitle(path: string): string {
  const diff = parseDiffPath(path);
  const merge = parseMergePath(path);
  return diff ? diffTitle(diff) : merge ? mergeTitle(merge) : basename(path);
}

export function revealInTree(project: Project, path: string): void {
  const ws = useWorkspace.getState();
  const dirs: string[] = [];
  let cur = dirname(path);
  while (cur && cur.length >= project.path.length) {
    dirs.push(cur);
    const next = dirname(cur);
    if (next === cur) break;
    cur = next;
  }
  ws.updateUi(project.id, (u) => ({ expanded: [...new Set([...u.expanded, ...dirs])], sidebarVisible: true }));
  setSelection(project.id, [path], path);
}

function Breadcrumb({ project, path }: { project: Project; path: string }) {
  const parts = relative(project.path, path).split("/");
  return (
    <div className="breadcrumb">
      <span>{project.name}</span>
      {parts.map((p, i) => (
        <span key={i}>
          <span className="crumb-sep">›</span>
          {p}
        </span>
      ))}
    </div>
  );
}

function DiskBanner({ path }: { path: string }) {
  return (
    <div className="banner warn">
      The file changed on disk while you have unsaved edits.
      <button className="btn small" onClick={() => void reloadBuffer(path).catch((e) => toast(errorMessage(e), "error"))}>
        Load disk version
      </button>
      <button
        className="btn small"
        onClick={() =>
          void saveBuffer(path, { force: true }).catch((e) => toast(errorMessage(e), "error"))
        }
      >
        Overwrite with mine
      </button>
    </div>
  );
}

export function EditorArea({ project }: { project: Project }) {
  const ui = useWorkspace((s) => s.ui[project.id]);
  const reveal = useWorkspace((s) => s.reveal);
  const active = ui?.activeTab ?? null;
  const meta = useBuffers((s) => (active ? s.meta[active] : undefined));
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const shownPath = useRef<string | null>(null);

  // One editor instance per project view; models are swapped on tab change.
  useEffect(() => {
    if (!host.current) return;
    installRiderKeymap();
    const editor = monaco.editor.create(host.current, {
      model: null,
      automaticLayout: true,
      ...codeFontOptions(),
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderWhitespace: "selection",
      smoothScrolling: true,
      stickyScroll: { enabled: true },
      bracketPairColorization: { enabled: true },
      theme: monacoTheme(),
    });
    editor.onDidChangeCursorSelection((e) => {
      const model = editor.getModel();
      const sel = e.selection;
      useCursor.setState({
        line: sel.positionLineNumber,
        column: sel.positionColumn,
        selected: model ? model.getValueInRange(sel).length : 0,
      });
    });
    editor.onDidChangeModelContent(() => {
      // Editing a preview tab keeps it, like Rider; an agent changing the file on disk does not.
      if (reloadingFromDisk()) return;
      const path = shownPath.current;
      const ws = useWorkspace.getState();
      if (path && ws.ui[project.id]?.tabs.find((t) => t.path === path)?.preview) ws.pinTab(project.id, path);
    });
    editor.addAction({
      id: "haze.copyContext",
      label: "Copy Context (path + lines)",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyC],
      contextMenuGroupId: "9_cutcopypaste",
      run: () => copyContext(),
    });
    const codeAction = (id: string, label: string, keys: number[], run: () => void, group = "navigation") =>
      editor.addAction({ id, label, keybindings: keys, contextMenuGroupId: group, run });
    const { KeyMod: M, KeyCode: K } = monaco;
    const isCs = () => editor.getModel()?.getLanguageId() === "csharp";
    // Rider on macOS puts Previous Error on Shift+F12.
    codeAction("haze.findUsages", "Find Usages", isMac ? [M.Alt | K.F7] : [M.Alt | K.F7, M.Shift | K.F12], () => {
      const model = editor.getModel();
      const pos = editor.getPosition();
      if (!model || !pos || !isCs()) return;
      void showLocations(project, `Usages of ${symbolAt(editor)}`, () => findUsages(model, pos));
    });
    codeAction("haze.gotoImplementation", "Go to Implementation", [M.CtrlCmd | M.Alt | K.KeyB], () => {
      const model = editor.getModel();
      const pos = editor.getPosition();
      if (!model || !pos || !isCs()) return;
      void showLocations(project, `Implementations of ${symbolAt(editor)}`, () => findImplementations(model, pos), true);
    });
    codeAction("haze.annotate", "Annotate with Git Blame", [], () => void toggleBlame(project, editor), "9_git");
    codeAction("haze.fileHistory", "Show History for File", [], () => {
      const model = editor.getModel();
      if (model?.uri.scheme === "file") showHistory(project, model.uri.fsPath);
    }, "9_git");
    codeAction("haze.compareHead", "Compare with HEAD", [], () => {
      const model = editor.getModel();
      const root = repo(project.id).root;
      if (model?.uri.scheme === "file" && root) openDiff(project.id, { root, rel: relative(root, model.uri.fsPath), left: "HEAD", right: "working" });
    }, "9_git");
    codeAction("haze.rename", "Rename Symbol…", [M.Shift | K.F6, K.F2], () => {
      if (isCs()) void renameAt(editor);
    }, "1_modification");
    editorRef.current = editor;
    currentEditor = editor;
    return () => {
      if (shownPath.current) viewStates.set(shownPath.current, editor.saveViewState());
      editor.dispose();
      editorRef.current = null;
      if (currentEditor === editor) {
        currentEditor = null;
        currentPath = null;
      }
    };
  }, [project.id]);

  // Load the active file (applying any recovered draft once).
  useEffect(() => {
    if (!active || isImagePath(active) || active.startsWith("haze-")) return;
    const draft = recoveredDrafts.get(active);
    void ensureBuffer(active, draft).finally(() => {
      if (draft && getModel(active) && recoveredDrafts.get(active) === draft) recoveredDrafts.delete(active);
    });
  }, [active]);

  // Show the active model.
  const ready = meta?.status === "text";
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const prev = shownPath.current;
    if (prev && prev !== active) viewStates.set(prev, editor.saveViewState());
    const model = active && ready ? getModel(active) : null;
    if (editor.getModel() !== model) {
      editor.setModel(model);
      shownPath.current = model ? active : null;
      currentPath = shownPath.current;
      const vs = active ? viewStates.get(active) : null;
      if (model && vs) editor.restoreViewState(vs);
    }
    if (model) editor.focus();
  }, [active, ready]);

  // Jump to a requested line (terminal links, later: navigation).
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !reveal || reveal.path !== active || !ready) return;
    const pos = { lineNumber: reveal.line, column: reveal.column };
    editor.setPosition(pos);
    editor.revealPositionInCenter(pos);
    editor.focus();
    useWorkspace.setState({ reveal: null });
  }, [reveal, active, ready]);

  const isMarkdown = !!active && extname(active) === "md";
  const [mdPreview, setMdPreview] = useState<Record<string, boolean>>({});
  const showMd = isMarkdown && ready && !!mdPreview[active!];
  const image = !!active && isImagePath(active);
  const diff = active ? parseDiffPath(active) : null;
  const merge = active ? parseMergePath(active) : null;
  const special = !!diff || !!merge;

  return (
    <div className="editor-area">
      <TabBar project={project} />
      {active && !special && (
        <div className="editor-toolbar">
          <Breadcrumb project={project} path={active} />
          {isMarkdown && (
            <div className="seg small">
              <button className={"seg-btn" + (!showMd ? " on" : "")} onClick={() => setMdPreview((m) => ({ ...m, [active]: false }))}>
                Source
              </button>
              <button className={"seg-btn" + (showMd ? " on" : "")} onClick={() => setMdPreview((m) => ({ ...m, [active]: true }))}>
                Preview
              </button>
            </div>
          )}
        </div>
      )}
      {active && meta?.status === "text" && meta.diskChanged && <DiskBanner path={active} />}
      <div className="editor-stack">
        <div ref={host} className="monaco-host" style={{ visibility: ready && !image && !special ? "visible" : "hidden" }} />
        {diff && <DiffView key={active} spec={diff} />}
        {merge && <MergeView key={active} project={project} spec={merge} />}
        {showMd && <MarkdownPreview path={active!} />}
        {image && <ImageView path={active!} />}
        {!active && (
          <div className="editor-empty">
            <div className="hint-grid">
              <span>Open file</span>
              <kbd>Click in Project view</kbd>
              <span>Terminal</span>
              <kbd>{shortcutLabel("terminal")}</kbd>
              <span>Project view</span>
              <kbd>Alt+1</kbd>
              <span>Save all</span>
              <kbd>{shortcutLabel("saveAll")}</kbd>
            </div>
          </div>
        )}
        {active && !image && !special && meta && meta.status !== "text" && (
          <div className="editor-empty">
            {meta.status === "loading" && "Loading…"}
            {meta.status === "error" && <span className="error">{meta.message}</span>}
            {meta.status === "binary" && `Binary file (${meta.size.toLocaleString()} bytes) — not shown.`}
            {meta.status === "tooLarge" && `File is too large to edit (${meta.size.toLocaleString()} bytes).`}
          </div>
        )}
      </div>
    </div>
  );
}
