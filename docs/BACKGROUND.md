# Background images and videos

**Settings → Appearance → Background** puts an image or a video behind the Islands layout. The panels turn into tinted glass over it, and their opacity, the blur and the dim are adjustable. Two more options go with it:

- **Ambient glow**: each island is lit from its edges in the colours of the background behind it.
- **Agent status glow**: the terminal island glows in the state of its AI agents instead: working, waiting for you, done or failed.

Supported files: PNG, JPEG, WebP, BMP, and MP4, M4V, MOV and WebM videos. **GIFs are not supported** (see [Why not GIFs](#why-not-gifs)). Convert one to a video instead:

```sh
ffmpeg -i background.gif -movflags +faststart -pix_fmt yuv420p -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" background.mp4
```

A video stops while the window is hidden or covered, and with **Pause in background** also while no Haze window has focus.

## Performance

CPU used by each kind of background, as a percentage of one core.

| Background | CPU |
|---|---|
| None | 0.1–0.5% |
| Image | ~0% |
| Image + ambient glow | 0–0.1% |
| Video, 1080p 30 fps | 4.0–4.6% |
| Video + ambient glow | 6.0–6.3% |
| Video, no blur | 4.3–4.4% |
| GIF, 480×270 25 fps | 15.7–16.1% |
| GIF + ambient glow | ~17% |
| GIF, no blur | 14.4–14.7% |
| GIF, 1280×720 25 fps | 29.9–34.3% |

The GIF rows were measured with the GIF support that was removed afterwards. A range is the lowest and highest of several runs.

**How it was measured**

- Machine: Apple M4, macOS, a 2560×1440 display.
- Build: a release build with its own bundle identifier and settings, the Islands layout and the dark theme.
- Settings: blur 12, dim 30, ambient glow 40 % where it is on.
- Run: the 1400×900 window kept in front and focused, 20 s to settle, then 30 s measured.
- What counts: the CPU time of Haze's process and of the WebKit processes it started (WebContent, GPU, Networking).
- What doesn't: WindowServer, which swung between 0 % and 42 % with the same background, depending on what else the machine was doing.
- Media: made with ffmpeg's `testsrc2`, which changes every pixel in every frame, so these are worst cases. The image is a 1920×1080 JPEG and the video H.264 at 6 Mb/s.

**What it shows**

- An image costs nothing once it is shown: it is blurred once, when chosen, and kept blurred.
- The ambient glow costs nothing over an image. It adds about 2 % over a video, which it samples every two seconds.
- A video costs about 4 %. macOS decodes it in hardware, and WebKit hands its frames to the compositor as a video layer, which blurs them on the GPU.

## Why not GIFs

A GIF cost three to seven times what a 1080p video does, and the cost was in how a GIF has to be drawn, not in the file:

- **No way to the GPU.** WebKit plays an animated GIF only in an `<img>`. On a canvas it draws just the first frame, and it has no `ImageDecoder` either. So Haze decoded the GIF itself in JavaScript and put every frame through a 2D canvas.
- **Every frame crosses three processes.** The page process uploads the frame, the GPU process draws it, and the app process commits the changed layer. The app process alone used about 3 % for a GIF, against 0.3 % for a video.
- **Decoding was the smaller part.** It took 0.6 ms a frame at 480×270 (about 1.5 % CPU at 25 fps) and 4 ms at 1280×720. Without blur a GIF still cost 14–15 %.

Other ways of drawing it were measured too (480×270 GIF unless noted). None was both cheap and good-looking:

| Approach | CPU | Problem |
|---|---|---|
| Canvas blurred with CSS `filter` | 18.6–19.9% | Costs more |
| Canvas forced onto the CPU (`willReadFrequently`) | 16.2–19.5% | No gain |
| Canvas with a quarter of the pixels | 12.7–15.7% | Within the noise of the original |
| Native `<img>` with a CSS blur | 5.2%; 34.2% at 1280×720 | Can't be paused, throttled or sampled for the glow; costs as much at 720p |
| Tiny canvas, no filter | 6.5% | Visibly blocky: 28.5 dB PSNR against a true blur, where the original drawing reaches 59.7 dB |

A video of the same animation is smaller, decoded in hardware and blurred by the GPU, so Haze takes videos only.
