import { describe, expect, it } from "vitest";
import { parseWorktrees } from "./worktrees";

describe("parseWorktrees", () => {
  it("reads branches, detached heads and marks the main worktree", () => {
    const out = "worktree /src/app\nHEAD aaa\nbranch refs/heads/main\n\nworktree /src/app-fix\nHEAD bbb\nbranch refs/heads/fix/login\n\nworktree /src/app-x\nHEAD ccc\ndetached\n\n";
    expect(parseWorktrees(out)).toEqual([
      { path: "/src/app", head: "aaa", branch: "main", main: true },
      { path: "/src/app-fix", head: "bbb", branch: "fix/login", main: false },
      { path: "/src/app-x", head: "ccc", branch: null, main: false },
    ]);
  });
});
