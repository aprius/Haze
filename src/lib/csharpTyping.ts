// Rider's C# typing assists, from text alone (no Roslyn), so they work before
// the projects load. Each returns one edit, or null to let the key do its usual
// thing; anything unclear is left alone.
//   `{`  at the `=>` of an expression-bodied member → block body
//   `{`  in a plain string                          → interpolated string
//   `{`  before the statement of an `if`/`else`     → wraps it in a block
//   Enter at the braces of a one-line method        → body on its own lines
//   Enter in a `///` comment                        → continues it
//   Enter in a string                               → `"a " +` / `"b"`
//   Enter after a new `#region`                     → adds its `#endregion`
//   `/`  making `///` above a declaration           → XML doc comment
//   `;`  before the closing brackets of a line      → after them
//   Backspace in indentation                        → to the proper indentation
//   Complete Statement (Ctrl+Shift+Enter)           → closes, adds `;` or `{ }`
//
// Expression bodies:
//   void Start() => Foo();      →  void Start() { Foo(); }
//   int Count() => items.Count; →  int Count() { return items.Count; }
//   int Count => items.Count;   →  int Count { get { return items.Count; } }

export interface BodyEdit {
  /** Offsets of the replaced text. */
  start: number;
  end: number;
  text: string;
  /** Caret offset after the edit, in the new text. */
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
export function skipLiteral(t: string, i: number): number {
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
function scanCode(t: string, i: number, stop: string, abort = ",;"): number {
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
    } else if (stack.length === 0 && abort.includes(c)) return -1;
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
    if (d === ">" || d === "]" || d === "?" || d === "*") return endsType(t, q) ? { kind: "return", headerStart: nameStart } : null;
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
  if (e === ">" || e === "]" || e === "?" || e === "*") return endsType(t, r) ? { kind: "property", headerStart: nameStart } : null;
  if (!isIdent(e)) return null;
  const w = t.slice(wordBack(t, r), r);
  if (NOT_A_TYPE.has(w) || MODIFIERS.has(w) || NOT_A_NAME.has(name)) return null;
  return { kind: "property", headerStart: nameStart };
}

/** Whether the `>`, `]`, `?` or `*` just before `end` ends a type (`List<int>`, `int[]`, `int?`), not `=>` or `? :`. */
function endsType(t: string, end: number) {
  const c = t[end - 1];
  const b = t[end - 2];
  if (c === ">") return b !== "=" && b !== "-";
  if (c === "?") return isIdent(b) || b === ">" || b === "]";
  return c === "]" || c === "*";
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
  if (inCommentOrString(t, arrow)) return null;

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
  // An accessor in a one-line property (`{ get => _x; set => ... }`) stays on its line.
  const headerLine = t.lastIndexOf("\n", member.headerStart - 1) + 1;
  if (member.headerStart > headerLine + indent.length && /^(get|set|init|add|remove)$/.test(t.slice(member.headerStart, headerEnd)) && !expr.includes("\n")) {
    const stmt = `${member.kind === "return" && !/^throw\b/.test(expr) ? "return " : ""}${expr};`;
    const head = ` { ${stmt}`;
    return { start: headerEnd, end: semi + 1, text: `${head} }`, caret: headerEnd + head.length };
  }
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

/** Statements of a block body, split on top-level `;`, or the whole body when that fails. */
function statements(t: string, start: number, end: number) {
  const out: string[] = [];
  let i = skipWsFwd(t, start);
  while (i < end) {
    const semi = scanCode(t, i, ";", "");
    if (semi < 0 || semi >= end) return [t.slice(skipWsFwd(t, start), end).trim()];
    out.push(t.slice(i, semi + 1).trim());
    i = skipWsFwd(t, semi + 1);
  }
  return out;
}

/**
 * The edit that lays out a one-line method body `{ ... }` on its own lines,
 * when Enter is pressed just before or after its `{`, or just before its `}`.
 */
export function expandInlineMethod(t: string, offset: number, indentUnit: string, eol = "\n"): BodyEdit | null {
  const lineStart = t.lastIndexOf("\n", offset - 1) + 1;
  const nl = t.indexOf("\n", offset);
  const lineEnd = nl < 0 ? t.length : nl;
  // The method's `{`: the first one on the line that follows a `)`.
  let open = -1;
  for (let i = t.indexOf("{", lineStart); i >= 0 && i < lineEnd; i = t.indexOf("{", i + 1)) {
    const h = skipWsBack(t, i);
    if (t[h - 1] === ")") {
      open = i;
      break;
    }
  }
  if (open < 0) return null;
  const headerEnd = skipWsBack(t, open);
  const member = memberKind(t, headerEnd);
  if (!member || member.kind === "property" || member.headerStart < lineStart) return null;
  const close = scanCode(t, open + 1, "}", "");
  if (close < 0 || close >= lineEnd) return null;
  // Only a comment may follow the method on its line.
  const rest = t.slice(close + 1, lineEnd).trim();
  if (rest && !rest.startsWith("//") && !rest.startsWith("/*")) return null;
  const atOpen = skipWsBack(t, offset) === open + 1 || skipWsFwd(t, offset) === open;
  const atClose = skipWsFwd(t, offset) === close && offset > open;
  if (!atOpen && !atClose) return null;

  const indent = indentAt(t, member.headerStart);
  const inner = indent + indentUnit;
  const stmts = statements(t, open + 1, close).filter(Boolean);
  const head = `${eol}${indent}{${eol}${inner}`;
  const body = stmts.join(eol + inner);
  const text = `${head}${body}${eol}${indent}}`;
  const caret = headerEnd + head.length + (atOpen && !atClose ? 0 : body.length);
  return { start: headerEnd, end: close + 1, text, caret };
}

// ---------------------------------------------------------------------------
// Shared line helpers

/** Whether `offset` is in a `//` comment or a string on its line. */
function inCommentOrString(t: string, offset: number) {
  if (literalAt(t, offset)) return true;
  const { start } = lineBounds(t, offset);
  for (let i = t.indexOf("//", start); i >= 0 && i < offset; i = t.indexOf("//", i + 2)) {
    if (!literalAt(t, i + 1)) return true;
  }
  return false;
}

function lineBounds(t: string, offset: number) {
  const start = t.lastIndexOf("\n", offset - 1) + 1;
  const nl = t.indexOf("\n", offset);
  let end = nl < 0 ? t.length : nl;
  if (t[end - 1] === "\r") end--;
  return { start, end };
}

export interface Literal {
  /** Offset of the literal's first character (its `$` or `@`, if any). */
  start: number;
  /** Offset of the opening quote. */
  quote: number;
  /** Offset just past the closing quote, or -1 when the line ends first. */
  end: number;
  verbatim: boolean;
  interpolated: boolean;
  /** Inside an interpolation hole `{...}`. */
  inHole: boolean;
}

/** The string literal (on one line, not raw) that `offset` is inside, or null. */
export function literalAt(t: string, offset: number): Literal | null {
  const { start: ls, end: le } = lineBounds(t, offset);
  let i = ls;
  while (i < le && i < offset) {
    const c = t[i];
    if (c === "/" && t[i + 1] === "/") return null;
    if (c === "/" && t[i + 1] === "*") {
      const close = t.indexOf("*/", i + 2);
      if (close < 0 || close >= le) return null;
      i = close + 2;
      continue;
    }
    if (c === "'") {
      const end = skipLiteral(t, i);
      if (end < 0) return null;
      i = end;
      continue;
    }
    if (c === '"' || ((c === "$" || c === "@") && /^[$@]*"/.test(t.slice(i, i + 4)))) {
      let q = i;
      let verbatim = false;
      let interpolated = false;
      while (t[q] === "$" || t[q] === "@") {
        if (t[q] === "@") verbatim = true;
        else interpolated = true;
        q++;
      }
      if (t.startsWith('"""', q)) return null;
      // Walk the literal, noting whether `offset` falls in an interpolation hole.
      let j = q + 1;
      let inHole = false;
      let end = -1;
      while (j < le) {
        const d = t[j];
        if (!verbatim && d === "\\") {
          j += 2;
          continue;
        }
        if (d === '"') {
          if (verbatim && t[j + 1] === '"') {
            j += 2;
            continue;
          }
          end = j + 1;
          break;
        }
        if (interpolated && d === "{") {
          if (t[j + 1] === "{") {
            j += 2;
            continue;
          }
          const close = scanCode(t, j + 1, "}", "");
          if (close < 0 || close >= le) return null;
          if (offset > j && offset <= close) inHole = true;
          j = close + 1;
          continue;
        }
        j++;
      }
      if (offset > q && (end < 0 || offset < end)) return { start: i, quote: q, end, verbatim, interpolated, inHole };
      if (end < 0) return null;
      i = end;
      continue;
    }
    i++;
  }
  return null;
}

// ---------------------------------------------------------------------------
// `///` → XML doc comment

/** The declaration header below `offset`'s line, joined onto one line, attributes skipped. */
function declarationBelow(t: string, offset: number): string | null {
  let { end } = lineBounds(t, offset);
  const parts: string[] = [];
  for (let n = 0; n < 30; n++) {
    const s = t.indexOf("\n", end) + 1;
    if (s <= 0) return null;
    const b = lineBounds(t, s);
    end = b.end;
    let line = t.slice(b.start, b.end).trim();
    if (!parts.length) {
      if (!line || line.startsWith("//") || line.startsWith("#")) return null;
      // Attributes, on their own line or before the declaration.
      while (line.startsWith("[")) {
        const attr = bracketed(line, 0);
        if (attr === null) break;
        line = line.slice(attr.length + 2).trim();
      }
      if (!line) continue;
    }
    parts.push(line);
    const head = topLevelHead(parts.join(" "));
    if (head !== null) return head || null;
  }
  return null;
}

/** The part of `s` before its first `{`, `;` or `=` outside brackets and strings. */
function topLevelHead(s: string): string | null {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'") {
      const end = skipLiteral(s, i);
      if (end < 0) return null;
      i = end - 1;
    } else if (c === "(" || c === "[" || c === "<") depth++;
    else if (c === ")" || c === "]" || (c === ">" && s[i - 1] !== "=")) depth--;
    else if (depth === 0 && (c === "{" || c === ";" || c === "=")) return s.slice(0, i).trim();
  }
  return null;
}

/** Splits `s` on top-level commas. */
function splitTop(s: string) {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'") {
      const end = skipLiteral(s, i);
      if (end > 0) i = end - 1;
    } else if ("([<{".includes(c)) depth++;
    else if (")]>}".includes(c)) depth--;
    else if (c === "," && depth === 0) {
      out.push(s.slice(from, i));
      from = i + 1;
    }
  }
  out.push(s.slice(from));
  return out.map((p) => p.trim()).filter(Boolean);
}

