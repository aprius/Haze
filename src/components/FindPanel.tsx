// The Find tool window in the bottom panel: usages moved there from the
// usages popup stay listed, one tab per search, as a tree of files and lines.
// A detached editor window has one of its own, under its editors.
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Pin, RotateCcw, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { create } from "zustand";
import { errorMessage } from "../lib/ipc";
import { basename, dirname, relative } from "../lib/path";
import * as L from "../lib/editorLayout";
import { useWorkspace, type Project } from "../store/workspace";
import { Splitter } from "./Shell";
import { ToolTabs } from "./BuildPanel";
import { FileIcon } from "./FileIcon";
import { UsageCode, type Usage } from "./UsagesPopup";

interface FindTab {
  id: number;
  title: string;
  items: Usage[];
  loading: boolean;
  error: string | null;
  /** Pinned tabs are kept; new results replace the unpinned one. */
  pinned: boolean;
  rerun: (() => Promise<Usage[]>) | null;
}

/**
 * Tabs are kept per Find window: the main window's, keyed by its project, and
 * each detached editor window's, keyed by that window's id.
 */
interface FindState {
  tabs: Record<string, FindTab[]>;
  active: Record<string, number>;
  /** Detached windows' Find windows: shown, and their height. */
  docked: Record<string, { visible: boolean; height: number }>;
}

export const useFind = create<FindState>(() => ({ tabs: {}, active: {}, docked: {} }));

let nextId = 1;

function updateTab(key: string, id: number, patch: Partial<FindTab>): void {
  useFind.setState((s) => ({ tabs: { ...s.tabs, [key]: (s.tabs[key] ?? []).map((t) => (t.id === id ? { ...t, ...patch } : t)) } }));
}

function setDocked(windowId: string, patch: Partial<{ visible: boolean; height: number }>): void {
  useFind.setState((s) => ({ docked: { ...s.docked, [windowId]: { ...(s.docked[windowId] ?? { visible: false, height: 240 }), ...patch } } }));
}

/**
 * Shows `items` in the Find window, in place of its unpinned tab: the main
 * window's, or with `windowId` the one in that detached editor window.
 */
export function openInFindWindow(projectId: string, title: string, items: Usage[], rerun: (() => Promise<Usage[]>) | null, windowId: string | null = null): void {
  const key = windowId ?? projectId;
  const tab: FindTab = { id: nextId++, title, items, loading: false, error: null, pinned: false, rerun };
  useFind.setState((s) => {
    const tabs = s.tabs[key] ?? [];
    const at = tabs.findIndex((t) => !t.pinned);
    const next = at < 0 ? [...tabs, tab] : tabs.map((t, i) => (i === at ? tab : t));
    return { tabs: { ...s.tabs, [key]: next }, active: { ...s.active, [key]: tab.id } };
  });
  if (windowId) setDocked(windowId, { visible: true });
  else useWorkspace.getState().updateUi(projectId, { bottomVisible: true, bottomTab: "find" });
}

/** Drops a closed detached window's Find window. */
export function forgetFindWindow(windowId: string): void {
  useFind.setState((s) => {
    const { [windowId]: _t, ...tabs } = s.tabs;
    const { [windowId]: _a, ...active } = s.active;
    const { [windowId]: _d, ...docked } = s.docked;
    return { tabs, active, docked };
  });
}

function closeTab(projectId: string, windowId: string | null, id: number): void {
  const key = windowId ?? projectId;
  useFind.setState((s) => {
    const tabs = s.tabs[key] ?? [];
    const at = tabs.findIndex((t) => t.id === id);
    const next = tabs.filter((t) => t.id !== id);
    const active = s.active[key] === id ? (next[Math.min(at, next.length - 1)]?.id ?? 0) : s.active[key];
    return { tabs: { ...s.tabs, [key]: next }, active: { ...s.active, [key]: active } };
  });
  if (useFind.getState().tabs[key]?.length) return;
  if (windowId) setDocked(windowId, { visible: false });
  else useWorkspace.getState().updateUi(projectId, { bottomTab: "build" });
}

async function rerunTab(key: string, tab: FindTab): Promise<void> {
  if (!tab.rerun) return;
  updateTab(key, tab.id, { loading: true, error: null });
  try {
    updateTab(key, tab.id, { loading: false, items: await tab.rerun() });
  } catch (e) {
    updateTab(key, tab.id, { loading: false, error: errorMessage(e) });
  }
}

