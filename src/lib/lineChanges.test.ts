import { describe, expect, it } from "vitest";
import { lineChanges, lineMapper } from "./lineChanges";

const text = (...l: string[]) => l.join("\n");

describe("lineChanges", () => {
  it("finds nothing in identical text, whatever the line endings", () => {
    expect(lineChanges(text("a", "b"), "a\r\nb")).toEqual([]);
  });

  it("marks added lines", () => {
    expect(lineChanges(text("a", "b"), text("a", "x", "y", "b"))).toEqual([{ kind: "added", start: 2, end: 3 }]);
  });

  it("marks modified lines", () => {
    expect(lineChanges(text("a", "b", "c"), text("a", "B", "c"))).toEqual([{ kind: "modified", start: 2, end: 2 }]);
  });

  it("marks a deletion after the line it follows", () => {
    expect(lineChanges(text("a", "b", "c"), text("a", "c"))).toEqual([{ kind: "deleted", start: 1, end: 1 }]);
    expect(lineChanges(text("a", "b"), text("b"))).toEqual([{ kind: "deleted", start: 0, end: 0 }]);
  });

  it("finds separate changes", () => {
    expect(lineChanges(text("a", "b", "c", "d", "e"), text("a", "B", "c", "e", "f"))).toEqual([
      { kind: "modified", start: 2, end: 2 },
      { kind: "deleted", start: 3, end: 3 },
      { kind: "added", start: 5, end: 5 },
    ]);
  });

  it("marks every line of a new file as added", () => {
    expect(lineChanges("", text("a", "b"))).toEqual([{ kind: "added", start: 1, end: 2 }]);
  });
});

describe("lineMapper", () => {
  const map = (base: string, current: string) => {
    const m = lineMapper(base, current);
    return current.split(/\r?\n/).map((_, i) => m(i + 1));
  };

  it("maps unchanged lines across added, modified and deleted ones", () => {
    // base: a b c d e f; current: a X c e f g
    expect(map(text("a", "b", "c", "d", "e", "f"), text("a", "X", "c", "e", "f", "g"))).toEqual([1, null, 3, 5, 6, null]);
    expect(map(text("a", "b"), text("n", "a", "b"))).toEqual([null, 1, 2]);
    expect(map(text("a", "b", "c"), text("a", "c"))).toEqual([1, 3]);
    expect(map(text("a", "b"), "a\r\nb")).toEqual([1, 2]);
  });

  it("maps the shared start and end around a change in the middle", () => {
    const base = text("1", "2", "3", "4", "5", "6", "7");
    expect(map(base, text("1", "2", "x", "y", "3", "4", "6", "7"))).toEqual([1, 2, null, null, 3, 4, 6, 7]);
  });

  it("answers null outside the text", () => {
    const m = lineMapper(text("a"), text("a"));
    expect([m(0), m(2)]).toEqual([null, null]);
  });
});

describe("diff", () => {
  // A C#-like file: braces and blank lines match everywhere.
  const csharp = (n: number) => {
    const out: string[] = [];
    for (let i = 0; out.length < n; i++) out.push(`    void M${i}()`, "    {", `        Call(${i});`, "    }", "");
    return out.slice(0, n);
  };

  it("calls the second of two identical lines the added one, like git", () => {
    expect(lineChanges(text("f();", "}", "", "x"), text("f();", "}", "}", "", "x"))).toEqual([{ kind: "added", start: 3, end: 3 }]);
    expect(lineChanges(text("a", "", "", "b"), text("a", "", "b"))).toEqual([{ kind: "deleted", start: 2, end: 2 }]);
  });

  it("stays fast with edits far apart in a large file", () => {
    const base = csharp(10_000);
    const cur = [...base];
    cur.splice(3, 0, "        Log();");
    cur.splice(cur.length - 3, 0, "        Log();");
    const t = performance.now();
    // The LCS this replaced took about 39 s here.
    expect(lineChanges(base.join("\n"), cur.join("\n"))).toEqual([
      { kind: "added", start: 4, end: 4 },
      { kind: "added", start: cur.length - 3, end: cur.length - 3 },
    ]);
    expect(performance.now() - t).toBeLessThan(1000);
  });

  it("calls a change too large to diff modified as a whole", () => {
    const base = csharp(20_000);
    // Every statement differs: far more edits than the diff looks for.
    const cur = base.map((l) => (l.includes("Call") ? l + " // x" : l));
    const t = performance.now();
    const changes = lineChanges(base.join("\n"), cur.join("\n"));
    expect(performance.now() - t).toBeLessThan(1000);
    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe("modified");
    const m = lineMapper(base.join("\n"), cur.join("\n"));
    expect([m(1), m(2), m(3)]).toEqual([1, 2, null]);
  });
});
