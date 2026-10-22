import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronsDownUp, Eye, LocateFixed, Package } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import { disposeBuffer, renameBuffer, useBuffers } from "../lib/buffers";
import { api, errorMessage, type DirEntry, type GitFileStatus } from "../lib/ipc";
import { basename, dirname, isWithin, join, relative } from "../lib/path";
import { repo } from "../store/git";
import { newTerminal } from "../store/terminals";
import { openDiff } from "./DiffView";
import { FileIcon } from "./FileIcon";
import { revealInTree } from "./EditorArea";
import { showHistory } from "./GitPanel";
import { isIgnored, loadDir, loadUnityPackages, refreshDirs, refreshGit, setSelection, useTree, type GitView } from "../store/tree";
import { useWorkspace, type Project, type TreeView } from "../store/workspace";
import { buildRows, isUnityProject, resolveView, type Row } from "../lib/treeRows";
import { confirmAction, openMenu, prompt, toast, type MenuItem } from "./Overlays";

const ROW_H = 24;
const OVERSCAN = 12;

function statusOf(view: GitView | undefined, entry: DirEntry): GitFileStatus | "changed-dir" | null {
  if (!view) return null;
  if (isIgnored(view, entry.path)) return "ignored";
  const st = view.status.files[entry.path];
  if (st) return st;
  if (entry.isDir && view.changedDirs.has(entry.path)) return "changed-dir";
  return null;
}

const validName = (v: string) => (!v.trim() ? "Name cannot be empty" : /[\\/]/.test(v) ? "Name cannot contain / or \\" : null);

