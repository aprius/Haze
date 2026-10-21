// Three-way merge model for the merge window: non-conflicting changes from
// both sides are applied automatically; each conflict keeps the base text in
// the result until the user picks a side (like IntelliJ's merge tool).
import { diff3Merge } from "node-diff3";

export interface ConflictBlock {
  id: number;
  /** 0-based first line of the block in ours / theirs / base. */
  oursStart: number;
  theirsStart: number;
  ours: string[];
  theirs: string[];
  base: string[];
  /** 0-based first line of the block in the initial result, and its length there (base lines). */
  resultStart: number;
}

export interface MergeModel {
  eol: string;
  result: string;
  conflicts: ConflictBlock[];
}

function lines(text: string): string[] {
  return text.split(/\r?\n/);
}

export function detectEol(text: string): string {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

export function buildMerge(ours: string, base: string, theirs: string): MergeModel {
  const eol = detectEol(ours || theirs || base);
  const regions = diff3Merge(lines(ours), lines(base), lines(theirs), { excludeFalseConflicts: true });
  const out: string[] = [];
  const conflicts: ConflictBlock[] = [];
  for (const r of regions) {
    if (r.ok) {
      out.push(...r.ok);
    } else if (r.conflict) {
      const c = r.conflict;
      conflicts.push({
        id: conflicts.length,
        oursStart: c.aIndex,
        theirsStart: c.bIndex,
        ours: c.a,
        theirs: c.b,
        base: c.o,
        resultStart: out.length,
      });
      out.push(...c.o);
    }
  }
  return { eol, result: out.join(eol), conflicts };
}

/** Lines that replace a conflict for each choice. */
export function resolution(c: ConflictBlock, choice: "ours" | "theirs" | "both" | "base"): string[] {
  switch (choice) {
    case "ours":
      return c.ours;
    case "theirs":
      return c.theirs;
    case "both":
      return [...c.ours, ...c.theirs];
    default:
      return c.base;
  }
}

/** A text edit in Monaco coordinates (1-based lines and columns). */
export interface ResultEdit {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  text: string;
}

/**
 * The edit on the result that resolves conflict `c` with `choice`, where the
 * conflict currently spans lines `start..end` of `result` (its lines). With an
 * empty base the conflict holds no line of its own, so the chosen lines are
 * inserted before `start`.
 */
export function resolveEdit(c: ConflictBlock, choice: "ours" | "theirs" | "both", start: number, end: number, result: readonly string[], eol: string): ResultEdit {
  const chosen = resolution(c, choice);
  const text = chosen.join(eol);
  const edit = (startLine: number, startColumn: number, endLine: number, endColumn: number, text: string) => ({ startLine, startColumn, endLine, endColumn, text });
  if (c.base.length === 0) return edit(start, 1, start, 1, text ? text + eol : "");
  const endColumn = (result[end - 1] ?? "").length + 1;
  if (chosen.length === 0) return end < result.length ? edit(start, 1, end + 1, 1, "") : edit(start, 1, end, endColumn, "");
  return edit(start, 1, end, endColumn, text);
}
