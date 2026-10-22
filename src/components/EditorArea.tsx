import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { disposeBuffer, ensureBuffer, getModel, metaDirty, reloadBuffer, reloadingFromDisk, saveBuffer, useBuffers } from "../lib/buffers";
import { api, errorMessage, type BlameLine } from "../lib/ipc";
import { codeFontOptions, languageFor, monaco, suggestOptions } from "../lib/monaco";
import { monacoTheme } from "../lib/theme";
import { basename, dirname, extname, isWithin, join, relative } from "../lib/path";
import { clearUnusedMarks, findImplementations, findUsages, prepareRename, renameSymbol, setCodeVisionAuthor } from "../lib/lsp/csharp";
import { lineChanges } from "../lib/lineChanges";
import { findTextUsages, registerTextNavigation } from "../lib/textNav";
import { zedWheel } from "../lib/wheel";
import { applyWorkspaceEdit } from "../lib/workspaceEdit";
import { recoveredDrafts } from "../store/persist";
import { setSelection } from "../store/tree";
import { activeProject, projectForPath, useWorkspace, type Project } from "../store/workspace";
import { absPath, repo, useGit } from "../store/git";
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
    // Code navigation (C# via Roslyn, other languages by text search: lib/textNav).
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
  // Ctrl+Click / Ctrl+B in languages Roslyn does not cover, and in C# until it is up.
  registerTextNavigation();
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
const UNCOMMITTED = "0".repeat(40);

/** Blames the model's text: unsaved edits as they are, so the lines match the editor. */
function blameModel(root: string, model: monaco.editor.ITextModel): Promise<BlameLine[]> {
  const path = model.uri.fsPath;
  const meta = useBuffers.getState().meta[path];
  return api.gitBlame(root, relative(root, path), metaDirty(meta) ? model.getValue() : null, meta?.status === "text" ? meta.encoding : null);
}

/** A blamed line's commit, shown on hover; nothing for lines not committed yet. */
function blameHover(b: BlameLine): monaco.IMarkdownString | undefined {
  if (b.hash === UNCOMMITTED) return undefined;
  return { value: `**${b.summary}**\n\n${b.author} · ${new Date(b.time * 1000).toLocaleString()} · \`${b.hash.slice(0, 12)}\`` };
}

async function toggleBlame(project: Project, editor: monaco.editor.ICodeEditor) {
  const model = editor.getModel();
  if (!model || model.uri.scheme !== "file") return;
  const existing = blameDecorations.get(model);
  if (existing) {
    model.deltaDecorations(existing, []);
    blameDecorations.delete(model);
    return;
  }
  const root = repo(project.id).root;
  if (!root) return toast("Not a git repository.", "error");
  try {
    const lines = await blameModel(root, model);
    const ids = model.deltaDecorations(
      [],
      lines
        .filter((l) => l.line >= 1 && l.line <= model.getLineCount())
        .map((l) => {
          const date = new Date(l.time * 1000).toISOString().slice(0, 10);
          const label = l.hash === UNCOMMITTED ? "Not committed yet".padEnd(31) : `${l.hash.slice(0, 7)} ${date} ${l.author.slice(0, 12).padEnd(12)}`;
          return {
            range: new monaco.Range(l.line, 1, l.line, 1),
            options: {
              showIfCollapsed: true,
              before: { content: label + "  ", inlineClassName: "blame-text", cursorStops: monaco.editor.InjectedTextCursorStops.None },
              hoverMessage: blameHover(l),
            },
          };
        }),
    );
    blameDecorations.set(model, ids);
  } catch (e) {
    toast(`Annotate failed: ${errorMessage(e)}`, "error");
  }
}

// Inline blame for the caret line, like Rider's GitToolBox: "Author, 2 days ago • summary"
// after the line's end, the commit's details on hover. One blame per model version
// (dirty text is blamed as is, so lines match), asked once the caret rests.
const lineBlames = new WeakMap<monaco.editor.ITextModel, { version: number; at: number; lines: Promise<Map<number, BlameLine> | null> }>();

function caretLineBlames(project: Project, model: monaco.editor.ITextModel): Promise<Map<number, BlameLine> | null> {
  const version = model.getAlternativeVersionId();
  const cached = lineBlames.get(model);
  // Re-asked after a while too: a commit changes the answer without changing the text.
  if (cached && cached.version === version && Date.now() - cached.at < 15_000) return cached.lines;
  const root = repo(project.id).root;
  if (!root || !isWithin(model.uri.fsPath, root)) return Promise.resolve(null);
  const lines = blameModel(root, model)
    .then((ls) => new Map(ls.map((l) => [l.line, l])))
    .catch(() => null); // untracked or outside git: nothing to show
  lineBlames.set(model, { version, at: Date.now(), lines });
  return lines;
}

