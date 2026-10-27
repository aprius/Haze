// Live diagnostics from Roslyn (pulled per document, see CsharpSession), shown
// like Rider's inspections: errors, warnings, suggestions and hints. Kept
// free of Monaco so it can be tested; the numbers are Monaco's.
//
// What could be "phantom" is left out: nothing before the projects load,
// nothing semantic from a file whose project lost its references, and the
// advice Unity's own analyzers would suppress, for projects generated
// without Microsoft.Unity.Analyzers.
import type { LspRange, LspTextEdit } from "./convert";

export interface LspDiagnostic {
  range: LspRange;
  /** 1 error, 2 warning, 3 information, 4 hint. */
  severity?: number;
  code?: string | number;
  codeDescription?: { href: string };
  source?: string;
  message: string;
  /** 1 unnecessary, 2 deprecated (Roslyn adds VS-only tags too). */
  tags?: number[];
}

/** Monaco's MarkerSeverity. */
export const Severity = { Hint: 1, Info: 2, Warning: 4, Error: 8 } as const;

export interface DiagnosticMarker {
  severity: number;
  message: string;
  code?: string | { value: string; target: string };
  source: string;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  tags?: number[];
}

/** Roslyn's pulled kinds Haze shows; the others are for XAML, Hot Reload and the whole workspace. */
export const PULLED_KINDS = ["syntax", "DocumentCompilerSemantic", "DocumentAnalyzerSyntax", "DocumentAnalyzerSemantic"];

const SEVERITY: Record<number, number> = { 1: Severity.Error, 2: Severity.Warning, 3: Severity.Info, 4: Severity.Hint };

export function codeOf(d: LspDiagnostic): string | undefined {
  return d.code === undefined ? undefined : String(d.code);
}

export function toMarker(d: LspDiagnostic): DiagnosticMarker {
  const code = codeOf(d);
  const tags = d.tags?.filter((t) => t === 1 || t === 2);
  return {
    severity: SEVERITY[d.severity ?? 1] ?? Severity.Error,
    message: d.message,
    code: code && d.codeDescription?.href ? { value: code, target: d.codeDescription.href } : code,
    source: d.source ?? "C#",
    startLineNumber: d.range.start.line + 1,
    startColumn: d.range.start.character + 1,
    endLineNumber: d.range.end.line + 1,
    endColumn: d.range.end.character + 1,
    ...(tags?.length ? { tags } : {}),
  };
}

/**
 * "Predefined type 'System.Object' is not defined": the project's references
 * are gone (the Unity Editor that generated it was moved or uninstalled), so
 * every name in the file would be an error.
 */
export function referencesMissing(diags: LspDiagnostic[]): boolean {
  return diags.some((d) => codeOf(d) === "CS0518");
}

