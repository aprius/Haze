// Find in Files (Ctrl+Shift+F) / Replace in Files (Ctrl+Shift+R).
//
// Disk files are searched and replaced by the Rust side. Files open in the
// editor are searched from their (possibly unsaved) buffer and replaced inside
// the buffer, so the edit shows up in the editor's undo history.
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { EyeOff, FolderOpen, History, Pin, Replace } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { create } from "zustand";
import { getModel, metaDirty, saveBuffer, useBuffers } from "../lib/buffers";
import { api, errorMessage, type FileMatches, type ReplaceTarget, type SearchContext, type SearchMatch, type SearchQuery, type SearchResults } from "../lib/ipc";
import { monaco } from "../lib/monaco";
import { CodePreview } from "./CodePreview";
import { basename, dirname, isWithin, relative } from "../lib/path";
import { keepSearchFocus } from "../lib/popupFocus";
import { closeFindInFiles, useUi } from "../store/ui";
import { solutionDirs, useDotnet } from "../store/dotnet";
import { useWorkspace, type Project } from "../store/workspace";
import { FileIcon } from "./FileIcon";
import { toast } from "./Overlays";

// Rider's scopes: the solution, one of its projects (a `.csproj`), a directory.
// Without a solution, "In Project" is the opened folder.
type ScopeKind = "solution" | "csproj" | "folder" | "directory" | "openFiles";

function effectiveScope(scope: ScopeKind, hasSolution: boolean): ScopeKind {
  if (!hasSolution && (scope === "solution" || scope === "csproj")) return "folder";
  if (hasSolution && scope === "folder") return "solution";
  return scope;
}

interface FindOptions {
  query: string;
  replacement: string;
  isRegex: boolean;
  matchCase: boolean;
  wholeWord: boolean;
  preserveCase: boolean;
  context: SearchContext;
  fileMask: string;
  fileMaskOn: boolean;
  scope: ScopeKind;
  /** The `.csproj` searched by the "Project" scope. */
  csproj: string;
  directory: string;
  includeIgnored: boolean;
  /** "Solution": also files no project lists (Unity's assets and `.meta`s), like Rider. */
  nonSolution: boolean;
}

// Options survive closing the popup, like Rider.
const useFindOptions = create<FindOptions>(() => ({
  query: "",
  replacement: "",
  isRegex: false,
  matchCase: false,
  wholeWord: false,
  preserveCase: false,
  context: "anywhere",
  fileMask: "",
  fileMaskOn: false,
  scope: "solution",
  csproj: "",
  directory: "",
  includeIgnored: false,
  nonSolution: false,
}));

const SCOPE_LABELS: Record<ScopeKind, string> = {
  solution: "In Solution",
  csproj: "Project",
  folder: "In Project",
  directory: "Directory",
  openFiles: "Open Files",
};

const CONTEXTS: { id: SearchContext; label: string }[] = [
  { id: "anywhere", label: "Anywhere" },
  { id: "inComments", label: "In comments" },
  { id: "inStrings", label: "In string literals" },
  { id: "exceptComments", label: "Except comments" },
  { id: "exceptStrings", label: "Except string literals" },
  { id: "exceptCommentsAndStrings", label: "Except comments and string literals" },
];

const ROW_H = 22;
let searchId = 1;

const NO_MATCHES: SearchMatch[] = [];
const MASK_PRESETS = ["*.cs", "*.cs, !*.Designer.cs", "*.shader, *.hlsl, *.cginc", "*.uxml, *.uss", "*.json", "*.xml, *.csproj, *.props"];

// Recent queries and file masks, and where the popup was left, kept in
// localStorage like the theme: per machine, not per workspace.
const HISTORY_KEY = "haze.findInFiles.history";
const LAYOUT_KEY = "haze.findInFiles.layout";
const HISTORY_MAX = 20;

interface FindHistory {
  queries: string[];
  masks: string[];
}