export function FileTree({ project }: { project: Project }) {
  const ui = useWorkspace((s) => s.ui[project.id]);
  const nest = useWorkspace((s) => s.nestFiles);
  const updateUi = useWorkspace((s) => s.updateUi);
  const openFile = useWorkspace((s) => s.openFile);
  const dirs = useTree((s) => s.dirs);
  const git = useTree((s) => s.git[project.id]);
  const selection = useTree((s) => s.selection[project.id]) ?? [];
  const clipboard = useTree((s) => s.clipboard);
  const meta = useBuffers((s) => s.meta);
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const expanded = useMemo(() => new Set(ui?.expanded ?? []), [ui?.expanded]);
  const unity = isUnityProject(dirs, project.path);
  const view = resolveView(ui?.treeView, unity);
  const showAll = !!ui?.treeShowAll;
  const packages = useTree((s) => s.packages[project.path]);
  const rows = useMemo(
    () => buildRows(project, dirs, expanded, { view, showAll, packages }),
    [project, dirs, expanded, view, showAll, packages],
  );
  const selected = useMemo(() => new Set(selection), [selection]);
  // Scrolls a newly selected row into view once it is listed (Select Opened File expands its folders first).
  const pendingScroll = useRef<string | null>(null);

  // First open: expand the root.
  useEffect(() => {
    if (ui && ui.expanded.length === 0) updateUi(project.id, { expanded: [project.path] });
  }, [project.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load every expanded directory that is not cached yet; the root always,
  // since it tells a Unity project apart and the Unity view lists it.
  useEffect(() => {
    if (!dirs[project.path]) void loadDir(project.path, nest);
    for (const p of expanded) {
      const inPackage = packages?.some((k) => isWithin(p, k.path));
      if (!dirs[p] && (isWithin(p, project.path) || inPackage)) void loadDir(p, nest);
    }
  }, [expanded, dirs, nest, project.path, packages]);

  useEffect(() => {
    if (unity && !packages) void loadUnityPackages(project.path);
  }, [unity, packages, project.path]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    pendingScroll.current = selection[selection.length - 1] ?? null;
  }, [selection]);

  useEffect(() => {
    const path = pendingScroll.current;
    const el = scroller.current;
    if (!path || !el) return;
    const i = rows.findIndex((r) => r.entry.path === path);
    if (i < 0) return;
    pendingScroll.current = null;
    const top = i * ROW_H;
    if (top < el.scrollTop || top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = Math.max(0, top - el.clientHeight / 2);
  }, [rows, selection]);

  // Unity tracks assets by the GUID in their `.meta`: it moves, renames and is
  // deleted with its asset, even when the view hides it. Copies get a new one.
  const metaOf = (path: string): string | null => {
    if (!unity) return null;
    const st = dirs[dirname(path)];
    const m = path + ".meta";
    return st && "entries" in st && st.entries.some((e) => e.path === m) ? m : null;
  };
  const withMeta = (paths: string[]): string[] => [...new Set(paths.flatMap((p) => [p, metaOf(p) ?? p]))];

  const setExpanded = (path: string, open: boolean) =>
    updateUi(project.id, (u) => ({
      expanded: open ? [...new Set([...u.expanded, path])] : u.expanded.filter((p) => p !== path && !isWithin(p, path)),
    }));

  const targetDir = (entry: DirEntry) => (entry.isDir ? entry.path : dirname(entry.path));
  const selectedEntries = (fallback?: DirEntry): DirEntry[] => {
    const list = rows.filter((r) => selected.has(r.entry.path)).map((r) => r.entry);
    return list.length ? list : fallback ? [fallback] : [];
  };

  const afterChange = (dir?: string) => {
    void refreshDirs(project.path, dir ? [dir] : "all", nest);
    refreshGit(project.id, project.path, 200);
  };

  const run = async <T,>(what: string, f: () => Promise<T>): Promise<T | null> => {
    try {
      return await f();
    } catch (e) {
      toast(`${what}: ${errorMessage(e)}`, "error");
      return null;
    }
  };

  const newFile = async (dir: string) => {
    const name = await prompt("New File", "", { validate: validName, okLabel: "Create" });
    if (!name) return;
    const path = await run("Create file", () => api.createFile(dir, name.trim()));
    if (!path) return;
    setExpanded(dir, true);
    afterChange(dir);
    setSelection(project.id, [path], path);
    openFile(project.id, path);
  };

  const newDir = async (dir: string) => {
    const name = await prompt("New Directory", "", {
      validate: (v) => (!v.trim() ? "Name cannot be empty" : null),
      okLabel: "Create",
    });
    if (!name) return;
    const path = await run("Create directory", () => api.createDir(dir, name.trim()));
    if (!path) return;
    setExpanded(dir, true);
    afterChange(dir);
    setSelection(project.id, [path], path);
  };

  const rename = async (entry: DirEntry) => {
    if (entry.path === project.path) return;
    const name = await prompt(`Rename ${entry.isDir ? "Directory" : "File"}`, entry.name, {
      selectStem: !entry.isDir,
      validate: validName,
      okLabel: "Rename",
    });
    if (!name || name === entry.name) return;
    const meta = metaOf(entry.path);
    const target = await run("Rename", () => api.renamePath(entry.path, name.trim()));
    if (!target) return;
    renameBuffer(entry.path, target);
    useWorkspace.getState().renamePaths(entry.path, target);
    if (meta) {
      const to = await run("Rename .meta", () => api.renamePath(meta, name.trim() + ".meta"));
      if (to) {
        renameBuffer(meta, to);
        useWorkspace.getState().renamePaths(meta, to);
      }
    }
    setSelection(project.id, [target], target);
    afterChange(dirname(entry.path));
  };

  const remove = async (entries: DirEntry[]) => {
    const list = entries.filter((e) => e.path !== project.path);
    if (!list.length) return;
    const what = list.length === 1 ? `"${list[0].name}"` : `${list.length} items`;
    if (!(await confirmAction("Delete", `Move ${what} to the trash?`, "Delete", true))) return;
    const paths = withMeta(list.map((e) => e.path));
    const ok = await run("Delete", () => api.trashPaths(paths));
    if (ok === null) return;
    const ws = useWorkspace.getState();
    const gone = (p: string) => paths.some((x) => isWithin(p, x));
    const closing = (ws.ui[project.id]?.tabs ?? []).filter((t) => gone(t.path)).map((t) => t.path);
    // Unsaved buffers stay open so their text is not lost.
    const clean = closing.filter((p) => !(meta[p]?.status === "text" && (meta[p] as { dirty: boolean }).dirty));
    ws.closeTabs(project.id, clean);
    clean.forEach(disposeBuffer);
    setSelection(project.id, []);
    afterChange();
  };

  const paste = async (dir: string) => {
    if (!clipboard) return;
    const sources = clipboard.cut ? withMeta(clipboard.paths) : clipboard.paths;
    const fn = clipboard.cut ? api.movePaths : api.copyPaths;
    const result = await run(clipboard.cut ? "Move" : "Copy", () => fn(sources, dir));
    if (!result) return;
    if (clipboard.cut) {
      // Paths already in `dir` were not moved.
      sources.filter((p) => dirname(p) !== dir).forEach((p) => {
        const to = join(dir, basename(p));
        renameBuffer(p, to);
        useWorkspace.getState().renamePaths(p, to);
      });
      useTree.setState({ clipboard: null });
    }
    const shown = clipboard.paths.map(basename);
    const picked = result.filter((p) => shown.includes(basename(p)) || !p.endsWith(".meta"));
    setExpanded(dir, true);
    setSelection(project.id, picked, picked[0]);
    afterChange();
  };

  const moveInto = async (paths: string[], dir: string, copy: boolean) => {
    const sources = (copy ? paths : withMeta(paths)).filter((p) => dirname(p) !== dir || copy);
    if (!sources.length) return;
    const result = await run(copy ? "Copy" : "Move", () => (copy ? api.copyPaths(sources, dir) : api.movePaths(sources, dir)));
    if (!result) return;
    if (!copy) {
      sources.forEach((p) => {
        const to = join(dir, basename(p));
        renameBuffer(p, to);
        useWorkspace.getState().renamePaths(p, to);
      });
    }
    setExpanded(dir, true);
    afterChange();
  };

  const copyText = (text: string) => void navigator.clipboard.writeText(text).then(() => toast("Copied to clipboard"));

  const menuFor = (entry: DirEntry): MenuItem[] => {
    const dir = targetDir(entry);
    const entries = selectedEntries(entry);
    const isRoot = entry.path === project.path;
    return [
      { label: "New File…", shortcut: "Alt+Insert", action: () => void newFile(dir) },
      { label: "New Directory…", action: () => void newDir(dir) },
      { separator: true },
      { label: "Cut", shortcut: "Ctrl+X", disabled: isRoot, action: () => useTree.setState({ clipboard: { paths: entries.map((e) => e.path), cut: true } }) },
      { label: "Copy", shortcut: "Ctrl+C", disabled: isRoot, action: () => useTree.setState({ clipboard: { paths: entries.map((e) => e.path), cut: false } }) },
      { label: "Paste", shortcut: "Ctrl+V", disabled: !clipboard, action: () => void paste(dir) },
      { separator: true },
      { label: "Copy Path", shortcut: "Ctrl+Shift+C", action: () => copyText(entries.map((e) => e.path).join("\n")) },
      { label: "Copy Relative Path", action: () => copyText(entries.map((e) => relative(project.path, e.path)).join("\n")) },
      { separator: true },
      { label: "Rename…", shortcut: "Shift+F6", disabled: isRoot, action: () => void rename(entry) },
      { label: "Delete", shortcut: "Delete", disabled: isRoot, danger: true, action: () => void remove(entries) },
      { separator: true },
      { label: "Open in Terminal", action: () => void newTerminal(project.id, dir, { title: basename(dir) }) },
      { separator: true },
      { label: "Git: Show History", action: () => showHistory(project, entry.path) },
      {
        label: "Git: Compare with HEAD",
        disabled: entry.isDir,
        action: () => {
          const root = repo(project.id).root;
          if (!root) return toast("Not a git repository.", "error");
          const rel = relative(root, entry.path);
          openDiff(project.id, { root, rel, left: "HEAD", right: "working" });
        },
      },
      { separator: true },
      { label: "Reveal in File Manager", action: () => void revealItemInDir(entry.path).catch((e) => toast(errorMessage(e), "error")) },
      { label: "Reload from Disk", action: () => afterChange() },
    ];
  };

  const onRowClick = (e: MouseEvent, row: Row, index: number) => {
    const path = row.entry.path;
    if (e.shiftKey) {
      const anchor = useTree.getState().anchor[project.id];
      const a = rows.findIndex((r) => r.entry.path === anchor);
      const [from, to] = a < 0 ? [index, index] : [Math.min(a, index), Math.max(a, index)];
      setSelection(project.id, rows.slice(from, to + 1).map((r) => r.entry.path));
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      setSelection(project.id, selected.has(path) ? selection.filter((p) => p !== path) : [...selection, path], path);
      return;
    }
    setSelection(project.id, [path], path);
    if (!row.entry.isDir) openFile(project.id, path, { preview: true });
  };

  const onRowDoubleClick = (row: Row) => {
    if (row.entry.isDir) setExpanded(row.entry.path, !row.expanded);
    else openFile(project.id, row.entry.path, { preview: false });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const cur = selection[selection.length - 1];
    const idx = rows.findIndex((r) => r.entry.path === cur);
    const row = rows[idx];
    const select = (i: number) => {
      const r = rows[Math.max(0, Math.min(rows.length - 1, i))];
      if (!r) return;
      setSelection(project.id, [r.entry.path], r.entry.path);
      const el = scroller.current;
      if (el) {
        const top = Math.max(0, Math.min(rows.length - 1, i)) * ROW_H;
        if (top < el.scrollTop) el.scrollTop = top;
        else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
      }
    };
    const mod = e.ctrlKey || e.metaKey;
    let handled = true;
    if (e.key === "ArrowDown") select(idx + 1);
    else if (e.key === "ArrowUp") select(idx - 1);
    else if (e.key === "Home") select(0);
    else if (e.key === "End") select(rows.length - 1);
    else if (e.key === "ArrowRight" && row) {
      if (row.expandable && !row.expanded) setExpanded(row.entry.path, true);
      else select(idx + 1);
    } else if (e.key === "ArrowLeft" && row) {
      if (row.expandable && row.expanded) setExpanded(row.entry.path, false);
      else {
        for (let i = idx - 1; i >= 0; i--) if (rows[i].depth < row.depth) return select(i);
      }
    } else if (e.key === "Enter" && row) onRowDoubleClick(row);
    else if (e.key === "Delete" && row) void remove(selectedEntries(row.entry));
    else if ((e.key === "F2" || (e.shiftKey && e.key === "F6")) && row) void rename(row.entry);
    else if (e.altKey && e.key === "Insert" && row) {
      const r = (e.target as HTMLElement).getBoundingClientRect();
      openMenu({ clientX: r.left + 40, clientY: r.top + (idx - Math.floor(scrollTop / ROW_H) + 1) * ROW_H }, menuFor(row.entry).slice(0, 2));
    } else if (mod && e.shiftKey && e.key.toLowerCase() === "c" && row) copyText(selectedEntries(row.entry).map((x) => x.path).join("\n"));
    else if (mod && e.key.toLowerCase() === "c" && row)
      useTree.setState({ clipboard: { paths: selectedEntries(row.entry).map((x) => x.path), cut: false } });
    else if (mod && e.key.toLowerCase() === "x" && row)
      useTree.setState({ clipboard: { paths: selectedEntries(row.entry).map((x) => x.path), cut: true } });
    else if (mod && e.key.toLowerCase() === "v" && row) void paste(targetDir(row.entry));
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const onDragStart = (e: DragEvent, row: Row) => {
    if (row.entry.path === project.path) return e.preventDefault();
    const paths = selected.has(row.entry.path) ? selection : [row.entry.path];
    e.dataTransfer.setData("application/x-haze-paths", JSON.stringify(paths));
    e.dataTransfer.effectAllowed = "copyMove";
  };

  const onDragOver = (e: DragEvent, row: Row) => {
    if (!e.dataTransfer.types.includes("application/x-haze-paths")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = e.ctrlKey || e.altKey ? "copy" : "move";
    setDropTarget(targetDir(row.entry));
  };

  const onDrop = (e: DragEvent, row: Row) => {
    e.preventDefault();
    setDropTarget(null);
    const raw = e.dataTransfer.getData("application/x-haze-paths");
    if (!raw) return;
    const paths = JSON.parse(raw) as string[];
    void moveInto(paths, targetDir(row.entry), e.ctrlKey || e.altKey);
  };

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_H) + OVERSCAN);
  const libraryDir = join(project.path, "Library");
  const cutPaths = clipboard?.cut ? new Set(clipboard.paths) : null;

  return (
    <div className="file-tree">
      <div
        ref={scroller}
        className="tree-scroll"
        tabIndex={0}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onKeyDown={onKeyDown}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget(null);
        }}
      >
        <div style={{ height: rows.length * ROW_H, position: "relative" }}>
          {rows.slice(first, last).map((row, i) => {
            const index = first + i;
            // Package caches are ignored by git, yet they are the packages: no grey.
            const st = view === "unity" && isWithin(row.entry.path, libraryDir) ? null : statusOf(git, row.entry);
            const loadingDir = row.expanded && row.entry.isDir && dirs[row.entry.path] && "loading" in dirs[row.entry.path];
            const dirError = row.expanded && row.entry.isDir && dirs[row.entry.path] && "error" in dirs[row.entry.path];
            const dirty = meta[row.entry.path]?.status === "text" && (meta[row.entry.path] as { dirty: boolean }).dirty;
            return (
              <div
                key={row.entry.path}
                className={
                  "tree-row" +
                  (selected.has(row.entry.path) ? " selected" : "") +
                  (dropTarget === row.entry.path && row.entry.isDir ? " drop-target" : "") +
                  (cutPaths?.has(row.entry.path) ? " cut" : "") +
                  (st ? " git-" + st : "")
                }
                style={{ top: index * ROW_H, height: ROW_H, paddingLeft: 6 + row.depth * 16 }}
                draggable
                onDragStart={(e) => onDragStart(e, row)}
                onDragOver={(e) => onDragOver(e, row)}
                onDrop={(e) => onDrop(e, row)}
                onClick={(e) => onRowClick(e, row, index)}
                onDoubleClick={() => onRowDoubleClick(row)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (!selected.has(row.entry.path)) setSelection(project.id, [row.entry.path], row.entry.path);
                  openMenu(e, menuFor(row.entry));
                }}
                title={row.entry.path}
              >
                <span
                  className="chevron"
                  onClick={(e) => {
                    if (!row.expandable) return;
                    e.stopPropagation();
                    setExpanded(row.entry.path, !row.expanded);
                  }}
                >
                  {row.expandable ? row.expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : null}
                </span>
                {row.pkg ? (
                  <Package size={14} className="ico ico-package" />
                ) : view === "unity" && row.entry.isDir && !row.entry.isSymlink ? null : (
                  <FileIcon name={row.entry.name} isDir={row.entry.isDir} isSymlink={row.entry.isSymlink} open={row.expanded} />
                )}
                <span className="tree-name">
                  {row.entry.name}
                  {dirty && <span className="dirty-mark">*</span>}
                </span>
                {row.entry.path === project.path && <span className="tree-hint">{project.path}</span>}
                {row.pkg && <span className="tree-hint">{row.pkg.version}</span>}
                {loadingDir && <span className="tree-hint">loading…</span>}
                {dirError && <span className="tree-hint error">{(dirs[row.entry.path] as { error: string }).error}</span>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const VIEW_LABEL: Record<TreeView, string> = { unity: "Unity", files: "File System" };

/** Header of the Project tool window: view mode switcher and tree actions, as in Rider. */
export function ProjectViewHeader({ project, onHide }: { project: Project; onHide: () => void }) {
  const ui = useWorkspace((s) => s.ui[project.id]);
  const updateUi = useWorkspace((s) => s.updateUi);
  const unity = useTree((s) => isUnityProject(s.dirs, project.path));
  const view = resolveView(ui?.treeView, unity);

  const locate = () => {
    const tab = ui?.activeTab;
    if (tab && isWithin(tab, project.path)) revealInTree(project, tab);
  };

  return (
    <div className="sidebar-tabs">
      <span className="tool-title">Project</span>
      {unity ? (
        <button
          className="view-switch"
          title="Change view"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            openMenu(
              { clientX: r.left, clientY: r.bottom + 2 },
              (["unity", "files"] as const).map((v) => ({
                label: VIEW_LABEL[v],
                checked: v === view,
                action: () => updateUi(project.id, { treeView: v }),
              })),
            );
          }}
        >
          {VIEW_LABEL[view]}
          <ChevronDown size={12} />
        </button>
      ) : (
        <span className="view-switch static">{VIEW_LABEL[view]}</span>
      )}
      <span className="toolbar-gap" />
      {view === "unity" && (
        <button
          className={"icon-btn" + (ui?.treeShowAll ? " on" : "")}
          title="Show All Files"
          onClick={() => updateUi(project.id, (u) => ({ treeShowAll: !u.treeShowAll }))}
        >
          <Eye size={14} />
        </button>
      )}
      <button className="icon-btn" title="Select Opened File" disabled={!ui?.activeTab} onClick={locate}>
        <LocateFixed size={14} />
      </button>
      <button className="icon-btn" title="Collapse All" onClick={() => updateUi(project.id, { expanded: [project.path] })}>
        <ChevronsDownUp size={14} />
      </button>
      <button className="icon-btn" title="Hide" onClick={onHide}>
        <ChevronLeft size={14} />
      </button>
    </div>
  );
}
