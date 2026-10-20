import { describe, expect, it, vi } from "vitest";

vi.mock("../monaco", () => ({ monaco: {} }));

const { uriToPath, toLocations } = await import("./convert");

describe("lsp conversions", () => {
  it("maps file URIs to OS paths", () => {
    expect(uriToPath("file:///home/u/My%20App/A.cs", false)).toBe("/home/u/My App/A.cs");
    expect(uriToPath("file:///c%3A/work/App/A.cs", true)).toBe("C:\\work\\App\\A.cs");
    expect(uriToPath("file:///C:/work/A.cs", true)).toBe("C:\\work\\A.cs");
  });

  it("normalizes locations and links", () => {
    const range = { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } };
    expect(toLocations(null)).toEqual([]);
    expect(toLocations({ uri: "file:///a", range })).toEqual([{ uri: "file:///a", range }]);
    expect(toLocations([{ targetUri: "file:///b", targetRange: range, targetSelectionRange: range }])).toEqual([
      { uri: "file:///b", range },
    ]);
  });
});
