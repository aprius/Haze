// Navigate Back / Forward (Ctrl+Alt+Left/Right, Cmd+[ / Cmd+], the mouse's
// back and forward buttons) over the places of lib/navHistory.
import { api } from "../lib/ipc";
import { dropPlaces, emptyHistory, navHistories, recordPlace, stepPlace, type Place } from "../lib/navHistory";
import { useWorkspace } from "./workspace";

/** The place Back or Forward is opening: other caret moves until it is shown are not places. */
let going: { projectId: string; place: Place; until: number } | null = null;

/** The caret is at `place` in `projectId` (a move the user or a navigation made). */
export function notePlace(projectId: string, place: Place): void {
  // Diffs, merges and other views of Haze's own are no places to go back to.
  if (place.path.startsWith("haze-")) return;
  if (going?.projectId === projectId) {
    const arrived = going.place.path === place.path && going.place.line === place.line;
    if (!arrived && Date.now() < going.until) return;
    going = null;
  }
  navHistories.set(projectId, recordPlace(navHistories.get(projectId) ?? emptyHistory(), place));
}

// One at a time, so Back pressed twice quickly goes two places back.
let queue: Promise<unknown> = Promise.resolve();

/** Goes one place back (-1) or forward (1) in `projectId`. Resolves to whether there was one. */
export function navigate(projectId: string, delta: -1 | 1): Promise<boolean> {
  const run = queue.then(() => go(projectId, delta));
  queue = run.catch(() => {});
  return run;
}

async function go(projectId: string, delta: -1 | 1): Promise<boolean> {
  if (!useWorkspace.getState().ui[projectId]) return false;
  const missing = await missingFiles(projectId);
  // Read again after the wait: the caret may have moved meanwhile. Places added
  // since were not checked, and count as there.
  const history = navHistories.get(projectId) ?? emptyHistory();
  const step = stepPlace(history, delta, (p) => !missing.has(p.path));
  // Files deleted since (by an agent, a checkout…) leave the history. Not on
  // their "removed" events: a checkout removes files and creates them again.
  if (!step) {
    if (missing.size) navHistories.set(projectId, dropPlaces(history, (p) => missing.has(p)));
    return false;
  }
  navHistories.set(projectId, missing.size ? dropPlaces(step.history, (p) => missing.has(p)) : step.history);
  const { path, line, column, group } = step.place;
  going = { projectId, place: step.place, until: Date.now() + 1500 };
  // A group closed since opens it in the active one. A file no longer open
  // comes back as the preview tab, so going back does not pile up tabs.
  useWorkspace.getState().openFile(projectId, path, { line, column, group, preview: true });
  return true;
}

/** The files of the history's places that are gone. Decompiled and generated code (`csharp:`) is no file. */
async function missingFiles(projectId: string): Promise<Set<string>> {
  const paths = [...new Set((navHistories.get(projectId)?.places ?? []).map((p) => p.path))].filter((p) => !p.startsWith("csharp:"));
  if (!paths.length) return new Set();
  // Unknown (outside Tauri, an IPC error): as if all were there.
  const exist = await api.filesExist(paths).catch(() => paths.map(() => true));
  return new Set(paths.filter((_, i) => !exist[i]));
}
