// Three-way merge model for the merge window, as IntelliJ's (MergeConflictModel):
// the result starts as the base; every stretch either side changed is a
// change with a state per side, applied (» / «) or ignored (×). A change is
// resolved once both sides are handled. Non-conflicting changes are applied
// only on request (or with auto-apply on), as in Rider.
import { diff3Changes, diff3Merge, diffLines } from "./lineDiff";

export type Side = "ours" | "theirs";

export interface MergeChange {
  id: number;
  /** Both sides changed it, differently. */
  conflict: boolean;
  oursChanged: boolean;
  theirsChanged: boolean;
  /** Line boundaries (0 = above line 1) of the change in each version. */
  oursStart: number;
  oursEnd: number;
  baseStart: number;
  baseEnd: number;
  theirsStart: number;
  theirsEnd: number;
  ours: string[];
  base: string[];
  theirs: string[];
  /** For a conflict, its word-level merge when the sides changed different words ("simple" conflict, the magic wand). */
  autoResolved: string[] | null;
}

export interface MergeModel {
  eol: string;
  /** The result as it starts: the base. */
  result: string;
  changes: MergeChange[];
}

function lines(text: string): string[] {
  return text.split(/\r?\n/);
}

export function detectEol(text: string): string {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

const TOKEN = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;
const tokens = (text: string) => text.match(TOKEN) ?? [];

/**
 * A conflict's lines merged word by word (IntelliJ's "simple conflict"
 * resolution): null when the sides change the same words. Big blocks are left
 * alone, as a word merge of them would be slow and rarely what one wants.
 */
export function mergeWords(ours: readonly string[], base: readonly string[], theirs: readonly string[]): string[] | null {
  if (ours.length + base.length + theirs.length > 300) return null;
  const regions = diff3Merge(tokens(ours.join("\n")), tokens(base.join("\n")), tokens(theirs.join("\n")));
  if (regions.some((r) => "conflict" in r)) return null;
  const text = regions.flatMap((r) => ("ok" in r ? r.ok : [])).join("");
  return text.split("\n");
}

export function buildMerge(ours: string, base: string, theirs: string): MergeModel {
  const eol = detectEol(ours || theirs || base);
  const [a, o, b] = [lines(ours), lines(base), lines(theirs)];
  const changes = diff3Changes(a, o, b).map((c, id): MergeChange => {
    const change = {
      id,
      conflict: c.conflict,
      oursChanged: c.aChanged,
      theirsChanged: c.bChanged,
      oursStart: c.aStart,
      oursEnd: c.aEnd,
      baseStart: c.oStart,
      baseEnd: c.oEnd,
      theirsStart: c.bStart,
      theirsEnd: c.bEnd,
      ours: a.slice(c.aStart, c.aEnd),
      base: o.slice(c.oStart, c.oEnd),
      theirs: b.slice(c.bStart, c.bEnd),
      autoResolved: null as string[] | null,
    };
    if (c.conflict) change.autoResolved = mergeWords(change.ours, change.base, change.theirs);
    return change;
  });
  return { eol, result: base, changes };
}

export const changedOn = (c: MergeChange, side: Side) => (side === "ours" ? c.oursChanged : c.theirsChanged);
export const sideLines = (c: MergeChange, side: Side) => (side === "ours" ? c.ours : c.theirs);
export const sideStart = (c: MergeChange, side: Side) => (side === "ours" ? c.oursStart : c.theirsStart);
export const sideEnd = (c: MergeChange, side: Side) => (side === "ours" ? c.oursEnd : c.theirsEnd);
const other = (side: Side): Side => (side === "ours" ? "theirs" : "ours");

/** How a side's lines differ from the base's in a change: lines added, removed or changed. */
export function changeKind(c: MergeChange, side: Side): "added" | "deleted" | "modified" {
  return c.base.length === 0 ? "added" : sideLines(c, side).length === 0 ? "deleted" : "modified";
}

/**
 * Where a change sits in the result as it starts (the base): its base lines,
 * or with no base line the line it goes before. One after the last line (no
 * final newline) is marked by the end of the last line instead.
 */
export function initialMark(c: MergeChange, result: readonly string[]): BlockMark & { endColumn: number } {
  const n = Math.max(1, result.length);
  const empty = c.base.length === 0;
  if (empty && c.baseStart >= n) {
    const end = (result[n - 1] ?? "").length + 1;
    return { startLine: n, startColumn: end, endLine: n, endColumn: end, empty };
  }
  return { startLine: c.baseStart + 1, startColumn: 1, endLine: c.baseStart + Math.max(1, c.base.length), endColumn: 1, empty };
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

/**
 * Where a change sits in the result: lines `startLine..endLine` (1-based),
 * or with `empty` no line, before `startLine`; an empty block after the last
 * line is marked by the end of that line (`startColumn > 1`).
 */
export interface BlockMark {
  startLine: number;
  startColumn: number;
  endLine: number;
  empty: boolean;
}

/** The edit that makes a block hold `lines`, and where the block is afterwards (`result` is before the edit). */
export function rewriteBlock(mark: BlockMark, lines: readonly string[], result: readonly string[], eol: string): { edit: ResultEdit; mark: BlockMark & { endColumn: number } } {
  const start = mark.empty && mark.startColumn > 1 ? mark.startLine + 1 : mark.startLine;
  const held = mark.empty ? 0 : mark.endLine - mark.startLine + 1;
  const edit = replaceBlock(held, lines, start, mark.endLine, result, eol);
  // Lines after the edit: this block's change in length shifts the end of the file.
  const count = result.length - held + lines.length;
  if (lines.length > 0) return { edit, mark: { startLine: start, startColumn: 1, endLine: start + lines.length - 1, endColumn: 1, empty: false } };
  if (start <= count) return { edit, mark: { startLine: start, startColumn: 1, endLine: start, endColumn: 1, empty: true } };
  const last = Math.max(1, count);
  // The text of the new last line: the line before the block, unchanged by the edit.
  const end = (result[last - 1] ?? "").length + 1;
  return { edit, mark: { startLine: last, startColumn: end, endLine: last, endColumn: end, empty: true } };
}

/** One side of a change in the merge window: not handled yet, applied to the result, or ignored. */
export type SideState = "pending" | "applied" | "ignored";

export interface ChangeState {
  ours: SideState;
  theirs: SideState;
  /** The applied sides, in the order they were applied. */
  order: Side[];
  /** A conflict with one side applied: applying the other appends it (IntelliJ's isOnesideAppliedConflict). */
  oneside: boolean;
  /** Lines from the magic wand, in place of the sides. */
  custom?: string[];
}

export const pendingState = (): ChangeState => ({ ours: "pending", theirs: "pending", order: [], oneside: false });

export const isResolved = (s: ChangeState): boolean => s.ours !== "pending" && s.theirs !== "pending";

/** The lines change `c` holds in the result in state `s`: the applied sides in order, else the base. */
export function stateLines(c: MergeChange, s: ChangeState): string[] {
  if (s.custom) return s.custom;
  return s.order.length ? s.order.flatMap((side) => sideLines(c, side)) : c.base;
}

/** Both sides handled, with nothing applied that was not. */
const resolve = (s: ChangeState): ChangeState => ({
  ...s,
  ours: s.ours === "pending" ? "ignored" : s.ours,
  theirs: s.theirs === "pending" ? "ignored" : s.theirs,
  oneside: false,
});

/**
 * `»` / `«` (MergeConflictModel.replaceChange): a non-conflicting change is
 * taken and resolved. A conflict's first side replaces the block and leaves
 * the other side open; the second appends. With Ctrl (`resolve`), or when the
 * other side has no lines, the first side resolves the conflict at once.
 */
export function applySide(c: MergeChange, s: ChangeState, side: Side, resolveAll = false): ChangeState {
  if (s[side] !== "pending") return s;
  if (!changedOn(c, side)) return resolve(s);
  if (!c.conflict) return resolve({ ...s, [side]: "applied", order: [side] });
  if (s.oneside) return resolve({ ...s, [side]: "applied", order: [...s.order, side] });
  const next: ChangeState = { ...s, [side]: "applied", order: [side], oneside: s[other(side)] === "pending" };
  return resolveAll || sideLines(c, other(side)).length === 0 ? resolve(next) : next;
}

/**
 * `×` (MergeConflictModel.ignoreChange): the result keeps what it has. A
 * conflict's side is ignored alone; a non-conflicting change, or with Ctrl, is resolved.
 */
export function ignoreSide(c: MergeChange, s: ChangeState, side: Side, resolveAll = false): ChangeState {
  if (s[side] !== "pending") return s;
  if (!c.conflict || resolveAll) return resolve(s);
  return { ...s, [side]: "ignored", oneside: false };
}

/** Accept Left / Accept Right: every change as that side has it, resolved. */
export function acceptState(c: MergeChange, side: Side): ChangeState {
  return { ours: side === "ours" ? "applied" : "ignored", theirs: side === "theirs" ? "applied" : "ignored", order: changedOn(c, side) ? [side] : [], oneside: false };
}

/** The magic wand: a simple conflict merged word by word. */
export function autoState(c: MergeChange): ChangeState | null {
  return c.autoResolved ? { ours: "applied", theirs: "applied", order: ["ours", "theirs"], oneside: false, custom: c.autoResolved } : null;
}

/**
 * Words of `side` that differ from `base` (for the word highlights), as
 * 1-based line and column ranges in `side`; empty for big blocks.
 */
export function changedWords(side: readonly string[], base: readonly string[]): { line: number; start: number; end: number }[] {
  if (side.length + base.length > 200) return [];
  const st = tokens(side.join("\n"));
  const out: { line: number; start: number; end: number }[] = [];
  // Line and column of each token of the side.
  const pos: [number, number][] = [];
  let line = 1;
  let col = 1;
  for (const t of st) {
    pos.push([line, col]);
    for (const ch of t) {
      if (ch === "\n") (line++, (col = 1));
      else col++;
    }
  }
  pos.push([line, col]);
  for (const h of diffLines(tokens(base.join("\n")), st)) {
    for (let i = h.abStart; i < h.abStart + h.abLength; i++) {
      if (/^\s+$/.test(st[i])) continue;
      const [l, c] = pos[i];
      out.push({ line: l, start: c, end: c + st[i].length });
    }
  }
  return out;
}
