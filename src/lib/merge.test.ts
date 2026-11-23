import { describe, expect, it } from "vitest";
import { acceptState, applySide, autoState, buildMerge, changedWords, ignoreSide, initialMark, isResolved, mergeWords, pendingState, replaceBlock, rewriteBlock, stateLines, type BlockMark, type ChangeState, type MergeChange, type MergeModel, type Side } from "./merge";
import { applyEdit } from "./testEdit";

describe("buildMerge", () => {
  it("starts the result as the base, with every change either side made", () => {
    const m = buildMerge("A\nb\nc\nd\n", "a\nb\nc\nd\n", "a\nb\nc\nD\n");
    expect(m.result).toBe("a\nb\nc\nd\n");
    expect(m.changes.map((c) => [c.conflict, c.oursChanged, c.theirsChanged, c.base, c.ours, c.theirs])).toEqual([
      [false, true, false, ["a"], ["A"], ["a"]],
      [false, false, true, ["d"], ["d"], ["D"]],
    ]);
  });

  it("finds conflicts, and the same change on both sides as none", () => {
    const m = buildMerge("one\nvalue = 2\nend\n", "one\nvalue = 1\nend\n", "one\nvalue = 3\nend\n");
    expect(m.changes).toHaveLength(1);
    expect(m.changes[0]).toMatchObject({ conflict: true, oursStart: 1, oursEnd: 2, baseStart: 1, baseEnd: 2, theirsStart: 1, theirsEnd: 2, ours: ["value = 2"], theirs: ["value = 3"] });
    const same = buildMerge("x\r\nsame\r\n", "x\r\nold\r\n", "x\r\nsame\r\n");
    expect(same.eol).toBe("\r\n");
    expect(same.changes[0]).toMatchObject({ conflict: false, oursChanged: true, theirsChanged: true });
  });

  it("keeps each side's line numbers through the other changes", () => {
    const m = buildMerge("new\na\nb\nX\n", "a\nb\nc\n", "a\nb\nY\n");
    const c = m.changes.find((x) => x.conflict)!;
    expect([c.oursStart, c.oursEnd, c.baseStart, c.baseEnd, c.theirsStart, c.theirsEnd]).toEqual([3, 4, 2, 3, 2, 3]);
  });
});

describe("side actions, as MergeConflictModel", () => {
  const conflict = buildMerge("a\nx: 1\nb\n", "a\nx: 0\nb\n", "a\nx: 2\nb\n").changes[0];
  const nonConflict = buildMerge("a\nX\nb\n", "a\nx\nb\n", "a\nx\nb\n").changes[0];

  it("replaces on the first side of a conflict and appends the second", () => {
    let s = applySide(conflict, pendingState(), "theirs");
    expect([stateLines(conflict, s), s.oneside, isResolved(s)]).toEqual([["x: 2"], true, false]);
    s = applySide(conflict, s, "ours");
    expect([stateLines(conflict, s), isResolved(s)]).toEqual([["x: 2", "x: 1"], true]);
  });

  it("resolves a conflict on the first side with Ctrl, or when the other side has no lines", () => {
    const s = applySide(conflict, pendingState(), "ours", true);
    expect([stateLines(conflict, s), isResolved(s)]).toEqual([["x: 1"], true]);
    const deleted = buildMerge("a\nb\n", "a\nx\nb\n", "a\ny\nb\n").changes[0];
    expect(isResolved(applySide(deleted, pendingState(), "theirs"))).toBe(true);
  });

  it("ignores one side of a conflict, or all of it with Ctrl or when it is not a conflict", () => {
    const s = ignoreSide(conflict, pendingState(), "ours");
    expect([stateLines(conflict, s), isResolved(s)]).toEqual([["x: 0"], false]);
    expect(isResolved(applySide(conflict, s, "theirs"))).toBe(true);
    expect(isResolved(ignoreSide(conflict, pendingState(), "ours", true))).toBe(true);
    expect(isResolved(ignoreSide(nonConflict, pendingState(), "ours"))).toBe(true);
    expect(stateLines(nonConflict, ignoreSide(nonConflict, pendingState(), "ours"))).toEqual(["x"]);
  });

  it("takes a non-conflicting change and resolves it; a handled side does not change again", () => {
    const s = applySide(nonConflict, pendingState(), "ours");
    expect([stateLines(nonConflict, s), isResolved(s)]).toEqual([["X"], true]);
    expect(applySide(nonConflict, s, "ours")).toBe(s);
  });

  it("accepts a whole side: changes the side did not make keep the base", () => {
    expect(stateLines(nonConflict, acceptState(nonConflict, "theirs"))).toEqual(["x"]);
    expect(stateLines(conflict, acceptState(conflict, "theirs"))).toEqual(["x: 2"]);
  });
});

