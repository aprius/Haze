// "Reformat changed lines on save", like Rider's: only the lines that differ
// from the committed file are formatted, so a save never reformats code you did
// not touch (and the diff stays about your change).
import { lineChanges } from "./lineChanges";

/** 1-based, inclusive. */
export interface LineRange {
  start: number;
  end: number;
}

/**
 * Lines to format: those added or modified since `base` (the committed text),
 * neighbours merged. `base === null` (the file is not in Git) = the whole file.
 */
export function changedRanges(base: string | null, current: string, lineCount: number): LineRange[] {
  if (base === null) return lineCount > 0 ? [{ start: 1, end: lineCount }] : [];
  const out: LineRange[] = [];
  for (const c of lineChanges(base, current)) {
    if (c.kind === "deleted") continue;
    const last = out[out.length - 1];
    if (last && c.start <= last.end + 1) last.end = Math.max(last.end, c.end);
    else out.push({ start: c.start, end: c.end });
  }
  return out;
}

/** A text edit in Monaco's coordinates (1-based lines and columns). */
export interface RangeEdit {
  range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
  text: string;
}

const before = (a: RangeEdit["range"], line: number, col: number) => a.endLineNumber < line || (a.endLineNumber === line && a.endColumn <= col);

/**
 * Edits for several ranges, computed on the same text, as one set to apply:
 * sorted, exact duplicates dropped (ranges that touch can return the same
 * whitespace fix), and any edit that overlaps one kept before it left out.
 */
export function mergeEdits(edits: readonly RangeEdit[]): RangeEdit[] {
  const sorted = [...edits].sort(
    (a, b) =>
      a.range.startLineNumber - b.range.startLineNumber ||
      a.range.startColumn - b.range.startColumn ||
      a.range.endLineNumber - b.range.endLineNumber ||
      a.range.endColumn - b.range.endColumn,
  );
  const out: RangeEdit[] = [];
  for (const e of sorted) {
    const last = out[out.length - 1];
    if (last) {
      const same =
        last.text === e.text &&
        last.range.startLineNumber === e.range.startLineNumber &&
        last.range.startColumn === e.range.startColumn &&
        last.range.endLineNumber === e.range.endLineNumber &&
        last.range.endColumn === e.range.endColumn;
      if (same) continue;
      // Two insertions at one point both apply; anything else must start where the last ended or after.
      const empty = (r: RangeEdit["range"]) => r.startLineNumber === r.endLineNumber && r.startColumn === r.endColumn;
      if (!before(last.range, e.range.startLineNumber, e.range.startColumn) && !(empty(last.range) && empty(e.range))) continue;
    }
    out.push(e);
  }
  return out;
}
