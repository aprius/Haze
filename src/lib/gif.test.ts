import { describe, expect, it } from "vitest";
import { decodeFrame, GifComposer, parseGif, type Gif } from "./gif";
// Made by Pillow, 40×24: three frames (50/120/0 ms, disposal 1/2/1, index 255
// transparent), and one interlaced frame (Pillow interlaces no animation); with
// each frame as Pillow composes it.
import fixtures from "./gif.fixtures.json";

const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** Each frame as GifComposer composes it. */
function compose(gif: Gif): Uint8ClampedArray[] {
  const c = new GifComposer(gif);
  return gif.frames.map(() => (c.step(), c.pixels.slice()));
}

describe("gif", () => {
  for (const [name, fx] of Object.entries(fixtures)) {
    it(`reads the ${name} file's structure`, () => {
      const gif = parseGif(bytes(fx.gif));
      expect([gif.width, gif.height, gif.frames.length]).toEqual([40, 24, fx.delays.length]);
      expect(gif.frames.map((f) => f.delay)).toEqual(fx.delays);
      expect(gif.frames[0].interlaced).toBe(name === "interlaced");
    });

    it(`decodes the ${name} first frame's indices`, () => {
      const f = parseGif(bytes(fx.gif)).frames[0];
      expect([f.left, f.top, f.width, f.height]).toEqual([0, 0, 40, 24]);
      expect(Array.from(decodeFrame(f))).toEqual(Array.from(bytes(fx.first)));
    });

    it(`composes the ${name} frames as Pillow does`, () => {
      const got = compose(parseGif(bytes(fx.gif)));
      expect(got.length).toBe(fx.rgba.length);
      got.forEach((frame, i) => expect(Array.from(frame)).toEqual(Array.from(bytes(fx.rgba[i]))));
    });
  }

  it("composes the frames again, the same, when it loops", () => {
    const fx = fixtures.plain;
    const gif = parseGif(bytes(fx.gif));
    const c = new GifComposer(gif);
    for (let i = 0; i < gif.frames.length * 2; i++) c.step();
    c.step();
    expect(Array.from(c.pixels)).toEqual(Array.from(bytes(fx.rgba[0])));
  });

  it("rejects what is not a GIF", () => {
    expect(() => parseGif(new TextEncoder().encode("PNG not a gif"))).toThrow("not a GIF");
  });
});
