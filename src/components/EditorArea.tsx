import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { X } from "lucide-react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { disposeBuffer, ensureBuffer, getModel, reloadBuffer, saveBuffer, useBuffers, type BufferMeta } from "../lib/buffers";
import { api, errorMessage } from "../lib/ipc";
import { languageFor, monaco } from "../lib/monaco";
import { basename, dirname, extname, relative } from "../lib/path";
import { recoveredDrafts } from "../store/persist";
import { setSelection } from "../store/tree";
import { useWorkspace, type Project } from "../store/workspace";
import { choose, openMenu, toast } from "./Overlays";

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
  const project = path ? useWorkspace.getState().projects.find((p) => path.startsWith(p.path)) : null;
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

let keymapInstalled = false;

/** A few IntelliJ/Rider keys that differ from Monaco's VS Code defaults. */
function installRiderKeymap() {
  if (keymapInstalled) return;
  keymapInstalled = true;
  const { KeyMod: M, KeyCode: K } = monaco;
  monaco.editor.addKeybindingRules([
    { keybinding: M.CtrlCmd | K.KeyD, command: "-editor.action.addSelectionToNextFindMatch" },
    { keybinding: M.CtrlCmd | K.KeyD, command: "editor.action.copyLinesDownAction", when: "editorTextFocus && !editorReadonly" },
    { keybinding: M.Alt | K.KeyJ, command: "editor.action.addSelectionToNextFindMatch", when: "editorFocus" },
    { keybinding: M.CtrlCmd | K.KeyY, command: "editor.action.deleteLines", when: "editorTextFocus && !editorReadonly" },
    { keybinding: M.CtrlCmd | K.KeyR, command: "editor.action.startFindReplaceAction", when: "editorFocus" },
    { keybinding: M.CtrlCmd | K.KeyW, command: "editor.action.smartSelect.expand", when: "editorTextFocus" },
    { keybinding: M.CtrlCmd | M.Shift | K.KeyW, command: "editor.action.smartSelect.shrink", when: "editorTextFocus" },
    { keybinding: M.Alt | M.Shift | K.UpArrow, command: "editor.action.moveLinesUpAction", when: "editorTextFocus && !editorReadonly" },
    { keybinding: M.Alt | M.Shift | K.DownArrow, command: "editor.action.moveLinesDownAction", when: "editorTextFocus && !editorReadonly" },
    { keybinding: M.CtrlCmd | M.Shift | K.Slash, command: "editor.action.blockComment", when: "editorTextFocus && !editorReadonly" },
    { keybinding: M.CtrlCmd | M.Shift | K.KeyU, command: "editor.action.transformToUppercase", when: "editorTextFocus && !editorReadonly" },
  ]);
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

/** Closes tabs, asking about unsaved changes. Returns false if cancelled. */
export async function closeTabsWithPrompt(projectId: string, paths: string[]): Promise<boolean> {
  const meta = useBuffers.getState().meta;
  const dirty = paths.filter((p) => isDirty(meta[p]));
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
  // Keep buffers that another project still shows.
  const open = new Set(Object.values(useWorkspace.getState().ui).flatMap((u) => u.tabs.map((t) => t.path)));
  for (const p of paths) {
    if (!open.has(p)) {
      disposeBuffer(p);
      viewStates.delete(p);
    }
  }
  return true;
}

function TabBar({ project }: { project: Project }) {
  const ui = useWorkspace((s) => s.ui[project.id]);
  const meta = useBuffers((s) => s.meta);
  const tabs = ui?.tabs ?? [];

  const tabMenu = (path: string) => [
    { label: "Close", shortcut: "Ctrl+F4", action: () => void closeTabsWithPrompt(project.id, [path]) },
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
    { label: "Select in Project View", shortcut: "Alt+F1", action: () => revealInTree(project, path) },
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
            <span className="editor-tab-name">{basename(t.path)}</span>
            {isDirty(m) ? (
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
    const dark = window.matchMedia("(prefers-color-scheme: dark)");
    const editor = monaco.editor.create(host.current, {
      model: null,
      automaticLayout: true,
      fontFamily: 'JetBrains Mono, "Cascadia Code", Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 20,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderWhitespace: "selection",
      smoothScrolling: true,
      stickyScroll: { enabled: true },
      bracketPairColorization: { enabled: true },
      theme: dark.matches ? "haze-dark" : "haze-light",
    });
    const onTheme = () => monaco.editor.setTheme(dark.matches ? "haze-dark" : "haze-light");
    dark.addEventListener("change", onTheme);
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
      // Editing a preview tab keeps it, like Rider.
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
    editorRef.current = editor;
    currentEditor = editor;
    return () => {
      if (shownPath.current) viewStates.set(shownPath.current, editor.saveViewState());
      dark.removeEventListener("change", onTheme);
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
    if (!active || isImagePath(active)) return;
    const draft = recoveredDrafts.get(active);
    recoveredDrafts.delete(active);
    void ensureBuffer(active, draft);
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

  return (
    <div className="editor-area">
      <TabBar project={project} />
      {active && (
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
        <div ref={host} className="monaco-host" style={{ visibility: ready && !image ? "visible" : "hidden" }} />
        {showMd && <MarkdownPreview path={active!} />}
        {image && <ImageView path={active!} />}
        {!active && (
          <div className="editor-empty">
            <div className="hint-grid">
              <span>Open file</span>
              <kbd>Click in Project view</kbd>
              <span>Terminal</span>
              <kbd>Alt+F12</kbd>
              <span>Project view</span>
              <kbd>Alt+1</kbd>
              <span>Save all</span>
              <kbd>Ctrl+S</kbd>
            </div>
          </div>
        )}
        {active && !image && meta && meta.status !== "text" && (
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