/** A detached editor window's editors, with its Find window under them when shown. */
export function WithFindWindow({ project, windowId, children }: { project: Project; windowId: string; children: ReactNode }) {
  const docked = useFind((s) => s.docked[windowId]);
  const ref = useRef<HTMLDivElement>(null);
  // Its own window's height, not the main window's.
  const height = (ref.current?.ownerDocument.defaultView ?? window).innerHeight;
  return (
    <div ref={ref} className="find-docked">
      {children}
      {docked?.visible && (
        <>
          <Splitter vertical={false} value={docked.height} min={100} max={Math.max(200, height - 160)} invert onChange={(v) => setDocked(windowId, { height: v })} />
          <div className="bottom" style={{ height: docked.height }}>
            <FindPanel project={project} windowId={windowId} />
          </div>
        </>
      )}
    </div>
  );
}

type Row = { kind: "file"; path: string; count: number } | { kind: "usage"; usage: Usage; index: number };

const rowKey = (r: Row) => (r.kind === "file" ? `f:${r.path}` : `u:${r.index}`);

/** `windowId`: the Find window of that detached editor window, else the main window's. */
export function FindPanel({ project, windowId = null }: { project: Project; windowId?: string | null }) {
  const key = windowId ?? project.id;
  const tabs = useFind((s) => s.tabs[key]) ?? [];
  const activeId = useFind((s) => s.active[key]);
  const tab = tabs.find((t) => t.id === activeId) ?? tabs[0];

  return (
    <div className="terminal-panel build-panel fw-panel">
      <div className="panel-header">
        {windowId ? <span className="panel-title">Find</span> : <ToolTabs project={project} />}
        <div className="fw-tabs">
          {tabs.map((t) => (
            <div
              key={t.id}
              className={"fw-tab" + (t === tab ? " active" : "")}
              onClick={() => useFind.setState((s) => ({ active: { ...s.active, [key]: t.id } }))}
              onMouseDown={(e) => e.button === 1 && (e.preventDefault(), closeTab(project.id, windowId, t.id))}
              title={t.title}
            >
              {t.pinned && <Pin size={11} />}
              <span className="fw-tab-title">{t.title}</span>
              <button
                className="fw-tab-close"
                title="Close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(project.id, windowId, t.id);
                }}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
        <div className="panel-actions">
          <button
            className="icon-btn"
            title="Hide"
            onClick={() => (windowId ? setDocked(windowId, { visible: false }) : useWorkspace.getState().updateUi(project.id, { bottomVisible: false }))}
          >
            <ChevronDown size={16} />
          </button>
        </div>
      </div>
      {tab ? <FindResults key={tab.id} project={project} windowId={windowId} tab={tab} /> : <div className="build-body fw-body se-empty">Find Usages, then Open in Find Window from the usages list</div>}
    </div>
  );
}

function FindResults({ project, windowId, tab }: { project: Project; windowId: string | null; tab: FindTab }) {
  const key = windowId ?? project.id;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const byFile = useMemo(() => {
    const m = new Map<string, number[]>();
    tab.items.forEach((u, i) => m.set(u.path, [...(m.get(u.path) ?? []), i]));
    return m;
  }, [tab.items]);

  const rows: Row[] = [];
  for (const [path, indexes] of byFile) {
    rows.push({ kind: "file", path, count: indexes.length });
    if (!collapsed.has(path)) for (const i of indexes) rows.push({ kind: "usage", usage: tab.items[i], index: i });
  }

  // Start on the first usage, and again after a rerun. The tree
  // takes focus so the popup closing does not hand it back to the editor.
  useEffect(() => {
    setSelected(tab.items.length ? "u:0" : null);
  }, [tab.items]);

  useEffect(() => {
    listRef.current?.focus();
  }, []);

  useEffect(() => {
    listRef.current?.querySelector(".fw-row.selected")?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const current = rows.find((r) => rowKey(r) === selected);

  const open = (u: Usage) => useWorkspace.getState().openFile(project.id, u.path, { line: u.line, column: u.column, group: groupIn(project.id, windowId) });
  const toggle = (path: string, collapse = !collapsed.has(path)) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (collapse) next.add(path);
      else next.delete(path);
      return next;
    });

  /** Previous / next usage, expanding its file, and shown in the editor (Ctrl+Alt+Up/Down). */
  const step = (delta: 1 | -1) => {
    const n = tab.items.length;
    if (!n) return;
    // From a file row: its first usage going down, the one before it going up.
    const at = current?.kind === "usage" ? current.index : current?.kind === "file" ? byFile.get(current.path)![0] - (delta > 0 ? 1 : 0) : delta > 0 ? -1 : 0;
    const i = (((at + delta) % n) + n) % n;
    toggle(tab.items[i].path, false);
    setSelected(`u:${i}`);
    open(tab.items[i]);
  };

  const onKey = (e: React.KeyboardEvent) => {
    const at = rows.findIndex((r) => rowKey(r) === selected);
    const r = rows[at];
    if (e.key === "ArrowDown") setSelected(rowKey(rows[Math.min(rows.length - 1, at + 1)] ?? rows[0]));
    else if (e.key === "ArrowUp") setSelected(rowKey(rows[Math.max(0, at - 1)] ?? rows[0]));
    else if (e.key === "ArrowLeft" && r) {
      if (r.kind === "file") toggle(r.path, true);
      else setSelected(`f:${r.usage.path}`);
    } else if (e.key === "ArrowRight" && r?.kind === "file") toggle(r.path, false);
    else if ((e.key === "Enter" || e.key === "F4") && r) {
      if (r.kind === "usage") open(r.usage);
      else toggle(r.path);
    } else return;
    e.preventDefault();
  };

  const files = byFile.size;
  const summary = tab.loading
    ? "Searching…"
    : tab.error
      ? tab.error
      : `${tab.items.length} usage${tab.items.length === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"}`;

  return (
    <div className="build-body fw-body">
      <div className="fw-toolbar">
        <button className="icon-btn" title="Rerun" disabled={!tab.rerun || tab.loading} onClick={() => void rerunTab(key, tab)}>
          <RotateCcw size={15} />
        </button>
        <button className="icon-btn" title="Expand All" onClick={() => setCollapsed(new Set())}>
          <ChevronsUpDown size={15} />
        </button>
        <button className="icon-btn" title="Collapse All" onClick={() => setCollapsed(new Set(byFile.keys()))}>
          <ChevronsDownUp size={15} />
        </button>
        <button className="icon-btn" title="Previous Occurrence" disabled={!tab.items.length} onClick={() => step(-1)}>
          <ArrowUp size={15} />
        </button>
        <button className="icon-btn" title="Next Occurrence" disabled={!tab.items.length} onClick={() => step(1)}>
          <ArrowDown size={15} />
        </button>
        <button className={"icon-btn" + (tab.pinned ? " on" : "")} title={tab.pinned ? "Unpin Tab" : "Pin Tab"} onClick={() => updateTab(key, tab.id, { pinned: !tab.pinned })}>
          <Pin size={15} />
        </button>
      </div>
      <div className="problems fw-tree" ref={listRef} tabIndex={0} onKeyDown={onKey}>
        <div className={"fw-summary" + (tab.error ? " error" : "")}>
          <b>{tab.title}</b> <span className="muted">{summary}</span>
        </div>
        {rows.map((r) => {
          const key = rowKey(r);
          if (r.kind === "file") {
            const dir = relative(project.path, dirname(r.path));
            return (
              <div
                key={key}
                className={"problem fw-row fw-file" + (key === selected ? " selected" : "")}
                onClick={() => setSelected(key)}
                onDoubleClick={() => toggle(r.path)}
                title={relative(project.path, r.path)}
              >
                <span
                  className="fw-chevron"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle(r.path);
                  }}
                >
                  {collapsed.has(r.path) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                </span>
                <FileIcon name={basename(r.path)} />
                <span>{basename(r.path)}</span>
                {dir && <span className="muted fw-dir">{dir}</span>}
                <span className="muted">
                  {r.count} usage{r.count === 1 ? "" : "s"}
                </span>
              </div>
            );
          }
          const u = r.usage;
          return (
            <div
              key={key}
              className={"problem fw-row fw-usage" + (key === selected ? " selected" : "")}
              onClick={() => setSelected(key)}
              onDoubleClick={() => open(u)}
            >
              <span className="find-lineno">
                ({u.line}, {u.column})
              </span>
              <span className="fw-code">
                <UsageCode usage={u} />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Where a detached window's Find window opens usages: its group used last. Undefined for the main window's (the active group). */
function groupIn(projectId: string, windowId: string | null): string | undefined {
  const ui = useWorkspace.getState().ui[projectId];
  const win = windowId && ui?.windows.find((w) => w.id === windowId);
  if (!ui || !win) return undefined;
  const ids = L.layoutGroups(win.layout);
  return ids.includes(ui.activeGroup) ? ui.activeGroup : ids[0];
}
