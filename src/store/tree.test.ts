import { afterEach, describe, expect, it, vi } from "vitest";
import type { FsChange, GitChange, GitStatus } from "../lib/ipc";
import { affectsGit, cappedDelay, isIgnored, mergeStatus, refreshGit, useTree } from "./tree";

const ipc = vi.hoisted(() => ({
  statusCalls: 0,
  finish: [] as (() => void)[],
  /** When set, statuses answer at once with this (full) and `part` (scoped). */
  full: null as GitStatus | null,
  part: null as GitStatus | null,
  scoped: [] as string[][],
}));

vi.mock("../lib/ipc", () => ({
  errorMessage: String,
  api: {
    gitStatus: () =>
      new Promise<GitStatus>((resolve) => {
        ipc.statusCalls++;
        if (ipc.full) return resolve(ipc.full);
        ipc.finish.push(() => resolve({ isRepo: true, root: "/r", branch: "main", files: {}, changes: [] }));
      }),
    gitStatusPaths: async (_top: string, paths: string[]) => {
      ipc.scoped.push(paths);
      return ipc.part!;
    },
  },
}));

const change = (files: string[], extra: Partial<FsChange> = {}): FsChange => ({
  root: "/r",
  dirs: [],
  files,
  created: [],
  removed: [],
  overflow: false,
  lost: false,
  git: false,
  ...extra,
});

describe("affectsGit", () => {
  useTree.setState({
    git: {
      p: {
        status: { isRepo: true, root: "/r", branch: "main", files: { "/r/bin": "ignored", "/r/A.cs": "modified" }, changes: [] },
        changedDirs: new Set(["/r"]),
        ignored: ["/r/bin", "C:/w/obj"],
      },
    },
  });
  const view = useTree.getState().git.p;

  it("skips changes that only touch ignored paths", () => {
    expect(affectsGit("p", change(["/r/bin/Debug/App.dll", "/r/bin"]))).toBe(false);
    expect(isIgnored(view, "C:\\w\\obj\\x.json")).toBe(true);
    expect(isIgnored(view, "/r/binary.cs")).toBe(false);
  });

  it("refreshes for tracked files, git metadata and overflow", () => {
    expect(affectsGit("p", change(["/r/bin/x.dll", "/r/A.cs"]))).toBe(true);
    expect(affectsGit("p", change([], { git: true }))).toBe(true);
    expect(affectsGit("p", change([], { overflow: true }))).toBe(true);
    expect(affectsGit("unknown", change(["/r/bin/x.dll"]))).toBe(true);
  });
});

describe("cappedDelay", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps the debounce but never waits past the cap", () => {
    vi.useFakeTimers();
    const since = new Map<string, number>();
    expect(cappedDelay(since, "p", 300)).toBe(300);
    vi.advanceTimersByTime(1500);
    expect(cappedDelay(since, "p", 300)).toBe(300);
    vi.advanceTimersByTime(300);
    // A change every 100 ms: the refresh still runs 2 s after the first one.
    expect(cappedDelay(since, "p", 300)).toBe(200);
    vi.advanceTimersByTime(500);
    expect(cappedDelay(since, "p", 300)).toBe(0);
    // Other projects wait on their own.
    expect(cappedDelay(since, "q", 300)).toBe(300);
  });
});

