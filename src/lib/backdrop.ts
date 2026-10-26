// Background image behind the islands layout (Settings > Appearance). The
// frame shows the image, blurred (once, see drawBlurred) and dimmed towards the
// theme's frame colour, and each island is tinted glass over it: editors and
// terminals draw with a transparent background (useGlass, read by monaco.ts
// and TerminalPanel). Popups show the same image, fixed to the window, under
// their own tint. The settings are in localStorage like the theme, the image in
// IndexedDB (see readBase); it fades in once loaded. A video plays
// (backdropLive.ts), its first frame standing in where it does not.
import { create } from "zustand";
import { api, errorMessage } from "./ipc";
import { useGlass, useUiStyle } from "./theme";

export interface BackdropSettings {
  /** The image file; null for no background. */
  path: string | null;
  /** Blur radius of the image, in px. */
  blur: number;
  /** How far the image fades towards the frame colour, 0–90 %. */
  dim: number;
  /** How opaque each island is over the image, 40–100 %. */
  opacity: number;
  /** How opaque the frosted popups (menus, Search Everywhere, Find…) are, 50–100 %. */
  popupOpacity: number;
  /** How strongly each island glows in the image's colours (src/lib/ambient.ts), 0 (off)–100 %. */
  ambient: number;
  /** The terminal island glows in its agents' state instead: working, waiting for you, done, failed. */
  agentGlow: boolean;
  /** A video stops while no Haze window has focus. */
  pauseInBackground: boolean;
}

const KEY = "haze.backdrop";
export const DEFAULT_BACKDROP: BackdropSettings = { path: null, blur: 12, dim: 30, opacity: 82, popupOpacity: 80, ambient: 40, agentGlow: true, pauseInBackground: false };
export const BACKDROP_LIMITS = { blur: [0, 40], dim: [0, 90], opacity: [40, 100], popupOpacity: [50, 100], ambient: [0, 100] } as const;
// No GIFs: playing one cost three to seven times what a video does (docs/BACKGROUND.md).
export const BACKDROP_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "bmp", "mp4", "webm", "mov", "m4v"];

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  bmp: "image/bmp",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

/** What moves: a video plays (src/lib/backdropLive.ts); an image is still. */
export type MediaKind = "image" | "video";
export const mediaKind = (type: string): MediaKind => (type.startsWith("video/") ? "video" : "image");

const clamp = (n: unknown, [lo, hi]: readonly [number, number], fallback: number) =>
  Number.isFinite(Number(n)) ? Math.round(Math.min(hi, Math.max(lo, Number(n)))) : fallback;

function sanitize(s: Partial<BackdropSettings>): BackdropSettings {
  const d = DEFAULT_BACKDROP;
  return {
    path: typeof s.path === "string" && s.path ? s.path : null,
    blur: clamp(s.blur, BACKDROP_LIMITS.blur, d.blur),
    dim: clamp(s.dim, BACKDROP_LIMITS.dim, d.dim),
    opacity: clamp(s.opacity, BACKDROP_LIMITS.opacity, d.opacity),
    popupOpacity: clamp(s.popupOpacity, BACKDROP_LIMITS.popupOpacity, d.popupOpacity),
    ambient: clamp(s.ambient, BACKDROP_LIMITS.ambient, d.ambient),
    agentGlow: typeof s.agentGlow === "boolean" ? s.agentGlow : d.agentGlow,
    pauseInBackground: typeof s.pauseInBackground === "boolean" ? s.pauseInBackground : d.pauseInBackground,
  };
}

function initial(): BackdropSettings {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) return sanitize(JSON.parse(saved));
  } catch {}
  return DEFAULT_BACKDROP;
}

export const useBackdrop = create<BackdropSettings>(() => initial());

/**
 * The image as shown, already blurred (an object URL), or why it could not be
 * read. For a video, `url` is its first frame (popups and windows of their own
 * show that), and `live` the URL the frame plays it from.
 */
export const useBackdropImage = create<{ url: string | null; error: string | null; live: string | null }>(
  () => ({ url: null, error: null, live: null }),
);

function applyVars(s: BackdropSettings): void {
  const root = document.documentElement.style;
  root.setProperty("--backdrop-dim", `${s.dim}%`);
  root.setProperty("--glass", `${s.opacity}%`);
  root.setProperty("--popup-glass", `${s.popupOpacity}%`);
}

function applyGlass(): void {
  const on = !!useBackdropImage.getState().url && useUiStyle.getState().style === "islands";
  if (on) document.documentElement.dataset.backdrop = "";
  else delete document.documentElement.dataset.backdrop;
  if (useGlass.getState().on !== on) useGlass.setState({ on });
}

function show(url: string | null, error: string | null): void {
  const prev = useBackdropImage.getState().url;
  document.documentElement.style.setProperty("--backdrop-url", url ? `url("${url}")` : "none");
  if (prev && prev !== url) URL.revokeObjectURL(prev);
  useBackdropImage.setState({ url, error });
  applyGlass();
}

