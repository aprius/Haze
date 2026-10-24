// A GIF decoder, for animated backgrounds (src/lib/backdropLive.ts): a canvas
// draws an animated <img> as its first frame only, and WebKit has no
// ImageDecoder, so the frames are decoded here. parseGif reads the file's
// structure, decodeFrame one frame's pixels; GifPlayer composes the frames on
// a canvas, in time, as a browser plays them (GifComposer, on arrays).

export interface GifFrame {
  left: number;
  top: number;
  width: number;
  height: number;
  /** How long the frame shows, in ms. */
  delay: number;
  /** What happens to its area before the next frame: 0–1 keep, 2 clear, 3 restore what was there. */
  disposal: number;
  /** The colour index drawn as transparent, if any. */
  transparent: number | null;
  interlaced: boolean;
  /** RGB triples. */
  palette: Uint8Array;
  minCodeSize: number;
  /** The LZW data, its sub-blocks joined. */
  data: Uint8Array;
}

export interface Gif {
  width: number;
  height: number;
  frames: GifFrame[];
}

/** Below this, browsers play a frame for 100 ms: many GIFs say 0 and mean "fast". */
const MIN_DELAY = 20;

export function parseGif(bytes: Uint8Array): Gif {
  const sig = String.fromCharCode(...bytes.subarray(0, 6));
  if (sig !== "GIF87a" && sig !== "GIF89a") throw new Error("not a GIF");
  let p = 6;
  const u16 = () => bytes[p++] | (bytes[p++] << 8);
  const width = u16();
  const height = u16();
  const packed = bytes[p];
  p += 3;
  let global: Uint8Array = new Uint8Array(0);
  if (packed & 0x80) {
    const n = 3 * (1 << ((packed & 7) + 1));
    global = bytes.subarray(p, p + n);
    p += n;
  }
  const subBlocks = (): Uint8Array[] => {
    const out: Uint8Array[] = [];
    for (let n = bytes[p++]; n > 0 && p < bytes.length; n = bytes[p++]) {
      out.push(bytes.subarray(p, p + n));
      p += n;
    }
    return out;
  };
  const frames: GifFrame[] = [];
  let delay = 0;
  let disposal = 0;
  let transparent: number | null = null;
  while (p < bytes.length) {
    const kind = bytes[p++];
    if (kind === 0x3b) break;
    if (kind === 0x21) {
      const label = bytes[p++];
      if (label === 0xf9 && bytes[p] >= 4) {
        const flags = bytes[p + 1];
        disposal = (flags >> 2) & 7;
        delay = (bytes[p + 2] | (bytes[p + 3] << 8)) * 10;
        transparent = flags & 1 ? bytes[p + 4] : null;
      }
      subBlocks();
    } else if (kind === 0x2c) {
      const left = u16();
      const top = u16();
      const w = u16();
      const h = u16();
      const flags = bytes[p++];
      let palette = global;
      if (flags & 0x80) {
        const n = 3 * (1 << ((flags & 7) + 1));
        palette = bytes.subarray(p, p + n);
        p += n;
      }
      const minCodeSize = bytes[p++];
      const blocks = subBlocks();
      const data = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
      let o = 0;
      for (const b of blocks) {
        data.set(b, o);
        o += b.length;
      }
      frames.push({
        left,
        top,
        width: w,
        height: h,
        delay: delay < MIN_DELAY ? 100 : delay,
        disposal,
        transparent,
        interlaced: !!(flags & 0x40),
        palette,
        minCodeSize,
        data,
      });
      delay = 0;
      disposal = 0;
      transparent = null;
    } else {
      throw new Error("broken GIF");
    }
  }
  if (!frames.length) throw new Error("the GIF has no frames");
  return { width, height, frames };
}

// The LZW tables, shared: frames decode one at a time.
const prefix = new Int16Array(4096);
const suffix = new Uint8Array(4096);
const first = new Uint8Array(4096);
const stack = new Uint8Array(4097);

/** A frame's colour indices, row by row, interlacing undone; into `out` if given, which is reused. */
export function decodeFrame(f: GifFrame, out = new Uint8Array(f.width * f.height)): Uint8Array {
  const count = f.width * f.height;
  const clear = 1 << f.minCodeSize;
  const eoi = clear + 1;
  for (let i = 0; i < clear; i++) {
    prefix[i] = -1;
    suffix[i] = i;
    first[i] = i;
  }
  let size = f.minCodeSize + 1;
  let mask = (1 << size) - 1;
  let next = eoi + 1;
  let prev = -1;
  let buf = 0;
  let bits = 0;
  let o = 0;
  decode: for (let i = 0; i < f.data.length; i++) {
    buf |= f.data[i] << bits;
    bits += 8;
    while (bits >= size) {
      const code = buf & mask;
      buf >>>= size;
      bits -= size;
      if (code === clear) {
        size = f.minCodeSize + 1;
        mask = (1 << size) - 1;
        next = eoi + 1;
        prev = -1;
        continue;
      }
      if (code === eoi) break decode;
      if (prev === -1) {
        if (o < count) out[o++] = suffix[code];
        prev = code;
        continue;
      }
      let sp = 0;
      let c = code;
      // The code being defined right now: the previous string and its first byte.
      if (code >= next) {
        stack[sp++] = first[prev];
        c = prev;
      }
      while (c > eoi) {
        stack[sp++] = suffix[c];
        c = prefix[c];
      }
      stack[sp++] = c;
      while (sp > 0 && o < count) out[o++] = stack[--sp];
      if (next < 4096) {
        prefix[next] = prev;
        suffix[next] = c;
        first[next] = first[prev];
        next++;
        if (next > mask && size < 12) {
          size++;
          mask = (1 << size) - 1;
        }
      }
      prev = code;
    }
  }
  // A frame cut short: the rest as a fresh buffer would have it.
  out.fill(0, o, count);
  if (!f.interlaced) return out;
  const rows = out.slice(0, count);
  let row = 0;
  for (const [start, step] of [
    [0, 8],
    [4, 8],
    [2, 4],
    [1, 2],
  ]) {
    for (let y = start; y < f.height; y += step) {
      out.set(rows.subarray(row * f.width, (row + 1) * f.width), y * f.width);
      row++;
    }
  }
  return out;
}

