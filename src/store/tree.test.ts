import { describe, expect, it } from "vitest";
import type { FsChange } from "../lib/ipc";
import { affectsGit, isIgnored, useTree } from "./tree";

const change = (files: string[], extra: Partial<FsChange> = {}): FsChange => ({
  root: "/r",
  dirs: [],
  files,
  created: [],
  removed: [],
  overflow: false,
  git: false,
  ...extra,
});

describe("affectsGit", () => {
  useTree.setState({
    git: {
      p: {
        status: { isRepo: true, root: "/r", branch: "main", files: { "/r/bin": "ignored", "/r/A.cs": "modified" } },
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
