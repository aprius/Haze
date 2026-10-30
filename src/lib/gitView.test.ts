import { describe, expect, it } from "vitest";
import {
  branchTree,
  changeDiffSpec,
  changeRows,
  checkedPaths,
  pickCheckpoint,
  moveRow,
  parseRebaseLog,
  pickRows,
  rebaseProblem,
  rebaseSteps,
  shownFiles,
  toggleChecks,
  validBranch,
  withUnsaved,
  type RebaseRow,
} from "./gitView";
import type { Branch, ChangeStatus, GitChange } from "./ipc";

const ch = (rel: string, status: ChangeStatus = "modified", oldRel: string | null = null): GitChange => ({ rel, oldRel, status, staged: false });

describe("withUnsaved", () => {
  it("adds unsaved files git does not list yet as modified", () => {
    const git = [ch("a.ts"), ch("new.ts", "untracked")];
    expect(withUnsaved(git, ["new.ts", "b.ts"])).toEqual([...git, ch("b.ts")]);
  });

  it("keeps the same list when every unsaved file is listed", () => {
    const git = [ch("a.ts")];
    expect(withUnsaved(git, ["a.ts"])).toBe(git);
  });
});

describe("changeRows", () => {
  const items = [ch("src/components/B.tsx"), ch("src/components/A.tsx"), ch("src/lib/x.ts"), ch("README.md"), ch("docs/guide/intro.md")];

  it("lists files as given when not grouped by directory", () => {
    expect(changeRows("changes", items, false, {}).map((r) => (r.kind === "file" ? r.change.rel : r.name))).toEqual(items.map((c) => c.rel));
  });

  it("builds a sorted tree, merging folders with a single child folder", () => {
    const rows = changeRows("changes", items, true, {});
    expect(rows.map((r) => [r.kind === "dir" ? r.name : r.change.rel, r.depth])).toEqual([
      ["docs/guide", 0],
      ["docs/guide/intro.md", 1],
      ["src", 0],
      ["components", 1],
      ["src/components/A.tsx", 2],
      ["src/components/B.tsx", 2],
      ["lib", 1],
      ["src/lib/x.ts", 2],
      ["README.md", 0],
    ]);
    const src = rows.find((r) => r.kind === "dir" && r.name === "src");
    expect(src?.kind === "dir" && src.files.map((c) => c.rel).sort()).toEqual(["src/components/A.tsx", "src/components/B.tsx", "src/lib/x.ts"]);
    expect(src?.kind === "dir" && src.key).toBe("changes:src");
  });

  it("hides the contents of collapsed folders", () => {
    const rows = changeRows("changes", items, true, { "changes:src/components": true });
    expect(rows.map((r) => (r.kind === "dir" ? r.name : r.change.rel))).toEqual(["docs/guide", "docs/guide/intro.md", "src", "components", "lib", "src/lib/x.ts", "README.md"]);
  });
});

describe("shownFiles", () => {
  const changes = [ch("new.txt", "untracked"), ch("b.cs"), ch("clash.cs", "conflict"), ch("a.cs", "added")];

  it("orders conflicts, then changes, then unversioned files", () => {
    expect(shownFiles(changes, false, {}).map((c) => c.rel)).toEqual(["clash.cs", "b.cs", "a.cs", "new.txt"]);
  });

  it("skips collapsed groups", () => {
    expect(shownFiles(changes, false, { changes: true }).map((c) => c.rel)).toEqual(["clash.cs", "new.txt"]);
  });
});

describe("changeDiffSpec", () => {
  it("compares with HEAD, from nothing for new files, from the old path for renames", () => {
    expect(changeDiffSpec("/r", ch("a.cs"))).toEqual({ root: "/r", rel: "a.cs", oldRel: null, left: "HEAD", right: "working" });
    expect(changeDiffSpec("/r", ch("n.cs", "untracked")).left).toBeNull();
    expect(changeDiffSpec("/r", ch("n.cs", "added")).left).toBeNull();
    expect(changeDiffSpec("/r", ch("new.cs", "renamed", "old.cs"))).toMatchObject({ oldRel: "old.cs", left: "HEAD" });
  });
});

describe("checkedPaths", () => {
  const changes = [ch("a.cs"), ch("b.cs", "deleted"), ch("new.txt", "untracked"), ch("clash.cs", "conflict")];

  it("ticks tracked changes by default, not unversioned files or conflicts", () => {
    expect([...checkedPaths({ checked: null, changes })]).toEqual(["a.cs", "b.cs"]);
  });

  it("keeps explicit ticks only for files that are still changed", () => {
    expect([...checkedPaths({ checked: ["new.txt", "gone.cs"], changes })]).toEqual(["new.txt"]);
    expect(checkedPaths({ checked: [], changes }).size).toBe(0);
  });
});

