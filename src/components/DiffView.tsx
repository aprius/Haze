// Side-by-side diff as an editor tab. The right side of a "working" diff is
// the file's real buffer, so it can be edited in place like in Rider.
import { ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ensureBuffer, getModel } from "../lib/buffers";
import { api, errorMessage } from "../lib/ipc";
import { chunkKind, connectorCurve, connectorPath, mapBoundary, nextChunk, toChunk, type Chunk, type ChunkKind } from "../lib/diffLink";
import { codeFontOptions, languageFor, monaco } from "../lib/monaco";
import { monacoTheme } from "../lib/theme";
import { basename } from "../lib/path";
import { absPath } from "../store/git";
import { closeDiffWindow, useUi } from "../store/ui";
import { useWorkspace } from "../store/workspace";
import { FloatWindow } from "./Overlays";

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

interface Sides {
  left: monaco.editor.IStandaloneCodeEditor;
  right: monaco.editor.IStandaloneCodeEditor;
  /** Hidden diff editor: only used for Monaco's diff computation on the same models. */
  differ: monaco.editor.IStandaloneDiffEditor;
}

const GAP = 56;

/**
 * Rider-style diff: two plain editors (no filler lines), curved connectors
 * between matching blocks in the gap, scrolling kept in step block by block,
 * and `»` buttons that copy a block from the left into an editable right side.
 */
