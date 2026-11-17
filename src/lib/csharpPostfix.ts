// Rider's postfix templates for C#: `expr.if`, `enemies.foreach`,
// `GetComponent<Rigidbody>().var`… wrap the expression before the dot, so the
// caret need not go back to the start of the line. Text only: the expression
// is found from brackets and operators, names are guessed from it.
import { skipLiteral } from "./csharpTyping";

export interface PostfixExpression {
  /** Offset of the expression's first character on the line. */
  start: number;
  text: string;
  /** The expression is the whole statement so far: statement templates fit. */
  statement: boolean;
}

// Words after which an expression starts (`return x.var` wraps `x`). `new` and `await` belong to theirs.
const RESETTING_WORDS = new Set(["return", "throw", "case", "in", "out", "ref", "else", "yield"]);

/** The expression ending just before the `.` at `dot` on `line`, or null. */
export function postfixExpression(line: string, dot: number): PostfixExpression | null {
  // Start of the current expression at each bracket depth.
  const starts: number[] = [0];
  let i = 0;
  while (i < dot) {
    const c = line[i];
    if (c === "/" && (line[i + 1] === "/" || line[i + 1] === "*")) {
      if (line[i + 1] === "/") return null;
      const close = line.indexOf("*/", i + 2);
      if (close < 0 || close >= dot) return null;
      i = close + 2;
      continue;
    }
    if (c === '"' || c === "'" || ((c === "$" || c === "@") && /^[$@]*"/.test(line.slice(i, i + 4)))) {
      const end = skipLiteral(line, i);
      if (end < 0 || end > dot) return null;
      i = end;
      continue;
    }
    const top = starts.length - 1;
    if (c === "(" || c === "[" || c === "{") starts.push(i + 1);
    else if (c === ")" || c === "]" || c === "}") {
      if (starts.length > 1) starts.pop();
      if (c === "}") starts[starts.length - 1] = i + 1;
    } else if (c === "," || c === ";" || c === "?" || c === ":") {
      // `?.` and `??` continue the expression; a ternary's `?` and `:` do not.
      if (c === "?" && (line[i + 1] === "." || line[i + 1] === "?" || line[i - 1] === "?")) {
        i += line[i + 1] === "?" ? 2 : 1;
        continue;
      }
      starts[top] = i + 1;
    } else if (c === "=") {
      const prev = line[i - 1];
      const next = line[i + 1];
      if (next === ">") {
        starts[top] = i + 2;
        i += 2;
        continue;
      }
      // An assignment (`=`, `+=`…), not a comparison (`==`, `!=`, `<=`, `>=`).
      if (next !== "=" && prev !== "=" && prev !== "!" && prev !== "<" && prev !== ">") starts[top] = i + 1;
      else if (next === "=") i++;
    } else if (/[A-Za-z_]/.test(c) && (i === 0 || !/[\w@]/.test(line[i - 1]))) {
      const word = /^\w+/.exec(line.slice(i))![0];
      if (RESETTING_WORDS.has(word) && i + word.length < dot) starts[top] = i + word.length;
      i += word.length;
      continue;
    }
    i++;
  }
  let start = starts[starts.length - 1];
  while (start < dot && (line[start] === " " || line[start] === "\t")) start++;
  const text = line.slice(start, dot);
  if (!text || /\s$/.test(text) || !/[\w)\]"'>]$/.test(text) || /^\d+$/.test(text)) return null;
  const firstCode = line.search(/\S/);
  return { start, text, statement: starts.length === 1 && start === firstCode };
}

// ---------------------------------------------------------------------------
// Names

const KEYWORDS = new Set([
  "object", "string", "event", "base", "this", "class", "struct", "int", "float", "bool", "double", "char", "byte", "params",
  "default", "operator", "fixed", "lock", "checked", "in", "out", "ref", "is", "as", "new", "var", "value",
]);

/** The core word of an expression: a generic argument (`type`), else the last member's name. */
function core(expr: string): { word: string; type: boolean } {
  let e = expr.trim();
  // Drop a trailing call's arguments and indexers: `Find(x)[0]` → `Find`.
  for (;;) {
    const last = e[e.length - 1];
    if (last !== ")" && last !== "]") break;
    const open = last === ")" ? "(" : "[";
    let depth = 0;
    let j = e.length - 1;
    for (; j >= 0; j--) {
      if (e[j] === last) depth++;
      else if (e[j] === open && --depth === 0) break;
    }
    if (j < 0) break;
    e = e.slice(0, j).trimEnd();
  }
  // `GetComponent<Rigidbody>` → `Rigidbody`.
  const generic = /<\s*([\w.]+)(?:\[\])?\s*>$/.exec(e);
  if (generic) return { word: generic[1].split(".").pop()!, type: true };
  const word = /@?(\w+)$/.exec(e)?.[1] ?? "";
  return { type: false, word: word.replace(/^(Get|Find|Create|Load|Make|Build|Compute|Calculate|Read)(?=[A-Z])/, "") };
}

const lowerFirst = (s: string) => {
  // `UIManager` → `uiManager`, `HP` → `hp`.
  const m = /^[A-Z]+(?=[A-Z][a-z]|$)/.exec(s);
  return m ? m[0].toLowerCase() + s.slice(m[0].length) : s.charAt(0).toLowerCase() + s.slice(1);
};

const safe = (name: string, fallback: string) => (!name || /^\d/.test(name) ? fallback : KEYWORDS.has(name) ? name + "Value" : name);

/** A variable name for an expression's value: `GetComponent<Rigidbody>()` → `rigidbody`. */
export function nameFor(expr: string): string {
  return safe(lowerFirst(core(expr).word), "value");
}

const IRREGULAR: Record<string, string> = { children: "child", people: "person", men: "man", women: "woman", mice: "mouse", data: "item", indices: "index", vertices: "vertex" };

/** A loop variable name for a collection: `enemies` → `enemy`, `enemyList` → `enemy`. */
export function itemNameFor(expr: string): string {
  const c = core(expr);
  const name = lowerFirst(c.word);
  // A type argument (`GetComponentsInChildren<Collider>()`) names one item already.
  if (c.type) return safe(name, "item");
  const stripped = name.replace(/(List|Array|Set|Collection|Queue|Stack|Dict|Dictionary|Map)$/, "");
  if (stripped !== name && stripped) return safe(stripped, "item");
  const lower = name.toLowerCase();
  if (IRREGULAR[lower]) return IRREGULAR[lower];
  let single = name;
  if (/ies$/.test(name)) single = name.slice(0, -3) + "y";
  else if (/(ss|sh|ch|x|z)es$/.test(name)) single = name.slice(0, -2);
  else if (/[^s]s$/.test(name)) single = name.slice(0, -1);
  else return "item";
  return safe(single, "item");
}

// ---------------------------------------------------------------------------
// Templates

export interface Postfix {
  key: string;
  description: string;
  /** Only when the expression is the whole statement. */
  statement: boolean;
  /** Snippet text for the expression `e` (already snippet-escaped). */
  expand: (e: string, raw: string) => string;
}

const block = (head: string, inner = "$0") => `${head}\n{\n\t${inner}\n}`;
/** `e` as an operand: parenthesized unless it is a name, a call or a member access. */
const operand = (e: string, raw: string) => (/^[\w.@]+(\(.*\)|\[.*\])?$/.test(raw.trim()) && !/\s/.test(raw.trim()) ? e : `(${e})`);
const esc = (s: string) => s.replace(/[$}\\]/g, "\\$&");

