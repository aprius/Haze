// Line diff and three-way merge regions for the merge window.
//
// node-diff3's LCS (Hunt–Szymanski with a linear candidate scan) blows up on
// files full of repeated lines, such as Unity scenes and prefabs: 9,000 lines
// took over 20 s and froze the window. This is Myers' O((N+M)·D) diff in
// linear space (the bisection of diff-match-patch), on interned lines, with
// common prefixes and suffixes trimmed at every step, and a deadline after
// which a stretch counts as replaced whole, so a merge never hangs; a coarser
// diff only makes a conflict larger, never the merge wrong.

/** A changed stretch: `oLength` lines at `oStart` of the old text became `abLength` lines at `abStart` of the new. */
export interface DiffHunk {
  oStart: number;
  oLength: number;
  abStart: number;
  abLength: number;
}

/** Where line `x` (forward) meets the reverse path, relative to the stretch; null when none is found. */
function bisect(A: Int32Array, B: Int32Array, a0: number, n: number, b0: number, m: number, deadline: number): [number, number] | null {
  const maxD = Math.ceil((n + m) / 2);
  const vOff = maxD;
  const vLen = 2 * maxD + 2;
  const v1 = new Int32Array(vLen).fill(-1);
  const v2 = new Int32Array(vLen).fill(-1);
  v1[vOff + 1] = 0;
  v2[vOff + 1] = 0;
  const delta = n - m;
  // With an odd delta the forward path finds the overlap, else the reverse one.
  const front = delta % 2 !== 0;
  let k1start = 0;
  let k1end = 0;
  let k2start = 0;
  let k2end = 0;
  for (let d = 0; d < maxD; d++) {
    if ((d & 63) === 0 && Date.now() > deadline) return null;
    for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
      const k1Off = vOff + k1;
      let x1 = k1 === -d || (k1 !== d && v1[k1Off - 1] < v1[k1Off + 1]) ? v1[k1Off + 1] : v1[k1Off - 1] + 1;
      let y1 = x1 - k1;
      while (x1 < n && y1 < m && A[a0 + x1] === B[b0 + y1]) {
        x1++;
        y1++;
      }
      v1[k1Off] = x1;
      if (x1 > n) k1end += 2;
      else if (y1 > m) k1start += 2;
      else if (front) {
        const k2Off = vOff + delta - k1;
        if (k2Off >= 0 && k2Off < vLen && v2[k2Off] !== -1 && x1 >= n - v2[k2Off]) return [x1, y1];
      }
    }
    for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
      const k2Off = vOff + k2;
      let x2 = k2 === -d || (k2 !== d && v2[k2Off - 1] < v2[k2Off + 1]) ? v2[k2Off + 1] : v2[k2Off - 1] + 1;
      let y2 = x2 - k2;
      while (x2 < n && y2 < m && A[a0 + n - x2 - 1] === B[b0 + m - y2 - 1]) {
        x2++;
        y2++;
      }
      v2[k2Off] = x2;
      if (x2 > n) k2end += 2;
      else if (y2 > m) k2start += 2;
      else if (!front) {
        const k1Off = vOff + delta - k2;
        if (k1Off >= 0 && k1Off < vLen && v1[k1Off] !== -1) {
          const x1 = v1[k1Off];
          const y1 = vOff + x1 - k1Off;
          if (x1 >= n - x2) return [x1, y1];
        }
      }
    }
  }
  return null;
}

