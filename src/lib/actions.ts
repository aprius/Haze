// Commands shown in Search Everywhere's "Actions" tab (Ctrl+Shift+A).
import { closeTabsWithPrompt, copyContext, revealInTree, runEditorCommand, saveAll, type EditorCommand } from "../components/EditorArea";
import { openSettings } from "../components/SettingsDialog";
import { toggleTerminal } from "../components/TerminalPanel";
import { openFolder } from "../components/Shell";
import { newTerminal } from "../store/terminals";
import { checkForUpdates } from "../store/updates";
import { useTree } from "../store/tree";
import { openFindInFiles, openSearchEverywhere } from "../store/ui";
import type { Command } from "./keymap";
import { toggleThemeMode } from "./theme";
import { resetZoom, zoomIn, zoomOut } from "./zoom";
import { activeProject, useWorkspace } from "../store/workspace";
import { activeGroupOf, activeTabOf, openPaths, unsplitAll } from "./editorLayout";

export interface Action {
  id: string;
  label: string;
  /** Its keymap command, whose shortcut is shown next to it. */
  command?: Command;
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

export { scoreLabel } from "./scoreLabel";

export const actions: Action[] = [
  { id: "searchEverywhere", label: "Search Everywhere", command: "searchEverywhere", run: () => openSearchEverywhere("all") },
  { id: "gotoFile", label: "Go to File…", command: "gotoFile", run: () => openSearchEverywhere("files") },
  { id: "findInFiles", label: "Find in Files…", command: "findInFiles", needsProject: true, run: () => openFindInFiles() },
  {
    id: "replaceInFiles",
    label: "Replace in Files…",
    command: "replaceInFiles",
    needsProject: true,
    run: () => openFindInFiles({ replace: true }),
  },
  { id: "saveAll", label: "Save All", command: "saveAll", run: () => void saveAll() },
  { id: "openFolder", label: "Open Folder…", run: () => void openFolder() },
  { id: "toggleTheme", label: "Toggle Light/Dark Theme", run: toggleThemeMode },
  { id: "zoomIn", label: "Zoom In", command: "zoomIn", run: zoomIn },
  { id: "zoomOut", label: "Zoom Out", command: "zoomOut", run: zoomOut },
  { id: "resetZoom", label: "Reset Zoom", command: "resetZoom", run: resetZoom },
  { id: "settings", label: "Settings (AI agent hooks, notifications)", command: "settings", run: () => openSettings() },
  { id: "checkUpdates", label: "Check for Updates…", run: () => void checkForUpdates(true) },
  {
    id: "closeTab",
    label: "Close Tab",
    command: "closeTab",
    needsProject: true,
    run: withProject((id) => {
      const ui = useWorkspace.getState().ui[id];
      const g = ui && activeGroupOf(ui);
      if (g?.activeTab) void closeTabsWithPrompt(id, [g.activeTab], g.id);
    }),
  },
  {
    id: "closeAllTabs",
    label: "Close All Tabs",
    needsProject: true,
    run: withProject((id) => {
      const ui = useWorkspace.getState().ui[id];
      if (ui) void closeTabsWithPrompt(id, openPaths(ui));
    }),
  },
  ...(
    [
      ["splitVertically", "Split Vertically"],
      ["splitHorizontally", "Split Horizontally"],
      ["unsplit", "Unsplit"],
      ["moveToOppositeGroup", "Move to Opposite Group"],
      ["nextSplitter", "Go to Next Splitter"],
      ["openInNewWindow", "Open in New Window"],
    ] as [EditorCommand, string][]
  ).map(([id, label]): Action => ({ id, label, command: id, needsProject: true, run: withProject((p) => runEditorCommand(id, p)) })),
  {
    id: "unsplitAll",
    label: "Unsplit All",
    needsProject: true,
    run: withProject((id) => useWorkspace.getState().editors(id, (e) => unsplitAll(e, activeGroupOf(e).id))),
  },
  { id: "copyContext", label: "Copy Context (code with path and lines)", command: "copyContext", needsProject: true, run: () => copyContext() },
  {
    id: "selectInProject",
    label: "Select Opened File in Project View",
    command: "selectInProject",
    needsProject: true,
    run: () => {
      const p = activeProject();
      const ui = p && useWorkspace.getState().ui[p.id];
      const tab = ui && activeTabOf(ui);
      if (p && tab) revealInTree(p, tab);
    },
  },
  {
    id: "toggleTerminal",
    label: "Terminal",
    command: "terminal",
    needsProject: true,
    run: withProject((id) => toggleTerminal(id, false)),
  },
  { id: "newTerminal", label: "New Terminal", needsProject: true, run: withProject((id, path) => void newTerminal(id, path)) },
  {
    id: "toggleProjectView",
    label: "Project View",
    command: "projectView",
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
  {
    id: "toggleSelectOpenedFile",
    label: "Always Select Opened File (toggle)",
    run: () => useWorkspace.setState((s) => ({ selectOpenedFile: !s.selectOpenedFile })),
  },
  {
    id: "toggleStickyScroll",
    label: "Sticky Scroll (toggle)",
    run: () => useWorkspace.setState((s) => ({ stickyScroll: !s.stickyScroll })),
  },
];