/** The size a blurred background is drawn at, and the blur radius there. */
export function blurredSize(blur: number): { w: number; h: number; r: number } {
  // Blurred, the image needs fewer pixels: drawn at a fraction of the screen's
  // size, it is scaled up smoothly. Not too few: sharp detail (lights, edges)
  // scaled up 3x or more shows as blocks, and so do the JPEG's own. Unblurred,
  // the screen's own.
  const scale = blur > 0 ? Math.min(1, 8 / blur) : window.devicePixelRatio || 1;
  return { w: Math.max(1, Math.round(screen.width * scale)), h: Math.max(1, Math.round(screen.height * scale)), r: blur > 0 ? blur * scale : 0 };
}

let scratch: HTMLCanvasElement | null = null;
// Not by setting ctx.filter and reading it back: without the property, that
// sets a plain one, which reads back the same.
const canvasFilters = "filter" in CanvasRenderingContext2D.prototype;

/**
 * Draws `src` (sw × sh) blurred by `r` to cover `ctx`'s canvas. Blurred here,
 * rather than by CSS: a blur filter on a layer the size of the window, or
 * backdrop-filter on popups, blurs again on every repaint, and WebKit leaves
 * stale pixels under a backdrop-filter when what is inside it scrolls.
 */
export function drawBlurred(ctx: CanvasRenderingContext2D, src: CanvasImageSource, sw: number, sh: number, r: number): void {
  const { width: w, height: h } = ctx.canvas;
  // Cover the canvas and overflow it by twice the radius, so the edges blur
  // into the image rather than into transparent (black once a JPEG).
  const k = Math.max((w + 4 * r) / sw, (h + 4 * r) / sh);
  const dw = sw * k;
  const dh = sh * k;
  // The big step down to the canvas must average, or it aliases into detail
  // the blur is too small to remove.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  if (r === 0 || canvasFilters) {
    ctx.filter = r > 0 ? `blur(${r}px)` : "none";
    ctx.drawImage(src, (w - dw) / 2, (h - dh) / 2, dw, dh);
    return;
  }
  // No canvas filters (older WebKit): shrink further and let scaling up blur it.
  scratch ??= document.createElement("canvas");
  const sw2 = Math.max(1, Math.round(w / r));
  const sh2 = Math.max(1, Math.round(h / r));
  if (scratch.width !== sw2 || scratch.height !== sh2) {
    scratch.width = sw2;
    scratch.height = sh2;
  }
  const sctx = scratch.getContext("2d")!;
  sctx.imageSmoothingQuality = "high";
  sctx.drawImage(src, (w - dw) / 2 / r, (h - dh) / 2 / r, dw / r, dh / r);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(scratch, 0, 0, w, h);
}

/** A still of `src`, blurred, as a JPEG. */
async function blurred(src: CanvasImageSource, sw: number, sh: number, blur: number): Promise<Blob> {
  const { w, h, r } = blurredSize(blur);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  drawBlurred(canvas.getContext("2d")!, src, sw, sh, r);
  return toBlob(canvas);
}

/** A video's first frame, as a source to draw. */
async function videoFrame(url: string): Promise<{ src: HTMLVideoElement; w: number; h: number; done: () => void }> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  // Served from loopback: drawn onto a canvas, it must not taint it.
  video.crossOrigin = "anonymous";
  video.src = url;
  // Without load(), the element keeps its decoder and connection until collected.
  const done = () => (video.removeAttribute("src"), video.load());
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error("cannot play this video"));
    });
  } catch (e) {
    done();
    throw e;
  }
  return { src: video, w: video.videoWidth, h: video.videoHeight, done };
}

// The image is read and decoded once, when chosen: kept in IndexedDB at the
// screen's size (`base`), and blurred as last shown (`shown`), so a start shows
// the latter at once, with no IPC or decoding, and the background survives the
// file moving. Nothing keeps the full-size image in memory. A video is copied
// into the app's cache instead, and played from there over loopback HTTP
// (src-tauri/src/media.rs), which WebKit plays with half the CPU a blob: URL
// takes.
const DB = "haze-backdrop";
const STORE = "images";
interface Stored {
  path: string;
  blur?: number;
  /** The image at the screen's size, or the still as shown. */
  blob?: Blob;
  /** A video's copy in the app's cache. */
  video?: string;
}

function idb<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return new Promise((resolve) => {
    try {
      const open = indexedDB.open(DB, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(STORE);
      open.onerror = () => resolve(undefined);
      open.onsuccess = () => {
        const db = open.result;
        try {
          const req = op(db.transaction(STORE, mode).objectStore(STORE));
          req.onsuccess = () => (db.close(), resolve(req.result));
          req.onerror = () => (db.close(), resolve(undefined));
        } catch {
          db.close();
          resolve(undefined);
        }
      };
    } catch {
      resolve(undefined);
    }
  });
}
const getStored = (key: "base" | "shown") => idb<Stored>("readonly", (s) => s.get(key));
const putStored = (key: "base" | "shown", v: Stored) => void idb("readwrite", (s) => s.put(v, key));
const clearStored = () => void idb("readwrite", (s) => s.clear());

