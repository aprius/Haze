// App-wide shortcuts. On macOS they follow the "ReSharper (macOS)" Rider keymap
// as customised by the user (Alt+1, Alt+9, Alt+P, Cmd+. …); elsewhere the
// Windows Rider defaults Haze always had. A Haze key Rider leaves free is kept.
// Settings › Keymap overrides any command's shortcuts; overrides are kept in
// localStorage, like fonts, so the first keystroke already uses them.
import { create } from "zustand";

export const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);
export const isWindows = typeof navigator !== "undefined" && /Win/i.test(navigator.platform || navigator.userAgent);

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
  // Cmd+J like VS Code; Rider's "Open Claude in Terminal" (Alt+2, Cmd+Esc) also shows Haze's terminal, where agents run.
  terminal: { mac: ["meta J", "meta ctrl 1", "alt 2", "meta ESCAPE", "alt F12", "ctrl BACK_QUOTE"], other: ["alt F12", "ctrl BACK_QUOTE"] },
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
  // Project view. Most Mac keyboards have no forward Delete: Cmd+Backspace, as in Rider.
  delete: { mac: ["meta BACK_SPACE", "DELETE"], other: ["DELETE"] },
  copyContext: { mac: ["meta shift C"], other: ["ctrl shift C"] },
  zoomIn: { mac: ["meta EQUALS", "meta shift EQUALS", "meta NUMPAD_ADD"], other: ["ctrl EQUALS", "ctrl shift EQUALS", "ctrl NUMPAD_ADD"] },
  zoomOut: { mac: ["meta MINUS", "meta NUMPAD_SUBTRACT"], other: ["ctrl MINUS", "ctrl NUMPAD_SUBTRACT"] },
  resetZoom: { mac: ["meta 0", "meta NUMPAD0"], other: ["ctrl 0", "ctrl NUMPAD0"] },
} satisfies Record<string, { mac: Keystroke[]; other: Keystroke[] }>;

export type Command = keyof typeof app;

/** Names and groups for Settings › Keymap, in the order shown there. */
export const COMMANDS: { id: Command; name: string; group: string }[] = [
  { id: "searchEverywhere", name: "Search Everywhere", group: "Navigation" },
  { id: "gotoFile", name: "Go to File", group: "Navigation" },
  { id: "recentFiles", name: "Recent Files", group: "Navigation" },
  { id: "findAction", name: "Find Action", group: "Navigation" },
  { id: "findInFiles", name: "Find in Files", group: "Navigation" },
  { id: "replaceInFiles", name: "Replace in Files", group: "Navigation" },
  { id: "selectInProject", name: "Select Opened File in Project View", group: "Navigation" },
  { id: "nextTab", name: "Next Tab", group: "Navigation" },
  { id: "previousTab", name: "Previous Tab", group: "Navigation" },
  { id: "saveAll", name: "Save All", group: "Editing" },
  { id: "closeTab", name: "Close Tab", group: "Editing" },
  { id: "rename", name: "Rename", group: "Editing" },
  { id: "delete", name: "Delete (Project view)", group: "Editing" },
  { id: "copyContext", name: "Copy Context", group: "Editing" },
  { id: "projectView", name: "Project View", group: "Tool Windows" },
  { id: "terminal", name: "Terminal", group: "Tool Windows" },
  { id: "commitView", name: "Commit View", group: "Tool Windows" },
  { id: "gitView", name: "Git View", group: "Tool Windows" },
  { id: "settings", name: "Settings", group: "Tool Windows" },
  { id: "commit", name: "Commit", group: "Version Control" },
  { id: "push", name: "Push", group: "Version Control" },
  { id: "pull", name: "Pull", group: "Version Control" },
  { id: "updateProject", name: "Update Project", group: "Version Control" },
  { id: "branches", name: "Branches", group: "Version Control" },
  { id: "build", name: "Build", group: "Build and Run" },
  { id: "run", name: "Run", group: "Build and Run" },
  { id: "zoomIn", name: "Zoom In", group: "View" },
  { id: "zoomOut", name: "Zoom Out", group: "View" },
  { id: "resetZoom", name: "Reset Zoom", group: "View" },
];

