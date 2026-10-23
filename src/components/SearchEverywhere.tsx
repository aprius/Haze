// Search Everywhere (Double Shift), Go to File (Ctrl+Shift+N), Find Action
// (Ctrl+Shift+A) and recent files (Ctrl+E) — one popup, like Rider.
import { PanelBottom, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { actions, scoreLabel, type Action } from "../lib/actions";
import { api, type FileHit, type SearchMatch } from "../lib/ipc";
import { symbolKindName } from "../lib/lsp/convert";
import { workspaceSymbols, type WorkspaceSymbolHit } from "../lib/lsp/csharp";
import { basename, dirname, relative } from "../lib/path";
import { keepSearchFocus } from "../lib/popupFocus";
import { closeSearchEverywhere, toggleSeIncludeAll, useUi, type SeTab } from "../store/ui";
import { useWorkspace, type Project } from "../store/workspace";
import { CodePreview, type PreviewRange } from "./CodePreview";
import { FileIcon } from "./FileIcon";

type Item =
  | { kind: "file"; path: string; rel: string; indices: number[]; recent?: boolean }
  | { kind: "symbol"; symbol: WorkspaceSymbolHit; rel: string }
  | { kind: "action"; action: Action }
  | { kind: "text"; path: string; rel: string; match: SearchMatch };

const TABS: { id: SeTab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "files", label: "Files" },
  { id: "symbols", label: "Symbols" },
  { id: "actions", label: "Actions" },
  { id: "text", label: "Text" },
];

/** `Foo.cs:12:4` → query `Foo.cs`, line 12, column 4. */
export function splitLineSuffix(q: string): { query: string; line?: number; column?: number } {
  const m = /^(.*?)(?::(\d+)(?::(\d+))?)$/.exec(q.trim());
  if (!m || !m[1]) return { query: q.trim() };
  return { query: m[1], line: Number(m[2]), column: m[3] ? Number(m[3]) : undefined };
}

let textSearchId = 1_000_000;

// The preview pane stays on or off between openings, per machine.
const PREVIEW_KEY = "haze.searchEverywhere.preview";
function loadPreview(): boolean {
  try {
    return localStorage.getItem(PREVIEW_KEY) === "1";
  } catch {
    return false;
  }
}

const NO_RANGES: PreviewRange[] = [];

/** What the preview shows for a row: the file and where; actions have none. */
function previewOf(item: Item | undefined, line?: number, column?: number): { path: string; range: PreviewRange } | null {
  if (!item || item.kind === "action") return null;
  if (item.kind === "text") return { path: item.path, range: item.match };
  if (item.kind === "symbol") {
    const { path, line: l, column: c, name } = item.symbol;
    return { path, range: { line: l, column: c, endLine: l, endColumn: c + name.length } };
  }
  const l = line ?? 1;
  const c = column ?? 1;
  return { path: item.path, range: { line: l, column: c, endLine: l, endColumn: c } };
}

function Highlighted({ text, indices }: { text: string; indices: number[] }) {
  if (!indices.length) return <>{text}</>;
  const set = new Set(indices);
  const chars = [...text];
  const out: ReactNode[] = [];
  let run = "";
  let runHit = false;
  chars.forEach((c, i) => {
    const hit = set.has(i);
    if (hit !== runHit && run) {
      out.push(runHit ? <mark key={i}>{run}</mark> : run);
      run = "";
    }
    runHit = hit;
    run += c;
  });
  if (run) out.push(runHit ? <mark key="end">{run}</mark> : run);
  return <>{out}</>;
}

/** Indices of `query`'s characters in `name`, in order and ignoring case, for symbols the server doesn't mark. */
function matchIndices(name: string, query: string): number[] {
  const lower = name.toLowerCase();
  const q = query.toLowerCase();
  const at = lower.indexOf(q);
  if (at >= 0) return [...q].map((_, i) => at + i);
  const out: number[] = [];
  let from = 0;
  for (const c of q) {
    const i = lower.indexOf(c, from);
    if (i < 0) return [];
    out.push(i);
    from = i + 1;
  }
  return out;
}

