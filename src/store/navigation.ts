// Navigate Back / Forward (Ctrl+Alt+Left/Right, Cmd+[ / Cmd+], the mouse's
// back and forward buttons) over the places of lib/navHistory.
import { emptyHistory, navHistories, recordPlace, stepPlace, type Place } from "../lib/navHistory";
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

/** Goes one place back (-1) or forward (1) in `projectId`. Returns whether there was one. */
export function navigate(projectId: string, delta: -1 | 1): boolean {
  const ws = useWorkspace.getState();
  if (!ws.ui[projectId]) return false;
  const step = stepPlace(navHistories.get(projectId) ?? emptyHistory(), delta);
  if (!step) return false;
  navHistories.set(projectId, step.history);
  const { path, line, column, group } = step.place;
  going = { projectId, place: step.place, until: Date.now() + 1500 };
  // A group closed since opens it in the active one.
  ws.openFile(projectId, path, { line, column, group });
  return true;
}