// `x ?? y`, `x?.y`, `x is null` and friends skip UnityEngine.Object's == operator,
// so they are wrong for destroyed objects (Microsoft.Unity.Analyzers' USP0001, 2, 21).
const UNITY_UNSAFE = new Set(["IDE0029", "IDE0030", "IDE0031", "IDE0041", "IDE0083", "IDE0150", "IDE0270"]);
// Unused or never-assigned members and parameters: Unity sets serialized fields and calls messages by name.
const UNUSED_MEMBER = new Set(["IDE0051", "IDE0052", "IDE0060", "IDE0044", "CS0649", "CS0169", "CS0414"]);
const SERIALIZED = /\[\s*(UnityEngine\.)?(SerializeField|SerializeReference)\b/;

export interface UnitySource {
  /** A line of the document, 1-based. */
  line(n: number): string;
  isMessage(name: string): boolean;
}

/** Advice Unity's analyzers would suppress (USP0001–USP0021), or that is wrong for Unity code. */
export function unitySuppressed(d: LspDiagnostic, src: UnitySource): boolean {
  const code = codeOf(d);
  if (!code) return false;
  if (UNITY_UNSAFE.has(code)) return true;
  if (!UNUSED_MEMBER.has(code)) return false;
  const line = d.range.start.line + 1;
  const text = src.line(line);
  // A Unity message, or a parameter of one: `void OnTriggerEnter(Collider other)`.
  const called = /\b([A-Z]\w*)\s*\(/.exec(text);
  if (called && src.isMessage(called[1])) return true;
  // A serialized field: the attribute on its line or the lines above it.
  for (let n = line; n >= Math.max(1, line - 3); n--) {
    const above = src.line(n);
    if (SERIALIZED.test(above)) return true;
    if (n < line && !/^\s*(\[|\/\/)/.test(above)) break;
  }
  return false;
}

/** Whether a build marker already shows this diagnostic (same code on the same line). */
export function shownByBuild(d: LspDiagnostic, build: { code?: unknown; startLineNumber: number }[]): boolean {
  const code = codeOf(d);
  return build.some((b) => {
    const bc = typeof b.code === "object" && b.code ? (b.code as { value: string }).value : b.code;
    return bc === code && b.startLineNumber === d.range.start.line + 1;
  });
}

/** Whether two LSP ranges overlap (or touch: a caret just after a name is on it). */
export function touches(a: LspRange, b: LspRange): boolean {
  const before = (x: { line: number; character: number }, y: { line: number; character: number }) =>
    x.line < y.line || (x.line === y.line && x.character < y.character);
  return !before(a.end, b.start) && !before(b.end, a.start);
}

/** A quick fix that adds a `using` (or qualifies the name): the fix for a missing namespace. */
export function isImportFix(title: string): boolean {
  return /^using [\w.]+;$/.test(title) || /^\w+ - using [\w.]+;$/.test(title);
}

/**
 * The ID of a rule that can be ignored (CS0168, IDE0130, CA1822, UNT0001):
 * not an error (no #pragma or severity turns those off), not one of Unity's
 * inspections (they have names).
 */
export function ruleId(d: LspDiagnostic): string | undefined {
  const code = codeOf(d);
  return (d.severity ?? 1) !== 1 && code && RULE_ID.test(code) ? code : undefined;
}

const RULE_ID = /^[A-Z]{2,}\d+$/;

/** The rule IDs in what was typed in Settings ("ide0130, CS0168"), upper-cased, once each. */
export function parseRuleIds(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((c) => c.toUpperCase()).filter((c) => RULE_ID.test(c)))];
}

/** `#pragma warning disable`/`restore` around the diagnostic's lines, indented like its first one. */
export function pragmaSuppression(code: string, range: LspRange, line: (n: number) => string, lineCount: number): LspTextEdit[] {
  const indent = /^\s*/.exec(line(range.start.line))![0];
  const end = range.end.line;
  const restore = `${indent}#pragma warning restore ${code}`;
  return [
    { range: { start: { line: range.start.line, character: 0 }, end: { line: range.start.line, character: 0 } }, newText: `${indent}#pragma warning disable ${code}\n` },
    end + 1 < lineCount
      ? { range: { start: { line: end + 1, character: 0 }, end: { line: end + 1, character: 0 } }, newText: `${restore}\n` }
      : { range: { start: { line: end, character: line(end).length }, end: { line: end, character: line(end).length } }, newText: `\n${restore}` },
  ];
}

const CS_SECTION = /^\s*\[\*\.(cs|\{[^}]*\bcs\b[^}]*\})\]\s*$/;

/** The .editorconfig text with the rule's severity set (in the `[*.cs]` section, added when missing). */
export function withSeverity(text: string, code: string, severity = "none"): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.length ? text.split(/\r?\n/) : [];
  const entry = `dotnet_diagnostic.${code}.severity = ${severity}`;
  const key = new RegExp(`^\\s*dotnet_diagnostic\\.${code}\\.severity\\s*=`, "i");
  let section = "";
  const set = lines.findIndex((l) => {
    if (/^\s*\[/.test(l)) section = l;
    return CS_SECTION.test(section) && key.test(l);
  });
  if (set >= 0) {
    lines[set] = entry;
    return lines.join(eol);
  }
  // The last [*.cs] section: a later section wins over an earlier one.
  let header = -1;
  lines.forEach((l, i) => CS_SECTION.test(l) && (header = i));
  if (header >= 0) {
    // After the section's last setting.
    let at = header + 1;
    for (let i = at; i < lines.length && !/^\s*\[/.test(lines[i]); i++) if (lines[i].trim()) at = i + 1;
    lines.splice(at, 0, entry);
    return lines.join(eol);
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return [...lines, ...(lines.length ? [""] : []), "[*.cs]", entry, ""].join(eol);
}
