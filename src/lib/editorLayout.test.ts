import { describe, expect, it } from "vitest";
import {
  activeTabOf,
  closeTabs,
  defaultEditors,
  detachTab,
  dockWindow,
  focusMain,
  insertBeside,
  layoutGroups,
  moveTab,
  normalizeEditors,
  openBeside,
  openTab,
  removeGroup,
  splitTab,
  unsplit,
  unsplitAll,
  type EditorLayout,
  type Editors,
} from "./editorLayout";

const tabsOf = (e: Editors, id: string) => e.groups.find((g) => g.id === id)?.tabs.map((t) => t.path);

function opened(...paths: string[]): Editors {
  return paths.reduce((e, p) => openTab(e, p, false), defaultEditors());
}

describe("layout tree", () => {
  it("splits a lone group, then adds a sibling in the same direction", () => {
    let l: EditorLayout = { group: "a" };
    l = insertBeside(l, "a", "b", "right");
    expect(l).toEqual({ split: "row", children: [{ group: "a" }, { group: "b" }], sizes: [0.5, 0.5] });
    l = insertBeside(l, "b", "c", "right");
    expect(layoutGroups(l)).toEqual(["a", "b", "c"]);
    expect("split" in l && l.sizes).toEqual([0.5, 0.25, 0.25]);
  });

  it("nests a split the other way", () => {
    const l = insertBeside(insertBeside({ group: "a" }, "a", "b", "right"), "b", "c", "bottom");
    expect(l).toEqual({
      split: "row",
      children: [{ group: "a" }, { split: "column", children: [{ group: "b" }, { group: "c" }], sizes: [0.5, 0.5] }],
      sizes: [0.5, 0.5],
    });
  });

  it("collapses splits left with one child, and joins one the same way", () => {
    const l = insertBeside(insertBeside({ group: "a" }, "a", "b", "right"), "b", "c", "bottom");
    expect(removeGroup(l, "a")).toEqual({ split: "column", children: [{ group: "b" }, { group: "c" }], sizes: [0.5, 0.5] });
    expect(removeGroup(removeGroup(l, "c")!, "b")).toEqual({ group: "a" });
    expect(removeGroup({ group: "a" }, "a")).toBeNull();
  });
});

