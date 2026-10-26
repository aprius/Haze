import { describe, expect, it } from "vitest";
import type { UnityCode, UnityProjectData, UnityRef } from "../ipc";
import { inspectUnityCode, sceneMatches, unityNames } from "./inspections";

const r = (line: number) => ({ start: { line, character: 4 }, end: { line, character: 12 } });
const data: UnityProjectData = {
  tags: ["Untagged", "Player", "Enemy"],
  layers: ["Default", "UI", "Ground"],
  axes: ["Horizontal", "Vertical", "Jump", "Jump"],
  buildScenes: [
    { path: "Assets/Scenes/Menu.unity", enabled: true },
    { path: "Assets/Scenes/Level1.unity", enabled: true },
    { path: "Assets/Tests/Menu.unity", enabled: true },
    { path: "Assets/Scenes/Debug.unity", enabled: false },
  ],
  scenes: ["Assets/Scenes/Menu.unity", "Assets/Scenes/Level1.unity", "Assets/Tests/Menu.unity", "Assets/Scenes/Debug.unity", "Assets/Scenes/Sandbox.unity"],
  resources: ["UI/Icon.png", "Levels/One.asset", "Config.json"],
  animatorStates: ["Idle", "Run"],
  shaders: ["Custom/Water"],
  assemblies: [],
  compiled: [],
  assembliesComplete: true,
};

function problems(refs: [UnityRef["kind"], string][], d: UnityProjectData | null = data) {
  const code: UnityCode = { refs: refs.map(([kind, value], i) => ({ kind, value, range: r(i) })), setParent: [] };
  return inspectUnityCode(code, d).map((p) => [p.range.start.line, p.code, p.message]);
}

describe("Unity inspections", () => {
  it("knows the project's tags, layers and input axes", () => {
    const got = problems([
      ["tag", "Enemy"],
      ["tag", "Boss"],
      ["tag", ""],
      ["layer", "Ground"],
      ["layer", "Water"],
      ["axis", "Horizontal"],
      ["axis", "Fire3"],
    ]);
    expect(got.map((p) => p.slice(0, 2))).toEqual([
      [1, "UnknownTag"],
      [4, "UnknownLayer"],
      [6, "UnknownInputAxes"],
    ]);
    expect(got[0][2]).toBe('The tag "Boss" is not defined in the Tag Manager.');
  });

  it("checks scenes against the Build Settings", () => {
    const got = problems([
      ["scene", "Level1"],
      ["scene", "Scenes/Level1"],
      ["scene", "Assets/Scenes/Level1.unity"],
      ["scene", "Debug"],
      ["scene", "Menu"],
      ["scene", "Sandbox"],
      ["scene", "Nowhere"],
      ["sceneIndex", "2"],
      ["sceneIndex", "3"],
      ["editorScene", "Assets/Scenes/Sandbox.unity"],
      ["editorScene", "Assets/Gone.unity"],
    ]);
    expect(got.map((p) => p.slice(0, 2))).toEqual([
      [3, "LoadSceneDisabledSceneName"],
      [4, "LoadSceneAmbiguousSceneName"],
      [5, "LoadSceneUnknownSceneName"],
      [6, "LoadSceneUnexistingSceneName"],
      [8, "LoadSceneWrongIndex"],
      [10, "LoadSceneUnexistingSceneName"],
    ]);
    expect(sceneMatches("Assets/Scenes/Menu.unity", "enes/Menu")).toBe(false);
  });

  it("checks Resources paths, Animator states and shaders", () => {
    const got = problems([
      ["resource", "UI/Icon"],
      ["resource", "ui/icon"],
      ["resource", "UI/Icon.png"],
      ["resource", "UI/Missing"],
      ["resourceFolder", "Levels"],
      ["resourceFolder", "Sounds"],
      ["animatorState", "Run"],
      ["animatorState", "Base Layer.Idle"],
      ["animatorState", "Fly"],
      ["shader", "Custom/Water"],
      ["shader", "Standard"],
      ["shader", "Custom/Lava"],
    ]);
    expect(got.map((p) => p.slice(0, 2))).toEqual([
      [2, "UnknownResource"],
      [3, "UnknownResource"],
      [5, "UnknownResource"],
      [8, "UnknownAnimatorStateName"],
      [11, "ShaderLabShaderReferenceNotResolved"],
    ]);
    expect(got[0][2]).toBe('Resources paths have no file extension: "UI/Icon".');
  });

  it("checks nothing it could not read", () => {
    const unread: UnityProjectData = { ...data, tags: null, layers: null, axes: null, buildScenes: null, animatorStates: null };
    expect(problems([["tag", "Boss"], ["layer", "X"], ["axis", "X"], ["scene", "X"], ["sceneIndex", "9"], ["animatorState", "X"]], unread)).toEqual([]);
    expect(problems([["tag", "Boss"]], null)).toEqual([]);
  });

  it("suggests passing the parent to Instantiate", () => {
    const setParent = [
      { range: r(5), instantiate: r(4), original: "prefab", parent: "root", world: true },
      { range: r(8), instantiate: r(7), original: "prefab", parent: "root", world: false },
    ];
    const got = inspectUnityCode({ refs: [], setParent }, null);
    expect(got.map((p) => [p.code, p.severity])).toEqual([
      ["InstantiateWithoutParent", "info"],
      ["InstantiateWithoutParent", "info"],
    ]);
    expect(got[0].message).toContain("Instantiate(prefab, root, true)");
    expect(got[1].message).toContain("Instantiate(prefab, root).");
  });

  it("lists names to complete", () => {
    expect(unityNames("scene", data)).toEqual(["Menu", "Level1", "Menu"]);
    expect(unityNames("resource", data)).toEqual(["UI/Icon", "Levels/One", "Config"]);
    expect(unityNames("resourceFolder", data)).toEqual(["UI", "Levels"]);
    expect(unityNames("shader", data)).toContain("Standard");
    expect(unityNames("shader", data).some((s) => s.startsWith("Hidden/"))).toBe(false);
  });
});
