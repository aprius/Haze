// Side-by-side diff as an editor tab. The right side of a "working" diff is
// the file's real buffer, so it can be edited in place like in Rider.
import { ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ensureBuffer, getModel } from "../lib/buffers";
import { api, errorMessage } from "../lib/ipc";
import { chunkKind, connectorCurve, connectorPath, mapBoundary, nextChunk, revertEdit, toChunk, type Chunk, type ChunkKind } from "../lib/diffLink";
import { codeFontOptions, languageFor, monaco, suggestOptions } from "../lib/monaco";
import { monacoTheme } from "../lib/theme";
import { diffPath, diffTitle, type DiffSpec } from "../lib/diffSpec";
import { absPath } from "../store/git";
import { closeDiffWindow, useUi } from "../store/ui";
import { useWorkspace } from "../store/workspace";
import { wheelScroll, zedWheel } from "../lib/wheel";
import { FloatWindow } from "./Overlays";

export { diffPath, diffTitle, parseDiffPath, type DiffSpec } from "../lib/diffSpec";

export function openDiff(projectId: string, spec: DiffSpec): void {
  useWorkspace.getState().openFile(projectId, diffPath(spec), { preview: true });
}

interface Sides {
  left: monaco.editor.IStandaloneCodeEditor;
  right: monaco.editor.IStandaloneCodeEditor;
  /** Hidden diff editor: only used for Monaco's diff computation on the same models. */
  differ: monaco.editor.IStandaloneDiffEditor;
}

// IntelliJ's `diff.divider.width`.
const GAP = 24;
// The left editor's share of the two editors' width; dragging the gap sets it
// for every diff after, as in Rider.
let lastSplit = 0.5;
const ICON = 16;
const ARROW =
  '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M3.5 4.5 7 8l-3.5 3.5M8.5 4.5 12 8l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
// Shown instead while Ctrl is held: append the left lines below the right block.
const ARROW_DOWN =
  '<svg viewBox="0 0 16 16" width="16" height="16"><path d="M4 4l7.5 7.5M11.5 6v5.5H6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/**
 * The two sides of `spec`. The right side of a "working" diff is the file's
 * real buffer; the models made here are added to `owned`, to dispose.
 */
async function diffModels(spec: DiffSpec, owned: monaco.editor.ITextModel[]) {
  const lang = languageFor(spec.rel);
  const fromRev = async (rev: string | null, rel: string) => {
    const text = rev ? ((await api.gitFileAt(spec.root, rev, rel)) ?? "") : "";
    const m = monaco.editor.createModel(text, lang);
    owned.push(m);
    return m;
  };
  const original = await fromRev(spec.left, spec.oldRel ?? spec.rel);
  if (spec.right !== "working") return { original, modified: await fromRev(spec.right, spec.rel) };
  const path = absPath(spec.root, spec.rel);
  await ensureBuffer(path);
  return { original, modified: getModel(path) ?? (await fromRev(null, spec.rel)) };
}

/**
 * Rider-style diff: two plain editors (no filler lines), curved connectors
 * between matching blocks in the gap, scrolling kept in step block by block.
 * As in IntelliJ, the left editor is mirrored: its gutter (`>>` icons, then
 * line numbers) sits against the gap. Monaco cannot mirror a gutter, so that
 * one is drawn here and the left editor shows no line numbers of its own.
 */
