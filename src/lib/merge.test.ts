import { describe, expect, it } from "vitest";
import { buildMerge, conflictRange, resolution, resolveEdit } from "./merge";
import { applyEdit } from "./testEdit";

describe("buildMerge", () => {
  it("applies non-conflicting changes from both sides", () => {
    const base = "a\nb\nc\nd\n";
    const ours = "A\nb\nc\nd\n";
    const theirs = "a\nb\nc\nD\n";
    const m = buildMerge(ours, base, theirs);
    expect(m.conflicts).toEqual([]);
    expect(m.result).toBe("A\nb\nc\nD\n");
  });

  it("keeps base text for conflicts and records both sides", () => {
    const base = "one\nvalue = 1\nend\n";
    const ours = "one\nvalue = 2\nend\n";
    const theirs = "one\nvalue = 3\nend\n";
    const m = buildMerge(ours, base, theirs);
    expect(m.conflicts).toHaveLength(1);
    const c = m.conflicts[0];
    expect(c.ours).toEqual(["value = 2"]);
    expect(c.theirs).toEqual(["value = 3"]);
    expect(c.base).toEqual(["value = 1"]);
    expect(c.resultStart).toBe(1);
    expect(m.result).toBe(base);
    expect(resolution(c, "both")).toEqual(["value = 2", "value = 3"]);
  });

  it("treats identical changes on both sides as no conflict and keeps CRLF", () => {
    const m = buildMerge("x\r\nsame\r\n", "x\r\nold\r\n", "x\r\nsame\r\n");
    expect(m.conflicts).toEqual([]);
    expect(m.eol).toBe("\r\n");
    expect(m.result).toBe("x\r\nsame\r\n");
  });
});

describe("resolveEdit", () => {
  // Resolves the only conflict the way the merge window does: from the range
  // it marks, where a mark at the end of the last line means "after it".
  const resolve = (ours: string, base: string, theirs: string, choice: "ours" | "theirs" | "both") => {
    const m = buildMerge(ours, base, theirs);
    expect(m.conflicts).toHaveLength(1);
    const c = m.conflicts[0];
    const lines = m.result.split(m.eol);
    const r = conflictRange(c, lines);
    const start = c.base.length === 0 && r.startColumn > 1 ? r.startLine + 1 : r.startLine;
    return applyEdit(m.result, resolveEdit(c, choice, start, r.endLine, lines, m.eol), m.eol);
  };
  const base = "one\nvalue = 1\nend\n";
  const ours = "one\nvalue = 2\nend\n";
  const theirs = "one\nvalue = 3\nend\n";

  it("replaces the base lines with the chosen side", () => {
    expect(resolve(ours, base, theirs, "ours")).toBe(ours);
    expect(resolve(ours, base, theirs, "theirs")).toBe(theirs);
    expect(resolve(ours, base, theirs, "both")).toBe("one\nvalue = 2\nvalue = 3\nend\n");
  });

  it("removes the conflict's lines when the chosen side deleted them", () => {
    expect(resolve("a\nb\n", "a\nx\nb\n", "a\ny\nb\n", "ours")).toBe("a\nb\n");
    expect(resolve("a\nb\n", "a\nx\nb\n", "a\ny\nb\n", "theirs")).toBe("a\ny\nb\n");
  });

  it("inserts both sides' additions where the base had nothing", () => {
    expect(resolve("a\nX\nb\n", "a\nb\n", "a\nY\nb\n", "ours")).toBe("a\nX\nb\n");
    expect(resolve("a\nX\nb\n", "a\nb\n", "a\nY\nb\n", "both")).toBe("a\nX\nY\nb\n");
  });

  it("adds after the last line when both sides append to a file without a final newline", () => {
    expect(resolve("a\nX", "a", "a\nY", "ours")).toBe("a\nX");
    expect(resolve("a\nX", "a", "a\nY", "theirs")).toBe("a\nY");
    expect(resolve("a\nX", "a", "a\nY", "both")).toBe("a\nX\nY");
    expect(resolve("a\r\nX", "a", "a\r\nY", "both")).toBe("a\r\nX\r\nY");
  });

  it("marks a conflict's base lines, or where an empty base goes", () => {
    const at = (ours: string, base: string, theirs: string) => {
      const m = buildMerge(ours, base, theirs);
      return conflictRange(m.conflicts[0], m.result.split(m.eol));
    };
    expect(at("a\nB\nC\nd\n", "a\nb\nc\nd\n", "a\nX\nY\nd\n")).toMatchObject({ startLine: 2, startColumn: 1, endLine: 3 });
    expect(at("a\nX\nb\n", "a\nb\n", "a\nY\nb\n")).toMatchObject({ startLine: 2, startColumn: 1, endLine: 2 });
    expect(at("ab\nX", "ab", "ab\nY")).toMatchObject({ startLine: 1, startColumn: 3, endLine: 1, endColumn: 3 });
  });

  it("keeps CRLF line endings", () => {
    expect(resolve("x\r\nours\r\n", "x\r\nbase\r\n", "x\r\ntheirs\r\n", "both")).toBe("x\r\nours\r\ntheirs\r\n");
  });

  it("resolves several conflicts independently", () => {
    const m = buildMerge("A1\nk\nA2\n", "a1\nk\na2\n", "B1\nk\nB2\n");
    expect(m.conflicts).toHaveLength(2);
    const [c1, c2] = m.conflicts;
    // Bottom one first, so the first conflict's lines stay where they are.
    let text = applyEdit(m.result, resolveEdit(c2, "theirs", c2.resultStart + 1, c2.resultStart + 1, m.result.split("\n"), "\n"));
    text = applyEdit(text, resolveEdit(c1, "ours", c1.resultStart + 1, c1.resultStart + 1, text.split("\n"), "\n"));
    expect(text).toBe("A1\nk\nB2\n");
  });
});
