// Extend Selection (Ctrl+W / Alt+Up) for C#, like Rider's: each step selects
// the next enclosing piece of syntax, found from brackets, statements and
// operators in the text (no Roslyn):
//   position → transform.position → transform.position.x → the argument →
//   all arguments → the call → the right-hand side → the statement → the
//   block's statements → the block → the if / method / class, doc comment included.
import { skipLiteral } from "./csharpTyping";

type Span = [number, number];

interface Region {
  start: number;
  end: number;
  kind: "string" | "comment" | "directive";
}

interface Structure {
  /** Strings, comments and directive lines, in order. */
  regions: Region[];
  /** Each bracket's matching bracket, both ways. */
  pair: Map<number, number>;
}

const OPEN: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const isIdent = (c: string | undefined) => !!c && /[\w@]/.test(c);
const isWs = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r";

function structure(t: string): Structure {
  const regions: Region[] = [];
  const pair = new Map<number, number>();
  const stack: number[] = [];
  let lineStart = true;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === "\n") {
      lineStart = true;
      continue;
    }
    if (lineStart && c === "#") {
      const nl = t.indexOf("\n", i);
      const end = nl < 0 ? t.length : nl;
      regions.push({ start: i, end, kind: "directive" });
      i = end - 1;
      continue;
    }
    if (!isWs(c)) lineStart = false;
    if (c === "/" && t[i + 1] === "/") {
      const nl = t.indexOf("\n", i);
      let end = nl < 0 ? t.length : nl;
      if (t[end - 1] === "\r") end--;
      regions.push({ start: i, end, kind: "comment" });
      i = end - 1;
      continue;
    }
    if (c === "/" && t[i + 1] === "*") {
      const close = t.indexOf("*/", i + 2);
      const end = close < 0 ? t.length : close + 2;
      regions.push({ start: i, end, kind: "comment" });
      i = end - 1;
      continue;
    }
    if (c === '"' || c === "'" || ((c === "$" || c === "@") && /^[$@]*"/.test(t.slice(i, i + 4)))) {
      const end = skipLiteral(t, i);
      if (end < 0) {
        // Unterminated: to the end of the line.
        const nl = t.indexOf("\n", i);
        regions.push({ start: i, end: nl < 0 ? t.length : nl, kind: "string" });
        i = (nl < 0 ? t.length : nl) - 1;
        continue;
      }
      regions.push({ start: i, end, kind: "string" });
      i = end - 1;
      continue;
    }
    if (c in OPEN) stack.push(i);
    else if (c === ")" || c === "]" || c === "}") {
      // Pop to the matching opener; a stray closer is ignored.
      for (let k = stack.length - 1; k >= 0; k--) {
        if (OPEN[t[stack[k]]] === c) {
          pair.set(stack[k], i);
          pair.set(i, stack[k]);
          stack.length = k;
          break;
        }
      }
    }
  }
  return { regions, pair };
}

/** The region containing `i` (start inclusive, end exclusive), if any. */
function regionAt(s: Structure, i: number): Region | undefined {
  let lo = 0;
  let hi = s.regions.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = s.regions[mid];
    if (i < r.start) hi = mid - 1;
    else if (i >= r.end) lo = mid + 1;
    else return r;
  }
  return undefined;
}

/** Skips whitespace, comments and directives from `i` up to `to`. */
function skipTrivia(t: string, s: Structure, i: number, to: number) {
  while (i < to) {
    if (isWs(t[i])) i++;
    else {
      const r = regionAt(s, i);
      if (r && r.kind !== "string") i = r.end;
      else break;
    }
  }
  return i;
}

/** Trims whitespace (and trivia) off both ends of a span. */
function trim(t: string, s: Structure, a: number, b: number): Span | null {
  a = skipTrivia(t, s, a, b);
  while (b > a && isWs(t[b - 1])) b--;
  return b > a ? [a, b] : null;
}

