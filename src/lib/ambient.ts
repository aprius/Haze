// Ambient glow (Settings > Appearance > Ambient glow), with a background image
// in the islands layout: each island casts light from its edges, in the colours
// of the image behind each edge, like a TV's ambilight. The image is sampled
// once into a small grid laid out as the window shows it (cover); each island
// edge takes the colour of the cells under it.
//
// The light is drawn on one canvas behind the islands, at a quarter of the
// window's size and scaled up (it is blurred, so that costs nothing to look
// at): box-shadows on the islands blurred again, at full resolution, whenever
// an island changed size, and doubled the frames a splitter drag dropped.
// Drawing it is about a millisecond, so it follows a drag live. Islands
// register with glowRef and are drawn again when they change size, once a
// frame at most (moving one changes its or a neighbour's size).
import { useBackdrop, useBackdropImage } from "./backdrop";

const GW = 48;
const GH = 30;
/** Canvas pixels per window pixel. */
const SCALE = 0.25;
/** The light's reach, in window pixels, and how far it starts inside the edge. */
const BLUR = 22;
const BAND = 6;
/** The islands' corner radius (styles.css, islands layout). */
const RADIUS = 10;

let grid: Uint8ClampedArray | null = null;
let gridFor = "";

const islands = new Set<HTMLElement>();
const ro = new ResizeObserver(() => schedule());

const canvas = document.createElement("canvas");
canvas.className = "ambient";
canvas.setAttribute("aria-hidden", "true");
document.body.appendChild(canvas);

/** Ref for an island: `ref={glowRef}`. */
export function glowRef(el: HTMLElement | null): (() => void) | void {
  if (!el) return;
  islands.add(el);
  ro.observe(el);
  schedule();
  return () => {
    islands.delete(el);
    ro.unobserve(el);
    schedule();
  };
}

let frame = 0;
function schedule(): void {
  if (!frame) frame = requestAnimationFrame(() => void update());
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
    const c = document.createElement("canvas");
    c.width = GW;
    c.height = GH;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
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
  return `hsla(${h.toFixed(0)}, ${Math.min(100, s * 130).toFixed(0)}%, ${Math.min(70, Math.max(45, l * 100)).toFixed(0)}%, ${alpha})`;
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

function setOn(on: boolean): void {
  if (on) document.documentElement.dataset.ambient = "";
  else delete document.documentElement.dataset.ambient;
}

async function update(): Promise<void> {
  frame = 0;
  const url = useBackdropImage.getState().url;
  const strength = useBackdrop.getState().ambient;
  if (!url || strength <= 0) return setOn(false);
  await sample(url);
  if (!grid) return;
  const w = Math.max(1, Math.round(innerWidth * SCALE));
  const h = Math.max(1, Math.round(innerHeight * SCALE));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.scale(SCALE, SCALE);
  const rects = [...islands].map((el) => el.getBoundingClientRect()).filter((r) => r.width && r.height);
  // Each edge's band drawn far off the canvas, its shadow alone brought back:
  // a blur every canvas has, unlike ctx.filter.
  const off = 4 * (innerWidth + innerHeight);
  ctx.shadowOffsetX = off * SCALE;
  ctx.shadowBlur = BLUR * SCALE;
  for (const r of rects) {
    // The band of image under each edge: a fifth of the island, at most 120px.
    const bw = Math.min(120, r.width / 5);
    const bh = Math.min(120, r.height / 5);
    const edges: [number[], number[]][] = [
      [[r.left, r.top, r.right, r.top + bh], [r.left, r.top - BAND, r.width, 2 * BAND]],
      [[r.right - bw, r.top, r.right, r.bottom], [r.right - BAND, r.top, 2 * BAND, r.height]],
      [[r.left, r.bottom - bh, r.right, r.bottom], [r.left, r.bottom - BAND, r.width, 2 * BAND]],
      [[r.left, r.top, r.left + bw, r.bottom], [r.left - BAND, r.top, 2 * BAND, r.height]],
    ];
    for (const [[x0, y0, x1, y1], [x, y, ew, eh]] of edges) {
      ctx.shadowColor = light(x0, y0, x1, y1, strength / 100);
      ctx.fillRect(x - off, y, ew, eh);
    }
  }
  // Light only around the islands, as a box-shadow casts it, not under their glass.
  ctx.shadowColor = "transparent";
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  for (const r of rects) {
    if (ctx.roundRect) ctx.roundRect(r.left, r.top, r.width, r.height, RADIUS);
    else ctx.rect(r.left, r.top, r.width, r.height);
  }
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";
  setOn(true);
}

useBackdropImage.subscribe(schedule);
useBackdrop.subscribe((s, prev) => s.ambient !== prev.ambient && schedule());
addEventListener("resize", schedule);
