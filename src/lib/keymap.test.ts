import { describe, expect, it } from "vitest";
import { conflicts, keystrokeFromEvent, keystrokes, matchesKeystroke, resetKeystrokes, setKeystrokes } from "./keymap";

const press = (code: string, key: string, mods: Partial<Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>> = {}) =>
  ({ code, key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods }) as KeyboardEvent;

describe("keystrokeFromEvent", () => {
  it("names letters, digits, function and named keys by physical key", () => {
    expect(keystrokeFromEvent(press("KeyP", "π", { altKey: true }))).toBe("alt P");
    expect(keystrokeFromEvent(press("Digit1", "1", { metaKey: true, shiftKey: true }))).toBe("meta shift 1");
    expect(keystrokeFromEvent(press("F12", "F12", { ctrlKey: true }))).toBe("ctrl F12");
    expect(keystrokeFromEvent(press("Backquote", "`", { ctrlKey: true }))).toBe("ctrl BACK_QUOTE");
  });

  it("ignores lone modifiers", () => {
    expect(keystrokeFromEvent(press("ShiftLeft", "Shift", { shiftKey: true }))).toBeNull();
  });

  it("round-trips through matchesKeystroke", () => {
    const e = press("BracketLeft", "[", { metaKey: true, shiftKey: true });
    expect(matchesKeystroke(e, keystrokeFromEvent(e)!)).toBe(true);
  });
});

describe("overrides", () => {
  it("replace a command's shortcuts until reset", () => {
    const before = keystrokes("build");
    setKeystrokes("build", ["ctrl alt B"]);
    expect(keystrokes("build")).toEqual(["ctrl alt B"]);
    expect(conflicts("run", "ctrl alt B")).toEqual(["build"]);
    resetKeystrokes("build");
    expect(keystrokes("build")).toEqual(before);
  });
});