interface Layout {
  bounds: { x: number; y: number; w: number; h: number } | null;
  /** Share of the body the results list takes; the preview gets the rest. */
  split: number;
  pinned: boolean;
}

function load<T>(key: string, fallback: T): T {
  try {
    const saved = localStorage.getItem(key);
    return saved ? { ...fallback, ...JSON.parse(saved) } : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or full storage: the popup just forgets.
  }
}

const useHistory = create<FindHistory>(() => load<FindHistory>(HISTORY_KEY, { queries: [], masks: [] }));
const useLayout = create<Layout>(() => load<Layout>(LAYOUT_KEY, { bounds: null, split: 0.55, pinned: false }));
useHistory.subscribe((h) => save(HISTORY_KEY, h));
useLayout.subscribe((l) => save(LAYOUT_KEY, l));

/** Most recent first, without duplicates. */
const remember = (list: string[], item: string) => (item.trim() ? [item, ...list.filter((x) => x !== item)].slice(0, HISTORY_MAX) : list);

function rememberSearch() {
  const o = useFindOptions.getState();
  useHistory.setState((h) => ({
    queries: remember(h.queries, o.query),
    masks: o.fileMaskOn ? remember(h.masks, o.fileMask.trim()) : h.masks,
  }));
}

/** Keeps the popup's title bar on screen, whatever the window size is now. */
function clampBounds(b: NonNullable<Layout["bounds"]>) {
  const w = Math.min(Math.max(b.w, 480), window.innerWidth - 16);
  const h = Math.min(Math.max(b.h, 320), window.innerHeight - 16);
  return {
    x: Math.min(Math.max(b.x, 8), window.innerWidth - w - 8),
    y: Math.min(Math.max(b.y, 8), window.innerHeight - h - 8),
    w,
    h,
  };
}

