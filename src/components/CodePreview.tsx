// Read-only code preview under a results list: Find in Files and Search
// Everywhere.
import { useEffect, useRef, useState } from "react";
import { getModel } from "../lib/buffers";
import { api } from "../lib/ipc";
import { codeFontOptions, languageFor, monaco } from "../lib/monaco";
import { monacoTheme } from "../lib/theme";
import { useWorkspace } from "../store/workspace";

/** 1-based Monaco positions; a `SearchMatch` is one. */
export interface PreviewRange {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

/**
 * Shows `path` with `match` highlighted and centred, `others` (the file's
 * other matches) more faintly; `hash` is the searched content's, so a file
 * changed since is read again.
 */
export function CodePreview({ path, hash, match, others }: { path: string | null; hash: string | null; match: PreviewRange | null; others: PreviewRange[] }) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const own = useRef<monaco.editor.ITextModel | null>(null);
  const ownHash = useRef<string | null>(null);
  const decorations = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const stickyScroll = useWorkspace((s) => s.stickyScroll);

  useEffect(() => {
    if (!host.current) return;
    editor.current = monaco.editor.create(host.current, {
      model: null,
      readOnly: true,
      automaticLayout: true,
      minimap: { enabled: false },
      ...codeFontOptions(),
      scrollBeyondLastLine: false,
      renderLineHighlight: "none",
      stickyScroll: { enabled: useWorkspace.getState().stickyScroll },
      theme: monacoTheme(),
    });
    decorations.current = editor.current.createDecorationsCollection();
    return () => {
      editor.current?.dispose();
      own.current?.dispose();
    };
  }, []);

  useEffect(() => {
    editor.current?.updateOptions({ stickyScroll: { enabled: stickyScroll } });
  }, [stickyScroll]);

