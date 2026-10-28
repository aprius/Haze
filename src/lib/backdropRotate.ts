// A background that changes by itself (Settings > Background > Folder): every
// few minutes it picks another image or video from a folder, at random or in
// order of name. By day it picks from the folder's `days` folder, by night
// from its `nights` one; without one (or with it empty) from the folder's own
// files. Day and night start at the times set. Each change fades over the one
// before (cover() in backdropLive.ts). The folder is read again at each pick,
// so files added to it join in. Nothing changes while the window is hidden:
// the change waits until it is shown.
import { create } from "zustand";
import { setBackdrop, useBackdrop, useBackdropImage } from "./backdrop";
import { cover } from "./backdropLive";
import { api, errorMessage } from "./ipc";
import { periodAt, pick, poolFor, type Period } from "./backdropPick";

/** What the folder holds, as last read, and why it could not be. */
export const useRotation = create<{ day: number; night: number; root: number; period: Period | null; error: string | null }>(() => ({
  day: 0,
  night: 0,
  root: 0,
  period: null,
  error: null,
}));

// When the last pick was made and in which period, kept across starts so a
// start does not change the background before its time.
const KEY = "haze.backdrop.rotated";
interface Rotated {
  at: number;
  period: Period;
  folder: string;
}
function lastRotated(): Rotated | null {
  try {
    const r = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return r && typeof r.at === "number" && (r.period === "day" || r.period === "night") && typeof r.folder === "string" ? r : null;
  } catch {
    return null;
  }
}
function saveRotated(r: Rotated): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(r));
  } catch {}
}

let busy = false;
/** A pick asked for while the window was hidden or another was under way. */
let pending = false;

/** Picks the next background now if it is due, or always with `force`. */
async function tick(force = false): Promise<void> {
  const s = useBackdrop.getState();
  const folder = s.folder;
  if (!folder) return;
  if (busy || document.hidden) {
    pending ||= force;
    return;
  }
  const period = periodAt(new Date(), s);
  const last = lastRotated();
  const fresh = last?.folder === folder;
  const now = Date.now();
  // The clock going back (or set by hand) counts as up.
  const timeUp = !fresh || last.at > now || now - last.at >= s.interval * 60_000;
  const due = force || !fresh || last.period !== period || !s.path || (s.interval > 0 && timeUp);
  // Not due, and the folder read already (for Settings' counts).
  if (!due && useRotation.getState().period === period) return;
  busy = true;
  try {
    let list;
    try {
      list = await api.listBackdropFolder(folder);
    } catch (e) {
      useRotation.setState({ error: errorMessage(e), period });
      return;
    }
    if (useBackdrop.getState().folder !== folder) return;
    const pool = poolFor(list, period);
    useRotation.setState({ day: list.day.length, night: list.night.length, root: list.root.length, period, error: pool.length ? null : "no images or videos in it" });
    if (!due) return;
    // The period turned, but what shows is one of its own too and its time is
    // not up: keep it, and when it was picked.
    if (!force && fresh && s.interval > 0 && !timeUp && !!s.path && pool.includes(s.path)) {
      saveRotated({ at: last.at, period, folder });
      return;
    }
    if (!pool.length) return;
    saveRotated({ at: Date.now(), period, folder });
    // A file that cannot be shown gives way to another, a few times over.
    const tried = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const next = pick(pool.filter((p) => !tried.has(p)), useBackdrop.getState().path, s.shuffle);
      if (!next) return;
      tried.add(next);
      if (next === useBackdrop.getState().path && !useBackdropImage.getState().error) return;
      const reveal = cover();
      try {
        await setBackdrop({ path: next });
      } finally {
        reveal();
      }
      if (useBackdrop.getState().folder !== folder || !useBackdropImage.getState().error) return;
    }
  } finally {
    busy = false;
    if (pending) {
      pending = false;
      void tick(true);
    }
  }
}

/** Shows the next background from the folder now (Settings' Next). */
export const rotateNow = () => void tick(true);

// The minute is checked rather than a timer set for the next pick: a timer
// sleeps with the Mac and wakes late. Only while there is a folder.
let clock: ReturnType<typeof setInterval> | undefined;
function runClock(on: boolean): void {
  clearInterval(clock);
  clock = on ? setInterval(() => void tick(), 30_000) : undefined;
}
runClock(!!useBackdrop.getState().folder);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  const force = pending;
  pending = false;
  void tick(force);
});
useBackdrop.subscribe((s, prev) => {
  if (s.folder !== prev.folder) {
    useRotation.setState({ day: 0, night: 0, root: 0, period: null, error: null });
    runClock(!!s.folder);
    void tick(!!s.folder);
  } else if (s.dayStart !== prev.dayStart || s.nightStart !== prev.nightStart || s.interval !== prev.interval) void tick();
});
void tick();
