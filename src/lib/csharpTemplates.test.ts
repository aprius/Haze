import { describe, expect, it } from "vitest";
import { blockContext, templateBody, templatesFor, TEMPLATES } from "./csharpTemplates";

const at = (src: string) => {
  const o = src.indexOf("|");
  return blockContext(src.slice(0, o) + src.slice(o + 1), o);
};

describe("blockContext", () => {
  it("tells the top level, type bodies and code apart", () => {
    expect(at("using UnityEngine;\n|")).toEqual({ kind: "top" });
    expect(at("namespace Game\n{\n    |\n}")).toEqual({ kind: "top" });
    expect(at("namespace Game;\npublic class Player : MonoBehaviour\n{\n    |\n}")).toEqual({ kind: "type", typeName: "Player" });
    expect(at("public class Pool<T> where T : class\n{\n    |")).toEqual({ kind: "type", typeName: "Pool" });
    expect(at("class Player\n{\n    void Update()\n    {\n        |\n    }\n}")).toEqual({ kind: "code", typeName: "Player" });
    expect(at("class Player\n{\n    void Update()\n    {\n        if (x) { }\n        |")).toEqual({ kind: "code", typeName: "Player" });
    expect(at("class A\n{\n    class B\n    {\n    }\n    |")).toEqual({ kind: "type", typeName: "A" });
    expect(at("record Point(int X)\n{\n    |")).toEqual({ kind: "type", typeName: "Point" });
  });

  it("skips braces in strings, comments and directives", () => {
    expect(at('class A\n{\n    string s = "{";\n    // {\n    /* { */\n    char c = \'{\';\n    |')).toEqual({ kind: "type", typeName: "A" });
    expect(at('class A\n{\n    void F()\n    {\n        var s = $"{x}";\n        |')).toEqual({ kind: "code", typeName: "A" });
  });

  it("treats a lambda, an initializer or an enum body as code", () => {
    expect(at("class A\n{\n    Action a = () =>\n    {\n        |")).toEqual({ kind: "code", typeName: "A" });
    expect(at("enum E\n{\n    |")).toEqual({ kind: "code" });
    expect(at("class A\n{\n    void F()\n    {\n        class |")).toEqual({ kind: "code", typeName: "A" });
  });
});

describe("templatesFor", () => {
  const keys = (kind: "top" | "type" | "code", before: string, word: string) => templatesFor({ kind }, before, word).map((t) => t.key);
  it("offers the templates that fit where the caret is", () => {
    expect(keys("type", "    ", "pro")).toEqual(["prop", "propg"]);
    expect(keys("code", "    ", "pro")).toEqual([]);
    expect(keys("code", "        ", "fo")).toEqual(["for", "forr", "fore"]);
    expect(keys("top", "", "mo")).toEqual(["mono"]);
    expect(keys("code", "        var rb = ", "gc")).toEqual(["gc"]);
    expect(keys("code", "        var rb = ", "dl")).toEqual([]);
    expect(keys("code", "    ", "")).toEqual([]);
  });

  it("fills the type and file names", () => {
    const ctor = TEMPLATES.find((t) => t.key === "ctor")!;
    expect(templateBody(ctor, { typeName: "Player", fileName: "Player" })).toBe("public Player($1)\n{\n\t$0\n}");
    const mono = TEMPLATES.find((t) => t.key === "mono")!;
    expect(templateBody(mono, { fileName: "En$emy" })).toBe("public class ${1:En\\$emy} : MonoBehaviour\n{\n\t$0\n}");
  });

  it("has unique keys", () => {
    expect(new Set(TEMPLATES.map((t) => t.key)).size).toBe(TEMPLATES.length);
  });
});
