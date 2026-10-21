import { describe, expect, it } from "vitest";
import { chunkKind, connectorCurve, connectorPath, mapBoundary, nextChunk, toChunk } from "./diffLink";

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
