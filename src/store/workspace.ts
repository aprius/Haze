// Workspace state: projects, per-project layout, editor tabs and terminal
// tabs. Everything here is persisted (see persist.ts) so Haze reopens exactly
// where it was left.
import { create } from "zustand";
import { basename } from "../lib/path";

export interface Project {
  id: string;
  path: string;
  name: string;
  favorite: boolean;
  /** Open projects appear in the rail; closed ones stay in "recent". */
  open: boolean;
  lastOpenedAt: number;
}

export interface EditorTab {
  path: string;
  /** A preview tab is replaced by the next single-click open. */
  preview: boolean;
}

/** Project view modes: Unity (Assets and Packages, no .meta) and File System (everything, flat). */
export type TreeView = "unity" | "files";

/** Tool windows of the bottom dock; Unity and Tests only in Unity projects. */
export type BottomTab = "build" | "git" | "unity" | "tests" | "find";

export interface ProjectUi {
  expanded: string[];
  /** null: Unity for Unity projects, File System otherwise. */
  treeView: TreeView | null;
  /** Unity view also lists the project root's other folders and Unity-hidden assets (`.x`, `x~`). */
  treeShowAll: boolean;
  tabs: EditorTab[];
  activeTab: string | null;
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
  path: string;
  line: number;
  column: number;
  nonce: number;
}

export const defaultUi = (): ProjectUi => ({
  expanded: [],
  treeView: null,
  treeShowAll: false,
  tabs: [],
  activeTab: null,
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

  addProject(path: string): string;
  activateProject(id: string | null): void;
  closeProject(id: string): void;
  removeProject(id: string): void;
  toggleFavorite(id: string): void;
  moveProject(id: string, delta: number): void;
  updateUi(id: string, patch: Partial<ProjectUi> | ((ui: ProjectUi) => Partial<ProjectUi>)): void;

  openFile(projectId: string, path: string, opts?: { preview?: boolean; line?: number; column?: number }): void;
  pinTab(projectId: string, path: string): void;
  closeTabs(projectId: string, paths: string[]): void;
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
    const preview = opts.preview ?? false;
    get().updateUi(projectId, (ui) => {
      let tabs = ui.tabs;
      const existing = tabs.find((t) => t.path === path);
      if (existing) {
        if (!preview && existing.preview) {
          tabs = tabs.map((t) => (t.path === path ? { ...t, preview: false } : t));
        }
      } else {
        const tab = { path, preview };
        const previewIdx = preview ? tabs.findIndex((t) => t.preview) : -1;
        if (previewIdx >= 0) {
          tabs = tabs.map((t, i) => (i === previewIdx ? tab : t));
        } else {
          const at = ui.activeTab ? tabs.findIndex((t) => t.path === ui.activeTab) + 1 : tabs.length;
          tabs = [...tabs.slice(0, at), tab, ...tabs.slice(at)];
        }
      }
      const recentFiles = path.startsWith("haze-") || path.startsWith("csharp:")
        ? ui.recentFiles
        : [path, ...ui.recentFiles.filter((p) => p !== path)].slice(0, 50);
      return { tabs, activeTab: path, recentFiles };
    });
    if (opts.line) {
      set({ reveal: { path, line: opts.line, column: opts.column ?? 1, nonce: Date.now() } });
    }
  },

  pinTab(projectId, path) {
    get().updateUi(projectId, (ui) => ({
      tabs: ui.tabs.map((t) => (t.path === path ? { ...t, preview: false } : t)),
    }));
  },

  closeTabs(projectId, paths) {
    const closing = new Set(paths);
    get().updateUi(projectId, (ui) => {
      const idx = ui.tabs.findIndex((t) => t.path === ui.activeTab);
      const tabs = ui.tabs.filter((t) => !closing.has(t.path));
      let activeTab = ui.activeTab;
      if (activeTab && closing.has(activeTab)) {
        // Activate the tab to the left of the closed one.
        activeTab = tabs.length ? tabs[Math.max(0, Math.min(idx - 1, tabs.length - 1))].path : null;
      }
      return { tabs, activeTab };
    });
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
          tabs: u.tabs.map((t) => ({ ...t, path: map(t.path) })),
          activeTab: u.activeTab ? map(u.activeTab) : null,
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
