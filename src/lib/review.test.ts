import { describe, expect, it } from "vitest";
import { buildReviewPrompt, commentLocation, hunkKey, type ReviewComment } from "./review";

const comment = (over: Partial<ReviewComment>): ReviewComment => ({
  id: "1",
  root: "/repo",
  rel: "src/A.cs",
  side: "new",
  rev: "working",
  startLine: 3,
  endLine: 3,
  code: "var x = 1;",
  text: "Rename x",
  createdAt: 0,
  ...over,
});

describe("commentLocation", () => {
  it("names the file and lines, and the revision unless it is the working copy", () => {
    expect(commentLocation(comment({}))).toBe("src/A.cs:3");
    expect(commentLocation(comment({ startLine: 3, endLine: 5 }))).toBe("src/A.cs:3-5");
    expect(commentLocation(comment({ rev: "0123456789abcdef0123" }))).toBe("src/A.cs:3 (at 01234567)");
    expect(commentLocation(comment({ side: "old", rev: "0123456789abcdef0123" }))).toBe("src/A.cs:3 (old version, 01234567)");
  });
});

describe("buildReviewPrompt", () => {
  it("numbers the comments by file and line, quoting the code", () => {
    const prompt = buildReviewPrompt([
      comment({ id: "2", rel: "src/B.cs", startLine: 1, endLine: 1, code: "class B {}", text: "Seal it" }),
      comment({ id: "1", startLine: 9, endLine: 10, code: "if (a)\n  b();", text: "Missing braces\nAlso log" }),
      comment({ id: "3", startLine: 2, endLine: 2 }),
    ]);
    expect(prompt).toBe(
      [
        "Please address these review comments:",
        "",
        "1. src/A.cs:2",
        "   > var x = 1;",
        "   Rename x",
        "",
        "2. src/A.cs:9-10",
        "   > if (a)",
        "   >   b();",
        "   Missing braces",
        "   Also log",
        "",
        "3. src/B.cs:1",
        "   > class B {}",
        "   Seal it",
      ].join("\n"),
    );
  });

  it("cuts long quotes short", () => {
    const code = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
    const prompt = buildReviewPrompt([comment({ code })]);
    expect(prompt.startsWith("Please address this review comment:")).toBe(true);
    expect(prompt).toContain("   > line 7\n   > …\n   Rename x");
    expect(prompt).not.toContain("line 8");
  });
});

describe("hunkKey", () => {
  it("depends on the content and the file, not on the position", () => {
    expect(hunkKey("/r", "a", ["x"], ["y"])).toBe(hunkKey("/r", "a", ["x"], ["y"]));
    expect(hunkKey("/r", "a", ["x"], ["y"])).not.toBe(hunkKey("/r", "a", ["x"], ["z"]));
    expect(hunkKey("/r", "a", ["x"], ["y"])).not.toBe(hunkKey("/r", "b", ["x"], ["y"]));
    expect(hunkKey("/r", "a", ["x", ""], [])).not.toBe(hunkKey("/r", "a", ["x"], [""]));
  });
});
