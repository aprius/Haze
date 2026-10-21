// Text patterns that guess where a name is declared, for Ctrl+Click in
// languages without a language server (and C# before Roslyn is up).
// Like a quick grep: no types are resolved, so a guess can be wrong.

/** Lower sorts first: types, then functions, then variables and members. */
export type DeclKind = 0 | 1 | 2;

export interface DeclHit {
  kind: DeclKind;
  /** 0-based UTF-16 offsets of the name in the line. */
  start: number;
  end: number;
}

const FAMILIES: string[][] = [
  ["cs", "csx"],
  ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"],
  ["py", "pyi"],
  ["c", "h", "cc", "cpp", "cxx", "hh", "hpp", "hxx", "inl", "m", "mm"],
  ["go"],
  ["rs"],
  ["java"],
  ["kt", "kts"],
  ["swift"],
  ["php"],
  ["rb"],
  ["lua"],
  ["dart"],
  ["scala"],
  ["fs", "fsi", "fsx"],
  ["vb"],
  ["shader", "hlsl", "hlsli", "cginc", "compute", "glsl", "usf", "ush"],
  ["sh", "bash", "zsh"],
  ["ps1", "psm1"],
];

/** Extensions searched together with `ext` (a `.ts` name may live in a `.tsx`), or null for non-code files. */
export function familyOf(ext: string): string[] | null {
  const e = ext.toLowerCase();
  return FAMILIES.find((f) => f.includes(e)) ?? null;
}

const IDENT = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;

// Never declared by user code; skipping them keeps Ctrl+hover from searching.
const KEYWORDS = new Set(
  (
    "abstract and as async await base bool break byte case catch char class const continue decimal def default del delegate do double " +
    "dynamic elif else enum event except explicit export extends extern false final finally fixed float fn for foreach from func function " +
    "get global goto if impl implements implicit import in init int interface internal is lambda let lock long match mod module mut " +
    "namespace new nil None nonlocal not null object of operator or out override package params partial pass private protected pub " +
    "public raise readonly record ref return sbyte sealed select self set short sizeof stackalloc static string struct super switch " +
    "this throw trait True False true try type typeof uint ulong unsafe ushort using val value var virtual void volatile where while " +
    "with yield"
  ).split(" "),
);

/** Whether Ctrl+Click on `word` is worth a search. */
export function isSearchableName(word: string): boolean {
  return IDENT.test(word) && !KEYWORDS.has(word);
}

const S = "[ \\t]";
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A word before "Type name" that makes it a statement instead (`return x;`, `new Foo(`).
const NOT_A_TYPE = new Set(
  "return if elif while assert lambda new await throw else case yield in is as typeof sizeof nameof goto not and or of delete instanceof void using import from package extends implements with when where out ref echo print puts do then".split(
    " ",
  ),
);
// `void` is a C# return type but a JS operator; only JS-like files treat it as one.
const C_LIKE_VOID = new Set(["cs", "csx", "c", "h", "cc", "cpp", "cxx", "hh", "hpp", "hxx", "java", "shader", "hlsl", "hlsli", "cginc", "compute", "glsl"]);

interface Pattern {
  kind: DeclKind;
  source: string;
  /** "Type name" shapes, checked against the word before them. */
  typed?: boolean;
}

function patterns(word: string, ext: string): Pattern[] {
  const w = esc(word);
  const list: Pattern[] = [
    {
      kind: 0,
      source: `\\b(?:class|struct|interface|enum|record|trait|type|typedef|namespace|module|object|protocol|extension|union|delegate)${S}+(?:[\\w.]+${S}+)?${w}\\b`,
    },
    { kind: 1, source: `\\b(?:function\\*?|func|fn|def|fun|sub|macro|proc)${S}+${w}\\b` },
    // Go methods: func (r *Repo) Name(
    { kind: 1, source: `\\bfunc${S}*\\([^)]*\\)${S}*${w}\\b` },
    { kind: 2, source: `\\b(?:let|const|var|val|dim|local|my|our)${S}+(?:mut${S}+)?${w}\\b` },
    // int count = …, List<int> items;, string Name {, void Run(, (Foo a, Bar b), char *p
    { kind: 2, typed: true, source: `[\\w>\\]?*&]${S}+[*&]?${w}${S}*(?:[(<;{,)\\[]|=(?:[^=]|$))` },
  ];
  const fam = familyOf(ext);
  if (fam?.includes("py")) {
    list.push(
      { kind: 2, source: `^${S}*(?:self\\.)?${w}${S}*(?::[^=]*)?=(?:[^=]|$)` },
      { kind: 2, source: `\\bfor${S}+(?:\\w+${S}*,${S}*)*${w}\\b` },
      { kind: 2, source: `\\bas${S}+${w}\\b` },
    );
  }
  if (fam?.includes("ts")) {
    // Class members and object keys: `name = 1`, `name: T`, `name(a): T {`
    list.push({
      kind: 2,
      source: `^${S}*(?:(?:public|private|protected|static|readonly|async|get|set|override|abstract|declare|export|default|accessor)${S}+)*#?${w}${S}*[?!]?${S}*(?:<[^>]*>)?(?:=(?:[^=>]|$)|:|\\([^)]*\\)${S}*(?::[^;{]*)?\\{)`,
    });
  }
  return list;
}

/** One regex for every declaration shape, for the Rust text search (which runs it multi-line). */
export function declarationRegex(word: string, ext: string): string {
  return patterns(word, ext).map((p) => `(?:${p.source})`).join("|");
}

function isComment(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") || t.startsWith("#") || t.startsWith("--");
}

/** The name `word` at the end of `line[from, to)`: the last whole-word occurrence (`Color Color {`). */
function nameIn(line: string, word: string, from: number, to: number): number {
  const re = new RegExp(`(?<![\\p{L}\\p{N}_$])${esc(word)}(?![\\p{L}\\p{N}_$])`, "gu");
  let at = -1;
  for (const m of line.slice(from, to).matchAll(re)) at = from + m.index;
  return at;
}

function typedOk(line: string, at: number, ext: string): boolean {
  const c = line[at];
  // `a > b)`, `x ? y : z` and `a * b;` are expressions; `List<int> x`, `int? x`, `char* p` are not.
  if (!/\w/.test(c)) return at > 0 && !/\s/.test(line[at - 1]);
  const before = /\w+$/.exec(line.slice(0, at + 1))?.[0] ?? "";
  if (before === "void") return C_LIKE_VOID.has(ext.toLowerCase());
  return !NOT_A_TYPE.has(before);
}

/** Declarations of `word` in one line of a file with extension `ext`. */
export function declarationsInLine(line: string, word: string, ext: string): DeclHit[] {
  if (isComment(line)) return [];
  const hits: DeclHit[] = [];
  for (const p of patterns(word, ext)) {
    for (const m of line.matchAll(new RegExp(p.source, "g"))) {
      if (p.typed && !typedOk(line, m.index, ext)) continue;
      const start = nameIn(line, word, m.index, m.index + m[0].length);
      if (start < 0 || hits.some((h) => h.start === start)) continue;
      hits.push({ kind: p.kind, start, end: start + word.length });
    }
  }
  return hits.sort((a, b) => a.kind - b.kind || a.start - b.start);
}
