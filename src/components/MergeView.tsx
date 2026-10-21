// Three-pane merge window (Yours | Result | Theirs) as an editor tab, opened
// for a conflicted file. Non-conflicting changes are already applied in the
// result; each conflict is resolved with « Yours, Both, Theirs » or by hand.
import { ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getModel, reloadBuffer } from "../lib/buffers";
import { api, errorMessage } from "../lib/ipc";
import { buildMerge, conflictRange, resolution, resolveEdit, type ConflictBlock, type ResultEdit } from "../lib/merge";
import { codeFontOptions, languageFor, monaco } from "../lib/monaco";
import { monacoTheme } from "../lib/theme";
import { basename } from "../lib/path";
import { mergePath, type MergeSpec } from "../lib/diffSpec";
import { absPath, refreshRepo, repo, runGit } from "../store/git";
import { useWorkspace, type Project } from "../store/workspace";
import { closeTabsWithPrompt } from "./EditorArea";
import { confirmAction, toast } from "./Overlays";

export { mergePath, mergeTitle, parseMergePath, type MergeSpec } from "../lib/diffSpec";

export function openMerge(projectId: string, spec: MergeSpec): void {
  useWorkspace.getState().openFile(projectId, mergePath(spec));
}

type Choice = "ours" | "theirs" | "both";

const rangeOf = (e: ResultEdit) => new monaco.Range(e.startLine, e.startColumn, e.endLine, e.endColumn);

interface Pane {
  editor: monaco.editor.IStandaloneCodeEditor;
  decorations: monaco.editor.IEditorDecorationsCollection;
}

