// Git state per project for the Commit and Git tool windows: repository
// root, local changes, branches, stashes, and a console of commands run.
import { create } from "zustand";
import { toast } from "../components/Overlays";
import { api, errorMessage, type BranchesInfo, type ChangedFile, type Checkpoint, type GitChange, type GitOutput, type StashEntry } from "../lib/ipc";
import { onGitStatus, refreshGit as refreshTreeGit } from "./tree";
import { openCommitWindow, useUi } from "./ui";
import { useWorkspace } from "./workspace";

export interface ConsoleEntry {
  time: number;
  args: string[];
  output: GitOutput | null;
  error?: string;
}

export interface RepoState {
  root: string | null;
  changes: GitChange[];
  branches: BranchesInfo | null;
  stashes: StashEntry[];
  /** Rel paths ticked in the Commit window; `null` = default selection. */
  checked: string[] | null;
  message: string;
  amend: boolean;
  busy: string | null;
  console: ConsoleEntry[];
  /** Bumped after any operation, so the log reloads. */
  revision: number;
  /** Files marked reviewed: rel → content fingerprint when marked (dropped once the file changes). */
  reviewed: Record<string, string>;
  checkpoints: Checkpoint[];
  /** Checkpoint whose changes are listed ("Since checkpoint"), if any. */
  checkpoint: string | null;
  since: ChangedFile[];
}

const empty = (): RepoState => ({
  root: null,
  changes: [],
  branches: null,
  stashes: [],
  checked: null,
  message: "",
  amend: false,
  busy: null,
  console: [],
  revision: 0,
  reviewed: {},
  checkpoints: [],
  checkpoint: null,
  since: [],
});

export const useGit = create<{ repos: Record<string, RepoState> }>(() => ({ repos: {} }));

export function repo(projectId: string): RepoState {
  return useGit.getState().repos[projectId] ?? empty();
}

export function patchRepo(projectId: string, patch: Partial<RepoState> | ((r: RepoState) => Partial<RepoState>)): void {
  useGit.setState((s) => {
    const cur = s.repos[projectId] ?? empty();
    const p = typeof patch === "function" ? patch(cur) : patch;
    return { repos: { ...s.repos, [projectId]: { ...cur, ...p } } };
  });
}

