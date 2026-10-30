// The Editors tool window: which copy of a Unity project (the project, a
// worktree, a clone next to it) a terminal works in.

const trim = (p: string) => p.replace(/[\\/]+$/, "");

/** The root `path` is in (the deepest, as a worktree may sit inside the project's folder), if any. */
export function copyOfPath(path: string, roots: string[]): string | null {
  const p = trim(path);
  let best: string | null = null;
  for (const root of roots) {
    const r = trim(root);
    const inside = p === r || p.startsWith(r + "/") || p.startsWith(r + "\\");
    if (inside && (!best || r.length > trim(best).length)) best = root;
  }
  return best;
}
