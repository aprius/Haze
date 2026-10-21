// Ctrl+Click / Ctrl+B and Find Usages for every language, and for C# while
// Roslyn has not loaded the projects or knows nothing of a name (a script
// Unity has not added to its .csproj yet): declarations are guessed from text
// (see declarations.ts), the current file first, then the project.
import { api, type SearchMatch, type SearchResults } from "./ipc";
import { monaco } from "./monaco";
import { extname, isWithin } from "./path";
import { csharpAnswers, setDefinitionFallback, type FoundLocation } from "./lsp/csharp";
import { declarationRegex, declarationsInLine, familyOf, isSearchableName, type DeclKind } from "./declarations";
import { projectForPath } from "../store/workspace";

let registered = false;
let searchId = 0;

type Token = monaco.CancellationToken | undefined;

const norm = (p: string) => {
  const n = p.replace(/\\/g, "/");
  return /^[a-z]:/i.test(n) ? n.toLowerCase() : n;
};

interface Target {
  word: monaco.editor.IWordAtPosition;
  ext: string;
  root: string;
  mask: string;
}

/**
 * What to search for at `position`, or null when there is nothing to find.
 * Unless `force`d, C# is left to Roslyn once it has loaded the projects.
 */
function target(model: monaco.editor.ITextModel, position: monaco.IPosition, force = false): Target | null {
  if (model.uri.scheme !== "file") return null;
  if (!force && model.getLanguageId() === "csharp" && csharpAnswers(model)) return null;
  const ext = extname(model.uri.fsPath);
  const family = familyOf(ext);
  const word = family && model.getWordAtPosition(position);
  if (!word || !isSearchableName(word.word)) return null;
  const project = projectForPath(model.uri.fsPath);
  if (!project) return null;
  return { word, ext, root: project.path, mask: family.map((e) => `*.${e}`).join(", ") };
}

// Ctrl+hover asks for the same name again and again, and a click once more:
// project searches are kept until a file in the project changes on disk.
interface Cached {
  root: string;
  id: number;
  done: boolean;
  /** Callers still waiting; the search stops when the last one gives up. */
  waiting: number;
  result: Promise<SearchResults | null>;
}
const cache = new Map<string, Cached>();
const MAX_CACHED = 100;

/** Forgets searches of projects under `root` (called on file changes). */
export function invalidateTextNav(root: string): void {
  for (const [key, c] of cache) if (c.done && (isWithin(c.root, root) || isWithin(root, c.root))) cache.delete(key);
}

async function search(key: string, root: string, token: Token, run: (id: number) => Promise<SearchResults>): Promise<SearchResults | null> {
  let c = cache.get(key);
  if (c) {
    // Most recently used last, so the oldest goes first.
    cache.delete(key);
    cache.set(key, c);
  } else {
    const id = ++searchId;
    const entry: Cached = { root, id, done: false, waiting: 0, result: Promise.resolve(null) };
    entry.result = run(id).then(
      (r) => {
        entry.done = true;
        // Stopped (a newer search, or nobody waiting): ask again next time.
        if (r.cancelled && cache.get(key) === entry) cache.delete(key);
        return r.cancelled ? null : r;
      },
      () => {
        if (cache.get(key) === entry) cache.delete(key);
        return null;
      },
    );
    c = entry;
    cache.set(key, c);
    if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
  }
  const entry = c;
  entry.waiting++;
  const sub = token?.onCancellationRequested(() => {
    if (--entry.waiting > 0 || entry.done) return;
    if (cache.get(key) === entry) cache.delete(key);
    void api.cancelNav(entry.id).catch(() => {});
  });
  try {
    return await entry.result;
  } finally {
    sub?.dispose();
    if (!token?.isCancellationRequested) entry.waiting--;
  }
}

// Declarations in the current file, per model version and name.
let localCache: { uri: string; version: number; name: string; hits: { line: number; start: number; end: number; kind: DeclKind }[] } | null = null;

function localDeclarations(model: monaco.editor.ITextModel, name: string, ext: string) {
  const uri = model.uri.toString();
  const version = model.getVersionId();
  if (localCache && localCache.uri === uri && localCache.version === version && localCache.name === name) return localCache.hits;
  const hits: { line: number; start: number; end: number; kind: DeclKind }[] = [];
  // Monaco's own search finds the few lines with the name, instead of reading every line.
  let last = 0;
  for (const m of model.findMatches(name, false, false, true, null, false)) {
    const line = m.range.startLineNumber;
    if (line === last) continue;
    last = line;
    for (const h of declarationsInLine(model.getLineContent(line), name, ext)) hits.push({ line, ...h });
  }
  localCache = { uri, version, name, hits };
  return hits;
}

