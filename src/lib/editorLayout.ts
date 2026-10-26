// Editor splits, as in Rider: the editor area is a tree of splits whose
// leaves are editor groups (a tab bar and an editor each). The main window has
// one tree; each detached editor window ("Open in New Window") has its own.
// Pure functions over plain data, so the store can persist it as it is.

export interface EditorTab {
  path: string;
  /** A preview tab is replaced by the next single-click open. */
  preview: boolean;
}

export interface EditorGroup {
  id: string;
  tabs: EditorTab[];
  activeTab: string | null;
}

/** "row": side by side (Split Vertically); "column": one above the other (Split Horizontally). */
export type SplitDir = "row" | "column";

export type EditorLayout = { group: string } | { split: SplitDir; children: EditorLayout[]; sizes: number[] };

export interface EditorWindow {
  id: string;
  layout: EditorLayout;
}

/** Where a group goes next to another: the side of it. */
export type Side = "left" | "right" | "top" | "bottom";

export const MAIN_GROUP = "main";

export const newGroupId = () => "g" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36);

/** Group ids of a layout, in reading order. */
export function layoutGroups(node: EditorLayout): string[] {
  return "group" in node ? [node.group] : node.children.flatMap(layoutGroups);
}

/** Places `added` beside the group `at` on `side`, splitting it in half. Unchanged if `at` is not in the layout. */
export function insertBeside(node: EditorLayout, at: string, added: string, side: Side): EditorLayout {
  const dir: SplitDir = side === "left" || side === "right" ? "row" : "column";
  const before = side === "left" || side === "top";
  const leaf = { group: added };
  if ("group" in node) {
    if (node.group !== at) return node;
    return { split: dir, children: before ? [leaf, node] : [node, leaf], sizes: [0.5, 0.5] };
  }
  const i = node.children.findIndex((c) => "group" in c && c.group === at);
  // A split the same way gains a sibling: the group's share is halved between the two.
  if (i >= 0 && node.split === dir) {
    const half = node.sizes[i] / 2;
    const children = [...node.children];
    const sizes = [...node.sizes];
    children.splice(before ? i : i + 1, 0, leaf);
    sizes.splice(i, 1, half, half);
    return { ...node, children, sizes };
  }
  return { ...node, children: node.children.map((c) => insertBeside(c, at, added, side)) };
}

/** The layout without `group`; null when nothing is left. Splits left with one child give way to it. */
export function removeGroup(node: EditorLayout, group: string): EditorLayout | null {
  if ("group" in node) return node.group === group ? null : node;
  const children: EditorLayout[] = [];
  const sizes: number[] = [];
  node.children.forEach((c, i) => {
    const kept = removeGroup(c, group);
    if (!kept) return;
    // A split inside one the same way (left behind by a removal) joins it.
    if (!("group" in kept) && kept.split === node.split) {
      kept.children.forEach((k, j) => {
        children.push(k);
        sizes.push(node.sizes[i] * kept.sizes[j]);
      });
    } else {
      children.push(kept);
      sizes.push(node.sizes[i]);
    }
  });
  if (!children.length) return null;
  if (children.length === 1) return children[0];
  const total = sizes.reduce((a, b) => a + b, 0) || 1;
  return { ...node, children, sizes: sizes.map((s) => s / total) };
}

/** Replaces the sizes of the split found by `path` (child indexes from the root). */
export function resizeSplit(node: EditorLayout, path: number[], sizes: number[]): EditorLayout {
  if ("group" in node) return node;
  if (!path.length) return { ...node, sizes };
  const [i, ...rest] = path;
  return { ...node, children: node.children.map((c, j) => (j === i ? resizeSplit(c, rest, sizes) : c)) };
}

/**
 * The group beside `group` that Rider's "Move to Opposite Group" and Unsplit
 * use: the next one in its split, or the previous at the end.
 */
