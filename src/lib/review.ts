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

const MAX_QUOTED = 8;

/** The prompt that hands `comments` to an agent: one numbered item per comment, by file and line. */
export function buildReviewPrompt(comments: readonly ReviewComment[]): string {
  const sorted = [...comments].sort((a, b) => a.rel.localeCompare(b.rel) || a.startLine - b.startLine || a.createdAt - b.createdAt);
  const items = sorted.map((c, i) => {
    const code = c.code.split(/\r?\n/);
    const quoted = code.slice(0, MAX_QUOTED).map((l) => `   > ${l}`);
    if (code.length > MAX_QUOTED) quoted.push(`   > …`);
    const text = c.text
      .trim()
      .split(/\r?\n/)
      .map((l) => `   ${l}`);
    return [`${i + 1}. ${commentLocation(c)}`, ...quoted, ...text].join("\n");
  });
  const intro = sorted.length === 1 ? "Please address this review comment:" : "Please address these review comments:";
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
