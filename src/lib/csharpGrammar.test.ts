import { describe, expect, it } from "vitest";
import { csharpLanguage } from "./csharpGrammar";

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
const tokenizer = new MonarchTokenizer(services, {}, "csharp", compile("csharp", csharpLanguage), config);

/** Each line as `text:token` pairs, whitespace dropped. */
function tokenize(code: string): string[][] {
  let state = tokenizer.getInitialState();
  return code.split("\n").map((line) => {
    const r = tokenizer.tokenize(line, true, state);
    state = r.endState;
    return r.tokens
      .map((t: { offset: number; type: string }, i: number) => [line.slice(t.offset, r.tokens[i + 1]?.offset ?? line.length), t.type.replace(/\.cs$/, "")])
      .filter(([text]: string[]) => text.trim())
      .map(([text, type]: string[]) => `${text.trim()}:${type}`);
  });
}

const typeOf = (code: string, word: string) =>
  tokenize(code)
    .flat()
    .find((t) => t.startsWith(`${word}:`))
    ?.slice(word.length + 1);

describe("C# grammar", () => {
  it("tells methods from types", () => {
    const code = "var rb = GetComponent<Rigidbody>();\nDebug.Log(transform.position);\nVector3 dir = Vector3.up * speed;";
    expect(typeOf(code, "GetComponent")).toBe("method");
    expect(typeOf(code, "Rigidbody")).toBe("type");
    expect(typeOf(code, "Debug")).toBe("type");
    expect(typeOf(code, "Log")).toBe("method");
    expect(typeOf(code, "transform")).toBe("identifier");
    expect(typeOf(code, "Vector3")).toBe("type");
    expect(typeOf(code, "*")).toBe("operator");
    expect(typeOf(code, "var")).toBe("keyword.var");
  });

  it("colours declarations and constructors", () => {
    const code = "public class Player : MonoBehaviour {\n  private List<Enemy> enemies = new List<Enemy>();\n  void Update() { var p = new Bullet(1.5f); }\n}";
    expect(typeOf(code, "Player")).toBe("type");
    expect(typeOf(code, "MonoBehaviour")).toBe("type");
    expect(typeOf(code, "List")).toBe("type");
    expect(typeOf(code, "Update")).toBe("method");
    expect(typeOf(code, "Bullet")).toBe("type");
    expect(typeOf(code, "1.5f")).toBe("number.float");
    expect(typeOf(code, "new")).toBe("keyword.new");
  });

  it("knows attributes, doc comments and directives", () => {
    const code = '/// <param name="hp">Health</param>\n[SerializeField, Range(0, MAX_HP)] float hp;\n#if UNITY_EDITOR\nint x;\n#endif';
    const lines = tokenize(code);
    expect(lines[0]).toEqual(["///:comment.doc", "<param:comment.doc.tag", "name:comment.doc.tag", "=:comment.doc", '"hp":comment.doc.value', ">:comment.doc.tag", "Health:comment.doc", "</param>:comment.doc.tag"]);
    expect(typeOf(code, "SerializeField")).toBe("type");
    expect(typeOf(code, "Range")).toBe("type");
    expect(typeOf(code, "MAX_HP")).toBe("constant");
    expect(typeOf(code, "float")).toBe("keyword.float");
    expect(typeOf(code, "UNITY_EDITOR")).toBe("constant");
    expect(lines[3]).toEqual(["int:keyword.int", "x:identifier", ";:delimiter"]);
  });

  it("keeps strings and interpolation", () => {
    const code = 'var s = $"{name.ToUpper()} {{x}}"; var r = """raw "q" text""";';
    expect(typeOf(code, "ToUpper")).toBe("method");
    expect(tokenize(code)[0]).toEqual(expect.arrayContaining(["{{:string.escape", "x:string", "}}:string.escape", '""":string.quote', 'raw "q" text:string']));
  });
});
