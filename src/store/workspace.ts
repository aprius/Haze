// Workspace state: projects, per-project layout, editor tabs and terminal
// tabs. Everything here is persisted (see persist.ts) so Haze reopens exactly
// where it was left.
import { create } from "zustand";
import * as L from "../lib/editorLayout";
import { basename } from "../lib/path";

export type { EditorTab } from "../lib/editorLayout";

/** Where Unity's performance-critical context is marked: every method run each frame, the one at the caret, or none. */
export type PerfContextMode = "everywhere" | "current" | "never";

export interface Project {
  id: string;
  path: string;
  name: string;
  favorite: boolean;
  /** Open projects appear in the rail; closed ones stay in "recent". */
  open: boolean;
  lastOpenedAt: number;
}

/** Project view modes: Unity (Assets and Packages, no .meta) and File System (everything, flat). */
export type TreeView = "unity" | "files";

/** Tool windows of the bottom dock; Unity and Tests only in Unity projects. */
export type BottomTab = "build" | "git" | "unity" | "tests" | "find";

/** Editor tabs live in groups (splits and detached windows): see lib/editorLayout. */
export interface ProjectUi extends L.Editors {
  expanded: string[];
  /** null: Unity for Unity projects, File System otherwise. */
  treeView: TreeView | null;
  /** Unity view also lists the project root's other folders and Unity-hidden assets (`.x`, `x~`). */
  treeShowAll: boolean;
  sidebarVisible: boolean;
  sidebarWidth: number;
  terminalVisible: boolean;
  /** Terminal sessions, docked right of the editor. */
  terminalWidth: number;
  /** Build and Git, docked below. */
  bottomVisible: boolean;
  bottomHeight: number;
  terminalOrder: string[];
  activeTerminal: string | null;
  /** Most recently opened files, newest first (Ctrl+E). */
  recentFiles: string[];
  /** Tool window shown in the bottom panel. */
  bottomTab: BottomTab;
  /** Commit view lists changes in a directory tree rather than flat. */
  commitGroupByDir: boolean;
  /** Commit details in the Git log list changed files in a directory tree rather than flat. */
  logGroupByDir: boolean;
  /** Sizes of the Git tool window panes: branch list, commit details, stash list, commit message under the files. */
  gitBranchesWidth: number;
  gitDetailsWidth: number;
  gitStashListWidth: number;
  gitMetaHeight: number;
  /** Collapsed groups and folders of the Git branch list ("Local", "Remote/origin", …). */
  gitCollapsed: string[];
  /** Selected run configuration id (see RunBar). */
  runConfig: string | null;
}

export interface Reveal {
  /** The group asked to show it. */
  group: string;
  path: string;
  line: number;
  column: number;
  nonce: number;
}

export const defaultUi = (): ProjectUi => ({
  ...L.defaultEditors(),
  expanded: [],
  treeView: null,
  treeShowAll: false,
  sidebarVisible: true,
  sidebarWidth: 300,
  terminalVisible: false,
  terminalWidth: 560,
  bottomVisible: false,
  bottomHeight: 280,
  terminalOrder: [],
  activeTerminal: null,
  recentFiles: [],
  bottomTab: "build",
  commitGroupByDir: false,
  logGroupByDir: true,
  gitBranchesWidth: 210,
  gitDetailsWidth: 340,
  gitStashListWidth: 320,
  gitMetaHeight: 140,
  gitCollapsed: [],
  runConfig: null,
});

interface WorkspaceState {
  loaded: boolean;
  projects: Project[];
  activeProjectId: string | null;
  ui: Record<string, ProjectUi>;
  reveal: Reveal | null;
  nestFiles: boolean;
  /** "Always Select Opened File": the Project view follows the active editor tab. */
  selectOpenedFile: boolean;
  /** Pins the enclosing class/method lines at the top of the editor while scrolling. */
  stickyScroll: boolean;
  /** Shows the caret line's author, date and commit at the end of the line. */
  lineBlame: boolean;
  /** Code Vision: usages and author above C# types and members; unused private members greyed. */
  codeVision: boolean;
  /** Rainbow brackets: (), [] and {} coloured by nesting depth. */
  rainbowBrackets: boolean;
  /** Vertical guides for each bracket pair in its depth's colour (needs rainbowBrackets). */
  rainbowGuides: boolean;
  /** Desktop notifications when an agent needs you or finishes. */
  notifyAgents: boolean;
  /** Unity refreshes its assets (and compiles) when files change on disk, without waiting for focus. */
  unityAutoRefresh: boolean;
  /** Where the gutter marks Unity's performance-critical context (methods run every frame). */
  unityPerfContext: PerfContextMode;
  /** Expensive calls (GetComponent, Find…) in that context are underlined. */
  unityPerfHints: boolean;
  /** Unknown tags, layers, scenes… in scripts and broken assembly definition references are reported. */
  unityInspections: boolean;
  /** Looks for a newer Haze release at startup and every few hours. */
  checkUpdates: boolean;

  addProject(path: string): string;
  activateProject(id: string | null): void;
  closeProject(id: string): void;
  removeProject(id: string): void;
  toggleFavorite(id: string): void;
  moveProject(id: string, delta: number): void;
  updateUi(id: string, patch: Partial<ProjectUi> | ((ui: ProjectUi) => Partial<ProjectUi>)): void;