/** The text between the bracket at `open` and its match, or null. */
function bracketed(s: string, open: number) {
  const pair: Record<string, string> = { "(": ")", "<": ">", "[": "]" };
  const close = pair[s[open]];
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === s[open]) depth++;
    else if (s[i] === close && --depth === 0) return s.slice(open + 1, i);
  }
  return null;
}

const paramName = (p: string) => {
  const noDefault = p.replace(/\s*=.*$/s, "");
  return /@?\w+$/.exec(noDefault)?.[0]?.replace(/^@/, "");
};

const HEAD_WORDS = /^(public|private|protected|internal|static|extern|unsafe|file|virtual|override|abstract|sealed|new|async|partial|readonly|ref|delegate|record|implicit|explicit)$/;

/** The `(` of a header's parameter list: after a name, not a tuple type's. */
function paramParen(head: string) {
  for (let i = head.indexOf("("); i >= 0; i = head.indexOf("(", i + 1)) {
    let p = i;
    while (p > 0 && head[p - 1] === " ") p--;
    if (head[p - 1] === ">" || /\boperator\s*\S+$/.test(head.slice(0, p))) return i;
    const w = /@?\w+$/.exec(head.slice(0, p))?.[0];
    if (w && !HEAD_WORDS.test(w)) return i;
    if (w === "record" || w === "delegate") continue;
  }
  return -1;
}

