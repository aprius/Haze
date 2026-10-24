// A splitter being dragged (Splitter in Shell.tsx). Terminals wait for the drop
// to fit their new size: each resize reflows the scrollback and makes the shell,
// or an agent's TUI, draw again.
let dragging = false;
const waiting = new Set<() => void>();

export const splitDragging = () => dragging;

/** Runs `fn` once the drag ends; the same function waits only once. */
export function afterSplitDrag(fn: () => void): void {
  waiting.add(fn);
}

export function setSplitDragging(on: boolean): void {
  dragging = on;
  if (on) return;
  const fns = [...waiting];
  waiting.clear();
  fns.forEach((fn) => fn());
}
