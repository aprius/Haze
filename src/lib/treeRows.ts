// Rows of the Project view for its modes (Unity, File System).
import type { DirEntry } from "./ipc";
import { join, sepOf } from "./path";
import type { DirState } from "../store/tree";
import type { Project, TreeView } from "../store/workspace";

export interface Row {
  entry: DirEntry;
  depth: number;
  expandable: boolean;
  expanded: boolean;
  /** A package the Unity project references, listed under Packages. */
  pkg?: UnityPackage;
}

export interface UnityPackage {
  name: string;
  path: string;
  /** Registry version, or the source for git and local packages. */
  version: string;
}

function rootEntry(project: Project): DirEntry {
  return { name: project.name, path: project.path, isDir: true, isSymlink: false, nestedUnder: null };
}

export interface TreeOptions {
  view: TreeView;
  showAll: boolean;
  packages?: UnityPackage[];
}

/** `rel` against the directory `base`, `..` resolved; absolute `rel` is kept. */
export function resolvePath(base: string, rel: string): string {
  const abs = /^([\\/]|[A-Za-z]:)/.test(rel);
  const sep = sepOf(base);
  const parts = (abs ? rel : base + "/" + rel).split(/[\\/]+/);
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") {
      if (out.length > 1) out.pop();
    } else if (p !== ".") out.push(p);
  }
  return out.join(sep) || sep;
}

/**
 * Packages a Unity project references, as Rider's Packages node lists them:
 * registry and git packages from `Library/PackageCache` (`name@hash`), local
 * ones from their `file:` path. Embedded packages are folders of `Packages/`
 * already; built-in modules live in the Unity install.
 */
export function resolvePackages(root: string, lockText: string | null, cacheDirs: string[]): UnityPackage[] {
  const packagesDir = join(root, "Packages");
  const cacheDir = join(join(root, "Library"), "PackageCache");
  const cached = new Map(cacheDirs.map((d) => [d.slice(0, d.lastIndexOf("@") > 0 ? d.lastIndexOf("@") : d.length), d]));
  let deps: Record<string, { version?: string; source?: string }> | null = null;
  try {
    deps = lockText ? JSON.parse(lockText).dependencies ?? null : null;
  } catch {
    deps = null;
  }
  const out: UnityPackage[] = [];
  if (deps) {
    for (const [name, d] of Object.entries(deps)) {
      const version = d.version ?? "";
      if (d.source === "local" && version.startsWith("file:")) {
        out.push({ name, path: resolvePath(packagesDir, version.slice(5)), version: "local" });
      } else if ((d.source === "registry" || d.source === "git") && cached.has(name)) {
        out.push({ name, path: join(cacheDir, cached.get(name)!), version: d.source === "git" ? "git" : version });
      }
    }
  } else {
    for (const [name, dir] of cached) out.push({ name, path: join(cacheDir, dir), version: dir.slice(name.length + 1) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const UNITY_TOP = ["Assets", "Packages"];

/** A Unity project root: `Assets` next to `ProjectSettings`. */
export function isUnityProject(dirs: Record<string, DirState>, root: string): boolean {
  const st = dirs[root];
  return !!st && "entries" in st && ["Assets", "ProjectSettings"].every((n) => st.entries.some((e) => e.isDir && e.name === n));
}

/** Assets Unity does not import: hidden names, `name~`, `cvs` and `*.tmp`. */
export function unityHidden(name: string): boolean {
  const n = name.toLowerCase();
  return n.startsWith(".") || n.endsWith("~") || n === "cvs" || n.endsWith(".tmp");
}

export function resolveView(view: TreeView | null | undefined, unity: boolean): TreeView {
  return unity && view !== "files" ? "unity" : "files";
}

export function buildRows(
  project: Project,
  dirs: Record<string, DirState>,
  expanded: Set<string>,
  opts: TreeOptions = { view: "files", showAll: false },
): Row[] {
  const rows: Row[] = [];
  const unity = opts.view === "unity";
  // Show All Files, as Rider's toggle, also brings back what Unity hides: `.meta` included.
  const visible = (e: DirEntry) => !unity || opts.showAll || ((e.isDir || !e.name.endsWith(".meta")) && !unityHidden(e.name));
  const packagesDir = join(project.path, "Packages");
  const pkgs = new Map((unity ? opts.packages ?? [] : []).map((p) => [p.path, p]));
  const walk = (dir: string, depth: number, top?: (entries: DirEntry[]) => DirEntry[]) => {
    const st = dirs[dir];
    if (!st || !("entries" in st)) return;
    let entries = st.entries.filter(visible);
    if (top) entries = top(entries);
    if (dir === packagesDir && pkgs.size) {
      const refs = [...pkgs.values()].map((p): DirEntry => ({ name: p.name, path: p.path, isDir: true, isSymlink: false, nestedUnder: null }));
      const n = entries.findIndex((e) => !e.isDir);
      entries = n < 0 ? [...entries, ...refs] : [...entries.slice(0, n), ...refs, ...entries.slice(n)];
    }
    // `.meta` files sit next to their asset, not under it.
    const flat = (e: DirEntry) => opts.view === "files" || e.name.endsWith(".meta");
    entries = entries.map((e) => (e.nestedUnder && flat(e) ? { ...e, nestedUnder: null } : e));
    const names = new Set(entries.map((e) => e.name));
    const kids = new Map<string, DirEntry[]>();
    for (const e of entries) {
      if (e.nestedUnder && names.has(e.nestedUnder)) {
        kids.set(e.nestedUnder, [...(kids.get(e.nestedUnder) ?? []), e]);
      }
    }
    const emit = (e: DirEntry, d: number) => {
      if (e.isDir) {
        const open = expanded.has(e.path) && !e.isSymlink;
        rows.push({ entry: e, depth: d, expandable: !e.isSymlink, expanded: open, pkg: pkgs.get(e.path) });
        if (open) walk(e.path, d + 1);
        return;
      }
      const nested = kids.get(e.name) ?? [];
      const open = nested.length > 0 && expanded.has(e.path);
      rows.push({ entry: e, depth: d, expandable: nested.length > 0, expanded: open });
      if (open) nested.forEach((k) => emit(k, d + 1));
    };
    for (const e of entries) {
      if (!(e.nestedUnder && names.has(e.nestedUnder))) emit(e, depth);
    }
  };
  if (unity) {
    // Like Rider's Unity Explorer: Assets and Packages at the top, no project node.
    const rank = (e: DirEntry) => (UNITY_TOP.includes(e.name) ? UNITY_TOP.indexOf(e.name) : UNITY_TOP.length);
    walk(project.path, 0, (entries) =>
      entries
        .filter((e) => opts.showAll || (e.isDir && UNITY_TOP.includes(e.name)))
        .sort((a, b) => rank(a) - rank(b)),
    );
    return rows;
  }
  const root = rootEntry(project);
  const open = expanded.has(root.path);
  rows.push({ entry: root, depth: 0, expandable: true, expanded: open });
  if (open) walk(root.path, 1);
  return rows;
}