/** The doc comment lines for a declaration header, `|` marking the caret. */
export function docCommentFor(head: string): string[] {
  const lines = ["<summary>", "|", "</summary>"];
  // Not the `class` of a `where T : class` constraint.
  const typeMatch = /\b(class|struct|interface|enum|record|delegate)\b/.exec(head.split(/[(:]|\bwhere\b/)[0]);
  // The name: just before the type parameters or parameters, else the last word.
  const paren = typeMatch && typeMatch[1] !== "delegate" && typeMatch[1] !== "record" ? -1 : paramParen(head);
  const before = paren >= 0 ? head.slice(0, paren) : head.replace(/\s*(:|\bwhere\b).*$/s, "");
  let nameEnd = before.trimEnd().length;
  let typeParams: string[] = [];
  if (before.trimEnd().endsWith(">")) {
    const lt = before.lastIndexOf("<", nameEnd);
    const tp = lt >= 0 ? bracketed(before, lt) : null;
    if (tp !== null) typeParams = splitTop(tp).map((x) => /\w+$/.exec(x)?.[0] ?? "").filter(Boolean);
    nameEnd = lt;
  }
  const words = before.slice(0, nameEnd).trim().split(/\s+/);
  const name = words.pop() ?? "";
  for (const tp of typeParams) lines.push(`<typeparam name="${tp}"></typeparam>`);
  if (paren >= 0) {
    const params = splitTop(bracketed(head, paren) ?? "").map(paramName).filter((n): n is string => !!n);
    for (const p of params) lines.push(`<param name="${p}"></param>`);
  }
  if (paren >= 0 && !typeMatch) {
    const ret = words.filter((w) => !MODIFIERS.has(w) && !/^(virtual|override|abstract|sealed|new|async|partial|readonly|ref)$/.test(w)).pop();
    const isAsyncTask = /\basync\b/.test(head) && (ret === "Task" || ret === "ValueTask");
    const isCtor = !ret || name.startsWith("~");
    if (ret && ret !== "void" && !isAsyncTask && !isCtor) lines.push("<returns></returns>");
  } else if (typeMatch?.[1] === "delegate" && !/\bdelegate\s+void\b/.test(head)) lines.push("<returns></returns>");
  return lines;
}

/** `/` typed after `//` above a declaration: the `///` doc comment, caret in its summary. */
export function docCommentEdit(t: string, offset: number, eol = "\n"): BodyEdit | null {
  const { start, end } = lineBounds(t, offset);
  const lineBefore = t.slice(start, offset);
  if (!/^[ \t]*\/\/$/.test(lineBefore) || t.slice(offset, end).trim()) return null;
  // Not inside a doc comment already.
  const prevEnd = start - 1;
  if (prevEnd > 0) {
    const prev = lineBounds(t, prevEnd);
    if (/^\s*\/\/\//.test(t.slice(prev.start, prev.end))) return null;
  }
  const head = declarationBelow(t, offset);
  if (!head) return null;
  const indent = /^[ \t]*/.exec(lineBefore)![0];
  const lines = docCommentFor(head);
  let text = "";
  let caret = 0;
  lines.forEach((l, i) => {
    const prefix = i === 0 ? "/ " : `${eol}${indent}/// `;
    if (l === "|") {
      text += `${eol}${indent}/// `;
      caret = text.length;
    } else text += prefix + l;
  });
  return { start: offset, end: offset, text, caret: offset + caret };
}

/** Enter inside a `///` comment: the new line continues it. */
export function docCommentEnter(t: string, offset: number, eol = "\n"): BodyEdit | null {
  const { start } = lineBounds(t, offset);
  const m = /^([ \t]*)\/\/\/ ?/.exec(t.slice(start, offset));
  if (!m || offset < start + m[1].length + 3) return null;
  // Spaces after the caret move to the new line's prefix, not after it.
  let to = offset;
  while (t[to] === " " || t[to] === "\t") to++;
  const text = `${eol}${m[1]}/// `;
  return { start: offset, end: to, text, caret: offset + text.length };
}

// ---------------------------------------------------------------------------
// Strings

/**
 * `{` typed in a plain string makes it interpolated: `"Hp: |"` → `$"Hp: {|}"`.
 * Not when the string already has braces, which `string.Format` may use.
 */
/** Whether `offset` follows an odd run of backslashes: inside an escape like `\n`. */
function inEscape(t: string, offset: number) {
  let n = 0;
  while (t[offset - 1 - n] === "\\") n++;
  return n % 2 === 1;
}

export function interpolateEdit(t: string, offset: number): BodyEdit | null {
  const lit = literalAt(t, offset);
  if (!lit || lit.interpolated || lit.end < 0 || (!lit.verbatim && inEscape(t, offset))) return null;
  if (/[{}]/.test(t.slice(lit.quote + 1, lit.end - 1))) return null;
  const text = "$" + t.slice(lit.start, offset) + "{}";
  return { start: lit.start, end: offset, text, caret: lit.start + text.length - 1 };
}

/** Enter in a plain one-line string splits it: `"Hello |world"` → `"Hello " +` / `"world"`. */
export function splitStringEdit(t: string, offset: number, indentUnit: string, eol = "\n"): BodyEdit | null {
  const lit = literalAt(t, offset);
  if (!lit || lit.verbatim || lit.inHole || lit.end < 0 || inEscape(t, offset)) return null;
  // Not between the braces of a `{{` or `}}` escape.
  if (lit.interpolated && ((t[offset - 1] === "{" && t[offset] === "{") || (t[offset - 1] === "}" && t[offset] === "}"))) return null;
  const { start } = lineBounds(t, offset);
  const indent = /^[ \t]*/.exec(t.slice(start))![0];
  const prefix = t.slice(lit.start, lit.quote);
  const text = `" +${eol}${indent}${indentUnit}${prefix}"`;
  return { start: offset, end: offset, text, caret: offset + text.length };
}

// ---------------------------------------------------------------------------
// `{` before an embedded statement

const BRACE_HEADER = /(?:^|[\s}])(?:(?:else\s+)?if|while|for|foreach|using|lock|fixed)\s*$/;
const BRACE_STARTS_BLOCK = /^(if|else|while|for|foreach|using|lock|fixed|switch|try|do|return\s*;)\b/;

/**
 * `{` typed between an `if (...)` or `else` and the one-line statement after
 * it wraps that statement in a block, as in Rider:
 * `if (x) |Foo();` → `if (x)` / `{` / `    Foo();|` / `}`.
 */
export function braceStatementEdit(t: string, offset: number, indentUnit: string, eol = "\n"): BodyEdit | null {
  const { start, end } = lineBounds(t, offset);
  const headerEnd = skipWsBack(t, offset);
  if (headerEnd <= start || inCommentOrString(t, offset)) return null;
  if (t[headerEnd - 1] === ")") {
    const open = matchBack(t, headerEnd, "(", ")");
    if (open < start || !BRACE_HEADER.test(t.slice(start, open))) return null;
  } else if (!(wordBack(t, headerEnd) === headerEnd - 4 && /(?:^|[\s}])else$/.test(t.slice(start, headerEnd)))) return null;

  const stmtStart = skipWsFwd(t, offset);
  if (stmtStart >= end || t[stmtStart] === "{" || BRACE_STARTS_BLOCK.test(t.slice(stmtStart, end))) return null;
  const semi = scanCode(t, stmtStart, ";", "");
  if (semi < 0 || semi >= end) return null;
  // Only a comment may follow the statement on its line.
  const rest = t.slice(semi + 1, end).trim();
  if (rest && !rest.startsWith("//") && !rest.startsWith("/*")) return null;

  const indent = /^[ \t]*/.exec(t.slice(start, end))![0];
  const inner = indent + indentUnit;
  const stmt = t.slice(stmtStart, semi + 1);
  const head = `${eol}${indent}{${eol}${inner}`;
  const tail = rest ? ` ${rest}` : "";
  return { start: headerEnd, end, text: `${head}${stmt}${tail}${eol}${indent}}`, caret: headerEnd + head.length + stmt.length };
}

