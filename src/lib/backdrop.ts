// What is behind the islands layout (Settings > Background): an image or a
// video, or system glass. With an image, the frame shows it dimmed towards the
// theme's frame colour, and each island is tinted over it: editors and
// terminals draw with a transparent background (useGlass, read by monaco.ts
// and TerminalPanel). Popups show the same image, fixed to the window, under
// their own tint. The settings are in localStorage like the theme, the image in
// IndexedDB (see readBase); it fades in once loaded. A video plays
// (backdropLive.ts), its first frame standing in where it does not.
// With glass, the windows are see-through and the system blurs what is behind
// them (src-tauri/src/glass.rs); the islands are tinted over that, and popups,
// which nothing blurs under, are opaque.
import { create } from "zustand";
import { api, errorMessage } from "./ipc";
import { useGlass, useTheme, useUiStyle } from "./theme";

export interface BackdropSettings {
  /** The image file; null for no background. */
  path: string | null;
  /** System glass instead of an image (never with one). */
  glass: boolean;
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
  /** A folder to rotate through (src/lib/backdropRotate.ts), `path` being its pick; null for one file. */
  folder: string | null;
  /** Minutes between picks; 0: only when day turns to night and back. */
  interval: number;
  /** Picks at random rather than in order of name. */
  shuffle: boolean;
  /** When day and night start, in minutes after midnight. */
  dayStart: number;
  nightStart: number;
  /** How long one background fades into the next, in seconds; 0 cuts. */
  fade: number;
}

const KEY = "haze.backdrop";
export const DEFAULT_BACKDROP: BackdropSettings = {
  path: null, glass: false, dim: 30, opacity: 82, popupOpacity: 80, ambient: 40, agentGlow: true, pauseInBackground: false,
  folder: null, interval: 30, shuffle: true, dayStart: 6 * 60, nightStart: 18 * 60, fade: 2,
};
export const BACKDROP_LIMITS = { dim: [0, 90], opacity: [40, 100], popupOpacity: [50, 100], ambient: [0, 100], fade: [0, 5] } as const;
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
    glass: s.glass === true && !s.path,
    dim: clamp(s.dim, BACKDROP_LIMITS.dim, d.dim),
    opacity: clamp(s.opacity, BACKDROP_LIMITS.opacity, d.opacity),
    popupOpacity: clamp(s.popupOpacity, BACKDROP_LIMITS.popupOpacity, d.popupOpacity),
    ambient: clamp(s.ambient, BACKDROP_LIMITS.ambient, d.ambient),
    agentGlow: typeof s.agentGlow === "boolean" ? s.agentGlow : d.agentGlow,
    pauseInBackground: typeof s.pauseInBackground === "boolean" ? s.pauseInBackground : d.pauseInBackground,
    folder: typeof s.folder === "string" && s.folder ? s.folder : null,
    interval: clamp(s.interval, [0, 24 * 60], d.interval),
    shuffle: typeof s.shuffle === "boolean" ? s.shuffle : d.shuffle,
    dayStart: clamp(s.dayStart, [0, 24 * 60 - 1], d.dayStart),
    nightStart: clamp(s.nightStart, [0, 24 * 60 - 1], d.nightStart),
    fade: clamp(s.fade, BACKDROP_LIMITS.fade, d.fade),
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
 * The image as shown (an object URL), or why it could not be
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

/** Whether the system draws glass (macOS, Windows 11), and whether it is on. */
export const useSystemGlass = create<{ supported: boolean; on: boolean }>(() => ({ supported: false, on: false }));

/** The system glass as last asked for: "" off, else the theme's mode. */
let asked = "";
let glassToken = 0;

/**
 * Sets data-backdrop ("image" or "glass", read by the CSS) and useGlass. Glass
 * turns the page see-through only once the system draws it, and back opaque
 * before it stops, so nothing behind the window shows unblurred.
 */
function applyGlass(): void {
  const root = document.documentElement.dataset;
  const islands = useUiStyle.getState().style === "islands";
  const wantGlass = islands && useBackdrop.getState().glass && useSystemGlass.getState().supported;
  const image = islands && !wantGlass && !!useBackdropImage.getState().url;
  const set = (mode: "image" | "glass" | null) => {
    if (mode) root.backdrop = mode;
    else delete root.backdrop;
    const on = mode !== null;
    if (useGlass.getState().on !== on) useGlass.setState({ on });
  };
  const want = wantGlass ? useTheme.getState().mode : "";
  if (!wantGlass) set(image ? "image" : null);
  if (want === asked) {
    if (wantGlass && useSystemGlass.getState().on) set("glass");
    return;
  }
  asked = want;
  const t = ++glassToken;
  api
    .setGlass(!!want, want === "dark")
    .catch(() => false)
    .then((on) => {
      if (t !== glassToken) return;
      useSystemGlass.setState({ on });
      if (wantGlass) set(on ? "glass" : null);
    });
}