const location = (path: string, line: number, start: number, end: number): monaco.languages.Location => ({
  uri: monaco.Uri.file(path),
  range: new monaco.Range(line, start + 1, line, end + 1),
});

async function provideDefinition(
  model: monaco.editor.ITextModel,
  position: monaco.IPosition,
  token: Token,
  force = false,
): Promise<monaco.languages.Location[] | null> {
  const t = target(model, position, force);
  if (!t) return null;
  const name = t.word.word;

  // The current file, unsaved edits included. On the declaration itself the
  // result is where the cursor is, so Monaco shows the usages instead.
  const local = localDeclarations(model, name, t.ext);
  const here = local.find((d) => d.line === position.lineNumber && d.start + 1 === t.word.startColumn);
  if (here) return [location(model.uri.fsPath, here.line, here.start, here.end)];
  if (local.length) {
    // A local variable is declared above its use: the nearest one wins.
    const above = local.filter((d) => d.line <= position.lineNumber).pop();
    const best = above ?? [...local].sort((a, b) => a.kind - b.kind)[0];
    return [location(model.uri.fsPath, best.line, best.start, best.end)];
  }

  const res = await search(`def|${t.root}|${t.mask}|${name}`, t.root, token, (id) =>
    api.searchNav(
      id,
      { query: declarationRegex(name, t.ext), isRegex: true, matchCase: true, wholeWord: false, context: "exceptCommentsAndStrings", replacement: null, preserveCase: false },
      { dirs: [t.root], files: [], fileMask: t.mask, includeIgnored: false, overrides: {} },
      500,
    ),
  );
  if (!res) return null;
  const self = norm(model.uri.fsPath);
  const found: { path: string; line: number; start: number; end: number; kind: DeclKind }[] = [];
  for (const f of res.files) {
    if (norm(f.path) === self) continue;
    for (const m of f.matches) {
      const hit = hitIn(m, name, extname(f.path));
      if (hit) found.push({ path: f.path, line: m.line, kind: hit.kind, start: hit.start, end: hit.end });
    }
  }
  found.sort((a, b) => a.kind - b.kind || a.path.localeCompare(b.path) || a.line - b.line);
  // Types and functions beat variables of the same name elsewhere.
  const best = found.filter((d) => d.kind === found[0]?.kind).slice(0, 30);
  return best.map((d) => location(d.path, d.line, d.start, d.end));
}

/** The declaration in a search match, with its offsets moved from the preview window to the whole line. */
function hitIn(m: SearchMatch, name: string, ext: string) {
  const shift = m.column - 1 - m.previewStart;
  const h = declarationsInLine(m.lineText, name, ext).find((d) => d.start >= m.previewStart && d.end <= m.previewEnd);
  return h && { kind: h.kind, start: h.start + shift, end: h.end + shift };
}

async function provideReferences(model: monaco.editor.ITextModel, position: monaco.IPosition, token?: Token): Promise<monaco.languages.Location[] | null> {
  const t = target(model, position);
  if (!t) return null;
  const name = t.word.word;
  const path = model.uri.fsPath;
  const res = await search(`ref|${path}|${model.getVersionId()}|${t.mask}|${name}`, t.root, token, (id) =>
    api.searchNav(
      id,
      { query: name, isRegex: false, matchCase: true, wholeWord: true, context: "exceptCommentsAndStrings", replacement: null, preserveCase: false },
      // The current file as edited, so the lines match what is on screen.
      { dirs: [t.root], files: [], fileMask: t.mask, includeIgnored: false, overrides: { [path]: model.getValue() } },
      2000,
    ),
  );
  if (!res) return null;
  return res.files.flatMap((f) =>
    f.matches.map((m) => ({ uri: monaco.Uri.file(f.path), range: new monaco.Range(m.line, m.column, m.endLine, m.endColumn) })),
  );
}

/** Find Usages (Alt+F7) by whole-word search, for files no language server covers. */
export async function findTextUsages(model: monaco.editor.ITextModel, position: monaco.IPosition): Promise<FoundLocation[]> {
  const refs = (await provideReferences(model, position)) ?? [];
  return refs.map((r) => ({
    path: r.uri.fsPath,
    line: r.range.startLineNumber,
    column: r.range.startColumn,
    endLine: r.range.endLineNumber,
    endColumn: r.range.endColumn,
  }));
}

/** Registers the text-based providers for all languages (once). */
export function registerTextNavigation(): void {
  if (registered) return;
  registered = true;
  monaco.languages.registerDefinitionProvider("*", { provideDefinition: (model, position, token) => provideDefinition(model, position, token) });
  monaco.languages.registerReferenceProvider("*", { provideReferences: (model, position, _context, token) => provideReferences(model, position, token) });
  // Roslyn found nothing: a file outside every loaded project, say.
  setDefinitionFallback((model, position, token) => provideDefinition(model, position, token, true));
}
