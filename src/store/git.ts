// Git state per project for the Commit and Git tool windows: repository
// root, local changes, branches, stashes, and a console of commands run.
import { create } from "zustand";
import { isAuthFailure } from "../components/GitAccounts";
import { openConflictsDialog } from "../components/ConflictsDialog";
import { toast } from "../components/Overlays";
import { openSettings } from "../components/SettingsDialog";
import { saveAll } from "../components/EditorArea";
import { dirtyPaths, useBuffers } from "../lib/buffers";
import { pickCheckpoint, withUnsaved } from "../lib/gitView";
import { api, errorMessage, type BranchesInfo, type ChangedFile, type Checkpoint, type GitChange, type GitOutput, type StashEntry } from "../lib/ipc";
import { isWithin, relative } from "../lib/path";
import { withTask } from "./tasks";
import { cappedDelay, isIgnored, onGitStatus, refreshGit as refreshTreeGit, useTree } from "./tree";
import { useUi } from "./ui";
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

/** Changes as `git status` last reported them, before unsaved files are added. */
const gitChanges = new Map<string, { root: string; changes: GitChange[] }>();

/** Files with unsaved edits in the repository, as relative paths (ignored files left out). */
function unsavedIn(projectId: string, root: string): string[] {
  const view = useTree.getState().git[projectId];
  return dirtyPaths()
    .filter((p) => isWithin(p, root) && !isIgnored(view, p))
    .map((p) => relative(root, p));
}

function showChanges(projectId: string): void {
  const g = gitChanges.get(projectId);
  if (g) patchRepo(projectId, { changes: withUnsaved(g.changes, unsavedIn(projectId, g.root)) });
}

// Changes come from the file tree's `git status` (one run serves both).
onGitStatus((projectId, status) => {
  if (!status.isRepo || !status.root) return;
  gitChanges.set(projectId, { root: status.root, changes: status.changes });
  showChanges(projectId);
});

// A file counts as changed as soon as it is edited, saved or not.
let dirtyKey = "";
useBuffers.subscribe(() => {
  const key = dirtyPaths().sort().join("\n");
  if (key === dirtyKey) return;
  dirtyKey = key;
  gitChanges.forEach((_, projectId) => showChanges(projectId));
});

/** Git commands that read or write the working tree: unsaved edits are saved first. */
const touchesFiles = new Set(["stash", "checkout", "switch", "merge", "rebase", "cherry-pick", "revert", "reset", "pull", "add", "rm", "restore"]);

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const waitingSince = new Map<string, number>();
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

/** Projects whose branches, stashes and checkpoints the pending refresh reloads. */
const refsDirty = new Set<string>();
/** Projects with a refresh running; one asked for meanwhile runs after it (`rerun`). */
const running = new Set<string>();
const rerun = new Map<string, string>();

/**
 * Reloads changes, branches and stashes (debounced when `delay` > 0). The log
 * reloads too (`revision`), except after a watcher refresh that left the
 * history as it was: an agent editing files would reload it constantly.
 * Like Rider, a watcher refresh for edits in the working tree (`gitChanged`
 * false) leaves branches, stashes and checkpoints alone: only files in `.git`
 * change them.
 */
export function refreshRepo(projectId: string, projectPath: string, delay = 0, fromWatcher = false, gitChanged = true): void {
  if (!fromWatcher) explicit.add(projectId);
  if (!fromWatcher || gitChanged) refsDirty.add(projectId);
  // The watcher's change has asked for its own (scoped) status already, see handleFsChange.
  if (!fromWatcher) refreshTreeGit(projectId, projectPath, delay);
  const t = timers.get(projectId);
  if (t) clearTimeout(t);
  timers.set(
    projectId,
    setTimeout(() => {
      timers.delete(projectId);
      waitingSince.delete(projectId);
      void runRefresh(projectId, projectPath);
    }, cappedDelay(waitingSince, projectId, delay)),
  );
}

async function runRefresh(projectId: string, projectPath: string): Promise<void> {
  if (running.has(projectId)) {
    rerun.set(projectId, projectPath);
    return;
  }
  running.add(projectId);
  try {
    await reload(projectId, projectPath);
  } finally {
    running.delete(projectId);
    const again = rerun.get(projectId);
    rerun.delete(projectId);
    if (again !== undefined) void runRefresh(projectId, again);
  }
}

