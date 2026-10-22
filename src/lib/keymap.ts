// App-wide shortcuts. On macOS they follow the "ReSharper (macOS)" Rider keymap
// as customised by the user (Alt+1, Alt+9, Alt+P, Cmd+. …); elsewhere the
// Windows Rider defaults Haze always had. A Haze key Rider leaves free is kept.

export const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);

/** IntelliJ keystroke syntax: modifiers then a key, e.g. "meta shift N", "alt F12", "ctrl BACK_QUOTE". */
type Keystroke = string;

const app = {
  searchEverywhere: { mac: ["meta N"], other: [] },
  gotoFile: { mac: ["meta shift N"], other: ["ctrl shift N"] },
  recentFiles: { mac: ["meta E"], other: ["ctrl E"] },
  findAction: { mac: ["meta shift A"], other: ["ctrl shift A"] },
  findInFiles: { mac: ["meta shift F"], other: ["ctrl shift F"] },
  replaceInFiles: { mac: ["meta shift H"], other: ["ctrl shift R"] },
  saveAll: { mac: ["meta S", "meta shift S"], other: ["ctrl S"] },
  settings: { mac: ["meta COMMA", "meta alt S"], other: ["ctrl alt S"] },
  closeTab: { mac: ["meta F4", "meta W"], other: ["ctrl F4"] },
  nextTab: { mac: ["ctrl TAB", "meta shift CLOSE_BRACKET"], other: ["ctrl TAB"] },
  previousTab: { mac: ["ctrl shift TAB", "meta shift OPEN_BRACKET"], other: ["ctrl shift TAB"] },
  selectInProject: { mac: ["alt F1"], other: ["alt F1"] },
  // Rider's "Open Claude in Terminal" (Alt+2, Cmd+Esc) shows Haze's terminal, where agents run.
  terminal: { mac: ["meta ctrl 1", "alt 2", "meta ESCAPE", "alt F12", "ctrl BACK_QUOTE"], other: ["alt F12", "ctrl BACK_QUOTE"] },
  projectView: { mac: ["alt 1"], other: ["alt 1"] },
  commitView: { mac: ["alt 0"], other: ["alt 0"] },
  gitView: { mac: ["alt 9"], other: ["alt 9"] },
  commit: { mac: ["meta K"], other: ["ctrl K"] },
  push: { mac: ["meta shift K"], other: ["ctrl shift K"] },
  pull: { mac: ["alt P"], other: [] },
  updateProject: { mac: ["meta alt W", "meta T"], other: ["ctrl T"] },
  branches: { mac: ["meta shift BACK_QUOTE"], other: ["ctrl shift BACK_QUOTE"] },
  build: { mac: ["meta shift B"], other: ["ctrl shift B"] },
  run: { mac: ["ctrl F5", "shift F10"], other: ["shift F10"] },
  rename: { mac: ["F2", "shift F6"], other: ["shift F6", "F2"] },
  copyContext: { mac: ["meta shift C"], other: ["ctrl shift C"] },
  zoomIn: { mac: ["meta EQUALS", "meta shift EQUALS", "meta NUMPAD_ADD"], other: ["ctrl EQUALS", "ctrl shift EQUALS", "ctrl NUMPAD_ADD"] },
  zoomOut: { mac: ["meta MINUS", "meta NUMPAD_SUBTRACT"], other: ["ctrl MINUS", "ctrl NUMPAD_SUBTRACT"] },
  resetZoom: { mac: ["meta 0", "meta NUMPAD0"], other: ["ctrl 0", "ctrl NUMPAD0"] },
} satisfies Record<string, { mac: Keystroke[]; other: Keystroke[] }>;

export type Command = keyof typeof app;

export function keystrokes(cmd: Command): Keystroke[] {
  return isMac ? app[cmd].mac : app[cmd].other;
}

interface Parsed {
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  /** KeyboardEvent.code, or KeyboardEvent.key for named keys. */
  code: string;
}