const KEY = "haze.keymap";

/** The user's shortcuts for the commands they changed, for this platform. */
type Overrides = Partial<Record<Command, Keystroke[]>>;

function initial(): Overrides {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    const out: Overrides = {};
    for (const cmd of Object.keys(app) as Command[]) {
      const v = saved?.[cmd];
      if (Array.isArray(v) && v.every((k) => typeof k === "string")) out[cmd] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export const useKeymap = create<Overrides>(() => initial());

function save(next: Overrides): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {}
  useKeymap.setState(next, true);
}

export function defaultKeystrokes(cmd: Command): Keystroke[] {
  return isMac ? app[cmd].mac : app[cmd].other;
}

export function keystrokes(cmd: Command): Keystroke[] {
  return useKeymap.getState()[cmd] ?? defaultKeystrokes(cmd);
}

export function setKeystrokes(cmd: Command, list: Keystroke[]): void {
  const { [cmd]: _, ...rest } = useKeymap.getState();
  const same = list.length === defaultKeystrokes(cmd).length && list.every((k, i) => k === defaultKeystrokes(cmd)[i]);
  save(same ? rest : { ...rest, [cmd]: list });
}

/** Back to the default shortcuts: of one command, or of all of them. */
export function resetKeystrokes(cmd?: Command): void {
  if (!cmd) return save({});
  const { [cmd]: _, ...rest } = useKeymap.getState();
  save(rest);
}

/** The other commands a keystroke is bound to. */
export function conflicts(cmd: Command, ks: Keystroke): Command[] {
  const p = parse(ks);
  return COMMANDS.filter((c) => c.id !== cmd && keystrokes(c.id).some((k) => samePressed(parse(k), p))).map((c) => c.id);
}

const samePressed = (a: Parsed, b: Parsed) => a.ctrl === b.ctrl && a.meta === b.meta && a.alt === b.alt && a.shift === b.shift && a.code === b.code;

// While Settings › Keymap records a shortcut, no command runs on the keys pressed.
let recording = false;
export function setRecordingKeys(on: boolean): void {
  recording = on;
}
export const isRecordingKeys = () => recording;

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
  return !recording && keystrokes(cmd).some((ks) => matchesKeystroke(e, ks));
}

const codeNames = Object.fromEntries(Object.entries(named).map(([k, v]) => [v, k]));
const modifierKeys = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "Fn", "OS"]);

/** The keystroke a key press makes, e.g. "meta shift N"; null for a lone modifier or a key Haze cannot name. */
export function keystrokeFromEvent(e: KeyboardEvent): Keystroke | null {
  if (modifierKeys.has(e.key)) return null;
  const c = e.code;
  const key = /^Key[A-Z]$/.test(c) ? c.slice(3) : /^Digit\d$/.test(c) ? c.slice(5) : /^F\d{1,2}$/.test(c) ? c : /^Numpad\d$/.test(c) ? `NUMPAD${c.slice(6)}` : codeNames[c];
  if (!key) return null;
  const mods = [e.ctrlKey && "ctrl", e.metaKey && "meta", e.altKey && "alt", e.shiftKey && "shift"].filter(Boolean);
  return [...mods, key].join(" ");
}

const macLabel: Record<string, string> = { BACK_SPACE: "⌫", DELETE: "⌦" };

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
  return keystrokeLabel(ks);
}

export function keystrokeLabel(ks: Keystroke): string {
  const p = parse(ks);
  const raw = ks.split(" ").pop()!.toUpperCase();
  const key = (isMac ? macLabel[raw] : undefined) ?? label[raw] ?? (raw.length === 1 ? raw : raw.charAt(0) + raw.slice(1).toLowerCase().replace(/_(\w)/g, (_, c: string) => c.toUpperCase()));
  const keyText = /^F\d+$/i.test(raw) ? raw : key;
  if (isMac) return (p.ctrl ? "⌃" : "") + (p.alt ? "⌥" : "") + (p.shift ? "⇧" : "") + (p.meta ? "⌘" : "") + keyText;
  return [p.ctrl && "Ctrl", p.meta && "Win", p.alt && "Alt", p.shift && "Shift", keyText].filter(Boolean).join("+");
}