export function neighbourGroup(node: EditorLayout, group: string): string | null {
  const ids = layoutGroups(node);
  const i = ids.indexOf(group);
  if (i < 0 || ids.length < 2) return null;
  return ids[i + 1] ?? ids[i - 1];
}

/**
 * Makes a saved or edited state consistent: every group in exactly one
 * layout, no layout without groups, a main layout with at least one group.
 * Tabs of groups no layout shows join the main window's first group.
 */
export function normalizeEditors(e: Partial<Editors>): Editors {
  const groups = e.groups ?? [];
  const windows = e.windows ?? [];
  const known = new Map(groups.map((g) => [g.id, g]));
  const seen = new Set<string>();
  // Leaf by leaf: a group shown twice keeps its first place only.
  const clean = (node: EditorLayout | null): EditorLayout | null => {
    if (!node) return null;
    if ("group" in node) {
      if (!known.has(node.group) || seen.has(node.group)) return null;
      seen.add(node.group);
      return node;
    }
    const children: EditorLayout[] = [];
    const sizes: number[] = [];
    node.children.forEach((c, i) => {
      const kept = clean(c);
      if (!kept) return;
      children.push(kept);
      const size = node.sizes[i];
      sizes.push(Number.isFinite(size) && size > 0 ? size : 1);
    });
    if (children.length < 2) return children[0] ?? null;
    const total = sizes.reduce((a, b) => a + b, 0);
    return { split: node.split, children, sizes: sizes.map((x) => x / total) };
  };
  let main = clean(e.layout ?? null);
  const kept = windows.map((w) => ({ ...w, layout: clean(w.layout) })).filter((w): w is EditorWindow => !!w.layout);
  let list = groups.filter((g) => seen.has(g.id));
  if (!main) {
    const g: EditorGroup = { id: newGroupId(), tabs: [], activeTab: null };
    list = [...list, g];
    main = { group: g.id };
  }
  const orphans = groups.filter((g) => !seen.has(g.id));
  if (orphans.length) {
    const first = layoutGroups(main)[0];
    list = list.map((g) => {
      if (g.id !== first) return g;
      const tabs = [...g.tabs];
      for (const t of orphans.flatMap((o) => o.tabs)) if (!tabs.some((x) => x.path === t.path)) tabs.push(t);
      return { ...g, tabs, activeTab: g.activeTab ?? tabs[0]?.path ?? null };
    });
  }
  const mainIds = layoutGroups(main);
  const mainGroup = e.mainGroup && mainIds.includes(e.mainGroup) ? e.mainGroup : mainIds[0];
  const activeGroup = e.activeGroup && list.some((g) => g.id === e.activeGroup) ? e.activeGroup : mainGroup;
  return { groups: list, layout: main, windows: kept, activeGroup, mainGroup };
}

// ------------------------------------------------------------------ editor groups

/** A project's editors: its groups, the main window's layout and the detached windows. */
export interface Editors {
  groups: EditorGroup[];
  layout: EditorLayout;
  windows: EditorWindow[];
  /** The group the next file opens in and editor commands act on. */
  activeGroup: string;
  /** The group of the main window last active: files opened from the main window go there. */
  mainGroup: string;
}

export const defaultEditors = (): Editors => ({
  groups: [{ id: MAIN_GROUP, tabs: [], activeTab: null }],
  layout: { group: MAIN_GROUP },
  windows: [],
  activeGroup: MAIN_GROUP,
  mainGroup: MAIN_GROUP,
});

export function groupById(e: Editors, id: string): EditorGroup | undefined {
  return e.groups.find((g) => g.id === id);
}

export function activeGroupOf(e: Editors): EditorGroup {
  return groupById(e, e.activeGroup) ?? groupById(e, layoutGroups(e.layout)[0]) ?? e.groups[0];
}

/** The active group's active tab: "the" open file, for the title, status bar and Project view. */
export function activeTabOf(e: Editors): string | null {
  return activeGroupOf(e)?.activeTab ?? null;
}