const named: Record<string, string> = {
  COMMA: "Comma",
  PERIOD: "Period",
  SLASH: "Slash",
  SEMICOLON: "Semicolon",
  QUOTE: "Quote",
  MINUS: "Minus",
  EQUALS: "Equal",
  BACK_QUOTE: "Backquote",
  OPEN_BRACKET: "BracketLeft",
  CLOSE_BRACKET: "BracketRight",
  BACK_SLASH: "Backslash",
  SPACE: "Space",
  ENTER: "Enter",
  ESCAPE: "Escape",
  TAB: "Tab",
  BACK_SPACE: "Backspace",
  DELETE: "Delete",
  INSERT: "Insert",
  HOME: "Home",
  END: "End",
  PAGE_UP: "PageUp",
  PAGE_DOWN: "PageDown",
  UP: "ArrowUp",
  DOWN: "ArrowDown",
  LEFT: "ArrowLeft",
  RIGHT: "ArrowRight",
  NUMPAD_ADD: "NumpadAdd",
  NUMPAD_SUBTRACT: "NumpadSubtract",
  NUMPAD0: "Numpad0",
};

const cache = new Map<Keystroke, Parsed>();
export function parse(ks: Keystroke): Parsed {
  let p = cache.get(ks);
  if (p) return p;
  const parts = ks.split(" ");
  const key = parts.pop()!.toUpperCase();
  const has = (m: string) => parts.some((x) => x.toLowerCase() === m || (m === "ctrl" && x.toLowerCase() === "control"));
  const code = /^[A-Z]$/.test(key) ? `Key${key}` : /^[0-9]$/.test(key) ? `Digit${key}` : (named[key] ?? key);
  p = { ctrl: has("ctrl"), meta: has("meta"), alt: has("alt"), shift: has("shift"), code };
  cache.set(ks, p);
  return p;
}

/**
 * Matches by physical key (`code`), so Alt+P still matches on macOS where the
 * event's `key` is "π", and Vietnamese or other layouts do not get in the way.
 */
export function matchesKeystroke(e: KeyboardEvent, ks: Keystroke): boolean {
  const p = parse(ks);
  if (e.ctrlKey !== p.ctrl || e.metaKey !== p.meta || e.altKey !== p.alt || e.shiftKey !== p.shift) return false;
  return e.code === p.code || e.key === p.code;
}

export function matches(e: KeyboardEvent, cmd: Command): boolean {
  return keystrokes(cmd).some((ks) => matchesKeystroke(e, ks));
}

const label: Record<string, string> = {
  COMMA: ",",
  PERIOD: ".",
  SLASH: "/",
  SEMICOLON: ";",
  BACK_QUOTE: "`",
  OPEN_BRACKET: "[",
  CLOSE_BRACKET: "]",
  ESCAPE: "Esc",
  BACK_SPACE: "Backspace",
  PAGE_UP: "PgUp",
  PAGE_DOWN: "PgDn",
  EQUALS: "=",
  MINUS: "-",
  UP: "↑",
  DOWN: "↓",
  LEFT: "←",
  RIGHT: "→",
};

/** How a command's first shortcut reads in menus and tooltips: "⌘⇧N" on macOS, "Ctrl+Shift+N" elsewhere. */
export function shortcutLabel(cmd: Command): string | undefined {
  const ks = keystrokes(cmd)[0];
  if (!ks) return cmd === "searchEverywhere" ? "Double Shift" : undefined;
  const p = parse(ks);
  const raw = ks.split(" ").pop()!.toUpperCase();
  const key = label[raw] ?? (raw.length === 1 ? raw : raw.charAt(0) + raw.slice(1).toLowerCase().replace(/_(\w)/g, (_, c: string) => c.toUpperCase()));
  const keyText = /^F\d+$/i.test(raw) ? raw : key;
  if (isMac) return (p.ctrl ? "⌃" : "") + (p.alt ? "⌥" : "") + (p.shift ? "⇧" : "") + (p.meta ? "⌘" : "") + keyText;
  return [p.ctrl && "Ctrl", p.alt && "Alt", p.shift && "Shift", keyText].filter(Boolean).join("+");
}
