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
  const fullA = intern(o);
  const fullB = intern(ab);
  const removed = new Uint8Array(fullA.length);
  const added = new Uint8Array(fullB.length);
  // As git does (xdl_cleanup_records): a line missing from the other text is
  // surely removed or added, so Myers runs on the rest only. It cannot be in a
  // common subsequence, so the diff stays minimal.
  const inA = new Uint8Array(ids.size);
  const inB = new Uint8Array(ids.size);
  fullA.forEach((id) => (inA[id] = 1));
  fullB.forEach((id) => (inB[id] = 1));
  const keep = (full: Int32Array, other: Uint8Array, gone: Uint8Array): [Int32Array, Int32Array] => {
    const idx: number[] = [];
    full.forEach((id, i) => (other[id] ? idx.push(i) : (gone[i] = 1)));
    return [Int32Array.from(idx, (i) => full[i]), Int32Array.from(idx)];
  };
  const [A, mapA] = keep(fullA, inB, removed);
  const [B, mapB] = keep(fullB, inA, added);
  const mark = (gone: Uint8Array, map: Int32Array, from: number, to: number) => {
    for (let i = from; i < to; i++) gone[map[i]] = 1;
  };
  const deadline = Date.now() + budgetMs;
  const stack: [number, number, number, number][] = [[0, A.length, 0, B.length]];
  while (stack.length) {
    let [a0, a1, b0, b1] = stack.pop()!;
    while (a0 < a1 && b0 < b1 && A[a0] === B[b0]) (a0++, b0++);
    while (a0 < a1 && b0 < b1 && A[a1 - 1] === B[b1 - 1]) (a1--, b1--);
    if (a0 === a1 || b0 === b1) {
      mark(removed, mapA, a0, a1);
      mark(added, mapB, b0, b1);
      continue;
    }
    const mid = bisect(A, B, a0, a1 - a0, b0, b1 - b0, deadline);
    // A split at either end would push the same stretch again: count it as replaced instead.
    if (!mid || (mid[0] === 0 && mid[1] === 0) || (mid[0] === a1 - a0 && mid[1] === b1 - b0)) {
      mark(removed, mapA, a0, a1);
      mark(added, mapB, b0, b1);
      continue;
    }
    const [x, y] = mid;
    stack.push([a0 + x, a1, b0 + y, b1], [a0, a0 + x, b0, b0 + y]);
  }
  // The lines left unmarked on both sides match one to one, in order.
  const hunks: DiffHunk[] = [];
  let i = 0;
  let j = 0;
  while (i < fullA.length || j < fullB.length) {
    if (i < fullA.length && j < fullB.length && !removed[i] && !added[j]) {
      i++;
      j++;
      continue;
    }
    const i0 = i;
    const j0 = j;
    while (i < fullA.length && removed[i]) i++;
    while (j < fullB.length && added[j]) j++;
    hunks.push({ oStart: i0, oLength: i - i0, abStart: j0, abLength: j - j0 });
  }
  return hunks;
}

/**
 * A stretch where `a` or `b` (or both) differ from `o`, in line boundaries of
 * all three: lines `aStart..aEnd` of `a` stand for `oStart..oEnd` of `o` and
 * `bStart..bEnd` of `b`. A side that did not change it holds `o`'s lines there.
 */
export interface Diff3Change {
  aStart: number;
  aEnd: number;
  oStart: number;
  oEnd: number;
  bStart: number;
  bEnd: number;
  /** Both sides changed it, differently. */
  conflict: boolean;
  aChanged: boolean;
  bChanged: boolean;
}

/**
 * node-diff3's diff3 (Khanna, Kunal and Pierce) over `diffLines`, as the
 * changes IntelliJ's merge window works with: every stretch either side
 * changed, overlapping changes as one conflict; the same change on both sides
 * is no conflict.
 */
export function diff3Changes(a: readonly string[], o: readonly string[], b: readonly string[]): Diff3Change[] {
  const hunks = [...diffLines(o, a).map((h) => ({ ...h, ab: "a" as const })), ...diffLines(o, b).map((h) => ({ ...h, ab: "b" as const }))];
  hunks.sort((x, y) => x.oStart - y.oStart);
  const changes: Diff3Change[] = [];
  // How far `a` and `b` are ahead of `o` after the changes so far: unchanged stretches keep that offset.
  let da = 0;
  let db = 0;
  let h = 0;
  while (h < hunks.length) {
    const first = hunks[h++];
    const oStart = first.oStart;
    let oEnd = first.oStart + first.oLength;
    const region = [first];
    while (h < hunks.length && hunks[h].oStart <= oEnd) {
      oEnd = Math.max(oEnd, hunks[h].oStart + hunks[h].oLength);
      region.push(hunks[h++]);
    }
    // Each side's span: its hunks widened by the unchanged lines around them, else `o`'s lines.
    const span = (side: "a" | "b", d: number): [number, number] => {
      const own = region.filter((x) => x.ab === side);
      if (!own.length) return [oStart + d, oEnd + d];
      const s0 = Math.min(...own.map((x) => x.abStart));
      const s1 = Math.max(...own.map((x) => x.abStart + x.abLength));
      const o0 = Math.min(...own.map((x) => x.oStart));
      const o1 = Math.max(...own.map((x) => x.oStart + x.oLength));
      return [s0 - (o0 - oStart), s1 + (oEnd - o1)];
    };
    const [aStart, aEnd] = span("a", da);
    const [bStart, bEnd] = span("b", db);
    const aChanged = region.some((x) => x.ab === "a");
    const bChanged = region.some((x) => x.ab === "b");
    let conflict = aChanged && bChanged;
    if (conflict && aEnd - aStart === bEnd - bStart) {
      let same = true;
      for (let i = 0; same && i < aEnd - aStart; i++) same = a[aStart + i] === b[bStart + i];
      conflict = !same;
    }
    changes.push({ aStart, aEnd, oStart, oEnd, bStart, bEnd, conflict, aChanged, bChanged });
    da = aEnd - oEnd;
    db = bEnd - oEnd;
  }
  return changes;
}

export type MergeRegion = { ok: string[] } | { conflict: { a: string[]; aIndex: number; o: string[]; oIndex: number; b: string[]; bIndex: number } };

/**
 * The merged text as regions: each change taken from the side that made it,
 * conflicts left as such (what `git merge-file` does, in node-diff3's shape).
 */
export function diff3Merge(a: readonly string[], o: readonly string[], b: readonly string[]): MergeRegion[] {
  const results: MergeRegion[] = [];
  let ok: string[] = [];
  const pushOk = (lines: readonly string[]) => {
    for (const l of lines) ok.push(l);
  };
  let curr = 0;
  for (const c of diff3Changes(a, o, b)) {
    pushOk(o.slice(curr, c.oStart));
    if (!c.conflict) pushOk(c.aChanged ? a.slice(c.aStart, c.aEnd) : b.slice(c.bStart, c.bEnd));
    else {
      if (ok.length) results.push({ ok });
      ok = [];
      results.push({ conflict: { a: a.slice(c.aStart, c.aEnd), aIndex: c.aStart, o: o.slice(c.oStart, c.oEnd), oIndex: c.oStart, b: b.slice(c.bStart, c.bEnd), bIndex: c.bStart } });
    }
    curr = c.oEnd;
  }
  pushOk(o.slice(curr));
  if (ok.length) results.push({ ok });
  return results;
}
