import { describe, expect, it } from "vitest";
import { decodeFrame, frameRGBA, parseGif, type Gif } from "./gif";
// Made by Pillow, 40×24: three frames (50/120/0 ms, disposal 1/2/1, index 255
// transparent), and one interlaced frame (Pillow interlaces no animation); with
// each frame as Pillow composes it.
import fixtures from "./gif.fixtures.json";

const bytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** GifPlayer's composition, on arrays. */
function compose(gif: Gif): Uint8ClampedArray[] {
  const canvas = new Uint8ClampedArray(gif.width * gif.height * 4);
  const out: Uint8ClampedArray[] = [];
  gif.frames.forEach((f, i) => {
    const prev = gif.frames[i - 1];
    if (prev?.disposal === 2) {
      for (let y = prev.top; y < prev.top + prev.height; y++) canvas.fill(0, (y * gif.width + prev.left) * 4, (y * gif.width + prev.left + prev.width) * 4);
    }
    const rgba = frameRGBA(f, decodeFrame(f));
    for (let y = 0; y < f.height; y++) {
      for (let x = 0; x < f.width; x++) {
        const s = (y * f.width + x) * 4;
        if (!rgba[s + 3]) continue;
        canvas.set(rgba.subarray(s, s + 4), ((f.top + y) * gif.width + f.left + x) * 4);
      }
    }
    out.push(canvas.slice());
  });
  return out;
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

  it("rejects what is not a GIF", () => {
    expect(() => parseGif(new TextEncoder().encode("PNG not a gif"))).toThrow("not a GIF");
  });
});
