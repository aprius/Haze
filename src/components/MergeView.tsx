// Three-pane merge window (Yours | Result | Theirs) as an editor tab, opened
// for a conflicted file, working as IntelliJ's / Rider's (MergeThreesideViewer):
// the result starts as the base; every change either side made has » and × in
// the left side's gutter, « and × in the right side's: apply that side to the
// result, or ignore it. A conflict's first side replaces the block, the second
// is appended (Ctrl resolves it at once); the magic wand merges a simple
// conflict word by word. A handled side fades; a change is resolved once both
// sides are. Non-conflicting changes are applied from the toolbar, or on
// opening with auto-apply on. Unity scenes, prefabs and other Unity YAML go
// through UnityYAMLMerge first, as in Rider: the sides then hold its premerged
// versions, which differ only where it left conflicts.
import { ArrowLeftToLine, ArrowRightToLine, ChevronDown, ChevronsLeftRight, ChevronUp, WandSparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getModel, reloadBuffer } from "../lib/buffers";
import { connectorCurve, connectorPath, mapBoundary, type Chunk } from "../lib/diffLink";
import { api, errorMessage } from "../lib/ipc";
import {
  acceptState,
  applySide,
  autoState,
  changedOn,
  changedWords,
  changeKind,
  ignoreSide,
  initialMark,
  isResolved,
  pendingState,
  rewriteBlock,
  sideEnd,
  sideLines,
  sideStart,
  stateLines,
  type ChangeState,
  type MergeChange,
  type MergeModel,
  type ResultEdit,
  type Side,
} from "../lib/merge";
import MergeWorker from "../lib/merge.worker?worker";
import { codeFontOptions, languageFor, monaco, suggestOptions } from "../lib/monaco";
import { monacoTheme } from "../lib/theme";
import { basename } from "../lib/path";
import { mergePath, type MergeSpec } from "../lib/diffSpec";
import { wheelScroll, zedWheel } from "../lib/wheel";
import { absPath, refreshRepo, repo, runGit } from "../store/git";
import { useWorkspace, type Project } from "../store/workspace";
import { afterMergeApplied } from "./ConflictsDialog";
import { closeTabsWithPrompt } from "./EditorArea";
import { confirmAction, toast } from "./Overlays";

export { mergePath, mergeTitle, parseMergePath, type MergeSpec } from "../lib/diffSpec";

export function openMerge(projectId: string, spec: MergeSpec): void {
  useWorkspace.getState().openFile(projectId, mergePath(spec));
}

type Ed = monaco.editor.IStandaloneCodeEditor;

