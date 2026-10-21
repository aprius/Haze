import { describe, expect, it } from "vitest";
import { diffPath, diffTitle, mergePath, mergeTitle, parseDiffPath, parseMergePath, type DiffSpec } from "./diffSpec";

const hash = "0123456789abcdef0123456789abcdef01234567";

describe("diff and merge tab paths", () => {
  it("round-trips specs through the tab path", () => {
    const spec: DiffSpec = { root: "C:\\repo", rel: "src/a b.cs", oldRel: "old.cs", left: "HEAD", right: "working" };
    expect(parseDiffPath(diffPath(spec))).toEqual(spec);
    expect(parseMergePath(mergePath({ root: "/r", rel: "x.cs" }))).toEqual({ root: "/r", rel: "x.cs" });
  });

  it("rejects other paths and broken specs", () => {
    expect(parseDiffPath("/r/src/a.cs")).toBeNull();
    expect(parseDiffPath("haze-diff:{oops")).toBeNull();
    expect(parseDiffPath(mergePath({ root: "/r", rel: "x.cs" }))).toBeNull();
    expect(parseMergePath(diffPath({ root: "/r", rel: "x.cs", left: null, right: "working" }))).toBeNull();
  });

  it("titles diffs with short revisions, ∅ for nothing and Local for the working copy", () => {
    expect(diffTitle({ root: "/r", rel: "src/a.cs", left: "HEAD", right: "working" })).toBe("a.cs (HEAD ↔ Local)");
    expect(diffTitle({ root: "/r", rel: "a.cs", left: null, right: hash })).toBe("a.cs (∅ ↔ 01234567)");
    expect(diffTitle({ root: "/r", rel: "a.cs", left: hash + "^", right: hash })).toBe("a.cs (01234567^ ↔ 01234567)");
    expect(mergeTitle({ root: "/r", rel: "dir/x.cs" })).toBe("Merge x.cs");
  });
});
