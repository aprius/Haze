import { describe, expect, it } from "vitest";
import { changedRanges, mergeEdits, type RangeEdit } from "./formatChanged";

describe("changedRanges", () => {
  it("lists added and modified lines, neighbours merged, deletions left out", () => {
    const base = ["a", "b", "c", "d", "e", "f", "g"].join("\n");
    const current = ["a", "B", "x", "c", "e", "f", "G"].join("\n");
    // b → B and x added (2-3), d deleted, g → G (7).
    expect(changedRanges(base, current, 7)).toEqual([
      { start: 2, end: 3 },
      { start: 7, end: 7 },
    ]);
  });

  it("is empty when nothing changed, and the whole file when it is not in Git", () => {
    expect(changedRanges("a\nb", "a\nb", 2)).toEqual([]);
    expect(changedRanges("a\nb\nc", "a\nc", 2)).toEqual([]);
    expect(changedRanges(null, "a\nb", 2)).toEqual([{ start: 1, end: 2 }]);
    expect(changedRanges(null, "", 0)).toEqual([]);
  });
});

const edit = (sl: number, sc: number, el: number, ec: number, text = ""): RangeEdit => ({
  range: { startLineNumber: sl, startColumn: sc, endLineNumber: el, endColumn: ec },
  text,
});

describe("mergeEdits", () => {
  it("sorts the edits and drops duplicates", () => {
    expect(mergeEdits([edit(5, 1, 5, 3, " "), edit(1, 1, 1, 2), edit(5, 1, 5, 3, " ")])).toEqual([edit(1, 1, 1, 2), edit(5, 1, 5, 3, " ")]);
  });

  it("leaves out an edit that overlaps one kept before it", () => {
    expect(mergeEdits([edit(2, 1, 3, 5, "x"), edit(3, 1, 3, 2, "y")])).toEqual([edit(2, 1, 3, 5, "x")]);
  });

  it("keeps edits that only touch, and insertions at one point", () => {
    expect(mergeEdits([edit(2, 1, 2, 4, "a"), edit(2, 4, 2, 6, "b")])).toHaveLength(2);
    expect(mergeEdits([edit(2, 4, 2, 4, "a"), edit(2, 4, 2, 4, "b")])).toHaveLength(2);
  });
});