const ICON = 16;
const GAP = 24;
const SVG = (d: string) => `<svg viewBox="0 0 16 16" width="16" height="16"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const APPLY_RIGHT = SVG("M3.5 4.5 7 8l-3.5 3.5M8.5 4.5 12 8l-3.5 3.5");
const APPLY_LEFT = SVG("M12.5 4.5 9 8l3.5 3.5M7.5 4.5 4 8l3.5 3.5");
// A conflict with one side applied: the other side is appended below it.
const APPEND_RIGHT = SVG("M4 4l7.5 7.5M11.5 6v5.5H6");
const APPEND_LEFT = SVG("M12 4l-7.5 7.5M4.5 6v5.5H10");
const IGNORE = SVG("M4.5 4.5l7 7M11.5 4.5l-7 7");

// IntelliJ's "Automatically apply non-conflicting changes", off by default as there.
const AUTO_APPLY_KEY = "haze.merge.autoApplyNonConflicting";
const autoApplySetting = () => localStorage.getItem(AUTO_APPLY_KEY) === "1";

const rangeOf = (e: ResultEdit) => new monaco.Range(e.startLine, e.startColumn, e.endLine, e.endColumn);
const sameLines = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((l, i) => l === b[i]);
const stickiness = monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges;

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
  const panes = useRef<Panes | null>(null);
  // The changes, each one's state, and where it sits in the result (a tracked range).
  const changesRef = useRef<MergeChange[]>([]);
  const states = useRef<ChangeState[]>([]);
  const tracked = useRef<string[]>([]);
  // Whether each change holds no line in the result. Not read off its range:
  // a one-line block is marked from column 1 to column 1, an empty range too.
  const blockEmpty = useRef<boolean[]>([]);
  // Re-decorates and redraws after states change; set by the editors' effect.
  const refresh = useRef<() => void>(() => {});
  const [changes, setChanges] = useState<MergeChange[]>([]);
  const [, setVersion] = useState(0);
  const [current, setCurrent] = useState(-1);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [autoApply, setAutoApply] = useState(autoApplySetting);
  // UnityYAMLMerge ran (its path), or why it could not.
  const [smart, setSmart] = useState<{ tool: string; conflicts: boolean } | null>(null);
  const [smartError, setSmartError] = useState<string | null>(null);
  const operation = repo(project.id).branches?.operation ?? null;
  // During a rebase, stage 2 is the branch being rebased onto and stage 3 is your commit.
  const labels = operation === "rebase" ? ["Upstream (being rebased onto)", "Your commit"] : ["Yours (current branch)", "Theirs (incoming)"];

  /** Where change `i` is in the result, in line boundaries. */
  const resultSpan = (i: number): [number, number] => {
    const model = panes.current?.center.getModel();
    const r = model?.getDecorationRange(tracked.current[i]);
    if (!model || !r) return [0, 0];
    if (blockEmpty.current[i]) {
      const at = r.startColumn > 1 ? model.getLineCount() : r.startLineNumber - 1;
      return [at, at];
    }
    return [r.startLineNumber - 1, r.endLineNumber];
  };

  // Colour classes: red for a conflict not resolved yet, else the kind of
  // change against the base; faded once handled (IntelliJ's resolved highlighters).
  const sideClass = (c: MergeChange, side: Side) => {
    const s = states.current[c.id];
    return (c.conflict && !isResolved(s) ? "conflict" : changeKind(c, side)) + (s[side] !== "pending" ? " rd-accepted" : "");
  };
  const resultClass = (c: MergeChange) => {
    const s = states.current[c.id];
    return (c.conflict && !isResolved(s) ? "conflict" : changeKind(c, c.oursChanged ? "ours" : "theirs")) + (isResolved(s) ? " rd-accepted" : "");
  };
  const classes = (kind: string) =>
    kind
      .split(" ")
      .map((k) => `rd-${k}`)
      .join(" ");

  useEffect(() => {
    const hosts = [leftHost, centerHost, rightHost, leftGutter, rightGutter, leftGap, rightGap].map((r) => r.current);
    if (hosts.some((h) => !h)) return;
    const [lh, ch, rh, lgEl, rgEl, lgapEl, rgapEl] = hosts as HTMLDivElement[];
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
    // The result's glyph margin holds the magic wand of simple conflicts.
    const center = monaco.editor.create(ch, { ...opts(false), glyphMargin: true });
    const right = side(rh);
    const all = [left, center, right];
    panes.current = { left, center, right };
    const decos = all.map((ed) => ed.createDecorationsCollection());
    // Word highlights of each side, worked out once: the sides and the base do not change.
    const words = new Map<string, monaco.editor.IModelDeltaDecoration[]>();
    // Magic wand decorations → the change they belong to.
    let wands = new Map<string, number>();

    // Each side's changes against the result, for scrolling in step and the
    // connectors: recomputed after the result changes.
    let chunks: { ours: Chunk[]; theirs: Chunk[] } | null = null;
    const chunksOf = () => {
      if (!chunks) {
        const spans = changesRef.current.map((c) => resultSpan(c.id));
        chunks = {
          ours: changesRef.current.map((c, i) => ({ a0: c.oursStart, a1: c.oursEnd, b0: spans[i][0], b1: spans[i][1] })),
          theirs: changesRef.current.map((c, i) => ({ a0: spans[i][0], a1: spans[i][1], b0: c.theirsStart, b1: c.theirsEnd })),
        };
      }
      return chunks;
    };

    let frame = 0;
    // A side's gutter, mirrored for the left one: band tints and edges, » × on
    // each change it made that is still open, and line numbers against the gap.
    // Only what is in view is drawn: changes are in line order, so a binary search finds the first.
    const drawGutter = (el: HTMLDivElement, ed: Ed, which: Side) => {
      const model = ed.getModel();
      if (!model) return void (el.innerHTML = "");
      const line = ed.getOption(monaco.editor.EditorOption.lineHeight);
      const font = ed.getOption(monaco.editor.EditorOption.fontInfo);
      const height = el.clientHeight;
      const digits = Math.max(2, String(model.getLineCount()).length);
      const width = `${Math.ceil(2 * ICON + 2 + 6 + digits * font.typicalHalfwidthCharacterWidth + 8)}px`;
      if (el.style.width !== width) el.style.width = width;
      Object.assign(el.style, { fontFamily: font.fontFamily, fontSize: `${font.fontSize}px`, lineHeight: `${line}px` });
      const list = changesRef.current;
      const [top, bottom] = shown(ed);
      const pos = (n: number) => (which === "ours" ? `left:${n}px` : `left:auto;right:${n}px`);
      const name = which === "ours" ? "left" : "right";
      let html = "";
      for (let i = firstEndingFrom(list.length, (j) => sideEnd(list[j], which), top); i < list.length && sideStart(list[i], which) <= bottom; i++) {
        const c = list[i];
        if (!changedOn(c, which)) continue;
        const s0 = sideStart(c, which);
        const s1 = sideEnd(c, which);
        const cls = classes(sideClass(c, which));
        const y0 = boundaryY(ed, s0);
        const y1 = boundaryY(ed, s1);
        if (y1 < -line || y0 > height + line) continue;
        if (s0 < s1) {
          html += `<div class="rd-gl-band rd-line ${cls}" style="top:${y0}px;height:${y1 - y0}px"></div>`;
          html += `<div class="rd-gl-edge ${cls}" style="top:${y0}px"></div><div class="rd-gl-edge ${cls}" style="top:${y1 - 1}px"></div>`;
        } else {
          html += `<div class="rd-gl-edge ${cls}" style="top:${s0 > 0 ? y0 - 1 : y0}px"></div>`;
        }
        const s = states.current[c.id];
        if (s[which] !== "pending") continue;
        const y = boundaryY(ed, Math.min(s0 + 1, model.getLineCount()) - 1) + (line - ICON) / 2;
        const icon = s.oneside ? (which === "ours" ? APPEND_RIGHT : APPEND_LEFT) : which === "ours" ? APPLY_RIGHT : APPLY_LEFT;
        const applyTitle = s.oneside ? `Append ${name} side` : c.conflict ? `Apply ${name} side (Ctrl+click: and resolve the conflict)` : `Apply ${name} side`;
        const ignoreTitle = c.conflict ? `Ignore ${name} side (Ctrl+click: and resolve the conflict)` : "Ignore";
        html +=
          `<button class="rd-apply" data-id="${c.id}" data-act="apply" title="${applyTitle}" style="top:${y}px;${pos(3)}">${icon}</button>` +
          `<button class="rd-apply" data-id="${c.id}" data-act="ignore" title="${ignoreTitle}" style="top:${y}px;${pos(ICON + 5)}">${IGNORE}</button>`;
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
    // Connectors between each change a side made and its block in the result.
    const drawGap = (el: HTMLDivElement, which: Side) => {
      const [a, b] = which === "ours" ? [left, center] : [center, right];
      const list = which === "ours" ? chunksOf().ours : chunksOf().theirs;
      const width = el.clientWidth;
      const height = el.clientHeight;
      let paths = "";
      const [aTop, aBottom] = shown(a);
      const [bTop, bBottom] = shown(b);
      // A link is in view while either end is; one going from above to below starts before both.
      const from = Math.min(firstEndingFrom(list.length, (j) => list[j].a1, aTop), firstEndingFrom(list.length, (j) => list[j].b1, bTop));
      for (let i = from; i < list.length && (list[i].a0 <= aBottom || list[i].b0 <= bBottom); i++) {
        const change = changesRef.current[i];
        if (!changedOn(change, which)) continue;
        const c = list[i];
        const l0 = boundaryY(a, c.a0);
        const l1 = boundaryY(a, c.a1);
        const r0 = boundaryY(b, c.b0);
        const r1 = boundaryY(b, c.b1);
        if (Math.max(l1, r1) < 0 || Math.min(l0, r0) > height) continue;
        const k = classes(sideClass(change, which));
        // Borders sit half a pixel inside the band to line up with the 1px edges drawn in the editors.
        const edge = (y0: number, y1: number, s: number): [number, number] => (y0 === y1 ? (s > 0 ? [y0 - 0.5, y0 - 0.5] : [y0 + 0.5, y0 + 0.5]) : [y0 + 0.5, y1 - 0.5]);
        const [lt, lb] = edge(l0, l1, c.a0);
        const [rt, rb] = edge(r0, r1, c.b0);
        paths +=
          `<path class="rd-link ${k}" d="${connectorPath(width, l0, l1, r0, r1)}"/>` +
          `<path class="rd-edge ${k}" d="${connectorCurve(width, lt, rt)} ${connectorCurve(width, lb, rb)}"/>`;
      }
      el.innerHTML = `<svg width="${width}" height="${height}">${paths}</svg>`;
    };
    const draw = () => {
      frame = 0;
      drawGutter(lgEl, left, "ours");
      drawGutter(rgEl, right, "theirs");
      drawGap(lgapEl, "ours");
      drawGap(rgapEl, "theirs");
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
      const { ours, theirs } = chunksOf();
      const mid = from.getLayoutInfo().height / 2;
      if (from === left) align(center, mapBoundary(ours, boundaryAt(left, mid), true), mid);
      if (from === right) align(center, mapBoundary(theirs, boundaryAt(right, mid), false), mid);
      const x = boundaryAt(center, mid);
      if (from !== left) align(left, mapBoundary(ours, x, false), mid);
      if (from !== right) align(right, mapBoundary(theirs, x, true), mid);
      syncing = false;
    };

    // Highlights from the changes (not a live diff): each side's block, the
    // result's block, word highlights on sides still open, and the magic wand.
    const update = () => {
      chunks = null;
      const whole = (from: number, to: number, cls: string): monaco.editor.IModelDeltaDecoration => ({
        range: new monaco.Range(from, 1, to, 1),
        options: { isWholeLine: true, className: cls, marginClassName: cls },
      });
      const lineDeco = (ed: Ed, kind: string, s: number, e: number): monaco.editor.IModelDeltaDecoration[] => {
        const cls = classes(kind);
        if (s < e) {
          const text = { range: new monaco.Range(s + 1, 1, e, ed.getModel()?.getLineMaxColumn(e) ?? 1), options: { inlineClassName: "rd-text" } };
          return [whole(s + 1, e, `rd-line ${cls}`), whole(s + 1, s + 1, `rd-top ${cls}`), whole(e, e, `rd-bottom ${cls}`), text];
        }
        // Empty side: a thin line where the other side's block belongs.
        const lines = ed.getModel()?.getLineCount() ?? 1;
        return s >= 1 ? [whole(Math.min(s, lines), Math.min(s, lines), `rd-bottom ${cls}`)] : [whole(1, 1, `rd-top ${cls}`)];
      };
      const wordDecos = (c: MergeChange, which: Side) => {
        const key = `${which}:${c.id}`;
        let d = words.get(key);
        if (!d) {
          d = changedWords(sideLines(c, which), c.base).map((w) => {
            const line = sideStart(c, which) + w.line;
            return { range: new monaco.Range(line, w.start, line, w.end), options: { inlineClassName: "rd-char" } };
          });
          words.set(key, d);
        }
        return d;
      };
      const l: monaco.editor.IModelDeltaDecoration[] = [];
      const m: monaco.editor.IModelDeltaDecoration[] = [];
      const r: monaco.editor.IModelDeltaDecoration[] = [];
      const wandOf: number[] = [];
      for (const c of changesRef.current) {
        const s = states.current[c.id];
        for (const [which, out, ed] of [["ours", l, left], ["theirs", r, right]] as const) {
          if (!changedOn(c, which)) continue;
          for (const d of lineDeco(ed, sideClass(c, which), sideStart(c, which), sideEnd(c, which))) out.push(d);
          if (s[which] === "pending" && changeKind(c, which) === "modified") for (const d of wordDecos(c, which)) out.push(d);
        }
        const [b0, b1] = resultSpan(c.id);
        for (const d of lineDeco(center, resultClass(c), b0, b1)) m.push(d);
        if (c.autoResolved && s.ours === "pending" && s.theirs === "pending") {
          const at = Math.min(b0 + 1, center.getModel()?.getLineCount() ?? 1);
          m.push({ range: new monaco.Range(at, 1, at, 1), options: { glyphMarginClassName: "merge-wand", glyphMarginHoverMessage: { value: "Resolve simple conflict (the sides changed different words)" } } });
          wandOf.push(c.id);
        }
      }
      decos[0].set(l);
      decos[2].set(r);
      const ids = decos[1].set(m);
      // The wand decorations are the glyph ones, in order.
      wands = new Map();
      let w = 0;
      m.forEach((d, i) => d.options.glyphMarginClassName && wands.set(ids[i], wandOf[w++]));
      redraw();
    };
    refresh.current = update;

    // The magic wand: a click on it in the result's glyph margin.
    const wandClick = center.onMouseDown((e) => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
      const line = e.target.position?.lineNumber;
      const model = center.getModel();
      if (!line || !model) return;
      const id = model
        .getLineDecorations(line)
        .map((d) => wands.get(d.id))
        .find((x) => x !== undefined);
      if (id !== undefined) resolveAutoRef.current(id);
    });

    // Wheel scrolling like the code editor's; over a gutter or a gap it scrolls the result.
    const wheels = all.map(zedWheel);
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      wheelScroll(center, e);
    };
    const wheelHosts = [lgEl, rgEl, lgapEl, rgapEl];
    wheelHosts.forEach((h) => h.addEventListener("wheel", wheel, { passive: false }));
    // F7 / Shift+F7: next / previous change still open, as in IntelliJ.
    for (const ed of all) {
      ed.addCommand(monaco.KeyCode.F7, () => stepRef.current(1));
      ed.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F7, () => stepRef.current(-1));
    }

    const subs = [
      ...all.map((ed) => ed.onDidScrollChange(follow(ed))),
      ...all.map((ed) => ed.onDidLayoutChange(redraw)),
      left.onDidChangeCursorPosition(redraw),
      right.onDidChangeCursorPosition(redraw),
      // Typing in the result moves the blocks below.
      center.onDidChangeModelContent(() => {
        chunks = null;
        redraw();
      }),
      wandClick,
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
          model = { eol: "\n", result: unity.mine, changes: [] };
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
        const result = mkModel(model.result);
        const lines = result.getLinesContent();
        tracked.current = result.deltaDecorations(
          [],
          model.changes.map((c) => {
            const r = initialMark(c, lines);
            return { range: new monaco.Range(r.startLine, r.startColumn, r.endLine, r.endColumn), options: { stickiness } };
          }),
        );
        changesRef.current = model.changes;
        states.current = model.changes.map(pendingState);
        blockEmpty.current = model.changes.map((c) => c.base.length === 0);
        left.setModel(mkModel(leftText));
        center.setModel(result);
        right.setModel(mkModel(rightText));
        setChanges(model.changes);
        setLoading(false);
        if (autoApplySetting()) applyNonConflictingRef.current(null);
        update();
        // Start at the first conflict, else the first change.
        if (model.changes.length) revealRef.current(Math.max(0, model.changes.findIndex((c) => c.conflict)));
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
      all.forEach((ed) => ed.dispose());
      owned.forEach((m) => m.dispose());
      panes.current = null;
      refresh.current = () => {};
    };
  }, [spec.root, spec.rel]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Scrolls the result to change `i`; the sides follow. */
  function reveal(i: number) {
    const p = panes.current;
    if (!p || i < 0 || i >= changesRef.current.length) return;
    setCurrent(i);
    const [b0, b1] = resultSpan(i);
    p.center.revealLinesInCenter(b0 + 1, Math.max(b0 + 1, b1));
  }

  /**
   * Puts change `c` in state `next`: rewrites its lines in the result when
   * they change. In a batch the caller re-decorates once at the end.
   */
  function setChangeState(c: MergeChange, next: ChangeState, inBatch = false) {
    const p = panes.current;
    const model = p?.center.getModel();
    const prev = states.current[c.id];
    if (!p || !model || prev === next) return;
    const r = model.getDecorationRange(tracked.current[c.id]);
    if (!r) return;
    const lines = stateLines(c, next);
    if (!sameLines(stateLines(c, prev), lines)) {
      // Lines typed into the block by hand are part of it too: its range says how many.
      const mark = { startLine: r.startLineNumber, startColumn: r.startColumn, endLine: r.endLineNumber, empty: blockEmpty.current[c.id] };
      const { edit, mark: after } = rewriteBlock(mark, lines, model.getLinesContent(), model.getEOL());
      p.center.executeEdits("merge", [{ range: rangeOf(edit), text: edit.text }]);
      const range = new monaco.Range(after.startLine, after.startColumn, after.endLine, after.endColumn);
      [tracked.current[c.id]] = model.deltaDecorations([tracked.current[c.id]], [{ range, options: { stickiness } }]);
      blockEmpty.current[c.id] = after.empty;
    }
    states.current[c.id] = next;
    if (inBatch) return;
    refresh.current();
    setVersion((v) => v + 1);
  }

  /** Several changes at once: one undo step, one redraw. */
  function batch(each: (c: MergeChange, s: ChangeState) => ChangeState | null) {
    const center = panes.current?.center;
    center?.pushUndoStop();
    for (const c of changesRef.current) {
      const next = each(c, states.current[c.id]);
      if (next) setChangeState(c, next, true);
    }
    center?.pushUndoStop();
    refresh.current();
    setVersion((v) => v + 1);
  }

  /** Whether change `c`'s block in the result still holds what its state put there (not edited by hand). */
  function isPristine(c: MergeChange): boolean {
    const model = panes.current?.center.getModel();
    if (!model) return false;
    const [b0, b1] = resultSpan(c.id);
    return sameLines(b0 === b1 ? [] : model.getLinesContent().slice(b0, b1), stateLines(c, states.current[c.id]));
  }

  /** Apply non-conflicting changes from one side (null: from whichever side made each). */
  function applyNonConflicting(side: Side | null) {
    batch((c, s) => {
      if (c.conflict || isResolved(s)) return null;
      const from = side ?? (c.oursChanged ? "ours" : "theirs");
      return changedOn(c, from) ? applySide(c, s, from) : null;
    });
  }

  /** The magic wand of one conflict, while its block still holds the base. */
  function resolveAuto(id: number) {
    const c = changesRef.current[id];
    const next = c && autoState(c);
    if (next && isPristine(c)) setChangeState(c, next);
  }

  const open = (c: MergeChange) => !isResolved(states.current[c.id]);
  const untouched = (s: ChangeState) => s.ours === "pending" && s.theirs === "pending";
  const step = (dir: 1 | -1) => {
    const list = changesRef.current;
    for (let k = 1; k <= list.length; k++) {
      const from = current < 0 ? (dir > 0 ? -1 : list.length) : current;
      const i = (((from + dir * k) % list.length) + list.length) % list.length;
      if (open(list[i])) return reveal(i);
    }
  };

  // The editors' effect calls these: kept current.
  const revealRef = useRef(reveal);
  revealRef.current = reveal;
  const applyNonConflictingRef = useRef(applyNonConflicting);
  applyNonConflictingRef.current = applyNonConflicting;
  const resolveAutoRef = useRef(resolveAuto);
  resolveAutoRef.current = resolveAuto;
  const stepRef = useRef(step);
  stepRef.current = step;

  const onGutter = (side: Side) => (e: React.MouseEvent) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    const c = b && changesRef.current[Number(b.dataset.id)];
    if (!b || !c) return;
    // Ctrl (Cmd on macOS) resolves the whole conflict, as IntelliJ's Ctrl+click.
    const resolveAll = e.ctrlKey || e.metaKey;
    const s = states.current[c.id];
    setChangeState(c, b.dataset.act === "apply" ? applySide(c, s, side, resolveAll) : ignoreSide(c, s, side, resolveAll));
  };

  const openChanges = changes.filter(open);
  const openConflicts = openChanges.filter((c) => c.conflict).length;
  const openNonConflicting = openChanges.length - openConflicts;
  const simple = openChanges.filter((c) => c.autoResolved && untouched(states.current[c.id])).length;

  const apply = async () => {
    const model = panes.current?.center.getModel();
    if (!model) return;
    if (openChanges.length && !(await confirmAction("Apply Merge", `${openChanges.length} change(s) are not processed (${openConflicts} conflict(s)); the result keeps the base there. Apply anyway?`, "Apply"))) return;
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
      // As in Rider: back to the Conflicts list, which offers to finish once none are left.
      afterMergeApplied(project.id);
    } catch (e) {
      toast(`Could not apply: ${errorMessage(e)}`, "error");
    }
  };

  // Accept Left / Right (IntelliJ's handleAcceptSide): every change as that side has it.
  const acceptAll = async (side: Side) => {
    const touched = changesRef.current.some((c) => !untouched(states.current[c.id]));
    if (touched && !(await confirmAction(`Accept ${side === "ours" ? "Left" : "Right"}`, "Changes you already resolved are replaced too.", "Accept"))) return;
    batch((c) => acceptState(c, side));
  };

  const toggleAutoApply = () => {
    const on = !autoApply;
    localStorage.setItem(AUTO_APPLY_KEY, on ? "1" : "0");
    setAutoApply(on);
    if (on) applyNonConflicting(null);
  };

  const status = error
    ? error
    : loading
      ? "Computing merge…"
      : changes.length === 0
        ? smart
          ? "No conflicts left — merged by UnityYAMLMerge. Apply to finish."
          : "No changes to merge."
        : openChanges.length === 0
          ? "All changes have been processed — Apply to finish."
          : `${openChanges.length} change(s) left, ${openConflicts} conflict(s)`;

  return (
    <div className="merge-view">
      {/* Clicks keep focus in the editors. */}
      <div className="diff-toolbar" onMouseDown={(e) => (e.target as HTMLElement).closest("button") && e.preventDefault()}>
        <button className="icon-btn" title="Previous change (Shift+F7)" onClick={() => step(-1)}>
          <ChevronUp size={16} />
        </button>
        <button className="icon-btn" title="Next change (F7)" onClick={() => step(1)}>
          <ChevronDown size={16} />
        </button>
        <button className="icon-btn" title="Apply non-conflicting changes from the left side" disabled={!openNonConflicting} onClick={() => applyNonConflicting("ours")}>
          <ArrowRightToLine size={16} />
        </button>
        <button className="icon-btn" title="Apply all non-conflicting changes" disabled={!openNonConflicting} onClick={() => applyNonConflicting(null)}>
          <ChevronsLeftRight size={16} />
        </button>
        <button className="icon-btn" title="Apply non-conflicting changes from the right side" disabled={!openNonConflicting} onClick={() => applyNonConflicting("theirs")}>
          <ArrowLeftToLine size={16} />
        </button>
        <button className="icon-btn" title="Resolve simple conflicts (the sides changed different words)" disabled={!simple} onClick={() => batch((c, s) => (untouched(s) && isPristine(c) ? autoState(c) : null))}>
          <WandSparkles size={16} />
        </button>
        <label className="merge-auto small muted" title="Apply non-conflicting changes when a merge opens (IntelliJ's setting, off by default)">
          <input type="checkbox" checked={autoApply} onChange={toggleAutoApply} /> Auto-apply non-conflicting
        </label>
        <span className={"small merge-status " + (openConflicts && !loading ? "error" : "muted")}>{status}</span>
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
        <button className="btn small" onClick={() => void acceptAll("ours")} disabled={loading || !changes.length}>
          Accept Left
        </button>
        <button className="btn small" onClick={() => void acceptAll("theirs")} disabled={loading || !changes.length}>
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
      </div>
    </div>
  );
}
