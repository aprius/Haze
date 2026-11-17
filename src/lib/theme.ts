// Colour theme. Each theme has a mode (dark or light) that the rest of the
// app keys off (<html data-theme>, file icons, COLORFGBG); the theme itself
// sets <html data-palette>, which src/styles.css overrides the colours by.
// Kept in localStorage rather than the workspace state file: that loads
// asynchronously, and the theme has to be known before the first paint.
import type { ITheme } from "@xterm/xterm";
import { create } from "zustand";

export type ThemeMode = "dark" | "light";
export type ThemeId = "monokai-pro" | "monokai-light" | "dracula-blade";

export const THEMES: { id: ThemeId; name: string; mode: ThemeMode }[] = [
  { id: "monokai-pro", name: "Monokai Pro", mode: "dark" },
  { id: "monokai-light", name: "Monokai Pro Light", mode: "light" },
  { id: "dracula-blade", name: "Dracula Pro Blade", mode: "dark" },
];

export const themeMode = (id: ThemeId): ThemeMode => THEMES.find((t) => t.id === id)?.mode ?? "dark";

const KEY = "haze.theme";
// The dark theme the light/dark toggle goes back to.
const DARK_KEY = "haze.theme.dark";

const isThemeId = (v: unknown): v is ThemeId => THEMES.some((t) => t.id === v);

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function initial(): ThemeId {
  const saved = read(KEY);
  if (isThemeId(saved)) return saved;
  // Before themes, only the mode was saved.
  if (saved === "light") return "monokai-light";
  return "monokai-pro";
}

const first = initial();
export const useTheme = create<{ id: ThemeId; mode: ThemeMode }>(() => ({ id: first, mode: themeMode(first) }));

/**
 * Islands over a background image (src/lib/backdrop.ts): editors and terminals
 * draw no background of their own, their island's glass shows through.
 */
export const useGlass = create<{ on: boolean }>(() => ({ on: false }));

const MONACO_NAMES: Record<ThemeId, string> = {
  "monokai-pro": "haze-dark",
  "monokai-light": "haze-light",
  "dracula-blade": "haze-dracula-blade",
};

export const monacoTheme = (id: ThemeId = useTheme.getState().id, glass = useGlass.getState().on) =>
  MONACO_NAMES[id] + (glass ? "-glass" : "");

