import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { AlertCircle, AlertTriangle, Check, ChevronDown, Lightbulb, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { DefinitionAction, SymbolNavigationAction } from "monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands.js";
import { disposeBuffer, ensureBuffer, getModel, isVirtualPath, metaDirty, reloadBuffer, reloadingFromDisk, saveBuffer, useBuffers } from "../lib/buffers";
import { api, errorMessage, type BlameLine } from "../lib/ipc";
import { codeFontOptions, languageFor, monaco, suggestOptions } from "../lib/monaco";
import { monacoTheme } from "../lib/theme";
import { basename, dirname, extname, isWithin, join, relative } from "../lib/path";
import { clearUnusedMarks, csharpAnswers, findImplementations, findUsages, prepareRename, renameSymbol, setCodeVisionAuthor } from "../lib/lsp/csharp";
import { lineChanges, lineMapper } from "../lib/lineChanges";
import { withNested } from "../lib/treeRows";
import { findTextUsages, registerTextNavigation } from "../lib/textNav";
import { zedWheel } from "../lib/wheel";
import { applyWorkspaceEdit } from "../lib/workspaceEdit";
import { recoveredDrafts } from "../store/persist";
import { loadDir, setSelection, useTree } from "../store/tree";
import { activeProject, projectForPath, useWorkspace, type Project } from "../store/workspace";
import * as L from "../lib/editorLayout";
import { absPath, repo, useGit } from "../store/git";
import { DiffView, diffTitle, openDiff, parseDiffPath } from "./DiffView";
import { MergeView, mergeTitle, parseMergePath } from "./MergeView";
import { showHistory } from "./GitPanel";
import { choose, externalWindows, FloatWindow, openMenu, prompt, toast, windowFocusedAt, type MenuItem } from "./Overlays";
import { showAssetUsages, showDeclarations, showLocations } from "./UsagesPopup";
import type { AssetUsage } from "../lib/ipc";
import { runUnityTests } from "../store/unity";
import { generateUnityMember, registerUnityCompletion } from "../lib/unity/generate";
import { installUnityPerf } from "../lib/unity/perfDecorations";
import { isMac, matches, shortcutLabel } from "../lib/keymap";

export const useCursor = create<{ line: number; column: number; selected: number }>(() => ({
  line: 1,
  column: 1,
  selected: 0,
}));

// Scroll and caret per group and file, kept while the tab is open.
const viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>();
const viewKey = (group: string, path: string) => `${group}\n${path}`;

// The editor of the active group, for commands run from outside (actions, shortcuts).
let currentEditor: monaco.editor.IStandaloneCodeEditor | null = null;
let currentPath: string | null = null;

/** The project and group each editor shows: navigation from it opens in its own group. */
const editorGroups = new Map<monaco.editor.ICodeEditor, { projectId: string; group: string }>();

function setCurrentEditor(editor: monaco.editor.IStandaloneCodeEditor, path: string | null) {
  currentEditor = editor;
  currentPath = path;
  const sel = editor.getSelection();
  const model = editor.getModel();
  if (sel) useCursor.setState({ line: sel.positionLineNumber, column: sel.positionColumn, selected: model ? model.getValueLengthInRange(sel) : 0 });
}

/** Makes `group` the active one, without a store update when it already is. */
function focusGroup(projectId: string, group: string) {
  const ui = useWorkspace.getState().ui[projectId];
  if (ui && L.focusGroup(ui, group) !== ui) useWorkspace.getState().editors(projectId, (e) => L.focusGroup(e, group));
}

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

// Popups closing leave focus on <body>; give it back to the editor.
window.addEventListener("haze:popup-closed", () =>
  requestAnimationFrame(() => {
    const el = document.activeElement;
    if (!el || el === document.body) currentEditor?.focus();
  }),
);

let keymapInstalled = false;

/**
 * IntelliJ keys that differ from Monaco's VS Code defaults. On macOS
 * they follow the user's "ReSharper (macOS)" keymap (see lib/keymap).
 */
function installIdeKeymap() {
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
  // Windows keys; on macOS Cmd+Y is Redo and Cmd+W closes the tab.
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
  installResultLists();
  // Ctrl+Click / Ctrl+B in languages Roslyn does not cover, and in C# until it is up.
  registerTextNavigation();
  registerUnityCompletion();
  // Navigating to another file (Ctrl+click, F12…) opens it in Haze's tabs.
  monaco.editor.registerEditorOpener({
    openCodeEditor(source, resource, selectionOrPosition) {
      const path = tabPath(resource);
      if (!path) return false;
      // In the project and group of the editor asking: opening the file in another
      // project (one nested in this folder, say) would show nothing.
      const from = editorGroups.get(source);
      const project =
        (from && useWorkspace.getState().projects.find((p) => p.id === from.projectId)) ??
        activeProject() ??
        (isVirtualPath(path) ? null : projectForPath(path));
      if (!project) return false;
      const pos =
        selectionOrPosition && "startLineNumber" in selectionOrPosition
          ? { line: selectionOrPosition.startLineNumber, column: selectionOrPosition.startColumn }
          : selectionOrPosition
            ? { line: selectionOrPosition.lineNumber, column: selectionOrPosition.column }
            : {};
      useWorkspace.getState().openFile(project.id, path, { ...pos, group: from?.projectId === project.id ? from.group : undefined });
      return true;
    },
  });
}

/** The tab showing a URI: a file, or decompiled and generated code (`csharp:`, lib/buffers.ts). */
function tabPath(uri: monaco.Uri): string | null {
  if (uri.scheme === "file") return uri.fsPath;
  return uri.scheme === "csharp" ? uri.toString(true) : null;
}

// Monaco's Go to References and Peek References (the right-click menu, and
// Ctrl+Click on a declaration, which runs Go to References instead).
const REFERENCE_ACTIONS = new Set(["editor.action.goToReferences", "editor.action.referenceSearch.trigger"]);

/**
 * Lists results in popups instead of in Monaco's peek view: several
 * declarations (a partial class, say) in the declarations list under the name,
 * usages in the usages list (as Alt+F7). Monaco has no public hook for this, so
 * its result handling for symbol navigation is wrapped. Open to the Side and
 * the other navigations (implementations, type definitions) keep Monaco's own.
 */
function installResultLists() {
  const proto = SymbolNavigationAction.prototype;
  const onResult = proto._onResult;
  proto._onResult = function (editorService, symbolNavService, editor, result, range) {
    const refs = result.references;
    const pos = editor.getPosition();
    const model = editor.getModel();
    const path = model && tabPath(model.uri);
    const word = pos && model?.getWordAtPosition(pos);
    const usages = REFERENCE_ACTIONS.has(this.desc.id);
    const declarations = this instanceof DefinitionAction && (refs.length > 1 || this.configuration.openInPeek);
    if (!(usages || declarations) || this.configuration.openToSide || !pos || !path || !word || refs.some((r) => !tabPath(r.uri)))
      return onResult.call(this, editorService, symbolNavService, editor, result, range);
    // Peek Definition with one result goes there, like Go to Definition.
    if (declarations && refs.length === 1) return this._openReference(editor, editorService, refs[0], false, true).then(() => result.dispose());
    const found = refs.map((r) => ({
      path: tabPath(r.uri)!,
      line: r.range.startLineNumber,
      column: r.range.startColumn,
      endLine: r.range.endLineNumber,
      endColumn: r.range.endColumn,
    }));
    result.dispose();
    const anchor = anchorBelow(editor, { lineNumber: pos.lineNumber, column: word.startColumn });
    const project = (isVirtualPath(path) ? null : projectForPath(path)) ?? activeProject();
    if (!usages) void showDeclarations(word.word, found, anchor);
    else if (project) void showLocations(project, `Usages of ${word.word}`, async () => found, false, anchor);
    return Promise.resolve();
  };
}

/** Rename (Shift+F6) for C# symbols, applied across files with one Undo. */
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

// Inline blame for the caret line: "Author, 2 days ago • summary" after the
// line's end, the commit's details on hover. Like Rider, the file is blamed
// once per HEAD, as committed there, and the editor's lines are mapped onto
// that through the changes since (lineMapper): typing never runs git, and a
// line added or edited since HEAD is "You, uncommitted changes".
type LineBlames = Map<number, BlameLine> | null;
/** A file's blame at HEAD by line there, per HEAD commit (keyed like headTexts); null when it is not in HEAD. */
const headBlames = new Map<string, Promise<Map<number, BlameLine> | null>>();
const lineBlames = new WeakMap<monaco.editor.ITextModel, { key: string; lines: Promise<LineBlames>; done?: Map<number, BlameLine> }>();

/** What a model's line blames depend on: the file, HEAD and the text. */
function lineBlameKey(project: Project, model: monaco.editor.ITextModel): string | null {
  const r = repo(project.id);
  if (!r.root || !r.branches?.head || !isWithin(model.uri.fsPath, r.root)) return null;
  return `${r.branches.head}:${r.root}:${model.uri.fsPath}:${model.getAlternativeVersionId()}`;
}

function caretLineBlames(project: Project, model: monaco.editor.ITextModel): Promise<LineBlames> {
  const key = lineBlameKey(project, model);
  if (!key) return Promise.resolve(null);
  const cached = lineBlames.get(model);
  if (cached?.key === key) return cached.lines;
  const r = repo(project.id);
  const root = r.root!;
  const head = r.branches!.head!;
  const rel = relative(root, model.uri.fsPath);
  const blameKey = `${head}:${root}:${rel}`;
  let blamed = headBlames.get(blameKey);
  if (!blamed) {
    blamed = api
      .gitBlame(root, rel, null, null, head)
      .then((ls) => new Map(ls.map((l) => [l.line, l])))
      .catch(() => null); // not in HEAD, or outside git
    headBlames.set(blameKey, blamed);
  }
  // This version's text: the model moves on while HEAD's text and blame come.
  const text = model.getValue();
  const lines = (async (): Promise<LineBlames> => {
    let base = await headText(root, rel, head);
    // Added to git but not committed yet: every line is new.
    if (base === null && r.changes.some((c) => c.rel === rel && c.status === "added")) base = "";
    if (base === null) return null;
    const atHead = base === "" ? new Map<number, BlameLine>() : await blamed;
    if (!atHead) return null;
    const toHead = lineMapper(base, text);
    const count = text === "" ? 0 : text.split(/\r?\n/).length;
    const now = Date.now() / 1000;
    const out = new Map<number, BlameLine>();
    for (let line = 1; line <= count; line++) {
      const at = toHead(line);
      const b = at === null ? undefined : atHead.get(at);
      out.set(line, b ? { ...b, line } : { line, hash: UNCOMMITTED, author: "", time: now, summary: "" });
    }
    return out;
  })().catch(() => null);
  const entry: { key: string; lines: Promise<LineBlames>; done?: Map<number, BlameLine> } = { key, lines };
  void lines.then((m) => (entry.done = m ?? undefined));
  lineBlames.set(model, entry);
  return lines;
}

/** The line blames of the model's current text and HEAD, if computed: shown at once. */
function knownLineBlames(project: Project, model: monaco.editor.ITextModel): Map<number, BlameLine> | undefined {
  const cached = lineBlames.get(model);
  return cached && cached.key === lineBlameKey(project, model) ? cached.done : undefined;
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

// Code Vision's author ("aprius +2"): who wrote most of the declaration's lines.
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

/** Viewport point just under `pos`, where the usages list opens. */
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

// Unity Code Vision: asset usages of a script or method, and running tests in Unity.
monaco.editor.registerCommand("haze.unityAssetUsages", (_accessor, _path: string, title: string, usages: AssetUsage[]) => {
  showAssetUsages(title, usages, null);
});

monaco.editor.registerCommand("haze.unityRunTests", (_accessor, path: string, pattern: string, label: string) => {
  const project = projectForPath(path);
  if (!project) return;
  void runUnityTests(project.id, pattern, label).then((ok) => {
    if (!ok) toast("Unity is not connected: open the project in Unity with Haze as External Script Editor.", "error");
  });
});

monaco.editor.registerCommand("haze.unityShowTests", (_accessor, path: string) => {
  const project = projectForPath(path);
  if (project) useWorkspace.getState().updateUi(project.id, { bottomVisible: true, bottomTab: "tests" });
});

function installLineBlame(project: Project, editor: monaco.editor.ICodeEditor): monaco.IDisposable {
  const shown = editor.createDecorationsCollection();
  let shownKey = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    shown.clear();
    shownKey = "";
  };
  // A commit or checkout changes the answer without changing the text.
  const keyOf = (model: monaco.editor.ITextModel, line: number) =>
    `${repo(project.id).branches?.head ?? ""}:${model.uri}:${model.getAlternativeVersionId()}:${line}`;
  const update = (delay: number) => {
    clearTimeout(timer);
    const model = editor.getModel();
    const line = editor.getSelection()?.positionLineNumber;
    const key = model && line ? keyOf(model, line) : "";
    // Moving along the same line keeps the annotation (no flicker).
    if (key && key === shownKey) return;
    clear();
    if (!model || !line || model.uri.scheme !== "file" || !useWorkspace.getState().lineBlame) return;
    const show = (b: BlameLine | undefined) => {
      // Full Annotate is on: it already says it.
      if (!b || blameDecorations.has(model)) return;
      if (editor.getModel() !== model || editor.getSelection()?.positionLineNumber !== line || line > model.getLineCount()) return;
      if (keyOf(model, line) !== key) return;
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
    };
    // This text's blame is already here: no wait. The timer still re-asks once it's due.
    const known = knownLineBlames(project, model)?.get(line);
    show(known);
    timer = setTimeout(async () => {
      const b = (await caretLineBlames(project, model))?.get(line);
      if (b !== known) show(b);
    }, delay);
  };
  const subs = [
    editor.onDidChangeCursorSelection(() => update(200)),
    editor.onDidChangeModel(() => update(200)),
    // Typing maps the lines again (no git), once it pauses.
    editor.onDidChangeModelContent(() => update(300)),
    editor.onDidBlurEditorText(() => {
      clearTimeout(timer);
      clear();
    }),
    editor.onDidFocusEditorText(() => update(200)),
  ];
  const unsub = useWorkspace.subscribe((s, prev) => s.lineBlame !== prev.lineBlame && update(0));
  const unsubGit = useGit.subscribe((s, prev) => s.repos[project.id]?.branches?.head !== prev.repos[project.id]?.branches?.head && update(0));
  return {
    dispose() {
      clearTimeout(timer);
      subs.forEach((d) => d.dispose());
      unsub();
      unsubGit();
    },
  };
}

/** HEAD's text of a file, per HEAD commit; `null` = not in HEAD. */
const headTexts = new Map<string, Promise<string | null>>();

/** `rel` as committed in `head` (a hash; "" before the first commit). */
function headText(root: string, rel: string, head: string): Promise<string | null> {
  const key = `${head}:${root}:${rel}`;
  let text = headTexts.get(key);
  if (!text) {
    // By hash: HEAD may have moved since `head` was read.
    text = api.gitFileAt(root, head || "HEAD", rel).catch(() => null);
    headTexts.set(key, text);
  }
  return text;
}

/**
 * Change markers: a bar beside the line numbers for lines added
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
      const version = model.getVersionId();
      let text = await headText(r.root, rel, r.branches?.head ?? "");
      // Not in HEAD: a new file added to git is all new; an unversioned one gets no markers.
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
    if (a?.branches?.head !== b?.branches?.head) {
      headTexts.clear();
      headBlames.clear();
    }
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

/**
 * Rider's file status in the editor's corner: errors, warnings and
 * suggestions in the file (from the last build and live analysis), or a green
 * check. A click goes to the next one.
 */
function InspectionStatus({ path, editor }: { path: string; editor: React.RefObject<monaco.editor.IStandaloneCodeEditor | null> }) {
  const uri = useMemo(() => monaco.Uri.file(path), [path]);
  const [counts, setCounts] = useState({ errors: 0, warnings: 0, infos: 0, csharp: false });
  useEffect(() => {
    const count = () => {
      const markers = monaco.editor.getModelMarkers({ resource: uri });
      const n = (s: monaco.MarkerSeverity) => markers.filter((m) => m.severity === s).length;
      // The check only once Roslyn has looked at the file.
      const model = monaco.editor.getModel(uri);
      const csharp = !!model && model.getLanguageId() === "csharp" && csharpAnswers(model);
      setCounts({ errors: n(monaco.MarkerSeverity.Error), warnings: n(monaco.MarkerSeverity.Warning), infos: n(monaco.MarkerSeverity.Info), csharp });
    };
    count();
    const sub = monaco.editor.onDidChangeMarkers((uris) => {
      if (uris.some((u) => u.toString() === uri.toString())) count();
    });
    return () => sub.dispose();
  }, [uri]);
  const { errors, warnings, infos, csharp } = counts;
  if (!errors && !warnings && !infos && !csharp) return null;
  const next = () => {
    const e = editor.current;
    if (!e) return;
    e.focus();
    void e.getAction("editor.action.marker.next")?.run();
  };
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const title = errors || warnings || infos
    ? [errors && plural(errors, "error"), warnings && plural(warnings, "warning"), infos && plural(infos, "suggestion")].filter(Boolean).join(", ") + ": click for the next one"
    : "No problems found";
  return (
    <button className="inspection-status" title={title} onClick={next}>
      {errors > 0 && (
        <span>
          <AlertCircle size={13} className="sev-error" /> {errors}
        </span>
      )}
      {warnings > 0 && (
        <span>
          <AlertTriangle size={13} className="sev-warning" /> {warnings}
        </span>
      )}
      {infos > 0 && (
        <span>
          <Lightbulb size={13} className="sev-info" /> {infos}
        </span>
      )}
      {!errors && !warnings && !infos && <Check size={14} className="sev-ok" />}
    </button>
  );
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

/** Closes tabs (in `group`, or in every group), asking about unsaved changes. Returns false if cancelled. */
export async function closeTabsWithPrompt(projectId: string, paths: string[], group?: string): Promise<boolean> {
  const closing = new Set(paths);
  return closeWithPrompt(
    projectId,
    (g, p) => (!group || g === group) && closing.has(p),
    paths,
    () => useWorkspace.getState().closeTabs(projectId, paths, group),
  );
}

/** Closes a detached editor window and its tabs; cancelled, they go back to the main window. */
export async function closeEditorWindow(projectId: string, windowId: string): Promise<void> {
  const ui = useWorkspace.getState().ui[projectId];
  const win = ui?.windows.find((w) => w.id === windowId);
  if (!ui || !win) return;
  const ids = new Set(L.layoutGroups(win.layout));
  const groups = ui.groups.filter((g) => ids.has(g.id));
  const closed = await closeWithPrompt(
    projectId,
    (g) => ids.has(g),
    groups.flatMap((g) => g.tabs.map((t) => t.path)),
    () => useWorkspace.getState().editors(projectId, (e) => groups.reduce((acc, g) => L.closeTabs(acc, g.tabs.map((t) => t.path), g.id), e)),
  );
  if (!closed) useWorkspace.getState().editors(projectId, (e) => L.dockWindow(e, windowId));
}

/**
 * Asks about unsaved changes in the files of the tabs closing (`closing` by
 * group and path), then closes them with `close`. Returns false if cancelled.
 */
async function closeWithPrompt(projectId: string, closing: (group: string, path: string) => boolean, paths: string[], close: () => void): Promise<boolean> {
  // Files another tab still shows (another group, another project) keep their buffer.
  const kept = new Set(
    Object.entries(useWorkspace.getState().ui).flatMap(([id, u]) =>
      u.groups.flatMap((g) => g.tabs.filter((t) => id !== projectId || !closing(g.id, t.path)).map((t) => editedFile(t.path))),
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
  close();
  for (const f of files) {
    recoveredDrafts.delete(f);
    disposeBuffer(f);
  }
  // View states of tabs no group shows any more.
  const shown = new Set(Object.values(useWorkspace.getState().ui).flatMap((u) => u.groups.flatMap((g) => g.tabs.map((t) => viewKey(g.id, t.path)))));
  for (const key of [...viewStates.keys()]) if (!shown.has(key)) viewStates.delete(key);
  return true;
}

/** Rider's split actions for a tab, in its context menu and Find Action. */
function splitMenu(project: Project, group: string, path: string): MenuItem[] {
  const ui = useWorkspace.getState().ui[project.id];
  if (!ui) return [];
  const op = (f: (e: L.Editors) => L.Editors) => () => useWorkspace.getState().editors(project.id, f);
  const win = L.windowOf(ui, group);
  const inWindow = L.layoutGroups(win ? win.layout : ui.layout);
  const single = (L.groupById(ui, group)?.tabs.length ?? 0) < 2;
  const opposite = L.neighbourGroup(win ? win.layout : ui.layout, group);
  return [
    { label: "Split Vertically", shortcut: shortcutLabel("splitVertically"), action: op((e) => L.splitTab(e, group, path, "right", false)) },
    { label: "Split Horizontally", shortcut: shortcutLabel("splitHorizontally"), action: op((e) => L.splitTab(e, group, path, "bottom", false)) },
    { label: "Split and Move Right", disabled: single, action: op((e) => L.splitTab(e, group, path, "right", true)) },
    { label: "Split and Move Down", disabled: single, action: op((e) => L.splitTab(e, group, path, "bottom", true)) },
    {
      label: "Move to Opposite Group",
      shortcut: shortcutLabel("moveToOppositeGroup"),
      disabled: !opposite,
      action: op((e) => (opposite ? L.moveTab(e, group, path, opposite) : e)),
    },
    { label: "Unsplit", shortcut: shortcutLabel("unsplit"), disabled: inWindow.length < 2, action: op((e) => L.unsplit(e, group)) },
    { label: "Unsplit All", disabled: inWindow.length < 2, action: op((e) => L.unsplitAll(e, group)) },
    { separator: true },
    { label: "Open in New Window", shortcut: shortcutLabel("openInNewWindow"), action: op((e) => L.detachTab(e, group, path)) },
    ...(win ? [{ label: "Move to Main Window", action: op((e) => L.moveTab(e, group, path, e.mainGroup)) }] : []),
  ];
}

/** Where a dragged tab would land: a place in a tab bar, a side of a group to split, or a window of its own. */
type TabDrop =
  | { kind: "tab"; group: string; index: number; rect: DOMRect }
  | { kind: "group"; group: string; side: L.Side | null; rect: DOMRect }
  | { kind: "window" };

/** The pointer during a tab drag: the window and document it is over, there, and the drop it would make. */
interface TabDragAt {
  doc: Document;
  /** Tauri label of the window it is over, when not the drag's own. */
  label: string | null;
  x: number;
  y: number;
  drop: TabDrop | null;
}

/** One of Haze's windows on screen: its content's top left in logical pixels, and CSS pixels to those (page zoom). */
interface WindowBox {
  win: Window;
  label: string;
  left: number;
  top: number;
  zoom: number;
}

/**
 * Where Haze's windows are, to carry a tab dragged out of one into another,
 * the last focused first (no z-order is to be had; it is the nearest guess at
 * which is in front). Minimized and hidden ones are left out. Empty outside
 * Tauri, where the editor windows are panels in the main one.
 */
async function windowBoxes(): Promise<WindowBox[]> {
  if (!("__TAURI_INTERNALS__" in window)) return [];
  const { WebviewWindow, getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const at = (w: Window) => windowFocusedAt.get(w) ?? 0;
  const all: [Window, string][] = [...externalWindows, [window, getCurrentWebviewWindow().label] as [Window, string]].sort(([a], [b]) => at(b) - at(a));
  const boxes = await Promise.all(
    all.map(async ([win, label]) => {
      const w = win.closed ? null : await WebviewWindow.getByLabel(label);
      if (!w) return null;
      const [pos, size, scale, minimized, visible] = await Promise.all([w.innerPosition(), w.innerSize(), w.scaleFactor(), w.isMinimized(), w.isVisible()]);
      if (minimized || !visible) return null;
      return { win, label, left: pos.x / scale, top: pos.y / scale, zoom: size.width / scale / (win.innerWidth || 1) };
    }),
  );
  return boxes.filter((b): b is WindowBox => !!b);
}

/**
 * The drop under the pointer at `x`, `y` in `doc`, the document the drag
 * started in. Outside its window, in another of Haze's windows (`boxes`) the
 * pointer is over; outside all of them, a window of its own.
 */
function tabDropAt(projectId: string, doc: Document, x: number, y: number, boxes: WindowBox[]): TabDragAt {
  const win = doc.defaultView!;
  const owns = (group: string) => !!useWorkspace.getState().ui[projectId]?.groups.some((g) => g.id === group);
  if (x >= 0 && y >= 0 && x <= win.innerWidth && y <= win.innerHeight) return { doc, label: null, x, y, drop: tabDropIn(doc, x, y, owns) };
  const from = boxes.find((b) => b.win === win);
  if (from) {
    const sx = from.left + x * from.zoom;
    const sy = from.top + y * from.zoom;
    for (const b of boxes) {
      if (b === from || b.win.closed) continue;
      const cx = (sx - b.left) / b.zoom;
      const cy = (sy - b.top) / b.zoom;
      if (cx < 0 || cy < 0 || cx > b.win.innerWidth || cy > b.win.innerHeight) continue;
      return { doc: b.win.document, label: b.label, x: cx, y: cy, drop: tabDropIn(b.win.document, cx, cy, owns) };
    }
  }
  return { doc, label: null, x, y, drop: { kind: "window" } };
}

/** The drop at `x`, `y` in `doc`, on a group of the project (`owns`). */
function tabDropIn(doc: Document, x: number, y: number, owns: (group: string) => boolean): TabDrop | null {
  const el = doc.elementFromPoint(x, y);
  const tab = el?.closest<HTMLElement>(".editor-tab");
  const bar = el?.closest<HTMLElement>(".editor-tabs");
  if (bar?.dataset.group) {
    if (!owns(bar.dataset.group)) return null;
    const tabs = [...bar.querySelectorAll<HTMLElement>(".editor-tab:not(.overflowed)")];
    if (tab && !tab.classList.contains("overflowed")) {
      const r = tab.getBoundingClientRect();
      const after = x > r.left + r.width / 2;
      const index = Number(tab.dataset.index) + (after ? 1 : 0);
      return { kind: "tab", group: bar.dataset.group, index, rect: new DOMRect(after ? r.right - 1 : r.left - 1, r.top, 2, r.height) };
    }
    const last = tabs[tabs.length - 1]?.getBoundingClientRect();
    const r = bar.getBoundingClientRect();
    const index = tabs.length ? Number(tabs[tabs.length - 1].dataset.index) + 1 : 0;
    return { kind: "tab", group: bar.dataset.group, index, rect: new DOMRect(last ? last.right - 1 : r.left, r.top, 2, r.height) };
  }
  const stack = el?.closest<HTMLElement>(".editor-group");
  if (!stack?.dataset.group || !owns(stack.dataset.group)) return null;
  const body = stack.querySelector(".editor-stack")?.getBoundingClientRect() ?? stack.getBoundingClientRect();
  const fx = (x - body.left) / body.width;
  const fy = (y - body.top) / body.height;
  // The outer quarter on each side splits there; the middle moves the tab into the group.
  const edges: [L.Side, number][] = [
    ["left", fx],
    ["right", 1 - fx],
    ["top", fy],
    ["bottom", 1 - fy],
  ];
  const [side, dist] = edges.reduce((a, b) => (b[1] < a[1] ? b : a));
  if (dist > 0.25) return { kind: "group", group: stack.dataset.group, side: null, rect: body };
  const { left, top, width, height } = body;
  const rect =
    side === "left" ? new DOMRect(left, top, width / 2, height)
    : side === "right" ? new DOMRect(left + width / 2, top, width / 2, height)
    : side === "top" ? new DOMRect(left, top, width, height / 2)
    : new DOMRect(left, top + height / 2, width, height / 2);
  return { kind: "group", group: stack.dataset.group, side, rect };
}

/** A tab dragged out of a window of its own (its only tab) would just get another one. */
function aloneInWindow(e: L.Editors, group: string): boolean {
  const win = L.windowOf(e, group);
  return !!win && L.layoutGroups(win.layout).length === 1 && (L.groupById(e, group)?.tabs.length ?? 0) < 2;
}

/** Applies a tab drop: reorder, move to another group (in another window too), split, or a window of its own. */
function dropTab(project: Project, from: string, path: string, drop: TabDrop) {
  useWorkspace.getState().editors(project.id, (e) => {
    if (drop.kind === "window") return aloneInWindow(e, from) ? e : L.detachTab(e, from, path);
    if (drop.kind === "tab") {
      // Within its own bar, the index counts the tab itself.
      const g = L.groupById(e, drop.group);
      const at = g?.tabs.findIndex((t) => t.path === path) ?? -1;
      const index = drop.group === from && at >= 0 && at < drop.index ? drop.index - 1 : drop.index;
      return L.moveTab(e, from, path, drop.group, index);
    }
    if (drop.side) {
      // Its only tab beside its own group: nothing would change.
      if (drop.group === from && (L.groupById(e, from)?.tabs.length ?? 0) < 2) return e;
      return L.splitTab(e, from, path, drop.side, true, drop.group);
    }
    return drop.group === from ? e : L.moveTab(e, from, path, drop.group);
  });
}

/** Drawn in the window the pointer is over: the drop's place, and the tab's name by the pointer. */
function TabDragGhost({ label, at, newWindow }: { label: string; at: TabDragAt; newWindow: boolean }) {
  const { doc, x, y, drop } = at;
  const r = drop && drop.kind !== "window" ? drop.rect : null;
  return createPortal(
    <>
      {r && <div className={"tab-drop-zone" + (drop?.kind === "tab" ? " caret" : "")} style={{ left: r.left, top: r.top, width: r.width, height: r.height }} />}
      <div className="tab-drag-ghost" style={{ left: x + 12, top: y + 8 }}>
        {label}
        {newWindow && <span className="muted"> · Open in New Window</span>}
      </div>
    </>,
    doc.body,
  );
}

function TabBar({ project, group }: { project: Project; group: L.EditorGroup }) {
  const meta = useBuffers((s) => s.meta);
  const tabs = group.tabs;
  const active = useWorkspace((s) => s.ui[project.id]?.activeGroup === group.id);
  const activate = (path: string) => useWorkspace.getState().editors(project.id, (e) => L.activateTab(e, group.id, path));

  const tabMenu = (path: string): MenuItem[] => [
    { label: "Close", shortcut: shortcutLabel("closeTab"), action: () => void closeTabsWithPrompt(project.id, [path], group.id) },
    {
      label: "Close Others",
      action: () => void closeTabsWithPrompt(project.id, tabs.filter((t) => t.path !== path).map((t) => t.path), group.id),
    },
    { label: "Close All", action: () => void closeTabsWithPrompt(project.id, tabs.map((t) => t.path), group.id) },
    { separator: true },
    { label: "Keep Open (Pin Preview)", action: () => useWorkspace.getState().pinTab(project.id, path) },
    { separator: true },
    ...splitMenu(project, group.id, path),
    { separator: true },
    { label: "Copy Path", action: () => void navigator.clipboard.writeText(path) },
    { label: "Copy Relative Path", action: () => void navigator.clipboard.writeText(relative(project.path, path)) },
    { label: "Select in Project View", shortcut: shortcutLabel("selectInProject"), action: () => revealInTree(project, path) },
    { label: "Reveal in File Manager", action: () => void revealItemInDir(path) },
  ];

  // Dragging a tab: to another place in a bar, another group, a side of a group
  // (a new split), or out of the window (a window of its own).
  const [drag, setDrag] = useState<{ label: string; at: TabDragAt; newWindow: boolean } | null>(null);
  const dragged = useRef(false);
  const onTabPointerDown = (e: React.PointerEvent<HTMLDivElement>, path: string) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest(".tab-close")) return;
    // Without this the drag also starts a native text selection that sweeps across the editor.
    e.preventDefault();
    const el = e.currentTarget;
    const doc = el.ownerDocument;
    const [startX, startY] = [e.clientX, e.clientY];
    let started = false;
    let at: TabDragAt | null = null;
    // Haze's windows don't move during a drag: where they are is asked once.
    let boxes: WindowBox[] = [];
    void windowBoxes().then((b) => (boxes = b)).catch(() => {});
    // Keeps the events coming to the tab wherever the pointer goes, outside the window too.
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      if (!started && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
      started = true;
      at = tabDropAt(project.id, doc, ev.clientX, ev.clientY, boxes);
      const ui = useWorkspace.getState().ui[project.id];
      const newWindow = at.drop?.kind === "window" && !!ui && !aloneInWindow(ui, group.id);
      setDrag({ label: tabTitle(path), at, newWindow });
    };
    const end = (apply: boolean) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", cancel);
      el.removeEventListener("lostpointercapture", cancel);
      doc.defaultView?.removeEventListener("keydown", key, true);
      if (!started) return;
      dragged.current = true;
      setTimeout(() => (dragged.current = false));
      setDrag(null);
      const done = at as TabDragAt | null;
      if (!apply || !done?.drop) return;
      dropTab(project, group.id, path, done.drop);
      // Dropped in another window: it comes to the front, as its editor has the tab now.
      if (done.label) {
        const label = done.label;
        void import("@tauri-apps/api/webviewWindow").then(async ({ WebviewWindow }) => (await WebviewWindow.getByLabel(label))?.setFocus()).catch(() => {});
      }
    };
    const up = () => end(true);
    const cancel = () => end(false);
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || !started) return;
      ev.preventDefault();
      ev.stopPropagation();
      end(false);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", cancel);
    el.addEventListener("lostpointercapture", cancel);
    doc.defaultView?.addEventListener("keydown", key, true);
  };

  // A single row: tabs that don't fit are hidden behind a ▾ list instead of scrolled,
  // and the row shifts just enough to keep the active tab in it.
  const barRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ first: 0, last: Infinity });
  const [, relayout] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    // From the bar's own window: a detached one's resizing is not seen by the main window's observer.
    const win = (barRef.current!.ownerDocument.defaultView ?? window) as Window & typeof globalThis;
    const ro = new win.ResizeObserver(relayout);
    ro.observe(barRef.current!);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    const bar = barRef.current!;
    const els = [...stripRef.current!.children] as HTMLElement[];
    const widths = els.map((el) => el.offsetWidth);
    const style = getComputedStyle(bar);
    const gap = parseFloat(getComputedStyle(stripRef.current!).columnGap) || 0;
    let avail = bar.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const span = (a: number, b: number) => widths.slice(a, b + 1).reduce((x, w) => x + w + gap, -gap);
    let next = { first: 0, last: widths.length - 1 };
    if (widths.length && span(0, widths.length - 1) > avail) {
      avail -= OVERFLOW_BUTTON + gap;
      const active = tabs.findIndex((t) => t.path === group.activeTab);
      let first = Math.min(range.first, widths.length - 1);
      if (active >= 0 && active < first) first = active;
      const fill = (a: number) => {
        let b = a;
        while (b + 1 < widths.length && span(a, b + 1) <= avail) b++;
        return b;
      };
      let last = fill(first);
      if (active > last) {
        first = active;
        while (first > 0 && span(first - 1, active) <= avail) first--;
        last = fill(first);
      }
      // Room left at the end (tabs closed there): bring earlier tabs back.
      while (first > 0 && span(first - 1, last) <= avail) first--;
      next = { first, last };
    }
    if (next.first !== range.first || next.last !== range.last) setRange(next);
  });
  const hidden = tabs.filter((_, i) => i < range.first || i > range.last);

  return (
    <div className={"editor-tabs" + (active ? " active-group" : "")} ref={barRef} data-group={group.id}>
      <div className="editor-tabs-strip" ref={stripRef}>
        {tabs.map((t, i) => {
          const m = meta[t.path];
          return (
            <div
              key={t.path}
              data-index={i}
              className={
                "editor-tab" +
                (t.path === group.activeTab ? " active" : "") +
                (t.preview ? " preview" : "") +
                (i < range.first || i > range.last ? " overflowed" : "")
              }
              title={t.path}
              onPointerDown={(e) => onTabPointerDown(e, t.path)}
              onClick={() => !dragged.current && activate(t.path)}
              onDoubleClick={() => useWorkspace.getState().pinTab(project.id, t.path)}
              onMouseDown={(e) => {
                // The selection a drag would start (see onTabPointerDown): WebKit starts it on mousedown.
                if (e.button === 0) e.preventDefault();
                if (e.button === 1) {
                  e.preventDefault();
                  void closeTabsWithPrompt(project.id, [t.path], group.id);
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
                  void closeTabsWithPrompt(project.id, [t.path], group.id);
                }}
              >
                <X size={15} />
              </button>
            </div>
          );
        })}
      </div>
      {hidden.length > 0 && (
        <button
          className="editor-tabs-more"
          title="Show Hidden Tabs"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            openMenu(
              { clientX: r.left, clientY: r.bottom, target: e.currentTarget },
              hidden.map((t) => ({
                label: tabTitle(t.path),
                action: () => activate(t.path),
              })),
            );
          }}
        >
          <ChevronDown size={14} />
          {hidden.length}
        </button>
      )}
      {drag && <TabDragGhost {...drag} />}
    </div>
  );
}

