// Search Everywhere (Double Shift), Go to File (Ctrl+Shift+N), Find Action
// (Ctrl+Shift+A) and recent files (Ctrl+E) — one popup, like Rider.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { actions, scoreLabel, type Action } from "../lib/actions";
import { api, type FileHit, type SearchMatch } from "../lib/ipc";
import { basename, relative } from "../lib/path";
import { closeSearchEverywhere, useUi, type SeTab } from "../store/ui";
import { useWorkspace, type Project } from "../store/workspace";

type Item =
  | { kind: "file"; path: string; rel: string; indices: number[]; recent?: boolean }
  | { kind: "action"; action: Action }
  | { kind: "text"; path: string; rel: string; match: SearchMatch };

const TABS: { id: SeTab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "files", label: "Files" },
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
      out.push(runHit ? <b key={i}>{run}</b> : run);
      run = "";
    }
    runHit = hit;
    run += c;
  });
  if (run) out.push(runHit ? <b key="end">{run}</b> : run);
  return <>{out}</>;
}

export function SearchEverywhere({ project }: { project: Project | null }) {
  const { open, tab: initialTab, nonce, query: initialQuery } = useUi((s) => s.searchEverywhere);
  const [tab, setTab] = useState<SeTab>(initialTab);
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<FileHit[]>([]);
  const [text, setText] = useState<{ path: string; match: SearchMatch }[]>([]);
  const [selected, setSelected] = useState(0);
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
    if (!open || !project || !query || tab === "actions" || tab === "text") {
      setFiles([]);
      return;
    }
    let stale = false;
    const t = setTimeout(() => {
      api
        .findFiles(project.path, query, tab === "files" ? 60 : 12)
        .then((hits) => !stale && setFiles(hits))
        .catch(() => !stale && setFiles([]));
    }, 40);
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
          { dirs: [project.path], files: [], fileMask: null, includeIgnored: false, overrides: {} },
          60,
        )
        .then((r) => !stale && setText(r.files.flatMap((f) => f.matches.map((m) => ({ path: f.path, match: m })))))
        .catch(() => !stale && setText([]));
    }, 200);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [open, project, query, tab]);

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
  }, [tab, project, query, files, text, recentFiles]);

  useEffect(() => setSelected(0), [items.length, tab]);

  useEffect(() => {
    listRef.current?.querySelector(".se-item.selected")?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  if (!open) return null;

  const activate = (item: Item | undefined) => {
    if (!item) return;
    closeSearchEverywhere();
    if (item.kind === "action") {
      item.action.run();
    } else if (project) {
      const pos = item.kind === "text" ? { line: item.match.line, column: item.match.column } : { line, column };
      useWorkspace.getState().openFile(project.id, item.path, pos);
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
      <div className="se-popup" tabIndex={-1} onKeyDown={onKeyDown}>
        <div className="se-tabs">
          {TABS.map((t) => (
            <button key={t.id} className={"se-tab" + (t.id === tab ? " active" : "")} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
          <span className="se-hint">Tab to switch · Enter to open · name:line to jump</span>
        </div>
        <input
          ref={inputRef}
          className="se-input"
          value={input}
          spellCheck={false}
          placeholder={tab === "actions" ? "Type action name" : tab === "text" ? "Search text in project" : "Type file name or action"}
          onChange={(e) => setInput(e.target.value)}
        />
        <div className="se-list" ref={listRef}>
          {items.map((item, i) => {
            const group =
              item.kind === "action" ? "Actions" : item.kind === "text" ? "Text" : item.kind === "file" && item.recent ? "Recent Files" : "Files";
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
                      <span className="se-name">
                        <Highlighted text={basename(item.path)} indices={item.indices} />
                      </span>
                      <span className="se-detail">{item.rel}</span>
                    </>
                  )}
                  {item.kind === "action" && (
                    <>
                      <span className="se-name">{item.action.label}</span>
                      {item.action.shortcut && <span className="se-shortcut">{item.action.shortcut}</span>}
                    </>
                  )}
                  {item.kind === "text" && (
                    <>
                      <span className="se-line">
                        {item.match.lineText.slice(0, item.match.previewStart).trimStart()}
                        <b>{item.match.lineText.slice(item.match.previewStart, item.match.previewEnd)}</b>
                        {item.match.lineText.slice(item.match.previewEnd)}
                      </span>
                      <span className="se-detail">
                        {item.rel}:{item.match.line}
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
      </div>
    </div>
  );
}
