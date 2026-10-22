// Fonts and sizes, in three groups: the Haze UI (menus, tool windows, Git,
// Commit, Project view…), code (editors, diffs) and the terminal. The terminal
// shares the code font family but has its own size, line height and renderer.
// Kept in localStorage like the theme, so the first paint already uses them.
import { create } from "zustand";

export interface FontSettings {
  uiFont: string;
  uiSize: number;
  codeFont: string;
  codeSize: number;
  terminalSize: number;
  terminalLineHeight: number;
  /**
   * Draw the terminal with WebGL; off uses xterm's DOM renderer (browser text).
   * Off by default: on macOS WebGL draws some glyphs, often accented ones,
   * lighter than their neighbours.
   */
  terminalWebgl: boolean;
}

const KEY = "haze.fonts";
export const DEFAULT_FONTS: FontSettings = {
  uiFont: "Inter",
  uiSize: 13,
  codeFont: "JetBrains Mono",
  codeSize: 13,
  terminalSize: 15,
  terminalLineHeight: 1.5,
  terminalWebgl: false,
};
export const MIN_SIZE = 8;
export const MAX_SIZE = 32;
export const MIN_LINE_HEIGHT = 1;
export const MAX_LINE_HEIGHT = 2;

const UI_FALLBACK = '-apple-system, "Segoe UI", system-ui, sans-serif';
const MONO_FALLBACK = '"Cascadia Mono", Menlo, Consolas, monospace';

/** Suggestions for the font pickers; any installed font name can be typed. */
export const UI_FONT_SUGGESTIONS = ["Inter", "Segoe UI", "SF Pro Text", "Helvetica Neue", "Arial", "Roboto", "Noto Sans", "Ubuntu"];
export const CODE_FONT_SUGGESTIONS = [
  "JetBrains Mono",
  "Cascadia Code",
  "Cascadia Mono",
  "Fira Code",
  "Consolas",
  "Menlo",
  "SF Mono",
  "Source Code Pro",
  "Hack",
  "Ubuntu Mono",
];

const clampSize = (n: number, fallback: number) => (Number.isFinite(n) ? Math.round(Math.min(MAX_SIZE, Math.max(MIN_SIZE, n))) : fallback);
const clampLineHeight = (n: number, fallback: number) =>
  Number.isFinite(n) ? Math.round(Math.min(MAX_LINE_HEIGHT, Math.max(MIN_LINE_HEIGHT, n)) * 100) / 100 : fallback;

function sanitize(s: Partial<FontSettings>): FontSettings {
  const d = DEFAULT_FONTS;
  const name = (v: unknown, fallback: string) => (typeof v === "string" && v.trim() ? v.trim() : fallback);
  return {
    uiFont: name(s.uiFont, d.uiFont),
    uiSize: clampSize(Number(s.uiSize), d.uiSize),
    codeFont: name(s.codeFont, d.codeFont),
    codeSize: clampSize(Number(s.codeSize), d.codeSize),
    terminalSize: clampSize(Number(s.terminalSize), d.terminalSize),
    terminalLineHeight: clampLineHeight(Number(s.terminalLineHeight), d.terminalLineHeight),
    terminalWebgl: typeof s.terminalWebgl === "boolean" ? s.terminalWebgl : d.terminalWebgl,
  };
}

function initial(): FontSettings {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) return sanitize(JSON.parse(saved));
  } catch {}
  return DEFAULT_FONTS;
}

export const useFonts = create<FontSettings>(() => initial());

const quote = (name: string) => `"${name.replace(/["\\]/g, "")}"`;
/** CSS font-family for the UI. */
export const uiFontFamily = (f: FontSettings = useFonts.getState()) => `${quote(f.uiFont)}, ${UI_FALLBACK}`;
/** CSS font-family for editors and terminals. */
export const codeFontFamily = (f: FontSettings = useFonts.getState()) => `${quote(f.codeFont)}, ${MONO_FALLBACK}`;
/** Editor line height for a font size: 20px at the default 13px. */
export const codeLineHeight = (size: number) => Math.round(size * 1.54);

function apply(f: FontSettings): void {
  const root = document.documentElement.style;
  root.setProperty("--font-ui", uiFontFamily(f));
  root.setProperty("--font-mono", codeFontFamily(f));
  root.setProperty("--ui-font-size", `${f.uiSize}px`);
}

apply(useFonts.getState());

export function setFonts(patch: Partial<FontSettings>): void {
  const next = sanitize({ ...useFonts.getState(), ...patch });
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {}
  apply(next);
  useFonts.setState(next);
}

export const resetFonts = () => setFonts(DEFAULT_FONTS);

/**
 * Editors and terminals measure glyphs when created or when the font changes;
 * resolves once the code font has loaded so they do not measure the fallback.
 */
export function loadCodeFont(f: FontSettings = useFonts.getState()): Promise<unknown> {
  return Promise.all(
    ["400", "italic 400", "700"].map((w) => document.fonts.load(`${w} ${f.codeSize}px ${codeFontFamily(f)}`)),
  ).catch(() => {});
}