/** Shown images still drawn elsewhere (a fading cover), and whether they are no longer shown. */
const held = new Map<string, boolean>();

/** Keeps the image `url` alive until the function returned lets it go. */
export function holdImage(url: string): () => void {
  held.set(url, false);
  return () => {
    if (held.get(url)) URL.revokeObjectURL(url);
    held.delete(url);
  };
}

function show(url: string | null, error: string | null): void {
  const prev = useBackdropImage.getState().url;
  document.documentElement.style.setProperty("--backdrop-url", url ? `url("${url}")` : "none");
  if (prev && prev !== url) {
    if (held.has(prev)) held.set(prev, true);
    else URL.revokeObjectURL(prev);
  }
  useBackdropImage.setState({ url, error });
  applyGlass();
}

/** `src` (sw × sh) drawn on a canvas of its own size. */
export function frameCanvas(src: CanvasImageSource, sw: number, sh: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, sw);
  canvas.height = Math.max(1, sh);
  canvas.getContext("2d")!.drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** A still of `src`, as a JPEG. */
async function still(src: CanvasImageSource, sw: number, sh: number): Promise<Blob> {
  const canvas = frameCanvas(src, sw, sh);
  try {
    return await toBlob(canvas);
  } finally {
    // WebKit keeps a canvas's backing store until it is collected.
    canvas.width = canvas.height = 0;
  }
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
  const done = () => (video.pause(), video.removeAttribute("src"), video.load());
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
// screen's size (`base`), and as last shown (`shown`), so a start shows
// the latter at once, with no IPC or decoding, and the background survives the
// file moving. Nothing keeps the full-size image in memory. A video is copied
// into the app's cache instead, and played from there over loopback HTTP
// (src-tauri/src/media.rs), which WebKit plays with half the CPU a blob: URL
// takes.
const DB = "haze-backdrop";
const STORE = "images";
interface Stored {
  path: string;
  /** Blur radius of a still shown by an older version, which blurred it. */
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
 * The file at the screen's size (device pixels, so it stays sharp);
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
    try {
      return { path, blob: await toBlob(canvas) };
    } finally {
      canvas.width = canvas.height = 0;
    }
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
    // Shown before the start read the image back.
    const path = useBackdrop.getState().path;
    return path ? load(path, true) : show(null, null);
  }
  const { path } = base;
  const kind = kindOf(base);
  try {
    let out = base.blob;
    if (kind === "video") {
      // From the URL the background plays from: asking for another would end it.
      const url = useBackdropImage.getState().live;
      if (!url) throw new Error("cannot play this video");
      const f = await videoFrame(url);
      try {
        out = await still(f.src, f.w, f.h);
      } finally {
        f.done();
      }
    }
    if (t !== token || !out) return;
    show(URL.createObjectURL(out), null);
    putStored("shown", { path, blob: out });
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
      if (last?.path === path && !last.blur && last.blob) {
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
useTheme.subscribe((s, prev) => s.mode !== prev.mode && applyGlass());
api
  .glassSupported()
  .catch(() => false)
  .then((supported) => {
    useSystemGlass.setState({ supported });
    applyGlass();
  });

/** Resolves once a new file is shown, or could not be (useBackdropImage's error). */
export function setBackdrop(patch: Partial<BackdropSettings>): Promise<void> {
  const prev = useBackdrop.getState();
  // An image or glass, never both: choosing one drops the other.
  if (patch.glass) patch = { ...patch, path: null, folder: null };
  else if (patch.path || patch.folder) patch = { ...patch, glass: false };
  const next = sanitize({ ...prev, ...patch });
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {}
  applyVars(next);
  useBackdrop.setState(next);
  // Choosing the same file again reads it again: it may have changed.
  if (next.glass !== prev.glass) applyGlass();
  if (patch.path !== undefined && (patch.path !== null || prev.path !== null)) return load(next.path);
  return Promise.resolve();
}
