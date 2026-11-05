// Colours in Unity C#, for Monaco's colour picker (registered in monaco.ts).
// Kept free of Monaco so finding and writing them can be tested.
//
// Found, on one line:
//   new Color(r, g, b[, a])      float literals, 0..1
//   new Color32(r, g, b[, a])    integer literals, 0..255
//   Color.red, Color.clear ...   Unity's named colours (UnityEngine.Color too)
//   "#RRGGBB" / "#RRGGBBAA"      a whole string, as ColorUtility.TryParseHtmlString
//                                reads it, and <color=#RRGGBB> in rich text

export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** All four are 0..1. */
  a: number;
}

type Kind = "color" | "color32" | "named" | "hex";

export interface ColorHit {
  /** 0-based columns of the text to replace: [start, end). */
  start: number;
  end: number;
  rgba: Rgba;
  kind: Kind;
  /** Arguments written (3 or 4) for `color` and `color32`; hex digits (6 or 8) for `hex`. */
  arity: number;
  /** For `hex`: the digits had upper-case letters. */
  upper: boolean;
}

const NAMED: Record<string, [number, number, number, number]> = {
  red: [1, 0, 0, 1],
  green: [0, 1, 0, 1],
  blue: [0, 0, 1, 1],
  white: [1, 1, 1, 1],
  black: [0, 0, 0, 1],
  yellow: [1, 0.92156863, 0.015686275, 1],
  cyan: [0, 1, 1, 1],
  magenta: [1, 0, 1, 1],
  gray: [0.5, 0.5, 0.5, 1],
  grey: [0.5, 0.5, 0.5, 1],
  clear: [0, 0, 0, 0],
};

const NUM = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[fF]?`;
const ARGS = String.raw`\s*(${NUM})\s*,\s*(${NUM})\s*,\s*(${NUM})\s*(?:,\s*(${NUM})\s*)?`;
const CTOR = new RegExp(String.raw`(?<![\w.])new\s+(?:UnityEngine\.)?(Color32|Color)\s*\(${ARGS}\)`, "g");
const NAME = new RegExp(String.raw`(?<![\w.])(?:UnityEngine\.)?Color\.(${Object.keys(NAMED).join("|")})\b(?!\s*[(\w.])`, "g");
const HEX = /("#|<color=#)([0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?)(?=["<>])/g;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const num = (s: string) => Number.parseFloat(s.replace(/[fF]$/, ""));

/** Every colour on `line`, in order of appearance. */
export function findColors(line: string): ColorHit[] {
  const hits: ColorHit[] = [];
  const base = { upper: false };

  if (line.includes("new")) {
    for (const m of line.matchAll(CTOR)) {
      const wide = m[1] === "Color32";
      const arity = m[5] === undefined ? 3 : 4;
      const v = [m[2], m[3], m[4], m[5] ?? (wide ? "255" : "1")].map(num);
      if (v.some((n) => !Number.isFinite(n))) continue;
      const scale = wide ? 255 : 1;
      const [r, g, b, a] = v.map((n) => clamp(n / scale, 0, 1));
      hits.push({ ...base, start: m.index, end: m.index + m[0].length, rgba: { r, g, b, a }, kind: wide ? "color32" : "color", arity });
    }
  }

  if (line.includes("Color.")) {
    for (const m of line.matchAll(NAME)) {
      const [r, g, b, a] = NAMED[m[1]];
      hits.push({ ...base, start: m.index, end: m.index + m[0].length, rgba: { r, g, b, a }, kind: "named", arity: 3 });
    }
  }

  if (line.includes("#")) {
    for (const m of line.matchAll(HEX)) {
      const digits = m[2];
      const byte = (i: number) => Number.parseInt(digits.slice(i, i + 2), 16) / 255;
      const start = m.index + m[1].length;
      hits.push({
        start,
        end: start + digits.length,
        rgba: { r: byte(0), g: byte(2), b: byte(4), a: digits.length === 8 ? byte(6) : 1 },
        kind: "hex",
        arity: digits.length,
        upper: /[A-F]/.test(digits),
      });
    }
  }

  return hits.sort((x, y) => x.start - y.start);
}

/** A float as C# source: at most 3 decimals, `f` suffix (`0.5f`, `1f`). */
function floatLiteral(n: number): string {
  const s = String(Math.round(clamp(n, 0, 1) * 1000) / 1000);
  return s + "f";
}

const byte = (n: number) => Math.round(clamp(n, 0, 1) * 255);

/**
 * The text that stands for `rgba` in place of `hit`. A constructor keeps its
 * type and gets an alpha argument only when the colour is not opaque (or had
 * one); a named colour becomes `new Color(...)`; hex keeps its case and length.
 */
export function formatColor(hit: ColorHit, rgba: Rgba): string {
  const { r, g, b, a } = rgba;
  if (hit.kind === "hex") {
    const hex = (n: number) => byte(n).toString(16).padStart(2, "0");
    const out = hex(r) + hex(g) + hex(b) + (hit.arity === 8 || byte(a) !== 255 ? hex(a) : "");
    return hit.upper ? out.toUpperCase() : out;
  }
  if (hit.kind === "color32") {
    const args = [byte(r), byte(g), byte(b)];
    if (hit.arity === 4 || byte(a) !== 255) args.push(byte(a));
    return `new Color32(${args.join(", ")})`;
  }
  const args = [r, g, b].map(floatLiteral);
  if (hit.arity === 4 || Math.round(a * 1000) !== 1000) args.push(floatLiteral(a));
  return `new Color(${args.join(", ")})`;
}
