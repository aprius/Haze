import { describe, expect, it } from "vitest";
import { iconName } from "./fileIcons";

describe("iconName", () => {
  it("picks file icons by extension and name", () => {
    expect(iconName("Player.cs", false)).toBe("Csharp");
    expect(iconName("Main.unity", false)).toBe("FileUnity");
    expect(iconName("Hero.prefab", false)).toBe("FileUnityPrefab");
    expect(iconName("Player.cs.meta", false)).toBe("FileUnityMeta");
    expect(iconName("Game.asmdef", false)).toBe("Asmdef");
    expect(iconName(".gitignore", false)).toBe("gitignore");
    expect(iconName("Dockerfile", false)).toBe("docker");
    expect(iconName("model.fbx", false)).toBe("unknown");
  });

  it("marks Unity's special folders only in the Unity view", () => {
    expect(iconName("Editor", true, true)).toBe("FolderEditor");
    expect(iconName("Editor", true)).toBe("folder");
    expect(iconName("Scripts", true, true)).toBe("folder");
    expect(iconName("com.unity.ugui", true, true, "packageReferenced")).toBe("FolderPackageReferenced");
  });
});