describe("pickRows", () => {
  const shown = ["a", "b", "c", "d", "e"];
  const none = { shiftKey: false, ctrlKey: false, metaKey: false };
  const ctrl = { ...none, ctrlKey: true };
  const shift = { ...none, shiftKey: true };
  const picks = (rels: string[], anchor: string | null) => ({ picked: new Set(rels), anchor });

  it("picks only the clicked row on a plain click", () => {
    expect(pickRows(shown, picks(["a", "b"], "a"), "b", "d", none)).toEqual(picks(["d"], "d"));
  });

  it("toggles with Ctrl or Cmd, starting from the shown file", () => {
    expect(pickRows(shown, picks([], null), "b", "d", ctrl)).toEqual(picks(["b", "d"], "d"));
    expect(pickRows(shown, picks(["b", "d"], "d"), "d", "b", { ...none, metaKey: true })).toEqual(picks(["d"], "b"));
    expect(pickRows(shown, picks([], null), null, "c", ctrl)).toEqual(picks(["c"], "c"));
  });

  it("picks the range from the anchor with Shift, in either direction, keeping the anchor", () => {
    expect(pickRows(shown, picks(["b"], "b"), "b", "d", shift)).toEqual(picks(["b", "c", "d"], "b"));
    expect(pickRows(shown, picks(["d"], "d"), "d", "a", shift)).toEqual(picks(["a", "b", "c", "d"], "d"));
  });

  it("treats Shift without a shown anchor as a plain click", () => {
    expect(pickRows(shown, picks([], null), null, "c", shift)).toEqual(picks(["c"], "c"));
    expect(pickRows(shown, picks(["x"], "x"), null, "c", shift)).toEqual(picks(["c"], "c"));
    // Nothing clicked yet: the range starts at the shown file.
    expect(pickRows(shown, picks([], null), "b", "d", shift)).toEqual(picks(["b", "c", "d"], "b"));
  });
});

describe("toggleChecks", () => {
  it("ticks all rows unless all are ticked, then unticks them", () => {
    expect([...toggleChecks(new Set(["a", "z"]), ["a", "b"])].sort()).toEqual(["a", "b", "z"]);
    expect([...toggleChecks(new Set(["a", "b", "z"]), ["a", "b"])]).toEqual(["z"]);
  });
});

describe("branchTree", () => {
  const b = (name: string): Branch => ({ name, refname: name, hash: "", upstream: null, ahead: 0, behind: 0, current: false, kind: "local" });

  it("nests branches by the slashes in their names", () => {
    const t = branchTree([b("main"), b("feature/login"), b("feature/ui/menu"), b("fix")]);
    expect(t.branches.map((x) => x.name)).toEqual(["main", "fix"]);
    const feature = t.folders.get("feature")!;
    expect(feature.branches.map((x) => x.name)).toEqual(["feature/login"]);
    expect(feature.folders.get("ui")!.branches.map((x) => x.name)).toEqual(["feature/ui/menu"]);
  });
});

describe("validBranch", () => {
  it("accepts ordinary names", () => {
    for (const name of ["main", "feature/login", "fix-1.2", "user_name/task"]) expect(validBranch(name)).toBeNull();
  });

  it("rejects empty names", () => {
    expect(validBranch("")).toBe("Name cannot be empty");
    expect(validBranch("   ")).toBe("Name cannot be empty");
  });

  it("rejects names git refuses", () => {
    for (const name of ["-x", "a b", "a..b", "a~1", "a^", "a:b", "a?", "a*", "a[b", "a\\b", "a/", "x.lock", "a@{1}"])
      expect(validBranch(name), name).toBe("Not a valid branch name");
  });
});

describe("interactive rebase", () => {
  const log = "h1\u001fFirst\u001fFirst\n\nBody line\n\u001e\nh2\u001fSecond\u001fSecond\n\u001e\n";
  const rows = parseRebaseLog(log);
  const row = (hash: string, action: RebaseRow["action"]): RebaseRow => ({ hash, subject: hash, action, message: `msg ${hash}` });

  it("parses the log into rows set to pick, with the full message", () => {
    expect(rows).toEqual([
      { hash: "h1", subject: "First", action: "pick", message: "First\n\nBody line" },
      { hash: "h2", subject: "Second", action: "pick", message: "Second" },
    ]);
    expect(parseRebaseLog("")).toEqual([]);
  });

  it("refuses an empty todo or one starting with squash/fixup", () => {
    expect(rebaseProblem(null)).toBe("Nothing to rebase");
    expect(rebaseProblem([row("a", "drop")])).toBe("Nothing to rebase");
    expect(rebaseProblem([row("a", "drop"), row("b", "fixup")])).toBe("The first commit cannot be squashed or fixed up.");
    expect(rebaseProblem([row("a", "pick"), row("b", "squash")])).toBeNull();
  });

  it("moves rows within bounds", () => {
    const list = [row("a", "pick"), row("b", "pick"), row("c", "pick")];
    expect(moveRow(list, 2, -1).map((r) => r.hash)).toEqual(["a", "c", "b"]);
    expect(moveRow(list, 0, -1)).toBe(list);
    expect(moveRow(list, 2, 1)).toBe(list);
  });

  it("sends a message only for reword", () => {
    expect(rebaseSteps([row("a", "reword"), row("b", "squash")])).toEqual([
      { action: "reword", hash: "a", message: "msg a" },
      { action: "squash", hash: "b", message: null },
    ]);
  });
});

describe("pickCheckpoint", () => {
  const cp = (hash: string) => ({ hash, time: 0, label: hash });

  it("follows the newest when the newest was shown", () => {
    expect(pickCheckpoint("b", [cp("b"), cp("a")], [cp("c"), cp("b"), cp("a")])).toBe("c");
    expect(pickCheckpoint(null, [], [cp("a")])).toBe("a");
  });

  it("keeps an older one picked while it lasts", () => {
    expect(pickCheckpoint("a", [cp("b"), cp("a")], [cp("c"), cp("b"), cp("a")])).toBe("a");
    expect(pickCheckpoint("a", [cp("b"), cp("a")], [cp("c"), cp("b")])).toBe("c");
    expect(pickCheckpoint("a", [cp("a")], [])).toBeNull();
  });
});
