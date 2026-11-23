// Three-pane merge window (Yours | Result | Theirs) as an editor tab, opened
// for a conflicted file. Non-conflicting changes are already applied in the
// result. It is drawn like the side-by-side diff, twice: each side against the
// result, with curved connectors between matching blocks and scrolling kept in
// step block by block. As in Rider, a conflict has » and × in the left side's
// gutter and « and × in the right side's: apply that side to the result, or
// ignore it; a conflict is resolved once both sides are handled (or by hand).
// Unity scenes, prefabs and other Unity YAML go through UnityYAMLMerge first,
// as in Rider: the panes then hold its premerged versions, and only the
// conflicts it could not resolve are left.
import { ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getModel, reloadBuffer } from "../lib/buffers";
import { chunkKind, connectorCurve, connectorPath, mapBoundary, toChunk, type Chunk } from "../lib/diffLink";
import { api, errorMessage } from "../lib/ipc";
import { actOnSide, conflictRange, isResolved, pendingState, rewriteBlock, stateLines, type ConflictBlock, type ConflictState, type MergeModel, type ResultEdit } from "../lib/merge";
import MergeWorker from "../lib/merge.worker?worker";
import { codeFontOptions, languageFor, monaco, suggestOptions } from "../lib/monaco";
import { monacoTheme } from "../lib/theme";
import { basename } from "../lib/path";
import { mergePath, type MergeSpec } from "../lib/diffSpec";
import { wheelScroll, zedWheel } from "../lib/wheel";
import { absPath, refreshRepo, repo, runGit } from "../store/git";
import { useWorkspace, type Project } from "../store/workspace";
import { closeTabsWithPrompt } from "./EditorArea";
import { confirmAction, toast } from "./Overlays";

export { mergePath, mergeTitle, parseMergePath, type MergeSpec } from "../lib/diffSpec";

export function openMerge(projectId: string, spec: MergeSpec): void {
  useWorkspace.getState().openFile(projectId, mergePath(spec));
}

type Side = "ours" | "theirs";
type Ed = monaco.editor.IStandaloneCodeEditor;

