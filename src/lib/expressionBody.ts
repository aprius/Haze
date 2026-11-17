// Typing `{` next to the `=>` of an expression-bodied C# member turns it into a
// block body, as in Rider:
//   void Start() => Foo();      →  void Start() { Foo(); }
//   int Count() => items.Count; →  int Count() { return items.Count; }
//   int Count => items.Count;   →  int Count { get { return items.Count; } }
// Text only, no Roslyn: lambdas, switch-expression arms and anything unclear
// are left alone, and the `{` is typed as usual.

export interface BodyEdit {
  /** Offsets of the replaced text: from the end of the header to the `;`. */
  start: number;
  end: number;
  text: string;
  /** Caret offset after the edit, at the end of the new statement. */
  caret: number;
}

const isIdent = (c: string | undefined) => !!c && /[\w@]/.test(c);
const isWs = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r";

// Words before a name that make `name =>` or `name(...) =>` a lambda or an expression, not a member.
const NOT_A_TYPE = new Set([
  "return", "await", "yield", "in", "is", "as", "case", "when", "select", "where", "else", "throw",
  "new", "out", "ref", "from", "let", "on", "equals", "by", "group", "into", "orderby", "join", "and", "or", "not",
]);
// Words before a name that make it a constructor: no return type.
const MODIFIERS = new Set(["public", "private", "protected", "internal", "static", "extern", "unsafe", "file"]);
const STATEMENT_ACCESSORS = new Set(["set", "init", "add", "remove"]);
// `if (x) =>` and friends are never members.
const NOT_A_NAME = new Set(["if", "while", "for", "foreach", "using", "lock", "switch", "catch", "nameof", "typeof", "sizeof", "default", "checked", "unchecked", "fixed", "when", "return"]);

function skipWsBack(t: string, i: number) {
  while (i > 0 && isWs(t[i - 1])) i--;
  return i;
}

function skipWsFwd(t: string, i: number) {
  while (i < t.length && isWs(t[i])) i++;
  return i;
}

/** Start of the identifier ending at `end`. */
function wordBack(t: string, end: number) {
  let i = end;
  while (i > 0 && isIdent(t[i - 1])) i--;
  return i;
}

/** Offset of the `open` matching the `close` just before `end`, or -1. */
function matchBack(t: string, end: number, open: string, close: string) {
  let depth = 0;
  for (let i = end - 1; i >= 0; i--) {
    if (t[i] === close) depth++;
    else if (t[i] === open && --depth === 0) return i;
    else if (t[i] === ";" || t[i] === "{" || t[i] === "}") return -1;
  }
  return -1;
}

/** Skips a qualifier like `IFoo.` before a name starting at `i`; returns the new start. */
function skipQualifier(t: string, i: number) {
  for (;;) {
    const p = skipWsBack(t, i);
    if (t[p - 1] !== ".") return i;
    let q = skipWsBack(t, p - 1);
    if (t[q - 1] === ">") q = matchBack(t, q, "<", ">");
    if (q < 0) return i;
    const w = wordBack(t, q);
    if (w === q) return i;
    i = w;
  }
}

/** End of the string or char literal starting at `i` (prefixes `$` and `@` included), or -1. */
function skipLiteral(t: string, i: number): number {
  let j = i;
  let verbatim = false;
  let interpolated = 0;
  while (t[j] === "$" || t[j] === "@") {
    if (t[j] === "@") verbatim = true;
    else interpolated++;
    j++;
  }
  if (t[j] === "'") {
    for (j++; j < t.length; j++) {
      if (t[j] === "\\") j++;
      else if (t[j] === "'") return j + 1;
      else if (t[j] === "\n") return -1;
    }
    return -1;
  }
  if (t[j] !== '"') return -1;
  if (t.startsWith('"""', j)) {
    let n = 0;
    while (t[j + n] === '"') n++;
    const close = t.indexOf('"'.repeat(n), j + n);
    return close < 0 ? -1 : close + n;
  }
  for (j++; j < t.length; j++) {
    const c = t[j];
    if (!verbatim && c === "\\") j++;
    else if (c === '"') {
      if (verbatim && t[j + 1] === '"') j++;
      else return j + 1;
    } else if (!verbatim && c === "\n") return -1;
    else if (interpolated && c === "{") {
      if (t[j + 1] === "{") j++;
      else {
        const end = scanCode(t, j + 1, "}");
        if (end < 0) return -1;
        j = end;
      }
    }
  }
  return -1;
}

/**
 * From `i`, the offset of the first `stop` outside brackets, strings and
 * comments, or -1 when a bracket closes first or the text ends.
 */
