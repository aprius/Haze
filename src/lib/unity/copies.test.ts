import { describe, expect, it } from "vitest";
import { copyOfPath } from "./copies";

describe("copyOfPath", () => {
  const roots = ["/w/Game", "/w/Game-task", "/w/Game/.worktrees/fix", "C:\\w\\Game"];

  it("needs a whole folder name: Game-task is not inside Game", () => {
    expect(copyOfPath("/w/Game-task/Assets", roots)).toBe("/w/Game-task");
    expect(copyOfPath("/w/Game", roots)).toBe("/w/Game");
    expect(copyOfPath("/w/GamePlay", roots)).toBeNull();
  });

  it("takes the deepest root and Windows paths", () => {
    expect(copyOfPath("/w/Game/.worktrees/fix/Assets", roots)).toBe("/w/Game/.worktrees/fix");
    expect(copyOfPath("C:\\w\\Game\\Assets", roots)).toBe("C:\\w\\Game");
  });
});
