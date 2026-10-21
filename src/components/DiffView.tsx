// Side-by-side diff as an editor tab. The right side of a "working" diff is
// the file's real buffer, so it can be edited in place like in Rider.
import { ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ensureBuffer, getModel } from "../lib/buffers";
import { api, errorMessage } from "../lib/ipc";
import { languageFor, monaco } from "../lib/monaco";
import { monacoTheme } from "../lib/theme";
import { basename } from "../lib/path";
import { absPath } from "../store/git";
import { useWorkspace } from "../store/workspace";

export interface DiffSpec {
  /** Repository root. */
  root: string;
  rel: string;
  /** Path on the left side when the file was renamed. */
  oldRel?: string | null;
  /** Revision of the left side; `null` = empty (added file). */
  left: string | null;
  /** `"working"` = the file on disk / in the editor, else a revision (`null` content if deleted there). */
  right: string;
}

const PREFIX = "haze-diff:";

export function diffPath(spec: DiffSpec): string {
  return PREFIX + JSON.stringify(spec);
}

export function parseDiffPath(path: string): DiffSpec | null {
  if (!path.startsWith(PREFIX)) return null;
  try {
    return JSON.parse(path.slice(PREFIX.length)) as DiffSpec;
  } catch {
    return null;
  }
}

const short = (rev: string) => (/^[0-9a-f]{40}/.test(rev) ? rev.slice(0, 8) + rev.slice(40) : rev);

export function diffTitle(spec: DiffSpec): string {
  const left = spec.left ? short(spec.left) : "∅";
  const right = spec.right === "working" ? "Local" : short(spec.right);
  return `${basename(spec.rel)} (${left} ↔ ${right})`;
}

export function openDiff(projectId: string, spec: DiffSpec): void {
  useWorkspace.getState().openFile(projectId, diffPath(spec), { preview: true });
}

export function DiffView({ spec }: { spec: DiffSpec }) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<number | null>(null);

  useEffect(() => {
    if (!host.current) return;
    const ed = monaco.editor.createDiffEditor(host.current, {
      automaticLayout: true,
      renderSideBySide: true,
      originalEditable: false,
      readOnly: spec.right !== "working",
      fontFamily: 'JetBrains Mono, "Cascadia Code", Menlo, Consolas, monospace',
      fontSize: 13,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      ignoreTrimWhitespace: false,
      theme: monacoTheme(),
    });
    editor.current = ed;
    const owned: monaco.editor.ITextModel[] = [];
    let cancelled = false;
    const lang = languageFor(spec.rel);
    const fromRev = async (rev: string | null, rel: string) => {
      const text = rev ? ((await api.gitFileAt(spec.root, rev, rel)) ?? "") : "";
      const m = monaco.editor.createModel(text, lang);
      owned.push(m);
      return m;
    };
    void (async () => {
      try {
        const original = await fromRev(spec.left, spec.oldRel ?? spec.rel);
        let modified: monaco.editor.ITextModel;
        if (spec.right === "working") {
          const path = absPath(spec.root, spec.rel);
          await ensureBuffer(path);
          modified = getModel(path) ?? (await fromRev(null, spec.rel));
        } else {
          modified = await fromRev(spec.right, spec.rel);
        }
        if (cancelled) return;
        ed.onDidUpdateDiff(() => setStats(ed.getLineChanges()?.length ?? 0));
        ed.setModel({ original, modified });
      } catch (e) {
        setError(errorMessage(e));
      }
    })();
    return () => {
      cancelled = true;
      ed.dispose();
      owned.forEach((m) => m.dispose());
      editor.current = null;
    };
  }, [spec.root, spec.rel, spec.oldRel, spec.left, spec.right]);

  return (
    <div className="diff-view">
      <div className="diff-toolbar">
        <button className="icon-btn" title="Previous difference (Shift+F7)" onClick={() => editor.current?.goToDiff("previous")}>
          <ChevronUp size={14} />
        </button>
        <button className="icon-btn" title="Next difference (F7)" onClick={() => editor.current?.goToDiff("next")}>
          <ChevronDown size={14} />
        </button>
        <span className="muted small">
          {error ? <span className="error">{error}</span> : stats === null ? "Comparing…" : stats === 0 ? "Contents are identical" : `${stats} difference(s)`}
        </span>
        {spec.right === "working" && <span className="muted small diff-hint">Right side is the local file — edits are saved as usual.</span>}
      </div>
      <div
        ref={host}
        className="diff-host"
        onKeyDown={(e) => {
          if (e.key === "F7") {
            e.preventDefault();
            editor.current?.goToDiff(e.shiftKey ? "previous" : "next");
          }
        }}
      />
    </div>
  );
}