/** Top-level statements between `from` and `to` (a block's inside, or the file). */
function statements(t: string, s: Structure, from: number, to: number): Span[] {
  const out: Span[] = [];
  let i = skipTrivia(t, s, from, to);
  while (i < to) {
    const start = i;
    let end = -1;
    while (i < to) {
      const r = regionAt(s, i);
      if (r) {
        i = r.end;
        continue;
      }
      const c = t[i];
      if (c === ";") {
        end = i + 1;
        break;
      }
      // A switch section's label is a statement of its own.
      if (c === ":" && t[i + 1] !== ":" && /^(case\b|default\s*$)/.test(t.slice(start, i))) {
        end = i + 1;
        break;
      }
      if (c === "(" || c === "[") {
        i = (s.pair.get(i) ?? to - 1) + 1;
        continue;
      }
      if (c === "{") {
        const close = s.pair.get(i) ?? to - 1;
        i = close + 1;
        // A block ends its statement unless the statement goes on after it.
        const next = skipTrivia(t, s, i, to);
        const rest = t.slice(next, next + 8);
        if (/^[;,).?=]/.test(rest) || /^(else|catch|finally)\b/.test(rest) || (/^while\b/.test(rest) && /^do\b/.test(t.slice(start, start + 3)))) continue;
        // An initializer, lambda or switch expression (`= new() { … }`, `=> {`, `x switch { … }`) goes on to its `;`.
        // (Not the `new()` of a `where T : new()` constraint.)
        if (/(=|=>|\breturn|(?<![:,]\s*)\bnew\b[^;{]*|\bswitch|\bwith|\bdelegate(\s*\([^)]*\))?)\s*$/.test(t.slice(start, s.pair.get(close)!))) continue;
        end = close + 1;
        break;
      }
      i++;
    }
    if (end < 0) {
      const tr = trim(t, s, start, to);
      if (tr) out.push(tr);
      break;
    }
    out.push([start, end]);
    i = skipTrivia(t, s, end, to);
  }
  return out;
}

/** The first top-level `=` (an assignment, not `==`, `<=`, `>=`, `!=`, `=>`) or `=>` in a span, as [offset, length]. */
function topAssign(t: string, s: Structure, a: number, b: number): [number, number] | null {
  for (let i = a; i < b; i++) {
    const r = regionAt(s, i);
    if (r) {
      i = r.end - 1;
      continue;
    }
    const c = t[i];
    if ((c === "(" || c === "[" || c === "{") && s.pair.has(i)) {
      i = s.pair.get(i)!;
      continue;
    }
    if (c !== "=") continue;
    if (t[i + 1] === ">") return [i, 2];
    if (t[i + 1] === "=" || "=!<>".includes(t[i - 1])) {
      i++;
      continue;
    }
    return [i, 1];
  }
  return null;
}

/** Splits `a..b` on top-level commas. */
function commaParts(t: string, s: Structure, a: number, b: number): Span[] {
  const out: Span[] = [];
  let from = a;
  for (let i = a; i < b; i++) {
    const r = regionAt(s, i);
    if (r) {
      i = r.end - 1;
      continue;
    }
    if (t[i] in OPEN && s.pair.has(i)) i = s.pair.get(i)!;
    else if (t[i] === ",") {
      out.push([from, i]);
      from = i + 1;
    }
  }
  out.push([from, b]);
  return out;
}

/** Start of the member-access chain ending just before `end` (`a.B<T>(x)[0].c`). */
function chainStart(t: string, s: Structure, end: number) {
  let i = end;
  for (;;) {
    // One part, right to left: its calls and indexers, type arguments, then its name.
    let called = false;
    while ((t[i - 1] === ")" || t[i - 1] === "]") && s.pair.has(i - 1)) {
      i = s.pair.get(i - 1)!;
      called = true;
    }
    if (called && t[i - 1] === ">") {
      const lt = t.lastIndexOf("<", i - 1);
      if (lt < 0 || !/^[\w\s,.<>[\]?]*$/.test(t.slice(lt + 1, i - 1))) return i;
      i = lt;
    }
    if (!isIdent(t[i - 1])) return i;
    while (isIdent(t[i - 1])) i--;
    // The `.` or `?.` before it, and the part before that.
    const dot = t[i - 1] === "." ? (t[i - 2] === "?" ? i - 2 : i - 1) : -1;
    if (dot < 0) return i;
    const prev = t[dot - 1];
    if (!isIdent(prev) && prev !== ")" && prev !== "]") return i;
    i = dot;
  }
}

/** The ends of each part of the chain going right from the identifier ending at `end`. */
function chainEnds(t: string, s: Structure, end: number): number[] {
  const ends = [end];
  let i = end;
  for (;;) {
    if ((t[i] === "(" || t[i] === "[") && s.pair.has(i)) i = s.pair.get(i)! + 1;
    else if (t[i] === "<") {
      const gt = t.indexOf(">", i);
      if (gt < 0 || t[gt + 1] !== "(" || !/^[\w\s,.<[\]?]*$/.test(t.slice(i + 1, gt))) break;
      i = gt + 1;
      continue;
    } else if ((t[i] === "." || (t[i] === "?" && t[i + 1] === ".")) && isIdent(t[i + (t[i] === "?" ? 2 : 1)])) {
      i += t[i] === "?" ? 2 : 1;
      while (isIdent(t[i])) i++;
    } else break;
    ends.push(i);
  }
  return ends;
}