export function DiffView({ spec }: { spec: DiffSpec }) {
  const leftHost = useRef<HTMLDivElement>(null);
  const rightHost = useRef<HTMLDivElement>(null);
  const differHost = useRef<HTMLDivElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const gap = useRef<HTMLDivElement>(null);
  const sides = useRef<Sides | null>(null);
  const chunks = useRef<Chunk[]>([]);
  // The side last typed or clicked in: F7 and the toolbar step from its caret.
  const leftActive = useRef(false);
  const stickyScroll = useWorkspace((s) => s.stickyScroll);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<number | null>(null);
  const [split, setSplit] = useState(lastSplit);
  const editable = spec.right === "working";

  useEffect(() => {
    if (!leftHost.current || !rightHost.current || !differHost.current || !gutter.current || !gap.current) return;
    // The window this diff is in: Haze's or a floating one.
    const win = gap.current.ownerDocument.defaultView ?? window;
    const opts = (readOnly: boolean): monaco.editor.IStandaloneEditorConstructionOptions => ({
      readOnly,
      automaticLayout: true,
      // WebKit does not paint Monaco's composited layers (text, line numbers)
      // in a window of its own (the Commit and Diff windows): keep them flat there.
      disableLayerHinting: win !== window,
      ...codeFontOptions(),
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      stickyScroll: { enabled: useWorkspace.getState().stickyScroll },
      glyphMargin: false,
      suggest: suggestOptions,
      theme: monacoTheme(),
    });
    // The left side has no vertical scrollbar (it follows the right one) and
    // no gutter of its own, so its blocks run straight into the mirrored gutter.
    const left = monaco.editor.create(leftHost.current, {
      ...opts(true),
      lineNumbers: "off",
      folding: false,
      lineDecorationsWidth: 10,
      scrollbar: { vertical: "hidden", verticalScrollbarSize: 0 },
      overviewRulerLanes: 0,
      overviewRulerBorder: false,
    });
    const right = monaco.editor.create(rightHost.current, opts(!editable));
    const differ = monaco.editor.createDiffEditor(differHost.current, { ignoreTrimWhitespace: false, renderOverviewRuler: false });
    sides.current = { left, right, differ };
    const leftDecos = left.createDecorationsCollection();
    const rightDecos = right.createDecorationsCollection();
    const gutterEl = gutter.current;
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

    let frame = 0;
    // The mirrored left gutter: band tints and edges, `>>` icons on each
    // block's first line (where IntelliJ puts them), then right-aligned line numbers.
    const drawGutter = (height: number) => {
      const model = left.getModel();
      if (!model) return void (gutterEl.innerHTML = "");
      const line = left.getOption(monaco.editor.EditorOption.lineHeight);
      const font = left.getOption(monaco.editor.EditorOption.fontInfo);
      const digits = Math.max(2, String(model.getLineCount()).length);
      const width = `${Math.ceil(ICON + 6 + digits * font.typicalHalfwidthCharacterWidth + 8)}px`;
      if (gutterEl.style.width !== width) gutterEl.style.width = width;
      Object.assign(gutterEl.style, { fontFamily: font.fontFamily, fontSize: `${font.fontSize}px`, lineHeight: `${line}px` });
      let html = "";
      chunks.current.forEach((c, i) => {
        const y0 = boundaryY(left, c.a0);
        const y1 = boundaryY(left, c.a1);
        if (y1 < -line || y0 > height + line) return;
        const kind = chunkKind(c);
        if (c.a0 < c.a1) {
          html += `<div class="rd-gl-band rd-line rd-${kind}" style="top:${y0}px;height:${y1 - y0}px"></div>`;
          html += `<div class="rd-gl-edge rd-${kind}" style="top:${y0}px"></div><div class="rd-gl-edge rd-${kind}" style="top:${y1 - 1}px"></div>`;
        } else {
          html += `<div class="rd-gl-edge rd-${kind}" style="top:${c.a0 > 0 ? y0 - 1 : y0}px"></div>`;
        }
        if (editable) {
          const at = boundaryY(left, Math.min(c.a0 + 1, model.getLineCount()) - 1);
          // Like IntelliJ, Ctrl turns the icon of a modified block into Append.
          const append = ctrl && kind === "modified";
          html +=
            `<button class="rd-apply" data-chunk="${i}"${append ? " data-append" : ""} title="${append ? "Append" : "Revert (Ctrl: Append)"}" ` +
            `style="top:${at + (line - ICON) / 2}px">${append ? ARROW_DOWN : ARROW}</button>`;
        }
      });
      const caret = left.getPosition()?.lineNumber;
      const scroll = left.getScrollTop();
      for (const r of left.getVisibleRanges()) {
        for (let n = r.startLineNumber; n <= r.endLineNumber; n++) {
          html += `<div class="rd-gl-num${n === caret ? " active" : ""}" style="top:${left.getTopForLineNumber(n) - scroll}px">${n}</div>`;
        }
      }
      gutterEl.innerHTML = html;
    };

    const draw = () => {
      frame = 0;
      // Sizes read before anything is written, so a frame lays out once.
      const width = gapEl.clientWidth;
      const height = gapEl.clientHeight;
      drawGutter(gutterEl.clientHeight);
      let paths = "";
      chunks.current.forEach((c) => {
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
      });
      gapEl.innerHTML = `<svg width="${width}" height="${height}">${paths}</svg>`;
    };
    const redraw = () => {
      if (!frame) frame = win.requestAnimationFrame(draw);
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
        if (s < e) {
          // `rd-text` marks the block's text, so dim tokens (comments) can be lifted off the tint.
          const text = { range: new monaco.Range(s + 1, 1, e, ed.getModel()?.getLineMaxColumn(e) ?? 1), options: { inlineClassName: "rd-text" } };
          return [whole(s + 1, e, `rd-line rd-${kind}`), whole(s + 1, s + 1, `rd-top rd-${kind}`), whole(e, e, `rd-bottom rd-${kind}`), text];
        }
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

    // Wheel scrolling like the code editor's (Zed's, no easing); over the
    // gutter or the gap it scrolls as over the editors.
    const wheels = [zedWheel(left), zedWheel(right)];
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      wheelScroll(right, e);
    };
    gutterEl.addEventListener("wheel", wheel, { passive: false });
    gapEl.addEventListener("wheel", wheel, { passive: false });

    // Monaco binds F7 itself, so the shortcuts go on the editors rather than the container.
    for (const ed of [left, right]) {
      ed.addCommand(monaco.KeyCode.F7, () => step(1));
      ed.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F7, () => step(-1));
    }

    let first = true;
    // IntelliJ tracks the Ctrl key itself (also on macOS), not Cmd.
    let ctrl = false;
    const modifiers = (e: KeyboardEvent | FocusEvent) => {
      const now = "ctrlKey" in e && e.ctrlKey;
      if (now !== ctrl) {
        ctrl = now;
        redraw();
      }
    };
    win.addEventListener("keydown", modifiers);
    win.addEventListener("keyup", modifiers);
    win.addEventListener("blur", modifiers);

    const subs = [
      left.onDidScrollChange(follow(left, right, true)),
      right.onDidScrollChange(follow(right, left, false)),
      left.onDidLayoutChange(redraw),
      left.onDidChangeCursorPosition(redraw),
      right.onDidLayoutChange(redraw),
      left.onDidFocusEditorText(() => (leftActive.current = true)),
      right.onDidFocusEditorText(() => (leftActive.current = false)),
      differ.onDidUpdateDiff(() => {
        update();
        if (first && chunks.current.length) goTo(0);
        first = false;
      }),
    ];

    const owned: monaco.editor.ITextModel[] = [];
    let cancelled = false;
    void (async () => {
      try {
        const { original, modified } = await diffModels(spec, owned);
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
      win.cancelAnimationFrame(frame);
      gutterEl.removeEventListener("wheel", wheel);
      win.removeEventListener("keydown", modifiers);
      win.removeEventListener("keyup", modifiers);
      win.removeEventListener("blur", modifiers);
      gapEl.removeEventListener("wheel", wheel);
      wheels.forEach((w) => w.dispose());
      subs.forEach((s) => s.dispose());
      differ.dispose();
      left.dispose();
      right.dispose();
      owned.forEach((m) => m.dispose());
      sides.current = null;
      chunks.current = [];
    };
  }, [spec.root, spec.rel, spec.oldRel, spec.left, spec.right]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const s = sides.current;
    for (const ed of s ? [s.left, s.right] : []) ed.updateOptions({ stickyScroll: { enabled: stickyScroll } });
  }, [stickyScroll]);

  function goTo(i: number) {
    const s = sides.current;
    const c = chunks.current[i];
    if (!s || !c) return;
    const line = Math.min(c.b0 + 1, s.right.getModel()?.getLineCount() ?? 1);
    s.right.revealLinesInCenter(line, Math.max(line, c.b1), monaco.editor.ScrollType.Immediate);
    // Both carets onto the block, so the next step goes on from it whichever side has focus.
    s.right.setPosition({ lineNumber: line, column: 1 });
    s.left.setPosition({ lineNumber: Math.min(c.a0 + 1, s.left.getModel()?.getLineCount() ?? 1), column: 1 });
  }

  function step(dir: 1 | -1) {
    const s = sides.current;
    if (!s) return;
    const fromLeft = leftActive.current;
    const ed = fromLeft ? s.left : s.right;
    let caret = ed.getPosition()?.lineNumber ?? 0;
    // Scrolled away from the caret: step from the middle of what is shown instead.
    const shown = ed.getVisibleRanges();
    if (shown.length && (caret < shown[0].startLineNumber || caret > shown[shown.length - 1].endLineNumber)) {
      caret = Math.floor((shown[0].startLineNumber + shown[shown.length - 1].endLineNumber) / 2);
    }
    // A caret on the left is mapped to the right side first.
    const line = fromLeft ? Math.floor(mapBoundary(chunks.current, caret - 1, true)) + 1 : caret;
    const i = nextChunk(chunks.current, line, dir);
    if (i >= 0) goTo(i);
  }

  // Replace the right side of a block with the left side's lines, or with
  // `append` insert them below it, keeping the right lines (one undo step).
  function apply(i: number, append = false) {
    const s = sides.current;
    const c = chunks.current[i];
    const from = s?.left.getModel();
    const to = s?.right.getModel();
    if (!s || !c || !from || !to) return;
    const e = revertEdit(c, from.getLinesContent(), to.getLinesContent(), to.getEOL(), append);
    if (!e) return;
    s.right.pushUndoStop();
    s.right.executeEdits("diff-apply", [{ range: new monaco.Range(e.startLine, e.startColumn, e.endLine, e.endColumn), text: e.text }]);
    s.right.pushUndoStop();
  }

  // Drag the gap to share the width between the sides; double-click evens them.
  function resize(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || !leftHost.current || !rightHost.current) return;
    e.preventDefault();
    const el = e.currentTarget;
    const total = leftHost.current.offsetWidth + rightHost.current.offsetWidth;
    const x0 = e.clientX;
    const s0 = split;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setSplit((lastSplit = Math.min(0.9, Math.max(0.1, s0 + (ev.clientX - x0) / total))));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  }

  return (
    <div className="diff-view">
      {/* Clicks keep focus in the editors, so the caret side stays the one stepped from. */}
      <div className="diff-toolbar" onMouseDown={(e) => (e.target as HTMLElement).closest("button") && e.preventDefault()}>
        <button className="icon-btn" title="Previous difference (Shift+F7)" onClick={() => step(-1)}>
          <ChevronUp size={16} />
        </button>
        <button className="icon-btn" title="Next difference (F7)" onClick={() => step(1)}>
          <ChevronDown size={16} />
        </button>
        <span className="muted small">
          {error ? <span className="error">{error}</span> : stats === null ? "Comparing…" : stats === 0 ? "Contents are identical" : `${stats} difference(s)`}
        </span>
        {editable && <span className="muted small diff-hint">Right side is the local file — edits are saved as usual.</span>}
      </div>
      <div className="diff-host">
        <div ref={leftHost} className="diff-side" style={{ flex: `${split} 1 0` }} />
        <div
          ref={gutter}
          className="diff-lgutter"
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            const b = (e.target as HTMLElement).closest<HTMLElement>("[data-chunk]");
            if (b) apply(Number(b.dataset.chunk), b.dataset.append !== undefined);
          }}
        />
        <div
          ref={gap}
          className="diff-gap"
          style={{ width: GAP }}
          onPointerDown={resize}
          onDoubleClick={() => setSplit((lastSplit = 0.5))}
        />
        <div ref={rightHost} className="diff-side" style={{ flex: `${1 - split} 1 0` }} />
        <div ref={differHost} className="diff-differ" aria-hidden />
      </div>
    </div>
  );
}