/** The hunks that turn `o` into `ab`, in order. Gives up on precision (not correctness) after `budgetMs`. */
export function diffLines(o: readonly string[], ab: readonly string[], budgetMs = 1500): DiffHunk[] {
  const ids = new Map<string, number>();
  const intern = (lines: readonly string[]) => {
    const out = new Int32Array(lines.length);
    lines.forEach((l, i) => {
      let id = ids.get(l);
      if (id === undefined) ids.set(l, (id = ids.size));
      out[i] = id;
    });
    return out;
  };
  const A = intern(o);
  const B = intern(ab);
  const removed = new Uint8Array(A.length);
  const added = new Uint8Array(B.length);
  const deadline = Date.now() + budgetMs;
  const stack: [number, number, number, number][] = [[0, A.length, 0, B.length]];
  while (stack.length) {
    let [a0, a1, b0, b1] = stack.pop()!;
    while (a0 < a1 && b0 < b1 && A[a0] === B[b0]) (a0++, b0++);
    while (a0 < a1 && b0 < b1 && A[a1 - 1] === B[b1 - 1]) (a1--, b1--);
    if (a0 === a1 || b0 === b1) {
      removed.fill(1, a0, a1);
      added.fill(1, b0, b1);
      continue;
    }
    const mid = bisect(A, B, a0, a1 - a0, b0, b1 - b0, deadline);
    if (!mid) {
      removed.fill(1, a0, a1);
      added.fill(1, b0, b1);
      continue;
    }
    const [x, y] = mid;
    stack.push([a0 + x, a1, b0 + y, b1], [a0, a0 + x, b0, b0 + y]);
  }
  // The lines left unmarked on both sides match one to one, in order.
  const hunks: DiffHunk[] = [];
  let i = 0;
  let j = 0;
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && !removed[i] && !added[j]) {
      i++;
      j++;
      continue;
    }
    const i0 = i;
    const j0 = j;
    while (i < A.length && removed[i]) i++;
    while (j < B.length && added[j]) j++;
    hunks.push({ oStart: i0, oLength: i - i0, abStart: j0, abLength: j - j0 });
  }
  return hunks;
}

export type MergeRegion = { ok: string[] } | { conflict: { a: string[]; aIndex: number; o: string[]; oIndex: number; b: string[]; bIndex: number } };

/**
 * node-diff3's `diff3Merge` (Khanna, Kunal and Pierce's diff3) over `diffLines`:
 * stretches changed on one side only are taken from it, overlapping changes
 * become conflicts, and the same change on both sides is no conflict.
 */
export function diff3Merge(a: readonly string[], o: readonly string[], b: readonly string[]): MergeRegion[] {
  const hunks = [...diffLines(o, a).map((h) => ({ ...h, ab: "a" as const })), ...diffLines(o, b).map((h) => ({ ...h, ab: "b" as const }))];
  hunks.sort((x, y) => x.oStart - y.oStart);
  const results: MergeRegion[] = [];
  let ok: string[] = [];
  const pushOk = (lines: readonly string[]) => {
    for (const l of lines) ok.push(l);
  };
  let curr = 0;
  let h = 0;
  while (h < hunks.length) {
    const first = hunks[h++];
    const regionStart = first.oStart;
    let regionEnd = first.oStart + first.oLength;
    const region = [first];
    while (h < hunks.length && hunks[h].oStart <= regionEnd) {
      regionEnd = Math.max(regionEnd, hunks[h].oStart + hunks[h].oLength);
      region.push(hunks[h++]);
    }
    if (regionStart > curr) pushOk(o.slice(curr, regionStart));
    if (region.length === 1) {
      // Only one side changed this stretch: take it.
      const src = first.ab === "a" ? a : b;
      pushOk(src.slice(first.abStart, first.abStart + first.abLength));
    } else {
      const bounds = { a: [a.length, -1, o.length, -1], b: [b.length, -1, o.length, -1] };
      for (const x of region) {
        const s = bounds[x.ab];
        s[0] = Math.min(x.abStart, s[0]);
        s[1] = Math.max(x.abStart + x.abLength, s[1]);
        s[2] = Math.min(x.oStart, s[2]);
        s[3] = Math.max(x.oStart + x.oLength, s[3]);
      }
      // A side with no hunk here keeps the region as it is in `o`.
      const span = (s: number[], len: number): [number, number] => {
        if (s[1] < 0) return [regionStart, regionEnd];
        return [s[0] + (regionStart - s[2]), Math.min(len, s[1] + (regionEnd - s[3]))];
      };
      const [aStart, aEnd] = span(bounds.a, a.length);
      const [bStart, bEnd] = span(bounds.b, b.length);
      const ac = a.slice(aStart, aEnd);
      const bc = b.slice(bStart, bEnd);
      if (ac.length === bc.length && ac.every((l, i) => l === bc[i])) pushOk(ac);
      else {
        if (ok.length) results.push({ ok });
        ok = [];
        results.push({ conflict: { a: ac, aIndex: aStart, o: o.slice(regionStart, regionEnd), oIndex: regionStart, b: bc, bIndex: bStart } });
      }
    }
    curr = regionEnd;
  }
  if (curr < o.length) pushOk(o.slice(curr));
  if (ok.length) results.push({ ok });
  return results;
}