/** Width of `.editor-tabs-more`, reserved once the tabs overflow. */
const OVERFLOW_BUTTON = 36;

function tabTitle(path: string): string {
  const diff = parseDiffPath(path);
  const merge = parseMergePath(path);
  return diff ? diffTitle(diff) : merge ? mergeTitle(merge) : basename(path);
}

/** `show: false` leaves a hidden Project view hidden (Always Select Opened File). */
export function revealInTree(project: Project, path: string, { show = true } = {}): void {
  const ws = useWorkspace.getState();
  const dirs: string[] = [];
  let cur = dirname(path);
  while (cur && cur.length >= project.path.length) {
    dirs.push(cur);
    const next = dirname(cur);
    if (next === cur) break;
    cur = next;
  }
  ws.updateUi(project.id, (u) => ({ expanded: [...new Set([...u.expanded, ...dirs])], ...(show && { sidebarVisible: true }) }));
  setSelection(project.id, [path], path);
  // A nested file (appsettings.Development.json) shows once the files it is under are open too.
  const parent = dirname(path);
  void loadDir(parent, ws.nestFiles).then(() => {
    const st = useTree.getState().dirs[parent];
    if (!st || !("entries" in st)) return;
    const byName = new Map(st.entries.map((e) => [e.name, e]));
    const files: string[] = [];
    // Paths as listed, which the tree's expanded set is compared with.
    for (let e = byName.get(basename(path)); e?.nestedUnder && files.length < st.entries.length; ) {
      e = byName.get(e.nestedUnder);
      if (e) files.push(e.path);
    }
    if (files.length) useWorkspace.getState().updateUi(project.id, (u) => ({ expanded: [...new Set([...u.expanded, ...files])] }));
  });
}

