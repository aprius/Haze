import { describe, expect, it } from "vitest";
import { SEMANTIC_LEGEND, semanticTranslator } from "./semantic";

const names = (data: Uint32Array) => {
  const out: string[] = [];
  let line = 0;
  let char = 0;
  for (let i = 0; i < data.length; i += 5) {
    line += data[i];
    char = data[i] ? data[i + 1] : char + data[i + 1];
    out.push(`${line}:${char}:${data[i + 2]}:${SEMANTIC_LEGEND.tokenTypes[data[i + 3]]}`);
  }
  return out;
};

describe("semantic tokens", () => {
  it("keeps identifiers from Roslyn's legend and re-encodes the gaps", () => {
    const translate = semanticTranslator({
      tokenTypes: ["keyword", "class name", "method name", "field name", "parameter name", "punctuation", "enum member name", "extensionMethod"],
      tokenModifiers: ["static symbol"],
    });
    // public static Vector3 Up(int a) { _x.Foo(); } — on lines 0 and 1.
    const data = [0, 0, 6, 0, 0, 0, 14, 7, 1, 0, 0, 8, 2, 2, 0, 0, 2, 1, 5, 0, 0, 4, 1, 4, 0, 1, 2, 2, 3, 1, 0, 2, 1, 5, 0, 0, 1, 3, 7, 0, 0, 3, 4, 6, 0];
    expect(names(translate(data))).toEqual(["0:14:7:type.cs", "0:22:2:method.cs", "0:28:1:parameter.cs", "1:2:2:static.cs", "1:5:3:method.cs", "1:8:4:constant.cs"]);
  });

  it("reads the LSP's standard names (csharp-ls)", () => {
    const translate = semanticTranslator({ tokenTypes: ["namespace", "struct", "property", "typeParameter", "string"], tokenModifiers: ["readonly", "static"] });
    const data = [0, 0, 5, 0, 0, 0, 6, 4, 1, 0, 0, 5, 3, 2, 2, 0, 4, 1, 3, 0, 0, 2, 3, 4, 0];
    expect(names(translate(data))).toEqual(["0:0:5:variable.cs", "0:6:4:type.cs", "0:11:3:static.cs", "0:15:1:type.cs"]);
  });
});