/** Every open tab's path, once, though several groups show it. */
export function openPaths(e: Editors): string[] {
  return [...new Set(e.groups.flatMap((g) => g.tabs.map((t) => t.path)))];
}

/** The detached window showing `group`; null for the main window. */
export function windowOf(e: Editors, group: string): EditorWindow | null {
  return e.windows.find((w) => layoutGroups(w.layout).includes(group)) ?? null;
}

const inMain = (e: Editors, group: string) => layoutGroups(e.layout).includes(group);

function setGroup(e: Editors, id: string, f: (g: EditorGroup) => EditorGroup): Editors {
  return { ...e, groups: e.groups.map((g) => (g.id === id ? f(g) : g)) };
}

/** Makes `group` the active one (and the main window's, when it is there). */
export function focusGroup(e: Editors, group: string): Editors {
  if (!groupById(e, group) || (e.activeGroup === group && (!inMain(e, group) || e.mainGroup === group))) return e;
  return { ...e, activeGroup: group, mainGroup: inMain(e, group) ? group : e.mainGroup };
}

/** The main window took focus: files opened from it go to its own group. */
export function focusMain(e: Editors): Editors {
  return inMain(e, e.activeGroup) ? e : { ...e, activeGroup: e.mainGroup };
}

export function activateTab(e: Editors, group: string, path: string): Editors {
  return focusGroup(setGroup(e, group, (g) => (g.activeTab === path ? g : { ...g, activeTab: path })), group);
}

/** Opens `path` in `group` (the active group by default), or shows it if it is open there already. */
export function openTab(e: Editors, path: string, preview: boolean, group = e.activeGroup): Editors {
  const target = groupById(e, group) ?? activeGroupOf(e);
  const opened = setGroup(e, target.id, (g) => {
    let tabs = g.tabs;
    const existing = tabs.find((t) => t.path === path);
    if (existing) {
      if (!preview && existing.preview) tabs = tabs.map((t) => (t.path === path ? { ...t, preview: false } : t));
    } else {
      const tab = { path, preview };
      const previewIdx = preview ? tabs.findIndex((t) => t.preview) : -1;
      if (previewIdx >= 0) {
        tabs = tabs.map((t, i) => (i === previewIdx ? tab : t));
      } else {
        const at = g.activeTab ? tabs.findIndex((t) => t.path === g.activeTab) + 1 : tabs.length;
        tabs = [...tabs.slice(0, at), tab, ...tabs.slice(at)];
      }
    }
    return { ...g, tabs, activeTab: path };
  });
  return focusGroup(opened, target.id);
}

export function pinTab(e: Editors, path: string): Editors {
  return { ...e, groups: e.groups.map((g) => (g.tabs.some((t) => t.path === path && t.preview) ? { ...g, tabs: g.tabs.map((t) => (t.path === path ? { ...t, preview: false } : t)) } : g)) };
}

function withoutTabs(g: EditorGroup, closing: Set<string>): EditorGroup {
  if (!g.tabs.some((t) => closing.has(t.path))) return g;
  const idx = g.tabs.findIndex((t) => t.path === g.activeTab);
  const tabs = g.tabs.filter((t) => !closing.has(t.path));
  let activeTab = g.activeTab;
  if (activeTab && closing.has(activeTab)) {
    // Activate the tab to the left of the closed one.
    activeTab = tabs.length ? tabs[Math.max(0, Math.min(idx - 1, tabs.length - 1))].path : null;
  }
  return { ...g, tabs, activeTab };
}

/**
 * Drops groups left without tabs, as Rider closes a split with its last tab
 * (the main window keeps one), and windows left without groups.
 */
