// Rider's live templates for C#: an abbreviation (`prop`, `ctor`, `fore`, `dl`…)
// offered in completion where it fits (a class body, a method body, the file's
// top level) and expanded as a snippet whose fields Tab walks through.
import { skipLiteral } from "./csharpTyping";

export type BlockKind = "top" | "type" | "code";

export interface BlockContext {
  kind: BlockKind;
  /** The innermost enclosing type's name, for `ctor`. */
  typeName?: string;
}

const TYPE_HEADER = /\b(class|struct|interface|record)\s+(@?\w+)/;

/** What kind of block `offset` is in, from the braces before it (strings and comments skipped). */
export function blockContext(t: string, offset: number): BlockContext {
  const stack: { kind: BlockKind | "enum"; name?: string }[] = [];
  let boundary = 0;
  for (let i = 0; i < offset; i++) {
    const c = t[i];
    if (c === "/" && t[i + 1] === "/") {
      const nl = t.indexOf("\n", i);
      i = nl < 0 || nl >= offset ? offset : nl;
      continue;
    }
    if (c === "/" && t[i + 1] === "*") {
      const close = t.indexOf("*/", i + 2);
      i = close < 0 ? offset : close + 1;
      continue;
    }
    if (c === '"' || c === "'" || ((c === "$" || c === "@") && /^[$@]*"/.test(t.slice(i, i + 4)))) {
      const end = skipLiteral(t, i);
      if (end < 0 || end > offset) return { kind: "code" };
      i = end - 1;
      continue;
    }
    if (c === "#" && /^[ \t]*$/.test(t.slice(t.lastIndexOf("\n", i - 1) + 1, i))) {
      // A directive line holds no braces.
      const nl = t.indexOf("\n", i);
      i = nl < 0 || nl >= offset ? offset : nl;
      boundary = i + 1;
      continue;
    }
    if (c === "{") {
      const header = t.slice(boundary, i).replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      const parent = stack[stack.length - 1]?.kind;
      const type = TYPE_HEADER.exec(header);
      if (parent === "code" || parent === "enum") stack.push({ kind: "code" });
      else if (type && !/=>|\(/.test(header.slice(0, type.index))) stack.push({ kind: "type", name: type[2].replace(/^@/, "") });
      else if (/\benum\b/.test(header)) stack.push({ kind: "enum" });
      else if (/\bnamespace\b/.test(header)) stack.push({ kind: "top" });
      else stack.push({ kind: "code" });
      boundary = i + 1;
    } else if (c === "}") {
      stack.pop();
      boundary = i + 1;
    } else if (c === ";") boundary = i + 1;
  }
  const top = stack[stack.length - 1];
  const typeName = [...stack].reverse().find((b) => b.kind === "type")?.name;
  if (!top) return { kind: "top" };
  // An enum body takes only names: no templates there.
  return { kind: top.kind === "enum" ? "code" : top.kind, typeName };
}

export interface Template {
  key: string;
  description: string;
  /** Where it applies. */
  in: BlockKind[];
  /** Also in the middle of a line (an expression), not only at a line's start. */
  expression?: boolean;
  /** Monaco snippet text: `\t` indents, `$1`… fields, `$0` the end. */
  body: string | ((c: { typeName: string; fileName: string }) => string);
}

const block = (head: string, inner = "$0") => `${head}\n{\n\t${inner}\n}`;

export const TEMPLATES: Template[] = [
  // Members
  { key: "prop", description: "Auto-property", in: ["type"], body: "public ${1:int} ${2:Name} { get; set; }$0" },
  { key: "propg", description: "Auto-property with a private setter", in: ["type"], body: "public ${1:int} ${2:Name} { get; private set; }$0" },
  { key: "ctor", description: "Constructor", in: ["type"], body: ({ typeName }) => block(`public ${typeName}($1)`) },
  { key: "sfield", description: "Serialized field (Unity)", in: ["type"], body: "[SerializeField] private ${1:float} ${2:speed};$0" },
  { key: "sfieldt", description: "Serialized field with a tooltip (Unity)", in: ["type"], body: '[SerializeField, Tooltip("${3}")] private ${1:float} ${2:speed};$0' },
  { key: "corout", description: "Coroutine (Unity)", in: ["type"], body: block("private IEnumerator ${1:Routine}($2)", "yield return null;$0") },
  { key: "menuitem", description: "Editor menu item (Unity)", in: ["type"], body: '[MenuItem("${1:Tools/Run}")]\nprivate static void ${2:Run}()\n{\n\t$0\n}' },
  { key: "ctxmenu", description: "Context menu method (Unity)", in: ["type"], body: '[ContextMenu("${1:Run}")]\nprivate void ${2:Run}()\n{\n\t$0\n}' },
  { key: "reg", description: "#region", in: ["top", "type", "code"], body: "#region ${1:Name}\n$0\n#endregion" },
  // Types
  { key: "class", description: "Class", in: ["top", "type"], body: ({ fileName }) => block(`public class \${1:${fileName}}`) },
  { key: "mono", description: "MonoBehaviour (Unity)", in: ["top", "type"], body: ({ fileName }) => block(`public class \${1:${fileName}} : MonoBehaviour`) },
  {
    key: "so",
    description: "ScriptableObject with a Create menu (Unity)",
    in: ["top", "type"],
    body: ({ fileName }) => `[CreateAssetMenu(fileName = "\${1:${fileName}}", menuName = "\${2:Data}/\${1}")]\n` + block(`public class \${1} : ScriptableObject`),
  },
  { key: "interface", description: "Interface", in: ["top", "type"], body: ({ fileName }) => block(`public interface \${1:${fileName}}`) },
  { key: "struct", description: "Struct", in: ["top", "type"], body: ({ fileName }) => block(`public struct \${1:${fileName}}`) },
  { key: "enum", description: "Enum", in: ["top", "type"], body: ({ fileName }) => block(`public enum \${1:${fileName}}`) },
  // Statements
  { key: "for", description: "for loop", in: ["code"], body: block("for (var ${1:i} = 0; $1 < ${2:count}; $1++)") },
  { key: "forr", description: "Reverse for loop", in: ["code"], body: block("for (var ${1:i} = ${2:count} - 1; $1 >= 0; $1--)") },
  { key: "fore", description: "foreach loop", in: ["code"], body: block("foreach (var ${2:item} in ${1:collection})") },
  { key: "if", description: "if statement", in: ["code"], body: block("if (${1:condition})") },
  { key: "ifelse", description: "if-else statement", in: ["code"], body: "if (${1:condition})\n{\n\t$2\n}\nelse\n{\n\t$0\n}" },
  { key: "while", description: "while loop", in: ["code"], body: block("while (${1:condition})") },
  { key: "do", description: "do-while loop", in: ["code"], body: "do\n{\n\t$0\n} while (${1:condition});" },
  { key: "switch", description: "switch statement", in: ["code"], body: "switch (${1:value})\n{\n\tcase ${2:0}:\n\t\t$0\n\t\tbreak;\n\tdefault:\n\t\tbreak;\n}" },
  { key: "try", description: "try-catch", in: ["code"], body: "try\n{\n\t$0\n}\ncatch (${1:Exception} ${2:e})\n{\n\t\n}" },
  { key: "tryf", description: "try-finally", in: ["code"], body: "try\n{\n\t$0\n}\nfinally\n{\n\t\n}" },
  { key: "using", description: "using statement", in: ["code"], body: block("using (${1:resource})") },
  { key: "lock", description: "lock statement", in: ["code"], body: block("lock (${1:this})") },
  { key: "thr", description: "throw new exception", in: ["code"], body: "throw new ${1:InvalidOperationException}($0);" },
  { key: "cw", description: "Console.WriteLine", in: ["code"], body: "Console.WriteLine($0);" },
  { key: "dl", description: "Debug.Log (Unity)", in: ["code"], body: "Debug.Log($0);" },
  { key: "dlw", description: "Debug.LogWarning (Unity)", in: ["code"], body: "Debug.LogWarning($0);" },
  { key: "dle", description: "Debug.LogError (Unity)", in: ["code"], body: "Debug.LogError($0);" },
  { key: "dlv", description: "Debug.Log a value with its name (Unity)", in: ["code"], body: 'Debug.Log($"${1:value} = {$1}");$0' },
  { key: "yrn", description: "yield return null (Unity)", in: ["code"], body: "yield return null;$0" },
  { key: "yrw", description: "yield return new WaitForSeconds (Unity)", in: ["code"], body: "yield return new WaitForSeconds(${1:1f});$0" },
  { key: "gc", description: "GetComponent (Unity)", in: ["code"], expression: true, body: "GetComponent<${1:Component}>()$0" },
  { key: "tgc", description: "TryGetComponent (Unity)", in: ["code"], body: block("if (TryGetComponent(out ${1:Rigidbody} ${2:body}))") },
];

/** The templates for `word` typed at a caret in `context`, `lineBefore` being the line up to the word. */
export function templatesFor(context: BlockContext, lineBefore: string, word: string): Template[] {
  if (!word) return [];
  const atLineStart = !lineBefore.trim();
  return TEMPLATES.filter((t) => t.in.includes(context.kind) && (atLineStart || t.expression) && t.key.startsWith(word.toLowerCase()));
}

/** Text for a snippet's placeholder or literal part: `$`, `}` and `\\` escaped. */
const snippetText = (s: string) => s.replace(/[$}\\]/g, "\\$&");

export function templateBody(t: Template, c: { typeName?: string; fileName: string }): string {
  if (typeof t.body === "string") return t.body;
  return t.body({ typeName: snippetText(c.typeName ?? "Name"), fileName: snippetText(c.fileName || "Name") });
}
