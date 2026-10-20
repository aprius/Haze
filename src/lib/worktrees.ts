// Parses `git worktree list --porcelain`.

export interface Worktree {
  path: string;
  branch: string | null;
  head: string;
  main: boolean;
}

export function parseWorktrees(out: string): Worktree[] {
  return out
    .split(/\r?\n\r?\n+/)
    .map((block) => {
      const get = (k: string) => block.split(/\r?\n/).find((l) => l.startsWith(k + " "))?.slice(k.length + 1) ?? null;
      const path = get("worktree");
      if (!path) return null;
      return { path, head: get("HEAD") ?? "", branch: get("branch")?.replace(/^refs\/heads\//, "") ?? null, main: false };
    })
    .filter((w): w is Worktree => !!w)
    .map((w, i) => ({ ...w, main: i === 0 }));
}