export const TERMINAL_THEMES: Record<ThemeId, ITheme> = {
  // Monokai Pro (Filter: Pro), as its terminal themes ship it, but for the
  // default text (and plain white): #fcfcfa glares, as in the editor. The
  // background is the Project view's (--panel), not the editor's.
  "monokai-pro": {
    background: "#221f22",
    foreground: "#d3d1cf",
    cursor: "#d3d1cf",
    cursorAccent: "#221f22",
    selectionBackground: "#5b595c",
    black: "#403e41",
    red: "#ff6188",
    green: "#a9dc76",
    yellow: "#ffd866",
    blue: "#fc9867",
    magenta: "#ab9df2",
    cyan: "#78dce8",
    white: "#d3d1cf",
    brightBlack: "#727072",
    brightRed: "#ff6188",
    brightGreen: "#a9dc76",
    brightYellow: "#ffd866",
    brightBlue: "#fc9867",
    brightMagenta: "#ab9df2",
    brightCyan: "#78dce8",
    brightWhite: "#fcfcfa",
  },
  // Monokai Pro (Filter: Light), on the Project view's background too.
  "monokai-light": {
    background: "#ede7e5",
    foreground: "#29242a",
    cursor: "#29242a",
    cursorAccent: "#ede7e5",
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
  // Dracula Pro (Blade), on the Project view's background: the variant's
  // green-tinted greys, the accents Dracula Pro's. Black is the selection
  // grey, as the background itself would vanish; bright black (dim text and
  // borders of CLI agents) the comment colour.
  "dracula-blade": {
    background: "#1b2422",
    foreground: "#e8e8e2",
    cursor: "#f8f8f2",
    cursorAccent: "#1b2422",
    selectionBackground: "#415854",
    black: "#415854",
    red: "#ff9580",
    green: "#8aff80",
    yellow: "#ffff80",
    blue: "#9580ff",
    magenta: "#ff80bf",
    cyan: "#80ffea",
    white: "#e8e8e2",
    brightBlack: "#70a99f",
    brightRed: "#ffaa99",
    brightGreen: "#a2ff99",
    brightYellow: "#ffff99",
    brightBlue: "#aa99ff",
    brightMagenta: "#ff99cc",
    brightCyan: "#99ffee",
    brightWhite: "#ffffff",
  },
};

// Over a background image the light island is darker and uneven: deeper inks
// and ANSI greys (brightBlack is what CLI agents draw dim text and borders in)
// and a translucent selection keep the terminal legible on the glass.
const TERMINAL_LIGHT_GLASS: ITheme = {
  background: "#f8f3f100",
  foreground: "#1d191e",
  cursor: "#1d191e",
  cursorAccent: "#f8f3f1",
  selectionBackground: "#1d191e2e",
  black: "#1d191e",
  red: "#c92c5d",
  green: "#1b8254",
  yellow: "#a86000",
  blue: "#c74a1c",
  magenta: "#5c43ab",
  cyan: "#12748f",
  white: "#6e686b",
  brightBlack: "#5c5659",
  brightRed: "#c92c5d",
  brightGreen: "#1b8254",
  brightYellow: "#a86000",
  brightBlue: "#c74a1c",
  brightMagenta: "#5c43ab",
  brightCyan: "#12748f",
  brightWhite: "#1d191e",
};

// Glass: the background clear, but its colour kept, as xterm draws inverse
// text in it made opaque (black, from #00000000: unreadable in the light theme).
export function terminalTheme(id: ThemeId = useTheme.getState().id, glass = useGlass.getState().on): ITheme {
  const base = TERMINAL_THEMES[id];
  if (!glass) return base;
  return themeMode(id) === "light" ? TERMINAL_LIGHT_GLASS : { ...base, background: base.background + "00" };
}

function apply(id: ThemeId): void {
  document.documentElement.dataset.theme = themeMode(id);
  document.documentElement.dataset.palette = id;
}

apply(first);

export function setTheme(id: ThemeId): void {
  const mode = themeMode(id);
  try {
    localStorage.setItem(KEY, id);
    if (mode === "dark") localStorage.setItem(DARK_KEY, id);
  } catch {}
  apply(id);
  useTheme.setState({ id, mode });
}

/** Light goes to Monokai Pro Light, dark back to the last dark theme used. */
export function toggleThemeMode(): void {
  if (useTheme.getState().mode === "light") {
    const dark = read(DARK_KEY);
    setTheme(isThemeId(dark) && themeMode(dark) === "dark" ? dark : "monokai-pro");
  } else setTheme("monokai-light");
}

// Layout style: "classic" puts the panels edge to edge; "islands" draws each
// one (Project, editor, terminal, Build/Git) as a rounded block with gaps
// between them, and tabs as rounded chips. Only the
// shapes change, the colours stay the theme's.
export type UiStyle = "classic" | "islands";

const UI_STYLE_KEY = "haze.uiStyle";

function initialUiStyle(): UiStyle {
  try {
    const saved = localStorage.getItem(UI_STYLE_KEY);
    if (saved === "classic" || saved === "islands") return saved;
  } catch {}
  return "classic";
}

export const useUiStyle = create<{ style: UiStyle }>(() => ({ style: initialUiStyle() }));

document.documentElement.dataset.ui = useUiStyle.getState().style;

export function setUiStyle(style: UiStyle): void {
  try {
    localStorage.setItem(UI_STYLE_KEY, style);
  } catch {}
  document.documentElement.dataset.ui = style;
  useUiStyle.setState({ style });
}