describe("editor groups", () => {
  it("splits the active tab into a new group to the right, copied", () => {
    const e = splitTab(opened("/a", "/b"), "main", "/b", "right", false, "main", "g2");
    expect(tabsOf(e, "main")).toEqual(["/a", "/b"]);
    expect(tabsOf(e, "g2")).toEqual(["/b"]);
    expect(e.activeGroup).toBe("g2");
    expect(layoutGroups(e.layout)).toEqual(["main", "g2"]);
  });

  it("opens files in the active group", () => {
    let e = splitTab(opened("/a"), "main", "/a", "right", false, "main", "g2");
    e = openTab(e, "/c", false);
    expect(tabsOf(e, "g2")).toEqual(["/a", "/c"]);
    expect(tabsOf(e, "main")).toEqual(["/a"]);
    expect(activeTabOf(e)).toBe("/c");
  });

  it("does not split and move a group's only tab", () => {
    const e = opened("/a");
    expect(splitTab(e, "main", "/a", "right", true)).toBe(e);
  });

  it("closes a split with its last tab, but never the main window's last group", () => {
    let e = splitTab(opened("/a", "/b"), "main", "/b", "right", true, "main", "g2");
    expect(tabsOf(e, "main")).toEqual(["/a"]);
    e = closeTabs(e, ["/b"], "g2");
    expect(e.layout).toEqual({ group: "main" });
    expect(e.activeGroup).toBe("main");
    e = closeTabs(e, ["/a"]);
    expect(e.layout).toEqual({ group: "main" });
    expect(tabsOf(e, "main")).toEqual([]);
  });

  it("closes a file in one group only, or in all", () => {
    const e = splitTab(opened("/a", "/b"), "main", "/b", "right", false, "main", "g2");
    expect(tabsOf(closeTabs(e, ["/b"], "main"), "g2")).toEqual(["/b"]);
    expect(layoutGroups(closeTabs(e, ["/b"]).layout)).toEqual(["main"]);
  });

  it("moves a tab to another group, dropping the group it leaves empty", () => {
    let e = splitTab(opened("/a", "/b"), "main", "/b", "right", true, "main", "g2");
    e = moveTab(e, "main", "/a", "g2", 0);
    expect(tabsOf(e, "g2")).toEqual(["/a", "/b"]);
    expect(layoutGroups(e.layout)).toEqual(["g2"]);
    expect(e.mainGroup).toBe("g2");
  });

  it("reorders a tab within its group", () => {
    const e = moveTab(opened("/a", "/b", "/c"), "main", "/c", "main", 0);
    expect(tabsOf(e, "main")).toEqual(["/c", "/a", "/b"]);
  });

  it("unsplits into the neighbour, and Unsplit All merges every group", () => {
    let e = splitTab(opened("/a", "/b"), "main", "/b", "right", true, "main", "g2");
    e = splitTab(e, "g2", "/b", "bottom", false, "g2", "g3");
    const one = unsplit(e, "g3");
    expect(layoutGroups(one.layout)).toEqual(["main", "g2"]);
    const all = unsplitAll(e, "main");
    expect(all.layout).toEqual({ group: "main" });
    expect(tabsOf(all, "main")).toEqual(["/a", "/b"]);
  });

  it("detaches a tab into a window, and docks it back", () => {
    let e = detachTab(opened("/a", "/b"), "main", "/b", "w1", "g2");
    expect(tabsOf(e, "main")).toEqual(["/a"]);
    expect(e.windows).toEqual([{ id: "w1", layout: { group: "g2" } }]);
    expect(e.activeGroup).toBe("g2");
    // Files opened from the main window go back to it once it has focus.
    expect(focusMain(e).activeGroup).toBe("main");
    e = dockWindow(e, "w1");
    expect(e.windows).toEqual([]);
    expect(tabsOf(e, "main")).toEqual(["/a", "/b"]);
  });

  it("closes a window with its last tab", () => {
    const e = closeTabs(detachTab(opened("/a", "/b"), "main", "/b", "w1", "g2"), ["/b"], "g2");
    expect(e.windows).toEqual([]);
    expect(e.groups.map((g) => g.id)).toEqual(["main"]);
    expect(e.activeGroup).toBe("main");
  });

  it("opens beside: in the neighbour, or a new split to the right", () => {
    let e = openBeside(opened("/a"), "/b", "main", "g2");
    expect(layoutGroups(e.layout)).toEqual(["main", "g2"]);
    expect(tabsOf(e, "g2")).toEqual(["/b"]);
    e = openBeside(e, "/c", "main", "g3");
    expect(tabsOf(e, "g2")).toEqual(["/b", "/c"]);
  });
});

describe("normalizeEditors", () => {
  it("gives tabs of groups no layout shows to the main window, and fixes the active group", () => {
    const e = normalizeEditors({
      groups: [
        { id: "a", tabs: [{ path: "/a", preview: false }], activeTab: "/a" },
        { id: "lost", tabs: [{ path: "/b", preview: false }], activeTab: "/b" },
      ],
      layout: { split: "row", children: [{ group: "a" }, { group: "gone" }], sizes: [0.5, 0.5] },
      windows: [{ id: "w", layout: { group: "missing" } }],
      activeGroup: "gone",
      mainGroup: "gone",
    });
    expect(e.layout).toEqual({ group: "a" });
    expect(e.windows).toEqual([]);
    expect(tabsOf(e, "a")).toEqual(["/a", "/b"]);
    expect(e.groups.map((g) => g.id)).toEqual(["a"]);
    expect(e.activeGroup).toBe("a");
    expect(e.mainGroup).toBe("a");
  });

  it("keeps a group shown twice in its first place only", () => {
    const e = normalizeEditors({
      groups: [
        { id: "a", tabs: [{ path: "/a", preview: false }], activeTab: "/a" },
        { id: "b", tabs: [{ path: "/b", preview: false }], activeTab: "/b" },
      ],
      layout: { split: "row", children: [{ group: "a" }, { group: "b" }, { group: "a" }], sizes: [0.25, 0.25, 0.5] },
      windows: [{ id: "w", layout: { group: "b" } }],
    });
    expect(e.layout).toEqual({ split: "row", children: [{ group: "a" }, { group: "b" }], sizes: [0.5, 0.5] });
    expect(e.windows).toEqual([]);
  });

  it("makes a main group when there is none", () => {
    const e = normalizeEditors({});
    expect(layoutGroups(e.layout)).toHaveLength(1);
    expect(e.groups).toHaveLength(1);
  });
});
