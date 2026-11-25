import { beforeEach, describe, expect, it, vi } from "vitest";

const disk = { gone: new Set<string>(), calls: 0 };
vi.mock("../lib/ipc", () => ({
  api: {
    filesExist: async (paths: string[]) => {
      disk.calls++;
      return paths.map((p) => !disk.gone.has(p));
    },
  },
}));

const { navigate, notePlace } = await import("./navigation");
const { navHistories } = await import("../lib/navHistory");
const { defaultUi, useWorkspace } = await import("./workspace");

const opened: { path: string; line?: number }[] = [];

beforeEach(() => {
  disk.gone.clear();
  disk.calls = 0;
  opened.length = 0;
  navHistories.clear();
  useWorkspace.setState({
    ui: { p: defaultUi() },
    openFile: (_id: string, path: string, opts?: { line?: number }) => void opened.push({ path, line: opts?.line }),
  });
});

/** Places in files /a, /b, /c…, the caret now in the last; each Back arrives where it went. */
function visit(...paths: string[]) {
  for (const path of paths) notePlace("p", { path, line: 1, column: 1 });
}

async function step(delta: -1 | 1) {
  const ok = await navigate("p", delta);
  const to = opened[opened.length - 1];
  if (ok) notePlace("p", { path: to.path, line: to.line ?? 1, column: 1 });
  return ok;
}
const back = () => step(-1);

describe("navigate", () => {
  it("goes back and forward", async () => {
    visit("/a", "/b", "/c");
    expect(await back()).toBe(true);
    expect(opened.at(-1)?.path).toBe("/b");
    expect(await step(1)).toBe(true);
    expect(opened.at(-1)?.path).toBe("/c");
  });

  it("skips the places of files deleted since and forgets them", async () => {
    visit("/a", "/b", "/c");
    disk.gone.add("/b");
    expect(await back()).toBe(true);
    expect(opened.at(-1)?.path).toBe("/a");
    expect(navHistories.get("p")?.places.map((p) => p.path)).toEqual(["/a", "/c"]);
  });

  it("goes nowhere when every place behind is gone", async () => {
    visit("/a", "/b");
    disk.gone.add("/a");
    expect(await back()).toBe(false);
    expect(opened).toEqual([]);
    expect(navHistories.get("p")?.places.map((p) => p.path)).toEqual(["/b"]);
  });

  it("does not check decompiled code on disk", async () => {
    visit("csharp:/x/A.cs", "/b");
    expect(await back()).toBe(true);
    expect(opened.at(-1)?.path).toBe("csharp:/x/A.cs");
  });

  it("goes two places back when Back is pressed twice at once", async () => {
    visit("/a", "/b", "/c");
    const [first, second] = await Promise.all([navigate("p", -1), navigate("p", -1)]);
    expect([first, second]).toEqual([true, true]);
    expect(opened.map((o) => o.path)).toEqual(["/b", "/a"]);
    notePlace("p", { path: "/a", line: 1, column: 1 });
  });

  it("asks the disk once per step", async () => {
    visit("/a", "/b", "/c");
    await back();
    expect(disk.calls).toBe(1);
  });
});
