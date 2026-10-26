// Inline (ghost text) completions for C# from Roslyn's ordinary completion
// list: the rest of the best item for the word being typed. Kept free of
// Monaco so the choice can be tested.
import type { LspRange, LspTextEdit } from "./convert";

export interface LspCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: unknown;
  sortText?: string;
  filterText?: string;
  insertText?: string;
  insertTextFormat?: number;
  textEdit?: { range?: LspRange; insert?: LspRange; newText: string };
  additionalTextEdits?: LspTextEdit[];
  commitCharacters?: string[];
  preselect?: boolean;
}

/** Characters typed before ghost text is offered, so a single letter does not flash a guess. */
export const MIN_PREFIX = 2;

export interface InlinePick {
  item: LspCompletionItem;
  /** The whole word to put in place of the typed prefix. */
  text: string;
}

/**
 * The completion to show as ghost text after `prefix`, the part of the word
 * before the cursor on 0-based `line` from `start` to `end` (the cursor).
 * Only items that continue the prefix exactly (same case) and replace just
 * that word count; snippets with placeholders and multi-line inserts do not.
 * Roslyn's preselected item wins, then the lowest sort text.
 */
export function pickInline(items: readonly LspCompletionItem[], prefix: string, line: number, start: number, end: number): InlinePick | null {
  if (prefix.length < MIN_PREFIX) return null;
  let best: { item: LspCompletionItem; text: string } | null = null;
  for (const item of items) {
    const text = item.textEdit?.newText ?? item.insertText ?? item.label;
    if (text.length <= prefix.length || !text.startsWith(prefix) || !(item.filterText ?? item.label).startsWith(prefix)) continue;
    if (/[\r\n]/.test(text) || (item.insertTextFormat === 2 && /\$/.test(text))) continue;
    const r = item.textEdit?.range ?? item.textEdit?.insert;
    if (r && (r.start.line !== line || r.end.line !== line || r.start.character !== start || r.end.character !== end)) continue;
    if (!best || better(item, best.item)) best = { item, text };
  }
  return best;
}

/** Whether an edit is typing: each change puts in at most one character (a deletion included), unlike an accepted completion or a paste. */
export function typedEdit(changes: readonly { text: string }[]): boolean {
  return changes.every((c) => c.text.length <= 1);
}

function better(a: LspCompletionItem, b: LspCompletionItem): boolean {
  if (!!a.preselect !== !!b.preselect) return !!a.preselect;
  const ka = a.sortText ?? a.label;
  const kb = b.sortText ?? b.label;
  return ka !== kb ? ka < kb : a.label < b.label;
}