function scanCode(t: string, i: number, stop: string): number {
  const stack: string[] = [];
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  while (i < t.length) {
    const c = t[i];
    if (stack.length === 0 && c === stop) return i;
    if (c === "/" && t[i + 1] === "/") {
      const nl = t.indexOf("\n", i);
      i = nl < 0 ? t.length : nl;
      continue;
    }
    if (c === "/" && t[i + 1] === "*") {
      const close = t.indexOf("*/", i + 2);
      if (close < 0) return -1;
      i = close + 2;
      continue;
    }
    if (c === '"' || c === "'" || ((c === "$" || c === "@") && /^[$@]*["]/.test(t.slice(i, i + 4)))) {
      const end = skipLiteral(t, i);
      if (end < 0) return -1;
      i = end;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") stack.push(c);
    else if (c in pairs) {
      if (stack.pop() !== pairs[c]) return -1;
    } else if (stack.length === 0 && (c === "," || c === ";")) return -1;
    i++;
  }
  return -1;
}

type Kind = "statement" | "return" | "property";

/** How the member whose header ends at `end` (just before `=>`) is turned into a block, or null. */
function memberKind(t: string, end: number): { kind: Kind; headerStart: number } | null {
  const c = t[end - 1];
  if (c === ")") {
    const open = matchBack(t, end, "(", ")");
    if (open < 0) return null;
    let p = skipWsBack(t, open);
    if (t[p - 1] === ">") {
      p = matchBack(t, p, "<", ">");
      if (p < 0) return null;
      p = skipWsBack(t, p);
    }
    let nameStart = wordBack(t, p);
    const name = t.slice(nameStart, p);
    if (!name || NOT_A_NAME.has(name)) return null;
    // `Foo(int x) : base(x) =>`: look at the constructor itself.
    if (name === "base" || name === "this") {
      const colon = skipWsBack(t, nameStart);
      if (t[colon - 1] !== ":") return null;
      const k = memberKind(t, skipWsBack(t, colon - 1));
      return k && { kind: "statement", headerStart: k.headerStart };
    }
    nameStart = skipQualifier(t, nameStart);
    const q = skipWsBack(t, nameStart);
    const d = t[q - 1];
    if (d === "~") return { kind: "statement", headerStart: q - 1 };
    if (q === 0 || d === "{" || d === "}" || d === ";") return { kind: "statement", headerStart: nameStart };
    if (d === ">" || d === "]" || d === "?" || d === "*") return { kind: "return", headerStart: nameStart };
    if (!isIdent(d)) return null;
    const w = t.slice(wordBack(t, q), q);
    if (NOT_A_TYPE.has(w)) return null;
    if (w === "void" || MODIFIERS.has(w)) return { kind: "statement", headerStart: nameStart };
    if ((w === "Task" || w === "ValueTask") && /\basync\b/.test(lineAt(t, q))) return { kind: "statement", headerStart: nameStart };
    return { kind: "return", headerStart: nameStart };
  }
  if (c === "]") {
    const open = matchBack(t, end, "[", "]");
    if (open < 0) return null;
    const p = skipWsBack(t, open);
    const s = wordBack(t, p);
    if (t.slice(s, p) !== "this") return null;
    return { kind: "property", headerStart: s };
  }
  if (!isIdent(c)) return null;
  const nameStart = wordBack(t, end);
  const name = t.slice(nameStart, end);
  const q = skipWsBack(t, nameStart);
  const d = t[q - 1];
  if (name === "get" || STATEMENT_ACCESSORS.has(name)) {
    const prev = isIdent(d) ? t.slice(wordBack(t, q), q) : d;
    if (q === 0 || ["{", "}", ";", "]", "private", "protected", "internal", "readonly"].includes(prev))
      return { kind: name === "get" ? "return" : "statement", headerStart: nameStart };
  }
  const r = skipWsBack(t, skipQualifier(t, nameStart));
  const e = t[r - 1];
  if (e === ">" || e === "]" || e === "?" || e === "*") return { kind: "property", headerStart: nameStart };
  if (!isIdent(e)) return null;
  const w = t.slice(wordBack(t, r), r);
  if (NOT_A_TYPE.has(w) || MODIFIERS.has(w) || NOT_A_NAME.has(name)) return null;
  return { kind: "property", headerStart: nameStart };
}

function lineAt(t: string, i: number) {
  const s = t.lastIndexOf("\n", i - 1) + 1;
  const e = t.indexOf("\n", i);
  return t.slice(s, e < 0 ? t.length : e);
}

function indentAt(t: string, i: number) {
  const s = t.lastIndexOf("\n", i - 1) + 1;
  return /^[ \t]*/.exec(t.slice(s))![0];
}

/**
 * The edit that turns the expression-bodied member around `offset` into a
 * block body, when `{` is typed there: just before or just after its `=>`.
 */
export function expandExpressionBody(t: string, offset: number, indentUnit: string, eol = "\n"): BodyEdit | null {
  let arrow: number;
  const before = skipWsBack(t, offset);
  const after = skipWsFwd(t, offset);
  if (t.startsWith("=>", before - 2)) arrow = before - 2;
  else if (t.startsWith("=>", after)) arrow = after;
  else return null;
  // Not `>=>` or `==>`, and nothing but spaces between the caret and the arrow on its line.
  if (t[arrow - 1] === "=" || t[arrow - 1] === ">" || t[arrow + 2] === ">") return null;
  if (t.slice(Math.min(offset, arrow), Math.max(offset, arrow + 2)).includes("\n")) return null;

  const headerEnd = skipWsBack(t, arrow);
  const member = memberKind(t, headerEnd);
  if (!member) return null;
  const exprStart = skipWsFwd(t, arrow + 2);
  const semi = scanCode(t, exprStart, ";");
  if (semi <= exprStart) return null;
  const expr = t.slice(exprStart, semi).trimEnd();
  if (!expr) return null;

  const indent = indentAt(t, member.headerStart);
  const inner = indent + indentUnit;
  const lines = expr.split(/\r?\n/);
  const body = (prefix: string, pad: string) => prefix + lines.map((l, i) => (i ? pad + l : l)).join(eol) + ";";
  const isThrow = /^throw\b/.test(expr);
  let text: string;
  let caretInText: number;
  if (member.kind === "property") {
    const stmt = body(isThrow ? "" : "return ", inner);
    const head = `${eol}${indent}{${eol}${inner}get { `;
    text = `${head}${stmt} }${eol}${indent}}`;
    caretInText = head.length + stmt.length;
  } else {
    const stmt = body(member.kind === "return" && !isThrow ? "return " : "", inner);
    const head = `${eol}${indent}{${eol}${inner}`;
    text = `${head}${stmt}${eol}${indent}}`;
    caretInText = head.length + stmt.length;
  }
  return { start: headerEnd, end: semi + 1, text, caret: headerEnd + caretInText };
}
