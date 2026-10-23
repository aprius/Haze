// C# highlighting richer than Monaco's grammar: methods, types,
// attributes, doc comments and directives get their own colours. Without
// symbols this guesses from the shape of the code (a Unity script reads well:
// `Debug.Log`, `Vector3 pos`, `[SerializeField]`); once Roslyn has loaded the
// project its semantic tokens (lsp/csharp.ts) correct the guesses.
import type { languages } from "monaco-editor";

// Reserved and common contextual keywords. LINQ and attribute-target words
// are left out: as keywords they would colour every variable named `select`.
const keywords = (
  "abstract alias as async await base bool break byte case catch char checked class const continue decimal default delegate " +
  "do double dynamic else enum event explicit extern false finally fixed float for foreach get global goto if implicit in init int " +
  "interface internal is lock long managed nameof namespace new not notnull null object operator or and out override params partial " +
  "private protected public readonly record ref remove add required return sbyte scoped sealed set short sizeof stackalloc static " +
  "string struct switch this throw true try typeof uint ulong unchecked unmanaged unsafe ushort using var virtual void volatile " +
  "when where while with yield nint nuint file"
).split(" ");

export const csharpLanguage: languages.IMonarchLanguage = {
  defaultToken: "",
  tokenPostfix: ".cs",
  brackets: [
    { open: "{", close: "}", token: "delimiter.curly" },
    { open: "[", close: "]", token: "delimiter.square" },
    { open: "(", close: ")", token: "delimiter.parenthesis" },
    { open: "<", close: ">", token: "delimiter.angle" },
  ],
  keywords,
  namespaceFollows: ["namespace", "using"],
  // Followed by the declared type's name, generic parameters and base types.
  typeDeclarations: ["class", "struct", "interface", "enum", "record"],
  operators: [
    "=", "??", "??=", "||", "&&", "|", "^", "&", "==", "!=", "<=", ">=", "<<", "+", "-", "*", "/", "%", "!", "~", "++", "--",
    "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>=", ">>", ">>>", "=>", "?", "?.", "..",
  ],
  symbols: /[=><!~?:&|+\-*\/\^%]+/,
  escapes: /\\(?:[abfnrtv\\"'0e]|x[0-9A-Fa-f]{1,4}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/,
  tokenizer: {
    root: [
      // Attributes on their own line: `[SerializeField]`, `[Header("Stats"), Range(0, 1)]`.
      [/^\s*\[(?=\s*[A-Za-z_])/, { token: "delimiter.square", next: "@attribute" }],
      // A call or method declaration, generic or not: `Log(`, `GetComponent<T>(`.
      [/(@?[a-zA-Z_]\w*)(\s*)(<)(?=[\w\s,.?<>\[\]]*>\s*\()/, ["method", "", { token: "delimiter.angle", next: "@typeArgs" }]],
      [/@?[a-zA-Z_]\w*(?=\s*\()/, { cases: { "@keywords": { token: "keyword.$0" }, "@default": "method" } }],
      // Type names by position: `List<int>`, `Vector3 pos`, `Transform[] targets`, `Debug.Log`.
      [/(@?[A-Z]\w*)(\s*)(<)(?=[\w\s,.?<>\[\]]*>)/, ["type", "", { token: "delimiter.angle", next: "@typeArgs" }]],
      [/@?[A-Z]\w*(?=(?:\[[,\s]*\]|\?)*\s+(?!(?:is|as|in|and|or|not|when|switch|with|where)\b)@?[A-Za-z_])/, "type"],
      [/[A-Z]\w*(?=\s*\.\s*[A-Za-z_])/, "type"],
      [
        /@?[a-zA-Z_]\w*/,
        {
          cases: {
            "@namespaceFollows": { token: "keyword.$0", next: "@namespace" },
            "new": { token: "keyword.$0", next: "@typeName" },
            "@typeDeclarations": { token: "keyword.$0", next: "@typeDeclaration" },
            "@keywords": { token: "keyword.$0" },
            // MAX_SPEED, SPEED: constants by convention (two-letter names are usually acronyms).
            "~(?:[A-Z][A-Z0-9]*_[A-Z0-9_]*|[A-Z][A-Z0-9]{2,})": "constant",
            // Type parameters: T, TKey.
            "~T(?:[A-Z][a-z]\\w*)?": "type",
            "@default": "identifier",
          },
        },
      ],
      { include: "@whitespace" },
      [
        /}/,
        {
          cases: {
            "$S2==interpolatedstring": { token: "string.quote", next: "@pop" },
            "$S2==litinterpstring": { token: "string.quote", next: "@pop" },
            "@default": "@brackets",
          },
        },
      ],
      [/[{}()\[\]]/, "@brackets"],
      [/[<>](?!@symbols)/, "@brackets"],
      [/\?\./, "operator"],
      [/@symbols/, { cases: { "@operators": "operator", "@default": "delimiter" } }],
      // Numbers, with their suffixes (`1.5f`, `10f`, `2UL`).
      [/(?:\d[\d_]*)?\.\d[\d_]*(?:[eE][-+]?\d+)?[fFdDmM]?/, "number.float"],
      [/\d[\d_]*(?:[eE][-+]?\d+[fFdDmM]?|[fFdDmM])/, "number.float"],
      [/0[xX][\da-fA-F_]+(?:[uU][lL]?|[lL][uU]?)?/, "number.hex"],
      [/0[bB][01_]+(?:[uU][lL]?|[lL][uU]?)?/, "number.hex"],
      [/\d[\d_]*(?:[uU][lL]?|[lL][uU]?)?/, "number"],
      [/[;,.]/, "delimiter"],
      // Strings
      [/\$*"""/, { token: "string.quote", next: "@rawstring" }],
      [/"([^"\\]|\\.)*$/, "string.invalid"],
      [/"/, { token: "string.quote", next: "@string" }],
      [/\$@"|@\$"/, { token: "string.quote", next: "@litinterpstring" }],
      [/@"/, { token: "string.quote", next: "@litstring" }],
      [/\$"/, { token: "string.quote", next: "@interpolatedstring" }],
      [/'[^\\']'/, "string"],
      [/(')(@escapes)(')/, ["string", "string.escape", "string"]],
      [/'/, "string.invalid"],
    ],
    attribute: [
      [/(?:assembly|module|field|event|method|param|property|return|type)(?=\s*:)/, "keyword"],
      [/[A-Za-z_]\w*/, "type"],
      [/\(/, { token: "delimiter.parenthesis", next: "@attributeArgs" }],
      [/\]/, { token: "delimiter.square", next: "@pop" }],
      [/[.,:]/, "delimiter"],
      [/\s+/, ""],
    ],
    attributeArgs: [
      [/\(/, { token: "delimiter.parenthesis", next: "@push" }],
      [/\)/, { token: "delimiter.parenthesis", next: "@pop" }],
      { include: "@root" },
    ],
    // After `new`: `new List<Enemy>(`, `new int[3]`.
    typeName: [
      [/[ \t]+/, ""],
      [/@?[a-zA-Z_]\w*/, { cases: { "@keywords": { token: "keyword.$0" }, "@default": "type" } }],
      [/\./, "delimiter"],
      [/</, { token: "delimiter.angle", switchTo: "@typeArgs" }],
      ["", "", "@pop"],
    ],
    // `class Player : MonoBehaviour, IDamageable`, up to the body, a primary constructor or `where`.
    typeDeclaration: [
      { include: "@whitespace" },
      [/where\b/, { token: "keyword.where", next: "@pop" }],
      [/@?[a-zA-Z_]\w*/, { cases: { "@keywords": { token: "keyword.$0" }, "@default": "type" } }],
      [/[<>]/, "delimiter.angle"],
      [/[.,:?\[\]]/, "delimiter"],
      ["", "", "@pop"],
    ],
    // Generic arguments: `<string, List<Enemy>>`.
    typeArgs: [
      [/\s+/, ""],
      [/@?[a-zA-Z_]\w*/, { cases: { "@keywords": { token: "keyword.$0" }, "@default": "type" } }],
      [/</, { token: "delimiter.angle", next: "@push" }],
      [/>/, { token: "delimiter.angle", next: "@pop" }],
      [/[.,?\[\]]/, "delimiter"],
      ["", "", "@pop"],
    ],
    namespace: [
      { include: "@whitespace" },
      [/[A-Z]\w*/, "namespace"],
      [/[\.=]/, "delimiter"],
      ["", "", "@pop"],
    ],
    comment: [
      [/[^\/*]+/, "comment"],
      ["\\*/", "comment", "@pop"],
      [/[\/*]/, "comment"],
    ],
    // `/// <summary>` … : tags and their attribute values stand out.
    docComment: [
      [/^/, "", "@pop"],
      [/(<\/?)([\w:]+)/, ["comment.doc.tag", "comment.doc.tag"]],
      [/\/?>/, "comment.doc.tag"],
      [/([\w:]+)(\s*=\s*)("[^"]*"|'[^']*')/, ["comment.doc.tag", "comment.doc", "comment.doc.value"]],
      [/[^<>\w]+|\w+/, "comment.doc"],
      [/./, "comment.doc"],
    ],
    // `#if UNITY_EDITOR && !UNITY_WEBGL`
    directive: [
      [/^/, "", "@pop"],
      [/true|false/, "keyword"],
      [/[A-Za-z_]\w*/, "constant"],
      [/[!&|=()]+/, "operator"],
      [/\/\/.*$/, "comment"],
      [/\s+/, ""],
    ],
    string: [
      [/[^\\"]+/, "string"],
      [/@escapes/, "string.escape"],
      [/\\./, "string.escape.invalid"],
      [/"/, { token: "string.quote", next: "@pop" }],
    ],
    rawstring: [
      [/[^"]+/, "string"],
      [/"""/, { token: "string.quote", next: "@pop" }],
      [/"/, "string"],
    ],
    litstring: [
      [/[^"]+/, "string"],
      [/""/, "string.escape"],
      [/"/, { token: "string.quote", next: "@pop" }],
    ],
    litinterpstring: [
      [/[^"{}]+/, "string"],
      [/""/, "string.escape"],
      [/{{/, "string.escape"],
      [/}}/, "string.escape"],
      [/}/, "string"],
      [/{/, { token: "string.quote", next: "root.litinterpstring" }],
      [/"/, { token: "string.quote", next: "@pop" }],
    ],
    interpolatedstring: [
      [/[^\\"{}]+/, "string"],
      [/@escapes/, "string.escape"],
      [/\\./, "string.escape.invalid"],
      [/{{/, "string.escape"],
      [/}}/, "string.escape"],
      [/}/, "string"],
      [/{/, { token: "string.quote", next: "root.interpolatedstring" }],
      [/"/, { token: "string.quote", next: "@pop" }],
    ],
    whitespace: [
      [/^[ \t\v\f]*#((r)|(load))(?=\s)/, "directive.csx"],
      [/^[ \t\v\f]*#\s*(?:if|elif|define|undef)\b/, { token: "keyword.directive", next: "@directive" }],
      [/^([ \t\v\f]*#\s*(?:region|endregion))(.*)$/, ["keyword.directive", "comment"]],
      [/^[ \t\v\f]*#\s*\w+/, "keyword.directive"],
      [/[ \t\v\f\r\n]+/, ""],
      [/\/\*/, "comment", "@comment"],
      [/\/\/\/(?!\/)/, { token: "comment.doc", next: "@docComment" }],
      [/\/\/.*$/, "comment"],
    ],
  },
};
