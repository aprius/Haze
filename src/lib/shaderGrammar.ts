// Shader highlighting, which Monaco has no grammar for: HLSL (Unity's
// .hlsl/.cginc/.compute, Unreal's .usf), GLSL, and Unity's ShaderLab
// (.shader), whose CGPROGRAM/HLSLPROGRAM blocks are coloured as HLSL.
import type { languages } from "monaco-editor";

const words = (s: string) => s.split(/\s+/).filter(Boolean);

const config: languages.LanguageConfiguration = {
  comments: { lineComment: "//", blockComment: ["/*", "*/"] },
  brackets: [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"', notIn: ["string"] },
    { open: "/*", close: " */", notIn: ["string"] },
  ],
  surroundingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
  ],
  folding: { markers: { start: /^\s*#\s*(?:pragma\s+)?region\b/, end: /^\s*#\s*(?:pragma\s+)?endregion\b/ } },
};

/** HLSL and GLSL: one C-like grammar, each with its own words and types. */
function cLike(postfix: string, keywords: string[], types: string[], typeShapes: RegExp, builtins: RegExp): languages.IMonarchLanguage {
  return {
    defaultToken: "",
    tokenPostfix: postfix,
    keywords,
    types,
    typeShapes,
    builtins,
    operators: words("= + - * / % ++ -- == != < > <= >= && || ! ~ & | ^ << >> += -= *= /= %= &= |= ^= <<= >>= ? :"),
    symbols: /[=><!~?:&|+\-*\/\^%]+/,
    tokenizer: {
      root: [
        { include: "@whitespace" },
        // Semantics: `float4 pos : SV_POSITION;`, `float4 frag(v2f i) : SV_Target`.
        [/(:)(\s*)([A-Za-z_]\w*)(?=\s*[;,){=])/, ["delimiter", "", "annotation"]],
        // Attributes: `[numthreads(8, 8, 1)]`, `[unroll]`.
        [/\[(?=\s*[A-Za-z_]\w*\s*(?:\(|\]))/, { token: "delimiter.square", next: "@attribute" }],
        [/[A-Za-z_]\w*(?=\s*\()/, { cases: { "@keywords": "keyword", "@types": "type", "~@typeShapes": "type", "@default": "method" } }],
        [
          /[A-Za-z_]\w*/,
          {
            cases: {
              "@keywords": "keyword",
              "@types": "type",
              "~@typeShapes": "type",
              "~@builtins": "variable.predefined",
              // UNITY_MATRIX_MVP, PI: macros and constants by convention.
              "~[A-Z][A-Z0-9]*_[A-Z0-9_]*|[A-Z][A-Z0-9]{2,}": "constant",
              "@default": "identifier",
            },
          },
        ],
        [/[{}()\[\]]/, "@brackets"],
        [/@symbols/, { cases: { "@operators": "operator", "@default": "delimiter" } }],
        [/(?:\d+\.\d*|\.\d+)(?:[eE][-+]?\d+)?[fFhHlL]?/, "number.float"],
        [/\d+(?:[eE][-+]?\d+[fFhHlL]?|[fFhH])/, "number.float"],
        [/0[xX][\da-fA-F]+[uUlL]*/, "number.hex"],
        [/\d+[uUlL]*/, "number"],
        [/[;,.]/, "delimiter"],
        [/"/, { token: "string.quote", next: "@string" }],
      ],
      attribute: [
        [/[A-Za-z_]\w*/, "annotation"],
        [/\(/, { token: "delimiter.parenthesis", next: "@attributeArgs" }],
        [/\]/, { token: "delimiter.square", next: "@pop" }],
        [/\s+/, ""],
      ],
      attributeArgs: [
        [/\)/, { token: "delimiter.parenthesis", next: "@pop" }],
        { include: "@root" },
      ],
      string: [
        [/[^\\"]+/, "string"],
        [/\\./, "string.escape"],
        [/"/, { token: "string.quote", next: "@pop" }],
      ],
      comment: [
        [/[^\/*]+/, "comment"],
        [/\*\//, "comment", "@pop"],
        [/[\/*]/, "comment"],
      ],
      // `#pragma vertex vert`, `#include "UnityCG.cginc"`, `#if defined(SHADOWS_ON)`.
      directive: [
        [/^/, "", "@pop"],
        [/\\$/, "keyword.directive"],
        [/"[^"]*"|<[^>]*>/, "string"],
        [/defined\b/, "keyword"],
        [/[A-Za-z_]\w*/, "constant"],
        [/\d+/, "number"],
        [/\/\/.*$/, "comment"],
        [/\/\*/, "comment", "@comment"],
        [/[^\sA-Za-z_"<\/\d]+|\//, "operator"],
        [/\s+/, ""],
      ],
      whitespace: [
        [/^\s*#\s*\w+/, { token: "keyword.directive", next: "@directive" }],
        [/[ \t\r\n]+/, ""],
        [/\/\*/, "comment", "@comment"],
        [/\/\/.*$/, "comment"],
      ],
    },
  };
}

const hlslKeywords = words(`
  break case cbuffer centroid class const continue default discard do else export extern false for groupshared if in
  inline inout interface linear line lineadj namespace nointerpolation noperspective out packoffset point precise register
  return row_major column_major sample shared static struct switch tbuffer triangle triangleadj true typedef uniform
  volatile while snorm unorm globallycoherent
`);
const hlslTypes = words(`
  void bool int uint dword half float double min16float min10float min16int min12int min16uint fixed string vector matrix
  sampler sampler1D sampler2D sampler3D samplerCUBE sampler_state SamplerState SamplerComparisonState
  sampler2D_float sampler2D_half samplerCUBE_float samplerCUBE_half
  Texture1D Texture1DArray Texture2D Texture2DArray Texture2DMS Texture2DMSArray Texture3D TextureCube TextureCubeArray
  RWTexture1D RWTexture1DArray RWTexture2D RWTexture2DArray RWTexture3D Buffer RWBuffer ByteAddressBuffer
  RWByteAddressBuffer StructuredBuffer RWStructuredBuffer AppendStructuredBuffer ConsumeStructuredBuffer
  InputPatch OutputPatch PointStream LineStream TriangleStream RaytracingAccelerationStructure
`);
// float4, half3x3, uint2, min16float4…
const hlslTypeShapes = /(?:bool|int|uint|dword|half|float|double|fixed|min16float|min10float|min16int|min12int|min16uint)[1-4](?:x[1-4])?/;
const hlslBuiltins = /(?!)/;

const glslKeywords = words(`
  attribute const uniform varying buffer shared coherent volatile restrict readonly writeonly layout centroid flat smooth
  noperspective patch sample break continue do for while switch case default if else subroutine in out inout true false
  invariant precise discard return lowp mediump highp precision struct
`);
const glslTypes = words(`
  void bool int uint float double atomic_uint
  sampler1D sampler2D sampler3D samplerCube sampler2DRect sampler1DArray sampler2DArray samplerCubeArray samplerBuffer
  sampler2DMS sampler2DMSArray sampler1DShadow sampler2DShadow samplerCubeShadow sampler2DRectShadow sampler1DArrayShadow
  sampler2DArrayShadow samplerCubeArrayShadow samplerExternalOES
  isampler2D isampler3D isamplerCube isampler2DArray usampler2D usampler3D usamplerCube usampler2DArray
  image1D image2D image3D imageCube image2DArray iimage2D uimage2D
`);
const glslTypeShapes = /(?:[biud]?vec[2-4]|d?mat[2-4](?:x[2-4])?)/;
const glslBuiltins = /gl_\w+/;

export const hlslLanguage = cLike(".hlsl", hlslKeywords, hlslTypes, hlslTypeShapes, hlslBuiltins);
export const glslLanguage = cLike(".glsl", glslKeywords, glslTypes, glslTypeShapes, glslBuiltins);

// ShaderLab: the blocks and render state around the HLSL.
export const shaderlabLanguage: languages.IMonarchLanguage = {
  defaultToken: "",
  tokenPostfix: ".shaderlab",
  ignoreCase: true,
  keywords: words(`
    Shader Properties SubShader Pass UsePass GrabPass Category Tags LOD Name Fallback FallBack CustomEditor
    CustomEditorForRenderPipeline Dependency PackageRequirements Stencil Material Lighting SeparateSpecular ColorMaterial
    Fog SetTexture Combine ConstantColor AlphaTest BindChannels Bind
  `),
  states: words(`
    Cull ZWrite ZTest ZClip Offset Blend BlendOp AlphaToMask ColorMask Conservative Ref ReadMask WriteMask Comp Pass
    Fail ZFail CompFront CompBack PassFront PassBack FailFront FailBack ZFailFront ZFailBack
  `),
  values: words(`
    Off On Back Front Less Greater LEqual GEqual Equal NotEqual Always Never Keep Zero Replace IncrSat DecrSat Invert
    IncrWrap DecrWrap One SrcColor SrcAlpha DstColor DstAlpha OneMinusSrcColor OneMinusSrcAlpha OneMinusDstColor
    OneMinusDstAlpha Add Sub RevSub Min Max True False
  `),
  propertyTypes: words("Range Float Int Integer Color Vector 2D 3D Cube 2DArray CubeArray Any"),
  tokenizer: {
    root: [
      { include: "@whitespace" },
      [/(?:CG|HLSL|GLSL)(?:PROGRAM|INCLUDE)\b/, { token: "keyword.embedded", next: "@program", nextEmbedded: "hlsl" }],
      // Property attributes: `[HDR]`, `[Toggle(_EMISSION)]`, `[Header(Surface)]`.
      [/\[(?=\s*[A-Za-z_]\w*\s*(?:\(|\]))/, { token: "delimiter.square", next: "@attribute" }],
      // Property names and references to them: `_MainTex`, `[_Cull]`.
      [/_\w+/, "variable.predefined"],
      [
        /[A-Za-z_]\w*/,
        {
          cases: {
            "@keywords": "keyword",
            "@states": "keyword",
            "@values": "constant",
            "@propertyTypes": "type",
            "@default": "identifier",
          },
        },
      ],
      [/2D(?:Array)?\b|3D\b/, "type"],
      [/[{}()\[\]]/, "@brackets"],
      [/(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?/, "number"],
      [/[=,]/, "delimiter"],
      [/"/, { token: "string.quote", next: "@string" }],
    ],
    program: [[/(?:ENDCG|ENDHLSL|ENDGLSL)\b/, { token: "@rematch", next: "@pop", nextEmbedded: "@pop" }]],
    attribute: [
      [/[A-Za-z_]\w*/, "annotation"],
      [/\(/, { token: "delimiter.parenthesis", next: "@attributeArgs" }],
      [/\]/, { token: "delimiter.square", next: "@pop" }],
      [/\s+/, ""],
    ],
    attributeArgs: [
      [/\)/, { token: "delimiter.parenthesis", next: "@pop" }],
      [/(?:\d+\.\d*|\.\d+|\d+)/, "number"],
      [/[A-Za-z_]\w*/, "constant"],
      [/[^)\w]+/, "delimiter"],
    ],
    string: [
      [/[^\\"]+/, "string"],
      [/\\./, "string.escape"],
      [/"/, { token: "string.quote", next: "@pop" }],
    ],
    comment: [
      [/[^\/*]+/, "comment"],
      [/\*\//, "comment", "@pop"],
      [/[\/*]/, "comment"],
    ],
    whitespace: [
      [/(?:ENDCG|ENDHLSL|ENDGLSL)\b/, "keyword.embedded"],
      [/[ \t\r\n]+/, ""],
      [/\/\*/, "comment", "@comment"],
      [/\/\/.*$/, "comment"],
    ],
  },
};

/** Registers the three languages; ids and extensions are what `languageFor` matches. */
export function registerShaderLanguages(monaco: typeof import("monaco-editor")): void {
  const langs: [string, string[], languages.IMonarchLanguage, string][] = [
    ["hlsl", [".hlsl", ".hlsli", ".cginc", ".compute", ".raytrace", ".fx", ".fxh", ".usf", ".ush"], hlslLanguage, "HLSL"],
    ["glsl", [".glsl", ".glslinc", ".vert", ".frag", ".geom", ".comp", ".tesc", ".tese", ".vsh", ".fsh"], glslLanguage, "GLSL"],
    ["shaderlab", [".shader"], shaderlabLanguage, "ShaderLab"],
  ];
  for (const [id, extensions, grammar, alias] of langs) {
    monaco.languages.register({ id, extensions, aliases: [alias] });
    monaco.languages.setMonarchTokensProvider(id, grammar);
    monaco.languages.setLanguageConfiguration(id, config);
  }
}
