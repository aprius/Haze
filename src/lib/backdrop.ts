// Background image behind the islands layout (Settings > Appearance). The
// frame shows the image, blurred (once, see blurred) and dimmed towards the
// theme's frame colour, and each island is tinted glass over it: editors and
// terminals draw with a transparent background (useGlass, read by monaco.ts
// and TerminalPanel). Popups show the same image, fixed to the window, under
// their own tint. The settings are in localStorage like the theme; the image is
// read from its path at startup, so it fades in once loaded.
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

let source: { blob: Blob; img: ImageBitmap } | null = null;
let token = 0;

async function render(): Promise<void> {
  const t = ++token;
  if (!source) return show(null, null);
  const blur = useBackdrop.getState().blur;
  try {
    // Unblurred, the file as it is: full resolution, and a GIF still plays.
    const blob = blur > 0 ? await blurred(source.img, blur) : source.blob;
    if (t === token) show(URL.createObjectURL(blob), null);
  } catch (e) {
    if (t === token) show(null, errorMessage(e));
  }
}

async function load(path: string | null): Promise<void> {
  const t = ++token;
  source?.img.close();
  source = null;
  if (!path) return show(null, null);
  try {
    const data = await api.readImage(path);
    const blob = await (await fetch(`data:${data.mime};base64,${data.base64}`)).blob();
    const img = await createImageBitmap(blob);
    if (t !== token) return img.close();
    source = { blob, img };
    await render();
  } catch (e) {
    if (t === token) show(null, errorMessage(e));
  }
}

applyVars(useBackdrop.getState());
void load(useBackdrop.getState().path);
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
  if (next.path !== prev.path) void load(next.path);
  else if (next.blur !== prev.blur) {
    clearTimeout(reblur);
    reblur = setTimeout(() => void render(), 150);
  }
}