async function reload(projectId: string, projectPath: string): Promise<void> {
  const force = explicit.delete(projectId);
  let root = repo(projectId).root;
  if (!root) {
    root = await api.gitToplevel(projectPath).catch(() => null);
    if (!root) return;
    patchRepo(projectId, { root });
  }
  const cur = repo(projectId);
  const refs = refsDirty.delete(projectId) || !cur.branches;
  // Failed (a lock, a rebase midway): the next refresh asks again, whatever started it.
  const retry = <T>(fallback: T) => () => {
    refsDirty.add(projectId);
    return fallback;
  };
  const reviewedRels = Object.keys(cur.reviewed);
  const [branches, stashes, checkpoints, prints] = await Promise.all([
    refs ? api.gitBranches(root).catch(retry(cur.branches)) : cur.branches,
    refs ? api.gitStashes(root).catch(retry(cur.stashes)) : cur.stashes,
    refs ? api.gitCheckpoints(root).catch(retry(cur.checkpoints)) : cur.checkpoints,
    reviewedRels.length ? api.gitFingerprints(root, reviewedRels).catch(() => []) : Promise.resolve([]),
  ]);
  const checkpoint = pickCheckpoint(cur.checkpoint, checkpoints);
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
}

export { checkedPaths } from "../lib/gitView";

async function headOf(root: string): Promise<string> {
  const o = await api.gitRun(root, ["rev-parse", "HEAD"]).catch(() => null);
  return o?.ok ? o.stdout.trim() : "";
}

/** Rider-style pull summary: commits received, files updated, and whether a merge commit was made. */
async function describePull(root: string, before: string, stdout: string): Promise<string | null> {
  const after = await headOf(root);
  if (!after || after === before) return /up to date/i.test(stdout) ? "Pull: already up to date" : null;
  const count = async (range: string) => {
    const o = await api.gitRun(root, ["rev-list", "--count", range]).catch(() => null);
    return o?.ok ? parseInt(o.stdout.trim(), 10) || 0 : 0;
  };
  const parents = await api.gitRun(root, ["rev-list", "--parents", "-n", "1", after]).catch(() => null);
  const merged = (parents?.stdout.trim().split(" ").length ?? 0) > 2 && (await count(`${before}..${after}^1`)) === 0;
  // A merge commit's second parent holds what came in; otherwise everything since `before` did.
  const received = await count(merged ? `${before}..${after}^2` : `${before}..${after}`);
  const files = /(\d+) files? changed/.exec(stdout)?.[1];
  const parts = [`${received} commit${received === 1 ? "" : "s"} received`];
  if (files) parts.push(`${files} file${files === "1" ? "" : "s"} updated`);
  return `Pull successful: ${parts.join(", ")}${merged ? " — merge commit created" : ""}`;
}

/** Runs git and records it in the console; failures become an error toast. */
export async function runGit(projectId: string, args: string[], opts: { label?: string; quiet?: boolean } = {}): Promise<GitOutput | null> {
  const r = repo(projectId);
  const project = useWorkspace.getState().projects.find((p) => p.id === projectId);
  if (!r.root || !project) return null;
  if (touchesFiles.has(args[0])) await saveAll();
  const entry: ConsoleEntry = { time: Date.now(), args, output: null };
  const label = opts.label ?? `git ${args[0]}`;
  patchRepo(projectId, (s) => ({ busy: label, console: [...s.console.slice(-199), entry] }));
  try {
    const before = args[0] === "pull" ? await headOf(r.root) : null;
    const out = await withTask(projectId, label, () => api.gitRun(r.root!, args));
    entry.output = out;
    const pulled = out.ok && before ? await describePull(r.root, before, out.stdout) : null;
    if (/^CONFLICT|Merge conflict in|could not apply/m.test(out.stdout + out.stderr)) {
      // Rider's Conflicts popup; the Commit window's "Merge Conflicts" group keeps the list.
      openConflictsDialog(projectId);
    } else if (!out.ok && isAuthFailure(out.stderr + out.stdout))
      // Offer to log in when the remote rejects the credentials.
      toast(`${opts.label ?? "git " + args[0]} failed: the remote needs you to log in. Add a GitHub/GitLab account in Settings.`, "error", {
        label: "Log In…",
        run: () => openSettings("vcs"),
      });
    else if (!out.ok) toast(`${opts.label ?? "git " + args[0]} failed: ${(out.stderr || out.stdout).trim().split("\n").slice(-3).join(" ")}`, "error");
    else if (pulled) toast(pulled);
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
    const hash = await withTask(projectId, "Creating checkpoint", () => api.gitCheckpoint(r.root!, label));
    patchRepo(projectId, { checkpoint: hash, reviewed: {} });
    toast(`Checkpoint created (${label}). Changes made after it appear under "Since checkpoint".`);
  } catch (e) {
    toast(`Checkpoint failed: ${errorMessage(e)}`, "error");
  }
  refreshRepo(projectId, projectPath);
}