export function MergeView({ project, spec }: { project: Project; spec: MergeSpec }) {
  const leftHost = useRef<HTMLDivElement>(null);
  const centerHost = useRef<HTMLDivElement>(null);
  const rightHost = useRef<HTMLDivElement>(null);
  const panes = useRef<{ left: Pane; center: Pane; right: Pane } | null>(null);
  // Tracked ranges of each conflict in the result model.
  const tracked = useRef<string[]>([]);
  const [conflicts, setConflicts] = useState<ConflictBlock[]>([]);
  const [resolved, setResolved] = useState<Record<number, Choice | "manual">>({});
  const [current, setCurrent] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const operation = repo(project.id).branches?.operation ?? null;
  // During a rebase, stage 2 is the branch being rebased onto and stage 3 is your commit.
  const labels = operation === "rebase" ? ["Upstream (being rebased onto)", "Your commit"] : ["Yours (current branch)", "Theirs (incoming)"];

  useEffect(() => {
    if (!leftHost.current || !centerHost.current || !rightHost.current) return;
    const opts = (readOnly: boolean): monaco.editor.IStandaloneEditorConstructionOptions => ({
      readOnly,
      automaticLayout: true,
      minimap: { enabled: false },
      ...codeFontOptions(),
      scrollBeyondLastLine: false,
      glyphMargin: false,
      theme: monacoTheme(),
    });
    const mk = (host: HTMLDivElement, readOnly: boolean): Pane => {
      const editor = monaco.editor.create(host, opts(readOnly));
      return { editor, decorations: editor.createDecorationsCollection() };
    };
    const p = { left: mk(leftHost.current, true), center: mk(centerHost.current, false), right: mk(rightHost.current, true) };
    panes.current = p;
    // Keep the three panes scrolled together.
    let syncing = false;
    const all = [p.left.editor, p.center.editor, p.right.editor];
    const subs = all.map((ed) =>
      ed.onDidScrollChange((e) => {
        if (syncing || !e.scrollTopChanged) return;
        syncing = true;
        all.filter((o) => o !== ed).forEach((o) => o.setScrollTop(e.scrollTop));
        syncing = false;
      }),
    );
    const owned: monaco.editor.ITextModel[] = [];
    let cancelled = false;
    void (async () => {
      try {
        const [base, ours, theirs] = await Promise.all([
          api.gitFileAt(spec.root, ":1", spec.rel),
          api.gitFileAt(spec.root, ":2", spec.rel),
          api.gitFileAt(spec.root, ":3", spec.rel),
        ]);
        if (cancelled) return;
        if (ours === null && theirs === null) throw new Error("This file is not in conflict anymore.");
        const model = buildMerge(ours ?? "", base ?? "", theirs ?? "");
        const lang = languageFor(spec.rel);
        const mkModel = (text: string) => {
          const m = monaco.editor.createModel(text, lang);
          owned.push(m);
          return m;
        };
        p.left.editor.setModel(mkModel(ours ?? ""));
        p.right.editor.setModel(mkModel(theirs ?? ""));
        const result = mkModel(model.result);
        p.center.editor.setModel(result);
        const lines = result.getLinesContent();
        tracked.current = result.deltaDecorations(
          [],
          model.conflicts.map((c) => ({
            range: rangeOf(conflictRange(c, lines)),
            options: {
              stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
              isWholeLine: true,
              className: "merge-conflict",
            },
          })),
        );
        const side = (pane: Pane, start: (c: ConflictBlock) => number, len: (c: ConflictBlock) => number) =>
          pane.decorations.set(
            model.conflicts.map((c) => ({
              range: new monaco.Range(start(c) + 1, 1, start(c) + Math.max(1, len(c)), 1),
              options: { isWholeLine: true, className: "merge-conflict-side" },
            })),
          );
        side(p.left, (c) => c.oursStart, (c) => c.ours.length);
        side(p.right, (c) => c.theirsStart, (c) => c.theirs.length);
        setConflicts(model.conflicts);
        if (model.conflicts.length) reveal(model.conflicts[0], 0);
      } catch (e) {
        setError(errorMessage(e));
      }
    })();
    return () => {
      cancelled = true;
      subs.forEach((s) => s.dispose());
      all.forEach((ed) => ed.dispose());
      owned.forEach((m) => m.dispose());
      panes.current = null;
    };
  }, [spec.root, spec.rel]); // eslint-disable-line react-hooks/exhaustive-deps

  function reveal(c: ConflictBlock, i: number) {
    const p = panes.current;
    const model = p?.center.editor.getModel();
    if (!p || !model) return;
    setCurrent(i);
    const r = model.getDecorationRange(tracked.current[c.id]);
    if (r) p.center.editor.revealLinesInCenter(r.startLineNumber, r.endLineNumber);
    p.left.editor.revealLinesInCenter(c.oursStart + 1, c.oursStart + Math.max(1, c.ours.length));
    p.right.editor.revealLinesInCenter(c.theirsStart + 1, c.theirsStart + Math.max(1, c.theirs.length));
  }

  function accept(c: ConflictBlock, choice: Choice) {
    const p = panes.current;
    const model = p?.center.editor.getModel();
    if (!p || !model) return;
    const r = model.getDecorationRange(tracked.current[c.id]);
    if (!r) return;
    // An empty base past the last line is marked at the end of that line.
    const start = c.base.length === 0 && r.startColumn > 1 ? r.startLineNumber + 1 : r.startLineNumber;
    const e = resolveEdit(c, choice, start, r.endLineNumber, model.getLinesContent(), model.getEOL());
    p.center.editor.executeEdits("merge", [{ range: rangeOf(e), text: e.text }]);
    const lines = resolution(c, choice).length;
    const [id] = model.deltaDecorations(
      [tracked.current[c.id]],
      [
        {
          range: new monaco.Range(start, 1, start + Math.max(0, lines - 1), 1),
          options: { isWholeLine: true, className: "merge-resolved", stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
        },
      ],
    );
    tracked.current[c.id] = id;
    setResolved((s) => ({ ...s, [c.id]: choice }));
    const next = conflicts.findIndex((x) => x.id !== c.id && !resolved[x.id]);
    if (next >= 0) reveal(conflicts[next], next);
  }

  const unresolved = conflicts.filter((c) => !resolved[c.id]).length;

  const apply = async () => {
    const model = panes.current?.center.editor.getModel();
    if (!model) return;
    if (unresolved && !(await confirmAction("Apply Merge", `${unresolved} conflict(s) are not resolved; the base text stays there. Apply anyway?`, "Apply"))) return;
    const path = absPath(spec.root, spec.rel);
    try {
      const file = await api.readFile(path).catch(() => null);
      const encoding = file?.kind === "text" ? file.encoding : "utf8";
      await api.writeFile(path, model.getValue(), encoding, null);
      await runGit(project.id, ["add", "--", spec.rel], { quiet: true });
      if (getModel(path)) await reloadBuffer(path);
      toast(`${basename(spec.rel)} resolved.`);
      refreshRepo(project.id, project.path);
      await closeTabsWithPrompt(project.id, [mergePath(spec)]);
    } catch (e) {
      toast(`Could not apply: ${errorMessage(e)}`, "error");
    }
  };

  const acceptAll = (choice: "ours" | "theirs") => conflicts.filter((c) => !resolved[c.id]).forEach((c) => accept(c, choice));

  return (
    <div className="merge-view">
      <div className="diff-toolbar">
        <button className="icon-btn" title="Previous conflict" onClick={() => conflicts.length && reveal(conflicts[(current - 1 + conflicts.length) % conflicts.length], (current - 1 + conflicts.length) % conflicts.length)}>
          <ChevronUp size={14} />
        </button>
        <button className="icon-btn" title="Next conflict" onClick={() => conflicts.length && reveal(conflicts[(current + 1) % conflicts.length], (current + 1) % conflicts.length)}>
          <ChevronDown size={14} />
        </button>
        <span className={"small " + (unresolved ? "error" : "muted")}>
          {error ? error : conflicts.length === 0 ? "No conflicts left — changes merged automatically." : `${unresolved} of ${conflicts.length} conflict(s) unresolved`}
        </span>
        <span className="run-spacer" />
        <button className="btn small" onClick={() => acceptAll("ours")} disabled={!unresolved}>
          Accept Left
        </button>
        <button className="btn small" onClick={() => acceptAll("theirs")} disabled={!unresolved}>
          Accept Right
        </button>
        <button className="btn small primary" onClick={() => void apply()} disabled={!!error}>
          Apply
        </button>
      </div>
      <div className="merge-columns">
        <div className="merge-col">
          <div className="merge-label">{labels[0]}</div>
          <div ref={leftHost} className="merge-editor" />
        </div>
        <div className="merge-col center">
          <div className="merge-label">Result</div>
          <div ref={centerHost} className="merge-editor" />
        </div>
        <div className="merge-col">
          <div className="merge-label">{labels[1]}</div>
          <div ref={rightHost} className="merge-editor" />
        </div>
      </div>
      {conflicts.length > 0 && (
        <div className="merge-conflicts">
          {conflicts.map((c, i) => (
            <div key={c.id} className={"merge-conflict-row" + (i === current ? " selected" : "") + (resolved[c.id] ? " done" : "")} onClick={() => reveal(c, i)}>
              <span className="small">
                Conflict {i + 1} {resolved[c.id] ? `— ${resolved[c.id]}` : ""}
              </span>
              {!resolved[c.id] && (
                <>
                  <button className="btn small" onClick={(e) => (e.stopPropagation(), accept(c, "ours"))}>
                    « Left
                  </button>
                  <button className="btn small" onClick={(e) => (e.stopPropagation(), accept(c, "both"))}>
                    Both
                  </button>
                  <button className="btn small" onClick={(e) => (e.stopPropagation(), accept(c, "theirs"))}>
                    Right »
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