function timeAgo(t: number): string {
  const s = Math.max(0, Date.now() / 1000 - t);
  const steps: [number, string][] = [
    [60, "second"], [60, "minute"], [24, "hour"], [7, "day"], [4.35, "week"], [12, "month"], [Infinity, "year"],
  ];
  let n = s;
  for (const [size, unit] of steps) {
    if (n < size) {
      const v = Math.floor(n);
      return unit === "second" ? "just now" : `${v} ${unit}${v === 1 ? "" : "s"} ago`;
    }
    n /= size;
  }
  return "";
}

// Code Vision's author ("aprius +2", Rider style): who wrote most of the declaration's lines.
setCodeVisionAuthor(async (model, from, to) => {
  const project = projectForPath(model.uri.fsPath);
  const lines = project && (await caretLineBlames(project, model));
  if (!lines) return null;
  const count = new Map<string, number>();
  for (let l = from; l <= to; l++) {
    const b = lines.get(l);
    if (!b) continue;
    const who = b.hash === UNCOMMITTED ? "You" : b.author;
    count.set(who, (count.get(who) ?? 0) + 1);
  }
  const ranked = [...count].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return null;
  return {
    title: ranked[0][0] + (ranked.length > 1 ? ` +${ranked.length - 1}` : ""),
    tooltip: ranked.map(([who, n]) => `${who}: ${n} line${n === 1 ? "" : "s"}`).join("\n"),
  };
});

/** Viewport point just under `pos`, where Rider opens its usages list. */
function anchorBelow(editor: monaco.editor.ICodeEditor, pos: monaco.IPosition): { x: number; y: number } | null {
  const at = editor.getScrolledVisiblePosition(pos);
  const dom = editor.getDomNode();
  if (!at || !dom) return null;
  const r = dom.getBoundingClientRect();
  return { x: r.left + at.left, y: r.top + at.top + at.height };
}

// A Code Vision usages count opens the usages list for that symbol, under its name.
monaco.editor.registerCommand("haze.codeVisionUsages", (_accessor, path: string, line: number, column: number, name: string) => {
  const model = getModel(path);
  const project = projectForPath(path);
  if (!model || !project) return;
  const pos = { lineNumber: line, column };
  const shown = monaco.editor.getEditors().filter((e) => e.getModel() === model);
  const editor = shown.find((e) => e.hasWidgetFocus()) ?? shown[0];
  void showLocations(project, `Usages of ${name}`, () => findUsages(model, pos), false, editor ? anchorBelow(editor, pos) : null);
});

function installLineBlame(project: Project, editor: monaco.editor.ICodeEditor): monaco.IDisposable {
  const shown = editor.createDecorationsCollection();
  let shownKey = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    shown.clear();
    shownKey = "";
  };
  const update = (delay: number) => {
    clearTimeout(timer);
    const model = editor.getModel();
    const line = editor.getSelection()?.positionLineNumber;
    const key = model && line ? `${model.uri}:${model.getAlternativeVersionId()}:${line}` : "";
    // Moving along the same line keeps the annotation (no flicker).
    if (key && key === shownKey) return;
    clear();
    if (!model || !line || model.uri.scheme !== "file" || !useWorkspace.getState().lineBlame) return;
    timer = setTimeout(async () => {
      // Full Annotate is on: it already says it.
      if (blameDecorations.has(model)) return;
      const b = (await caretLineBlames(project, model))?.get(line);
      if (!b || editor.getModel() !== model || editor.getSelection()?.positionLineNumber !== line || line > model.getLineCount()) return;
      if (`${model.uri}:${model.getAlternativeVersionId()}:${line}` !== key) return;
      const summary = b.summary.length > 60 ? b.summary.slice(0, 59) + "…" : b.summary;
      const label = b.hash === UNCOMMITTED ? "You, uncommitted changes" : `${b.author}, ${timeAgo(b.time)} • ${summary}`;
      const end = model.getLineMaxColumn(line);
      shown.set([
        {
          range: new monaco.Range(line, end, line, end),
          options: {
            showIfCollapsed: true,
            after: { content: "\u2003\u2003" + label, inlineClassName: "line-blame-text", cursorStops: monaco.editor.InjectedTextCursorStops.None },
            hoverMessage: blameHover(b),
          },
        },
      ]);
      shownKey = key;
    }, delay);
  };
  const subs = [
    editor.onDidChangeCursorSelection(() => update(200)),
    editor.onDidChangeModel(() => update(200)),
    // Typing re-blames the dirty text, so wait until it pauses.
    editor.onDidChangeModelContent(() => update(800)),
    editor.onDidBlurEditorText(() => {
      clearTimeout(timer);
      clear();
    }),
    editor.onDidFocusEditorText(() => update(200)),
  ];
  const unsub = useWorkspace.subscribe((s, prev) => s.lineBlame !== prev.lineBlame && update(0));
  return {
    dispose() {
      clearTimeout(timer);
      subs.forEach((d) => d.dispose());
      unsub();
    },
  };
}

