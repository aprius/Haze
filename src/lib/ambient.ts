// Ambient glow (Settings > Appearance > Ambient glow), with a background image
// in the islands layout: each island casts light from its edges, in the colours
// of the image behind each edge, like a TV's ambilight. The image is sampled
// once into a small grid laid out as the window shows it (cover); each island
// then reads the cells under its edges into --glow-t/-r/-b/-l, which its
// box-shadow draws. Islands register with glowRef and are read again when they
// change size, once a frame at most (moving one changes its or a neighbour's
// size), and after a splitter drag rather than on each step of it.
import { useBackdrop, useBackdropImage } from "./backdrop";
import { afterSplitDrag, splitDragging } from "./splitDrag";

const GW = 48;
const GH = 30;
let grid: Uint8ClampedArray | null = null;
let gridFor = "";

const islands = new Set<HTMLElement>();
const ro = new ResizeObserver(() => schedule());

/** Ref for an island: `ref={glowRef}`. */
export function glowRef(el: HTMLElement | null): (() => void) | void {
  if (!el) return;
  islands.add(el);
  ro.observe(el);
  schedule();
  return () => {
    islands.delete(el);
    ro.unobserve(el);
  };
}

let frame = 0;
function schedule(): void {
  if (splitDragging()) return afterSplitDrag(schedule);
  if (!frame) frame = requestAnimationFrame(update);
}

async function sample(url: string): Promise<void> {
  const key = `${url} ${innerWidth}x${innerHeight}`;
  if (key === gridFor) return;
  gridFor = key;
  try {
    const img = await createImageBitmap(await (await fetch(url)).blob());
    // Laid out as background-size: cover shows it in the window.
    const k = Math.max(innerWidth / img.width, innerHeight / img.height);
    const sx = GW / innerWidth;
    const sy = GH / innerHeight;
    const canvas = document.createElement("canvas");
    canvas.width = GW;
    canvas.height = GH;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.imageSmoothingQuality = "high";
    const dw = img.width * k;
    const dh = img.height * k;
    ctx.drawImage(img, ((innerWidth - dw) / 2) * sx, ((innerHeight - dh) / 2) * sy, dw * sx, dh * sy);
    img.close();
    if (gridFor === key) grid = ctx.getImageData(0, 0, GW, GH).data;
  } catch {
    grid = null;
  }
}

/** The mean colour of the grid cells under a rectangle of the window, lifted to read as light. */
function light(x0: number, y0: number, x1: number, y1: number, alpha: number): string {
  const g = grid!;
  const cx0 = Math.max(0, Math.min(GW - 1, Math.floor((x0 / innerWidth) * GW)));
  const cx1 = Math.max(cx0, Math.min(GW - 1, Math.ceil((x1 / innerWidth) * GW) - 1));
  const cy0 = Math.max(0, Math.min(GH - 1, Math.floor((y0 / innerHeight) * GH)));
  const cy1 = Math.max(cy0, Math.min(GH - 1, Math.ceil((y1 / innerHeight) * GH) - 1));
  let r = 0;
  let gr = 0;
  let b = 0;
  let n = 0;
  for (let y = cy0; y <= cy1; y++) {
    for (let x = cx0; x <= cx1; x++) {
      const i = (y * GW + x) * 4;
      r += g[i];
      gr += g[i + 1];
      b += g[i + 2];
      n++;
    }
  }
  const [h, s, l] = hsl(r / n, gr / n, b / n);
  // More saturated, and neither so dark it does not show nor so bright it glares.
  return `hsl(${h.toFixed(0)} ${Math.min(100, s * 130).toFixed(0)}% ${Math.min(70, Math.max(45, l * 100)).toFixed(0)}% / ${alpha})`;
}

function hsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

const SIDES = ["t", "r", "b", "l"] as const;

async function update(): Promise<void> {
  frame = 0;
  const url = useBackdropImage.getState().url;
  const strength = useBackdrop.getState().ambient;
  const on = !!url && strength > 0;
  if (on) document.documentElement.dataset.ambient = "";
  else delete document.documentElement.dataset.ambient;
  if (!on) return;
  await sample(url);
  if (!grid) return;
  const alpha = (strength / 100).toFixed(2);
  for (const el of islands) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    // The band of image under each edge: a fifth of the island, at most 120px.
    const bw = Math.min(120, r.width / 5);
    const bh = Math.min(120, r.height / 5);
    const bands = {
      t: [r.left, r.top, r.right, r.top + bh],
      r: [r.right - bw, r.top, r.right, r.bottom],
      b: [r.left, r.bottom - bh, r.right, r.bottom],
      l: [r.left, r.top, r.left + bw, r.bottom],
    };
    for (const side of SIDES) {
      const [x0, y0, x1, y1] = bands[side];
      el.style.setProperty(`--glow-${side}`, light(x0, y0, x1, y1, Number(alpha)));
    }
  }
}

useBackdropImage.subscribe(schedule);
useBackdrop.subscribe((s, prev) => s.ambient !== prev.ambient && schedule());
addEventListener("resize", schedule);
