// Test helper: applies a Monaco-style edit (1-based lines and columns, clamped
// like Monaco clamps positions) to a text.
interface Edit {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  text: string;
}

export function applyEdit(text: string, e: Edit, eol = "\n"): string {
  const lines = text.split(eol);
  const offset = (line: number, column: number) => {
    const l = Math.min(Math.max(1, line), lines.length);
    const col = Math.min(Math.max(1, column), lines[l - 1].length + 1);
    return lines.slice(0, l - 1).reduce((n, s) => n + s.length + eol.length, 0) + col - 1;
  };
  return text.slice(0, offset(e.startLine, e.startColumn)) + e.text + text.slice(offset(e.endLine, e.endColumn));
}