export const POSTFIX: Postfix[] = [
  { key: "if", description: "if (expr)", statement: true, expand: (e) => block(`if (${e})`) },
  { key: "else", description: "if (!expr)", statement: true, expand: (e, r) => block(`if (!${operand(e, r)})`) },
  { key: "null", description: "if (expr == null)", statement: true, expand: (e) => block(`if (${e} == null)`) },
  { key: "notnull", description: "if (expr != null)", statement: true, expand: (e) => block(`if (${e} != null)`) },
  { key: "nn", description: "if (expr != null)", statement: true, expand: (e) => block(`if (${e} != null)`) },
  { key: "foreach", description: "foreach (var item in expr)", statement: true, expand: (e, r) => block(`foreach (var \${1:${esc(itemNameFor(r))}} in ${e})`) },
  { key: "for", description: "for (var i = 0; i < expr.Count; i++)", statement: true, expand: (e) => block(`for (var \${1:i} = 0; $1 < ${e}.\${2:Count}; $1++)`) },
  { key: "forr", description: "for (var i = expr.Count - 1; i >= 0; i--)", statement: true, expand: (e) => block(`for (var \${1:i} = ${e}.\${2:Count} - 1; $1 >= 0; $1--)`) },
  { key: "var", description: "var name = expr;", statement: true, expand: (e, r) => `var \${1:${esc(nameFor(r))}} = ${e};$0` },
  { key: "return", description: "return expr;", statement: true, expand: (e) => `return ${e};$0` },
  { key: "throw", description: "throw expr;", statement: true, expand: (e) => `throw ${e};$0` },
  { key: "yield", description: "yield return expr;", statement: true, expand: (e) => `yield return ${e};$0` },
  { key: "while", description: "while (expr)", statement: true, expand: (e) => block(`while (${e})`) },
  { key: "using", description: "using (expr)", statement: true, expand: (e) => block(`using (${e})`) },
  { key: "lock", description: "lock (expr)", statement: true, expand: (e) => block(`lock (${e})`) },
  { key: "switch", description: "switch (expr)", statement: true, expand: (e) => `switch (${e})\n{\n\tcase \${1:0}:\n\t\t$0\n\t\tbreak;\n}` },
  { key: "log", description: "Debug.Log(expr); (Unity)", statement: true, expand: (e) => `Debug.Log(${e});$0` },
  { key: "not", description: "!expr", statement: false, expand: (e, r) => `!${operand(e, r)}$0` },
  { key: "par", description: "(expr)", statement: false, expand: (e) => `(${e})$0` },
  { key: "cast", description: "((Type)expr)", statement: false, expand: (e, r) => `((\${1:Type})${operand(e, r)})$0` },
  { key: "arg", description: "Method(expr)", statement: false, expand: (e) => `\${1:Method}(${e})$0` },
  { key: "new", description: "new Type()", statement: false, expand: (e) => `new ${e}($1)$0` },
  { key: "await", description: "await expr", statement: false, expand: (e) => `await ${e}$0` },
];

/** The postfix templates for an expression, by where it stands. */
export function postfixFor(expr: PostfixExpression): Postfix[] {
  return POSTFIX.filter((p) => !p.statement || expr.statement);
}

/** The snippet replacing `expr.key`. */
export function postfixSnippet(p: Postfix, expr: PostfixExpression): string {
  return p.expand(esc(expr.text), expr.text);
}
