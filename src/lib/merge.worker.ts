// Builds the merge window's model off the UI thread, as Rider computes its
// diffs in the background: a large scene or prefab never freezes the window.
import { buildMerge } from "./merge";

self.onmessage = (e: MessageEvent<{ ours: string; base: string; theirs: string }>) => {
  const { ours, base, theirs } = e.data;
  self.postMessage(buildMerge(ours, base, theirs));
};
