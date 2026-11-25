// Navigate Back / Forward, like Rider's: the places the caret was, per project.
// A move of fewer than NEAR_LINES lines in the same file updates the current
// place; a farther one (Go to Definition, a usage, another file) adds a place
// and drops the ones ahead of it, as a browser's history does.

export interface Place {
  path: string;
  line: number;
  column: number;
  /** The editor group it was in, to go back there while it exists. */
  group?: string;
}

export interface History {
  places: Place[];
  /** The current place; -1 when there is none. */
  index: number;
}

export const NEAR_LINES = 10;
export const MAX_PLACES = 50;

export const emptyHistory = (): History => ({ places: [], index: -1 });

export function recordPlace(h: History, p: Place): History {
  const cur = h.places[h.index];
  if (cur && cur.path === p.path && Math.abs(cur.line - p.line) < NEAR_LINES) {
    if (cur.line === p.line && cur.column === p.column && cur.group === p.group) return h;
    const places = h.places.slice();
    places[h.index] = p;
    return { places, index: h.index };
  }
  const places = [...h.places.slice(0, h.index + 1), p].slice(-MAX_PLACES);
  return { places, index: places.length - 1 };
}

/** The nearest place `delta` steps back (-1) or forward (1) that `usable` accepts, and the history moved to it. */
export function stepPlace(h: History, delta: -1 | 1, usable: (p: Place) => boolean = () => true): { history: History; place: Place } | null {
  for (let i = h.index + delta; i >= 0 && i < h.places.length; i += delta) {
    if (usable(h.places[i])) return { history: { places: h.places, index: i }, place: h.places[i] };
  }
  return null;
}

/** Without the places `gone` accepts (deleted files); neighbours that now are the same place merge. */
export function dropPlaces(h: History, gone: (path: string) => boolean): History {
  if (!h.places.some((p) => gone(p.path))) return h;
  const places: Place[] = [];
  let index = -1;
  h.places.forEach((p, i) => {
    if (!gone(p.path)) {
      const last = places[places.length - 1];
      if (!last || last.path !== p.path || last.line !== p.line) places.push(p);
    }
    if (i === h.index) index = places.length - 1;
  });
  return { places, index: places.length ? Math.max(index, 0) : -1 };
}

/** With paths rewritten after a rename or move. */
export function renamePlaces(h: History, map: (path: string) => string): History {
  let changed = false;
  const places = h.places.map((p) => {
    const path = map(p.path);
    if (path === p.path) return p;
    changed = true;
    return { ...p, path };
  });
  return changed ? { places, index: h.index } : h;
}

/** Each project's history, for this session. */
export const navHistories = new Map<string, History>();

export function renameNavPaths(map: (path: string) => string): void {
  for (const [id, h] of navHistories) navHistories.set(id, renamePlaces(h, map));
}

export function forgetNavPaths(gone: (path: string) => boolean): void {
  for (const [id, h] of navHistories) navHistories.set(id, dropPlaces(h, gone));
}