const toBlob = (canvas: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("could not process the image"))), "image/jpeg", 0.95),
  );

// One at a time: emptying the cache after copying a video would drop the copy.
let caching: Promise<unknown> = Promise.resolve();
function cacheVideo(path: string | null): Promise<string | null> {
  const next = caching.then(() => api.cacheBackdrop(path));
  caching = next.catch(() => {});
  return next;
}

/**
 * The file at the screen's size (device pixels, so unblurred it stays sharp);
 * a video copied into the app's cache.
 */
async function readBase(path: string): Promise<Stored> {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const type = MIME[ext] ?? "application/octet-stream";
  if (mediaKind(type) === "video") return { path, video: (await cacheVideo(path))! };
  // The copy of a video shown before.
  void cacheVideo(null).catch(() => {});
  const blob = new Blob([await api.readMedia(path)], { type });
  const img = await createImageBitmap(blob);
  try {
    const dpr = window.devicePixelRatio || 1;
    const k = Math.max((screen.width * dpr) / img.width, (screen.height * dpr) / img.height);
    if (k >= 1) return { path, blob };
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * k);
    canvas.height = Math.round(img.height * k);
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return { path, blob: await toBlob(canvas) };
  } finally {
    img.close();
  }
}

let base: Stored | null = null;
let token = 0;

/** What `b` is: a video or a still image. */
const kindOf = (b: Stored): MediaKind => (b.video ? "video" : mediaKind(b.blob?.type ?? ""));

/** A base read back from IndexedDB, as this version keeps it: a video by its copy, not its bytes. */
const usable = (b: Stored | undefined, path: string): b is Stored => b?.path === path && (!!b.video || (!!b.blob && kindOf(b) !== "video"));

let liveToken = 0;
async function setLive(b: Stored | null): Promise<void> {
  const t = ++liveToken;
  if (useBackdropImage.getState().live) useBackdropImage.setState({ live: null });
  if (!b?.video) return;
  const url = await api.mediaUrl(b.video);
  if (t === liveToken) useBackdropImage.setState({ live: url });
}

async function render(): Promise<void> {
  const t = ++token;
  if (!base) {
    // The slider moved before the start read the image back.
    const path = useBackdrop.getState().path;
    return path ? load(path, true) : show(null, null);
  }
  const { path } = base;
  const blur = useBackdrop.getState().blur;
  const kind = kindOf(base);
  try {
    let out = base.blob;
    if (kind === "video") {
      // From the URL the background plays from: asking for another would end it.
      const url = useBackdropImage.getState().live;
      if (!url) throw new Error("cannot play this video");
      const f = await videoFrame(url);
      try {
        out = await blurred(f.src, f.w, f.h, blur);
      } finally {
        f.done();
      }
    } else if (blur > 0) {
      const img = await createImageBitmap(base.blob!);
      try {
        out = await blurred(img, img.width, img.height, blur);
      } finally {
        img.close();
      }
    }
    if (t !== token || !out) return;
    show(URL.createObjectURL(out), null);
    putStored("shown", { path, blur, blob: out });
  } catch (e) {
    if (t === token) show(null, errorMessage(e));
  }
}

async function load(path: string | null, start = false): Promise<void> {
  const t = ++token;
  base = null;
  void setLive(null);
  if (!path) {
    clearStored();
    void cacheVideo(null).catch(() => {});
    return show(null, null);
  }
  try {
    let shown = false;
    if (start) {
      const last = await getStored("shown");
      if (t !== token) return;
      if (last?.path === path && last.blur === useBackdrop.getState().blur && last.blob) {
        show(URL.createObjectURL(last.blob), null);
        shown = true;
      }
      const stored = await getStored("base");
      if (t !== token) return;
      if (usable(stored, path)) {
        try {
          await setLive(stored);
          base = stored;
        } catch {
          // The cached copy is gone: read the file again.
        }
        if (t !== token) return;
      }
    }
    if (!base) {
      const read = await readBase(path);
      if (t !== token) return;
      await setLive(read);
      if (t !== token) return;
      base = read;
      putStored("base", base);
    }
    if (!shown) await render();
  } catch (e) {
    if (t === token) show(null, errorMessage(e));
  }
}

applyVars(useBackdrop.getState());
void load(useBackdrop.getState().path, true);
useUiStyle.subscribe(applyGlass);

// The blur slider re-blurs once it rests, not on every step of a drag.
let reblur: ReturnType<typeof setTimeout> | undefined;

export function setBackdrop(patch: Partial<BackdropSettings>): void {
  const prev = useBackdrop.getState();
  const next = sanitize({ ...prev, ...patch });
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {}
  applyVars(next);
  useBackdrop.setState(next);
  // Choosing the same file again reads it again: it may have changed.
  if (patch.path !== undefined) void load(next.path);
  else if (next.blur !== prev.blur) {
    clearTimeout(reblur);
    reblur = setTimeout(() => void render(), 150);
  }
}