describe("the magic wand: simple conflicts merged word by word", () => {
  it("merges changes to different words of the same line", () => {
    // Unity: mine moves y, theirs moves x.
    const m = buildMerge("p: {x: 0, y: 5}\n", "p: {x: 0, y: 0}\n", "p: {x: 7, y: 0}\n");
    const c = m.changes[0];
    expect(c.conflict).toBe(true);
    expect(c.autoResolved).toEqual(["p: {x: 7, y: 5}"]);
    expect(stateLines(c, autoState(c)!)).toEqual(["p: {x: 7, y: 5}"]);
  });

  it("leaves conflicts on the same words alone", () => {
    expect(mergeWords(["x: 1"], ["x: 0"], ["x: 2"])).toBeNull();
    const c = buildMerge("x: 1\n", "x: 0\n", "x: 2\n").changes[0];
    expect(autoState(c)).toBeNull();
  });
});

describe("changedWords", () => {
  it("marks the words a side changed, by line and column", () => {
    expect(changedWords(["p: {x: 7, y: 0}"], ["p: {x: 0, y: 0}"])).toEqual([{ line: 1, start: 8, end: 9 }]);
    expect(changedWords(["a", "b c"], ["a", "b d"])).toEqual([{ line: 2, start: 3, end: 4 }]);
  });
});

describe("rewriting a change's block in the result (what » « × do to the text)", () => {
  // Runs the window's steps on the result: the change's mark, then each state in turn.
  const run = (m: MergeModel, c: MergeChange, states: ChangeState[]) => {
    const r = initialMark(c, m.result.split(m.eol));
    let mark: BlockMark = r;
    let text = m.result;
    return states.map((s) => {
      const out = rewriteBlock(mark, stateLines(c, s), text.split(m.eol), m.eol);
      text = applyEdit(text, out.edit, m.eol);
      mark = out.mark;
      return text;
    });
  };
  const steps = (ours: string, base: string, theirs: string, sides: Side[]) => {
    const m = buildMerge(ours, base, theirs);
    const c = m.changes.find((x) => x.conflict) ?? m.changes[0];
    let s = pendingState();
    return run(
      m,
      c,
      sides.map((side) => (s = applySide(c, s, side))),
    );
  };

  it("replaces a one-line conflict instead of adding above it (its range is empty)", () => {
    expect(steps("a\nx: 1\nb\n", "a\nx: 0\nb\n", "a\nx: 2\nb\n", ["ours", "theirs"])).toEqual(["a\nx: 1\nb\n", "a\nx: 1\nx: 2\nb\n"]);
    expect(steps("a\nx: 1\nb\n", "a\nx: 0\nb\n", "a\nx: 2\nb\n", ["theirs"])).toEqual(["a\nx: 2\nb\n"]);
  });

  it("replaces a blank-line conflict and multi-line ones", () => {
    expect(steps("a\nX\nb\n", "a\n\nb\n", "a\nY\nb\n", ["ours", "theirs"])).toEqual(["a\nX\nb\n", "a\nX\nY\nb\n"]);
    expect(steps("a\n1\n2\nb\n", "a\n0\n0\nb\n", "a\n3\nb\n", ["theirs", "ours"])).toEqual(["a\n3\nb\n", "a\n3\n1\n2\nb\n"]);
  });

  it("inserts where the base had nothing, also after a last line without a newline", () => {
    expect(steps("a\nX\nb\n", "a\nb\n", "a\nY\nb\n", ["ours", "theirs"])).toEqual(["a\nX\nb\n", "a\nX\nY\nb\n"]);
    expect(steps("a\nX", "a", "a\nY", ["ours", "theirs"])).toEqual(["a\nX", "a\nX\nY"]);
    expect(steps("a\r\nX", "a", "a\r\nY", ["theirs", "ours"])).toEqual(["a\r\nY", "a\r\nY\r\nX"]);
  });

  it("keeps track of a block that became empty, also at the end of the file", () => {
    expect(steps("a\nb\n", "a\nx\nb\n", "a\ny\nb\n", ["theirs"])).toEqual(["a\ny\nb\n"]);
    const m = buildMerge("a", "a\nx", "a\ny");
    const c = m.changes[0];
    const ignoredOurs = ignoreSide(c, pendingState(), "ours");
    // Ours deleted the last line: applying it empties the block, then theirs goes where it was.
    expect(run(m, c, [{ ...pendingState(), ours: "applied", order: ["ours"] }, { ...ignoredOurs, order: ["theirs"] }])).toEqual(["a", "a\ny"]);
  });

  it("leaves other blocks in place: applying the lower change first", () => {
    const m = buildMerge("A1\nk\nA2\n", "a1\nk\na2\n", "B1\nk\nB2\n");
    expect(m.changes).toHaveLength(2);
    const [c1, c2] = m.changes;
    let text = applyEdit(m.result, rewriteBlock(initialMark(c2, m.result.split("\n")), ["B2"], m.result.split("\n"), "\n").edit);
    text = applyEdit(text, rewriteBlock(initialMark(c1, text.split("\n")), ["A1"], text.split("\n"), "\n").edit);
    expect(text).toBe("A1\nk\nB2\n");
  });

  it("removes the last lines with their line break", () => {
    expect(applyEdit("a\nX", replaceBlock(1, [], 2, 2, ["a", "X"], "\n"))).toBe("a");
  });
});