// LSP SymbolKind → the letter and colour of Rider's symbol icons.
const SYMBOL_ICONS: Record<number, [string, string]> = {
  2: ["M", "module"],
  3: ["N", "namespace"],
  4: ["P", "namespace"],
  5: ["C", "class"],
  6: ["m", "method"],
  7: ["p", "property"],
  8: ["f", "field"],
  9: ["m", "method"],
  10: ["E", "enum"],
  11: ["I", "interface"],
  12: ["ƒ", "method"],
  13: ["v", "field"],
  14: ["c", "field"],
  22: ["e", "enum"],
  23: ["S", "struct"],
  24: ["e", "event"],
  26: ["T", "interface"],
};

function SymbolIcon({ kind }: { kind: number }) {
  const [letter, tone] = SYMBOL_ICONS[kind] ?? ["s", "other"];
  return (
    <span className={"se-sym-ico " + tone} title={symbolKindName(kind)}>
      {letter}
    </span>
  );
}

export function SearchEverywhere({ project }: { project: Project | null }) {
  const { open, tab: initialTab, nonce, query: initialQuery } = useUi((s) => s.searchEverywhere);
  const includeAll = useUi((s) => s.seIncludeAll);
  const [tab, setTab] = useState<SeTab>(initialTab);
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<FileHit[]>([]);
  const [text, setText] = useState<{ path: string; match: SearchMatch }[]>([]);
  const [symbols, setSymbols] = useState<WorkspaceSymbolHit[]>([]);
  const [selected, setSelected] = useState(0);
  const [preview, setPreview] = useState(loadPreview);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const recentFiles = useWorkspace((s) => (project ? s.ui[project.id]?.recentFiles : undefined)) ?? [];
  const { query, line, column } = splitLineSuffix(input);

  useEffect(() => {
    if (!open) return;
    setTab(initialTab);
    setSelected(0);
    if (initialQuery !== null) setInput(initialQuery);
    requestAnimationFrame(() => inputRef.current?.select());
  }, [open, nonce, initialTab, initialQuery]);

  // File search (debounced, newest request wins).
  useEffect(() => {
    if (!open || !project || !query || tab === "actions" || tab === "text" || tab === "symbols") {
      setFiles([]);
      return;
    }
    let stale = false;
    const t = setTimeout(() => {
      api
        .findFiles(project.path, query, tab === "files" ? 60 : 12, includeAll)
        .then((hits) => !stale && setFiles(hits))
        .catch(() => !stale && setFiles([]));
    }, 40);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [open, project, query, tab, includeAll]);

  // Symbols from the C# language server.
  useEffect(() => {
    if (!open || !project || !query || (tab !== "symbols" && tab !== "all")) {
      setSymbols([]);
      return;
    }
    let stale = false;
    const t = setTimeout(() => {
      workspaceSymbols(project.id, query)
        .then((hits) => !stale && setSymbols(hits))
        .catch(() => !stale && setSymbols([]));
    }, 120);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [open, project, query, tab]);

  // Text search for the "Text" tab.
  useEffect(() => {
    if (!open || !project || tab !== "text" || query.length < 2) {
      setText([]);
      return;
    }
    let stale = false;
    const t = setTimeout(() => {
      api
        .searchText(
          ++textSearchId,
          { query, isRegex: false, matchCase: false, wholeWord: false, context: "anywhere", replacement: null, preserveCase: false },
          { dirs: [project.path], files: [], fileMask: null, includeIgnored: includeAll, overrides: {} },
          60,
        )
        .then((r) => !stale && setText(r.files.flatMap((f) => f.matches.map((m) => ({ path: f.path, match: m })))))
        .catch(() => !stale && setText([]));
    }, 200);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [open, project, query, tab, includeAll]);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    const showFiles = tab === "all" || tab === "files";
    if (showFiles && project) {
      if (!query) {
        for (const p of recentFiles.slice(0, 20)) out.push({ kind: "file", path: p, rel: relative(project.path, p), indices: [], recent: true });
      } else {
        for (const h of files) out.push({ kind: "file", path: h.path, rel: h.rel, indices: h.nameIndices });
      }
    }
    if ((tab === "all" || tab === "symbols") && project) {
      for (const sym of symbols.slice(0, tab === "all" ? 8 : 60)) out.push({ kind: "symbol", symbol: sym, rel: relative(project.path, sym.path) });
    }
    if ((tab === "all" && query) || tab === "actions") {
      const scored = actions
        .filter((a) => project || !a.needsProject)
        .map((a) => ({ a, s: scoreLabel(a.label, query) }))
        .filter((x): x is { a: Action; s: number } => x.s !== null)
        .sort((x, y) => y.s - x.s)
        .slice(0, tab === "all" ? 6 : 50);
      for (const { a } of scored) out.push({ kind: "action", action: a });
    }
    if (tab === "text" && project) {
      for (const t of text) out.push({ kind: "text", path: t.path, rel: relative(project.path, t.path), match: t.match });
    }
    return out;
  }, [tab, project, query, files, symbols, text, recentFiles]);

  useEffect(() => setSelected(0), [items.length, tab]);

  useEffect(() => {
    listRef.current?.querySelector(".se-item.selected")?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const shown = useMemo(() => previewOf(items[selected], line, column), [items, selected, line, column]);

  if (!open) return null;

  const togglePreview = () =>
    setPreview((on) => {
      try {
        localStorage.setItem(PREVIEW_KEY, on ? "0" : "1");
      } catch {
        // Private mode: the choice lasts until the window closes.
      }
      return !on;
    });

  const activate = (item: Item | undefined) => {
    if (!item) return;
    closeSearchEverywhere();
    if (item.kind === "action") {
      item.action.run();
    } else if (project) {
      const pos =
        item.kind === "text"
          ? { line: item.match.line, column: item.match.column }
          : item.kind === "symbol"
            ? { line: item.symbol.line, column: item.symbol.column }
            : { line, column };
      useWorkspace.getState().openFile(project.id, item.kind === "symbol" ? item.symbol.path : item.path, pos);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") closeSearchEverywhere();
    else if (e.key === "ArrowDown") setSelected((s) => Math.min(items.length - 1, s + 1));
    else if (e.key === "ArrowUp") setSelected((s) => Math.max(0, s - 1));
    else if (e.key === "PageDown") setSelected((s) => Math.min(items.length - 1, s + 10));
    else if (e.key === "PageUp") setSelected((s) => Math.max(0, s - 10));
    else if (e.key === "Enter") activate(items[selected]);
    else if (e.key === "Tab") {
      const i = TABS.findIndex((t) => t.id === tab);
      setTab(TABS[(i + (e.shiftKey ? TABS.length - 1 : 1)) % TABS.length].id);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  let lastGroup = "";
  return (
    <div className="modal-backdrop se-backdrop" onMouseDown={(e) => e.target === e.currentTarget && closeSearchEverywhere()}>
      <div className={"se-popup se-main" + (preview ? " with-preview" : "")} tabIndex={-1} onKeyDown={onKeyDown} onMouseDown={keepSearchFocus}>
        <div className="se-tabs">
          {TABS.map((t) => (
            <button key={t.id} className={"se-tab" + (t.id === tab ? " active" : "")} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
          <label className="se-include" title="Also search ignored files: bin/, obj/, Library/, .gitignore'd (Double Shift)">
            <input type="checkbox" checked={includeAll} onChange={toggleSeIncludeAll} />
            Include non-solution items
          </label>
          <button className={"se-preview-btn" + (preview ? " on" : "")} title={preview ? "Hide preview" : "Show preview"} onClick={togglePreview}>
            <PanelBottom size={15} />
          </button>
        </div>
        <label className="se-field">
          <Search size={16} className="ico" />
          <input
            ref={inputRef}
            className="se-input"
            value={input}
            spellCheck={false}
            placeholder={tab === "actions" ? "Type action name" : tab === "text" ? "Search text in project" : tab === "symbols" ? "Type symbol name" : "Type / to see commands"}
            onChange={(e) => setInput(e.target.value)}
          />
        </label>
        <div className="se-list" ref={listRef}>
          {items.map((item, i) => {
            const group =
              item.kind === "action"
                ? "Actions"
                : item.kind === "symbol"
                  ? "Symbols"
                  : item.kind === "text"
                    ? "Text"
                    : item.kind === "file" && item.recent
                      ? "Recent Files"
                      : "Files";
            const header = tab === "all" && group !== lastGroup ? group : null;
            lastGroup = group;
            return (
              <div key={i}>
                {header && <div className="se-group">{header}</div>}
                <div
                  className={"se-item" + (i === selected ? " selected" : "")}
                  onMouseMove={() => setSelected(i)}
                  onClick={() => activate(item)}
                >
                  {item.kind === "file" && (
                    <>
                      <FileIcon name={basename(item.path)} />
                      <span className="se-name">
                        <Highlighted text={basename(item.path)} indices={item.indices} />
                      </span>
                      <span className="se-detail">{dirname(item.rel)}</span>
                    </>
                  )}
                  {item.kind === "symbol" && (
                    <>
                      <SymbolIcon kind={item.symbol.kind} />
                      <span className="se-name">
                        <Highlighted text={item.symbol.name} indices={matchIndices(item.symbol.name, query)} />
                      </span>
                      {item.symbol.container && <span className="se-detail">in {item.symbol.container}</span>}
                      <span className="se-where">
                        <FileIcon name={basename(item.symbol.path)} />
                        {basename(item.symbol.path)}:{item.symbol.line}
                      </span>
                    </>
                  )}
                  {item.kind === "action" && (
                    <>
                      <span className="se-name">
                        <Highlighted text={item.action.label} indices={matchIndices(item.action.label, query)} />
                      </span>
                      {item.action.shortcut && <span className="se-shortcut">{item.action.shortcut}</span>}
                    </>
                  )}
                  {item.kind === "text" && (
                    <>
                      <span className="se-line">
                        {item.match.lineText.slice(0, item.match.previewStart).trimStart()}
                        <mark>{item.match.lineText.slice(item.match.previewStart, item.match.previewEnd)}</mark>
                        {item.match.lineText.slice(item.match.previewEnd)}
                      </span>
                      <span className="se-where">
                        <FileIcon name={basename(item.path)} />
                        {basename(item.path)} {item.match.line}
                      </span>
                    </>
                  )}
                </div>
              </div>
            );
          })}
          {items.length === 0 && (
            <div className="se-empty">{query ? "Nothing found" : tab === "text" ? "Type at least 2 characters" : "No recent files"}</div>
          )}
        </div>
        {preview && (
          <div className="se-preview">
            <div className="find-preview-header">
              {shown && project ? (
                <>
                  <FileIcon name={basename(shown.path)} />
                  <span className="find-file-name">{basename(shown.path)}</span>
                  <span className="find-file-dir">{relative(project.path, shown.path)}</span>
                </>
              ) : (
                <span className="muted">No preview</span>
              )}
            </div>
            <CodePreview path={shown?.path ?? null} hash={null} match={shown?.range ?? null} others={NO_RANGES} />
          </div>
        )}
        <div className="se-footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> to select · <kbd>Enter</kbd> to open · <kbd>Tab</kbd> next tab
          </span>
          <span>name:line to jump to a line</span>
        </div>
      </div>
    </div>
  );
}
