import { describe, expect, it } from "vitest";
import { addUsings, importedNamespace } from "./csharpUsings";

const apply = (text: string, ns: string[]) => {
  const { inserts } = addUsings(text, ns);
  let out = text;
  for (const i of [...inserts].sort((a, b) => b.offset - a.offset)) out = out.slice(0, i.offset) + i.text + out.slice(i.offset);
  return out;
};

describe("addUsings", () => {
  it("puts each directive where it sorts, System first", () => {
    expect(apply("using System;\nusing UnityEngine;\n\nclass A {}", ["System.Linq", "DG.Tweening", "UnityEngine.UI"])).toBe(
      "using System;\nusing System.Linq;\nusing DG.Tweening;\nusing UnityEngine;\nusing UnityEngine.UI;\n\nclass A {}",
    );
  });
  it("adds a block when there is none, after a leading comment", () => {
    expect(apply("class A {}", ["UnityEngine", "System"])).toBe("using System;\nusing UnityEngine;\n\nclass A {}");
    expect(apply("// Copyright\n#nullable enable\nnamespace Game;\n", ["UnityEngine"])).toBe("// Copyright\n#nullable enable\nusing UnityEngine;\n\nnamespace Game;\n");
  });
  it("skips what is there", () => {
    expect(addUsings("using UnityEngine;\nclass A {}", ["UnityEngine"]).inserts).toEqual([]);
  });
  it("keeps CRLF files CRLF", () => {
    const { inserts } = addUsings("using UnityEngine;\r\nclass A {}", ["System"], "\r\n");
    expect(inserts).toEqual([{ offset: 0, text: "using System;\r\n" }]);
  });
});

describe("importedNamespace", () => {
  it("reads Roslyn's fix titles", () => {
    expect(importedNamespace("using UnityEngine;")).toBe("UnityEngine");
    expect(importedNamespace("Debug - using UnityEngine;")).toBe("UnityEngine");
    expect(importedNamespace("Generate class 'Foo'")).toBeNull();
  });
});
