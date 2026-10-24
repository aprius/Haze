// A GIF or video background playing (src/lib/backdrop.ts reads it). A video
// is shown as it is when unblurred; a GIF is decoded and played here
// (src/lib/gif.ts), since a canvas draws an animated <img> as its first frame.
// Blurred, each frame is drawn on a small canvas (drawBlurred). Frames are
// drawn when the file moves on, at most 30 times a second, 10 while Haze is not
// focused, and not at all while the window is hidden or the background is not
// shown; nothing runs in between, rather than every display frame. The ambient
// glow follows the frames twice a second. Popups and windows of their own show
// the first frame.
import { blurredSize, drawBlurred, useBackdrop, useBackdropImage } from "./backdrop";
import { sampleLive } from "./ambient";
import { GifPlayer, parseGif } from "./gif";
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
let canvas: HTMLCanvasElement | null = null;
let last = 0;
let lastSample = 0;
// What wakes the next frame: a timer for a GIF, when its next frame is due; a
// video's frame callback, when it shows a new frame (rAF, polled, without one).
let timer: ReturnType<typeof setTimeout> | undefined;
let videoCb = 0;
let raf = 0;
let lastTime = -1;

type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?(cb: (now: number) => void): number;
  cancelVideoFrameCallback?(id: number): void;
};

/** What is drawn from, and its size. */
function source(): [CanvasImageSource, number, number] | null {
  if (video) return video.videoWidth ? [video, video.videoWidth, video.videoHeight] : null;
  if (gif) return [gif.canvas, gif.gif.width, gif.gif.height];
  return null;
}

const playing = () => (!!video || !!gif) && !document.hidden && useGlass.getState().on;
const interval = () => 1000 / (document.hasFocus() ? 30 : 10);

/** The file has moved on: draws it blurred, and has the glow follow it now and then. */
function draw(now: number): void {
  last = now;
  const src = source();
  if (!src) return;
  if (canvas) drawBlurred(canvas.getContext("2d")!, src[0], src[1], src[2], blurredSize(useBackdrop.getState().blur).r);
  if (now - lastSample > 500) {
    lastSample = now;
    if (canvas) sampleLive(canvas, canvas.width, canvas.height);
    else sampleLive(...src);
  }
}

function gifTick(): void {
  timer = undefined;
  if (!gif || !playing()) return;
  const now = performance.now();
  if (now - last >= interval() - 2 && gif.advance(now)) draw(now);
  const at = Math.max(gif.due, last + interval());
  if (at !== Infinity) timer = setTimeout(gifTick, Math.max(0, at - performance.now()));
}

function videoTick(now: number): void {
  videoCb = 0;
  raf = 0;
  const v = video as FrameVideo | null;
  if (!v || !playing()) return;
  if (v.requestVideoFrameCallback) videoCb = v.requestVideoFrameCallback(videoTick);
  else {
    raf = requestAnimationFrame(videoTick);
    if (v.currentTime === lastTime) return;
  }
  if (now - last < interval() - 2) return;
  lastTime = v.currentTime;
  draw(now);
}

function stop(): void {
  clearTimeout(timer);
  timer = undefined;
  if (videoCb) (video as FrameVideo | null)?.cancelVideoFrameCallback?.(videoCb);
  videoCb = 0;
  cancelAnimationFrame(raf);
  raf = 0;
}

function run(): void {
  const on = playing();
  stop();
  if (video) {
    if (on) void video.play().catch(() => {});
    else video.pause();
  }
  if (!on) return;
  if (gif) gifTick();
  else if (video) videoTick(performance.now());
}

/**
 * Blurred: a canvas at blurredSize over the video (which stays laid out under
 * it: WebKit pauses a video it does not show). Unblurred: the video, or the
 * GIF's own canvas.
 */
function layout(): void {
  const blur = useBackdrop.getState().blur;
  lastTime = -1;
  if ((!video && !gif) || blur === 0) {
    canvas?.remove();
    canvas = null;
    if (gif && !gif.canvas.isConnected) host.appendChild(gif.canvas);
    return;
  }
  gif?.canvas.remove();
  const { w, h } = blurredSize(blur);
  if (!canvas) {
    canvas = document.createElement("canvas");
    host.appendChild(canvas);
  }
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  // The current frame now, not when the file next moves on.
  const src = source();
  if (src) drawBlurred(canvas.getContext("2d")!, src[0], src[1], src[2], blurredSize(blur).r);
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
    v.src = live.url;
    v.className = "backdrop-media";
    host.prepend(v);
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
useBackdrop.subscribe((s, prev) => s.blur !== prev.blur && layout());
useGlass.subscribe(run);
document.addEventListener("visibilitychange", run);
void setMedia(useBackdropImage.getState().live);
