import { describe, expect, it } from "vitest";
import { ancestors, basename, dirname, isWithin, join, relative } from "./path";

describe("path helpers", () => {
  it("handles posix paths", () => {
    expect(basename("/a/b/c.cs")).toBe("c.cs");
    expect(dirname("/a/b/c.cs")).toBe("/a/b");
    expect(dirname("/a")).toBe("/");
    expect(join("/a/b", "c")).toBe("/a/b/c");
    expect(relative("/a", "/a/b/c")).toBe("b/c");
    expect(isWithin("/a/bc", "/a/b")).toBe(false);
    expect(ancestors("/r/x/y/z.cs", "/r")).toEqual(["/r/x/y", "/r/x", "/r"]);
  });

  it("handles windows paths", () => {
    expect(basename("C:\\a\\b.cs")).toBe("b.cs");
    expect(dirname("C:\\a\\b.cs")).toBe("C:\\a");
    expect(dirname("C:\\a")).toBe("C:\\");
    expect(join("C:\\a", "b")).toBe("C:\\a\\b");
    expect(isWithin("C:\\a\\b\\c", "C:\\a")).toBe(true);
  });
});