describe("refreshGit", () => {
  afterEach(() => vi.useRealTimers());

  it("runs one git status at a time, then once more for requests meanwhile", async () => {
    vi.useFakeTimers();
    refreshGit("s", "/r");
    await vi.advanceTimersByTimeAsync(0);
    expect(ipc.statusCalls).toBe(1);
    // Changes keep coming while it runs: they wait, and make a single rerun.
    for (let i = 0; i < 5; i++) {
      refreshGit("s", "/r");
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(ipc.statusCalls).toBe(1);
    ipc.finish.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    expect(ipc.statusCalls).toBe(2);
    ipc.finish.shift()!();
    await vi.advanceTimersByTimeAsync(0);
    expect(ipc.statusCalls).toBe(2);
    expect(useTree.getState().git.s?.status.branch).toBe("main");
  });
});

const ch = (rel: string, status: GitChange["status"], oldRel: string | null = null): GitChange => ({ rel, oldRel, status, staged: false });
const st = (files: GitStatus["files"], changes: GitChange[], branch = "main"): GitStatus => ({ isRepo: true, root: "/r", branch, files, changes });

describe("mergeStatus", () => {
  it("replaces entries under the scoped paths and keeps the rest", () => {
    const prev = st(
      { "/r/A.cs": "modified", "/r/d/B.cs": "untracked", "/r/d/C.cs": "modified", "/r/bin": "ignored" },
      [ch("A.cs", "modified"), ch("d/C.cs", "modified"), ch("d/B.cs", "untracked")],
    );
    // `d` was removed and re-created with only C.cs changed; E.cs is new; bin/x.dll reports its ignored folder.
    const part = st({ "/r/d/C.cs": "deleted", "/r/E.cs": "untracked", "/r/bin": "ignored" }, [ch("d/C.cs", "deleted"), ch("E.cs", "untracked")], "dev");
    const merged = mergeStatus(prev, part, ["d", "E.cs", "bin/x.dll"]);
    expect(merged.files).toEqual({ "/r/A.cs": "modified", "/r/d/C.cs": "deleted", "/r/E.cs": "untracked", "/r/bin": "ignored" });
    expect(merged.changes.map((c) => c.rel)).toEqual(["A.cs", "d/C.cs", "E.cs"]);
    // An entry git names above the scope (a repository inside) is not listed twice.
    const nested = mergeStatus(st({}, [ch("inner/", "untracked")]), st({}, [ch("inner/", "untracked")]), ["inner/f.cs"]);
    expect(nested.changes).toHaveLength(1);
    expect(merged.branch).toBe("dev");
    // `dd` is not under `d`.
    expect(mergeStatus(st({ "/r/dd/X.cs": "modified" }, [ch("dd/X.cs", "modified")]), st({}, []), ["d"]).changes).toHaveLength(1);
  });
});

describe("scoped refreshGit", () => {
  afterEach(() => {
    vi.useRealTimers();
    ipc.full = ipc.part = null;
    ipc.scoped = [];
  });

  it("asks git about the changed paths only, and everything when it cannot", async () => {
    vi.useFakeTimers();
    ipc.full = st({ "/r/A.cs": "modified" }, [ch("A.cs", "modified"), ch("New.cs", "renamed", "Old.cs")]);
    ipc.part = st({ "/r/B.cs": "untracked" }, [ch("B.cs", "untracked")]);
    const calls = ipc.statusCalls;
    refreshGit("m", "/r");
    await vi.advanceTimersByTimeAsync(0);
    expect(ipc.statusCalls).toBe(calls + 1);

    // Two changes in one debounce: one scoped status for both.
    refreshGit("m", "/r", 300, ["/r/B.cs"]);
    refreshGit("m", "/r", 300, ["/r/C.cs"]);
    await vi.advanceTimersByTimeAsync(300);
    expect(ipc.scoped).toEqual([["/r/B.cs", "/r/C.cs"]]);
    expect(ipc.statusCalls).toBe(calls + 1);
    expect(useTree.getState().git.m.status.files).toEqual({ "/r/A.cs": "modified", "/r/B.cs": "untracked" });

    // Part of a staged rename, a .gitignore, a path outside: the whole tree.
    for (const path of ["/r/Old.cs", "/r/sub/.gitignore", "/elsewhere/X.cs"]) {
      refreshGit("m", "/r", 0, [path]);
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(ipc.scoped).toHaveLength(1);
    expect(ipc.statusCalls).toBe(calls + 4);

    // No paths is no pathspec: that would be everything, merged as if scoped.
    refreshGit("m", "/r", 0, []);
    await vi.advanceTimersByTimeAsync(0);
    expect(ipc.scoped).toHaveLength(1);
    expect(ipc.statusCalls).toBe(calls + 5);
  });
});