function prune(e: Editors): Editors {
  const empty = e.groups.filter((g) => !g.tabs.length).map((g) => g.id);
  if (!empty.length) return e;
  let layout = e.layout;
  let windows = e.windows;
  const removed = new Set<string>();
  for (const id of empty) {
    if (inMain({ ...e, layout }, id)) {
      const next = removeGroup(layout, id);
      if (!next) continue;
      layout = next;
    } else {
      windows = windows.map((w) => ({ ...w, layout: removeGroup(w.layout, id) as EditorLayout })).filter((w) => w.layout);
    }
    removed.add(id);
  }
  if (!removed.size) return e;
  const groups = e.groups.filter((g) => !removed.has(g.id));
  const mainIds = layoutGroups(layout);
  const mainGroup = mainIds.includes(e.mainGroup) ? e.mainGroup : mainIds[0];
  const activeGroup = removed.has(e.activeGroup) ? mainGroup : e.activeGroup;
  return { groups, layout, windows, mainGroup, activeGroup };
}

/** Closes tabs in `group`, or in every group. */
export function closeTabs(e: Editors, paths: string[], group?: string): Editors {
  const closing = new Set(paths);
  return prune({ ...e, groups: e.groups.map((g) => (group && g.id !== group ? g : withoutTabs(g, closing))) });
}

/** Places a tab in `group` at `index` (the end by default), active there; moved within the group if it is in it. */
function putTab(e: Editors, group: string, tab: EditorTab, index?: number): Editors {
  return setGroup(e, group, (g) => {
    const tabs = g.tabs.filter((t) => t.path !== tab.path);
    const at = index === undefined ? tabs.length : Math.max(0, Math.min(index, tabs.length));
    // Pinned once it is moved or split, as Rider does.
    return { ...g, tabs: [...tabs.slice(0, at), { ...tab, preview: false }, ...tabs.slice(at)], activeTab: tab.path };
  });
}

/**
 * Split Vertically ("right") or Horizontally ("bottom"): a new group beside
 * `beside` (by default the tab's own group) showing `path` from `group`.
 * Copied, or with `move` (Split and Move, a tab dragged to a side) taken out of `group`.
 */
export function splitTab(e: Editors, group: string, path: string, side: Side, move: boolean, beside = group, id = newGroupId()): Editors {
  const from = groupById(e, group);
  const tab = from?.tabs.find((t) => t.path === path);
  if (!from || !tab || !groupById(e, beside) || (move && beside === group && from.tabs.length < 2)) return e;
  const win = windowOf(e, beside);
  let next: Editors = { ...e, groups: [...e.groups, { id, tabs: [], activeTab: null }] };
  next = win
    ? { ...next, windows: next.windows.map((w) => (w.id === win.id ? { ...w, layout: insertBeside(w.layout, beside, id, side) } : w)) }
    : { ...next, layout: insertBeside(next.layout, beside, id, side) };
  next = putTab(next, id, tab);
  if (move) next = setGroup(next, group, (g) => withoutTabs(g, new Set([path])));
  return focusGroup(prune(next), id);
}

/** Moves a tab to another group (dragged there, or Move to Opposite Group). */
export function moveTab(e: Editors, from: string, path: string, to: string, index?: number): Editors {
  const tab = groupById(e, from)?.tabs.find((t) => t.path === path);
  if (!tab || !groupById(e, to)) return e;
  if (from === to) return putTab(e, to, tab, index);
  let next = putTab(e, to, tab, index);
  next = setGroup(next, from, (g) => withoutTabs(g, new Set([path])));
  return focusGroup(prune(next), to);
}

/** Merges `group` into the group beside it (Unsplit). */
export function unsplit(e: Editors, group: string): Editors {
  const win = windowOf(e, group);
  const into = neighbourGroup(win ? win.layout : e.layout, group);
  const from = groupById(e, group);
  if (!into || !from) return e;
  let next = e;
  for (const t of from.tabs) if (!groupById(next, into)?.tabs.some((x) => x.path === t.path)) next = setGroup(next, into, (g) => ({ ...g, tabs: [...g.tabs, t] }));
  if (from.activeTab) next = setGroup(next, into, (g) => ({ ...g, activeTab: from.activeTab }));
  next = setGroup(next, group, (g) => ({ ...g, tabs: [], activeTab: null }));
  return focusGroup(prune(next), into);
}

