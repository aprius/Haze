// File tree data: cached directory listings, git status and selection.
// Not persisted; rebuilt from disk on startup.
import { create } from "zustand";
import { api, errorMessage, type DirEntry, type FsChange, type GitStatus } from "../lib/ipc";
import { ancestors, isWithin, join } from "../lib/path";
import { resolvePackages, type UnityPackage } from "../lib/treeRows";

export type DirState = { entries: DirEntry[] } | { loading: true } | { error: string };

export interface GitView {
  status: GitStatus;
  /** Directories containing changes, colored like their files. */
  changedDirs: Set<string>;
  /** Ignored paths, `/`-separated without a trailing slash. */
  ignored: string[];
}

interface TreeState {
  dirs: Record<string, DirState>;
  git: Record<string, GitView>;
  selection: Record<string, string[]>;
  anchor: Record<string, string | null>;
  clipboard: { paths: string[]; cut: boolean } | null;
  /** Packages each Unity project references, by project root. */
  packages: Record<string, UnityPackage[]>;
}

export const useTree = create<TreeState>(() => ({
  dirs: {},
  git: {},
  selection: {},
  anchor: {},
  clipboard: null,
  packages: {},
}));

const packagesLoading = new Set<string>();

export async function loadUnityPackages(root: string): Promise<void> {
  if (packagesLoading.has(root)) return;
  packagesLoading.add(root);
  try {
    const [lock, cache] = await Promise.all([
      api.readFile(join(join(root, "Packages"), "packages-lock.json")).catch(() => null),
      api.listDir(join(join(root, "Library"), "PackageCache"), false).catch(() => []),
    ]);
    const text = lock?.kind === "text" ? lock.content : null;
    const packages = resolvePackages(root, text, cache.filter((e) => e.isDir).map((e) => e.name));
    useTree.setState((s) => ({ packages: { ...s.packages, [root]: packages } }));
  } finally {
    packagesLoading.delete(root);
  }
}

const inflight = new Map<string, Promise<void>>();
/** Forced reloads asked for while a listing was in flight: it may predate the change. */
const again = new Map<string, Promise<void>>();

export function loadDir(path: string, nest: boolean, force = false): Promise<void> {
  const cur = useTree.getState().dirs[path];
  if (!force && cur && "entries" in cur) return Promise.resolve();
  const pending = inflight.get(path);
  if (pending && !force) return pending;
  if (pending) {
    let next = again.get(path);
    if (!next) {
      next = pending.then(() => {
        again.delete(path);
        return loadDir(path, nest, true);
      });
      again.set(path, next);
    }
    return next;
  }
  if (!cur) useTree.setState((s) => ({ dirs: { ...s.dirs, [path]: { loading: true } } }));
  const p = api
    .listDir(path, nest)
    .then(
      (entries) => useTree.setState((s) => ({ dirs: { ...s.dirs, [path]: { entries } } })),
      (e) => useTree.setState((s) => ({ dirs: { ...s.dirs, [path]: { error: errorMessage(e) } } })),
    )
    .finally(() => inflight.delete(path));
  inflight.set(path, p);
  return p;
}

/** Reloads cached listings under `root` (all of them, or just `dirs`). */
export async function refreshDirs(root: string, dirs: string[] | "all", nest: boolean): Promise<void> {
  const cached = Object.keys(useTree.getState().dirs).filter((d) => isWithin(d, root));
  const targets = dirs === "all" ? cached : cached.filter((d) => dirs.some((x) => sameDir(x, d)));
  await Promise.all(targets.map((d) => loadDir(d, nest, true)));
}

function sameDir(a: string, b: string): boolean {
  return a.replace(/\\/g, "/").replace(/\/+$/, "") === b.replace(/\\/g, "/").replace(/\/+$/, "");
}

const gitTimers = new Map<string, ReturnType<typeof setTimeout>>();
const statusListeners = new Set<(projectId: string, status: GitStatus) => void>();

/** Every fresh `git status` of a project (the Commit window takes its changes from it). */
export function onGitStatus(cb: (projectId: string, status: GitStatus) => void): () => void {
  statusListeners.add(cb);
  return () => statusListeners.delete(cb);
}

// Latest request per project; slower, older answers are dropped.
const gitSeq = new Map<string, number>();

export function refreshGit(projectId: string, root: string, delay = 0): void {
  const t = gitTimers.get(projectId);
  if (t) clearTimeout(t);
  gitTimers.set(
    projectId,
    setTimeout(async () => {
      gitTimers.delete(projectId);
      const seq = (gitSeq.get(projectId) ?? 0) + 1;
      gitSeq.set(projectId, seq);
      try {
        const status = await api.gitStatus(root);
        if (gitSeq.get(projectId) !== seq) return;
        const changedDirs = new Set<string>();
        const ignored: string[] = [];
        for (const [path, st] of Object.entries(status.files)) {
          if (st === "ignored") {
            ignored.push(slashes(path));
            continue;
          }
          for (const a of ancestors(path, root)) changedDirs.add(a);
        }
        useTree.setState((s) => ({ git: { ...s.git, [projectId]: { status, changedDirs, ignored } } }));
        statusListeners.forEach((l) => l(projectId, status));
      } catch (e) {
        console.warn("git status failed", e);
      }
    }, delay),
  );
}

const slashes = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");

export function isIgnored(view: GitView | undefined, path: string): boolean {
  if (!view) return false;
  if (view.status.files[path] === "ignored") return true;
  const p = slashes(path);
  return view.ignored.some((i) => p === i || p.startsWith(i + "/"));
}

/**
 * Whether a change can show up in `git status`. Build output and packages
 * (`bin/`, `obj/`, `node_modules/`) change constantly during a build or an
 * install, and each git refresh runs several git processes.
 */
export function affectsGit(projectId: string, change: FsChange): boolean {
  if (change.git || change.overflow) return true;
  const view = useTree.getState().git[projectId];
  return change.files.some((f) => !isIgnored(view, f));
}

export function handleFsChange(projectId: string, change: FsChange, nest: boolean): void {
  if (useTree.getState().packages[change.root] && (change.overflow || change.files.some((f) => /packages-lock\.json$|[\\/]PackageCache[\\/][^\\/]+$/.test(f))))
    void loadUnityPackages(change.root);
  if (change.overflow || change.dirs.length) void refreshDirs(change.root, change.overflow ? "all" : change.dirs, nest);
  if (affectsGit(projectId, change)) refreshGit(projectId, change.root, 300);
}

export function setSelection(projectId: string, paths: string[], anchor?: string | null): void {
  useTree.setState((s) => ({
    selection: { ...s.selection, [projectId]: paths },
    anchor: anchor === undefined ? s.anchor : { ...s.anchor, [projectId]: anchor },
  }));
}
