// A GIF decoder, for animated backgrounds (src/lib/backdropLive.ts): a canvas
// draws an animated <img> as its first frame only, and WebKit has no
// ImageDecoder, so the frames are decoded here. parseGif reads the file's
// structure, decodeFrame one frame's pixels; GifPlayer composes the frames on
// a canvas, in time, as a browser plays them.

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

/** A frame's colour indices, row by row, interlacing undone. */
export function decodeFrame(f: GifFrame): Uint8Array {
  const count = f.width * f.height;
  const out = new Uint8Array(count);
  const clear = 1 << f.minCodeSize;
  const eoi = clear + 1;
  const prefix = new Int16Array(4096);
  const suffix = new Uint8Array(4096);
  const first = new Uint8Array(4096);
  for (let i = 0; i < clear; i++) {
    prefix[i] = -1;
    suffix[i] = i;
    first[i] = i;
  }
  const stack = new Uint8Array(4097);
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
  if (!f.interlaced) return out;
  const rows = new Uint8Array(count);
  let row = 0;
  for (const [start, step] of [
    [0, 8],
    [4, 8],
    [2, 4],
    [1, 2],
  ]) {
    for (let y = start; y < f.height; y += step) {
      rows.set(out.subarray(row * f.width, (row + 1) * f.width), y * f.width);
      row++;
    }
  }
  return rows;
}

/** A frame's pixels as RGBA, its transparent colour clear. */
export function frameRGBA(f: GifFrame, indices: Uint8Array, out = new Uint8ClampedArray(indices.length * 4)): Uint8ClampedArray {
  const pal = f.palette;
  for (let i = 0, o = 0; i < indices.length; i++, o += 4) {
    const k = indices[i];
    if (k === f.transparent) {
      out[o + 3] = 0;
      continue;
    }
    out[o] = pal[k * 3];
    out[o + 1] = pal[k * 3 + 1];
    out[o + 2] = pal[k * 3 + 2];
    out[o + 3] = 255;
  }
  return out;
}

/** Plays a GIF on `canvas`, frame by frame, when advance() is called. */
export class GifPlayer {
  readonly canvas = document.createElement("canvas");
  private readonly ctx: CanvasRenderingContext2D;
  private readonly patch = document.createElement("canvas");
  private index = -1;
  private nextAt = 0;
  private saved: ImageData | null = null;

  constructor(readonly gif: Gif) {
    this.canvas.width = gif.width;
    this.canvas.height = gif.height;
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true })!;
  }

  /** Shows the next frame once the current one has had its time; true when it did. */
  advance(now: number): boolean {
    if (now < this.nextAt) return false;
    const frames = this.gif.frames;
    if (frames.length === 1 && this.index === 0) return false;
    const prev = frames[this.index];
    if (prev?.disposal === 2) this.ctx.clearRect(prev.left, prev.top, prev.width, prev.height);
    else if (prev?.disposal === 3 && this.saved) this.ctx.putImageData(this.saved, 0, 0);
    this.index = (this.index + 1) % frames.length;
    if (this.index === 0) this.ctx.clearRect(0, 0, this.gif.width, this.gif.height);
    const f = frames[this.index];
    this.saved = f.disposal === 3 ? this.ctx.getImageData(0, 0, this.gif.width, this.gif.height) : null;
    if (f.width && f.height) {
      if (this.patch.width !== f.width || this.patch.height !== f.height) {
        this.patch.width = f.width;
        this.patch.height = f.height;
      }
      const pctx = this.patch.getContext("2d")!;
      const img = pctx.createImageData(f.width, f.height);
      frameRGBA(f, decodeFrame(f), img.data);
      pctx.putImageData(img, 0, 0);
      // drawImage, not putImageData: the frame's transparent pixels keep what is under them.
      this.ctx.drawImage(this.patch, f.left, f.top);
    }
    // On the GIF's own clock, unless far behind it (the first frame, or the window was hidden).
    this.nextAt = (now - this.nextAt > 1000 ? now : this.nextAt) + f.delay;
    return true;
  }
}
