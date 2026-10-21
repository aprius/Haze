// Ctrl+Click / Ctrl+B and Find Usages for every language, and for C# until
// Roslyn has loaded the projects: declarations are guessed from text (see
// declarations.ts), the current file first, then the project.
import { api, type SearchMatch, type SearchResults } from "./ipc";
import { monaco } from "./monaco";
import { extname } from "./path";
import { csharpAnswers, type FoundLocation } from "./lsp/csharp";
import { declarationRegex, declarationsInLine, familyOf, isSearchableName, type DeclKind } from "./declarations";
import { projectForPath } from "../store/workspace";

let registered = false;
let searchId = 0;

const norm = (p: string) => {
  const n = p.replace(/\\/g, "/");
  return /^[a-z]:/i.test(n) ? n.toLowerCase() : n;
};

interface Target {
  model: monaco.editor.ITextModel;
  word: monaco.editor.IWordAtPosition;
  ext: string;
  root: string;
  mask: string;
}

/** What to search for at `position`, or null when the language server answers or there is nothing to find. */
function target(model: monaco.editor.ITextModel, position: monaco.IPosition): Target | null {
  if (model.uri.scheme !== "file" || (model.getLanguageId() === "csharp" && csharpAnswers(model))) return null;
  const ext = extname(model.uri.fsPath);
  const family = familyOf(ext);
  const word = model.getWordAtPosition(position);
  if (!family || !word || !isSearchableName(word.word)) return null;
  const project = projectForPath(model.uri.fsPath);
  if (!project) return null;
  return { model, word, ext, root: project.path, mask: family.map((e) => `*.${e}`).join(", ") };
}

// Ctrl+hover asks for the same name again and again; a click asks once more.
const cache = new Map<string, { at: number; result: Promise<SearchResults | null> }>();

function search(key: string, run: (id: number) => Promise<SearchResults>): Promise<SearchResults | null> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 10_000) return hit.result;
  const result = run(++searchId).then(
    (r) => {
      // A newer search stopped this one; ask again next time.
      if (r.cancelled) cache.delete(key);
      return r.cancelled ? null : r;
    },
    () => {
      cache.delete(key);
      return null;
    },
  );
  cache.set(key, { at: Date.now(), result });
  if (cache.size > 50) cache.delete(cache.keys().next().value!);
  return result;
}

const location = (path: string, line: number, start: number, end: number): monaco.languages.Location => ({
  uri: monaco.Uri.file(path),
  range: new monaco.Range(line, start + 1, line, end + 1),
});

async function provideDefinition(model: monaco.editor.ITextModel, position: monaco.IPosition): Promise<monaco.languages.Location[] | null> {
  const t = target(model, position);
  if (!t) return null;
  const name = t.word.word;

  // The current file, unsaved edits included. On the declaration itself the
  // result is where the cursor is, so Monaco shows the usages instead.
  const local: { line: number; start: number; end: number; kind: DeclKind }[] = [];
  for (let line = 1; line <= model.getLineCount(); line++) {
    const text = model.getLineContent(line);
    if (!text.includes(name)) continue;
    for (const h of declarationsInLine(text, name, t.ext)) local.push({ line, ...h });
  }
  const here = local.find((d) => d.line === position.lineNumber && d.start + 1 === t.word.startColumn);
  if (here) return [location(model.uri.fsPath, here.line, here.start, here.end)];
  if (local.length) {
    // A local variable is declared above its use: the nearest one wins.
    const above = local.filter((d) => d.line <= position.lineNumber).pop();
    const best = above ?? [...local].sort((a, b) => a.kind - b.kind)[0];
    return [location(model.uri.fsPath, best.line, best.start, best.end)];
  }

  const res = await search(`def|${t.root}|${t.mask}|${name}`, (id) =>
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

async function provideReferences(model: monaco.editor.ITextModel, position: monaco.IPosition): Promise<monaco.languages.Location[] | null> {
  const t = target(model, position);
  if (!t) return null;
  const name = t.word.word;
  const path = model.uri.fsPath;
  const res = await search(`ref|${t.root}|${t.mask}|${name}|${model.getVersionId()}`, (id) =>
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
  monaco.languages.registerDefinitionProvider("*", { provideDefinition: (model, position) => provideDefinition(model, position) });
  monaco.languages.registerReferenceProvider("*", { provideReferences: (model, position) => provideReferences(model, position) });
}
