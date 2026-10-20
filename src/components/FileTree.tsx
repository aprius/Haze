import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { ChevronDown, ChevronRight, File, FileCode, FileJson, FileText, Folder, FolderOpen, Image, Link } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import { disposeBuffer, renameBuffer, useBuffers } from "../lib/buffers";
import { api, errorMessage, type DirEntry, type GitFileStatus } from "../lib/ipc";
import { basename, dirname, extname, isWithin, join, relative } from "../lib/path";
import { repo } from "../store/git";
import { newTerminal } from "../store/terminals";
import { openDiff } from "./DiffView";
import { showHistory } from "./GitPanel";
import { isIgnored, loadDir, refreshDirs, refreshGit, setSelection, useTree, type DirState, type GitView } from "../store/tree";
import { useWorkspace, type Project } from "../store/workspace";
import { confirmAction, openMenu, prompt, toast, type MenuItem } from "./Overlays";

const ROW_H = 22;
const OVERSCAN = 12;

interface Row {
  entry: DirEntry;
  depth: number;
  expandable: boolean;
  expanded: boolean;
}

function rootEntry(project: Project): DirEntry {
  return { name: project.name, path: project.path, isDir: true, isSymlink: false, nestedUnder: null };
}

export function buildRows(project: Project, dirs: Record<string, DirState>, expanded: Set<string>): Row[] {
  const rows: Row[] = [];
  const walk = (dir: string, depth: number) => {
    const st = dirs[dir];
    if (!st || !("entries" in st)) return;
    const names = new Set(st.entries.map((e) => e.name));
    const kids = new Map<string, DirEntry[]>();
    for (const e of st.entries) {
      if (e.nestedUnder && names.has(e.nestedUnder)) {
        kids.set(e.nestedUnder, [...(kids.get(e.nestedUnder) ?? []), e]);
      }
    }
    const emit = (e: DirEntry, d: number) => {
      if (e.isDir) {
        const open = expanded.has(e.path) && !e.isSymlink;
        rows.push({ entry: e, depth: d, expandable: !e.isSymlink, expanded: open });
        if (open) walk(e.path, d + 1);
        return;
      }
      const nested = kids.get(e.name) ?? [];
      const open = nested.length > 0 && expanded.has(e.path);
      rows.push({ entry: e, depth: d, expandable: nested.length > 0, expanded: open });
      if (open) nested.forEach((k) => emit(k, d + 1));
    };
    for (const e of st.entries) {
      if (!(e.nestedUnder && names.has(e.nestedUnder))) emit(e, depth);
    }
  };
  const root = rootEntry(project);
  const open = expanded.has(root.path);
  rows.push({ entry: root, depth: 0, expandable: true, expanded: open });
  if (open) walk(root.path, 1);
  return rows;
}

function FileIcon({ entry, open }: { entry: DirEntry; open: boolean }) {
  if (entry.isSymlink) return <Link size={14} className="ico ico-link" />;
  if (entry.isDir) return open ? <FolderOpen size={14} className="ico ico-folder" /> : <Folder size={14} className="ico ico-folder" />;
  const ext = extname(entry.name);
  if (["cs", "fs", "vb", "ts", "tsx", "js", "jsx", "rs", "go", "py", "java", "kt", "cpp", "c", "h", "razor", "cshtml", "xaml", "axaml", "sql", "sh", "ps1"].includes(ext))
    return <FileCode size={14} className={"ico ico-code ext-" + ext} />;
  if (["json", "jsonc"].includes(ext)) return <FileJson size={14} className="ico ico-json" />;
  if (["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp"].includes(ext)) return <Image size={14} className="ico ico-image" />;
  if (["md", "txt", "log", "csproj", "sln", "slnx", "props", "targets", "xml", "yml", "yaml", "toml", "config"].includes(ext))
    return <FileText size={14} className="ico ico-text" />;
  return <File size={14} className="ico" />;
}

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
  const rows = useMemo(() => buildRows(project, dirs, expanded), [project, dirs, expanded]);
  const selected = useMemo(() => new Set(selection), [selection]);

  // First open: expand the root.
  useEffect(() => {
    if (ui && ui.expanded.length === 0) updateUi(project.id, { expanded: [project.path] });
  }, [project.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load every expanded directory that is not cached yet.
  useEffect(() => {
    for (const p of expanded) {
      if (!dirs[p] && isWithin(p, project.path)) void loadDir(p, nest);
    }
  }, [expanded, dirs, nest, project.path]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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
    const target = await run("Rename", () => api.renamePath(entry.path, name.trim()));
    if (!target) return;
    renameBuffer(entry.path, target);
    useWorkspace.getState().renamePaths(entry.path, target);
    setSelection(project.id, [target], target);
    afterChange(dirname(entry.path));
  };

  const remove = async (entries: DirEntry[]) => {
    const list = entries.filter((e) => e.path !== project.path);
    if (!list.length) return;
    const what = list.length === 1 ? `"${list[0].name}"` : `${list.length} items`;
    if (!(await confirmAction("Delete", `Move ${what} to the trash?`, "Delete", true))) return;
    const ok = await run("Delete", () => api.trashPaths(list.map((e) => e.path)));
    if (ok === null) return;
    const ws = useWorkspace.getState();
    const gone = (p: string) => list.some((e) => isWithin(p, e.path));
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
    const fn = clipboard.cut ? api.movePaths : api.copyPaths;
    const result = await run(clipboard.cut ? "Move" : "Copy", () => fn(clipboard.paths, dir));
    if (!result) return;
    if (clipboard.cut) {
      clipboard.paths.forEach((p) => {
        const to = join(dir, basename(p));
        renameBuffer(p, to);
        useWorkspace.getState().renamePaths(p, to);
      });
      useTree.setState({ clipboard: null });
    }
    setExpanded(dir, true);
    setSelection(project.id, result, result[0]);
    afterChange();
  };

  const moveInto = async (paths: string[], dir: string, copy: boolean) => {
    const sources = paths.filter((p) => dirname(p) !== dir || copy);
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
            const st = statusOf(git, row.entry);
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
                <FileIcon entry={row.entry} open={row.expanded} />
                <span className="tree-name">
                  {row.entry.name}
                  {dirty && <span className="dirty-mark">*</span>}
                </span>
                {row.depth === 0 && <span className="tree-hint">{project.path}</span>}
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