// ---------------------------------------------------------------------------
// `;` inside closing brackets

/**
 * `;` typed before the closing brackets that end a line goes after them:
 * `Foo(Bar(x|))` → `Foo(Bar(x));|`. Not in `for (...)`, strings or comments.
 */
export function semicolonEdit(t: string, offset: number): BodyEdit | null {
  const { start, end } = lineBounds(t, offset);
  const after = t.slice(offset, end);
  const m = /^([)\]]+)\s*(;?)\s*$/.exec(after);
  if (!m) return null;
  const line = t.slice(start, end);
  // Not the condition of an `if (...)` or `for (...)`, nor an attribute.
  if (/^\s*(}\s*)?(if|else\s+if|for|foreach|while|using|lock|switch|fixed|catch)\s*\(|^\s*\[/.test(line) || literalAt(t, offset)) return null;
  const before = t.slice(start, offset);
  if (/\/\/|\/\*/.test(before.replace(/"(?:[^"\\]|\\.)*"/g, '""'))) return null;
  // The closers must close brackets opened on this line, or it is not one statement.
  let depth = 0;
  for (const c of before.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""')) {
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
  }
  if (depth !== m[1].length) return null;
  const closeEnd = offset + m[1].length;
  if (m[2]) {
    // Already there: step over it.
    const semi = t.indexOf(";", closeEnd);
    return { start: offset, end: offset, text: "", caret: semi + 1 };
  }
  return { start: closeEnd, end: closeEnd, text: ";", caret: closeEnd + 1 };
}

// ---------------------------------------------------------------------------
// Backspace in indentation

const width = (ws: string, tabSize: number) => {
  let w = 0;
  for (const c of ws) w = c === "\t" ? w - (w % tabSize) + tabSize : w + 1;
  return w;
};

/** The indentation a line at `lineStart` should have, from the line above it; null when unsure. */
function properIndent(t: string, lineStart: number, rest: string, indentUnit: string): string | null {
  let i = lineStart - 1;
  while (i > 0) {
    const b = lineBounds(t, i);
    const line = t.slice(b.start, b.end);
    if (line.trim()) {
      let indent = /^[ \t]*/.exec(line)![0];
      const code = line.replace(/\/\/.*$/, "").trimEnd();
      // A continued expression or argument list: its alignment is the writer's.
      if (/(,|[-+*/%&|^?:=<>!]|=>)$/.test(code) && !code.endsWith("=>")) return null;
      // The end of a statement begun on a line above (`    b);`): its indentation is not the block's.
      const bare = code.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
      if ((bare.match(/[)\]]/g)?.length ?? 0) > (bare.match(/[([]/g)?.length ?? 0)) return null;
      const braceless = /^\s*(if|else if|for|foreach|while|using|lock|fixed)\b.*\)$|^\s*(else|do)$|=>$/.test(code);
      if (braceless || code.endsWith("{") || code.endsWith("(") || code.endsWith("[")) indent += indentUnit;
      if (/^[}\])]/.test(rest.trim())) indent = indent.endsWith(indentUnit) ? indent.slice(0, -indentUnit.length) : indent.replace(/[ \t]$/, "");
      return indent;
    }
    i = b.start - 1;
  }
  return "";
}

