// Inspections of assembly definitions (.asmdef), like Rider's: references to
// assemblies the project does not have or to itself, references by name
// where a GUID would survive a rename, a name that does not match the file,
// and malformed define constraints and version defines.
import type { UnityAssembly, UnityProjectData } from "../ipc";
import type { UnityProblem } from "./inspections";

/** A JSON value with where it is in the text (UTF-16 offsets). */
type Json =
  | { kind: "string"; value: string; start: number; end: number }
  | { kind: "other"; start: number; end: number }
  | { kind: "array"; items: Json[]; start: number; end: number }
  | { kind: "object"; props: { key: string; value: Json }[]; start: number; end: number };

/** Parses JSON, keeping offsets; null when it is malformed (the JSON service reports that). */
export function parseJson(text: string): Json | null {
  let i = 0;
  const ws = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  const str = (): Json & { kind: "string" } => {
    const start = i++;
    let value = "";
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\\") {
        const e = text[++i];
        if (e === "u") {
          value += String.fromCharCode(parseInt(text.slice(i + 1, i + 5), 16));
          i += 4;
        } else value += ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" } as Record<string, string>)[e] ?? e;
      } else value += text[i];
      i++;
    }
    if (text[i] !== '"') throw new Error("unterminated string");
    i++;
    return { kind: "string", value, start, end: i };
  };
  const value = (): Json => {
    ws();
    const start = i;
    const c = text[i];
    if (c === '"') return str();
    if (c === "[") {
      i++;
      const items: Json[] = [];
      ws();
      if (text[i] === "]") return i++, { kind: "array", items, start, end: i };
      for (;;) {
        items.push(value());
        ws();
        if (text[i] === ",") i++;
        else if (text[i] === "]") return i++, { kind: "array", items, start, end: i };
        else throw new Error("bad array");
      }
    }
    if (c === "{") {
      i++;
      const props: { key: string; value: Json }[] = [];
      ws();
      if (text[i] === "}") return i++, { kind: "object", props, start, end: i };
      for (;;) {
        ws();
        if (text[i] !== '"') throw new Error("bad key");
        const key = str().value;
        ws();
        if (text[i++] !== ":") throw new Error("bad object");
        props.push({ key, value: value() });
        ws();
        if (text[i] === ",") i++;
        else if (text[i] === "}") return i++, { kind: "object", props, start, end: i };
        else throw new Error("bad object");
      }
    }
    const m = /^(-?\d+(\.\d+)?([eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 64));
    if (!m) throw new Error("bad value");
    i += m[0].length;
    return { kind: "other", start, end: i };
  };
  try {
    if (text.charCodeAt(0) === 0xfeff) i = 1;
    const v = value();
    ws();
    return i === text.length ? v : null;
  } catch {
    return null;
  }
}

const SYMBOL = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CONSTRAINT = /^\s*!?\s*[A-Za-z_][A-Za-z0-9_]*\s*(\|\|\s*!?\s*[A-Za-z_][A-Za-z0-9_]*\s*)*$/;
const VERSION = "\\d[0-9A-Za-z.+-]*";
const VERSION_EXPR = new RegExp(`^(${VERSION}|[\\[(]\\s*(${VERSION})?\\s*,\\s*(${VERSION})?\\s*[\\])]|\\[\\s*${VERSION}\\s*\\])$`);

/** Whether a version define's expression is one Unity takes: "1.2", "[1.2,2.0)", "(,3.0]", "[1.2.3]"… */
export function validVersionExpression(e: string): boolean {
  const t = e.trim();
  if (!t) return true;
  if (!VERSION_EXPR.test(t)) return false;
  // "[,]" bounds nothing.
  return !/^[[(]\s*,\s*[\])]$/.test(t);
}

/** The assembly a reference ("Game.Core", "GUID:…") points at. */
function resolve(ref: string, data: UnityProjectData): UnityAssembly | "compiled" | null {
  if (/^GUID:/i.test(ref)) {
    const guid = ref.slice(5).toLowerCase();
    return data.assemblies.find((a) => a.guid?.toLowerCase() === guid) ?? null;
  }
  return data.assemblies.find((a) => a.name === ref) ?? (data.compiled.includes(ref) ? "compiled" : null);
}

function rangeOf(text: string, start: number, end: number) {
  const pos = (offset: number) => {
    const before = text.slice(0, offset);
    const line = before.split("\n").length - 1;
    return { line, character: offset - (before.lastIndexOf("\n") + 1) };
  };
  return { start: pos(start), end: pos(end) };
}

/** The problems of an assembly definition at `path`; `data` null while the project is read. */
export function inspectAsmdef(text: string, path: string, data: UnityProjectData | null): UnityProblem[] {
  const root = parseJson(text);
  if (root?.kind !== "object") return [];
  const out: UnityProblem[] = [];
  const at = (j: Json, severity: UnityProblem["severity"], code: string, message: string) =>
    out.push({ range: rangeOf(text, j.start, j.end), severity, code, message });
  const prop = (key: string) => root.props.find((p) => p.key === key)?.value;
  const strings = (j: Json | undefined) => (j?.kind === "array" ? j.items.filter((x) => x.kind === "string") : []) as (Json & { kind: "string" })[];

  const name = prop("name");
  const file = path.split(/[\\/]/).pop()!.replace(/\.asmdef$/i, "");
  if (name?.kind === "string" && name.value && name.value !== file)
    at(name, "info", "MismatchedAsmDefFilename", `The file name does not match the assembly name: rename it to ${name.value}.asmdef.`);

  // Monaco and the index may spell a Windows drive differently (`c:\` and `C:\`).
  const same = (p: string) => p.replace(/\\/g, "/").toLowerCase();
  const self = data?.assemblies.find((a) => same(a.path) === same(path));
  for (const ref of strings(prop("references"))) {
    const v = ref.value;
    const guid = /^GUID:/i.test(v);
    if ((name?.kind === "string" && v === name.value) || (guid && self?.guid && v.slice(5).toLowerCase() === self.guid.toLowerCase())) {
      at(ref, "error", "ReferencingSelf", "An assembly can't reference itself.");
      continue;
    }
    if (!data) continue;
    const target = resolve(v, data);
    if (!target) {
      if (data.assembliesComplete)
        at(ref, "warning", "UnresolvedProjectReference", `There is no assembly ${guid ? `with ${v}` : `"${v}"`}: Unity leaves the reference out when it compiles.`);
    } else if (!guid && target !== "compiled" && target.guid) {
      at(ref, "hint", "PreferGuidReference", `Reference by GUID (GUID:${target.guid}): it keeps working when ${v} is renamed.`);
    }
  }

  for (const c of strings(prop("defineConstraints")))
    if (!CONSTRAINT.test(c.value)) at(c, "error", "InvalidDefineConstraintExpression", `Invalid define constraint "${c.value}": symbols, "!" and "||" only.`);

  const versions = prop("versionDefines");
  for (const item of versions?.kind === "array" ? versions.items : []) {
    if (item.kind !== "object") continue;
    const get = (k: string) => item.props.find((p) => p.key === k)?.value;
    const define = get("define");
    if (define?.kind === "string" && !SYMBOL.test(define.value))
      at(define, "error", "InvalidVersionDefineSymbol", `"${define.value}" is not a valid symbol to define.`);
    const expression = get("expression");
    if (expression?.kind === "string" && !validVersionExpression(expression.value))
      at(expression, "error", "InvalidVersionDefineExpression", `Invalid version expression "${expression.value}": use 1.0, [1.0,2.0], (1.0,2.0), [1.0,2.0) or [1.0].`);
  }
  return out;
}
