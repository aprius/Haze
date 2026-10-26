// A video background playing (src/lib/backdrop.ts reads it), in a <video>.
// Blurred, it is blurred by CSS: WebKit blurs a video layer on the GPU as it
// composites it, where drawing each frame onto a canvas to blur it took about
// twice the CPU (1080p at 30 fps). Nothing plays while the window is hidden or
// the background is not shown, nor, with Pause in background, while no Haze
// window has focus. It plays from loopback HTTP (backdrop.ts), not a blob:
// URL. The ambient glow follows it every two seconds. Popups and windows of
// their own show the first frame. GIFs are not supported: each frame goes
// through a canvas, which cost three to seven times what a 1080p video does
// (docs/BACKGROUND.md).
import { useBackdrop, useBackdropImage } from "./backdrop";
import { sampleLive } from "./ambient";
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
/** The glow's next sample. */
let sampler: ReturnType<typeof setTimeout> | undefined;

/** Whether a Haze window has focus: any of them, popups' windows too. */
let active = document.hasFocus();

const playing = () => !!video && !document.hidden && useGlass.getState().on && (active || !useBackdrop.getState().pauseInBackground);

function sample(): void {
  sampler = undefined;
  if (!video || !playing()) return;
  if (video.videoWidth && useBackdrop.getState().ambient > 0) sampleLive(video, video.videoWidth, video.videoHeight);
  // Reading a video's frame costs WebKit more than drawing it: every 500 ms,
  // 4% CPU more (1080p).
  sampler = setTimeout(sample, 2000);
}

function run(): void {
  const on = playing();
  clearTimeout(sampler);
  sampler = undefined;
  if (!video) return;
  if (!on) return video.pause();
  start(video);
  sample();
}

/** play() can be refused (WebKit suspends a video while the window is in the
 * background): retry, or it stays stopped after focus returns. */
let retry: ReturnType<typeof setTimeout> | undefined;
function start(v: HTMLVideoElement, tries = 0): void {
  clearTimeout(retry);
  if (v !== video || !playing() || !v.paused) return;
  v.play().catch(() => {
    if (tries < 5) retry = setTimeout(() => start(v, tries + 1), 300 * (tries + 1));
  });
}

function layout(): void {
  const blur = useBackdrop.getState().blur;
  host.style.setProperty("--live-blur", `${blur}px`);
  video?.classList.toggle("blurred", blur > 0);
}

function setMedia(url: string | null): void {
  clearTimeout(retry);
  clearTimeout(sampler);
  sampler = undefined;
  video?.pause();
  video?.removeAttribute("src");
  // Without load(), it keeps its decoder and connection until collected.
  video?.load();
  video?.remove();
  video = null;
  sampleLive(null);
  if (url) {
    const v = document.createElement("video");
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.autoplay = true;
    // Served from loopback: the glow reads its frames, which must not taint the canvas.
    v.crossOrigin = "anonymous";
    v.src = url;
    v.className = "backdrop-media";
    host.appendChild(v);
    // Paused by the system while it should play, or stalled: start it again.
    v.addEventListener("pause", () => playing() && start(v));
    v.addEventListener("stalled", () => playing() && start(v));
    video = v;
  }
  layout();
  run();
}

useBackdropImage.subscribe((s, prev) => s.live !== prev.live && setMedia(s.live));
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
// The window's own focus events back up app://active, which can be missed or
// leave `active` stale.
window.addEventListener("focus", () => {
  clearTimeout(inactive);
  active = true;
  run();
});
useGlass.subscribe(run);
document.addEventListener("visibilitychange", run);
setMedia(useBackdropImage.getState().live);
