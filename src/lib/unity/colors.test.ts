import { describe, expect, it } from "vitest";
import { findColors, formatColor } from "./colors";

const one = (line: string) => {
  const hits = findColors(line);
  expect(hits).toHaveLength(1);
  return hits[0];
};
const text = (line: string, i = 0) => line.slice(findColors(line)[i].start, findColors(line)[i].end);

describe("findColors", () => {
  it("reads new Color with float literals", () => {
    const line = "var c = new Color(1f, 0.5f, 0);";
    const h = one(line);
    expect(text(line)).toBe("new Color(1f, 0.5f, 0)");
    expect(h.rgba).toEqual({ r: 1, g: 0.5, b: 0, a: 1 });
    expect(h.arity).toBe(3);
  });

  it("reads the alpha argument and a UnityEngine prefix", () => {
    const line = "x = new UnityEngine.Color(0, 0, 1, .25f);";
    expect(one(line).rgba).toEqual({ r: 0, g: 0, b: 1, a: 0.25 });
    expect(text(line)).toBe("new UnityEngine.Color(0, 0, 1, .25f)");
  });

  it("reads Color32 as bytes", () => {
    const h = one("new Color32(255, 128, 0, 51)");
    expect(h.kind).toBe("color32");
    expect(h.rgba.g).toBeCloseTo(128 / 255);
    expect(h.rgba.a).toBeCloseTo(0.2);
  });

  it("reads a target-typed new after a Color declaration", () => {
    const line = "        private static readonly Color WallShadow = new(0.05f, 0.04f, 0.2f);";
    const h = one(line);
    expect(text(line)).toBe("new(0.05f, 0.04f, 0.2f)");
    expect(h.typed).toBe(true);
    expect(h.rgba.b).toBeCloseTo(0.2);
    expect(one("Color32 c = new(255, 0, 0);").kind).toBe("color32");
    expect(one("public Color Tint => new(1, 1, 1, 0.5f);").rgba.a).toBe(0.5);
  });

  it("leaves a target-typed new alone when it is not a Color", () => {
    expect(findColors("Vector3 v = new(1f, 2f, 3f);")).toEqual([]);
    expect(findColors("Foo(new(1f, 2f, 3f));")).toEqual([]);
    expect(findColors("var c = new(1f, 2f, 3f);")).toEqual([]);
  });

  it("skips arguments that are not literals", () => {
    expect(findColors("new Color(r, g, b)")).toEqual([]);
    expect(findColors("new Color(1f, 0f, other.x)")).toEqual([]);
  });

  it("reads Unity's named colours", () => {
    expect(one("c = Color.red;").rgba).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(one("c = Color.clear;").rgba.a).toBe(0);
    expect(text("c = UnityEngine.Color.white;")).toBe("UnityEngine.Color.white");
  });

  it("ignores look-alikes", () => {
    expect(findColors("c = other.Color.red;")).toEqual([]);
    expect(findColors("c = MyColor.red;")).toEqual([]);
    expect(findColors("c = Color.redShift;")).toEqual([]);
    expect(findColors("c = Color.red.a;")).toEqual([]);
    expect(findColors("c = Color.Lerp(a, b, t);")).toEqual([]);
  });

  it("reads hex strings and rich text tags, digits only", () => {
    const line = 'ColorUtility.TryParseHtmlString("#FF8800", out c);';
    const h = one(line);
    expect(text(line)).toBe("FF8800");
    expect(h.upper).toBe(true);
    expect(h.rgba.r).toBe(1);

    const rich = 'Log("<color=#00ff0080>ok</color>");';
    const r = one(rich);
    expect(text(rich)).toBe("00ff0080");
    expect(r.rgba.a).toBeCloseTo(128 / 255);
  });

  it("does not take other strings for colours", () => {
    expect(findColors('var s = "#123";')).toEqual([]);
    expect(findColors('var s = "#ff0000 text";')).toEqual([]);
    expect(findColors("#region Foo")).toEqual([]);
  });

  it("finds several, in order", () => {
    const hits = findColors("a = Color.red; b = new Color(0, 1, 0);");
    expect(hits.map((h) => h.kind)).toEqual(["named", "color"]);
  });
});

describe("formatColor", () => {
  it("writes floats with an f suffix and trims them", () => {
    const h = one("new Color(1, 0, 0)");
    expect(formatColor(h, { r: 0.12345, g: 1, b: 0, a: 1 })).toBe("new Color(0.123f, 1f, 0f)");
  });

  it("adds an alpha argument only when needed or already there", () => {
    expect(formatColor(one("new Color(1, 0, 0)"), { r: 1, g: 0, b: 0, a: 0.5 })).toBe("new Color(1f, 0f, 0f, 0.5f)");
    expect(formatColor(one("new Color(1, 0, 0, 1)"), { r: 1, g: 0, b: 0, a: 1 })).toBe("new Color(1f, 0f, 0f, 1f)");
  });

  it("writes Color32 as bytes", () => {
    expect(formatColor(one("new Color32(0, 0, 0)"), { r: 1, g: 0.5, b: 0, a: 1 })).toBe("new Color32(255, 128, 0)");
    expect(formatColor(one("new Color32(0, 0, 0)"), { r: 0, g: 0, b: 0, a: 0 })).toBe("new Color32(0, 0, 0, 0)");
  });

  it("keeps a target-typed new target-typed", () => {
    const h = one("Color c = new(1, 0, 0);");
    expect(formatColor(h, { r: 0, g: 0, b: 1, a: 1 })).toBe("new(0f, 0f, 1f)");
    expect(formatColor(one("Color32 c = new(1, 0, 0);"), { r: 0, g: 0, b: 1, a: 0.5 })).toBe("new(0, 0, 255, 128)");
  });

  it("turns a named colour into new Color", () => {
    expect(formatColor(one("Color.red"), { r: 0, g: 0, b: 1, a: 1 })).toBe("new Color(0f, 0f, 1f)");
  });

  it("keeps a hex string's case and length", () => {
    expect(formatColor(one('"#FF8800"'), { r: 0, g: 1, b: 0, a: 1 })).toBe("00FF00");
    expect(formatColor(one('"#ff8800"'), { r: 0, g: 1, b: 0, a: 0.5 })).toBe("00ff0080");
    expect(formatColor(one('"#ff880080"'), { r: 0, g: 1, b: 0, a: 1 })).toBe("00ff00ff");
  });

  it("round-trips what it reads", () => {
    const h = one("new Color(0.25f, 0.5f, 0.75f)");
    const back = findColors(formatColor(h, h.rgba))[0];
    expect(back.rgba).toEqual(h.rgba);
  });
});
