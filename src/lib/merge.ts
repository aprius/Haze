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
 * Where conflict `c` sits in the initial result (its lines): its base lines,
 * or with an empty base the line it goes before. An empty base after the last
 * line (no final newline) is marked by the end of the last line instead.
 */
export function conflictRange(c: ConflictBlock, result: readonly string[]): ResultEdit {
  const n = Math.max(1, result.length);
  if (c.base.length === 0 && c.resultStart >= n) {
    const end = (result[n - 1] ?? "").length + 1;
    return { startLine: n, startColumn: end, endLine: n, endColumn: end, text: "" };
  }
  return { startLine: c.resultStart + 1, startColumn: 1, endLine: c.resultStart + Math.max(1, c.base.length), endColumn: 1, text: "" };
}

/**
 * The edit on the result that resolves conflict `c` with `choice`, where the
 * conflict currently spans lines `start..end` of `result` (its lines). With an
 * empty base the conflict holds no line of its own, so the chosen lines are
 * inserted before `start`, or after the last line when `start` is past it.
 */
export function resolveEdit(c: ConflictBlock, choice: "ours" | "theirs" | "both", start: number, end: number, result: readonly string[], eol: string): ResultEdit {
  return replaceBlock(c.base.length, resolution(c, choice), start, end, result, eol);
}

/**
 * The edit that replaces a block of `held` lines at `start..end` of `result`
 * (1-based) with `chosen`. A block of no lines sits before line `start`, or
 * after the last line when `start` is past it.
 */
export function replaceBlock(held: number, chosen: readonly string[], start: number, end: number, result: readonly string[], eol: string): ResultEdit {
  const text = chosen.join(eol);
  const edit = (startLine: number, startColumn: number, endLine: number, endColumn: number, text: string) => ({ startLine, startColumn, endLine, endColumn, text });
  if (held === 0) {
    if (chosen.length === 0) return edit(start, 1, start, 1, "");
    if (start <= result.length) return edit(start, 1, start, 1, text + eol);
    const n = Math.max(1, result.length);
    const endOfFile = (result[n - 1] ?? "").length + 1;
    return edit(n, endOfFile, n, endOfFile, eol + text);
  }
  const endColumn = (result[end - 1] ?? "").length + 1;
  if (chosen.length === 0) {
    if (end < result.length) return edit(start, 1, end + 1, 1, "");
    // The last lines: take the line break before them too.
    if (start > 1) return edit(start - 1, (result[start - 2] ?? "").length + 1, end, endColumn, "");
    return edit(start, 1, end, endColumn, "");
  }
  return edit(start, 1, end, endColumn, text);
}

/** One side of a conflict in the merge window: not handled yet, applied to the result, or ignored. */
export type SideState = "pending" | "applied" | "ignored";

export interface ConflictState {
  ours: SideState;
  theirs: SideState;
  /** The applied sides, in the order they were applied. */
  order: ("ours" | "theirs")[];
}

export const pendingState = (): ConflictState => ({ ours: "pending", theirs: "pending", order: [] });

/** The lines conflict `c` holds in the result in state `s`: the applied sides in order, else the base. */
export function stateLines(c: ConflictBlock, s: ConflictState): string[] {
  return s.order.length ? s.order.flatMap((side) => (side === "ours" ? c.ours : c.theirs)) : c.base;
}

/** `s` after applying (`»`/`«`) or ignoring (`×`) one side, as in Rider's merge tool. */
export function actOnSide(s: ConflictState, side: "ours" | "theirs", act: "apply" | "ignore"): ConflictState {
  if (s[side] !== "pending") return s;
  return { ...s, [side]: act === "apply" ? "applied" : "ignored", order: act === "apply" ? [...s.order, side] : s.order };
}

export const isResolved = (s: ConflictState): boolean => s.ours !== "pending" && s.theirs !== "pending";
