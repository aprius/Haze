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
//
// With Agent status glow on, the terminal island glows instead in the state of
// the active project's agents (the rail's badge, src/components/Shell.tsx):
// failed, waiting for you, done until seen, or working, fainter.
import { useTerminals } from "../store/terminals";
import { useWorkspace } from "../store/workspace";
import { useBackdrop, useBackdropImage } from "./backdrop";
import { useGlass, useTheme } from "./theme";

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

/** Draws `src` (sw × sh) into the grid as the window shows it (cover). */
function toGrid(src: CanvasImageSource, sw: number, sh: number): Uint8ClampedArray {
  const k = Math.max(innerWidth / sw, innerHeight / sh);
  const sx = GW / innerWidth;
  const sy = GH / innerHeight;
  if (!gridCtx) {
    const c = document.createElement("canvas");
    c.width = GW;
    c.height = GH;
    gridCtx = c.getContext("2d", { willReadFrequently: true })!;
    gridCtx.imageSmoothingQuality = "high";
  }
  const ctx = gridCtx;
  ctx.clearRect(0, 0, GW, GH);
  const dw = sw * k;
  const dh = sh * k;
  ctx.drawImage(src, ((innerWidth - dw) / 2) * sx, ((innerHeight - dh) / 2) * sy, dw * sx, dh * sy);
  return ctx.getImageData(0, 0, GW, GH).data;
}
let gridCtx: CanvasRenderingContext2D | null = null;

/**
 * A frame of a playing video (backdropLive.ts), or null once it stops:
 * the light eases towards its colours rather than jumping to them.
 */
export function sampleLive(src: CanvasImageSource | null, sw = 0, sh = 0): void {
  if (!src) {
    if (gridFor === LIVE) gridFor = "";
    return;
  }
  const next = toGrid(src, sw, sh);
  if (grid && gridFor === LIVE) for (let i = 0; i < next.length; i++) next[i] = (grid[i] + next[i]) / 2;
  grid = next;
  gridFor = LIVE;
  schedule();
}
const LIVE = "live";

// The image, decoded once and kept small: the window resizing samples it again
// every frame.
let small: { url: string; canvas: HTMLCanvasElement } | null = null;

async function sample(url: string): Promise<void> {
  const key = `${url} ${innerWidth}x${innerHeight}`;
  if (key === gridFor || gridFor === LIVE) return;
  gridFor = key;
  try {
    if (small?.url !== url) {
      const img = await createImageBitmap(await (await fetch(url)).blob());
      const canvas = document.createElement("canvas");
      canvas.width = 4 * GW;
      canvas.height = Math.max(1, Math.round((4 * GW * img.height) / img.width));
      const ctx = canvas.getContext("2d")!;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      img.close();
      small = { url, canvas };
    }
    const data = toGrid(small.canvas, small.canvas.width, small.canvas.height);
    if (gridFor === key) grid = data;
  } catch {
    if (gridFor === key) grid = null;
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

type AgentLight = "error" | "waiting" | "done" | "working";
const AGENT_LIGHT: Record<AgentLight, [colour: string, alpha: number]> = {
  error: ["--mk-red", 0.7],
  waiting: ["--mk-yellow", 0.7],
  done: ["--mk-green", 0.55],
  working: ["--mk-cyan", 0.35],
};

function agentLight(): AgentLight | null {
  if (!useBackdrop.getState().agentGlow) return null;
  const { sessions, attention } = useTerminals.getState();
  const project = useWorkspace.getState().activeProjectId;
  const mine = Object.entries(sessions).filter(([, x]) => x.projectId === project);
  if (mine.some(([id, x]) => x.agent?.state === "error" && attention[id])) return "error";
  if (mine.some(([, x]) => x.agent?.state === "waiting")) return "waiting";
  if (mine.some(([id]) => attention[id])) return "done";
  return mine.some(([, x]) => x.agent?.state === "working") ? "working" : null;
}

/** The theme's colour for an agent state, as the canvas takes it; read once a theme. */
const colours = new Map<AgentLight, string>();
function agentColour(light: AgentLight): string {
  const known = colours.get(light);
  if (known) return known;
  const [name, alpha] = AGENT_LIGHT[light];
  const hex = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const n = parseInt(hex.slice(1), 16);
  const c = `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  colours.set(light, c);
  return c;
}

function setOn(on: boolean): void {
  if (on) document.documentElement.dataset.ambient = "";
  else delete document.documentElement.dataset.ambient;
}

async function update(): Promise<void> {
  frame = 0;
  const url = useBackdropImage.getState().url;
  const strength = useBackdrop.getState().ambient;
  const agent = (lastAgent = agentLight());
  // Not shown outside the islands layout: not drawn either.
  if (!url || !useGlass.getState().on || (strength <= 0 && !agent)) return setOn(false);
  if (strength > 0) await sample(url);
  if (!grid && !agent) return setOn(false);
  const agentFill = agent && agentColour(agent);
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
  const all = [...islands].map((el) => ({ r: el.getBoundingClientRect(), terminal: el.classList.contains("side-dock") }));
  const lit = all.filter(({ r }) => r.width && r.height);
  // Each edge's band drawn far off the canvas, its shadow alone brought back:
  // a blur every canvas has, unlike ctx.filter.
  const off = 4 * (innerWidth + innerHeight);
  ctx.shadowOffsetX = off * SCALE;
  ctx.shadowBlur = BLUR * SCALE;
  for (const { r, terminal } of lit) {
    const fill = terminal && agentFill ? agentFill : null;
    if (!fill && (strength <= 0 || !grid)) continue;
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
      ctx.shadowColor = fill ?? light(x0, y0, x1, y1, strength / 100);
      ctx.fillRect(x - off, y, ew, eh);
    }
  }
  // Light only around the islands, as a box-shadow casts it, not under their glass.
  ctx.shadowColor = "transparent";
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  for (const { r } of lit) {
    if (ctx.roundRect) ctx.roundRect(r.left, r.top, r.width, r.height, RADIUS);
    else ctx.rect(r.left, r.top, r.width, r.height);
  }
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";
  setOn(true);
}

useBackdropImage.subscribe(schedule);
useGlass.subscribe(schedule);
useBackdrop.subscribe((s, prev) => (s.ambient !== prev.ambient || s.agentGlow !== prev.agentGlow) && schedule());
// Agents report on every tool they use: drawn again only when the light changes.
let lastAgent: AgentLight | null = null;
const agentChanged = () => agentLight() !== lastAgent && schedule();
useTerminals.subscribe((s, prev) => (s.sessions !== prev.sessions || s.attention !== prev.attention) && agentChanged());
useWorkspace.subscribe((s, prev) => s.activeProjectId !== prev.activeProjectId && agentChanged());
useTheme.subscribe(() => {
  colours.clear();
  schedule();
});
addEventListener("resize", schedule);
