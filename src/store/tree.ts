// File tree data: cached directory listings, git status and selection.
// Not persisted; rebuilt from disk on startup.
import { create } from "zustand";
import { api, errorMessage, type DirEntry, type FsChange, type GitChange, type GitStatus } from "../lib/ipc";
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

/** Longest a debounced git refresh waits while changes keep coming. */
const MAX_GIT_WAIT = 2000;

/**
 * The delay for a debounced refresh of `id` that `since` tracks: `delay`, but
 * never past MAX_GIT_WAIT after the first request it is still waiting on. A
 * program writing a file every 100 ms (a log) would otherwise put it off forever.
 */
export function cappedDelay(since: Map<string, number>, id: string, delay: number): number {
  const now = Date.now();
  if (!since.has(id)) since.set(id, now);
  return Math.min(delay, Math.max(0, since.get(id)! + MAX_GIT_WAIT - now));
}

const gitTimers = new Map<string, ReturnType<typeof setTimeout>>();
const gitWaitingSince = new Map<string, number>();
const statusListeners = new Set<(projectId: string, status: GitStatus) => void>();

/** Every fresh `git status` of a project (the Commit window takes its changes from it). */
export function onGitStatus(cb: (projectId: string, status: GitStatus) => void): () => void {
  statusListeners.add(cb);
  return () => statusListeners.delete(cb);
}

/** Projects with a `git status` running; one asked for meanwhile runs after it (`statusAgain`). */
const statusRunning = new Set<string>();
const statusAgain = new Map<string, string>();

/** What the pending status of a project covers: changed paths, or everything. */
type Scope = Set<string> | "all";
const pendingScope = new Map<string, Scope>();
/** Past this many paths (or this much command line, Windows allows 32K) git status runs on everything. */
const MAX_SCOPED_PATHS = 200;
const MAX_SCOPED_CHARS = 16_000;

function widenScope(projectId: string, paths: string[] | "all"): void {
  const cur = pendingScope.get(projectId);
  if (paths === "all" || cur === "all") return void pendingScope.set(projectId, "all");
  const next = cur ?? new Set<string>();
  for (const p of paths) next.add(p);
  let chars = 0;
  for (const p of next) chars += p.length + 1;
  pendingScope.set(projectId, next.size > MAX_SCOPED_PATHS || chars > MAX_SCOPED_CHARS ? "all" : next);
}

/**
 * Refreshes git status, debounced by `delay`. With `paths` (changed files
 * from the watcher), only those are asked about and merged into the last
 * full status, like Rider's dirty scopes; requests merge their paths.
 */
export function refreshGit(projectId: string, root: string, delay = 0, paths: string[] | "all" = "all"): void {
  widenScope(projectId, paths);
  const t = gitTimers.get(projectId);
  if (t) clearTimeout(t);
  gitTimers.set(
    projectId,
    setTimeout(() => {
      gitTimers.delete(projectId);
      gitWaitingSince.delete(projectId);
      void runStatus(projectId, root);
    }, cappedDelay(gitWaitingSince, projectId, delay)),
  );
}

/** `path` relative to `top`, `/`-separated; null when not under it (or `top` itself). */
function relTo(top: string, path: string): string | null {
  const t = slashes(top);
  const p = slashes(path);
  return p.startsWith(t + "/") ? p.slice(t.length + 1) : null;
}

const covers = (rels: string[], rel: string) => rels.some((s) => rel === s || rel.startsWith(s + "/"));

/**
 * `prev` with what `part`, the status of `rels` only, says about them: entries
 * under those paths are replaced, the others kept. Order follows git's: tracked
 * changes by path, then untracked ones.
 */