  useEffect(() => {
    const ed = editor.current;
    if (!ed || !path || !match) {
      ed?.setModel(null);
      return;
    }
    let cancelled = false;
    const show = (model: monaco.editor.ITextModel) => {
      if (cancelled) return;
      ed.setModel(model);
      const range = new monaco.Range(match.line, match.column, match.endLine, match.endColumn);
      decorations.current?.set([
        ...others
          .filter((m) => m !== match)
          .map((m) => ({ range: new monaco.Range(m.line, m.column, m.endLine, m.endColumn), options: { inlineClassName: "find-hit-other" } })),
        { range, options: { inlineClassName: "find-hit" } },
      ]);
      ed.revealRangeInCenter(range);
    };
    const buffer = getModel(path);
    if (buffer) {
      show(buffer);
    } else if (own.current?.uri.path === monaco.Uri.file(path).path && ownHash.current === hash) {
      show(own.current);
    } else {
      // Read again after a replace changed the file, or the highlight lands on old text.
      void api.readFile(path).then((f) => {
        if (cancelled) return;
        // Images and binaries: nothing to show, rather than the previous file.
        if (f.kind !== "text") return ed.setModel(null);
        own.current?.dispose();
        own.current = monaco.editor.createModel(f.content, languageFor(path), monaco.Uri.from({ scheme: "preview", path: monaco.Uri.file(path).path }));
        ownHash.current = hash;
        show(own.current);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [path, hash, match, others]);

  return <div ref={host} className="find-preview-editor" />;
}

// Result rows coloured like the editor, from the whole file's tokens so a
// line inside a block comment or a multi-line string gets its real colours.
// Files open in the editor use their buffer; others get a hidden model,
// kept for the last few files while the searched content is unchanged.

/** Monaco's model internals behind the editor's own colouring. */
interface TokenizedModel {
  tokenization: {
    forceTokenization(line: number): void;
    getLineTokens(line: number): { getCount(): number; getEndOffset(i: number): number; getClassName(i: number): string };
  };
}

const rowModels = new Map<string, { hash: string | null; model: Promise<monaco.editor.ITextModel | null> }>();
const ROW_MODELS_MAX = 40;
let rowModelId = 0;

function rowModel(path: string, hash: string | null): Promise<monaco.editor.ITextModel | null> {
  const buffer = getModel(path);
  if (buffer) return Promise.resolve(buffer);
  const cached = rowModels.get(path);
  rowModels.delete(path);
  if (cached?.hash === hash) {
    rowModels.set(path, cached);
    return cached.model;
  }
  void cached?.model.then((m) => m?.dispose());
  if (rowModels.size >= ROW_MODELS_MAX) {
    const [oldest, entry] = rowModels.entries().next().value!;
    rowModels.delete(oldest);
    void entry.model.then((m) => m?.dispose());
  }
  const language = languageFor(path);
  // colorize("") waits for the language's tokenizer, loaded lazily.
  const model = Promise.all([api.readFile(path), monaco.editor.colorize("", language, {})])
    .then(([f]) =>
      f.kind === "text"
        ? monaco.editor.createModel(f.content, language, monaco.Uri.from({ scheme: "find-rows", path: monaco.Uri.file(path).path, query: String(++rowModelId) }))
        : null,
    )
    .catch(() => null);
  rowModels.set(path, { hash, model });
  return model;
}

interface Segment {
  text: string;
  className: string;
}

/** The tokens of `line` between `from` and `from + text.length`, or null when the file no longer has `text` there. */
function lineSegments(model: monaco.editor.ITextModel, line: number, from: number, text: string): Segment[] | null {
  if (model.isDisposed() || line > model.getLineCount() || model.getLineContent(line).substr(from, text.length) !== text) return null;
  const { tokenization } = model as unknown as TokenizedModel;
  tokenization.forceTokenization(line);
  const tokens = tokenization.getLineTokens(line);
  const out: Segment[] = [];
  let start = 0;
  for (let i = 0; i < tokens.getCount(); i++) {
    const end = tokens.getEndOffset(i);
    const a = Math.max(start, from);
    const b = Math.min(end, from + text.length);
    if (a < b) out.push({ text: text.slice(a - from, b - from), className: tokens.getClassName(i) });
    start = end;
  }
  return out;
}

/**
 * One line of code coloured like the editor: `text` is what line `line` of
 * `path` holds from offset `from`. `hl` (offsets in `text`) is marked with
 * `hlClass`, and `insert` (a replacement) follows it. Plain until the colours are ready.
 */
export function CodeLine({
  path,
  hash,
  line,
  from,
  text,
  hl,
  hlClass,
  insert,
}: {
  path: string;
  hash: string | null;
  line: number;
  from: number;
  text: string;
  hl: [number, number];
  hlClass: string;
  insert?: string | null;
}) {
  const [segments, setSegments] = useState<Segment[] | null>(null);
  useEffect(() => {
    let live = true;
    setSegments(null);
    void rowModel(path, hash).then((model) => live && model && setSegments(lineSegments(model, line, from, text)));
    return () => {
      live = false;
    };
  }, [path, hash, line, from, text]);

  const parts: React.ReactNode[] = [];
  let offset = 0;
  let inserted = insert == null;
  const flushInsert = () => {
    if (inserted) return;
    inserted = true;
    parts.push(
      <span key="insert" className="find-new">
        {insert}
      </span>,
    );
  };
  for (const [i, seg] of (segments ?? [{ text, className: "" }]).entries()) {
    const end = offset + seg.text.length;
    // Cut the token where the highlight starts and ends.
    const cuts = [offset, ...[hl[0], hl[1]].filter((c) => c > offset && c < end), end];
    for (let k = 0; k + 1 < cuts.length; k++) {
      const [a, b] = [cuts[k], cuts[k + 1]];
      if (a === hl[1]) flushInsert();
      const marked = a >= hl[0] && b <= hl[1] && hl[0] < hl[1];
      parts.push(
        <span key={`${i}:${k}`} className={seg.className + (marked ? " " + hlClass : "")}>
          {seg.text.slice(a - offset, b - offset)}
        </span>,
      );
    }
    offset = end;
  }
  flushInsert();
  return <span className="code-line">{parts}</span>;
}
