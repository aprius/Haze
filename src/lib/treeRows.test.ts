import { describe, expect, it } from "vitest";
import type { DirEntry } from "./ipc";
import type { DirState } from "../store/tree";
import type { Project } from "../store/workspace";
import { buildRows, isUnityProject, resolvePackages, resolveView, withNested } from "./treeRows";

const project: Project = { id: "p", path: "/u", name: "u", favorite: false, open: true, lastOpenedAt: 0 };
const dir = (path: string, isDir = true): DirEntry => ({ name: path.split("/").pop()!, path, isDir, isSymlink: false, nestedUnder: null });
const file = (path: string, nestedUnder: string | null = null): DirEntry => ({ ...dir(path, false), nestedUnder });

const dirs: Record<string, DirState> = {
  "/u": {
    entries: [dir("/u/Assets"), dir("/u/Library"), dir("/u/Packages"), dir("/u/ProjectSettings"), file("/u/Assets.meta"), file("/u/u.sln")],
  },
  "/u/Assets": {
    entries: [dir("/u/Assets/Editor~"), file("/u/Assets/.hidden"), file("/u/Assets/Player.cs"), file("/u/Assets/Player.cs.meta", "Player.cs")],
  },
};
const expanded = new Set(["/u", "/u/Assets"]);
const names = (view: "unity" | "files", showAll = false) =>
  buildRows(project, dirs, expanded, { view, showAll, unityProject: true }).map((r) => "  ".repeat(r.depth) + r.entry.name);

describe("project view modes", () => {
  it("detects Unity projects and defaults to the Unity view", () => {
    expect(isUnityProject(dirs, "/u")).toBe(true);
    expect(resolveView(null, true)).toBe("unity");
    expect(resolveView("unity", false)).toBe("files");
    expect(resolveView(null, false)).toBe("files");
    expect(resolveView("files", true)).toBe("files");
  });

  it("Unity view shows Assets and Packages without .meta or hidden assets", () => {
    expect(names("unity")).toEqual(["Assets", "  Player.cs", "Packages"]);
  });

  it("Show All Files adds the root's other entries, hidden assets and .meta files", () => {
    expect(names("unity", true)).toEqual([
      "Assets",
      "  Editor~",
      "  .hidden",
      "  Player.cs",
      "  Player.cs.meta",
      "Packages",
      "Library",
      "ProjectSettings",
      "Assets.meta",
      "u.sln",
    ]);
  });

  it("lists referenced packages under Packages, after its folders", () => {
    const withPackages: Record<string, DirState> = {
      ...dirs,
      "/u/Packages": { entries: [dir("/u/Packages/com.me.embedded"), file("/u/Packages/manifest.json")] },
    };
    const packages = resolvePackages(
      "/u",
      JSON.stringify({
        dependencies: {
          "com.unity.ugui": { version: "2.0.0", source: "registry" },
          "com.cysharp.unitask": { version: "https://github.com/Cysharp/UniTask.git", source: "git" },
          "com.me.local": { version: "file:../../shared/local", source: "local" },
          "com.me.embedded": { version: "file:com.me.embedded", source: "embedded" },
          "com.unity.modules.ui": { version: "1.0.0", source: "builtin" },
          "com.unity.missing": { version: "1.0.0", source: "registry" },
        },
      }),
      ["com.unity.ugui@a1b2c3", "com.cysharp.unitask@d4e5f6"],
    );
    expect(packages).toEqual([
      { name: "com.cysharp.unitask", path: "/u/Library/PackageCache/com.cysharp.unitask@d4e5f6", version: "git" },
      { name: "com.me.local", path: "/shared/local", version: "local" },
      { name: "com.unity.ugui", path: "/u/Library/PackageCache/com.unity.ugui@a1b2c3", version: "2.0.0" },
    ]);
    const rows = buildRows(project, withPackages, new Set(["/u/Packages"]), { view: "unity", showAll: false, packages });
    expect(rows.map((r) => r.entry.name + (r.pkg ? "@" + r.pkg.version : ""))).toEqual([
      "Assets",
      "Packages",
      "com.me.embedded",
      "com.cysharp.unitask@git",
      "com.me.local@local",
      "com.unity.ugui@2.0.0",
      "manifest.json",
    ]);
  });

  it("File System view lists everything flat, .meta included", () => {
    expect(names("files")).toEqual([
      "u",
      "  Assets",
      "    Editor~",
      "    .hidden",
      "    Player.cs",
      "    Player.cs.meta",
      "  Library",
      "  Packages",
      "  ProjectSettings",
      "  Assets.meta",
      "  u.sln",
    ]);
  });
});

describe("file nesting", () => {
  const web: Project = { ...project, path: "/w", name: "w" };
  const webDirs: Record<string, DirState> = {
    "/w": {
      entries: [dir("/w/Pages"), file("/w/appsettings.Development.json", "appsettings.json"), file("/w/appsettings.json"), file("/w/Program.cs")],
    },
  };
  const rows = (open: string[], opts: { unityProject?: boolean } = {}) =>
    buildRows(web, webDirs, new Set(["/w", ...open]), { view: "files", showAll: false, ...opts }).map(
      (r) => "  ".repeat(r.depth) + r.entry.name + (r.expandable && !r.entry.isDir ? (r.expanded ? " -" : " +") : ""),
    );

  it("nests companion files in projects that are not Unity", () => {
    expect(rows([])).toEqual(["w", "  Pages", "  appsettings.json +", "  Program.cs"]);
    expect(rows(["/w/appsettings.json"])).toEqual(["w", "  Pages", "  appsettings.json -", "    appsettings.Development.json", "  Program.cs"]);
  });

  it("lists a Unity project's File System view flat", () => {
    expect(rows([], { unityProject: true })).toEqual(["w", "  Pages", "  appsettings.Development.json", "  appsettings.json", "  Program.cs"]);
  });
});

describe("withNested", () => {
  const list = (entries: DirEntry[]) => withNested(entries).map(({ entry, depth }) => "  ".repeat(depth) + entry.name);

  it("puts nested files under theirs, nested ones deeper", () => {
    expect(
      list([
        dir("/w/Pages"),
        file("/w/appsettings.Development.json", "appsettings.json"),
        file("/w/appsettings.Development.local.json", "appsettings.Development.json"),
        file("/w/appsettings.json"),
        file("/w/Program.cs"),
      ]),
    ).toEqual(["Pages", "appsettings.json", "  appsettings.Development.json", "    appsettings.Development.local.json", "Program.cs"]);
  });

  it("keeps a file whose parent is missing, and never loops", () => {
    expect(list([file("/w/Index.razor.cs", "Index.razor"), file("/w/a", "b"), file("/w/b", "a")])).toEqual(["Index.razor.cs"]);
  });
});