export function mergeStatus(prev: GitStatus, part: GitStatus, rels: string[]): GitStatus {
  const top = prev.root!;
  const files: GitStatus["files"] = {};
  for (const [path, st] of Object.entries(prev.files)) {
    const rel = relTo(top, path);
    if (rel === null || !covers(rels, rel)) files[path] = st;
  }
  Object.assign(files, part.files);
  // By path: git can name an entry above the scope (`?? nested/` for a repository inside), which `prev` has too.
  const byRel = new Map(prev.changes.filter((c) => !covers(rels, c.rel)).map((c) => [c.rel, c]));
  for (const c of part.changes) byRel.set(c.rel, c);
  const rank = (c: GitChange) => (c.status === "untracked" ? 1 : 0);
  const changes = [...byRel.values()].sort((a, b) => rank(a) - rank(b) || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { ...prev, branch: part.branch, files, changes };
}

/** The status `scope` asks for: scoped and merged when it can be, else the whole tree. */
async function loadStatus(projectId: string, root: string, scope: Scope): Promise<GitStatus> {
  const prev = useTree.getState().git[projectId]?.status;
  // No paths would be no pathspec: git status of everything, merged as if scoped.
  if (scope === "all" || !scope.size || !prev?.isRepo || !prev.root) return api.gitStatus(root);
  const paths = [...scope];
  const rels = paths.map((p) => relTo(prev.root!, p));
  // Outside the repository (or its root): only a full status says.
  if (rels.some((r) => r === null)) return api.gitStatus(root);
  const scoped = rels as string[];
  // A staged rename needs both of its sides in one status, and a rule change in a .gitignore anything.
  const renamed = (cs: GitChange[]) => cs.some((c) => c.oldRel !== null && (covers(scoped, c.rel) || covers(scoped, c.oldRel)));
  if (renamed(prev.changes) || scoped.some((r) => /(^|\/)\.gitignore$/.test(r))) return api.gitStatus(root);
  try {
    const part = await api.gitStatusPaths(prev.root, paths);
    if (part.changes.some((c) => c.oldRel !== null)) return api.gitStatus(root);
    return mergeStatus(prev, part, scoped);
  } catch {
    return api.gitStatus(root);
  }
}

/**
 * One `git status` per project at a time, like Rider's change list updates:
 * in a large repository one can outlast MAX_GIT_WAIT, and they piled up.
 * A request meanwhile runs once more after it, as that status may predate the change.
 */
async function runStatus(projectId: string, root: string): Promise<void> {
  if (statusRunning.has(projectId)) {
    statusAgain.set(projectId, root);
    return;
  }
  statusRunning.add(projectId);
  const scope = pendingScope.get(projectId) ?? "all";
  pendingScope.delete(projectId);
  try {
    const status = await loadStatus(projectId, root, scope);
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
  } finally {
    statusRunning.delete(projectId);
    const again = statusAgain.get(projectId);
    statusAgain.delete(projectId);
    if (again !== undefined) void runStatus(projectId, again);
  }
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

/**
 * The paths a change needs git status for: the files it touched that git does
 * not ignore; everything after a change in `.git` (a commit, checkout, reset
 * moves what anything compares against) or when events were dropped.
 */
export function statusScope(projectId: string, change: FsChange): string[] | "all" {
  if (change.git || change.overflow) return "all";
  const view = useTree.getState().git[projectId];
  return change.files.filter((f) => !isIgnored(view, f));
}

export function handleFsChange(projectId: string, change: FsChange, nest: boolean): void {
  if (useTree.getState().packages[change.root] && (change.overflow || change.files.some((f) => /packages-lock\.json$|[\\/]PackageCache[\\/][^\\/]+$/.test(f))))
    void loadUnityPackages(change.root);
  if (change.overflow || change.dirs.length) void refreshDirs(change.root, change.overflow ? "all" : change.dirs, nest);
  if (affectsGit(projectId, change)) refreshGit(projectId, change.root, 300, statusScope(projectId, change));
}

export function setSelection(projectId: string, paths: string[], anchor?: string | null): void {
  useTree.setState((s) => ({
    selection: { ...s.selection, [projectId]: paths },
    anchor: anchor === undefined ? s.anchor : { ...s.anchor, [projectId]: anchor },
  }));
}
