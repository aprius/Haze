import { describe, expect, it } from "vitest";
import { diff3Merge as nodeDiff3Merge } from "node-diff3";
import { diff3Merge, diffLines } from "./lineDiff";
import { buildMerge } from "./merge";

// Applies `diffLines(o, ab)` to `o`; it must give back `ab`.
function patch(o: string[], ab: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  for (const h of diffLines(o, ab)) {
    out.push(...o.slice(i, h.oStart), ...ab.slice(h.abStart, h.abStart + h.abLength));
    i = h.oStart + h.oLength;
  }
  return [...out, ...o.slice(i)];
}

const merged = (regions: ReturnType<typeof diff3Merge>) => regions.flatMap((r) => ("ok" in r ? r.ok : ["<<<", ...r.conflict.a, "===", ...r.conflict.b, ">>>"]));

// A small deterministic random generator, so failures repeat.
function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

// Unity-like YAML: many objects made of the same lines.
function scene(n: number, x: (i: number) => number): string[] {
  const out = ["%YAML 1.1"];
  for (let i = 0; i < n; i++) {
    out.push(`--- !u!1 &${1000 + i}`, "GameObject:", "  m_ObjectHideFlags: 0", "  serializedVersion: 6", `  m_Name: Obj${i}`, "  m_IsActive: 1");
    out.push(`--- !u!4 &${5000 + i}`, "Transform:", `  m_LocalPosition: {x: ${x(i)}, y: 0, z: 0}`, "  m_LocalScale: {x: 1, y: 1, z: 1}", "  m_Father: {fileID: 0}", "  m_Enabled: 1");
  }
  return out;
}

describe("diffLines", () => {
  it("gives hunks that turn one text into the other", () => {
    const r = rng(7);
    for (let t = 0; t < 300; t++) {
      const o = Array.from({ length: Math.floor(r() * 30) }, () => "abcde"[Math.floor(r() * 5)]);
      const ab = o.filter(() => r() > 0.2).flatMap((l) => (r() > 0.85 ? [l, "xyz"[Math.floor(r() * 3)]] : [l]));
      expect(patch(o, ab)).toEqual(ab);
    }
  });

  it("finds a minimal diff", () => {
    expect(diffLines(["a", "b", "c"], ["a", "x", "c"])).toEqual([{ oStart: 1, oLength: 1, abStart: 1, abLength: 1 }]);
    expect(diffLines([], ["a"])).toEqual([{ oStart: 0, oLength: 0, abStart: 0, abLength: 1 }]);
    expect(diffLines(["a", "b"], ["a", "b"])).toEqual([]);
  });

  it("stays correct when the time budget runs out", () => {
    const o = scene(300, () => 0);
    const ab = scene(300, (i) => i % 3);
    const out: string[] = [];
    let i = 0;
    for (const h of diffLines(o, ab, 0)) {
      out.push(...o.slice(i, h.oStart), ...ab.slice(h.abStart, h.abStart + h.abLength));
      i = h.oStart + h.oLength;
    }
    expect([...out, ...o.slice(i)]).toEqual(ab);
  });
});

describe("diff3Merge", () => {
  it("merges like node-diff3 on small texts", () => {
    const r = rng(11);
    let same = 0;
    for (let t = 0; t < 300; t++) {
      const o = Array.from({ length: 4 + Math.floor(r() * 12) }, (_, i) => `l${i}`);
      const edit = () => o.flatMap((l) => (r() < 0.15 ? [] : r() < 0.15 ? [l + "*"] : r() < 0.1 ? [l, "new"] : [l]));
      const a = edit();
      const b = edit();
      const ours = merged(diff3Merge(a, o, b));
      const theirs = merged(nodeDiff3Merge(a, o, b, { excludeFalseConflicts: true }) as ReturnType<typeof diff3Merge>);
      if (ours.join("\n") === theirs.join("\n")) same++;
      // Without conflicts the merge must hold every line both sides kept.
      if (!ours.includes("<<<")) {
        for (const l of a.filter((x) => !o.includes(x))) expect(ours).toContain(l);
        for (const l of b.filter((x) => !o.includes(x))) expect(ours).toContain(l);
      }
    }
    // Equally minimal diffs can differ in where they align; nearly all agree.
    expect(same).toBeGreaterThan(270);
  });

  it("takes one side's changes, and the same change on both sides, without conflict", () => {
    expect(diff3Merge(["A", "b", "c"], ["a", "b", "c"], ["a", "b", "C"])).toEqual([{ ok: ["A", "b", "C"] }]);
    expect(diff3Merge(["a", "X"], ["a", "b"], ["a", "X"])).toEqual([{ ok: ["a", "X"] }]);
  });

  it("merges a large Unity scene quickly", () => {
    const n = 15000; // 180,000 lines
    const base = scene(n, () => 0);
    const ours = scene(n, (i) => (i % 50 === 0 ? 1 : 0));
    const theirs = scene(n, (i) => (i % 50 === 0 ? 1 : i % 70 === 0 ? 2 : 0));
    const t = Date.now();
    const regions = diff3Merge(ours, base, theirs);
    expect(Date.now() - t).toBeLessThan(3000);
    // Both moved the same objects identically where they overlap: no conflict.
    expect(regions.every((r) => "ok" in r)).toBe(true);
    expect(merged(regions)).toEqual(theirs);
    // Where they move one object differently, that object is the only conflict.
    const clash = diff3Merge(ours, base, scene(n, (i) => (i === 700 ? 9 : i % 50 === 0 ? 1 : 0)));
    const conflicts = clash.filter((r) => "conflict" in r);
    expect(conflicts).toHaveLength(1);
    expect("conflict" in conflicts[0] && conflicts[0].conflict.b).toEqual(["  m_LocalPosition: {x: 9, y: 0, z: 0}"]);
  });
});

// Minimal number of inserted + deleted lines, by dynamic programming.
function editDistance(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1]);
  return dp[a.length][b.length];
}

describe("diffLines on hard inputs", () => {
  it("is minimal, lines missing from the other side set aside or not", () => {
    const r = rng(3);
    for (let t = 0; t < 2000; t++) {
      const alpha = 1 + Math.floor(r() * 6);
      const a = Array.from({ length: Math.floor(r() * 40) }, () => String(Math.floor(r() * alpha)));
      const b = Array.from({ length: Math.floor(r() * 40) }, () => String(Math.floor(r() * (alpha + 2))));
      const h = diffLines(a, b);
      expect(h.reduce((n, x) => n + x.oLength + x.abLength, 0)).toBe(editDistance(a, b));
      expect(patch(a, b)).toEqual(b);
    }
  });

  it("stays fast in the worst cases", { timeout: 60000 }, () => {
    const timed = (f: () => unknown) => {
      const t = performance.now();
      f();
      return performance.now() - t;
    };
    const n = 20000; // 240,000 lines
    const base = scene(n, () => 0);
    // Changes all over: every 3rd object on one side, every 4th on the other.
    expect(timed(() => diff3Merge(scene(n, (i) => (i % 3 === 0 ? 1 : 0)), base, scene(n, (i) => (i % 4 === 0 ? 2 : 0))))).toBeLessThan(5000);
    // A regenerated file sharing almost no line.
    expect(timed(() => diffLines(base, base.map((l) => l + " #")))).toBeLessThan(2000);
    // One huge conflict, which must not overflow the stack either.
    const big = Array.from({ length: 300000 }, (_, i) => `line ${i}`);
    expect(timed(() => buildMerge(big.map((l) => l + "a").join("\n"), big.join("\n"), big.map((l) => l + "b").join("\n")))).toBeLessThan(5000);
  });
});
