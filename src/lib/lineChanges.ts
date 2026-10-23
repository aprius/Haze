// Changed-line markers for the editor gutter ("VCS markers"): which
// lines of the buffer differ from the committed file.
import { diffIndices } from "node-diff3";

export type LineChangeKind = "added" | "modified" | "deleted";

export interface LineChange {
  kind: LineChangeKind;
  /** 1-based lines in the current text. A deletion has `start === end`: the line it follows (0 = before line 1). */
  start: number;
  end: number;
}

/** Past this many differing lines the LCS gets slow; no markers rather than a stuck editor. */
const MAX_LINES = 20_000;

function lines(text: string): string[] {
  return text === "" ? [] : text.split(/\r?\n/);
}

/** The lines of both texts, and how many lines they share at the start and at the end. */
function trimmed(base: string, current: string) {
  const a = lines(base);
  const b = lines(current);
  // Only the middle differs in the usual edit; diff just that.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return { a, b, head, tail, ma: a.slice(head, a.length - tail), mb: b.slice(head, b.length - tail) };
}

export function lineChanges(base: string, current: string): LineChange[] {
  const { head, ma, mb } = trimmed(base, current);
  if (ma.length + mb.length > MAX_LINES) return [];
  const out: LineChange[] = [];
  for (const d of diffIndices(ma, mb)) {
    const [, removed] = d.buffer1;
    const [at, added] = d.buffer2;
    const start = head + at + 1;
    if (added === 0) out.push({ kind: "deleted", start: start - 1, end: start - 1 });
    else out.push({ kind: removed === 0 ? "added" : "modified", start, end: start + added - 1 });
  }
  return out;
}

/**
 * For each 1-based line of `current`, the line of `base` it is unchanged
 * from, or null for a line added or modified since (like Rider's line status
 * tracker under an annotation). Every line is null when the change is too
 * large to diff.
 */
export function lineMapper(base: string, current: string): (line: number) => number | null {
  const { a, b, head, tail, ma, mb } = trimmed(base, current);
  if (ma.length + mb.length > MAX_LINES) return () => null;
  const hunks = diffIndices(ma, mb).map((d) => ({ bStart: d.buffer2[0], bEnd: d.buffer2[0] + d.buffer2[1], shift: d.buffer1[0] + d.buffer1[1] - (d.buffer2[0] + d.buffer2[1]) }));
  return (line) => {
    const i = line - 1;
    if (i < 0 || i >= b.length) return null;
    if (i < head) return line;
    if (i >= b.length - tail) return i + a.length - b.length + 1;
    const j = i - head;
    // Lines between hunks are equal; each hunk passed moves them by its size difference.
    let shift = 0;
    for (const h of hunks) {
      if (j < h.bStart) break;
      if (j < h.bEnd) return null;
      shift = h.shift;
    }
    return head + j + shift + 1;
  };
}
