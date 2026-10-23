// Search popups keep the caret in their search field (Search
// Everywhere and Find in Files): clicking a tab, a toggle, a checkbox or a
// result row acts without taking focus, so typing goes on refining the query.
import type React from "react";

/** `onMouseDown` for the popup: lets text fields, selects, the preview editor and scrollbars take the click as usual. */
export function keepSearchFocus(e: React.MouseEvent): void {
  const t = e.target as HTMLElement;
  if (t.closest("input:not([type=checkbox]), textarea, select, .monaco-editor")) return;
  // A scrollbar: dragging it needs the default.
  const { offsetX, offsetY } = e.nativeEvent;
  if ((t.scrollHeight > t.clientHeight && offsetX >= t.clientWidth) || (t.scrollWidth > t.clientWidth && offsetY >= t.clientHeight)) return;
  e.preventDefault();
}