/** Pointer drag that reports the offset from where it started. */
function drag(e: React.PointerEvent, onMove: (dx: number, dy: number) => void) {
  if (e.button !== 0) return;
  e.preventDefault();
  const x0 = e.clientX;
  const y0 = e.clientY;
  const move = (ev: PointerEvent) => onMove(ev.clientX - x0, ev.clientY - y0);
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// One row per match, the file named on the right, as in Rider's list.
type Row = { kind: "match"; file: FileMatches; match: SearchMatch; fileIndex: number };

const matchKey = (path: string, m: SearchMatch) => `${path}\u0000${m.start}`;

function toQuery(o: FindOptions, replace: boolean): SearchQuery {
  return {
    query: o.query,
    isRegex: o.isRegex,
    matchCase: o.matchCase,
    wholeWord: o.wholeWord,
    context: o.context,
    replacement: replace ? o.replacement : null,
    preserveCase: replace && o.preserveCase,
  };
}

function Toggle({ on, title, label, onClick }: { on: boolean; title: string; label: ReactNode; onClick: () => void }) {
  return (
    // Out of the tab order so Tab goes from the search field to the replace field.
    <button className={"toggle" + (on ? " on" : "")} title={title} tabIndex={-1} onClick={onClick}>
      {label}
    </button>
  );
}

export function FindInFiles({ project }: { project: Project | null }) {
  const { open, replace: replaceMode, initialQuery, directory, nonce } = useUi((s) => s.findInFiles);
  const opts = useFindOptions();
  const history = useHistory();
  const layout = useLayout();
  const hasSolution = useDotnet((s) => !!project && (s.info[project.id]?.projects.length ?? 0) > 0);
  const set = (patch: Partial<FindOptions>) => useFindOptions.setState(patch);
  const [replace, setReplace] = useState(replaceMode);
  const [results, setResults] = useState<SearchResults | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [listHeight, setListHeight] = useState(300);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyIndex, setHistoryIndex] = useState(0);
  const queryRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Row to select once the next results arrive (after replacing one occurrence).
  const pendingSelection = useRef<number | null>(null);
  // Buffer versions at search time, to refuse replacing in buffers edited since.
  const versions = useRef(new Map<string, number>());

  useEffect(() => {
    if (!open) return;
    setReplace(replaceMode);
    const patch: Partial<FindOptions> = {};
    if (initialQuery) patch.query = initialQuery;
    if (directory) {
      patch.directory = directory;
      patch.scope = "directory";
    } else if (project && !isWithin(useFindOptions.getState().directory || "", project.path)) {
      // Empty, or left over from another project.
      patch.directory = project.path;
    }
    set(patch);
    setHistoryOpen(false);
    requestAnimationFrame(() => queryRef.current?.select());
  }, [open, nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setListHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  // Run the search (debounced) whenever the options change.
  useEffect(() => {
    if (!open || !project) return;
    if (!opts.query) {
      setResults(null);
      setError(null);
      return;
    }
    const t = setTimeout(() => void runSearch(), 250);
    return () => clearTimeout(t);
  }, [open, project, replace, opts.query, opts.replacement, opts.isRegex, opts.matchCase, opts.wholeWord, opts.preserveCase, opts.context, opts.fileMask, opts.fileMaskOn, opts.scope, opts.csproj, opts.directory, opts.includeIgnored, opts.nonSolution]); // eslint-disable-line react-hooks/exhaustive-deps

  const runSearch = async () => {
    if (!project) return;
    const o = useFindOptions.getState();
    const id = ++searchId;
    const meta = useBuffers.getState().meta;
    const overrides: Record<string, string> = {};
    versions.current.clear();
    for (const [path, m] of Object.entries(meta)) {
      const model = getModel(path);
      if (!model || m.status !== "text") continue;
      versions.current.set(path, model.getAlternativeVersionId());
      if (m.dirty) overrides[path] = model.getValue();
    }
    const openTabs = Object.values(useWorkspace.getState().ui).flatMap((u) => u.tabs.map((t) => t.path));
    const info = useDotnet.getState().info[project.id];
    const projects = info?.projects ?? [];
    const kind = effectiveScope(o.scope, projects.length > 0);
    const csproj = projects.find((p) => p.path === o.csproj) ?? projects[0];
    const scope = {
      // The projects' own files; with non-solution items, everything in the
      // folders of the projects and solutions (Unity's assets, `.meta`s).
      projects: kind === "solution" && !o.nonSolution ? projects.map((p) => p.path) : kind === "csproj" && csproj ? [csproj.path] : [],
      dirs:
        kind === "solution" && o.nonSolution
          ? [...new Set([...solutionDirs(project.id), ...(info?.solutions ?? []).map(dirname)])]
          : kind === "directory"
            ? [o.directory || project.path]
            : kind === "folder"
              ? [project.path]
              : [],
      files: kind === "openFiles" ? [...new Set(openTabs)] : [],
      fileMask: (o.fileMaskOn && o.fileMask.trim()) || null,
      includeIgnored: o.includeIgnored,
      overrides,
    };
    setBusy(true);
    try {
      const r = await api.searchText(id, toQuery(o, replace), scope, 5000);
      if (id !== searchId || r.cancelled) return;
      setResults(r);
      setError(null);
      setExcluded(new Set());
      if (pendingSelection.current === null) setSelected(0);
    } catch (e) {
      if (id === searchId) {
        setError(errorMessage(e));
        setResults(null);
      }
    } finally {
      if (id === searchId) setBusy(false);
    }
  };

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    results?.files.forEach((file, fileIndex) => {
      for (const match of file.matches) out.push({ kind: "match", file, match, fileIndex });
    });
    return out;
  }, [results]);

  const firstMatchRow = rows.findIndex((r) => r.kind === "match");
  const sel = rows[selected]?.kind === "match" ? rows[selected] : rows[firstMatchRow];
  const selMatch = sel?.kind === "match" ? sel : null;

  useEffect(() => {
    const pending = pendingSelection.current;
    pendingSelection.current = null;
    if (pending !== null) {
      // The occurrence just replaced is gone: select the one that took its place.
      let i = Math.min(pending, rows.length - 1);
      while (rows[i] && rows[i].kind !== "match") i++;
      if (i < 0 || i >= rows.length) for (i = rows.length - 1; i >= 0 && rows[i].kind !== "match"; i--);
      setSelected(Math.max(i, 0));
      scrollIntoView(i);
    } else if (rows.length && rows[selected]?.kind !== "match" && firstMatchRow >= 0 && selected === 0) setSelected(firstMatchRow);
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  // Bounds saved for a bigger window than the current one.
  useEffect(() => {
    if (!open) return;
    const fit = () => {
      const b = useLayout.getState().bounds;
      if (b) useLayout.setState({ bounds: clampBounds(b) });
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [open]);

  function scrollIntoView(i: number) {
    const el = listRef.current;
    if (!el || !rows[i]) return;
    const top = i * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
  }

  if (!open || !project) return null;

  const isExcluded = (path: string, m: SearchMatch) => excluded.has(path) || excluded.has(matchKey(path, m));
  const toggleMatch = (path: string, m: SearchMatch) =>
    setExcluded((ex) => {
      const next = new Set(ex);
      const k = matchKey(path, m);
      if (next.has(path)) {
        // Unticking one match of an excluded file: include the file, exclude the rest.
        next.delete(path);
        const f = results?.files.find((x) => x.path === path);
        f?.matches.forEach((x) => x !== m && next.add(matchKey(path, x)));
      } else if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  const close = () => {
    if (opts.query) rememberSearch();
    closeFindInFiles();
  };

  // A pinned popup stays open, like Rider's, so one match after another can be visited.
  const openMatch = (path: string, m: SearchMatch) => {
    if (layout.pinned) rememberSearch();
    else close();
    useWorkspace.getState().openFile(project.id, path, { line: m.line, column: m.column });
  };

  const selectedCount = results ? results.files.reduce((n, f) => n + f.matches.filter((m) => !isExcluded(f.path, m)).length, 0) : 0;

  /** Replaces the ticked occurrences, or only `one`. */
  const doReplace = async (one?: { path: string; match: SearchMatch }) => {
    if (!results || !replace) return;
    rememberSearch();
    const o = useFindOptions.getState();
    const query = toQuery(o, true);
    const diskTargets: ReplaceTarget[] = [];
    const bufferEdits: { path: string; model: monaco.editor.ITextModel; matches: SearchMatch[]; wasClean: boolean }[] = [];
    const skipped: string[] = [];
    for (const f of results.files) {
      const chosen = one ? (one.path === f.path ? [one.match] : []) : f.matches.filter((m) => !isExcluded(f.path, m));
      if (!chosen.length) continue;
      const model = getModel(f.path);
      if (model) {
        if (versions.current.get(f.path) !== model.getAlternativeVersionId()) {
          skipped.push(`${basename(f.path)} (edited since the search)`);
          continue;
        }
        const meta = useBuffers.getState().meta[f.path];
        bufferEdits.push({ path: f.path, model, matches: chosen, wasClean: !metaDirty(meta) });
      } else {
        diskTargets.push({ path: f.path, hash: f.hash, starts: chosen.map((m) => m.start) });
      }
    }

    // Buffers: one undoable edit per file; files that were saved get saved again.
    const undoBuffers: { model: monaco.editor.ITextModel; version: number; path: string; save: boolean }[] = [];
    let count = 0;
    for (const b of bufferEdits) {
      b.model.pushStackElement();
      b.model.pushEditOperations(
        [],
        b.matches.map((m) => ({
          range: new monaco.Range(m.line, m.column, m.endLine, m.endColumn),
          text: m.replacement ?? "",
        })),
        () => null,
      );
      b.model.pushStackElement();
      count += b.matches.length;
      if (b.wasClean) {
        try {
          if (!(await saveBuffer(b.path))) skipped.push(`${basename(b.path)} (changed on disk; replaced in the editor, not saved)`);
        } catch (e) {
          skipped.push(`${basename(b.path)} (${errorMessage(e)})`);
        }
      }
      undoBuffers.push({ model: b.model, version: b.model.getAlternativeVersionId(), path: b.path, save: b.wasClean });
    }

    let undoId: number | null = null;
    let files = bufferEdits.length;
    if (diskTargets.length) {
      try {
        const out = await api.replaceInFiles(query, diskTargets);
        undoId = out.undoId;
        files += out.replaced.length;
        count += out.replaced.reduce((n, r) => n + r.count, 0);
        out.skipped.forEach((s) => skipped.push(`${basename(s.path)} (${s.reason})`));
      } catch (e) {
        toast(`Replace failed: ${errorMessage(e)}`, "error");
      }
    }

    const undo = async () => {
      let failed = 0;
      if (undoId !== null) failed += (await api.undoReplace(undoId).catch(() => [{ path: "", reason: "" }])).length;
      for (const u of undoBuffers) {
        if (u.model.isDisposed() || u.model.getAlternativeVersionId() !== u.version) {
          failed++;
          continue;
        }
        u.model.undo();
        if (u.save && !(await saveBuffer(u.path).catch(() => false))) failed++;
      }
      toast(failed ? `Undo finished; ${failed} file(s) had changed and were left as is.` : "Replace undone.", failed ? "error" : "info");
    };

    toast(`Replaced ${count} occurrence(s) in ${files} file(s).`, "info", { label: "Undo", run: () => void undo() });
    if (skipped.length) toast(`Skipped: ${skipped.join(", ")}. Run the search again.`, "error");
    if (one) pendingSelection.current = selected;
    void runSearch();
  };

  const pickHistory = (q: string) => {
    set({ query: q });
    setHistoryOpen(false);
    requestAnimationFrame(() => queryRef.current?.select());
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const move = (delta: number) => {
      const step = delta > 0 ? 1 : -1;
      const target = Math.min(Math.max(selected + delta, 0), rows.length - 1);
      let i = target;
      while (rows[i] && rows[i].kind !== "match") i += step;
      // Paging past either end lands on the first or last match rather than nowhere.
      if (!rows[i]) for (i = target; rows[i] && rows[i].kind !== "match"; i -= step);
      if (rows[i]?.kind !== "match") return;
      setSelected(i);
      scrollIntoView(i);
    };
    const page = Math.max(1, Math.floor((listRef.current?.clientHeight ?? 0) / ROW_H) - 1);
    const toggles: Record<string, "matchCase" | "wholeWord" | "isRegex"> = { KeyC: "matchCase", KeyO: "wholeWord", KeyX: "isRegex" };
    if (historyOpen) {
      if (e.key === "Escape") setHistoryOpen(false);
      else if (e.key === "ArrowDown") setHistoryIndex((i) => Math.min(i + 1, history.queries.length - 1));
      else if (e.key === "ArrowUp") setHistoryIndex((i) => Math.max(i - 1, 0));
      else if (e.key === "Enter" && history.queries[historyIndex] !== undefined) pickHistory(history.queries[historyIndex]);
      else return;
    } else if (e.key === "Escape") close();
    else if (e.altKey && e.key === "ArrowDown" && (e.target as HTMLElement) === queryRef.current) {
      if (!history.queries.length) return;
      setHistoryIndex(0);
      setHistoryOpen(true);
    }
    else if (e.altKey && !e.ctrlKey && !e.metaKey && toggles[e.code]) set({ [toggles[e.code]]: !opts[toggles[e.code]] });
    else if (e.key === "ArrowDown") move(1);
    else if (e.key === "ArrowUp") move(-1);
    else if (e.key === "PageDown") move(page);
    else if (e.key === "PageUp") move(-page);
    else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      if ((e.ctrlKey || e.metaKey) && replace) void doReplace();
      else if (selMatch) openMatch(selMatch.file.path, selMatch.match);
    } else if (e.key === " " && (e.target as HTMLElement).classList.contains("find-list") && selMatch) {
      toggleMatch(selMatch.file.path, selMatch.match);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const shownScope = effectiveScope(opts.scope, hasSolution);
  const csprojs = useDotnet.getState().info[project.id]?.projects ?? [];
  const bounds = layout.bounds;

  const moveBy = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button, input, select, label")) return;
    const r = popupRef.current!.getBoundingClientRect();
    drag(e, (dx, dy) => useLayout.setState({ bounds: clampBounds({ x: r.left + dx, y: r.top + dy, w: r.width, h: r.height }) }));
  };
  const resizeBy = (e: React.PointerEvent) => {
    const r = popupRef.current!.getBoundingClientRect();
    drag(e, (dx, dy) => useLayout.setState({ bounds: clampBounds({ x: r.left, y: r.top, w: r.width + dx, h: r.height + dy }) }));
  };
  const splitBy = (e: React.PointerEvent) => {
    const body = bodyRef.current!.getBoundingClientRect();
    const start = layout.split;
    drag(e, (_dx, dy) => useLayout.setState({ split: Math.min(0.85, Math.max(0.15, start + dy / body.height)) }));
  };
  const browseDirectory = async () => {
    const dir = await openDialog({ directory: true, multiple: false, defaultPath: opts.directory || project.path, title: "Directory to Search" });
    if (typeof dir === "string") set({ directory: dir, scope: "directory" });
  };
  const status = busy
    ? "Searching…"
    : results
      ? results.truncated
        ? `${results.totalMatches}+ matches in ${results.files.length}+ files`
        : `${results.totalMatches} ${results.totalMatches === 1 ? "match" : "matches"} in ${results.files.length} ${results.files.length === 1 ? "file" : "files"}`
      : "";
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 10);
  const last = Math.min(rows.length, Math.ceil((scrollTop + listHeight) / ROW_H) + 10);

  return (
    <div
      className={"modal-backdrop find-backdrop" + (layout.pinned ? " pinned" : "") + (bounds ? " placed" : "")}
      onMouseDown={(e) => e.target === e.currentTarget && !layout.pinned && close()}
    >
      <div
        ref={popupRef}
        className="find-popup"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onMouseDown={keepSearchFocus}
        style={bounds ? { left: bounds.x, top: bounds.y, width: bounds.w, height: bounds.h } : undefined}
      >
        <div className="find-header" onPointerDown={moveBy} onDoubleClick={(e) => !(e.target as HTMLElement).closest("button, input, select, label") && useLayout.setState({ bounds: null })}>
          <span className="find-title">{replace ? "Replace in Files" : "Find in Files"}</span>
          <span className="find-status">{status}</span>
          <label className="find-check" title="Search only files matching the mask">
            <input type="checkbox" checked={opts.fileMaskOn} onChange={(e) => set({ fileMaskOn: e.target.checked })} />
            File mask:
          </label>
          <input
            className="find-input small mask"
            value={opts.fileMask}
            placeholder="*.cs, !*.Designer.cs"
            list="find-mask-history"
            spellCheck={false}
            disabled={!opts.fileMaskOn}
            onChange={(e) => set({ fileMask: e.target.value })}
          />
          <datalist id="find-mask-history">
            {[...new Set([...history.masks, ...MASK_PRESETS])].map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <select
            className="find-select"
            value={opts.context}
            onChange={(e) => {
              set({ context: e.target.value as SearchContext });
              queryRef.current?.focus();
            }}
            title="Context (C# files)"
          >
            {CONTEXTS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
          <button className={"find-pin" + (replace ? " on" : "")} title={replace ? "Find only" : "Replace in Files"} onClick={() => setReplace((r) => !r)}>
            <Replace size={14} />
          </button>
          <button
            className={"find-pin" + (layout.pinned ? " on" : "")}
            title={layout.pinned ? "Unpin: close when a match is opened" : "Pin: keep open when a match is opened"}
            onClick={() => useLayout.setState({ pinned: !layout.pinned })}
          >
            <Pin size={14} />
          </button>
        </div>
        <div className="find-row find-query">
          <div className={"find-field" + (error ? " invalid" : "")}>
            <button
              className="find-history-btn"
              title="Recent searches (Alt+↓)"
              tabIndex={-1}
              disabled={!history.queries.length}
              // Keeps focus in the field, whose blur would close the list before the click toggles it.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setHistoryIndex(0);
                setHistoryOpen((o) => !o);
                queryRef.current?.focus();
              }}
            >
              <History size={14} />
            </button>
            <input
              ref={queryRef}
              className="find-field-input"
              value={opts.query}
              placeholder="Search"
              spellCheck={false}
              onChange={(e) => set({ query: e.target.value })}
              onBlur={() => setHistoryOpen(false)}
            />
            <Toggle on={opts.matchCase} title="Match case (Alt+C)" label="Cc" onClick={() => set({ matchCase: !opts.matchCase })} />
            <Toggle on={opts.wholeWord} title="Words (Alt+O)" label="W" onClick={() => set({ wholeWord: !opts.wholeWord })} />
            <Toggle on={opts.isRegex} title="Regex (Alt+X)" label=".*" onClick={() => set({ isRegex: !opts.isRegex })} />
          </div>
          {historyOpen && (
            <div className="find-history">
              {history.queries.map((q, i) => (
                <div
                  key={q}
                  className={"find-history-item" + (i === historyIndex ? " selected" : "")}
                  onMouseEnter={() => setHistoryIndex(i)}
                  // mousedown, before the field's blur closes the list.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickHistory(q);
                  }}
                >
                  {q}
                </div>
              ))}
            </div>
          )}
        </div>
        {replace && (
          <div className="find-row">
            <div className="find-field">
              <Replace size={14} className="ico find-field-ico" />
              <input
                className="find-field-input"
                value={opts.replacement}
                placeholder={opts.isRegex ? "Replace with ($1, ${name})" : "Replace with"}
                spellCheck={false}
                onChange={(e) => set({ replacement: e.target.value })}
              />
              <Toggle on={opts.preserveCase} title="Preserve case" label="Aa" onClick={() => set({ preserveCase: !opts.preserveCase })} />
            </div>
          </div>
        )}
        {error && <div className="find-error">{error}</div>}
        <div className="find-scopes">
          {((hasSolution ? ["solution", "csproj"] : ["folder"]).concat(["directory", "openFiles"]) as ScopeKind[]).map((s) => (
            <button key={s} className={"find-scope" + (shownScope === s ? " on" : "")} onClick={() => set({ scope: s })}>
              {SCOPE_LABELS[s]}
            </button>
          ))}
          {shownScope === "csproj" && (
            <select
              className="find-select"
              value={(csprojs.find((p) => p.path === opts.csproj) ?? csprojs[0])?.path}
              title="Project to search"
              onChange={(e) => {
                set({ csproj: e.target.value });
                queryRef.current?.focus();
              }}
            >
              {csprojs.map((p) => (
                <option key={p.path} value={p.path}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          {shownScope === "directory" && (
            <span className="find-dir">
              <input
                className="find-input small dir"
                value={opts.directory}
                title={opts.directory}
                spellCheck={false}
                onChange={(e) => set({ directory: e.target.value })}
              />
              <button className="btn small" title="Choose directory" onClick={() => void browseDirectory()}>
                <FolderOpen size={14} />
              </button>
            </span>
          )}
          <span className="find-scopes-end">
            {/* Search Everywhere's checkbox, for "In Solution". */}
            <label
              className={"se-include" + (shownScope === "solution" ? "" : " disabled")}
              title={shownScope === "solution" ? "Also search files no project lists: Unity's assets, scenes and .meta files" : "Applies to In Solution"}
            >
              <input type="checkbox" checked={opts.nonSolution} disabled={shownScope !== "solution"} onChange={(e) => set({ nonSolution: e.target.checked })} />
              Include non-solution items
            </label>
            <Toggle
              on={opts.includeIgnored}
              title="Include ignored: bin/, obj/, node_modules/ and .gitignore'd files"
              label={<EyeOff size={14} />}
              onClick={() => set({ includeIgnored: !opts.includeIgnored })}
            />
          </span>
        </div>
        <div ref={bodyRef} className="find-body">
          <div
            ref={listRef}
            className="find-list"
            tabIndex={0}
            style={{ flex: `${layout.split} 1 0` }}
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          >
            <div style={{ height: rows.length * ROW_H, position: "relative" }}>
              {rows.slice(first, last).map((row, i) => {
                const index = first + i;
                const m = row.match;
                const off = isExcluded(row.file.path, m);
                return (
                  <div
                    key={matchKey(row.file.path, m)}
                    className={"find-match" + (index === selected ? " selected" : "") + (off ? " off" : "")}
                    style={{ top: index * ROW_H, height: ROW_H }}
                    onClick={() => setSelected(index)}
                    onDoubleClick={() => openMatch(row.file.path, m)}
                  >
                    {replace && <input type="checkbox" checked={!off} onChange={() => toggleMatch(row.file.path, m)} onClick={(e) => e.stopPropagation()} />}
                    <span className="find-text">
                      {m.lineText.slice(0, m.previewStart).trimStart()}
                      <span className={replace ? "find-old" : "find-hl"}>{m.lineText.slice(m.previewStart, m.previewEnd)}</span>
                      {replace && <span className="find-new">{m.replacement}</span>}
                      {m.lineText.slice(m.previewEnd)}
                    </span>
                    <span className="find-where">
                      {row.file.fromBuffer && <span className="tag">unsaved</span>}
                      {basename(row.file.path)} {m.line}
                    </span>
                  </div>
                );
              })}
            </div>
            {results && rows.length === 0 && <div className="se-empty">No matches</div>}
          </div>
          <div className="find-splitter" onPointerDown={splitBy} onDoubleClick={() => useLayout.setState({ split: 0.55 })} />
          <div className="find-preview" style={{ flex: `${1 - layout.split} 1 0` }}>
            <div className="find-preview-header">
              {selMatch ? (
                <>
                  <FileIcon name={basename(selMatch.file.path)} />
                  <span className="find-file-name">{basename(selMatch.file.path)}</span>
                  <span className="find-file-dir">{relative(project.path, selMatch.file.path)}</span>
                  <span className="find-count">
                    {selMatch.match.line}:{selMatch.match.column}
                  </span>
                </>
              ) : (
                <span className="muted">No match selected</span>
              )}
            </div>
            <CodePreview
              path={selMatch?.file.path ?? null}
              hash={selMatch?.file.hash ?? null}
              match={selMatch?.match ?? null}
              others={selMatch?.file.matches ?? NO_MATCHES}
            />
          </div>
        </div>
        <div className="find-footer">
          <span className="muted small">Enter: open · Alt+↓: recent · Ctrl+Enter: replace · Space: tick/untick · Esc: close</span>
          {replace && (
            <span className="find-actions">
              <button
                className="btn"
                disabled={!selMatch || busy || isExcluded(selMatch.file.path, selMatch.match)}
                title="Replace the selected occurrence only"
                onClick={() => selMatch && void doReplace({ path: selMatch.file.path, match: selMatch.match })}
              >
                Replace
              </button>
              <button className="btn primary" disabled={!selectedCount || busy} onClick={() => void doReplace()}>
                Replace {selectedCount === results?.totalMatches ? "All" : `Selected (${selectedCount})`}
              </button>
            </span>
          )}
          <div className="find-grip" onPointerDown={resizeBy} title="Resize" />
        </div>
      </div>
    </div>
  );
}
