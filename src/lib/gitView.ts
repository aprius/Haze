// Logic behind the Commit and Git tool windows that does not need React:
// change groups and their directory tree, multi-selection, branch folders,
// branch name validation and the interactive rebase todo.
import type { DiffSpec } from "./diffSpec";
import type { Branch, GitChange, RebaseStep } from "./ipc";
import { basename } from "./path";

export const GROUPS: { id: string; label: string; match: (c: GitChange) => boolean }[] = [
  { id: "conflicts", label: "Merge Conflicts", match: (c) => c.status === "conflict" },
  { id: "changes", label: "Changes", match: (c) => c.status !== "untracked" && c.status !== "conflict" },
  { id: "unversioned", label: "Unversioned Files", match: (c) => c.status === "untracked" },
];

export type ChangeRow =
  | { kind: "dir"; key: string; name: string; depth: number; files: GitChange[] }
  | { kind: "file"; change: GitChange; depth: number };

interface DirNode {
  dirs: Map<string, DirNode>;
  files: GitChange[];
}

/** The rows of one group: flat, or as a directory tree whose single-child folders are merged (src/components). */
export function changeRows(groupId: string, items: GitChange[], byDir: boolean, collapsed: Record<string, boolean>): ChangeRow[] {
  if (!byDir) return items.map((change) => ({ kind: "file", change, depth: 0 }));
  const root: DirNode = { dirs: new Map(), files: [] };
  for (const c of items) {
    let node = root;
    for (const part of c.rel.split("/").slice(0, -1)) {
      let next = node.dirs.get(part);
      if (!next) node.dirs.set(part, (next = { dirs: new Map(), files: [] }));
      node = next;
    }
    node.files.push(c);
  }
  const all = (n: DirNode): GitChange[] => [...[...n.dirs.values()].flatMap(all), ...n.files];
  const rows: ChangeRow[] = [];
  const walk = (node: DirNode, path: string, depth: number) => {
    for (const [first, start] of [...node.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      let name = first;
      let child = start;
      while (child.files.length === 0 && child.dirs.size === 1) {
        const [n, c] = [...child.dirs][0];
        name += "/" + n;
        child = c;
      }
      const dir = path ? `${path}/${name}` : name;
      const key = `${groupId}:${dir}`;
      rows.push({ kind: "dir", key, name, depth, files: all(child) });
      if (!collapsed[key]) walk(child, dir, depth + 1);
    }
    for (const change of [...node.files].sort((a, b) => basename(a.rel).localeCompare(basename(b.rel)))) rows.push({ kind: "file", change, depth });
  };
  walk(root, "", 0);
  return rows;
}

/** The file rows of every group in display order, for Shift ranges and arrow keys. */
export function shownFiles(changes: GitChange[], byDir: boolean, collapsed: Record<string, boolean>): GitChange[] {
  return GROUPS.flatMap((g) =>
    collapsed[g.id] ? [] : changeRows(g.id, changes.filter(g.match), byDir, collapsed).flatMap((row) => (row.kind === "file" ? [row.change] : [])),
  );
}

/** The diff of a local change against HEAD (nothing on the left for a new file). */
export function changeDiffSpec(root: string, c: GitChange): DiffSpec {
  const created = c.status === "untracked" || c.status === "added";
  return { root, rel: c.rel, oldRel: c.oldRel, left: created ? null : "HEAD", right: "working" };
}

/** Default ticks like Rider: tracked changes on, unversioned files and conflicts off. */
export function checkedPaths(r: { checked: string[] | null; changes: GitChange[] }): Set<string> {
  if (r.checked) return new Set(r.checked.filter((p) => r.changes.some((c) => c.rel === p)));
  return new Set(r.changes.filter((c) => c.status !== "untracked" && c.status !== "conflict").map((c) => c.rel));
}

export interface Picks {
  picked: Set<string>;
  anchor: string | null;
}

/**
 * Rows picked after clicking `rel`: Shift picks the range from the anchor,
 * Ctrl/Cmd toggles the row (starting from the shown file when nothing is
 * picked yet), a plain click picks only the row.
 */
export function pickRows(
  shown: readonly string[],
  cur: Picks,
  selected: string | null,
  rel: string,
  e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
): Picks {
  const a = cur.anchor === null ? -1 : shown.indexOf(cur.anchor);
  if (e.shiftKey && a >= 0) {
    const i = shown.indexOf(rel);
    return { picked: new Set(shown.slice(Math.min(a, i), Math.max(a, i) + 1)), anchor: cur.anchor };
  }
  if (e.ctrlKey || e.metaKey) {
    const next = new Set(cur.picked.size ? cur.picked : selected ? [selected] : []);
    if (next.has(rel)) next.delete(rel);
    else next.add(rel);
    return { picked: next, anchor: rel };
  }
  return { picked: new Set([rel]), anchor: rel };
}

/** Space on several picked rows: ticks them all, or unticks them if all are ticked. */
export function toggleChecks(checked: ReadonlySet<string>, rels: readonly string[]): Set<string> {
  const next = new Set(checked);
  const on = !rels.every((rel) => checked.has(rel));
  rels.forEach((rel) => (on ? next.add(rel) : next.delete(rel)));
  return next;
}

export interface BranchFolder {
  folders: Map<string, BranchFolder>;
  branches: Branch[];
}

/** Groups branches into folders by the slashes in their names (feature/x, origin/main). */
export function branchTree(list: Branch[]): BranchFolder {
  const root: BranchFolder = { folders: new Map(), branches: [] };
  for (const b of list) {
    const parts = b.name.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let next = node.folders.get(part);
      if (!next) node.folders.set(part, (next = { folders: new Map(), branches: [] }));
      node = next;
    }
    node.branches.push(b);
  }
  return root;
}

/** Why `v` cannot be a branch name, or `null` if it can. */
export const validBranch = (v: string) => (!v.trim() ? "Name cannot be empty" : /^-|[\s~^:?*[\\]|\.\.|@\{|\/$|\.lock$/.test(v.trim()) ? "Not a valid branch name" : null);

export interface RebaseRow {
  hash: string;
  subject: string;
  action: RebaseStep["action"];
  message: string;
}

/** Rows from `git log --reverse --format=%H%x1f%s%x1f%B%x1e`, all set to pick. */
export function parseRebaseLog(stdout: string): RebaseRow[] {
  return stdout
    .split("\u001e")
    .map((r) => r.replace(/^\n/, ""))
    .filter(Boolean)
    .map((r) => {
      const [hash, subject, body] = r.split("\u001f");
      return { hash, subject, action: "pick" as const, message: (body ?? subject).trim() };
    });
}

/** Why the rebase todo cannot run, or `null`. */
export function rebaseProblem(rows: readonly RebaseRow[] | null): string | null {
  const firstKept = rows?.find((r) => r.action !== "drop");
  if (!rows || !firstKept) return "Nothing to rebase";
  return firstKept.action === "squash" || firstKept.action === "fixup" ? "The first commit cannot be squashed or fixed up." : null;
}

/** `rows` with row `i` moved by `d` places, or `rows` itself when it cannot move. */
export function moveRow<T>(rows: T[], i: number, d: number): T[] {
  if (i + d < 0 || i + d >= rows.length) return rows;
  const next = [...rows];
  [next[i], next[i + d]] = [next[i + d], next[i]];
  return next;
}

/** The steps sent to git; only a reword carries a message. */
export const rebaseSteps = (rows: readonly RebaseRow[]): RebaseStep[] =>
  rows.map((r) => ({ action: r.action, hash: r.hash, message: r.action === "reword" ? r.message : null }));
