import { describe, expect, it } from "vitest";
import { chunkKind, connectorCurve, connectorPath, mapBoundary, nextChunk, revertEdit, toChunk, type Chunk } from "./diffLink";
import { applyEdit } from "./testEdit";

describe("toChunk", () => {
  it("converts modified, added and deleted line changes", () => {
    expect(toChunk({ originalStartLineNumber: 3, originalEndLineNumber: 4, modifiedStartLineNumber: 3, modifiedEndLineNumber: 5 })).toEqual({ a0: 2, a1: 4, b0: 2, b1: 5 });
    const added = toChunk({ originalStartLineNumber: 2, originalEndLineNumber: 0, modifiedStartLineNumber: 3, modifiedEndLineNumber: 4 });
    expect(added).toEqual({ a0: 2, a1: 2, b0: 2, b1: 4 });
    expect(chunkKind(added)).toBe("added");
    const deleted = toChunk({ originalStartLineNumber: 1, originalEndLineNumber: 2, modifiedStartLineNumber: 0, modifiedEndLineNumber: 0 });
    expect(deleted).toEqual({ a0: 0, a1: 2, b0: 0, b1: 0 });
    expect(chunkKind(deleted)).toBe("deleted");
  });
});

describe("mapBoundary", () => {
  // Left lines 3-4 became right lines 3-5; left lines 8-9 were deleted.
  const chunks = [
    { a0: 2, a1: 4, b0: 2, b1: 5 },
    { a0: 7, a1: 9, b0: 8, b1: 8 },
  ];

  it("keeps unchanged stretches aligned with their offset", () => {
    expect(mapBoundary(chunks, 1, true)).toBe(1);
    expect(mapBoundary(chunks, 6, true)).toBe(7);
    expect(mapBoundary(chunks, 12, true)).toBe(11);
    expect(mapBoundary(chunks, 11, false)).toBe(12);
  });

  it("stretches changed blocks linearly", () => {
    expect(mapBoundary(chunks, 3, true)).toBe(3.5);
    expect(mapBoundary(chunks, 3.5, false)).toBe(3);
  });

  it("maps into an empty side to its single boundary and back across it", () => {
    expect(mapBoundary(chunks, 8, true)).toBe(8);
    expect(mapBoundary(chunks, 8, false)).toBe(9);
  });
});

describe("connectorPath", () => {
  it("draws a closed band between both spans", () => {
    expect(connectorPath(40, 10, 30, 50, 60)).toBe("M0,10 C20,10 20,50 40,50 L40,60 C20,60 20,30 0,30 Z");
    expect(connectorCurve(40, 10.5, 49.5)).toBe("M0,10.5 C20,10.5 20,49.5 40,49.5");
  });
});

describe("nextChunk", () => {
  const chunks = [
    { a0: 2, a1: 4, b0: 2, b1: 5 },
    { a0: 7, a1: 9, b0: 8, b1: 8 },
  ];

  it("finds the block after or before the caret line", () => {
    expect(nextChunk(chunks, 1, 1)).toBe(0);
    expect(nextChunk(chunks, 3, 1)).toBe(1);
    expect(nextChunk(chunks, 9, 1)).toBe(-1);
    expect(nextChunk(chunks, 10, -1)).toBe(1);
    expect(nextChunk(chunks, 9, -1)).toBe(0);
    expect(nextChunk(chunks, 3, -1)).toBe(-1);
  });
});

describe("revertEdit", () => {
  // Reverts (or appends) one block of the right side and returns the new right text.
  const run = (left: string, right: string, c: Chunk, append = false, eol = "\n") => {
    const e = revertEdit(c, left.split(eol), right.split(eol), eol, append);
    return e && applyEdit(right, e, eol);
  };

  it("reverts a modified block to the left lines", () => {
    expect(run("a\nB\nc", "a\nX\nY\nc", { a0: 1, a1: 2, b0: 1, b1: 3 })).toBe("a\nB\nc");
  });

  it("appends the left lines below a modified block", () => {
    expect(run("a\nB\nc", "a\nX\nY\nc", { a0: 1, a1: 2, b0: 1, b1: 3 }, true)).toBe("a\nX\nY\nB\nc");
  });

  it("removes added lines, including at the end of the file and the whole file", () => {
    expect(run("a\nc", "a\nb\nc", { a0: 1, a1: 1, b0: 1, b1: 2 })).toBe("a\nc");
    expect(run("a", "a\nb", { a0: 1, a1: 1, b0: 1, b1: 2 })).toBe("a");
    expect(run("", "x\ny", { a0: 0, a1: 0, b0: 0, b1: 2 })).toBe("");
  });

  it("restores deleted lines at the start, middle and end", () => {
    expect(run("a\nb", "b", { a0: 0, a1: 1, b0: 0, b1: 0 })).toBe("a\nb");
    expect(run("a\nb\nc", "a\nc", { a0: 1, a1: 2, b0: 1, b1: 1 })).toBe("a\nb\nc");
    expect(run("a\nb", "a", { a0: 1, a1: 2, b0: 1, b1: 1 })).toBe("a\nb");
  });

  it("has nothing to append for added lines", () => {
    expect(revertEdit({ a0: 1, a1: 1, b0: 1, b1: 2 }, ["a"], ["a", "b"], "\n", true)).toBeNull();
  });

  it("joins multi-line blocks with the right side's line ending", () => {
    expect(run("a\r\nB1\r\nB2\r\nc", "a\r\nX\r\nc", { a0: 1, a1: 3, b0: 1, b1: 2 }, false, "\r\n")).toBe("a\r\nB1\r\nB2\r\nc");
  });

  it("reverting every block from the bottom up gives back the left side", () => {
    const left = "head\nold 1\nkeep\nremoved\nkeep 2\ntail";
    const right = "head\nnew 1\nnew 1b\nkeep\nkeep 2\nadded\ntail";
    const chunks: Chunk[] = [
      { a0: 1, a1: 2, b0: 1, b1: 3 },
      { a0: 3, a1: 4, b0: 4, b1: 4 },
      { a0: 5, a1: 5, b0: 5, b1: 6 },
    ];
    let text = right;
    for (const c of [...chunks].reverse()) text = applyEdit(text, revertEdit(c, left.split("\n"), text.split("\n"), "\n")!);
    expect(text).toBe(left);
  });
});
