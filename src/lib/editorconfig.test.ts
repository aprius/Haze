import { describe, expect, it } from "vitest";
import { braceStyleFromProps, globRegex, parseEditorconfig, propertiesFor } from "./editorconfig";

describe("globRegex", () => {
  it("matches .editorconfig section patterns", () => {
    expect(globRegex("*.cs").test("Assets/Scripts/Foo.cs")).toBe(true);
    expect(globRegex("*.cs").test("Foo.csx")).toBe(false);
    expect(globRegex("*.{cs,vb}").test("a/b.vb")).toBe(true);
    expect(globRegex("*").test("a/b.cs")).toBe(true);
    expect(globRegex("src/**/*.cs").test("src/a/b/c.cs")).toBe(true);
    expect(globRegex("src/**/*.cs").test("src/c.cs")).toBe(true);
    expect(globRegex("/Foo.cs").test("a/Foo.cs")).toBe(false);
    expect(globRegex("[Ff]oo.cs").test("foo.cs")).toBe(true);
  });
});

describe("propertiesFor", () => {
  const root = parseEditorconfig("root = true\n[*]\nindent_size = 4\n[*.cs]\ncsharp_new_line_before_open_brace = all\ncsharp_new_line_before_else = true\n");
  const near = parseEditorconfig("[*.cs]\ncsharp_new_line_before_open_brace = none # K&R\n");
  it("lets the nearer file win and stops at the root", () => {
    const props = propertiesFor("/p/src/A.cs", [
      { dir: "/p/src", config: near },
      { dir: "/p", config: root },
      { dir: "/", config: parseEditorconfig("[*.cs]\ncsharp_new_line_before_else = false") },
    ]);
    expect(props["csharp_new_line_before_open_brace"]).toBe("none");
    expect(props["indent_size"]).toBe("4");
    expect(braceStyleFromProps(props)).toEqual({ openBraceOnNewLine: "none", elseOnNewLine: true, indentCaseBlock: true });
  });
});

describe("braceStyleFromProps", () => {
  it("reads the brace options, the .NET defaults otherwise", () => {
    expect(braceStyleFromProps({})).toEqual({ openBraceOnNewLine: "all", elseOnNewLine: true, indentCaseBlock: true });
    expect(braceStyleFromProps({ csharp_new_line_before_open_brace: "methods, types", csharp_new_line_before_else: "false" })).toEqual({
      openBraceOnNewLine: ["methods", "types"],
      elseOnNewLine: false,
      indentCaseBlock: true,
    });
  });
});
