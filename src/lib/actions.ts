// Commands shown in Search Everywhere's "Actions" tab (Ctrl+Shift+A).
import { closeTabsWithPrompt, copyContext, revealInTree, saveAll } from "../components/EditorArea";
import { openSettings } from "../components/SettingsDialog";
import { toggleTerminal } from "../components/TerminalPanel";
import { openFolder } from "../components/Shell";
import { newTerminal } from "../store/terminals";
import { useTree } from "../store/tree";
import { openFindInFiles, openSearchEverywhere } from "../store/ui";
import { shortcutLabel } from "./keymap";
import { toggleThemeMode } from "./theme";
import { resetZoom, zoomIn, zoomOut } from "./zoom";
import { activeProject, useWorkspace } from "../store/workspace";

export interface Action {
  id: string;
  label: string;
  shortcut?: string;
  /** Only offered when a project is open. */
  needsProject?: boolean;
  run(): void;
}

function withProject(f: (projectId: string, path: string) => void) {
  return () => {
    const p = activeProject();
    if (p) f(p.id, p.path);
  };
}

export const actions: Action[] = [
  { id: "searchEverywhere", label: "Search Everywhere", shortcut: shortcutLabel("searchEverywhere"), run: () => openSearchEverywhere("all") },
  { id: "gotoFile", label: "Go to File…", shortcut: shortcutLabel("gotoFile"), run: () => openSearchEverywhere("files") },
  { id: "findInFiles", label: "Find in Files…", shortcut: shortcutLabel("findInFiles"), needsProject: true, run: () => openFindInFiles() },
  {
    id: "replaceInFiles",
    label: "Replace in Files…",
    shortcut: shortcutLabel("replaceInFiles"),
    needsProject: true,
    run: () => openFindInFiles({ replace: true }),
  },
  { id: "saveAll", label: "Save All", shortcut: shortcutLabel("saveAll"), run: () => void saveAll() },
  { id: "openFolder", label: "Open Folder…", run: () => void openFolder() },
  { id: "toggleTheme", label: "Toggle Light/Dark Theme", run: toggleThemeMode },
  { id: "zoomIn", label: "Zoom In", shortcut: shortcutLabel("zoomIn"), run: zoomIn },
  { id: "zoomOut", label: "Zoom Out", shortcut: shortcutLabel("zoomOut"), run: zoomOut },
  { id: "resetZoom", label: "Reset Zoom", shortcut: shortcutLabel("resetZoom"), run: resetZoom },
  { id: "settings", label: "Settings (AI agent hooks, notifications)", shortcut: shortcutLabel("settings"), run: () => openSettings() },
  {
    id: "closeTab",
    label: "Close Tab",
    shortcut: shortcutLabel("closeTab"),
    needsProject: true,
    run: withProject((id) => {
      const tab = useWorkspace.getState().ui[id]?.activeTab;
      if (tab) void closeTabsWithPrompt(id, [tab]);
    }),
  },
  {
    id: "closeAllTabs",
    label: "Close All Tabs",
    needsProject: true,
    run: withProject((id) => {
      const tabs = useWorkspace.getState().ui[id]?.tabs ?? [];
      void closeTabsWithPrompt(id, tabs.map((t) => t.path));
    }),
  },
  { id: "copyContext", label: "Copy Context (code with path and lines)", shortcut: shortcutLabel("copyContext"), needsProject: true, run: () => copyContext() },
  {
    id: "selectInProject",
    label: "Select Opened File in Project View",
    shortcut: shortcutLabel("selectInProject"),
    needsProject: true,
    run: () => {
      const p = activeProject();
      const tab = p && useWorkspace.getState().ui[p.id]?.activeTab;
      if (p && tab) revealInTree(p, tab);
    },
  },
  {
    id: "toggleTerminal",
    label: "Terminal",
    shortcut: shortcutLabel("terminal"),
    needsProject: true,
    run: withProject((id) => toggleTerminal(id, false)),
  },
  { id: "newTerminal", label: "New Terminal", needsProject: true, run: withProject((id, path) => void newTerminal(id, path)) },
  {
    id: "toggleProjectView",
    label: "Project View",
    shortcut: shortcutLabel("projectView"),
    needsProject: true,
    run: withProject((id) => useWorkspace.getState().updateUi(id, (u) => ({ sidebarVisible: !u.sidebarVisible }))),
  },
  {
    id: "toggleNesting",
    label: "File Nesting (toggle)",
    run: () => {
      useWorkspace.setState((s) => ({ nestFiles: !s.nestFiles }));
      useTree.setState({ dirs: {} });
    },
  },
];

/** Subsequence match score for action labels; higher is better, null = no match. */
export function scoreLabel(label: string, query: string): number | null {
  const l = label.toLowerCase();
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  if (l.startsWith(q)) return 1000 - l.length;
  const idx = l.indexOf(q);
  if (idx >= 0) return 800 - idx;
  let i = 0;
  let gaps = 0;
  for (const ch of q) {
    if (ch === " ") continue;
    const j = l.indexOf(ch, i);
    if (j < 0) return null;
    gaps += j - i;
    i = j + 1;
  }
  return 500 - gaps;
}
