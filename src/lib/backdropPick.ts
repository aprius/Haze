// What a rotating background (backdropRotate.ts) shows when: day or night,
// the files for each, and the next pick among them.
import type { BackdropSettings } from "./backdrop";

export type Period = "day" | "night";

const minuteOfDay = (d: Date) => d.getHours() * 60 + d.getMinutes();

/** Day or night at `d`; with the same start for both, always day. */
export function periodAt(d: Date, s: Pick<BackdropSettings, "dayStart" | "nightStart">): Period {
  const m = minuteOfDay(d);
  const { dayStart: a, nightStart: b } = s;
  const day = a < b ? m >= a && m < b : a === b || m >= a || m < b;
  return day ? "day" : "night";
}

/** The files to pick from in `period`. */
export function poolFor(list: { root: string[]; day: string[]; night: string[] }, period: Period): string[] {
  const own = period === "day" ? list.day : list.night;
  if (own.length) return own;
  if (list.root.length) return list.root;
  // Only the other period's: better than nothing.
  return period === "day" ? list.night : list.day;
}

/** The next pick from `pool` after `current`: at random (never the same one twice running), or the next by name. */
export function pick(pool: string[], current: string | null, shuffle: boolean, random = Math.random): string | null {
  if (!pool.length) return null;
  if (shuffle) {
    const others = pool.length > 1 ? pool.filter((p) => p !== current) : pool;
    return others[Math.floor(random() * others.length)];
  }
  const i = current ? pool.indexOf(current) : -1;
  return pool[(i + 1) % pool.length];
}
