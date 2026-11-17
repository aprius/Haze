import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as { document?: unknown }).document ??= {
    documentElement: { dataset: {} },
  };
});

import { monacoTheme, TERMINAL_THEMES, terminalTheme, THEMES, useGlass, useTheme } from "./theme";

/** WCAG relative luminance for a `#rrggbb` (or `#rrggbbaa`) hex colour. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1, 7), 16);
  const chan = (shift: number) => {
    const s = ((n >> shift) & 0xff) / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * chan(16) + 0.7152 * chan(8) + 0.0722 * chan(0);
}

describe("monacoTheme", () => {
  it("maps every (theme, glass) combination to its Monaco theme name", () => {
    expect(monacoTheme("monokai-pro", false)).toBe("haze-dark");
    expect(monacoTheme("monokai-light", false)).toBe("haze-light");
    expect(monacoTheme("monokai-pro", true)).toBe("haze-dark-glass");
    expect(monacoTheme("monokai-light", true)).toBe("haze-light-glass");
    expect(monacoTheme("dracula-blade", false)).toBe("haze-dracula-blade");
    expect(monacoTheme("dracula-blade", true)).toBe("haze-dracula-blade-glass");
  });

  it("reads default arguments from useTheme and useGlass state", () => {
    useTheme.setState({ id: "monokai-light", mode: "light" });
    useGlass.setState({ on: true });
    expect(monacoTheme()).toBe("haze-light-glass");
    useGlass.setState({ on: false });
    expect(monacoTheme()).toBe("haze-light");
    useTheme.setState({ id: "monokai-pro", mode: "dark" });
    expect(monacoTheme()).toBe("haze-dark");
  });
});

describe("terminalTheme", () => {
  it("returns the opaque palettes when glass is false", () => {
    for (const { id } of THEMES) {
      expect(terminalTheme(id, false)).toBe(TERMINAL_THEMES[id]);
      expect(terminalTheme(id, false).background).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("uses an 8-digit transparent background whose RGB prefix matches the dark/light base in glass mode", () => {
    const darkGlass = terminalTheme("monokai-pro", true);
    const lightGlass = terminalTheme("monokai-light", true);

    expect(darkGlass.background).toMatch(/^#[0-9a-f]{6}00$/i);
    expect(lightGlass.background).toMatch(/^#[0-9a-f]{6}00$/i);

    // RGB prefix matches each theme's cursorAccent / base so xterm inverse-text
    // background extraction stays legible rather than collapsing to #000000.
    expect(darkGlass.background?.slice(0, 7)).toBe(TERMINAL_THEMES["monokai-pro"].background);
    expect(darkGlass.background?.slice(0, 7)).toBe(darkGlass.cursorAccent);
    expect(lightGlass.background?.slice(0, 7)).toBe(lightGlass.cursorAccent);
    expect(luminance(darkGlass.background!)).toBeLessThan(0.05);
    expect(luminance(lightGlass.background!)).toBeGreaterThan(0.85);
  });

  it("returns a dedicated light-glass palette with translucent selection and darker inks/accents", () => {
    const light = terminalTheme("monokai-light", false);
    const lightGlass = terminalTheme("monokai-light", true);

    expect(lightGlass).not.toBe(light);
    expect(lightGlass.selectionBackground).toMatch(/^#[0-9a-f]{8}$/i);

    const darkerKeys = [
      "foreground",
      "cursor",
      "black",
      "white",
      "brightBlack",
      "brightWhite",
      "red",
      "green",
      "yellow",
      "blue",
      "magenta",
      "cyan",
      "brightRed",
      "brightGreen",
      "brightYellow",
      "brightBlue",
      "brightMagenta",
      "brightCyan",
    ] as const;

    for (const key of darkerKeys) {
      expect(luminance(lightGlass[key]!), `${key} should be darker on light glass`).toBeLessThan(luminance(light[key]!));
    }
  });
});

describe("dracula-blade", () => {
  it("is a dark theme whose glass terminal keeps its own palette over a clear background", () => {
    const glass = terminalTheme("dracula-blade", true);
    expect(glass.background).toBe(TERMINAL_THEMES["dracula-blade"].background + "00");
    expect(glass.foreground).toBe(TERMINAL_THEMES["dracula-blade"].foreground);
    expect(luminance(glass.background!)).toBeLessThan(0.05);
  });
});
