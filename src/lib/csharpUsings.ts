// Adds `using` directives to a C# file, each where it sorts among the ones
// already there (System first, as `dotnet format` and Unity's templates do).

export interface UsingsEdit {
  /** Offsets to insert at (distinct), and the text. */
  inserts: { offset: number; text: string }[];
}

const USING = /^[ \t]*using[ \t]+(?:static[ \t]+)?([\w.]+)[ \t]*;[ \t]*(?:\/\/.*)?$/;
const ALIAS_OR_GLOBAL = /^[ \t]*(global[ \t]+using|using[ \t]+\w+[ \t]*=)/;

/** System namespaces first, then by name. */
function compare(a: string, b: string) {
  const sa = a === "System" || a.startsWith("System.");
  const sb = b === "System" || b.startsWith("System.");
  if (sa !== sb) return sa ? -1 : 1;
  return a.localeCompare(b, "en", { sensitivity: "base" }) || (a < b ? -1 : a > b ? 1 : 0);
}

/** The edits adding `namespaces` (those not there yet) to `text`. */
export function addUsings(text: string, namespaces: string[], eol = "\n"): UsingsEdit {
  const lines = text.split("\n");
  // The using block: directives at the top of the file, before any declaration.
  const existing: { name: string; line: number }[] = [];
  let lastHeader = -1; // the last leading comment, #directive or blank line before any code
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    const m = USING.exec(line);
    if (m) existing.push({ name: m[1], line: i });
    else if (ALIAS_OR_GLOBAL.test(line) || !line.trim() || /^\s*(\/\/|#|\/\*|\*)/.test(line)) {
      if (!existing.length && line.trim()) lastHeader = i;
    } else break;
  }
  const have = new Set(existing.map((u) => u.name));
  const wanted = [...new Set(namespaces)].filter((n) => !have.has(n)).sort(compare);
  if (!wanted.length) return { inserts: [] };

  const lineOffset = (i: number) => {
    let o = 0;
    for (let k = 0; k < i; k++) o += lines[k].length + 1;
    return o;
  };
  if (!existing.length) {
    // After a leading comment or #nullable, else at the very top; a blank line before the code.
    const at = lastHeader + 1;
    const block = wanted.map((n) => `using ${n};${eol}`).join("");
    const next = lines[at] ?? "";
    return { inserts: [{ offset: lineOffset(at), text: block + (next.trim() ? eol : "") }] };
  }
  const inserts: { offset: number; text: string }[] = [];
  for (const n of wanted) {
    // Before the first directive that sorts after it, else after the last one.
    const before = existing.find((u) => compare(n, u.name) < 0);
    const line = before ? before.line : existing[existing.length - 1].line + 1;
    const offset = lineOffset(line);
    // Several at one place go in one insertion, in order.
    const same = inserts.find((i) => i.offset === offset);
    if (same) same.text += `using ${n};${eol}`;
    else inserts.push({ offset, text: `using ${n};${eol}` });
  }
  return { inserts };
}

/** The namespace a Roslyn "add using" fix adds: `using UnityEngine;` → `UnityEngine`. */
export function importedNamespace(title: string): string | null {
  return /(?:^|- )using ([\w.]+);$/.exec(title)?.[1] ?? null;
}