export function DiffView({ spec }: { spec: DiffSpec }) {
  const leftHost = useRef<HTMLDivElement>(null);
  const rightHost = useRef<HTMLDivElement>(null);
  const differHost = useRef<HTMLDivElement>(null);
  const gap = useRef<HTMLDivElement>(null);
  const sides = useRef<Sides | null>(null);
  const chunks = useRef<Chunk[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<number | null>(null);
  const editable = spec.right === "working";

  useEffect(() => {
    if (!leftHost.current || !rightHost.current || !differHost.current || !gap.current) return;
    const opts = (readOnly: boolean): monaco.editor.IStandaloneEditorConstructionOptions => ({
      readOnly,
      automaticLayout: true,
      ...codeFontOptions(),
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      glyphMargin: false,
      theme: monacoTheme(),
    });
    // The left side has no vertical scrollbar (it follows the right one), so
    // its blocks run straight into the connectors like in Rider.
    const left = monaco.editor.create(leftHost.current, {
      ...opts(true),
      scrollbar: { vertical: "hidden", verticalScrollbarSize: 0 },
      overviewRulerLanes: 0,
      overviewRulerBorder: false,
    });
    const right = monaco.editor.create(rightHost.current, opts(!editable));
    const differ = monaco.editor.createDiffEditor(differHost.current, { ignoreTrimWhitespace: false, renderOverviewRuler: false });
    sides.current = { left, right, differ };
    const leftDecos = left.createDecorationsCollection();
    const rightDecos = right.createDecorationsCollection();
    const gapEl = gap.current;

    // Pixel position of a (fractional) line boundary, relative to the viewport.
    const boundaryY = (ed: monaco.editor.ICodeEditor, b: number) => {
      const lines = ed.getModel()?.getLineCount() ?? 1;
      const at = (n: number) => (n <= 0 ? 0 : ed.getBottomForLineNumber(Math.min(n, lines)));
      const lo = Math.floor(b);
      return at(lo) + (b - lo) * (at(lo + 1) - at(lo)) - ed.getScrollTop();
    };
    // Inverse of `boundaryY` by binary search (folded regions make lines uneven).
    const boundaryAt = (ed: monaco.editor.ICodeEditor, y: number) => {
      const lines = ed.getModel()?.getLineCount() ?? 1;
      let lo = 0;
      let hi = lines;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (boundaryY(ed, mid) <= y) lo = mid;
        else hi = mid - 1;
      }
      if (lo >= lines) return lines;
      const y0 = boundaryY(ed, lo);
      const h = boundaryY(ed, lo + 1) - y0;
      return lo + (h > 0 ? Math.min(1, Math.max(0, (y - y0) / h)) : 0);
    };

    // Like Rider: centred on the block's first left line (or on the marker of an
    // empty block), and kept inside the block while its top is scrolled away.
    const BUTTON = 16;
    const applyTop = (l0: number, l1: number) => {
      if (l0 === l1) return l0 - BUTTON / 2;
      const line = left.getOption(monaco.editor.EditorOption.lineHeight);
      const top = l0 + (line - BUTTON) / 2;
      return Math.max(top, Math.min((line - BUTTON) / 2, l1 - line + (line - BUTTON) / 2));
    };

    let frame = 0;
    const draw = () => {
      frame = 0;
      const width = gapEl.clientWidth;
      const height = gapEl.clientHeight;
      let paths = "";
      let buttons = "";
      chunks.current.forEach((c, i) => {
        const l0 = boundaryY(left, c.a0);
        const l1 = boundaryY(left, c.a1);
        const r0 = boundaryY(right, c.b0);
        const r1 = boundaryY(right, c.b1);
        if (Math.max(l1, r1) < 0 || Math.min(l0, r0) > height) return;
        const kind = chunkKind(c);
        // Borders sit half a pixel inside the band to line up with the 1px edges drawn in the editors.
        const edge = (y0: number, y1: number, b: number): [number, number] => (y0 === y1 ? (b > 0 ? [y0 - 0.5, y0 - 0.5] : [y0 + 0.5, y0 + 0.5]) : [y0 + 0.5, y1 - 0.5]);
        const [lt, lb] = edge(l0, l1, c.a0);
        const [rt, rb] = edge(r0, r1, c.b0);
        paths +=
          `<path class="rd-link rd-${kind}" d="${connectorPath(width, l0, l1, r0, r1)}"/>` +
          `<path class="rd-edge rd-${kind}" d="${connectorCurve(width, lt, rt)} ${connectorCurve(width, lb, rb)}"/>`;
        if (editable) buttons += `<button class="rd-apply" data-chunk="${i}" title="Replace with the left side" style="top:${Math.round(applyTop(l0, l1))}px">»</button>`;
      });
      gapEl.innerHTML = `<svg width="${width}" height="${height}">${paths}</svg>${buttons}`;
    };
    const redraw = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };

    // Scroll the other side so the line at mid-viewport stays matched.
    let syncing = false;
    const follow = (from: monaco.editor.ICodeEditor, to: monaco.editor.ICodeEditor, fromLeft: boolean) => (e: monaco.IScrollEvent) => {
      redraw();
      if (syncing) return;
      syncing = true;
      if (e.scrollLeftChanged) to.setScrollLeft(e.scrollLeft);
      if (e.scrollTopChanged) {
        const mid = from.getLayoutInfo().height / 2;
        const target = mapBoundary(chunks.current, boundaryAt(from, mid), fromLeft);
        to.setScrollTop(to.getScrollTop() + boundaryY(to, target) - mid);
      }
      syncing = false;
    };

    const update = () => {
      const changes = differ.getLineChanges() ?? [];
      chunks.current = changes.map(toChunk);
      setStats(changes.length);
      // Each class goes on the text and on the gutter, so a block is one band across the editor.
      const whole = (from: number, to: number, cls: string): monaco.editor.IModelDeltaDecoration => ({
        range: new monaco.Range(from, 1, to, 1),
        options: { isWholeLine: true, className: cls, marginClassName: cls },
      });
      const lineDeco = (ed: monaco.editor.ICodeEditor, kind: ChunkKind, s: number, e: number): monaco.editor.IModelDeltaDecoration[] => {
        if (s < e) return [whole(s + 1, e, `rd-line rd-${kind}`), whole(s + 1, s + 1, `rd-top rd-${kind}`), whole(e, e, `rd-bottom rd-${kind}`)];
        // Empty side: a thin line where the other side's block belongs.
        const lines = ed.getModel()?.getLineCount() ?? 1;
        return s >= 1 ? [whole(Math.min(s, lines), Math.min(s, lines), `rd-bottom rd-${kind}`)] : [whole(1, 1, `rd-top rd-${kind}`)];
      };
      const charDeco = (sl: number, sc: number, el: number, ec: number): monaco.editor.IModelDeltaDecoration[] =>
        sl > 0 && el > 0 && (sl !== el || sc !== ec) ? [{ range: new monaco.Range(sl, sc, el, ec), options: { inlineClassName: "rd-char" } }] : [];
      const l: monaco.editor.IModelDeltaDecoration[] = [];
      const r: monaco.editor.IModelDeltaDecoration[] = [];
      changes.forEach((ch, i) => {
        const c = chunks.current[i];
        const kind = chunkKind(c);
        l.push(...lineDeco(left, kind, c.a0, c.a1));
        r.push(...lineDeco(right, kind, c.b0, c.b1));
        if (kind !== "modified") return;
        for (const x of ch.charChanges ?? []) {
          l.push(...charDeco(x.originalStartLineNumber, x.originalStartColumn, x.originalEndLineNumber, x.originalEndColumn));
          r.push(...charDeco(x.modifiedStartLineNumber, x.modifiedStartColumn, x.modifiedEndLineNumber, x.modifiedEndColumn));
        }
      });
      leftDecos.set(l);
      rightDecos.set(r);
      redraw();
    };

    // Monaco binds F7 itself, so the shortcuts go on the editors rather than the container.
    for (const ed of [left, right]) {
      ed.addCommand(monaco.KeyCode.F7, () => step(1));
      ed.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F7, () => step(-1));
    }

    let first = true;
    const subs = [
      left.onDidScrollChange(follow(left, right, true)),
      right.onDidScrollChange(follow(right, left, false)),
      left.onDidLayoutChange(redraw),
      right.onDidLayoutChange(redraw),
      differ.onDidUpdateDiff(() => {
        update();
        if (first && chunks.current.length) goTo(0);
        first = false;
      }),
    ];

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
        if (editable) {
          const path = absPath(spec.root, spec.rel);
          await ensureBuffer(path);
          modified = getModel(path) ?? (await fromRev(null, spec.rel));
        } else {
          modified = await fromRev(spec.right, spec.rel);
        }
        if (cancelled) return;
        left.setModel(original);
        right.setModel(modified);
        differ.setModel({ original, modified });
      } catch (e) {
        setError(errorMessage(e));
      }
    })();
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      subs.forEach((s) => s.dispose());
      differ.dispose();
      left.dispose();
      right.dispose();
      owned.forEach((m) => m.dispose());
      sides.current = null;
      chunks.current = [];
    };
  }, [spec.root, spec.rel, spec.oldRel, spec.left, spec.right]); // eslint-disable-line react-hooks/exhaustive-deps

  function goTo(i: number) {
    const s = sides.current;
    const c = chunks.current[i];
    if (!s || !c) return;
    const line = Math.min(c.b0 + 1, s.right.getModel()?.getLineCount() ?? 1);
    s.right.revealLinesInCenter(line, Math.max(line, c.b1));
    s.right.setPosition({ lineNumber: line, column: 1 });
  }

  function step(dir: 1 | -1) {
    const s = sides.current;
    if (!s) return;
    const fromLeft = s.left.hasTextFocus();
    const caret = (fromLeft ? s.left : s.right).getPosition()?.lineNumber ?? 0;
    // A caret on the left is mapped to the right side first.
    const line = fromLeft ? Math.floor(mapBoundary(chunks.current, caret - 1, true)) + 1 : caret;
    const i = nextChunk(chunks.current, line, dir);
    if (i >= 0) goTo(i);
  }

  // Replace the right side of a block with the left side's lines (one undo step).
  function apply(i: number) {
    const s = sides.current;
    const c = chunks.current[i];
    const from = s?.left.getModel();
    const to = s?.right.getModel();
    if (!s || !c || !from || !to) return;
    const eol = to.getEOL();
    const text = c.a0 < c.a1 ? from.getValueInRange(new monaco.Range(c.a0 + 1, 1, c.a1, from.getLineMaxColumn(c.a1))) : null;
    const n = to.getLineCount();
    let range: monaco.Range;
    let insert: string;
    if (c.b0 < c.b1) {
      if (text !== null) {
        range = new monaco.Range(c.b0 + 1, 1, c.b1, to.getLineMaxColumn(c.b1));
        insert = text;
      } else if (c.b1 < n) {
        range = new monaco.Range(c.b0 + 1, 1, c.b1 + 1, 1);
        insert = "";
      } else {
        // Removing the last lines also removes the line break before them.
        range = c.b0 > 0 ? new monaco.Range(c.b0, to.getLineMaxColumn(c.b0), n, to.getLineMaxColumn(n)) : to.getFullModelRange();
        insert = "";
      }
    } else {
      if (text === null) return;
      if (c.b0 < n) {
        range = new monaco.Range(c.b0 + 1, 1, c.b0 + 1, 1);
        insert = text + eol;
      } else {
        range = new monaco.Range(n, to.getLineMaxColumn(n), n, to.getLineMaxColumn(n));
        insert = eol + text;
      }
    }
    s.right.pushUndoStop();
    s.right.executeEdits("diff-apply", [{ range, text: insert }]);
    s.right.pushUndoStop();
  }

  return (
    <div className="diff-view">
      <div className="diff-toolbar">
        <button className="icon-btn" title="Previous difference (Shift+F7)" onClick={() => step(-1)}>
          <ChevronUp size={14} />
        </button>
        <button className="icon-btn" title="Next difference (F7)" onClick={() => step(1)}>
          <ChevronDown size={14} />
        </button>
        <span className="muted small">
          {error ? <span className="error">{error}</span> : stats === null ? "Comparing…" : stats === 0 ? "Contents are identical" : `${stats} difference(s)`}
        </span>
        {editable && <span className="muted small diff-hint">Right side is the local file — edits are saved as usual.</span>}
      </div>
      <div className="diff-host">
        <div ref={leftHost} className="diff-side" />
        <div
          ref={gap}
          className="diff-gap"
          style={{ width: GAP }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            const b = (e.target as HTMLElement).closest<HTMLElement>("[data-chunk]");
            if (b) apply(Number(b.dataset.chunk));
          }}
        />
        <div ref={rightHost} className="diff-side" />
        <div ref={differHost} className="diff-differ" aria-hidden />
      </div>
    </div>
  );
}

/** A diff in a floating window of its own (Ctrl+D in the Commit window). */
export function DiffWindow() {
  const w = useUi((s) => s.diffWindow);
  if (!w) return null;
  return (
    <FloatWindow key={diffPath(w.spec)} className="diff-window" title={diffTitle(w.spec)} width={1100} height={700} onClose={closeDiffWindow}>
      <div className="float-diff">
        <DiffView spec={w.spec} />
      </div>
    </FloatWindow>
  );
}
