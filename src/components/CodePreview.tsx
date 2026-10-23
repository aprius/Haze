// Read-only code preview under a results list: Find in Files and Search
// Everywhere, like Rider's preview pane.
import { useEffect, useRef } from "react";
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
