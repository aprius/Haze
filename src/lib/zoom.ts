// Whole-window zoom ("Zoom IDE"): Ctrl/Cmd +/-/0 and Ctrl+wheel.
// The webview zooms natively, so the UI, editors and terminals all scale and
// re-render crisply. Kept in localStorage like the theme, to apply before the
// workspace state file has loaded.
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { create } from "zustand";
import { isMac } from "./keymap";

const KEY = "haze.zoom";
export const DEFAULT_ZOOM = 1;
const MIN = 0.5;
const MAX = 3;
const STEP = 0.1;

const clamp = (z: number) => Math.round(Math.min(MAX, Math.max(MIN, z)) * 100) / 100;

function initial(): number {
  try {
    const saved = Number(localStorage.getItem(KEY));
    if (saved > 0) return clamp(saved);
  } catch {}
  return DEFAULT_ZOOM;
}

export const useZoom = create<{ zoom: number }>(() => ({ zoom: initial() }));

function apply(zoom: number): void {
  void getCurrentWebview()
    .setZoom(zoom)
    .catch((e) => console.warn("zoom failed", e));
}

if (useZoom.getState().zoom !== DEFAULT_ZOOM) apply(useZoom.getState().zoom);

export function setZoom(zoom: number): void {
  zoom = clamp(zoom);
  if (zoom === useZoom.getState().zoom) return;
  try {
    localStorage.setItem(KEY, String(zoom));
  } catch {}
  apply(zoom);
  useZoom.setState({ zoom });
}

export const zoomIn = () => setZoom(useZoom.getState().zoom + STEP);
export const zoomOut = () => setZoom(useZoom.getState().zoom - STEP);
export const resetZoom = () => setZoom(DEFAULT_ZOOM);

// Ctrl+wheel (Cmd+wheel on macOS too). A trackpad pinch arrives as many small
// ctrl+wheel deltas, so they add up to a step rather than each being one.
let wheelSum = 0;
let wheelAt = 0;
window.addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey && !(isMac && e.metaKey)) return;
    e.preventDefault();
    e.stopPropagation();
    const now = Date.now();
    if (now - wheelAt > 300) wheelSum = 0;
    wheelAt = now;
    wheelSum += e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 33 : e.deltaY;
    if (Math.abs(wheelSum) < 50) return;
    if (wheelSum < 0) zoomIn();
    else zoomOut();
    wheelSum = 0;
  },
  { capture: true, passive: false },
);