/**
 * Backspace with only indentation before the caret, as in Rider: past the
 * proper indentation it goes back to it; at it, on a blank line, the line goes
 * and the caret ends the line above.
 */
export function backspaceEdit(t: string, offset: number, indentUnit: string, tabSize: number): BodyEdit | null {
  const { start, end } = lineBounds(t, offset);
  const before = t.slice(start, offset);
  if (!before || /[^ \t]/.test(before) || start === 0) return null;
  const rest = t.slice(offset, end);
  const proper = properIndent(t, start, rest, indentUnit);
  if (proper === null) return null;
  const w = width(before, tabSize);
  const p = width(proper, tabSize);
  if (w > p) return { start, end: offset, text: proper, caret: start + proper.length };
  // Shallower than it should be: the guess is off, Backspace does as usual.
  if (w < p || rest.trim()) return null;
  // Remove the blank line, along with trailing spaces of the line above.
  let from = start - 1;
  if (t[from - 1] === "\r") from--;
  while (from > 0 && (t[from - 1] === " " || t[from - 1] === "\t")) from--;
  return { start: from, end, text: "", caret: from };
}

// ---------------------------------------------------------------------------
// #region

/** Enter at the end of a `#region` line that has no `#endregion` yet closes it below. */
export function regionEdit(t: string, offset: number, eol = "\n"): BodyEdit | null {
  const { start, end } = lineBounds(t, offset);
  if (offset !== end) return null;
  const m = /^([ \t]*)#region\b/.exec(t.slice(start, end));
  if (!m) return null;
  // Only when the file has more regions than ends.
  let open = 0;
  for (const r of t.matchAll(/^[ \t]*#(region|endregion)\b/gm)) open += r[1] === "region" ? 1 : -1;
  if (open <= 0) return null;
  const text = `${eol}${m[1]}${eol}${m[1]}#endregion`;
  return { start: offset, end: offset, text, caret: offset + eol.length + m[1].length };
}

// ---------------------------------------------------------------------------
// Complete Statement (Ctrl+Shift+Enter)

const BLOCK_STATEMENT = /^(if|else\s+if|while|for|foreach|using|lock|switch|fixed|catch)\b/;
const BLOCK_WORD = /^(else|try|finally|do|catch|unsafe|checked|unchecked)$/;
const TYPE_DECL = /^([\w\s]*\s)?(class|struct|interface|enum|record|namespace)\s+\w/;

/** `if (x)` with nothing after its condition: the line wants a block, not `if (x) Foo()`. */
function conditionEndsLine(s: string) {
  const open = s.indexOf("(");
  if (open < 0) return false;
  const inside = bracketed(s, open);
  return inside !== null && open + inside.length + 2 === s.length;
}

/**
 * Completes the statement on the caret's line, as Rider's Complete Statement:
 * closes open brackets, adds the `;` or the `{ }` block it lacks, and moves the
 * caret to where the next statement goes.
 */
export function completeStatement(t: string, offset: number, indentUnit: string, eol = "\n"): BodyEdit | null {
  const { start, end } = lineBounds(t, offset);
  const line = t.slice(start, end);
  // The code of the line, without a trailing comment.
  let codeEnd = end;
  for (let i = line.indexOf("//"); i >= 0; i = line.indexOf("//", i + 2)) {
    if (!literalAt(t, start + i + 1)) {
      codeEnd = start + i;
      break;
    }
  }
  while (codeEnd > start && isWs(t[codeEnd - 1])) codeEnd--;
  const code = t.slice(start, codeEnd).trim();
  const indent = /^[ \t]*/.exec(line)![0];
  const inner = indent + indentUnit;
  // Brackets left open on the line, closed in reverse.
  const stack: string[] = [];
  const pairs: Record<string, string> = { "(": ")", "[": "]" };
  for (let i = start; i < codeEnd; i++) {
    const c = t[i];
    if (c === '"' || c === "'" || ((c === "$" || c === "@") && /^[$@]*"/.test(t.slice(i, i + 4)))) {
      const e = skipLiteral(t, i);
      if (e < 0 || e > codeEnd) break;
      i = e - 1;
    } else if (c in pairs) stack.push(pairs[c]);
    else if ((c === ")" || c === "]") && stack[stack.length - 1] === c) stack.pop();
  }
  const closers = stack.reverse().join("");
  const full = code + closers;

  const newLine = (at: number, add: string, pad: string): BodyEdit => {
    const text = `${add}${eol}${pad}`;
    return { start: at, end: at, text, caret: at + text.length };
  };
  // A comment, a directive, an attribute or a label: nothing to add.
  if (!code || code.startsWith("#") || (full.startsWith("[") && full.endsWith("]"))) return newLine(end, closers, indent);
  if (/[{};,]$/.test(full)) return newLine(end, "", full.endsWith("{") ? inner : indent);
  if (full.endsWith(":") && !full.endsWith("::")) return newLine(end, "", inner);
  // `} else`, `} catch (e)`: the keyword after the brace; `} while (x)` ends a `do`.
  const word = code.replace(/^}\s*/, "");
  const doWhile = code.startsWith("}") && /^while\b/.test(word);

  const headerKind = full.endsWith(")") ? memberKind(t.slice(0, codeEnd) + closers, codeEnd + closers.length) : null;
  const isBlock =
    (BLOCK_STATEMENT.test(word) && !doWhile && conditionEndsLine(full)) ||
    BLOCK_WORD.test(word) ||
    TYPE_DECL.test(code) ||
    // A method header, not a call: something (a type, a modifier) comes before its name.
    (headerKind !== null && headerKind.kind !== "property" && (headerKind.headerStart > start + indent.length || code.startsWith("~")));
  if (isBlock) {
    // A `{` already on the next line: just step into the block.
    const next = t.indexOf("\n", end);
    if (!closers && next >= 0) {
      const nb = lineBounds(t, next + 1);
      if (t.slice(nb.start, nb.end).trim() === "{") return newLine(nb.end, "", inner);
    }
    // A trailing comment stays on the statement's line.
    const head = `${closers}${t.slice(codeEnd, end)}${eol}${indent}{${eol}${inner}`;
    return { start: codeEnd, end, text: `${head}${eol}${indent}}`, caret: codeEnd + head.length };
  }
  const text = `${closers};`;
  const rest = t.slice(codeEnd, end);
  const after = `${eol}${indent}`;
  return { start: codeEnd, end: end, text: text + rest + after, caret: codeEnd + text.length + rest.length + after.length };
}

// ---------------------------------------------------------------------------

export type TypingKey = "{" | "Enter" | "/" | ";" | "Backspace";

export interface TypingOptions {
  indentUnit: string;
  tabSize: number;
  eol: string;
}

/** A cheap look at the caret's line: false when no assist can apply, so the whole text need not be read. */
export function mayApply(key: TypingKey, lineBefore: string, lineAfter: string): boolean {
  switch (key) {
    case "{":
      return (
        lineBefore.includes("=>") ||
        lineAfter.trimStart().startsWith("=>") ||
        lineBefore.includes('"') ||
        (/(\)|\belse)\s*$/.test(lineBefore) && lineAfter.includes(";"))
      );
    case "Enter":
      return /\/\/\/|#region|"|\{/.test(lineBefore) || /[{}]/.test(lineAfter);
    case "/":
      return /^[ \t]*\/\/$/.test(lineBefore) && !lineAfter.trim();
    case ";":
      return /^[)\]]/.test(lineAfter);
    case "Backspace":
      return lineBefore.length > 0 && !/[^ \t]/.test(lineBefore);
  }
}

/** The typing assist for `key` pressed at `offset` with no selection, or null to type it as usual. */
export function typingEdit(key: TypingKey, t: string, offset: number, o: TypingOptions): BodyEdit | null {
  switch (key) {
    case "{":
      return expandExpressionBody(t, offset, o.indentUnit, o.eol) ?? interpolateEdit(t, offset) ?? braceStatementEdit(t, offset, o.indentUnit, o.eol);
    case "Enter":
      return (
        docCommentEnter(t, offset, o.eol) ??
        regionEdit(t, offset, o.eol) ??
        splitStringEdit(t, offset, o.indentUnit, o.eol) ??
        expandInlineMethod(t, offset, o.indentUnit, o.eol)
      );
    case "/":
      return docCommentEdit(t, offset, o.eol);
    case ";":
      return semicolonEdit(t, offset);
    case "Backspace":
      return backspaceEdit(t, offset, o.indentUnit, o.tabSize);
  }
}
