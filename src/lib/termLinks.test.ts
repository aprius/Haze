import { describe, expect, it } from "vitest";
import { findPathCandidates, parseOscCwd } from "./termLinks";

describe("findPathCandidates", () => {
  it("parses msbuild diagnostics", () => {
    const [m] = findPathCandidates("/repo/src/Program.cs(12,5): error CS1002: ; expected");
    expect(m).toMatchObject({ path: "/repo/src/Program.cs", line: 12, column: 5, index: 0 });
  });

  it("parses windows paths", () => {
    const [m] = findPathCandidates("C:\\work\\App\\Startup.cs(3,1): warning CS0168");
    expect(m).toMatchObject({ path: "C:\\work\\App\\Startup.cs", line: 3, column: 1 });
  });

  it("parses colon line numbers and relative paths", () => {
    const ms = findPathCandidates("  at src/app.ts:42:7 and ./README.md");
    expect(ms.map((m) => [m.path, m.line, m.column])).toEqual([
      ["src/app.ts", 42, 7],
      ["./README.md", undefined, undefined],
    ]);
  });

  it("ignores urls", () => {
    expect(findPathCandidates("see https://example.com/docs/index.html")).toEqual([]);
  });
});

describe("parseOscCwd", () => {
  it("reads OSC 7 file URLs", () => {
    expect(parseOscCwd(7, "file://my-host/home/me/My%20App")).toBe("/home/me/My App");
    expect(parseOscCwd(7, "file:///C:/work/App")).toBe("C:/work/App");
    expect(parseOscCwd(7, "not a url")).toBeNull();
  });

  it("reads OSC 9;9 and ignores other OSC 9 messages", () => {
    expect(parseOscCwd(9, '9;"C:\\work\\App"')).toBe("C:\\work\\App");
    expect(parseOscCwd(9, "build finished")).toBeNull();
  });
});
