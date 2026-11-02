/** Subsequence match score for action labels; higher is better, null = no match. */
export function scoreLabel(label: string, query: string): number | null {
  const l = label.toLowerCase();
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  if (l.startsWith(q)) return 1000 - l.length;
  const idx = l.indexOf(q);
  if (idx >= 0) return 800 - idx;
  let i = 0;
  let gaps = 0;
  for (const ch of q) {
    if (ch === " ") continue;
    const j = l.indexOf(ch, i);
    if (j < 0) return null;
    gaps += j - i;
    i = j + 1;
  }
  return 500 - gaps;
}
