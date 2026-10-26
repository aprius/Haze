import { describe, expect, it } from "vitest";
import { glslLanguage, hlslLanguage, shaderlabLanguage } from "./shaderGrammar";

// Monaco's own Monarch compiler and lexer (not exported by the package).
const monarch = "../../node_modules/monaco-editor/esm/vs/editor/standalone/common/monarch/";
const { compile } = await import(/* @vite-ignore */ `${monarch}monarchCompile.js`);
const { MonarchTokenizer } = await import(/* @vite-ignore */ `${monarch}monarchLexer.js`);

const services = {
  languageIdCodec: { encodeLanguageId: () => 0 },
  isRegisteredLanguageId: () => false,
  requestBasicLanguageFeatures: () => {},
};
const config = { getValue: () => undefined, onDidChangeConfiguration: () => ({ dispose() {} }) };

/** The token type of `word`'s first occurrence, its language postfix dropped. */
function typeOf(id: string, grammar: object, code: string, word: string): string | undefined {
  const tokenizer = new MonarchTokenizer(services, {}, id, compile(id, grammar), config);
  let state = tokenizer.getInitialState();
  for (const line of code.split("\n")) {
    const r = tokenizer.tokenize(line, true, state);
    state = r.endState;
    for (let i = 0; i < r.tokens.length; i++) {
      const t = r.tokens[i];
      const text = line.slice(t.offset, r.tokens[i + 1]?.offset ?? line.length).trim();
      if (text === word) return t.type.replace(/\.\w+$/, "");
    }
  }
  return undefined;
}

describe("HLSL grammar", () => {
  const code = [
    '#include "UnityCG.cginc"',
    "struct v2f { float4 pos : SV_POSITION; half2 uv : TEXCOORD0; };",
    "sampler2D _MainTex;",
    "[numthreads(8, 8, 1)]",
    "float4 frag(v2f i) : SV_Target { return tex2D(_MainTex, i.uv) * UNITY_PI; } // done",
  ].join("\n");
  const type = (word: string) => typeOf("hlsl", hlslLanguage, code, word);

  it("colours types, functions and semantics", () => {
    expect(type("float4")).toBe("type");
    expect(type("half2")).toBe("type");
    expect(type("sampler2D")).toBe("type");
    expect(type("frag")).toBe("method");
    expect(type("tex2D")).toBe("method");
    expect(type("SV_POSITION")).toBe("annotation");
    expect(type("SV_Target")).toBe("annotation");
    expect(type("numthreads")).toBe("annotation");
    expect(type("struct")).toBe("keyword");
    expect(type("return")).toBe("keyword");
    expect(type("UNITY_PI")).toBe("constant");
  });

  it("colours directives and comments", () => {
    expect(type("#include")).toBe("keyword.directive");
    expect(type('"UnityCG.cginc"')).toBe("string");
    expect(type("// done")).toBe("comment");
  });
});

describe("GLSL grammar", () => {
  const code = "#version 330 core\nuniform mat4 mvp;\nin vec3 pos;\nvoid main() { gl_Position = mvp * vec4(pos, 1.0); }";
  const type = (word: string) => typeOf("glsl", glslLanguage, code, word);

  it("colours types and built-ins", () => {
    expect(type("mat4")).toBe("type");
    expect(type("vec3")).toBe("type");
    expect(type("vec4")).toBe("type");
    expect(type("uniform")).toBe("keyword");
    expect(type("main")).toBe("method");
    expect(type("gl_Position")).toBe("variable.predefined");
    expect(type("1.0")).toBe("number.float");
  });
});

describe("ShaderLab grammar", () => {
  const code = [
    'Shader "Custom/Lit" {',
    "  Properties {",
    '    [HDR] _Color ("Tint", Color) = (1, 1, 1, 1)',
    '    _MainTex ("Albedo", 2D) = "white" {}',
    "  }",
    "  SubShader {",
    '    Tags { "RenderType"="Opaque" }',
    "    Cull Off ZWrite On",
    "  }",
    '  Fallback "Diffuse"',
    "}",
  ].join("\n");
  const type = (word: string) => typeOf("shaderlab", shaderlabLanguage, code, word);

  it("colours blocks, render state and properties", () => {
    expect(type("Shader")).toBe("keyword");
    expect(type("SubShader")).toBe("keyword");
    expect(type("Cull")).toBe("keyword");
    expect(type("Off")).toBe("constant");
    expect(type("HDR")).toBe("annotation");
    expect(type("_MainTex")).toBe("variable.predefined");
    expect(type("2D")).toBe("type");
    expect(type("Fallback")).toBe("keyword");
  });
});
