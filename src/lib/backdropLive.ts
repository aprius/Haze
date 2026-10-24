// A GIF or video background playing (src/lib/backdrop.ts reads it). A video
// plays in a <video>; a GIF is decoded and played on a canvas here
// (src/lib/gif.ts), since nothing plays an animated <img> on a canvas.
// Blurred, a video is blurred by CSS: WebKit blurs a video layer on the GPU as
// it composites it, where drawing each frame onto a canvas to blur it took
// about twice the CPU (1080p at 30 fps). A canvas blurred by CSS costs more
// instead, so a GIF's frames are drawn blurred onto a small canvas
// (drawBlurred). GIF frames move on at most 30 times a second, 10 while Haze
// is not focused; nothing plays while the window is hidden or the background
// is not shown, nor, with Pause in background, while no Haze window has
// focus. A video plays from loopback HTTP (backdrop.ts), not a blob: URL. The
// ambient glow follows a GIF twice a second, a video every two seconds. Popups
// and windows of their own show the first frame.
import { blurredSize, drawBlurred, useBackdrop, useBackdropImage } from "./backdrop";
import { sampleLive } from "./ambient";
import { GifPlayer, parseGif } from "./gif";
import { onAppActive } from "./ipc";
import { useGlass } from "./theme";

const host = document.createElement("div");
host.className = "backdrop-live";

/** Ref for the main window's backdrop: the playing background goes in it. */
export function liveRef(el: HTMLElement | null): (() => void) | void {
  if (!el) return;
  el.appendChild(host);
  return () => host.remove();
}

let video: HTMLVideoElement | null = null;
let gif: GifPlayer | null = null;
/** The GIF's frames blurred, when they are. */
let canvas: HTMLCanvasElement | null = null;
let last = 0;
// The GIF's next frame, when it is due; the glow's next sample.
let timer: ReturnType<typeof setTimeout> | undefined;
let sampler: ReturnType<typeof setTimeout> | undefined;

/** What plays, and its size. */
function source(): [HTMLVideoElement | HTMLCanvasElement, number, number] | null {
  if (video) return video.videoWidth ? [video, video.videoWidth, video.videoHeight] : null;
  if (gif) return [gif.canvas, gif.gif.width, gif.gif.height];
  return null;
}

/** Whether a Haze window has focus: any of them, popups' windows too. */
let active = document.hasFocus();

const playing = () =>
  (!!video || !!gif) && !document.hidden && useGlass.getState().on && (active || !useBackdrop.getState().pauseInBackground);
const interval = () => 1000 / (active ? 30 : 10);

function gifTick(): void {
  timer = undefined;
  if (!gif || !playing()) return;
  const now = performance.now();
  if (now - last >= interval() - 2 && gif.advance(now)) {
    last = now;
    drawGif();
  }
  const at = Math.max(gif.due, last + interval());
  if (at !== Infinity) timer = setTimeout(gifTick, Math.max(0, at - performance.now()));
}

function drawGif(): void {
  if (gif && canvas) drawBlurred(canvas.getContext("2d")!, gif.canvas, gif.gif.width, gif.gif.height, blurredSize(useBackdrop.getState().blur).r);
}

function sample(): void {
  sampler = undefined;
  if (!playing()) return;
  const src: [CanvasImageSource, number, number] | null = canvas ? [canvas, canvas.width, canvas.height] : source();
  if (src && useBackdrop.getState().ambient > 0) sampleLive(...src);
  // Reading a video's frame costs WebKit more than drawing it: every 500 ms,
  // 4% CPU more (1080p).
  sampler = setTimeout(sample, video ? 2000 : 500);
}

function stop(): void {
  clearTimeout(timer);
  clearTimeout(sampler);
  timer = sampler = undefined;
}

function run(): void {
  const on = playing();
  stop();
  if (video) {
    if (on) void video.play().catch(() => {});
    else video.pause();
  }
  if (!on) return;
  gifTick();
  sample();
}

function layout(): void {
  const blur = useBackdrop.getState().blur;
  host.style.setProperty("--live-blur", `${blur}px`);
  video?.classList.toggle("blurred", blur > 0);
  if (!gif || blur === 0) {
    canvas?.remove();
    canvas = null;
    if (gif && !gif.canvas.isConnected) host.appendChild(gif.canvas);
    return;
  }
  gif.canvas.remove();
  const { w, h } = blurredSize(blur);
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.className = "backdrop-media";
    host.appendChild(canvas);
  }
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  // The current frame now, not when the GIF next moves on.
  drawGif();
}

let token = 0;
async function setMedia(live: { url: string; kind: "gif" | "video" } | null): Promise<void> {
  const t = ++token;
  stop();
  video?.pause();
  video?.removeAttribute("src");
  video?.remove();
  gif?.canvas.remove();
  video = null;
  gif = null;
  sampleLive(null);
  if (live?.kind === "video") {
    const v = document.createElement("video");
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.autoplay = true;
    // Served from loopback: the glow reads its frames, which must not taint the canvas.
    v.crossOrigin = "anonymous";
    v.src = live.url;
    v.className = "backdrop-media";
    host.appendChild(v);
    video = v;
  } else if (live?.kind === "gif") {
    try {
      const player = new GifPlayer(parseGif(new Uint8Array(await (await fetch(live.url)).arrayBuffer())));
      if (t !== token) return;
      player.canvas.className = "backdrop-media";
      player.advance(performance.now());
      gif = player;
    } catch {
      // Not a GIF we can play: its first frame, the still, stays.
      return;
    }
  }
  layout();
  run();
}

useBackdropImage.subscribe((s, prev) => s.live !== prev.live && void setMedia(s.live));
useBackdrop.subscribe((s, prev) => {
  if (s.blur !== prev.blur) layout();
  if (s.pauseInBackground !== prev.pauseInBackground) run();
});
// Focus moving from one Haze window to another blurs one before focusing the
// other: only a blur that lasts counts.
let inactive: ReturnType<typeof setTimeout> | undefined;
onAppActive((on) => {
  clearTimeout(inactive);
  if (on === active) return;
  if (on) {
    active = true;
    run();
  } else {
    inactive = setTimeout(() => {
      active = false;
      run();
    }, 200);
  }
}).catch(() => {});
useGlass.subscribe(run);
document.addEventListener("visibilitychange", run);
void setMedia(useBackdropImage.getState().live);