/** Comment lines directly above `start` (a doc comment, say), or `start`. */
function commentsAbove(t: string, s: Structure, start: number) {
  let first = start;
  let lineStart = t.lastIndexOf("\n", start - 1) + 1;
  while (lineStart > 0) {
    const prevStart = t.lastIndexOf("\n", lineStart - 2) + 1;
    const line = t.slice(prevStart, lineStart - 1);
    const code = line.search(/\S/);
    const r = code >= 0 ? regionAt(s, prevStart + code) : undefined;
    // The comment must fill the rest of its line.
    if (!r || r.kind !== "comment" || r.end < lineStart - 1 - (t[lineStart - 2] === "\r" ? 1 : 0)) break;
    first = r.start;
    lineStart = prevStart;
  }
  return first;
}

/** The selection ranges around `offset`, innermost first (Monaco sorts and keeps the nested ones). */
export function selectionRanges(t: string, offset: number): Span[] {
  const s = structure(t);
  const out: Span[] = [];
  const push = (span: Span | null) => {
    if (span && span[0] <= offset && offset <= span[1] && span[1] > span[0]) out.push(span);
  };

  const region = regionAt(s, offset) ?? (offset > 0 ? regionAt(s, offset - 1) : undefined);
  if (region?.kind === "string") {
    const q = t.indexOf('"', region.start);
    if (q >= 0 && t[region.end - 1] === '"') push([q + 1, region.end - 1]);
    push([region.start, region.end]);
  } else if (region?.kind === "comment") {
    push([region.start, region.end]);
    push([commentsAbove(t, s, region.start), region.end]);
  }

  // The member-access chain through the identifier at the caret.
  if (!region || region.kind === "string") {
    let a = offset;
    let b = offset;
    while (isIdent(t[a - 1])) a--;
    while (isIdent(t[b])) b++;
    // The word itself (Monaco adds it too, but the steps should not depend on that).
    if (b > a) push([a, b]);
    if (b > a && !regionAt(s, a)) {
      const start = chainStart(t, s, b);
      for (const e of chainEnds(t, s, b)) push([start, e]);
    }
  }

  // Enclosing brackets, inside out, and the statements of each block.
  const enclosing: Span[] = [];
  for (const [o, c] of s.pair) if (o < c && o < offset && offset <= c) enclosing.push([o, c]);
  enclosing.sort((x, y) => y[0] - x[0]);
  const blocks: Span[] = [[-1, t.length]];
  for (const [o, c] of enclosing) {
    if (t[o] === "{") {
      blocks.push([o, c]);
      continue;
    }
    for (const part of commaParts(t, s, o + 1, c)) {
      const tr = trim(t, s, part[0], part[1]);
      push(tr);
      // A lambda's body.
      if (tr) {
        const arrow = topAssign(t, s, tr[0], tr[1]);
        if (arrow && arrow[1] === 2) push(trim(t, s, arrow[0] + 2, tr[1]));
      }
    }
    push(trim(t, s, o + 1, c));
    push([o, c + 1]);
    // The call or indexer the brackets belong to.
    if (isIdent(t[o - 1]) || t[o - 1] === ">" || t[o - 1] === ")" || t[o - 1] === "]") push([chainStart(t, s, o), c + 1]);
  }

  for (const [o, c] of blocks) {
    const stmts = statements(t, s, o + 1, c);
    if (o >= 0) {
      if (stmts.length) push([stmts[0][0], stmts[stmts.length - 1][1]]);
      push([o, c + 1]);
    }
    const stmt = stmts.find(([a, b]) => a <= offset && offset <= b);
    if (!stmt) continue;
    const [a, b] = stmt;
    const semi = t[b - 1] === ";";
    if (semi) push(trim(t, s, a, b - 1));
    const assign = topAssign(t, s, a, semi ? b - 1 : b);
    if (assign && offset >= assign[0] + assign[1]) push(trim(t, s, assign[0] + assign[1], semi ? b - 1 : b));
    const ret = /^(return|throw|yield\s+return)\s/.exec(t.slice(a, a + 13));
    if (ret && semi) push(trim(t, s, a + ret[0].length, b - 1));
    push(stmt);
    push([commentsAbove(t, s, a), b]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Move Statement (Ctrl+Shift+Alt+Up/Down)

export interface MoveEdit {
  start: number;
  end: number;
  text: string;
  /** The caret's offset after the edit. */
  caret: number;
}

/**
 * Moves the statement or member at `offset` past its neighbour in the same
 * block, as Rider's Move Statement: whole methods, whole if-blocks, doc
 * comments and attributes along. `"edge"` when there is no neighbour that way
 * (it never leaves its block), null when it shares a line with another
 * statement (move the line instead).
 */
export function moveStatement(t: string, offset: number, up: boolean): MoveEdit | "edge" | null {
  const s = structure(t);
  // Judge by the line's first character: on a `}` line that is the block's end.
  const lineStart = t.lastIndexOf("\n", offset - 1) + 1;
  const lineEnd = t.indexOf("\n", offset);
  // A blank line moves as a line.
  if (!t.slice(lineStart, lineEnd < 0 ? t.length : lineEnd).trim()) return null;
  const ref = skipTrivia(t, s, lineStart, t.length);
  const at = ref < t.length && t.slice(lineStart, ref).indexOf("\n") < 0 ? ref : offset;

  const enclosing: Span[] = [];
  for (const [o, c] of s.pair) if (o < c && t[o] === "{" && o < at && at <= c) enclosing.push([o, c]);
  enclosing.sort((x, y) => y[0] - x[0]);
  enclosing.push([-1, t.length]);
  for (const [o, c] of enclosing) {
    const stmts = statements(t, s, o + 1, c);
    const i = stmts.findIndex(([a, b]) => commentsAbove(t, s, a) <= at && at < b);
    if (i < 0) continue;
    const j = up ? i - 1 : i + 1;
    if (j < 0 || j >= stmts.length) return "edge";
    // Not across a switch section's label, nor a label itself (the section moves as lines).
    const isLabel = (k: number) => /^(case\b|default\s*:)/.test(t.slice(stmts[k][0], stmts[k][1]));
    if (isLabel(i)) return null;
    if (isLabel(j)) return "edge";
    const lines = t.split("\n");
    const lineOf = (pos: number) => {
      let n = 0;
      for (let k = t.indexOf("\n"); k >= 0 && k < pos; k = t.indexOf("\n", k + 1)) n++;
      return n;
    };
    const unit = (k: number): [number, number] => [lineOf(commentsAbove(t, s, stmts[k][0])), lineOf(stmts[k][1] - 1)];
    const [ua, ub] = unit(i);
    const [na, nb] = unit(j);
    // Both must have their lines to themselves.
    const alone = (a: number, b: number, k: number) => {
      const before = t.slice(t.lastIndexOf("\n", commentsAbove(t, s, stmts[k][0]) - 1) + 1, commentsAbove(t, s, stmts[k][0]));
      const endLine = lines[b].replace(/\r$/, "");
      const lineEndStart = t.lastIndexOf("\n", stmts[k][1] - 1) + 1;
      const after = endLine.slice(stmts[k][1] - lineEndStart).trim();
      return !before.trim() && (!after || after.startsWith("//")) && a <= b;
    };
    if (!alone(ua, ub, i) || !alone(na, nb, j)) return null;
    const [first, second] = up ? [[na, nb], [ua, ub]] : [[ua, ub], [na, nb]];
    const piece = (a: number, b: number) => lines.slice(a, b + 1);
    const gap = lines.slice(first[1] + 1, second[0]);
    const moved = [...piece(second[0], second[1]), ...gap, ...piece(first[0], first[1])];
    const offsetOfLine = (n: number) => {
      let o2 = 0;
      for (let k = 0; k < n; k++) o2 += lines[k].length + 1;
      return o2;
    };
    const start = offsetOfLine(first[0]);
    const end = offsetOfLine(second[1]) + lines[second[1]].length;
    // The caret keeps its place in the moved statement.
    const caretLine = lineOf(offset);
    const column = offset - offsetOfLine(caretLine);
    const newLine = up ? first[0] + (caretLine - ua) : ua + (second[1] - second[0] + 1) + gap.length + (caretLine - ua);
    let caret = start;
    for (let k = first[0]; k < newLine; k++) caret += moved[k - first[0]].length + 1;
    return { start, end, text: moved.join("\n"), caret: caret + column };
  }
  return null;
}