/** Absolute path of a repository-relative path. */
export function absPath(root: string, rel: string): string {
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return root.replace(/[\\/]+$/, "") + sep + (sep === "\\" ? rel.replace(/\//g, "\\") : rel);
}

// Changes come from the file tree's `git status` (one run serves both).
onGitStatus((projectId, status) => {
  if (status.isRepo) patchRepo(projectId, { changes: status.changes });
});

const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** Projects with a refresh requested by an operation (not the watcher) still to run. */
const explicit = new Set<string>();

function commitWindowShown(projectId: string): boolean {
  return useWorkspace.getState().activeProjectId === projectId && useUi.getState().commitWindow === projectId;
}

/** What `git log --all` shows depends only on these; editing files changes none of them. */
const historyKeys = new Map<string, string>();

function historyKey(branches: BranchesInfo | null, stashes: StashEntry[], checkpoints: Checkpoint[]): string {
  return [
    branches?.head ?? "",
    ...(branches?.branches ?? []).map((b) => `${b.refname}=${b.hash}`),
    ...stashes.map((s) => s.hash),
    ...checkpoints.map((c) => c.hash),
  ].join("\n");
}

/**
 * Reloads changes, branches and stashes (debounced when `delay` > 0). The log
 * reloads too (`revision`), except after a watcher refresh that left the
 * history as it was: an agent editing files would reload it constantly.
 */
export function refreshRepo(projectId: string, projectPath: string, delay = 0, fromWatcher = false): void {
  if (!fromWatcher) explicit.add(projectId);
  refreshTreeGit(projectId, projectPath, delay);
  const t = timers.get(projectId);
  if (t) clearTimeout(t);
  timers.set(
    projectId,
    setTimeout(async () => {
      timers.delete(projectId);
      const force = explicit.delete(projectId);
      let root = repo(projectId).root;
      if (!root) {
        root = await api.gitToplevel(projectPath).catch(() => null);
        if (!root) return;
        patchRepo(projectId, { root });
      }
      const cur = repo(projectId);
      const reviewedRels = Object.keys(cur.reviewed);
      const [branches, stashes, checkpoints, prints] = await Promise.all([
        api.gitBranches(root).catch(() => cur.branches),
        api.gitStashes(root).catch(() => cur.stashes),
        api.gitCheckpoints(root).catch(() => cur.checkpoints),
        reviewedRels.length ? api.gitFingerprints(root, reviewedRels).catch(() => []) : Promise.resolve([]),
      ]);
      const checkpoint = cur.checkpoint && checkpoints.some((c) => c.hash === cur.checkpoint) ? cur.checkpoint : (checkpoints[0]?.hash ?? null);
      // Diffing against a checkpoint snapshots the whole working tree (`git add -A`
      // into a scratch index); only the Commit window shows it, and opening it refreshes.
      const since = !checkpoint ? [] : commitWindowShown(projectId) ? await api.gitChangesSince(root, checkpoint).catch(() => []) : cur.since;
      // A reviewed mark only holds while the file is unchanged since marking it.
      const reviewed: Record<string, string> = {};
      reviewedRels.forEach((rel, i) => {
        if ((prints[i] ?? "missing") === cur.reviewed[rel]) reviewed[rel] = cur.reviewed[rel];
      });
      const key = historyKey(branches, stashes, checkpoints);
      const moved = historyKeys.get(projectId) !== key;
      historyKeys.set(projectId, key);
      patchRepo(projectId, (r) => ({
        branches,
        stashes,
        checkpoints,
        checkpoint,
        since,
        reviewed,
        revision: force || moved ? r.revision + 1 : r.revision,
      }));
    }, delay),
  );
}

/** Default ticks like Rider: tracked changes on, unversioned files off. */
export function checkedPaths(r: RepoState): Set<string> {
  if (r.checked) return new Set(r.checked.filter((p) => r.changes.some((c) => c.rel === p)));
  return new Set(r.changes.filter((c) => c.status !== "untracked" && c.status !== "conflict").map((c) => c.rel));
}

/** Runs git and records it in the console; failures become an error toast. */
export async function runGit(projectId: string, args: string[], opts: { label?: string; quiet?: boolean } = {}): Promise<GitOutput | null> {
  const r = repo(projectId);
  const project = useWorkspace.getState().projects.find((p) => p.id === projectId);
  if (!r.root || !project) return null;
  const entry: ConsoleEntry = { time: Date.now(), args, output: null };
  patchRepo(projectId, (s) => ({ busy: opts.label ?? `git ${args[0]}`, console: [...s.console.slice(-199), entry] }));
  try {
    const out = await api.gitRun(r.root, args);
    entry.output = out;
    if (/^CONFLICT|Merge conflict in|could not apply/m.test(out.stdout + out.stderr)) {
      // Rider opens the conflicts list; ours is the Commit window's "Merge Conflicts" group.
      openCommitWindow(projectId);
      toast("Conflicts need to be resolved — see Merge Conflicts in the Commit window (double-click to merge).", "error");
    } else if (!out.ok) toast(`${opts.label ?? "git " + args[0]} failed: ${(out.stderr || out.stdout).trim().split("\n").slice(-3).join(" ")}`, "error");
    else if (!opts.quiet && opts.label) toast(`${opts.label}: done`);
    return out;
  } catch (e) {
    entry.error = errorMessage(e);
    toast(errorMessage(e), "error");
    return null;
  } finally {
    patchRepo(projectId, (s) => ({ busy: null, console: [...s.console] }));
    refreshRepo(projectId, project.path);
    refreshTreeGit(projectId, project.path, 0);
  }
}

export async function toggleReviewed(projectId: string, rel: string): Promise<void> {
  const r = repo(projectId);
  if (!r.root) return;
  if (r.reviewed[rel]) {
    patchRepo(projectId, (s) => {
      const reviewed = { ...s.reviewed };
      delete reviewed[rel];
      return { reviewed };
    });
    return;
  }
  const [print] = await api.gitFingerprints(r.root, [rel]);
  patchRepo(projectId, (s) => ({ reviewed: { ...s.reviewed, [rel]: print ?? "missing" } }));
}

/** Snapshots the working tree so an agent's edits can be reviewed afterwards. */
export async function createCheckpoint(projectId: string, projectPath: string): Promise<void> {
  const r = repo(projectId);
  if (!r.root) return;
  try {
    const label = new Date().toLocaleString();
    const hash = await api.gitCheckpoint(r.root, label);
    patchRepo(projectId, { checkpoint: hash, reviewed: {} });
    toast(`Checkpoint created (${label}). Changes made after it appear under "Since checkpoint".`);
  } catch (e) {
    toast(`Checkpoint failed: ${errorMessage(e)}`, "error");
  }
  refreshRepo(projectId, projectPath);
}