const ICON = 16;
const GAP = 24;
const SVG = (d: string) => `<svg viewBox="0 0 16 16" width="16" height="16"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const APPLY_RIGHT = SVG("M3.5 4.5 7 8l-3.5 3.5M8.5 4.5 12 8l-3.5 3.5");
const APPLY_LEFT = SVG("M12.5 4.5 9 8l3.5 3.5M7.5 4.5 4 8l3.5 3.5");
const IGNORE = SVG("M4.5 4.5l7 7M11.5 4.5l-7 7");

/** `buildMerge` in a worker; it ends when this does. */
function buildMergeInWorker(ours: string, base: string, theirs: string): { result: Promise<MergeModel>; cancel: () => void } {
  const worker = new MergeWorker();
  const result = new Promise<MergeModel>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<MergeModel>) => (worker.terminate(), resolve(e.data));
    worker.onerror = (e) => (worker.terminate(), reject(new Error(e.message || "Could not compute the merge.")));
  });
  worker.postMessage({ ours, base, theirs });
  return { result, cancel: () => worker.terminate() };
}

/**
 * For each chunk (by its boundaries on one side), whether it touches one of
 * `spans` (sorted, not overlapping): a binary search each, not a scan.
 */
function touching(chunks: readonly [number, number][], spans: readonly [number, number][]): boolean[] {
  return chunks.map(([c0, c1]) => {
    let lo = 0;
    let hi = spans.length;
    // The first span ending at or after the chunk's start.
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (spans[mid][1] < c0) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < spans.length && spans[i][0] <= c1; i++) if (overlaps(c0, c1, spans[i][0], spans[i][1])) return true;
    return false;
  });
}

const rangeOf = (e: ResultEdit) => new monaco.Range(e.startLine, e.startColumn, e.endLine, e.endColumn);

/** Whether the line boundaries `a0..a1` and `b0..b1` touch, an empty span counting as its point. */
const overlaps = (a0: number, a1: number, b0: number, b1: number) => (a0 === a1 || b0 === b1 ? a0 <= b1 && b0 <= a1 : a0 < b1 && b0 < a1);

// Pixel position of a (fractional) line boundary, relative to the viewport.
function boundaryY(ed: monaco.editor.ICodeEditor, b: number): number {
  const lines = ed.getModel()?.getLineCount() ?? 1;
  const at = (n: number) => (n <= 0 ? 0 : ed.getBottomForLineNumber(Math.min(n, lines)));
  const lo = Math.floor(b);
  return at(lo) + (b - lo) * (at(lo + 1) - at(lo)) - ed.getScrollTop();
}

// Inverse of `boundaryY` by binary search (folded regions make lines uneven).
function boundaryAt(ed: monaco.editor.ICodeEditor, y: number): number {
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
}

/** The first of `n` items, their ends ascending, whose end is at or after `at`. */
function firstEndingFrom(n: number, end: (i: number) => number, at: number): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (end(mid) < at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The line boundaries `ed` shows (with a line to spare either way). */
function shown(ed: monaco.editor.ICodeEditor): [number, number] {
  const r = ed.getVisibleRanges();
  const count = ed.getModel()?.getLineCount() ?? 1;
  return [Math.max(0, (r[0]?.startLineNumber ?? 1) - 2), (r[r.length - 1]?.endLineNumber ?? count) + 1];
}

interface Panes {
  left: Ed;
  center: Ed;
  right: Ed;
}

export function MergeView({ project, spec }: { project: Project; spec: MergeSpec }) {
  const leftHost = useRef<HTMLDivElement>(null);
  const centerHost = useRef<HTMLDivElement>(null);
  const rightHost = useRef<HTMLDivElement>(null);
  const leftGutter = useRef<HTMLDivElement>(null);
  const rightGutter = useRef<HTMLDivElement>(null);
  const leftGap = useRef<HTMLDivElement>(null);
  const rightGap = useRef<HTMLDivElement>(null);
  const differL = useRef<HTMLDivElement>(null);
  const differR = useRef<HTMLDivElement>(null);
  const panes = useRef<Panes | null>(null);
  // Tracked ranges of each conflict in the result model.
  const tracked = useRef<string[]>([]);
  // Whether each conflict holds no line in the result. Not read off its range:
  // a one-line block is marked from column 1 to column 1, an empty range too.
  const blockEmpty = useRef<boolean[]>([]);
  // Each conflict's sides; the ref is what the editors' handlers read.
  const states = useRef<ConflictState[]>([]);
  const conflictsRef = useRef<ConflictBlock[]>([]);
  // Re-decorates and redraws after a conflict's state changes.
  const refresh = useRef<() => void>(() => {});
  const [conflicts, setConflicts] = useState<ConflictBlock[]>([]);
  const [, setVersion] = useState(0);
  const [current, setCurrent] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // UnityYAMLMerge ran (its path), or why it could not.
  const [smart, setSmart] = useState<{ tool: string; conflicts: boolean } | null>(null);
  const [smartError, setSmartError] = useState<string | null>(null);
  const operation = repo(project.id).branches?.operation ?? null;
  // During a rebase, stage 2 is the branch being rebased onto and stage 3 is your commit.
  const labels = operation === "rebase" ? ["Upstream (being rebased onto)", "Your commit"] : ["Yours (current branch)", "Theirs (incoming)"];

  useEffect(() => {
    const hosts = [leftHost, centerHost, rightHost, leftGutter, rightGutter, leftGap, rightGap, differL, differR].map((r) => r.current);
    if (hosts.some((h) => !h)) return;
    const [lh, ch, rh, lgEl, rgEl, lgapEl, rgapEl, dlh, drh] = hosts as HTMLDivElement[];
    const win = ch.ownerDocument.defaultView ?? window;
    const opts = (readOnly: boolean): monaco.editor.IStandaloneEditorConstructionOptions => ({
      readOnly,
      automaticLayout: true,
      disableLayerHinting: win !== window,
      ...codeFontOptions(),
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      glyphMargin: false,
      suggest: suggestOptions,
      theme: monacoTheme(),
    });
    // The sides have no vertical scrollbar (they follow the result) and no
    // gutter of their own: theirs are drawn against the gaps, as in the diff.
    const side = (host: HTMLDivElement) =>
      monaco.editor.create(host, {
        ...opts(true),
        lineNumbers: "off",
        folding: false,
        lineDecorationsWidth: 10,
        scrollbar: { vertical: "hidden", verticalScrollbarSize: 0 },
        overviewRulerLanes: 0,
        overviewRulerBorder: false,
      });
    const left = side(lh);
    const center = monaco.editor.create(ch, opts(false));
    const right = side(rh);
    const all = [left, center, right];
    panes.current = { left, center, right };
    // Hidden diff editors, as in the diff view: each side against the result.
    const dl = monaco.editor.createDiffEditor(dlh, { ignoreTrimWhitespace: false, renderOverviewRuler: false });
    const dr = monaco.editor.createDiffEditor(drh, { ignoreTrimWhitespace: false, renderOverviewRuler: false });
    const decos = all.map((ed) => ed.createDecorationsCollection());
    // Left vs result (a = left, b = result) and result vs right (a = result, b = right).
    let chunksL: Chunk[] = [];
    let chunksR: Chunk[] = [];
    let changesL: monaco.editor.ILineChange[] = [];
    let changesR: monaco.editor.ILineChange[] = [];

    // Each block's colour, worked out once per update: red where it is a side
    // of a conflict not handled yet, else the kind of change.
    let kindsL: string[] = [];
    let kindsR: string[] = [];
    const kinds = (chunks: Chunk[], side: Side) => {
      const spans = conflictsRef.current
        .filter((x) => states.current[x.id]?.[side] === "pending")
        .map((x): [number, number] => (side === "ours" ? [x.oursStart, x.oursStart + x.ours.length] : [x.theirsStart, x.theirsStart + x.theirs.length]));
      const hit = touching(chunks.map((c) => (side === "ours" ? [c.a0, c.a1] : [c.b0, c.b1])), spans);
      return chunks.map((c, i) => (hit[i] ? "conflict" : chunkKind(c)));
    };

    let frame = 0;
    // A side's gutter, mirrored for the left one: band tints and edges, the
    // conflict buttons on each conflict's first line, and line numbers against the gap.
    // Only what is in view is drawn: blocks and conflicts are in line order, so a binary search finds the first.
    const drawGutter = (el: HTMLDivElement, ed: Ed, chunks: Chunk[], kindOf: string[], which: Side) => {
      const model = ed.getModel();
      if (!model) return void (el.innerHTML = "");
      const line = ed.getOption(monaco.editor.EditorOption.lineHeight);
      const font = ed.getOption(monaco.editor.EditorOption.fontInfo);
      const height = el.clientHeight;
      const digits = Math.max(2, String(model.getLineCount()).length);
      const width = `${Math.ceil(2 * ICON + 2 + 6 + digits * font.typicalHalfwidthCharacterWidth + 8)}px`;
      if (el.style.width !== width) el.style.width = width;
      Object.assign(el.style, { fontFamily: font.fontFamily, fontSize: `${font.fontSize}px`, lineHeight: `${line}px` });
      let html = "";
      const [top, bottom] = shown(ed);
      const lo = (c: Chunk) => (which === "ours" ? c.a0 : c.b0);
      const hi = (c: Chunk) => (which === "ours" ? c.a1 : c.b1);
      for (let i = firstEndingFrom(chunks.length, (j) => hi(chunks[j]), top); i < chunks.length && lo(chunks[i]) <= bottom; i++) {
        const s0 = lo(chunks[i]);
        const s1 = hi(chunks[i]);
        const cls = kindOf[i];
        const y0 = boundaryY(ed, s0);
        const y1 = boundaryY(ed, s1);
        if (y1 < -line || y0 > height + line) continue;
        if (s0 < s1) {
          html += `<div class="rd-gl-band rd-line rd-${cls}" style="top:${y0}px;height:${y1 - y0}px"></div>`;
          html += `<div class="rd-gl-edge rd-${cls}" style="top:${y0}px"></div><div class="rd-gl-edge rd-${cls}" style="top:${y1 - 1}px"></div>`;
        } else {
          html += `<div class="rd-gl-edge rd-${cls}" style="top:${s0 > 0 ? y0 - 1 : y0}px"></div>`;
        }
      }
      const pos = (n: number) => (which === "ours" ? `left:${n}px` : `left:auto;right:${n}px`);
      const name = which === "ours" ? "left" : "right";
      const list = conflictsRef.current;
      const startOf = (c: ConflictBlock) => (which === "ours" ? c.oursStart : c.theirsStart);
      const endOf = (c: ConflictBlock) => startOf(c) + (which === "ours" ? c.ours : c.theirs).length;
      for (let i = firstEndingFrom(list.length, (j) => endOf(list[j]), top); i < list.length && startOf(list[i]) <= bottom; i++) {
        const c = list[i];
        if (states.current[c.id]?.[which] !== "pending") continue;
        const start = startOf(c);
        const y = boundaryY(ed, Math.min(start + 1, model.getLineCount()) - 1) + (line - ICON) / 2;
        if (y < -line || y > height) continue;
        html +=
          `<button class="rd-apply" data-id="${c.id}" data-act="apply" title="Apply ${name} side" style="top:${y}px;${pos(3)}">${which === "ours" ? APPLY_RIGHT : APPLY_LEFT}</button>` +
          `<button class="rd-apply" data-id="${c.id}" data-act="ignore" title="Ignore ${name} side" style="top:${y}px;${pos(ICON + 5)}">${IGNORE}</button>`;
      }
      const caret = ed.getPosition()?.lineNumber;
      const scroll = ed.getScrollTop();
      for (const r of ed.getVisibleRanges()) {
        for (let n = r.startLineNumber; n <= r.endLineNumber; n++) {
          html += `<div class="rd-gl-num${n === caret ? " active" : ""}" style="top:${ed.getTopForLineNumber(n) - scroll}px">${n}</div>`;
        }
      }
      el.innerHTML = html;
    };
    const drawGap = (el: HTMLDivElement, a: Ed, b: Ed, chunks: Chunk[], kindOf: string[]) => {
      const width = el.clientWidth;
      const height = el.clientHeight;
      let paths = "";
      const [aTop, aBottom] = shown(a);
      const [bTop, bBottom] = shown(b);
      // A link is in view while either end is; one going from above to below starts before both.
      const from = Math.min(firstEndingFrom(chunks.length, (j) => chunks[j].a1, aTop), firstEndingFrom(chunks.length, (j) => chunks[j].b1, bTop));
      for (let i = from; i < chunks.length && (chunks[i].a0 <= aBottom || chunks[i].b0 <= bBottom); i++) {
        const c = chunks[i];
        const l0 = boundaryY(a, c.a0);
        const l1 = boundaryY(a, c.a1);
        const r0 = boundaryY(b, c.b0);
        const r1 = boundaryY(b, c.b1);
        if (Math.max(l1, r1) < 0 || Math.min(l0, r0) > height) continue;
        const k = kindOf[i];
        // Borders sit half a pixel inside the band to line up with the 1px edges drawn in the editors.
        const edge = (y0: number, y1: number, s: number): [number, number] => (y0 === y1 ? (s > 0 ? [y0 - 0.5, y0 - 0.5] : [y0 + 0.5, y0 + 0.5]) : [y0 + 0.5, y1 - 0.5]);
        const [lt, lb] = edge(l0, l1, c.a0);
        const [rt, rb] = edge(r0, r1, c.b0);
        paths +=
          `<path class="rd-link rd-${k}" d="${connectorPath(width, l0, l1, r0, r1)}"/>` +
          `<path class="rd-edge rd-${k}" d="${connectorCurve(width, lt, rt)} ${connectorCurve(width, lb, rb)}"/>`;
      }
      el.innerHTML = `<svg width="${width}" height="${height}">${paths}</svg>`;
    };
    const draw = () => {
      frame = 0;
      drawGutter(lgEl, left, chunksL, kindsL, "ours");
      drawGutter(rgEl, right, chunksR, kindsR, "theirs");
      drawGap(lgapEl, left, center, chunksL, kindsL);
      drawGap(rgapEl, center, right, chunksR, kindsR);
    };
    const redraw = () => {
      if (!frame) frame = win.requestAnimationFrame(draw);
    };

    // The result leads; each side is scrolled so the line at mid-viewport stays matched.
    let syncing = false;
    const align = (to: Ed, target: number, mid: number) => to.setScrollTop(to.getScrollTop() + boundaryY(to, target) - mid);
    const follow = (from: Ed) => (e: monaco.IScrollEvent) => {
      redraw();
      if (syncing || !e.scrollTopChanged) return;
      syncing = true;
      const mid = from.getLayoutInfo().height / 2;
      if (from === left) align(center, mapBoundary(chunksL, boundaryAt(left, mid), true), mid);
      if (from === right) align(center, mapBoundary(chunksR, boundaryAt(right, mid), false), mid);
      const x = boundaryAt(center, mid);
      if (from !== left) align(left, mapBoundary(chunksL, x, false), mid);
      if (from !== right) align(right, mapBoundary(chunksR, x, true), mid);
      syncing = false;
    };

    const update = () => {
      chunksL = changesL.map(toChunk);
      chunksR = changesR.map(toChunk);
      kindsL = kinds(chunksL, "ours");
      kindsR = kinds(chunksR, "theirs");
      // Each class goes on the text and on the gutter, so a block is one band across the editor.
      const whole = (from: number, to: number, cls: string): monaco.editor.IModelDeltaDecoration => ({
        range: new monaco.Range(from, 1, to, 1),
        options: { isWholeLine: true, className: cls, marginClassName: cls },
      });
      const lineDeco = (ed: Ed, kind: string, s: number, e: number): monaco.editor.IModelDeltaDecoration[] => {
        if (s < e) {
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
      const m: monaco.editor.IModelDeltaDecoration[] = [];
      const r: monaco.editor.IModelDeltaDecoration[] = [];
      const add = (changes: monaco.editor.ILineChange[], chunks: Chunk[], kindOf: string[], a: monaco.editor.IModelDeltaDecoration[], ae: Ed, b: monaco.editor.IModelDeltaDecoration[], be: Ed) =>
        changes.forEach((ch, i) => {
          const c = chunks[i];
          const k = kindOf[i];
          a.push(...lineDeco(ae, k, c.a0, c.a1));
          b.push(...lineDeco(be, k, c.b0, c.b1));
          if (chunkKind(c) !== "modified") return;
          for (const x of ch.charChanges ?? []) {
            a.push(...charDeco(x.originalStartLineNumber, x.originalStartColumn, x.originalEndLineNumber, x.originalEndColumn));
            b.push(...charDeco(x.modifiedStartLineNumber, x.modifiedStartColumn, x.modifiedEndLineNumber, x.modifiedEndColumn));
          }
        });
      add(changesL, chunksL, kindsL, l, left, m, center);
      add(changesR, chunksR, kindsR, m, center, r, right);
      decos[0].set(l);
      decos[1].set(m);
      decos[2].set(r);
      redraw();
    };
    refresh.current = update;

    // Wheel scrolling like the code editor's; over a gutter or a gap it scrolls the result.
    const wheels = all.map(zedWheel);
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      wheelScroll(center, e);
    };
    const wheelHosts = [lgEl, rgEl, lgapEl, rgapEl];
    wheelHosts.forEach((h) => h.addEventListener("wheel", wheel, { passive: false }));

    let first = true;
    const subs = [
      ...all.map((ed) => ed.onDidScrollChange(follow(ed))),
      ...all.map((ed) => ed.onDidLayoutChange(redraw)),
      left.onDidChangeCursorPosition(redraw),
      right.onDidChangeCursorPosition(redraw),
      dl.onDidUpdateDiff(() => {
        changesL = dl.getLineChanges() ?? [];
        update();
      }),
      dr.onDidUpdateDiff(() => {
        changesR = dr.getLineChanges() ?? [];
        update();
        if (first && conflictsRef.current.length) reveal(conflictsRef.current[0], 0);
        first = false;
      }),
    ];

    const owned: monaco.editor.ITextModel[] = [];
    let cancelled = false;
    let stopWorker = () => {};
    void (async () => {
      try {
        const [base, ours, theirs, unity] = await Promise.all([
          api.gitFileAt(spec.root, ":1", spec.rel),
          api.gitFileAt(spec.root, ":2", spec.rel),
          api.gitFileAt(spec.root, ":3", spec.rel),
          api.unityYamlMerge(spec.root, spec.rel).catch((e) => (setSmartError(errorMessage(e)), null)),
        ]);
        if (cancelled) return;
        if (ours === null && theirs === null) throw new Error("This file is not in conflict anymore.");
        let leftText = ours ?? "";
        let rightText = theirs ?? "";
        let model: MergeModel;
        if (unity && !unity.conflicts) {
          // Merged whole: the sides stay as committed, to compare with.
          model = { eol: "\n", result: unity.mine, conflicts: [] };
        } else {
          // With conflicts left, the sides are Unity's premerged versions, which differ only there.
          if (unity) [leftText, rightText] = [unity.mine, unity.theirs];
          const job = unity ? buildMergeInWorker(unity.mine, unity.base, unity.theirs) : buildMergeInWorker(ours ?? "", base ?? "", theirs ?? "");
          stopWorker = job.cancel;
          model = await job.result;
          if (cancelled) return;
        }
        if (unity) setSmart({ tool: unity.tool, conflicts: unity.conflicts });
        const lang = languageFor(spec.rel);
        const mkModel = (text: string) => {
          const m = monaco.editor.createModel(text, lang);
          owned.push(m);
          return m;
        };
        const oursModel = mkModel(leftText);
        const theirsModel = mkModel(rightText);
        const result = mkModel(model.result);
        const lines = result.getLinesContent();
        tracked.current = result.deltaDecorations(
          [],
          model.conflicts.map((c) => ({
            range: rangeOf(conflictRange(c, lines)),
            options: { stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
          })),
        );
        states.current = model.conflicts.map(pendingState);
        blockEmpty.current = model.conflicts.map((c) => c.base.length === 0);
        conflictsRef.current = model.conflicts;
        setConflicts(model.conflicts);
        setLoading(false);
        left.setModel(oursModel);
        center.setModel(result);
        right.setModel(theirsModel);
        dl.setModel({ original: oursModel, modified: result });
        dr.setModel({ original: result, modified: theirsModel });
      } catch (e) {
        if (cancelled) return;
        setError(errorMessage(e));
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      stopWorker();
      win.cancelAnimationFrame(frame);
      wheelHosts.forEach((h) => h.removeEventListener("wheel", wheel));
      wheels.forEach((w) => w.dispose());
      subs.forEach((s) => s.dispose());
      dl.dispose();
      dr.dispose();
      all.forEach((ed) => ed.dispose());
      owned.forEach((m) => m.dispose());
      panes.current = null;
      refresh.current = () => {};
    };
  }, [spec.root, spec.rel]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Scrolls the result to conflict `c`; the sides follow. */
  function reveal(c: ConflictBlock, i: number) {
    const p = panes.current;
    const model = p?.center.getModel();
    if (!p || !model) return;
    setCurrent(i);
    const r = model.getDecorationRange(tracked.current[c.id]);
    if (r) p.center.revealLinesInCenter(r.startLineNumber, r.endLineNumber);
  }

  /**
   * Puts conflict `c` in state `next`: rewrites its lines in the result. In a
   * batch the caller re-decorates once at the end instead of after each one.
   */
  function setState(c: ConflictBlock, next: ConflictState, batch = false) {
    const p = panes.current;
    const model = p?.center.getModel();
    if (!p || !model) return;
    const prev = states.current[c.id];
    if (prev === next) return;
    const r = model.getDecorationRange(tracked.current[c.id]);
    if (!r) return;
    // Lines typed into the block by hand are part of it too: its range says how many.
    const mark = { startLine: r.startLineNumber, startColumn: r.startColumn, endLine: r.endLineNumber, empty: blockEmpty.current[c.id] };
    if (prev.order.join() !== next.order.join()) {
      const { edit, mark: after } = rewriteBlock(mark, stateLines(c, next), model.getLinesContent(), model.getEOL());
      p.center.executeEdits("merge", [{ range: rangeOf(edit), text: edit.text }]);
      const range = new monaco.Range(after.startLine, after.startColumn, after.endLine, after.endColumn);
      [tracked.current[c.id]] = model.deltaDecorations([tracked.current[c.id]], [{ range, options: { stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges } }]);
      blockEmpty.current[c.id] = after.empty;
    }
    states.current[c.id] = next;
    if (batch) return;
    refresh.current();
    setVersion((v) => v + 1);
    if (isResolved(next)) {
      const i = conflicts.findIndex((x) => x.id !== c.id && !isResolved(states.current[x.id]));
      if (i >= 0) reveal(conflicts[i], i);
    }
  }

  const onGutter = (side: Side) => (e: React.MouseEvent) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    const c = b && conflicts.find((x) => x.id === Number(b.dataset.id));
    if (!b || !c) return;
    setState(c, actOnSide(states.current[c.id], side, b.dataset.act === "apply" ? "apply" : "ignore"));
  };

  const resolved = (c: ConflictBlock) => !!states.current[c.id] && isResolved(states.current[c.id]);
  const unresolved = conflicts.filter((c) => !resolved(c)).length;

  const apply = async () => {
    const model = panes.current?.center.getModel();
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
  const acceptAll = (choice: Side) => {
    const other: Side = choice === "ours" ? "theirs" : "ours";
    const edit = panes.current?.center;
    // One undo step for all of them.
    edit?.pushUndoStop();
    for (const c of conflicts) if (!resolved(c)) setState(c, actOnSide(actOnSide(states.current[c.id], choice, "apply"), other, "ignore"), true);
    edit?.pushUndoStop();
    refresh.current();
    setVersion((v) => v + 1);
  };

  const step = (dir: 1 | -1) => {
    if (!conflicts.length) return;
    const i = (current + dir + conflicts.length) % conflicts.length;
    reveal(conflicts[i], i);
  };

  return (
    <div className="merge-view">
      <div className="diff-toolbar">
        <button className="icon-btn" title="Previous conflict" onClick={() => step(-1)}>
          <ChevronUp size={16} />
        </button>
        <button className="icon-btn" title="Next conflict" onClick={() => step(1)}>
          <ChevronDown size={16} />
        </button>
        <span className={"small " + (unresolved && !loading ? "error" : "muted")}>
          {error
            ? error
            : loading
              ? "Computing merge…"
              : conflicts.length === 0
                ? smart
                  ? "No conflicts left — merged by UnityYAMLMerge."
                  : "No conflicts left — changes merged automatically."
                : `${unresolved} of ${conflicts.length} conflict(s) unresolved`}
        </span>
        {smart && smart.conflicts && (
          <span className="muted small" title={smart.tool}>
            Pre-merged by UnityYAMLMerge
          </span>
        )}
        {smartError && (
          <span className="muted small" title={smartError}>
            UnityYAMLMerge failed — line merge used
          </span>
        )}
        <span className="run-spacer" />
        <button className="btn small" onClick={() => acceptAll("ours")} disabled={!unresolved}>
          Accept Left
        </button>
        <button className="btn small" onClick={() => acceptAll("theirs")} disabled={!unresolved}>
          Accept Right
        </button>
        <button className="btn small primary" onClick={() => void apply()} disabled={!!error || loading}>
          Apply
        </button>
      </div>
      <div className="merge-labels">
        <div className="merge-label">{labels[0] + (smart?.conflicts ? " · pre-merged" : "")}</div>
        <div className="merge-label center">Result</div>
        <div className="merge-label">{labels[1] + (smart?.conflicts ? " · pre-merged" : "")}</div>
      </div>
      <div className="diff-host">
        <div ref={leftHost} className="diff-side" />
        <div ref={leftGutter} className="diff-lgutter" onMouseDown={(e) => e.preventDefault()} onClick={onGutter("ours")} />
        <div ref={leftGap} className="diff-gap merge-gap" style={{ width: GAP }} />
        <div ref={centerHost} className="diff-side" />
        <div ref={rightGap} className="diff-gap merge-gap" style={{ width: GAP }} />
        <div ref={rightGutter} className="diff-lgutter merge-rgutter" onMouseDown={(e) => e.preventDefault()} onClick={onGutter("theirs")} />
        <div ref={rightHost} className="diff-side" />
        <div ref={differL} className="diff-differ" aria-hidden />
        <div ref={differR} className="diff-differ" aria-hidden />
      </div>
    </div>
  );
}
