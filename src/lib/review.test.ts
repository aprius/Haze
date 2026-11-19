import { describe, expect, it } from "vitest";
import { buildReviewPrompt, commentLocation, fenceLanguage, hunkKey, quoteLines, type ReviewComment } from "./review";

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
  it("numbers the comments by file and line, the code fenced and the comment labelled", () => {
    const prompt = buildReviewPrompt([
      comment({ id: "2", rel: "src/b.py", startLine: 1, endLine: 1, code: "class B: pass", text: "Seal it" }),
      comment({ id: "1", startLine: 9, endLine: 10, code: "if (a)\n  b();", text: "Missing braces\nAlso log" }),
      comment({ id: "3", startLine: 2, endLine: 2, rel: "notes.unknownext" }),
    ]);
    expect(prompt).toBe(
      [
        "Review comments on the code. Answer the questions; change the code only where a comment asks for it.",
        "",
        "1. notes.unknownext:2",
        "   ```",
        "   var x = 1;",
        "   ```",
        "   Comment: Rename x",
        "",
        "2. src/A.cs:9-10",
        "   ```csharp",
        "   if (a)",
        "     b();",
        "   ```",
        "   Comment: Missing braces",
        "   Also log",
        "",
        "3. src/b.py:1",
        "   ```python",
        "   class B: pass",
        "   ```",
        "   Comment: Seal it",
      ].join("\n"),
    );
  });

  it("keeps comments in the code inside the block, and drops their shared indentation", () => {
    const prompt = buildReviewPrompt([comment({ code: "        // this comment\n\n        void Start()\n        {", text: "> 0 then?" })]);
    expect(prompt).toContain("   ```csharp\n   // this comment\n\n   void Start()\n   {\n   ```\n   Comment: > 0 then?");
  });

  it("uses a fence longer than any backticks in the code", () => {
    const prompt = buildReviewPrompt([comment({ rel: "README.md", code: "```bash\nls\n```" })]);
    expect(prompt).toContain("   ````markdown\n   ```bash\n   ls\n   ```\n   ````\n   Comment: Rename x");
  });

  it("quotes up to 20 lines whole", () => {
    const code = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const prompt = buildReviewPrompt([comment({ code })]);
    expect(prompt).toContain("   line 0\n");
    expect(prompt).toContain("   line 19\n   ```\n   Comment: Rename x");
    expect(prompt).not.toContain("…");
  });
});

describe("quoteLines", () => {
  it("keeps the start and the end of a long quote", () => {
    const lines = quoteLines(Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\r\n"));
    expect(lines).toHaveLength(19);
    expect(lines.slice(0, 12)).toEqual(Array.from({ length: 12 }, (_, i) => `line ${i}`));
    expect(lines[12]).toBe("… (12 more lines)");
    expect(lines.slice(13)).toEqual(Array.from({ length: 6 }, (_, i) => `line ${24 + i}`));
  });
});

describe("fenceLanguage", () => {
  it("maps extensions to Markdown languages", () => {
    expect(fenceLanguage("Assets/Menu.cs")).toBe("csharp");
    expect(fenceLanguage("a/b.SHADER")).toBe("hlsl");
    expect(fenceLanguage("Makefile")).toBe("");
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
