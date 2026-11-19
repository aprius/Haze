// Review of a diff: comments on its lines, sent to an agent as one prompt, and
// hunks marked accepted. Pure helpers; the state lives in store/review.ts.

/** "old" = the left side of a diff, "new" = the right side. */
export type ReviewSide = "old" | "new";

/** Where a comment sits: a file at one revision ("working" = the file on disk). */
export interface ReviewTarget {
  root: string;
  rel: string;
  side: ReviewSide;
  rev: string;
}

export interface ReviewComment extends ReviewTarget {
  id: string;
  startLine: number;
  endLine: number;
  /** The commented lines as they read when the comment was written. */
  code: string;
  text: string;
  createdAt: number;
}

export const sameTarget = (a: ReviewTarget, b: ReviewTarget) => a.root === b.root && a.rel === b.rel && a.side === b.side && a.rev === b.rev;

const short = (rev: string) => (/^[0-9a-f]{12,}$/.test(rev) ? rev.slice(0, 8) : rev);

/** `src/Foo.cs:12-14`, with the revision when it is not the file on disk. */
export function commentLocation(c: ReviewComment): string {
  const lines = c.startLine === c.endLine ? `${c.startLine}` : `${c.startLine}-${c.endLine}`;
  const where = `${c.rel}:${lines}`;
  if (c.side === "old") return `${where} (old version, ${short(c.rev)})`;
  return c.rev === "working" ? where : `${where} (at ${short(c.rev)})`;
}

/** Longest quote kept whole; a longer one keeps its first and last lines. */
const MAX_QUOTED = 20;
const QUOTE_HEAD = 12;
const QUOTE_TAIL = 6;

/** The commented lines to quote: all of them, or their start and end around a count of what is left out. */
export function quoteLines(code: string): string[] {
  const lines = dedent(code.split(/\r?\n/));
  if (lines.length <= MAX_QUOTED) return lines;
  return [...lines.slice(0, QUOTE_HEAD), `… (${lines.length - QUOTE_HEAD - QUOTE_TAIL} more lines)`, ...lines.slice(-QUOTE_TAIL)];
}

/** Drops the indentation all non-blank lines share. */
function dedent(lines: string[]): string[] {
  const indents = lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(Math.min(cut, /^[ \t]*/.exec(l)![0].length)));
}

const FENCE_LANGS: Record<string, string> = {
  cs: "csharp", csx: "csharp", ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  py: "python", go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift", c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp",
  m: "objectivec", mm: "objectivec", rb: "ruby", php: "php", lua: "lua", sh: "bash", zsh: "bash", ps1: "powershell",
  json: "json", asmdef: "json", yml: "yaml", yaml: "yaml", xml: "xml", csproj: "xml", html: "html", css: "css", scss: "scss",
  md: "markdown", sql: "sql", shader: "hlsl", hlsl: "hlsl", cginc: "hlsl", compute: "hlsl", glsl: "glsl", toml: "toml",
};

/** The Markdown info string for a file's code block (`csharp` for `.cs`), or "" when unknown. */
export function fenceLanguage(rel: string): string {
  const ext = /\.([^./\\]+)$/.exec(rel)?.[1]?.toLowerCase() ?? "";
  return FENCE_LANGS[ext] ?? "";
}

/** A code fence longer than any run of backticks in `lines`, so the code cannot close it. */
function fenceFor(lines: readonly string[]): string {
  const longest = Math.max(0, ...lines.map((l) => Math.max(0, ...(l.match(/`+/g) ?? []).map((r) => r.length))));
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * The prompt that hands `comments` to an agent: one numbered item per comment,
 * by file and line, with the commented code in a fenced block and the comment
 * labelled, so neither is taken for the other (a `// comment` in the code stays code).
 */
export function buildReviewPrompt(comments: readonly ReviewComment[]): string {
  const sorted = [...comments].sort((a, b) => a.rel.localeCompare(b.rel) || a.startLine - b.startLine || a.createdAt - b.createdAt);
  const pad = (l: string) => (l ? `   ${l}` : "");
  const items = sorted.map((c, i) => {
    const code = quoteLines(c.code);
    const fence = fenceFor(code);
    const [first = "", ...rest] = c.text.trim().split(/\r?\n/);
    return [
      `${i + 1}. ${commentLocation(c)}`,
      pad(fence + fenceLanguage(c.rel)),
      ...code.map(pad),
      pad(fence),
      pad(`Comment: ${first}`),
      ...rest.map(pad),
    ].join("\n");
  });
  // Neutral: a comment may be a question, and the agent should answer it rather than change code.
  const intro = "Review comments on the code. Answer the questions; change the code only where a comment asks for it.";
  return `${intro}\n\n${items.join("\n\n")}`;
}

/** FNV-1a, as 8 hex digits. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Identifies a hunk by its content, not its position: an accepted hunk stays
 * accepted when lines above it change, and shows again once its own lines do.
 */
export function hunkKey(root: string, rel: string, oldLines: readonly string[], newLines: readonly string[]): string {
  return `${root}\0${rel}\0${hash(oldLines.join("\n") + "\0" + newLines.join("\n"))}`;
}