/** Lists `dir` in a menu at `at`; folders drill down in place, files open. */
async function openDirMenu(project: Project, dir: string, at: { clientX: number; clientY: number }, current?: string): Promise<void> {
  let entries;
  try {
    // `.meta` files stay hidden, as in the Unity view.
    entries = (await api.listDir(dir, useWorkspace.getState().nestFiles)).filter((e) => !(e.nestedUnder && e.name.endsWith(".meta")));
  } catch (e) {
    return toast(errorMessage(e), "error");
  }
  entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
  // Nested files under theirs, indented (em spaces: menus collapse plain ones).
  openMenu(
    at,
    entries.length
      ? withNested(entries).map(({ entry: e, depth }) => ({
          label: "\u2003".repeat(depth) + (e.path === current ? "• " : "") + e.name + (e.isDir ? "/" : ""),
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

/** The active file's path for the status bar: a folder lists its contents, a file its siblings. */
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

/** One editor group: its tab bar and an editor (or a diff, image, preview…) for its active tab. */
function EditorGroupView({ project, group }: { project: Project; group: L.EditorGroup }) {
  const isActive = useWorkspace((s) => s.ui[project.id]?.activeGroup === group.id);
  const reveal = useWorkspace((s) => s.reveal);
  const stickyScroll = useWorkspace((s) => s.stickyScroll);
  const codeVision = useWorkspace((s) => s.codeVision);
  const active = group.activeTab;
  const meta = useBuffers((s) => (active ? s.meta[active] : undefined));
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const shownPath = useRef<string | null>(null);

  // One editor instance per group; models are swapped on tab change.
  useEffect(() => {
    if (!host.current) return;
    installIdeKeymap();
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
      // Roslyn's semantic tokens (lsp/csharp.ts); the theme alone would leave them off.
      "semanticHighlighting.enabled": true,
      theme: monacoTheme(),
    });
    editorGroups.set(editor, { projectId: project.id, group: group.id });
    editor.onDidFocusEditorWidget(() => {
      setCurrentEditor(editor, shownPath.current);
      focusGroup(project.id, group.id);
    });
    editor.onDidChangeCursorSelection((e) => {
      if (currentEditor !== editor) return;
      const model = editor.getModel();
      const sel = e.selection;
      useCursor.setState({
        line: sel.positionLineNumber,
        column: sel.positionColumn,
        selected: model ? model.getValueLengthInRange(sel) : 0,
      });
    });
    editor.onDidChangeModelContent(() => {
      // Editing a preview tab keeps it; an agent changing the file on disk does not.
      if (reloadingFromDisk()) return;
      const path = shownPath.current;
      const ws = useWorkspace.getState();
      if (path && ws.ui[project.id]?.groups.some((g) => g.tabs.some((t) => t.path === path && t.preview))) ws.pinTab(project.id, path);
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
    // On macOS Previous Error is on Shift+F12.
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
    // Generate: Haze generates Unity event functions. On macOS Ctrl+Enter, IntelliJ's
    // other Generate key: Cmd+N is Search Everywhere in Haze.
    codeAction("haze.generate", "Generate Unity Event Function…", isMac ? [M.WinCtrl | K.Enter] : [M.Alt | K.Insert], () => {
      if (!generateUnityMember(editor)) toast("Generate works in the classes of Unity scripts (MonoBehaviour, ScriptableObject, Editor…).");
    }, "1_modification");
    const lineBlame = installLineBlame(project, editor);
    const changes = installLineChanges(project, editor);
    const unityPerf = installUnityPerf(editor);
    const wheel = zedWheel(editor);
    editorRef.current = editor;
    if (!currentEditor || useWorkspace.getState().ui[project.id]?.activeGroup === group.id) currentEditor = editor;
    return () => {
      lineBlame.dispose();
      changes.dispose();
      unityPerf.dispose();
      wheel.dispose();
      if (shownPath.current) viewStates.set(viewKey(group.id, shownPath.current), editor.saveViewState());
      editorGroups.delete(editor);
      editor.dispose();
      editorRef.current = null;
      if (currentEditor === editor) {
        currentEditor = null;
        currentPath = null;
      }
    };
  }, [project.id, group.id]);

  // The active group's editor is the one commands act on.
  useEffect(() => {
    const editor = editorRef.current;
    if (isActive && editor) setCurrentEditor(editor, shownPath.current);
  }, [isActive]);

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
    if (prev && prev !== active) viewStates.set(viewKey(group.id, prev), editor.saveViewState());
    const model = active && ready ? getModel(active) : null;
    if (editor.getModel() !== model) {
      editor.setModel(model);
      // Decompiled and generated code is shown, never edited.
      editor.updateOptions({ readOnly: !!active && isVirtualPath(active), readOnlyMessage: { value: "Decompiled or generated code: read-only" } });
      shownPath.current = model ? active : null;
      if (currentEditor === editor) currentPath = shownPath.current;
      // A file split off keeps its place: the state of the group it came from, until it has one here.
      const vs = active ? (viewStates.get(viewKey(group.id, active)) ?? lastViewState(active)) : null;
      if (model && vs) editor.restoreViewState(vs);
    }
    // Only the active group takes focus: the others are just shown (a split restored at startup).
    if (model && useWorkspace.getState().ui[project.id]?.activeGroup === group.id) editor.focus();
  }, [active, ready]);

  // Jump to a requested line (terminal links, later: navigation).
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !reveal || reveal.group !== group.id || reveal.path !== active || !ready) return;
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
    <div
      className={"editor-group" + (isActive ? " active" : "")}
      data-group={group.id}
      onPointerDownCapture={() => focusGroup(project.id, group.id)}
    >
      <TabBar project={project} group={group} />
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
        {/* Hidden under the preview too: over a background image the preview is glass, and the source would show through. */}
        <div ref={host} className="monaco-host" style={{ visibility: ready && !image && !special && !showMd ? "visible" : "hidden" }} />
        {active && ready && !image && !special && !showMd && meta?.status === "text" && !isVirtualPath(active) && (
          <InspectionStatus path={active} editor={editorRef} />
        )}
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

/** The latest view state of `path` in any group, for the first time another group shows it. */
function lastViewState(path: string): monaco.editor.ICodeEditorViewState | null {
  if (currentPath === path && currentEditor) return currentEditor.saveViewState();
  for (const [key, vs] of viewStates) if (key.endsWith("\n" + path)) return vs;
  return null;
}

/** A split's children side by side or stacked, sized by fractions, with a handle between each two. */
function SplitView({ project, node, path }: { project: Project; node: L.EditorLayout; path: number[] }) {
  const groups = useWorkspace((s) => s.ui[project.id]?.groups);
  const ref = useRef<HTMLDivElement>(null);
  if ("group" in node) {
    const g = groups?.find((x) => x.id === node.group);
    return g ? <EditorGroupView key={g.id} project={project} group={g} /> : null;
  }
  const row = node.split === "row";
  const resize = (e: React.PointerEvent<HTMLDivElement>, i: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const box = ref.current!.getBoundingClientRect();
    const total = row ? box.width : box.height;
    const start = row ? e.clientX : e.clientY;
    const sizes = [...node.sizes];
    const pair = sizes[i] + sizes[i + 1];
    const min = Math.min(pair / 2, 120 / total);
    const panes = [...ref.current!.children].filter((c) => !c.classList.contains("split-handle")) as HTMLElement[];
    const move = (ev: PointerEvent) => {
      const d = ((row ? ev.clientX : ev.clientY) - start) / total;
      sizes[i] = Math.max(min, Math.min(pair - min, node.sizes[i] + d));
      sizes[i + 1] = pair - sizes[i];
      // Live on the elements; the store once dropped.
      panes[i].style.flexGrow = String(sizes[i]);
      panes[i + 1].style.flexGrow = String(sizes[i + 1]);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("lostpointercapture", up);
      useWorkspace.getState().updateUi(project.id, (ui) => resizeIn(ui, path, sizes));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("lostpointercapture", up);
  };
  return (
    <div ref={ref} className={"editor-split " + node.split}>
      {node.children.map((child, i) => (
        <SplitPane key={"group" in child ? child.group : `split-${i}`} grow={node.sizes[i]} handle={i > 0 ? (e) => resize(e, i - 1) : null} row={row}>
          <SplitView project={project} node={child} path={[...path, i]} />
        </SplitPane>
      ))}
    </div>
  );
}

function SplitPane({ grow, handle, row, children }: { grow: number; handle: ((e: React.PointerEvent<HTMLDivElement>) => void) | null; row: boolean; children: React.ReactNode }) {
  return (
    <>
      {handle && <div className={"split-handle " + (row ? "vertical" : "horizontal")} onPointerDown={handle} />}
      <div className="editor-split-pane" style={{ flexGrow: grow }}>
        {children}
      </div>
    </>
  );
}

/** `path` starts with the window: -1 for the main window, else the index of a detached one. */
function resizeIn(ui: L.Editors, path: number[], sizes: number[]): Partial<L.Editors> {
  const [w, ...rest] = path;
  if (w < 0) return { layout: L.resizeSplit(ui.layout, rest, sizes) };
  return { windows: ui.windows.map((win, i) => (i === w ? { ...win, layout: L.resizeSplit(win.layout, rest, sizes) } : win)) };
}

/** The main window's editors: one group, or Rider-style splits of several. */
export function EditorArea({ project }: { project: Project }) {
  const layout = useWorkspace((s) => s.ui[project.id]?.layout);
  if (!layout) return null;
  return (
    <div className="editor-area">
      <SplitView project={project} node={layout} path={[-1]} />
    </div>
  );
}

/** A detached editor window (Open in New Window), with splits of its own. */
function EditorWindowView({ project, index, win }: { project: Project; index: number; win: L.EditorWindow }) {
  const title = useWorkspace((s) => {
    const ui = s.ui[project.id];
    const ids = L.layoutGroups(win.layout);
    const g = ui && (ids.includes(ui.activeGroup) ? L.groupById(ui, ui.activeGroup) : L.groupById(ui, ids[0]));
    return g?.activeTab ? tabTitle(g.activeTab) : project.name;
  });
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (runEditorShortcut(e.nativeEvent, project.id)) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  return (
    <FloatWindow
      className="editor-window"
      title={`${title} — ${project.name}`}
      width={900}
      height={700}
      escapeCloses={false}
      onClose={() => void closeEditorWindow(project.id, win.id)}
    >
      <div className="editor-area" onKeyDown={onKeyDown}>
        <SplitView project={project} node={win.layout} path={[index]} />
      </div>
    </FloatWindow>
  );
}

/** Detached editor windows of every open project. */
export function EditorWindows() {
  const projects = useWorkspace((s) => s.projects);
  const ui = useWorkspace((s) => s.ui);
  return (
    <>
      {projects
        .filter((p) => p.open)
        .flatMap((p) => (ui[p.id]?.windows ?? []).map((w, i) => <EditorWindowView key={w.id} project={p} index={i} win={w} />))}
    </>
  );
}

const EDITOR_COMMANDS = ["closeTab", "nextTab", "previousTab", "splitVertically", "splitHorizontally", "unsplit", "moveToOppositeGroup", "openInNewWindow", "nextSplitter"] as const;
export type EditorCommand = (typeof EDITOR_COMMANDS)[number];

/**
 * Editor tab and split shortcuts, for the active group of `projectId`: from the
 * main window and from detached ones. Returns whether `e` was one.
 */
export function runEditorShortcut(e: KeyboardEvent, projectId: string): boolean {
  const cmd = EDITOR_COMMANDS.find((c) => matches(e, c));
  if (!cmd) return false;
  runEditorCommand(cmd, projectId);
  return true;
}

/** Runs a tab or split command on the active group of `projectId`. */
export function runEditorCommand(cmd: EditorCommand, projectId: string): void {
  const ws = useWorkspace.getState();
  const ui = ws.ui[projectId];
  if (!ui) return;
  const g = L.activeGroupOf(ui);
  const tab = g.activeTab;
  const op = (f: (e: L.Editors) => L.Editors) => ws.editors(projectId, f);
  const win = L.windowOf(ui, g.id);
  const layout = win ? win.layout : ui.layout;
  switch (cmd) {
    case "closeTab":
      if (tab) void closeTabsWithPrompt(projectId, [tab], g.id);
      break;
    case "nextTab":
    case "previousTab": {
      if (g.tabs.length < 2) break;
      const step = cmd === "nextTab" ? 1 : -1;
      const i = g.tabs.findIndex((t) => t.path === tab);
      const n = g.tabs.length;
      op((x) => L.activateTab(x, g.id, g.tabs[(i + step + n) % n].path));
      break;
    }
    case "splitVertically":
    case "splitHorizontally":
      if (tab) op((x) => L.splitTab(x, g.id, tab, cmd === "splitVertically" ? "right" : "bottom", false));
      break;
    case "unsplit":
      op((x) => L.unsplit(x, g.id));
      break;
    case "moveToOppositeGroup": {
      const to = L.neighbourGroup(layout, g.id);
      if (tab && to) op((x) => L.moveTab(x, g.id, tab, to));
      break;
    }
    case "openInNewWindow":
      if (tab) op((x) => L.detachTab(x, g.id, tab));
      break;
    case "nextSplitter": {
      const ids = L.layoutGroups(layout);
      const next = ids[(ids.indexOf(g.id) + 1) % ids.length];
      if (next !== g.id) focusGroupEditor(projectId, next);
      break;
    }
  }
}

/** Activates a group and puts the caret in its editor. */
function focusGroupEditor(projectId: string, group: string) {
  focusGroup(projectId, group);
  for (const [editor, at] of editorGroups) if (at.projectId === projectId && at.group === group) editor.focus();
}
