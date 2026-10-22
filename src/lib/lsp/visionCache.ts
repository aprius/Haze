// Code Vision answers ("3 usages", "aprius +1") by file and symbol, so a lens
// shows at once: the last answer while a new one is worked out in the
// background, and the editor redraws only when it changed.
//
// Speed is not only for show: Monaco waits as long between resolves as the
// last batch of resolves took (up to a minute). Resolves that wait on Roslyn
// (references across a Unity solution) or on git blame would slow every
// scroll and edit after them; resolves answered from here keep it at 250 ms.

export interface VisionAnswer {
  title: string;
  tooltip?: string;
  /** Usages: the count. */
  n?: number;
  /** From a server with its projects loaded: may grey an unused member. */
  real: boolean;
}

interface Entry {
  answer: VisionAnswer;
  /** `generation` it was worked out in; older ones are shown but asked again. */
  gen: number;
}

/** How long a lens with no answer yet waits for one before showing empty (it fills in later). */
export const QUICK_MS = 120;
const MAX_ENTRIES = 20_000;
/** Usage counts kept across restarts (authors come back quickly from git). */
const MAX_SAVED = 8_000;
const STORAGE_KEY = "haze.codeVision.v1";

const entries = new Map<string, Entry>();
const inflight = new Map<string, Promise<VisionAnswer | null>>();
let generation = 1;
let refresh: () => void = () => {};
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** What redraws Code Vision (fires the provider's onDidChange). */
export function setVisionRefresh(f: () => void): void {
  refresh = f;
}

/** Code changed (an edit, a file on disk, projects loaded): every answer may be out of date. */
export function bumpVisionGeneration(): void {
  generation++;
}

function refreshSoon() {
  refreshTimer ??= setTimeout(() => {
    refreshTimer = null;
    refresh();
  }, 150);
}

const same = (a: VisionAnswer, b: VisionAnswer) => a.title === b.title && a.tooltip === b.tooltip && a.real === b.real;

function remember(key: string, answer: VisionAnswer, gen: number) {
  // Re-inserted: Map order is the eviction order (least recently answered first).
  entries.delete(key);
  entries.set(key, { answer, gen });
  if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
  if (answer.real && answer.n !== undefined) saveSoon();
}

/**
 * A lens's answer: the current one; else the last one (`compute` runs in
 * the background unless `mayRefresh` is false, as before Roslyn has loaded
 * the projects, when it would count too few); else `compute`'s, if it comes
 * within QUICK_MS, or null (the lens fills in when it comes).
 */
export function visionAnswer(key: string, compute: () => Promise<VisionAnswer | null>, mayRefresh = true): Promise<VisionAnswer | null> {
  const hit = entries.get(key);
  if (hit && (hit.gen === generation || !mayRefresh)) return Promise.resolve(hit.answer);
  let running = inflight.get(key);
  if (!running) {
    const gen = generation;
    running = compute()
      .catch(() => null)
      .then((answer) => {
        if (answer) {
          const before = entries.get(key)?.answer;
          remember(key, answer, gen);
          if (!before || !same(before, answer)) refreshSoon();
        }
        return answer;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, running);
  }
  if (hit) return Promise.resolve(hit.answer);
  return Promise.race([running, new Promise<null>((r) => setTimeout(() => r(null), QUICK_MS))]);
}

// ------------------------------------------------------------------ kept across restarts

/** Answers from the last session: shown before Roslyn has loaded the projects, never greying. */
function load() {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return;
    for (const [key, title, tooltip, n] of JSON.parse(raw) as [string, string, string | null, number | null][])
      entries.set(key, { answer: { title, tooltip: tooltip ?? undefined, n: n ?? undefined, real: false }, gen: 0 });
  } catch {
    /* unreadable: start empty */
  }
}

function saveSoon() {
  saveTimer ??= setTimeout(() => {
    saveTimer = null;
    try {
      const rows = [...entries]
        .filter(([, e]) => e.answer.real && e.answer.n !== undefined)
        .slice(-MAX_SAVED)
        .map(([key, e]) => [key, e.answer.title, e.answer.tooltip ?? null, e.answer.n ?? null]);
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(rows));
    } catch {
      /* storage full or unavailable: answers are only kept in memory */
    }
  }, 3000);
}

load();
