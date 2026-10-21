// Geometry for the Rider-style side-by-side diff: changed blocks on each side,
// the curved connectors drawn between them, and the scroll mapping that keeps
// both sides aligned without padding either editor.

/**
 * A changed block in line *boundaries* (0 = above line 1, n = below line n):
 * lines `a0 + 1 .. a1` on the left map to `b0 + 1 .. b1` on the right. An empty
 * side (`a0 === a1`) marks where the other side's lines were added/removed.
 */
export interface Chunk {
  a0: number;
  a1: number;
  b0: number;
  b1: number;
}

export type ChunkKind = "added" | "deleted" | "modified";

/** Monaco's `ILineChange` line fields (an end of 0 means "empty, after the start line"). */
export interface LineChangeLike {
  originalStartLineNumber: number;
  originalEndLineNumber: number;
  modifiedStartLineNumber: number;
  modifiedEndLineNumber: number;
}

export function toChunk(c: LineChangeLike): Chunk {
  const side = (start: number, end: number): [number, number] => (end === 0 ? [start, start] : [start - 1, end]);
  const [a0, a1] = side(c.originalStartLineNumber, c.originalEndLineNumber);
  const [b0, b1] = side(c.modifiedStartLineNumber, c.modifiedEndLineNumber);
  return { a0, a1, b0, b1 };
}

export function chunkKind(c: Chunk): ChunkKind {
  return c.a0 === c.a1 ? "added" : c.b0 === c.b1 ? "deleted" : "modified";
}

/**
 * Maps a fractional boundary on one side to the other side: unchanged stretches
 * keep their offset, changed blocks are stretched linearly onto each other.
 */
export function mapBoundary(chunks: readonly Chunk[], x: number, fromLeft: boolean): number {
  let from0 = 0;
  let to0 = 0;
  for (const c of chunks) {
    const [s0, s1, t0, t1] = fromLeft ? [c.a0, c.a1, c.b0, c.b1] : [c.b0, c.b1, c.a0, c.a1];
    if (x < s0) break;
    if (x <= s1) return s1 === s0 ? t1 : t0 + ((x - s0) / (s1 - s0)) * (t1 - t0);
    from0 = s1;
    to0 = t1;
  }
  return to0 + (x - from0);
}

/** Closed SVG path joining the left span `l0..l1` to the right span `r0..r1` across a gap of `width`. */
export function connectorPath(width: number, l0: number, l1: number, r0: number, r1: number): string {
  const m = width / 2;
  const f = (n: number) => Math.round(n * 10) / 10;
  return (
    `M0,${f(l0)} C${f(m)},${f(l0)} ${f(m)},${f(r0)} ${f(width)},${f(r0)} ` +
    `L${f(width)},${f(r1)} C${f(m)},${f(r1)} ${f(m)},${f(l1)} 0,${f(l1)} Z`
  );
}

/** Open SVG curve from `yl` on the left edge to `yr` on the right edge: one border of a connector. */
export function connectorCurve(width: number, yl: number, yr: number): string {
  const m = width / 2;
  const f = (n: number) => Math.round(n * 10) / 10;
  return `M0,${f(yl)} C${f(m)},${f(yl)} ${f(m)},${f(yr)} ${f(width)},${f(yr)}`;
}

/** Index of the next (`dir = 1`) or previous (`dir = -1`) block relative to `line` on the right side. */
export function nextChunk(chunks: readonly Chunk[], line: number, dir: 1 | -1): number {
  if (dir === 1) return chunks.findIndex((c) => c.b0 + 1 > line);
  for (let i = chunks.length - 1; i >= 0; i--) if (Math.max(chunks[i].b1, chunks[i].b0 + 1) < line) return i;
  return -1;
}

/** A text edit in Monaco coordinates (1-based lines and columns). */
export interface LineEdit {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  text: string;
}

/**
 * The edit on the right side (`right`, its lines) that replaces block `c` with
 * the left side's lines, or with `append` inserts them below it, keeping the
 * right lines. `null` when there is nothing to do.
 */
export function revertEdit(c: Chunk, left: readonly string[], right: readonly string[], eol: string, append = false): LineEdit | null {
  const text = c.a0 < c.a1 ? left.slice(c.a0, c.a1).join(eol) : null;
  if (append && text === null) return null;
  const n = Math.max(1, right.length);
  const maxCol = (line: number) => (right[line - 1] ?? "").length + 1;
  const edit = (startLine: number, startColumn: number, endLine: number, endColumn: number, text: string) => ({ startLine, startColumn, endLine, endColumn, text });
  const b0 = append ? c.b1 : c.b0;
  if (b0 < c.b1) {
    if (text !== null) return edit(b0 + 1, 1, c.b1, maxCol(c.b1), text);
    if (c.b1 < n) return edit(b0 + 1, 1, c.b1 + 1, 1, "");
    // Removing the last lines also removes the line break before them.
    return b0 > 0 ? edit(b0, maxCol(b0), n, maxCol(n), "") : edit(1, 1, n, maxCol(n), "");
  }
  if (text === null) return null;
  return b0 < n ? edit(b0 + 1, 1, b0 + 1, 1, text + eol) : edit(n, maxCol(n), n, maxCol(n), eol + text);
}