/**
 * The Commit window's preview, like Rider's: one editor (IntelliJ's unified
 * viewer), the file as it is now with the removed lines shown between its
 * own. Ctrl+D opens the side-by-side diff.
 */
export function UnifiedDiffView({ spec }: { spec: DiffSpec }) {
  const host = useRef<HTMLDivElement>(null);
  const diff = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<number | null>(null);
  const stickyScroll = useWorkspace((s) => s.stickyScroll);
  const editable = spec.right === "working";

  useEffect(() => {
    if (!host.current) return;
    const win = host.current.ownerDocument.defaultView ?? window;
    const ed = monaco.editor.createDiffEditor(host.current, {
      renderSideBySide: false,
      automaticLayout: true,
      disableLayerHinting: win !== window,
      ...codeFontOptions(),
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      stickyScroll: { enabled: useWorkspace.getState().stickyScroll },
      glyphMargin: false,
      ignoreTrimWhitespace: false,
      renderOverviewRuler: false,
      originalEditable: false,
      readOnly: !editable,
      renderMarginRevertIcon: editable,
      suggest: suggestOptions,
      theme: monacoTheme(),
    });
    diff.current = ed;
    const shown = ed.getModifiedEditor();
    const wheel = zedWheel(shown);
    // Monaco's F7 opens its accessible diff viewer; IntelliJ's goes to the next change.
    shown.addCommand(monaco.KeyCode.F7, () => step(1));
    shown.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F7, () => step(-1));
    let first = true;
    const sub = ed.onDidUpdateDiff(() => {
      const changes = ed.getLineChanges() ?? [];
      setStats(changes.length);
      if (first && changes.length) {
        const line = Math.max(1, changes[0].modifiedStartLineNumber);
        shown.revealLineInCenter(line, monaco.editor.ScrollType.Immediate);
        shown.setPosition({ lineNumber: line, column: 1 });
      }
      first = false;
    });

    const owned: monaco.editor.ITextModel[] = [];
    let cancelled = false;
    void (async () => {
      try {
        const models = await diffModels(spec, owned);
        if (!cancelled) ed.setModel(models);
      } catch (e) {
        setError(errorMessage(e));
      }
    })();
    return () => {
      cancelled = true;
      sub.dispose();
      wheel.dispose();
      ed.dispose();
      owned.forEach((m) => m.dispose());
      diff.current = null;
    };
  }, [spec.root, spec.rel, spec.oldRel, spec.left, spec.right]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    diff.current?.updateOptions({ stickyScroll: { enabled: stickyScroll } });
  }, [stickyScroll]);

  function step(dir: 1 | -1) {
    const ed = diff.current;
    if (!ed) return;
    const shown = ed.getModifiedEditor();
    // Scrolled away from the caret: step from the middle of what is shown instead.
    const caret = shown.getPosition()?.lineNumber ?? 0;
    const ranges = shown.getVisibleRanges();
    if (ranges.length && (caret < ranges[0].startLineNumber || caret > ranges[ranges.length - 1].endLineNumber)) {
      shown.setPosition({ lineNumber: Math.floor((ranges[0].startLineNumber + ranges[ranges.length - 1].endLineNumber) / 2), column: 1 });
    }
    ed.goToDiff(dir === 1 ? "next" : "previous");
  }

  return (
    <div className="diff-view">
      <div className="diff-toolbar" onMouseDown={(e) => (e.target as HTMLElement).closest("button") && e.preventDefault()}>
        <button className="icon-btn" title="Previous difference (Shift+F7)" onClick={() => step(-1)}>
          <ChevronUp size={16} />
        </button>
        <button className="icon-btn" title="Next difference (F7)" onClick={() => step(1)}>
          <ChevronDown size={16} />
        </button>
        <span className="muted small">
          {error ? <span className="error">{error}</span> : stats === null ? "Comparing…" : stats === 0 ? "Contents are identical" : `${stats} difference(s)`}
        </span>
        <span className="muted small diff-hint">Ctrl+D: side-by-side diff</span>
      </div>
      <div className="diff-host">
        <div ref={host} className="diff-side" />
      </div>
    </div>
  );
}

/** A diff in a floating window of its own (Ctrl+D in the Commit window). */
export function DiffWindow() {
  const w = useUi((s) => s.diffWindow);
  if (!w) return null;
  return (
    <FloatWindow className="diff-window" title={diffTitle(w.spec)} width={1100} height={700} onClose={closeDiffWindow}>
      <div className="float-diff">
        <DiffView key={diffPath(w.spec)} spec={w.spec} />
      </div>
    </FloatWindow>
  );
}
