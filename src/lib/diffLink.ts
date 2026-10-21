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

/** Index of the next (`dir = 1`) or previous (`dir = -1`) block relative to `line` on the right side. */
export function nextChunk(chunks: readonly Chunk[], line: number, dir: 1 | -1): number {
  if (dir === 1) return chunks.findIndex((c) => c.b0 + 1 > line);
  for (let i = chunks.length - 1; i >= 0; i--) if (Math.max(chunks[i].b1, chunks[i].b0 + 1) < line) return i;
  return -1;
}