/** HEAD's text of a file, per HEAD commit; `null` = not in HEAD. */
const headTexts = new Map<string, Promise<string | null>>();

/**
 * Rider's change markers: a bar beside the line numbers for lines added
 * (green) or modified (blue) since HEAD, a notch where lines were deleted.
 */
function installLineChanges(project: Project, editor: monaco.editor.ICodeEditor): monaco.IDisposable {
  const shown = editor.createDecorationsCollection();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const update = (delay: number) => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const model = editor.getModel();
      const r = repo(project.id);
      if (!model || model.uri.scheme !== "file" || !r.root || !isWithin(model.uri.fsPath, r.root)) return shown.clear();
      const rel = relative(r.root, model.uri.fsPath);
      const key = `${r.branches?.head ?? ""}:${r.root}:${rel}`;
      let base = headTexts.get(key);
      if (!base) {
        base = api.gitFileAt(r.root, "HEAD", rel).catch(() => null);
        headTexts.set(key, base);
      }
      const version = model.getVersionId();
      let text = await base;
      // Not in HEAD: a new file added to git is all new; an unversioned one gets no markers, as in Rider.
      if (text === null && r.changes.some((c) => c.rel === rel && c.status === "added")) text = "";
      if (editor.getModel() !== model || model.getVersionId() !== version) return;
      if (text === null) return shown.clear();
      const last = model.getLineCount();
      shown.set(
        lineChanges(text, model.getValue()).map((c) => {
          const top = c.kind === "deleted" && c.start === 0;
          const line = Math.min(Math.max(c.start, 1), last);
          return {
            range: new monaco.Range(line, 1, c.kind === "deleted" ? line : Math.min(c.end, last), 1),
            options: { isWholeLine: true, linesDecorationsClassName: `line-change ${c.kind}${top ? " top" : ""}` },
          };
        }),
      );
    }, delay);
  };
  const subs = [editor.onDidChangeModel(() => update(0)), editor.onDidChangeModelContent(() => update(300))];
  // A commit, checkout or reset moves HEAD; new or staged files change what a missing HEAD file means.
  const unsub = useGit.subscribe((s, prev) => {
    const a = s.repos[project.id];
    const b = prev.repos[project.id];
    if (a?.branches?.head !== b?.branches?.head) headTexts.clear();
    if (a?.root !== b?.root || a?.branches?.head !== b?.branches?.head || a?.changes !== b?.changes) update(100);
  });
  update(0);
  return {
    dispose() {
      clearTimeout(timer);
      subs.forEach((d) => d.dispose());
      unsub();
    },
  };
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
    let cancelled = false;
    let render = () => {};
    void import("../lib/markdown").then(({ renderMarkdown }) => {
      if (cancelled) return;
      render = () => setHtml(renderMarkdown(model.getValue()));
      render();
    });
    let t: ReturnType<typeof setTimeout>;
    const sub = model.onDidChangeContent(() => {
      clearTimeout(t);
      t = setTimeout(() => render(), 150);
    });
    return () => {
      cancelled = true;
      clearTimeout(t);
      sub.dispose();
    };
  }, [path]);
  return <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />;
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
  const dirty = files.filter((p) => metaDirty(meta[p]));
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
            {metaDirty(m) || metaDirty(meta[editedFile(t.path) ?? ""]) ? (
              <span className="dirty-dot" title="Unsaved changes" />
            ) : null}
            <button
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                void closeTabsWithPrompt(project.id, [t.path]);
              }}
            >
              <X size={15} />
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

/** Lists `dir` in a menu at `at`; folders drill down in place, files open. */
async function openDirMenu(project: Project, dir: string, at: { clientX: number; clientY: number }, current?: string): Promise<void> {
  let entries;
  try {
    entries = (await api.listDir(dir, true)).filter((e) => !e.nestedUnder);
  } catch (e) {
    return toast(errorMessage(e), "error");
  }
  entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
  openMenu(
    at,
    entries.length
      ? entries.map((e) => ({
          label: (e.path === current ? "• " : "") + e.name + (e.isDir ? "/" : ""),
          action: () =>
            e.isDir ? void openDirMenu(project, e.path, at, current) : useWorkspace.getState().openFile(project.id, e.path),
        }))
      : [{ label: "Empty folder", disabled: true }],
  );
}

