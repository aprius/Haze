import { describe, expect, it } from "vitest";
import { lineChanges, lineMapper } from "./lineChanges";

const text = (...l: string[]) => l.join("\n");

describe("lineChanges", () => {
  it("finds nothing in identical text, whatever the line endings", () => {
    expect(lineChanges(text("a", "b"), "a\r\nb")).toEqual([]);
  });

  it("marks added lines", () => {
    expect(lineChanges(text("a", "b"), text("a", "x", "y", "b"))).toEqual([{ kind: "added", start: 2, end: 3 }]);
  });

  it("marks modified lines", () => {
    expect(lineChanges(text("a", "b", "c"), text("a", "B", "c"))).toEqual([{ kind: "modified", start: 2, end: 2 }]);
  });

  it("marks a deletion after the line it follows", () => {
    expect(lineChanges(text("a", "b", "c"), text("a", "c"))).toEqual([{ kind: "deleted", start: 1, end: 1 }]);
    expect(lineChanges(text("a", "b"), text("b"))).toEqual([{ kind: "deleted", start: 0, end: 0 }]);
  });

  it("finds separate changes", () => {
    expect(lineChanges(text("a", "b", "c", "d", "e"), text("a", "B", "c", "e", "f"))).toEqual([
      { kind: "modified", start: 2, end: 2 },
      { kind: "deleted", start: 3, end: 3 },
      { kind: "added", start: 5, end: 5 },
    ]);
  });

  it("marks every line of a new file as added", () => {
    expect(lineChanges("", text("a", "b"))).toEqual([{ kind: "added", start: 1, end: 2 }]);
  });
});

describe("lineMapper", () => {
  const map = (base: string, current: string) => {
    const m = lineMapper(base, current);
    return current.split(/\r?\n/).map((_, i) => m(i + 1));
  };

  it("maps unchanged lines across added, modified and deleted ones", () => {
    // base: a b c d e f; current: a X c e f g
    expect(map(text("a", "b", "c", "d", "e", "f"), text("a", "X", "c", "e", "f", "g"))).toEqual([1, null, 3, 5, 6, null]);
    expect(map(text("a", "b"), text("n", "a", "b"))).toEqual([null, 1, 2]);
    expect(map(text("a", "b", "c"), text("a", "c"))).toEqual([1, 3]);
    expect(map(text("a", "b"), "a\r\nb")).toEqual([1, 2]);
  });

  it("maps the shared start and end around a change in the middle", () => {
    const base = text("1", "2", "3", "4", "5", "6", "7");
    expect(map(base, text("1", "2", "x", "y", "3", "4", "6", "7"))).toEqual([1, 2, null, null, 3, 4, 6, 7]);
  });

  it("answers null outside the text", () => {
    const m = lineMapper(text("a"), text("a"));
    expect([m(0), m(2)]).toEqual([null, null]);
  });
});
