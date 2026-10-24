// Background image behind the islands layout (Settings > Appearance). The
// frame shows the image, blurred (once, see blurred) and dimmed towards the
// theme's frame colour, and each island is tinted glass over it: editors and
// terminals draw with a transparent background (useGlass, read by monaco.ts
// and TerminalPanel). Popups show the same image, fixed to the window, under
// their own tint. The settings are in localStorage like the theme, the image in
// IndexedDB (see readBase); it fades in once loaded.
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
}

const KEY = "haze.backdrop";
export const DEFAULT_BACKDROP: BackdropSettings = { path: null, blur: 12, dim: 30, opacity: 82, popupOpacity: 80 };
export const BACKDROP_LIMITS = { blur: [0, 40], dim: [0, 90], opacity: [40, 100], popupOpacity: [50, 100] } as const;
export const BACKDROP_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];

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

/** The image as shown, already blurred (an object URL), or why it could not be read. */
export const useBackdropImage = create<{ url: string | null; error: string | null }>(() => ({ url: null, error: null }));

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

/**
 * The image blurred once, here, rather than by CSS: a blur filter on a layer
 * the size of the window, or backdrop-filter on popups, blurs again on every
 * repaint, and WebKit leaves stale pixels under a backdrop-filter when what is
 * inside it scrolls. Blurred, the image needs few pixels: drawn at a fraction
 * of the screen's size, it is scaled up smoothly.
 */
async function blurred(img: ImageBitmap, blur: number): Promise<Blob> {
  const scale = Math.min(1, 4 / blur);
  const w = Math.max(1, Math.round(screen.width * scale));
  const h = Math.max(1, Math.round(screen.height * scale));
  const r = blur * scale;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  // Cover the canvas and overflow it by twice the radius, so the edges blur
  // into the image rather than into transparent (black once a JPEG).
  const k = Math.max((w + 4 * r) / img.width, (h + 4 * r) / img.height);
  const dw = img.width * k;
  const dh = img.height * k;
  ctx.filter = `blur(${r}px)`;
  if (ctx.filter.startsWith("blur")) {
    ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
  } else {
    // No canvas filters (older WebKit): shrink further and let scaling up blur it.
    const small = document.createElement("canvas");
    small.width = Math.max(1, Math.round(w / r));
    small.height = Math.max(1, Math.round(h / r));
    const sctx = small.getContext("2d")!;
    sctx.imageSmoothingQuality = "high";
    sctx.drawImage(img, ((w - dw) / 2) / r, ((h - dh) / 2) / r, dw / r, dh / r);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(small, 0, 0, w, h);
  }
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("could not blur the image"))), "image/jpeg", 0.92),
  );
}

// The image is read and decoded once, when chosen: kept in IndexedDB at the
// screen's size (`base`), and blurred as last shown (`shown`), so a start only
// reads the latter, with no IPC or decoding, and the background survives the
// file moving. Nothing keeps the full-size image in memory.
const DB = "haze-backdrop";
const STORE = "images";
interface Stored {
  path: string;
  blur?: number;
  blob: Blob;
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
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("could not process the image"))), "image/jpeg", 0.9),
  );

/** The file at the screen's size (device pixels, so unblurred it stays sharp); a GIF as it is, to keep playing. */
async function readBase(path: string): Promise<Blob> {
  const data = await api.readImage(path);
  const blob = await (await fetch(`data:${data.mime};base64,${data.base64}`)).blob();
  if (data.mime === "image/gif") return blob;
  const img = await createImageBitmap(blob);
  try {
    const dpr = window.devicePixelRatio || 1;
    const k = Math.max((screen.width * dpr) / img.width, (screen.height * dpr) / img.height);
    if (k >= 1) return blob;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * k);
    canvas.height = Math.round(img.height * k);
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await toBlob(canvas);
  } finally {
    img.close();
  }
}

let base: Stored | null = null;
let token = 0;

async function render(): Promise<void> {
  const t = ++token;
  if (!base) {
    // The slider moved before the start read the image back.
    const path = useBackdrop.getState().path;
    return path ? load(path, true) : show(null, null);
  }
  const { path, blob } = base;
  const blur = useBackdrop.getState().blur;
  try {
    let out = blob;
    if (blur > 0) {
      const img = await createImageBitmap(blob);
      try {
        out = await blurred(img, blur);
      } finally {
        img.close();
      }
    }
    if (t !== token) return;
    show(URL.createObjectURL(out), null);
    putStored("shown", { path, blur, blob: out });
  } catch (e) {
    if (t === token) show(null, errorMessage(e));
  }
}

async function load(path: string | null, start = false): Promise<void> {
  const t = ++token;
  base = null;
  if (!path) {
    clearStored();
    return show(null, null);
  }
  try {
    if (start) {
      const shown = await getStored("shown");
      if (t !== token) return;
      if (shown?.path === path && shown.blur === useBackdrop.getState().blur) {
        show(URL.createObjectURL(shown.blob), null);
        // For blurring again when the slider moves.
        const stored = await getStored("base");
        if (t === token && stored?.path === path) base = stored;
        return;
      }
      const stored = await getStored("base");
      if (t !== token) return;
      if (stored?.path === path) {
        base = stored;
        return await render();
      }
    }
    const blob = await readBase(path);
    if (t !== token) return;
    base = { path, blob };
    putStored("base", base);
    await render();
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
