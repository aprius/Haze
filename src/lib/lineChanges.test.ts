import { describe, expect, it } from "vitest";
import { lineChanges } from "./lineChanges";

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
