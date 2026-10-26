// Live diagnostics from Roslyn (pulled per document, see CsharpSession), shown
// like Rider's inspections: errors, warnings, suggestions and hints. Kept
// free of Monaco so it can be tested; the numbers are Monaco's.
//
// What could be "phantom" is left out: nothing before the projects load,
// nothing semantic from a file whose project lost its references, and the
// advice Unity's own analyzers would suppress, for projects generated
// without Microsoft.Unity.Analyzers.
import type { LspRange } from "./convert";

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
