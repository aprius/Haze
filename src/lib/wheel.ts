// Wheel scrolling like Zed: a mouse wheel moves one line per line it reports,
// a trackpad moves its pixels 1:1, and neither animates. Monaco scrolls 50px
// per wheel line (and a trackpad 1.25x) and eases each step, which in WebKit
// feels both too fast and laggy.
import { monaco } from "./monaco";

// WebKit reports a mouse wheel's lines as 40px each (Scrollbar::pixelsPerLineStep).
const PX_PER_LINE = 40;
// Zed's fast_scroll_sensitivity, applied while Alt is held.
const FAST = 4;

// The DOM does not say whether a wheel event came from a mouse or a trackpad,
// so this guesses as VS Code's MouseWheelClassifier does: deltas on both axes
// or fractional lines lean trackpad; whole lines that are multiples of the
// previous event's lean mouse. The last events weigh most.
const history: { x: number; y: number; score: number }[] = [];

const almostInt = (v: number) => Math.abs(Math.round(v) - v) < 0.01;

function isMouseWheel(x: number, y: number): boolean {
  const prev = history[history.length - 1];
  let score = 0.5;
  if (x && y) score = 1;
  else {
    if (!almostInt(x) || !almostInt(y)) score += 0.25;
    if (prev) {
      const [ax, ay, px, py] = [Math.abs(x), Math.abs(y), Math.abs(prev.x), Math.abs(prev.y)];
      const minX = Math.max(Math.min(ax, px), 1);
      const minY = Math.max(Math.min(ay, py), 1);
      if (Math.max(ax, px) % minX === 0 && Math.max(ay, py) % minY === 0) score -= 0.5;
    }
  }
  history.push({ x, y, score: Math.min(Math.max(score, 0), 1) });
  if (history.length > 5) history.shift();
  let total = 0;
  let remaining = 1;
  for (let i = history.length - 1; i >= 0; i--) {
    const influence = i === 0 ? remaining : 2 ** -(history.length - i);
    remaining -= influence;
    total += history[i].score * influence;
  }
  return total <= 0.5;
}

/**
 * How far a wheel event scrolls an editor with lines `lineHeight` tall, on
 * one axis at a time like Monaco's scrollPredominantAxis.
 */
function wheelDelta(e: WheelEvent, lineHeight: number): { dx: number; dy: number } {
  let { deltaX: dx, deltaY: dy } = e;
  if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    dx *= PX_PER_LINE;
    dy *= PX_PER_LINE;
  }
  if (isMouseWheel(dx / PX_PER_LINE, dy / PX_PER_LINE)) {
    dx = (dx / PX_PER_LINE) * lineHeight;
    dy = (dy / PX_PER_LINE) * lineHeight;
  }
  if (e.altKey) {
    dx *= FAST;
    dy *= FAST;
  }
  return Math.abs(dy) >= Math.abs(dx) ? { dx: 0, dy } : { dx, dy: 0 };
}

/** Scrolls `editor` by a wheel event, at once. */
export function wheelScroll(editor: monaco.editor.ICodeEditor, e: WheelEvent) {
  const { dx, dy } = wheelDelta(e, editor.getOption(monaco.editor.EditorOption.lineHeight));
  editor.setScrollPosition(
    { scrollTop: editor.getScrollTop() + dy, scrollLeft: editor.getScrollLeft() + dx },
    monaco.editor.ScrollType.Immediate,
  );
}

/** Takes over wheel scrolling of the editor's text area. */
export function zedWheel(editor: monaco.editor.ICodeEditor): monaco.IDisposable {
  const node = editor.getDomNode();
  if (!node) return { dispose() {} };
  const onWheel = (e: WheelEvent) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey) return;
    // Hovers, suggestions and other widgets scroll themselves.
    if ((e.target as Element | null)?.closest(".monaco-scrollable-element:not(.editor-scrollable)")) return;
    e.preventDefault();
    e.stopPropagation();
    wheelScroll(editor, e);
  };
  node.addEventListener("wheel", onWheel, { capture: true, passive: false });
  return { dispose: () => node.removeEventListener("wheel", onWheel, { capture: true }) };
}
