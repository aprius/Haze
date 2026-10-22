// Changed-line markers for the editor gutter (Rider's "VCS markers"): which
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

export function lineChanges(base: string, current: string): LineChange[] {
  const a = lines(base);
  const b = lines(current);
  // Only the middle differs in the usual edit; diff just that.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const ma = a.slice(head, a.length - tail);
  const mb = b.slice(head, b.length - tail);
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
