// Git state per project for the Commit and Git tool windows: repository
// root, local changes, branches, stashes, and a console of commands run.
import { create } from "zustand";
import { toast } from "../components/Overlays";
import { api, errorMessage, type BranchesInfo, type GitChange, type GitOutput, type StashEntry } from "../lib/ipc";
import { refreshGit as refreshTreeGit } from "./tree";
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

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Reloads changes, branches and stashes (debounced when `delay` > 0). */
export function refreshRepo(projectId: string, projectPath: string, delay = 0): void {
  const t = timers.get(projectId);
  if (t) clearTimeout(t);
  timers.set(
    projectId,
    setTimeout(async () => {
      timers.delete(projectId);
      let root = repo(projectId).root;
      if (!root) {
        root = await api.gitToplevel(projectPath).catch(() => null);
        if (!root) return;
        patchRepo(projectId, { root });
      }
      const [changes, branches, stashes] = await Promise.all([
        api.gitChanges(root).catch(() => repo(projectId).changes),
        api.gitBranches(root).catch(() => repo(projectId).branches),
        api.gitStashes(root).catch(() => repo(projectId).stashes),
      ]);
      patchRepo(projectId, (r) => ({ changes, branches, stashes, revision: r.revision + 1 }));
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
    if (!out.ok) toast(`${opts.label ?? "git " + args[0]} failed: ${(out.stderr || out.stdout).trim().split("\n").slice(-3).join(" ")}`, "error");
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