  /** Opens in `group`, by default the active group. */
  openFile(projectId: string, path: string, opts?: { preview?: boolean; line?: number; column?: number; group?: string }): void;
  pinTab(projectId: string, path: string): void;
  /** Closes the tabs in `group`, or in every group. */
  closeTabs(projectId: string, paths: string[], group?: string): void;
  /** Applies an editor group operation (split, move, detach…) from lib/editorLayout. */
  editors(projectId: string, op: (e: L.Editors) => L.Editors): void;
  /** Rewrites tab paths after a rename or move in the file tree. */
  renamePaths(from: string, to: string): void;
}

const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  loaded: false,
  projects: [],
  activeProjectId: null,
  ui: {},
  reveal: null,
  nestFiles: true,
  selectOpenedFile: true,
  stickyScroll: true,
  lineBlame: true,
  codeVision: true,
  rainbowBrackets: true,
  rainbowGuides: true,
  notifyAgents: true,
  unityAutoRefresh: true,
  unityPerfContext: "everywhere",
  unityPerfHints: true,
  unityInspections: true,
  checkUpdates: true,

  addProject(path) {
    const existing = get().projects.find((p) => p.path === path);
    if (existing) {
      get().activateProject(existing.id);
      return existing.id;
    }
    const project: Project = {
      id: newId(),
      path,
      name: basename(path) || path,
      favorite: false,
      open: true,
      lastOpenedAt: Date.now(),
    };
    set((s) => ({
      projects: [...s.projects, project],
      ui: { ...s.ui, [project.id]: defaultUi() },
      activeProjectId: project.id,
    }));
    return project.id;
  },

  activateProject(id) {
    set((s) => ({
      activeProjectId: id,
      projects: s.projects.map((p) => (p.id === id ? { ...p, open: true, lastOpenedAt: Date.now() } : p)),
    }));
  },

  closeProject(id) {
    set((s) => {
      const projects = s.projects.map((p) => (p.id === id ? { ...p, open: false } : p));
      const nextActive =
        s.activeProjectId === id ? (projects.find((p) => p.open)?.id ?? null) : s.activeProjectId;
      return { projects, activeProjectId: nextActive };
    });
  },

  removeProject(id) {
    set((s) => {
      const ui = { ...s.ui };
      delete ui[id];
      return {
        projects: s.projects.filter((p) => p.id !== id),
        ui,
        activeProjectId: s.activeProjectId === id ? null : s.activeProjectId,
      };
    });
  },

  toggleFavorite(id) {
    set((s) => ({ projects: s.projects.map((p) => (p.id === id ? { ...p, favorite: !p.favorite } : p)) }));
  },

  moveProject(id, delta) {
    set((s) => {
      // Swap with the neighbour shown in the rail: open projects, favorites first.
      const me = s.projects.find((p) => p.id === id);
      if (!me) return {};
      const shown = s.projects.filter((p) => p.open && p.favorite === me.favorite);
      const other = shown[shown.indexOf(me) + delta];
      if (!other) return {};
      const list = [...s.projects];
      const i = list.indexOf(me);
      const j = list.indexOf(other);
      [list[i], list[j]] = [list[j], list[i]];
      return { projects: list };
    });
  },

  updateUi(id, patch) {
    set((s) => {
      const cur = s.ui[id] ?? defaultUi();
      const p = typeof patch === "function" ? patch(cur) : patch;
      return { ui: { ...s.ui, [id]: { ...cur, ...p } } };
    });
  },

  openFile(projectId, path, opts = {}) {
    let group = "";
    get().updateUi(projectId, (ui) => {
      const e = L.openTab(ui, path, opts.preview ?? false, opts.group);
      group = e.activeGroup;
      const recentFiles = path.startsWith("haze-") || path.startsWith("csharp:")
        ? ui.recentFiles
        : [path, ...ui.recentFiles.filter((p) => p !== path)].slice(0, 50);
      return { ...e, recentFiles };
    });
    if (opts.line) {
      set({ reveal: { group, path, line: opts.line, column: opts.column ?? 1, nonce: Date.now() } });
    }
  },

  pinTab(projectId, path) {
    get().updateUi(projectId, (ui) => L.pinTab(ui, path));
  },

  closeTabs(projectId, paths, group) {
    get().updateUi(projectId, (ui) => L.closeTabs(ui, paths, group));
  },

  editors(projectId, op) {
    get().updateUi(projectId, (ui) => op(ui));
  },

  renamePaths(from, to) {
    const map = (p: string) => {
      if (p === from) return to;
      for (const sep of ["/", "\\"]) {
        if (p.startsWith(from + sep)) return to + p.slice(from.length);
      }
      return p;
    };
    set((s) => {
      const ui: Record<string, ProjectUi> = {};
      for (const [id, u] of Object.entries(s.ui)) {
        ui[id] = {
          ...u,
          ...L.mapTabPaths(u, map),
          expanded: u.expanded.map(map),
          recentFiles: u.recentFiles.map(map),
        };
      }
      return { ui };
    });
  },
}));

export function activeProject(): Project | null {
  const s = useWorkspace.getState();
  return s.projects.find((p) => p.id === s.activeProjectId) ?? null;
}

export function projectForPath(path: string): Project | null {
  const norm = (p: string) => p.replace(/\\/g, "/");
  const n = norm(path);
  let best: Project | null = null;
  for (const p of useWorkspace.getState().projects) {
    const root = norm(p.path);
    if ((n === root || n.startsWith(root + "/")) && (!best || root.length > norm(best.path).length)) best = p;
  }
  return best;
}
