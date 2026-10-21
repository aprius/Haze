// Finds file references in terminal output, e.g.
//   src/Program.cs(12,5): error CS1002     (MSBuild / dotnet)
//   src/app.ts:42:7                         (most tools)
//   ./README.md

export interface PathMatch {
  /** Offset of the match in the line (string index). */
  index: number;
  /** Full matched text, including any line/column suffix. */
  text: string;
  path: string;
  line?: number;
  column?: number;
}

const PATH_RE =
  /((?:[A-Za-z]:[\\/]|~\/|\.{1,2}[\\/]|\/)?(?:[\w.@+-]+[\\/])*[\w@+-][\w.@+-]*\.[A-Za-z][A-Za-z0-9]{0,9})(?:\((\d+)(?:,(\d+))?\)|:(\d+)(?::(\d+))?)?/g;

export function findPathCandidates(line: string): PathMatch[] {
  const out: PathMatch[] = [];
  for (const m of line.matchAll(PATH_RE)) {
    const index = m.index ?? 0;
    // Skip anything inside a URL (`https://host/x.html`).
    const tokenStart = line.lastIndexOf(" ", index) + 1;
    if (/^[a-z][\w+.-]*:\/\//i.test(line.slice(tokenStart))) continue;
    const lineNo = m[2] ?? m[4];
    const colNo = m[3] ?? m[5];
    out.push({
      index,
      text: m[0],
      path: m[1],
      line: lineNo ? Number(lineNo) : undefined,
      column: colNo ? Number(colNo) : undefined,
    });
  }
  return out;
}

/**
 * Directory a shell reports as it changes: OSC 7 (`file://host/path`, fish,
 * Starship, macOS zsh…) or OSC 9;9 (`9;C:\path`, Windows Terminal style).
 */
export function parseOscCwd(code: 7 | 9, data: string): string | null {
  if (code === 9) {
    if (!data.startsWith("9;")) return null;
    return data.slice(2).replace(/^"(.*)"$/, "$1") || null;
  }
  try {
    const url = new URL(data);
    if (url.protocol !== "file:") return null;
    const path = decodeURIComponent(url.pathname);
    // file:///C:/Users/me → C:/Users/me
    return /^\/[A-Za-z]:/.test(path) ? path.slice(1) : path || null;
  } catch {
    return null;
  }
}
