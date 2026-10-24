// The background image behind the islands layout (src/lib/backdrop.ts), in the
// main window and in Commit/Diff windows of their own; shown by CSS only there.
import { useBackdropImage } from "../lib/backdrop";
import { liveRef } from "../lib/backdropLive";

/** `live`: in the main window, where a video plays; elsewhere its first frame. */
export function Backdrop({ live }: { live?: boolean }) {
  const url = useBackdropImage((s) => s.url);
  if (!url) return null;
  // The image is --backdrop-url, set with it.
  return <div ref={live ? liveRef : undefined} className="backdrop" aria-hidden />;
}
