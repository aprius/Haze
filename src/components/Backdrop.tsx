// The background image behind the islands layout (src/lib/backdrop.ts), in the
// main window and in Commit/Diff windows of their own; shown by CSS only there.
import { useBackdropImage } from "../lib/backdrop";

export function Backdrop() {
  const url = useBackdropImage((s) => s.url);
  if (!url) return null;
  // The image is --backdrop-url, set with it.
  return <div className="backdrop" aria-hidden />;
}
