// Monokai Pro colour mode (dark = "Pro" filter, light = "Light" filter).
// Kept in localStorage rather than the workspace state file: that loads
// asynchronously, and the mode has to be known before the first paint.
import type { ITheme } from "@xterm/xterm";
import { create } from "zustand";

export type ThemeMode = "dark" | "light";

const KEY = "haze.theme";

function initial(): ThemeMode {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "dark" || saved === "light") return saved;
  } catch {}
  return "dark";
}

export const useTheme = create<{ mode: ThemeMode }>(() => ({ mode: initial() }));

export const monacoTheme = (mode: ThemeMode = useTheme.getState().mode) => (mode === "dark" ? "haze-dark" : "haze-light");

export const TERMINAL_THEMES: Record<ThemeMode, ITheme> = {
  // Monokai Pro (Filter: Pro), as its terminal themes ship it.
  dark: {
    background: "#2d2a2e",
    foreground: "#fcfcfa",
    cursor: "#fcfcfa",
    cursorAccent: "#2d2a2e",
    selectionBackground: "#5b595c",
    black: "#403e41",
    red: "#ff6188",
    green: "#a9dc76",
    yellow: "#ffd866",
    blue: "#fc9867",
    magenta: "#ab9df2",
    cyan: "#78dce8",
    white: "#fcfcfa",
    brightBlack: "#727072",
    brightRed: "#ff6188",
    brightGreen: "#a9dc76",
    brightYellow: "#ffd866",
    brightBlue: "#fc9867",
    brightMagenta: "#ab9df2",
    brightCyan: "#78dce8",
    brightWhite: "#fcfcfa",
  },
  // Monokai Pro (Filter: Light).
  light: {
    background: "#faf4f2",
    foreground: "#29242a",
    cursor: "#29242a",
    cursorAccent: "#faf4f2",
    selectionBackground: "#d3cdcc",
    black: "#29242a",
    red: "#e14775",
    green: "#269d69",
    yellow: "#cc7a0a",
    blue: "#e16032",
    magenta: "#7058be",
    cyan: "#1c8ca8",
    white: "#a59fa0",
    brightBlack: "#918c8e",
    brightRed: "#e14775",
    brightGreen: "#269d69",
    brightYellow: "#cc7a0a",
    brightBlue: "#e16032",
    brightMagenta: "#7058be",
    brightCyan: "#1c8ca8",
    brightWhite: "#29242a",
  },
};

function apply(mode: ThemeMode): void {
  document.documentElement.dataset.theme = mode;
}

apply(useTheme.getState().mode);

export function setThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(KEY, mode);
  } catch {}
  apply(mode);
  useTheme.setState({ mode });
}

export function toggleThemeMode(): void {
  setThemeMode(useTheme.getState().mode === "dark" ? "light" : "dark");
}