/**
 * Composes a GIF's frames in turn, as a browser plays them, into `pixels`
 * (RGBA, the GIF's size), and says which area each step changed.
 */
export class GifComposer {
  readonly pixels: Uint8ClampedArray;
  index = -1;
  /** What the last step changed: x, y, width, height. */
  dirty: [number, number, number, number] = [0, 0, 0, 0];
  private indices = new Uint8Array(0);
  private saved: Uint8ClampedArray | null = null;

  constructor(readonly gif: Gif) {
    this.pixels = new Uint8ClampedArray(gif.width * gif.height * 4);
  }

  step(): void {
    const { width: W, height: H, frames } = this.gif;
    const px = this.pixels;
    let x0 = W;
    let y0 = H;
    let x1 = 0;
    let y1 = 0;
    // A frame's rectangle, within the GIF: [left, top, right, bottom].
    const area = (f: GifFrame) => [Math.max(0, f.left), Math.max(0, f.top), Math.min(W, f.left + f.width), Math.min(H, f.top + f.height)];
    const touch = ([l, t, r, b]: number[]) => {
      if (l >= r || t >= b) return;
      x0 = Math.min(x0, l);
      y0 = Math.min(y0, t);
      x1 = Math.max(x1, r);
      y1 = Math.max(y1, b);
    };
    const prev = frames[this.index];
    if (prev && (prev.disposal === 2 || (prev.disposal === 3 && this.saved))) {
      const a = area(prev);
      for (let y = a[1]; y < a[3]; y++) {
        const s = (y * W + a[0]) * 4;
        const e = (y * W + a[2]) * 4;
        if (prev.disposal === 2) px.fill(0, s, e);
        else px.set(this.saved!.subarray(s, e), s);
      }
      touch(a);
    }
    this.index = (this.index + 1) % frames.length;
    if (this.index === 0) {
      px.fill(0);
      touch([0, 0, W, H]);
    }
    const f = frames[this.index];
    if (f.disposal === 3) (this.saved ??= new Uint8ClampedArray(px.length)).set(px);
    const a = area(f);
    if (a[0] < a[2] && a[1] < a[3]) {
      if (this.indices.length < f.width * f.height) this.indices = new Uint8Array(f.width * f.height);
      const idx = decodeFrame(f, this.indices);
      const pal = f.palette;
      const t = f.transparent;
      for (let y = a[1]; y < a[3]; y++) {
        let i = (y - f.top) * f.width + (a[0] - f.left);
        let o = (y * W + a[0]) * 4;
        for (let x = a[0]; x < a[2]; x++, i++, o += 4) {
          const k = idx[i];
          if (k === t) continue;
          px[o] = pal[k * 3];
          px[o + 1] = pal[k * 3 + 1];
          px[o + 2] = pal[k * 3 + 2];
          px[o + 3] = 255;
        }
      }
      touch(a);
    }
    this.dirty = x0 < x1 ? [x0, y0, x1 - x0, y1 - y0] : [0, 0, 0, 0];
  }
}

/** Plays a GIF on `canvas`, frame by frame, when advance() is called. */
export class GifPlayer {
  readonly canvas = document.createElement("canvas");
  private readonly ctx: CanvasRenderingContext2D;
  private readonly composer: GifComposer;
  private readonly image: ImageData;
  private nextAt = 0;

  constructor(readonly gif: Gif) {
    this.canvas.width = gif.width;
    this.canvas.height = gif.height;
    this.ctx = this.canvas.getContext("2d")!;
    this.composer = new GifComposer(gif);
    // The composer's pixels themselves: putImageData copies only what changed.
    this.image = new ImageData(this.composer.pixels as Uint8ClampedArray<ArrayBuffer>, gif.width, gif.height);
  }

  /** When the next frame is due, on performance.now()'s clock; Infinity for a still. */
  get due(): number {
    return this.gif.frames.length === 1 && this.composer.index === 0 ? Infinity : this.nextAt;
  }

  /** Shows the next frame once the current one has had its time; true when it did. */
  advance(now: number): boolean {
    if (now < this.due) return false;
    const c = this.composer;
    c.step();
    const [x, y, w, h] = c.dirty;
    if (w && h) this.ctx.putImageData(this.image, 0, 0, x, y, w, h);
    // On the GIF's own clock, unless far behind it (the first frame, or the window was hidden).
    this.nextAt = (now - this.nextAt > 1000 ? now : this.nextAt) + this.gif.frames[c.index].delay;
    return true;
  }
}
