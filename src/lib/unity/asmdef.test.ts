import { describe, expect, it } from "vitest";
import type { UnityProjectData } from "../ipc";
import { inspectAsmdef, parseJson, validVersionExpression } from "./asmdef";

const data: UnityProjectData = {
  tags: null,
  layers: null,
  axes: null,
  buildScenes: null,
  scenes: [],
  resources: [],
  animatorStates: null,
  shaders: [],
  assemblies: [
    { name: "Game", guid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", path: "/p/Assets/Game/Game.asmdef" },
    { name: "Game.Core", guid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", path: "/p/Assets/Core/Game.Core.asmdef" },
  ],
  compiled: ["Unity.TextMeshPro"],
  assembliesComplete: true,
};

const asmdef = (o: object) => JSON.stringify(o, null, 4);

describe("assembly definition inspections", () => {
  it("checks references", () => {
    const text = asmdef({
      name: "Game",
      references: ["GUID:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "Game.Core", "Unity.TextMeshPro", "Game", "GUID:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "Missing", "GUID:cccccccccccccccccccccccccccccccc"],
    });
    const got = inspectAsmdef(text, "/p/Assets/Game/Game.asmdef", data);
    expect(got.map((p) => [p.code, p.severity])).toEqual([
      ["PreferGuidReference", "hint"],
      ["ReferencingSelf", "error"],
      ["ReferencingSelf", "error"],
      ["UnresolvedProjectReference", "warning"],
      ["UnresolvedProjectReference", "warning"],
    ]);
    // Where "Game.Core" is, quotes included: line 4 (0-based).
    const line = text.split("\n")[4];
    expect(got[0].range.start).toEqual({ line: 4, character: line.indexOf('"Game.Core"') });
    expect(got[0].message).toContain("GUID:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  });

  it("leaves unresolved references alone when it can't know every assembly", () => {
    const text = asmdef({ name: "Game", references: ["Unity.ugui"] });
    expect(inspectAsmdef(text, "/p/Assets/Game/Game.asmdef", { ...data, assembliesComplete: false })).toEqual([]);
    expect(inspectAsmdef(text, "/p/Assets/Game/Game.asmdef", null)).toEqual([]);
  });

  it("checks the name, define constraints and version defines", () => {
    const text = asmdef({
      name: "Game.Editor",
      defineConstraints: ["UNITY_EDITOR", "!UNITY_WEBGL || DEBUG", "UNITY EDITOR", "A && B"],
      versionDefines: [
        { name: "com.unity.inputsystem", expression: "1.0.0", define: "INPUT_SYSTEM" },
        { name: "com.unity.render-pipelines.universal", expression: "[12.0,13.0)", define: "URP-12" },
        { name: "Unity", expression: "2021.3", define: "UNITY_2021" },
        { name: "com.a", expression: "1.0 - 2.0", define: "A" },
      ],
    });
    const got = inspectAsmdef(text, "/p/Assets/Game/Editor/GameEditor.asmdef", data);
    expect(got.map((p) => p.code)).toEqual([
      "MismatchedAsmDefFilename",
      "InvalidDefineConstraintExpression",
      "InvalidDefineConstraintExpression",
      "InvalidVersionDefineSymbol",
      "InvalidVersionDefineExpression",
    ]);
  });

  it("parses JSON with offsets and tells version expressions apart", () => {
    expect(parseJson('{"a": [1, "x\\"y"], "b": {}}')).toMatchObject({ kind: "object", props: [{ key: "a", value: { kind: "array", items: [{ kind: "other" }, { kind: "string", value: 'x"y', start: 10 }] } }, { key: "b" }] });
    expect(parseJson("{,}")).toBeNull();
    expect(parseJson('{"a": 1} x')).toBeNull();
    for (const ok of ["", "1.0", "[1.0,2.0]", "(1.0,2.0)", "[1.0,2.0)", "(,2.0]", "[1.0,)", "[1.2.3]", "2021.3.1f1", "1.0.0-pre.1"]) expect(validVersionExpression(ok), ok).toBe(true);
    for (const bad of ["[,]", "1.0 - 2.0", "[1.0;2.0]", "x1", "[1.0,2.0", ">=1.0"]) expect(validVersionExpression(bad), bad).toBe(false);
  });
});
