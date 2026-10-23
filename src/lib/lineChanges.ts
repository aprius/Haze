// Changed-line markers for the editor gutter ("VCS markers"): which
// lines of the buffer differ from the committed file.

export type LineChangeKind = "added" | "modified" | "deleted";

export interface LineChange {
  kind: LineChangeKind;
  /** 1-based lines in the current text. A deletion has `start === end`: the line it follows (0 = before line 1). */
  start: number;
  end: number;
}

/** Lines `aStart..aEnd` of the base became `bStart..bEnd` of the current text (0-based, end exclusive). */
interface Hunk {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

/**
 * Most edits (D) the diff looks for, and most work ((N+M)·D steps) it does,
 * before it gives up and calls the whole differing middle modified, like VS
 * Code's diff timeout. Runs on the UI thread after each pause in typing: at
 * most ~10 ms, and D² memory for the rounds kept (16 MB at most, for a moment).
 */
const MAX_EDITS = 2000;
const MAX_WORK = 40_000_000;

function lines(text: string): string[] {
  return text === "" ? [] : text.split(/\r?\n/);
}

/**
 * Myers' O(ND) diff (git's and VS Code's default) of two line lists, as line
 * ids. Its time grows with the number of differences, not with how often
 * lines repeat: the LCS it replaced took 39 s on a 10,000-line C# file with
 * two edits far apart, `}` and blank lines matching everywhere. `null` past
 * `maxEdits`.
 */
function myers(a: Int32Array, b: Int32Array, maxEdits: number): Hunk[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const off = max + 1;
  // Furthest x reached on each diagonal k = x - y, and its value before each round.
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= Math.min(max, maxEdits); d++) {
    trace.push(v.slice(off - d, off + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return hunksOf(trace, d, n, m);
    }
  }
  return null;
}

/** Walks the rounds back from (n, m) and groups the edits into hunks. */
function hunksOf(trace: Int32Array[], dEnd: number, n: number, m: number): Hunk[] {
  // Each edit, last first: deleting base line x, or inserting current line y, at (x, y).
  const edits: { x: number; y: number; del: boolean }[] = [];
  let x = n;
  let y = m;
  for (let d = dEnd; d > 0; d--) {
    const before = trace[d];
    const at = (k: number) => before[k + d];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    edits.push({ x: prevX, y: prevY, del: !down });
    x = prevX;
    y = prevY;
  }
  const hunks: Hunk[] = [];
  for (let i = edits.length - 1; i >= 0; i--) {
    const e = edits[i];
    const last = hunks[hunks.length - 1];
    if (last && last.aEnd === e.x && last.bEnd === e.y) {
      if (e.del) last.aEnd++;
      else last.bEnd++;
    } else {
      hunks.push({ aStart: e.x, aEnd: e.x + (e.del ? 1 : 0), bStart: e.y, bEnd: e.y + (e.del ? 0 : 1) });
    }
  }
  return hunks;
}

interface Diff {
  a: string[];
  b: string[];
  /** In whole-text lines, in order. */
  hunks: Hunk[];
}

/**
 * Moves each pure insertion or deletion down while the line after it is the
 * same as its first line, as git does: of two identical `}` lines, the second
 * is the one added, so markers and line blame agree with `git diff` and
 * `git blame`.
 */
function slideDown(hunks: Hunk[], a: string[], b: string[]): void {
  hunks.forEach((h, i) => {
    const next = hunks[i + 1];
    const [aLimit, bLimit] = next ? [next.aStart, next.bStart] : [a.length, b.length];
    const step = () => {
      h.aStart++;
      h.aEnd++;
      h.bStart++;
      h.bEnd++;
    };
    if (h.aStart === h.aEnd) while (h.bEnd < bLimit && h.aEnd < aLimit && b[h.bStart] === b[h.bEnd]) step();
    else if (h.bStart === h.bEnd) while (h.aEnd < aLimit && h.bEnd < bLimit && a[h.aStart] === a[h.aEnd]) step();
  });
}

/** The last diff: change markers and line blame ask for the same texts in turn. */
let last: { base: string; current: string; diff: Diff } | null = null;

function diff(base: string, current: string): Diff {
  if (last && last.base === base && last.current === current) return last.diff;
  const a = lines(base);
  const b = lines(current);
  // Only the middle differs in the usual edit; diff just that.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const ma = a.length - head - tail;
  const mb = b.length - head - tail;
  let hunks: Hunk[] = [];
  if (ma || mb) {
    const ids = new Map<string, number>();
    const id = (l: string) => {
      let i = ids.get(l);
      if (i === undefined) ids.set(l, (i = ids.size));
      return i;
    };
    const ia = Int32Array.from(a.slice(head, head + ma), id);
    const ib = Int32Array.from(b.slice(head, head + mb), id);
    const maxEdits = Math.min(MAX_EDITS, Math.floor(MAX_WORK / (ma + mb)));
    hunks = (myers(ia, ib, maxEdits) ?? [{ aStart: 0, aEnd: ma, bStart: 0, bEnd: mb }]).map((h) => ({
      aStart: h.aStart + head,
      aEnd: h.aEnd + head,
      bStart: h.bStart + head,
      bEnd: h.bEnd + head,
    }));
    slideDown(hunks, a, b);
  }
  const result = { a, b, hunks };
  last = { base, current, diff: result };
  return result;
}

export function lineChanges(base: string, current: string): LineChange[] {
  return diff(base, current).hunks.map((h) => {
    if (h.bEnd === h.bStart) return { kind: "deleted", start: h.bStart, end: h.bStart };
    return { kind: h.aEnd === h.aStart ? "added" : "modified", start: h.bStart + 1, end: h.bEnd };
  });
}

/**
 * For each 1-based line of `current`, the line of `base` it is unchanged
 * from, or null for a line added or modified since (like Rider's line status
 * tracker under an annotation). Lines of a change too large to diff are null.
 */
export function lineMapper(base: string, current: string): (line: number) => number | null {
  const { b, hunks } = diff(base, current);
  return (line) => {
    const i = line - 1;
    if (i < 0 || i >= b.length) return null;
    // Lines between hunks are equal; each hunk passed moves them by its size difference.
    let shift = 0;
    for (const h of hunks) {
      if (i < h.bStart) break;
      if (i < h.bEnd) return null;
      shift = h.aEnd - h.bEnd;
    }
    return i + shift + 1;
  };
}
