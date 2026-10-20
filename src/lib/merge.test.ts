import { describe, expect, it } from "vitest";
import { buildMerge, resolution } from "./merge";

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