/** Merges every group of the window showing `group` into it (Unsplit All). */
export function unsplitAll(e: Editors, group: string): Editors {
  const win = windowOf(e, group);
  let next = e;
  for (const id of layoutGroups(win ? win.layout : e.layout)) {
    if (id === group) continue;
    const from = groupById(next, id);
    if (!from) continue;
    next = setGroup(next, group, (g) => ({ ...g, tabs: [...g.tabs, ...from.tabs.filter((t) => !g.tabs.some((x) => x.path === t.path))] }));
    next = setGroup(next, id, (g) => ({ ...g, tabs: [] }));
  }
  return focusGroup(prune(next), group);
}

/** Moves a tab into a new window of its own (Open in New Window). */
export function detachTab(e: Editors, group: string, path: string, windowId = newGroupId(), groupId = newGroupId()): Editors {
  const tab = groupById(e, group)?.tabs.find((t) => t.path === path);
  if (!tab) return e;
  let next: Editors = {
    ...e,
    groups: [...e.groups, { id: groupId, tabs: [{ ...tab, preview: false }], activeTab: path }],
    windows: [...e.windows, { id: windowId, layout: { group: groupId } }],
  };
  next = setGroup(next, group, (g) => withoutTabs(g, new Set([path])));
  return focusGroup(prune(next), groupId);
}

/** Moves a detached window's tabs back into the main window, and closes it. */
export function dockWindow(e: Editors, windowId: string): Editors {
  const win = e.windows.find((w) => w.id === windowId);
  if (!win) return e;
  const ids = layoutGroups(win.layout);
  const into = inMain(e, e.mainGroup) ? e.mainGroup : layoutGroups(e.layout)[0];
  let next = e;
  for (const id of ids) {
    const from = groupById(next, id);
    if (!from) continue;
    next = setGroup(next, into, (g) => ({ ...g, tabs: [...g.tabs, ...from.tabs.filter((t) => !g.tabs.some((x) => x.path === t.path))] }));
    next = setGroup(next, id, (g) => ({ ...g, tabs: [] }));
  }
  return focusGroup(prune(next), into);
}

/** Rewrites tab paths (a file renamed or moved); a group then showing one twice keeps the first. */
export function mapTabPaths(e: Editors, map: (p: string) => string): Editors {
  return {
    ...e,
    groups: e.groups.map((g) => {
      const seen = new Set<string>();
      const tabs = g.tabs.map((t) => ({ ...t, path: map(t.path) })).filter((t) => !seen.has(t.path) && seen.add(t.path));
      return { ...g, tabs, activeTab: g.activeTab ? map(g.activeTab) : null };
    }),
  };
}

/**
 * Opens `path` in the group beside `group` (Rider's "Open in Right Split"),
 * splitting it to the right when it has none.
 */
export function openBeside(e: Editors, path: string, group: string, id = newGroupId()): Editors {
  const win = windowOf(e, group);
  const other = neighbourGroup(win ? win.layout : e.layout, group);
  if (other) return openTab(e, path, false, other);
  if (!groupById(e, group)) return e;
  const next: Editors = { ...e, groups: [...e.groups, { id, tabs: [], activeTab: null }] };
  const placed = win
    ? { ...next, windows: next.windows.map((w) => (w.id === win.id ? { ...w, layout: insertBeside(w.layout, group, id, "right") } : w)) }
    : { ...next, layout: insertBeside(next.layout, group, id, "right") };
  return openTab(placed, path, false, id);
}

/** Opens `path` in a new window of its own. */
export function openInNewWindow(e: Editors, path: string, windowId = newGroupId(), groupId = newGroupId()): Editors {
  return focusGroup(
    {
      ...e,
      groups: [...e.groups, { id: groupId, tabs: [{ path, preview: false }], activeTab: path }],
      windows: [...e.windows, { id: windowId, layout: { group: groupId } }],
    },
    groupId,
  );
}