function crumbMenu(project: Project, path: string, isDir: boolean) {
  return [
    ...(isDir ? [] : [{ label: "Close", action: () => void closeTabsWithPrompt(project.id, [path]) }, { separator: true }]),
    { label: "Copy Path", action: () => void navigator.clipboard.writeText(path) },
    { label: "Copy Relative Path", action: () => void navigator.clipboard.writeText(relative(project.path, path)) },
    { label: "Select in Project View", shortcut: shortcutLabel("selectInProject"), action: () => revealInTree(project, path) },
    { label: "Reveal in File Manager", action: () => void revealItemInDir(path) },
  ];
}

/** The active file's path for the status bar, Rider style: a folder lists its contents, a file its siblings. */
export function PathCrumbs({ project, path }: { project: Project; path: string }) {
  if (!isWithin(path, project.path) || path === project.path) return <span className="status-item muted">{basename(path)}</span>;
  // Built with the OS's separator, so a crumb's path matches the listing's (Windows too).
  const crumbs = [{ name: project.name, path: project.path }];
  for (const name of relative(project.path, path).split("/")) crumbs.push({ name, path: join(crumbs[crumbs.length - 1].path, name) });
  return (
    <span className="status-item crumbs">
      {crumbs.map((c, i) => {
        const isFile = i === crumbs.length - 1;
        return (
          <span key={c.path} className="crumb-wrap">
            {i > 0 && <span className="crumb-sep">›</span>}
            <button
              className={"crumb" + (isFile ? " file" : "")}
              title={c.path}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                void openDirMenu(project, isFile ? dirname(c.path) : c.path, { clientX: r.left, clientY: r.top }, path);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                openMenu(e, crumbMenu(project, c.path, !isFile));
              }}
            >
              {c.name}
            </button>
          </span>
        );
      })}
    </span>
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
  const stickyScroll = useWorkspace((s) => s.stickyScroll);
  const codeVision = useWorkspace((s) => s.codeVision);
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
      stickyScroll: { enabled: useWorkspace.getState().stickyScroll },
      codeLens: useWorkspace.getState().codeVision,
      suggest: suggestOptions,
      bracketPairColorization: { enabled: true },
      // Roslyn's semantic tokens (lsp/csharp.ts); the theme alone would leave them off.
      "semanticHighlighting.enabled": true,
      theme: monacoTheme(),
    });
    editor.onDidChangeCursorSelection((e) => {
      const model = editor.getModel();
      const sel = e.selection;
      useCursor.setState({
        line: sel.positionLineNumber,
        column: sel.positionColumn,
        selected: model ? model.getValueLengthInRange(sel) : 0,
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
      if (!model || !pos) return;
      void showLocations(
        project,
        `Usages of ${symbolAt(editor)}`,
        () => (isCs() ? findUsages(model, pos) : findTextUsages(model, pos)),
        false,
        anchorBelow(editor, pos),
      );
    });
    codeAction("haze.gotoImplementation", "Go to Implementation", [M.CtrlCmd | M.Alt | K.KeyB], () => {
      const model = editor.getModel();
      const pos = editor.getPosition();
      if (!model || !pos || !isCs()) return;
      void showLocations(project, `Implementations of ${symbolAt(editor)}`, () => findImplementations(model, pos), true, anchorBelow(editor, pos));
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
    const lineBlame = installLineBlame(project, editor);
    const changes = installLineChanges(project, editor);
    const wheel = zedWheel(editor);
    editorRef.current = editor;
    currentEditor = editor;
    return () => {
      lineBlame.dispose();
      changes.dispose();
      wheel.dispose();
      if (shownPath.current) viewStates.set(shownPath.current, editor.saveViewState());
      editor.dispose();
      editorRef.current = null;
      if (currentEditor === editor) {
        currentEditor = null;
        currentPath = null;
      }
    };
  }, [project.id]);

  useEffect(() => {
    editorRef.current?.updateOptions({ stickyScroll: { enabled: stickyScroll } });
  }, [stickyScroll]);

  useEffect(() => {
    editorRef.current?.updateOptions({ codeLens: codeVision });
    if (!codeVision) clearUnusedMarks();
  }, [codeVision]);

  // Load the active file (applying any recovered draft once).
  useEffect(() => {
    if (!active || isImagePath(active) || active.startsWith("haze-")) return;
    const draft = recoveredDrafts.get(active);
    void ensureBuffer(active, draft).finally(() => {
      if (draft && getModel(active) && recoveredDrafts.get(active) === draft) recoveredDrafts.delete(active);
    });
  }, [active]);

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
      {active && isMarkdown && (
        <div className="editor-toolbar">
          <div className="seg small">
            <button className={"seg-btn" + (!showMd ? " on" : "")} onClick={() => setMdPreview((m) => ({ ...m, [active]: false }))}>
              Source
            </button>
            <button className={"seg-btn" + (showMd ? " on" : "")} onClick={() => setMdPreview((m) => ({ ...m, [active]: true }))}>
              Preview
            </button>
          </div>
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
