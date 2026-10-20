// Conversions between LSP shapes (0-based, file URIs) and Monaco / Haze
// shapes (1-based, OS paths).
import { monaco } from "../monaco";

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export interface LspLocationLink {
  targetUri: string;
  targetRange: LspRange;
  targetSelectionRange: LspRange;
}

export interface LspTextEdit {
  range: LspRange;
  newText: string;
}

const isWindows = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);

/** `file:///c%3A/x/y.cs` → `C:\x\y.cs`; `file:///x/y.cs` → `/x/y.cs`. */
export function uriToPath(uri: string, windows = isWindows): string {
  if (!uri.startsWith("file:")) return uri;
  let p = decodeURIComponent(uri.replace(/^file:\/\//, ""));
  if (/^\/[A-Za-z]:/.test(p)) {
    p = p[1].toUpperCase() + p.slice(2);
    return p.replace(/\//g, "\\");
  }
  return windows ? p.replace(/\//g, "\\") : p;
}

export function pathToUri(path: string): string {
  return monaco.Uri.file(path).toString();
}

export function toMonacoRange(r: LspRange): monaco.IRange {
  return {
    startLineNumber: r.start.line + 1,
    startColumn: r.start.character + 1,
    endLineNumber: r.end.line + 1,
    endColumn: r.end.character + 1,
  };
}

export function toLspPosition(p: monaco.IPosition): LspPosition {
  return { line: p.lineNumber - 1, character: p.column - 1 };
}

export function toLspRange(r: monaco.IRange): LspRange {
  return {
    start: { line: r.startLineNumber - 1, character: r.startColumn - 1 },
    end: { line: r.endLineNumber - 1, character: r.endColumn - 1 },
  };
}

/** Normalizes Location | Location[] | LocationLink[] | null. */
export function toLocations(result: unknown): LspLocation[] {
  if (!result) return [];
  const list = Array.isArray(result) ? result : [result];
  return list.map((l: LspLocation | LspLocationLink) =>
    "targetUri" in l ? { uri: l.targetUri, range: l.targetSelectionRange ?? l.targetRange } : l,
  );
}

// LSP SymbolKind (1-based) → Monaco SymbolKind (0-based, same order).
export function toSymbolKind(kind: number): monaco.languages.SymbolKind {
  return Math.max(0, kind - 1) as monaco.languages.SymbolKind;
}

const SYMBOL_KIND_NAMES = [
  "File",
  "Module",
  "Namespace",
  "Package",
  "Class",
  "Method",
  "Property",
  "Field",
  "Constructor",
  "Enum",
  "Interface",
  "Function",
  "Variable",
  "Constant",
  "String",
  "Number",
  "Boolean",
  "Array",
  "Object",
  "Key",
  "Null",
  "EnumMember",
  "Struct",
  "Event",
  "Operator",
  "TypeParameter",
];

export function symbolKindName(kind: number): string {
  return SYMBOL_KIND_NAMES[kind - 1] ?? "Symbol";
}

// LSP CompletionItemKind (1-based) → Monaco CompletionItemKind.
export function toCompletionKind(kind: number | undefined): monaco.languages.CompletionItemKind {
  const K = monaco.languages.CompletionItemKind;
  const map: Record<number, monaco.languages.CompletionItemKind> = {
    1: K.Text,
    2: K.Method,
    3: K.Function,
    4: K.Constructor,
    5: K.Field,
    6: K.Variable,
    7: K.Class,
    8: K.Interface,
    9: K.Module,
    10: K.Property,
    11: K.Unit,
    12: K.Value,
    13: K.Enum,
    14: K.Keyword,
    15: K.Snippet,
    16: K.Color,
    17: K.File,
    18: K.Reference,
    19: K.Folder,
    20: K.EnumMember,
    21: K.Constant,
    22: K.Struct,
    23: K.Event,
    24: K.Operator,
    25: K.TypeParameter,
  };
  return map[kind ?? 1] ?? K.Text;
}

export function markupToString(contents: unknown): string {
  if (!contents) return "";
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) return contents.map(markupToString).filter(Boolean).join("\n\n");
  const c = contents as { kind?: string; value?: string; language?: string };
  if (c.language) return "```" + c.language + "\n" + (c.value ?? "") + "\n```";
  if (c.kind === "plaintext") return "```text\n" + (c.value ?? "") + "\n```";
  return c.value ?? "";
}
