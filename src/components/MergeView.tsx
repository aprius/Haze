// Three-pane merge window (Yours | Result | Theirs) as an editor tab, opened
// for a conflicted file. Non-conflicting changes are already applied in the
// result. As in Rider, each conflict has » and × beside it on the left side
// and « and × on the right: apply that side to the result, or ignore it; a
// conflict is resolved once both sides are handled (or by hand).
import { ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getModel, reloadBuffer } from "../lib/buffers";
import { api, errorMessage } from "../lib/ipc";
import { actOnSide, buildMerge, conflictRange, isResolved, pendingState, replaceBlock, stateLines, type ConflictBlock, type ConflictState, type ResultEdit } from "../lib/merge";
import { codeFontOptions, languageFor, monaco, suggestOptions } from "../lib/monaco";
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

type Side = "ours" | "theirs";

const ICON = 16;
const SVG = (d: string) => `<svg viewBox="0 0 16 16" width="16" height="16"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const APPLY_RIGHT = SVG("M3.5 4.5 7 8l-3.5 3.5M8.5 4.5 12 8l-3.5 3.5");
const APPLY_LEFT = SVG("M12.5 4.5 9 8l3.5 3.5M7.5 4.5 4 8l3.5 3.5");
const IGNORE = SVG("M4.5 4.5l7 7M11.5 4.5l-7 7");

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
  // Each conflict's sides; the ref is what the editors' handlers read.
  const states = useRef<ConflictState[]>([]);
  const [, setVersion] = useState(0);
  const leftStrip = useRef<HTMLDivElement>(null);
  const rightStrip = useRef<HTMLDivElement>(null);
  const draw = useRef<() => void>(() => {});
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
      suggest: suggestOptions,
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
        if (!syncing && e.scrollTopChanged) {
          syncing = true;
          all.filter((o) => o !== ed).forEach((o) => o.setScrollTop(e.scrollTop));
          syncing = false;
        }
        draw.current();
      }),
    );
    subs.push(p.left.editor.onDidLayoutChange(() => draw.current()), p.right.editor.onDidLayoutChange(() => draw.current()));
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
        states.current = model.conflicts.map(pendingState);
        setConflicts(model.conflicts);
        decorateSides(model.conflicts);
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

  /** Tints each side's block by its state: pending, applied or ignored. */
  function decorateSides(list: ConflictBlock[]) {
    const p = panes.current;
    if (!p) return;
    const cls = { pending: "merge-conflict-side", applied: "merge-resolved", ignored: "merge-ignored" } as const;
    const side = (pane: Pane, which: Side) =>
      pane.decorations.set(
        list.map((c) => {
          const start = which === "ours" ? c.oursStart : c.theirsStart;
          const len = (which === "ours" ? c.ours : c.theirs).length;
          return {
            range: new monaco.Range(start + 1, 1, start + Math.max(1, len), 1),
            options: { isWholeLine: true, className: cls[states.current[c.id]?.[which] ?? "pending"] },
          };
        }),
      );
    side(p.left, "ours");
    side(p.right, "theirs");
  }

  /** Puts conflict `c` in state `next`: rewrites its lines in the result and re-marks it. */
  function setState(c: ConflictBlock, next: ConflictState, advance = true) {
    const p = panes.current;
    const model = p?.center.editor.getModel();
    if (!p || !model) return;
    const prev = states.current[c.id];
    if (prev === next) return;
    const r = model.getDecorationRange(tracked.current[c.id]);
    if (!r) return;
    const empty = r.isEmpty();
    // An empty block past the last line is marked at the end of that line.
    const start = empty && r.startColumn > 1 ? r.startLineNumber + 1 : r.startLineNumber;
    // Lines typed into the block by hand are part of it too.
    const held = empty ? 0 : r.endLineNumber - r.startLineNumber + 1;
    const lines = stateLines(c, next);
    const changed = prev.order.join() !== next.order.join();
    if (changed) {
      const e = replaceBlock(held, lines, start, r.endLineNumber, model.getLinesContent(), model.getEOL());
      p.center.editor.executeEdits("merge", [{ range: rangeOf(e), text: e.text }]);
    }
    const count = model.getLineCount();
    const len = changed ? lines.length : held;
    const range =
      len > 0
        ? new monaco.Range(start, 1, start + len - 1, 1)
        : start <= count
          ? new monaco.Range(start, 1, start, 1)
          : new monaco.Range(count, model.getLineMaxColumn(count), count, model.getLineMaxColumn(count));
    const done = isResolved(next);
    const [id] = model.deltaDecorations(
      [tracked.current[c.id]],
      [{ range, options: { isWholeLine: true, className: done ? "merge-resolved" : "merge-conflict", stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges } }],
    );
    tracked.current[c.id] = id;
    states.current[c.id] = next;
    decorateSides(conflicts);
    setVersion((v) => v + 1);
    if (done && advance) {
      const i = conflicts.findIndex((x) => x.id !== c.id && !isResolved(states.current[x.id]));
      if (i >= 0) reveal(conflicts[i], i);
    }
  }

  const act = (c: ConflictBlock, side: Side, how: "apply" | "ignore") => setState(c, actOnSide(states.current[c.id], side, how));

  // The » × / « × buttons beside each conflict, on the first line of its block in that side.
  draw.current = () => {
    const p = panes.current;
    const strip = (host: HTMLDivElement | null, ed: monaco.editor.IStandaloneCodeEditor, side: Side) => {
      const model = ed.getModel();
      if (!host || !model) return;
      const line = ed.getOption(monaco.editor.EditorOption.lineHeight);
      const height = host.clientHeight;
      const scroll = ed.getScrollTop();
      let html = "";
      for (const c of conflicts) {
        if (states.current[c.id]?.[side] !== "pending") continue;
        const first = Math.min((side === "ours" ? c.oursStart : c.theirsStart) + 1, model.getLineCount());
        const len = Math.max(1, (side === "ours" ? c.ours : c.theirs).length);
        const top = ed.getTopForLineNumber(first) - scroll;
        const bottom = top + len * line;
        if (bottom < 0 || top > height) continue;
        // Keep the buttons in view while the block's top is scrolled away.
        const y = (top < 0 ? Math.min(0, bottom - line) : top) + (line - ICON) / 2;
        const apply = `<button class="merge-act" data-id="${c.id}" data-act="apply" title="Apply ${side === "ours" ? "left" : "right"} side" style="top:${y}px">${side === "ours" ? APPLY_RIGHT : APPLY_LEFT}</button>`;
        const ignore = `<button class="merge-act" data-id="${c.id}" data-act="ignore" title="Ignore ${side === "ours" ? "left" : "right"} side" style="top:${y}px">${IGNORE}</button>`;
        // The apply arrow sits next to the result, like Rider.
        html += side === "ours" ? ignore.replace("merge-act", "merge-act first") + apply.replace("merge-act", "merge-act second") : apply.replace("merge-act", "merge-act first") + ignore.replace("merge-act", "merge-act second");
      }
      host.innerHTML = html;
    };
    if (!p) return;
    strip(leftStrip.current, p.left.editor, "ours");
    strip(rightStrip.current, p.right.editor, "theirs");
  };
  useEffect(() => draw.current());

  const onStrip = (side: Side) => (e: React.MouseEvent) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button.merge-act");
    const c = b && conflicts.find((x) => x.id === Number(b.dataset.id));
    if (!b || !c) return;
    act(c, side, b.dataset.act === "apply" ? "apply" : "ignore");
  };
  const wheel = (e: React.WheelEvent) => {
    const ed = panes.current?.center.editor;
    if (ed) ed.setScrollTop(ed.getScrollTop() + e.deltaY);
  };

  const resolved = (c: ConflictBlock) => !!states.current[c.id] && isResolved(states.current[c.id]);
  const unresolved = conflicts.filter((c) => !resolved(c)).length;

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

  // Like Rider's Accept Left/Right: the other side of each unresolved conflict is ignored.
  const acceptAll = (choice: Side) =>
    conflicts
      .filter((c) => !resolved(c))
      .forEach((c) => {
        const other: Side = choice === "ours" ? "theirs" : "ours";
        setState(c, actOnSide(actOnSide(states.current[c.id], choice, "apply"), other, "ignore"), false);
      });

  return (
    <div className="merge-view">
      <div className="diff-toolbar">
        <button className="icon-btn" title="Previous conflict" onClick={() => conflicts.length && reveal(conflicts[(current - 1 + conflicts.length) % conflicts.length], (current - 1 + conflicts.length) % conflicts.length)}>
          <ChevronUp size={16} />
        </button>
        <button className="icon-btn" title="Next conflict" onClick={() => conflicts.length && reveal(conflicts[(current + 1) % conflicts.length], (current + 1) % conflicts.length)}>
          <ChevronDown size={16} />
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
          <div className="merge-body">
            <div ref={leftHost} className="merge-editor" />
            <div ref={leftStrip} className="merge-strip" onClick={onStrip("ours")} onWheel={wheel} />
          </div>
        </div>
        <div className="merge-col center">
          <div className="merge-label">Result</div>
          <div ref={centerHost} className="merge-editor" />
        </div>
        <div className="merge-col">
          <div className="merge-label">{labels[1]}</div>
          <div className="merge-body">
            <div ref={rightStrip} className="merge-strip" onClick={onStrip("theirs")} onWheel={wheel} />
            <div ref={rightHost} className="merge-editor" />
          </div>
        </div>
      </div>
    </div>
  );
}
