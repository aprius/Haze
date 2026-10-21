import { getCurrentWindow } from "@tauri-apps/api/window";
import { ChevronLeft } from "lucide-react";
import { useEffect, useRef } from "react";
import { closeTabsWithPrompt, EditorArea, revealInTree, saveAll, selectedText, triggerEditorAction } from "./components/EditorArea";
import { FileTree } from "./components/FileTree";
import { FindInFiles } from "./components/FindInFiles";
import { SearchEverywhere } from "./components/SearchEverywhere";
import { ContextMenu, Dialogs, Toasts } from "./components/Overlays";
import { ProjectRail, Splitter, StatusBar, toggleBottom, toggleSidebar, Welcome } from "./components/Shell";
import { BuildPanel } from "./components/BuildPanel";
import { CommitWindow } from "./components/CommitPanel";
import { DiffWindow } from "./components/DiffView";
import { BranchesPopup, openBranchesPopup, openPushDialog, PushDialog, updateProject } from "./components/GitDialogs";
import { GitPanel } from "./components/GitPanel";
import { RebaseDialog } from "./components/RebaseDialog";
import { openSettings, SettingsDialog } from "./components/SettingsDialog";
import { refreshRepo } from "./store/git";
import { RunBar, runConfig, runConfigs } from "./components/RunBar";
import { TerminalPanel, toggleTerminal } from "./components/TerminalPanel";
import { UsagesPopup } from "./components/UsagesPopup";
import { notifyFileChanges, startCsharp, stopCsharp } from "./lib/lsp/csharp";
import { invalidateTextNav } from "./lib/textNav";
import { defaultBuildTarget, loadDotnetInfo, startBuild, useDotnet } from "./store/dotnet";
import { handleDiskChanges } from "./lib/buffers";
import { matches, type Command } from "./lib/keymap";
import { api, onFsChange, onOpenRequest, type OpenRequest } from "./lib/ipc";
import { basename, dirname } from "./lib/path";
import { resetZoom, zoomIn, zoomOut } from "./lib/zoom";
import { restore } from "./store/persist";
import { startTerminals, syncSessions } from "./store/terminals";
import { affectsGit, handleFsChange, refreshGit, useTree } from "./store/tree";
import { openCommitWindow, openFindInFiles, openSearchEverywhere, toggleCommitWindow, useUi } from "./store/ui";
import { projectForPath, useWorkspace, type Project } from "./store/workspace";

function ProjectView({ project }: { project: Project }) {
  const ui = useWorkspace((s) => s.ui[project.id]);
  const updateUi = useWorkspace((s) => s.updateUi);
  if (!ui) return null;
  return (
    <div className="project-view">
      <RunBar project={project} />
      <div className="main-row">
        {ui.sidebarVisible && (
          <>
            <div className="sidebar" style={{ width: ui.sidebarWidth }}>
              <div className="sidebar-tabs">
                <button className="tool-tab active" onClick={() => toggleSidebar(project.id)} title="Project (Alt+1)">
                  Project
                </button>
                <button className="icon-btn sidebar-hide" title="Hide" onClick={() => updateUi(project.id, { sidebarVisible: false })}>
                  <ChevronLeft size={14} />
                </button>
              </div>
              <FileTree project={project} />
            </div>
            <Splitter vertical value={ui.sidebarWidth} min={160} max={800} onChange={(v) => updateUi(project.id, { sidebarWidth: v })} />
          </>
        )}
        <div className="center">
          <EditorArea project={project} />
        </div>
        {ui.terminalVisible && (
          <>
            <Splitter
              vertical
              value={ui.terminalWidth}
              min={280}
              max={Math.max(400, window.innerWidth - 360)}
              invert
              onChange={(v) => updateUi(project.id, { terminalWidth: v })}
            />
            <div className="side-dock" style={{ width: ui.terminalWidth }}>
              <TerminalPanel project={project} />
            </div>
          </>
        )}
      </div>
      {ui.bottomVisible && (
        <>
          <Splitter
            vertical={false}
            value={ui.bottomHeight}
            min={100}
            max={Math.max(200, window.innerHeight - 160)}
            invert
            onChange={(v) => updateUi(project.id, { bottomHeight: v })}
          />
          <div className="bottom" style={{ height: ui.bottomHeight }}>
            {ui.bottomTab === "git" ? <GitPanel project={project} /> : <BuildPanel project={project} />}
          </div>
        </>
      )}
    </div>
  );
}

/** Directory of the item selected in the Project view, for "Find in Directory". */
function selectedTreeDir(project: Project): string | null {
  const sel = useTree.getState().selection[project.id]?.[0];
  if (!sel || document.activeElement?.closest(".file-tree") == null) return null;
  const st = useTree.getState().dirs[sel];
  return st ? sel : null;
}

function useGlobalShortcuts(project: Project | null) {
  // App-wide shortcuts run in the capture phase so Monaco and xterm cannot swallow them.
  useEffect(() => {
    let lastShift = 0;
    let otherKey = false;
    const popupOpen = () => {
      const ui = useUi.getState();
      return ui.searchEverywhere.open || ui.findInFiles.open;
    };
    const onCapture = (e: KeyboardEvent) => {
      if (e.key !== "Shift") otherKey = true;
      const is = (cmd: Command) => matches(e, cmd);
      let handled = true;
      if (is("searchEverywhere")) openSearchEverywhere("all");
      else if (is("gotoFile")) openSearchEverywhere("files");
      else if (is("settings")) openSettings();
      else if (is("zoomIn")) zoomIn();
      else if (is("zoomOut")) zoomOut();
      else if (is("resetZoom")) resetZoom();
      // Monaco does not always receive Shift+F6 (WebKitGTK); route it to Rename ourselves.
      else if (is("rename") && triggerEditorAction("haze.rename")) {
        /* handled */
      }
      // Capture phase: Monaco binds Alt+F12 to Peek Definition on Windows and macOS.
      else if (is("terminal") && project) toggleTerminal(project.id);
      else if (is("push") && project) openPushDialog(project);
      else if (is("commit") && project) openCommitWindow(project.id);
      else if (is("updateProject") && project) void updateProject(project);
      else if (is("branches") && project) openBranchesPopup(project);
      else if (is("commitView") && project) toggleCommitWindow(project.id);
      else if (is("gitView") && project) toggleBottom(project.id, "git");
      else if (is("build") && project) void startBuild(project.id, project.path, "build", defaultBuildTarget(project.id));
      else if (is("run") && project) {
        const configs = runConfigs(useDotnet.getState().info[project.id]);
        const id = useWorkspace.getState().ui[project.id]?.runConfig;
        const cfg = configs.find((c) => c.id === id) ?? configs[0];
        if (cfg) void runConfig(project, cfg);
      } else if (is("findAction")) openSearchEverywhere("actions");
      else if (is("recentFiles") && project) openSearchEverywhere("files", "");
      else if ((is("findInFiles") || is("replaceInFiles")) && project) {
        openFindInFiles({ replace: is("replaceInFiles"), query: selectedText(), directory: selectedTreeDir(project) });
      } else if (is("selectInProject") && project) {
        const tab = useWorkspace.getState().ui[project.id]?.activeTab;
        if (tab) revealInTree(project, tab);
      } else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onDown = (e: KeyboardEvent) => {
      if (e.key === "Shift" && !e.repeat) otherKey = false;
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key !== "Shift" || otherKey) return;
      const now = Date.now();
      // Double Shift: two lone Shift presses within 350 ms.
      if (now - lastShift < 350 && !popupOpen()) {
        lastShift = 0;
        openSearchEverywhere("all");
      } else {
        lastShift = now;
      }
    };
    window.addEventListener("keydown", onDown, true);
    window.addEventListener("keydown", onCapture, true);
    window.addEventListener("keyup", onUp, true);
    return () => {
      window.removeEventListener("keydown", onDown, true);
      window.removeEventListener("keydown", onCapture, true);
      window.removeEventListener("keyup", onUp, true);
    };
  }, [project]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ws = useWorkspace.getState();
      if (matches(e, "saveAll")) {
        e.preventDefault();
        void saveAll();
        return;
      }
      if (!project) return;
      const ui = ws.ui[project.id];
      if (!ui) return;
      if (matches(e, "projectView")) {
        e.preventDefault();
        const inTree = (document.activeElement as HTMLElement | null)?.closest(".file-tree");
        ws.updateUi(project.id, { sidebarVisible: !(ui.sidebarVisible && inTree) });
        requestAnimationFrame(() => (document.querySelector(".tree-scroll") as HTMLElement | null)?.focus());
        return;
      }
      if (matches(e, "closeTab")) {
        e.preventDefault();
        if (ui.activeTab) void closeTabsWithPrompt(project.id, [ui.activeTab]);
        return;
      }
      const step = matches(e, "nextTab") ? 1 : matches(e, "previousTab") ? -1 : 0;
      if (step && ui.tabs.length > 1) {
        e.preventDefault();
        const i = ui.tabs.findIndex((t) => t.path === ui.activeTab);
        const n = ui.tabs.length;
        const next = ui.tabs[(i + step + n) % n];
        ws.updateUi(project.id, { activeTab: next.path });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [project]);
}

function openRequested(req: OpenRequest) {
  const ws = useWorkspace.getState();
  if (req.terminal && req.project) {
    // The terminal joins the project its folder is in, or opens the folder (a new worktree).
    const id = ws.addProject(projectForPath(req.project)?.path ?? req.project);
    const terminal = req.terminal;
    void syncSessions().then(() => ws.updateUi(id, { activeTerminal: terminal, terminalVisible: true }));
    return;
  }
  const owner = req.file && !req.project ? projectForPath(req.file) : null;
  const root = req.project ?? owner?.path ?? (req.file ? dirname(req.file) : null);
  if (!root) return;
  const id = ws.addProject(root);
  if (req.file) ws.openFile(id, req.file, req.line ? { line: req.line, column: req.column ?? 1 } : {});
}

export default function App() {
  const loaded = useWorkspace((s) => s.loaded);
  const projects = useWorkspace((s) => s.projects);
  const activeId = useWorkspace((s) => s.activeProjectId);
  const active = projects.find((p) => p.id === activeId && p.open) ?? null;
  const activeTab = useWorkspace((s) => (activeId ? s.ui[activeId]?.activeTab : null));

  useEffect(() => {
    void restore().then(() => startTerminals());
  }, []);

  // `haze <project> [<file>] --line N` (e.g. from Unity), at launch or from a second launch.
  useEffect(() => {
    if (!loaded) return;
    const drain = () => void api.takeOpenRequests().then((reqs) => reqs.forEach(openRequested)).catch(console.error);
    drain();
    const un = onOpenRequest(drain);
    return () => void un.then((f) => f());
  }, [loaded]);

  // Watch open projects; keep tree, git and buffers in sync with disk.
  const openRoots = projects.filter((p) => p.open).map((p) => p.path).join("\n");
  const watched = useRef(new Set<string>());
  useEffect(() => {
    if (!loaded) return;
    const open = useWorkspace.getState().projects.filter((p) => p.open);
    const roots = new Set(open.map((p) => p.path));
    // Only what changed: re-watching every project would drop their changes meanwhile.
    for (const root of [...watched.current]) {
      if (roots.has(root)) continue;
      watched.current.delete(root);
      void api.unwatchProject(root).catch(() => {});
    }
    for (const p of open) {
      if (watched.current.has(p.path)) continue;
      watched.current.add(p.path);
      void api.watchProject(p.path).catch((e) => console.warn("watch failed", p.path, e));
      refreshGit(p.id, p.path);
      refreshRepo(p.id, p.path);
    }
  }, [loaded, openRoots]);

  // C# support for open .NET projects: discover projects, then start Roslyn.
  useEffect(() => {
    if (!loaded) return;
    const open = useWorkspace.getState().projects.filter((p) => p.open);
    for (const p of open) {
      void loadDotnetInfo(p.id, p.path).then((info) => {
        if (info && info.projects.length) void startCsharp(p.id, p.path);
      });
    }
    for (const id of Object.keys(useDotnet.getState().csharp)) {
      if (!open.some((p) => p.id === id)) void stopCsharp(id);
    }
  }, [loaded, openRoots]);

  useEffect(() => {
    const un = onFsChange((change) => {
      const ws = useWorkspace.getState();
      const project = ws.projects.find((p) => p.path === change.root);
      if (!project) return;
      handleFsChange(project.id, change, ws.nestFiles);
      if (affectsGit(project.id, change)) refreshRepo(project.id, project.path, 400, true);
      void handleDiskChanges(change.overflow ? "all" : change.files);
      notifyFileChanges(change);
      invalidateTextNav(change.root);
      if (change.overflow || change.files.some((f) => /\.(csproj|fsproj|sln|slnx)$|launchSettings\.json$/i.test(f))) {
        void loadDotnetInfo(project.id, project.path).then((info) => {
          if (info && info.projects.length) void startCsharp(project.id, project.path);
        });
      }
    });
    return () => void un.then((f) => f());
  }, []);

  const nest = useWorkspace((s) => s.nestFiles);
  useEffect(() => {
    useTree.setState({ dirs: {} });
  }, [nest]);

  useEffect(() => {
    const title = active ? `${active.name}${activeTab && !activeTab.startsWith("haze-") ? " – " + basename(activeTab) : ""} — Haze` : "Haze";
    document.title = title;
    void getCurrentWindow().setTitle(title).catch(() => {});
  }, [active, activeTab]);

  useGlobalShortcuts(active);

  if (!loaded) return <div className="app loading" />;
  return (
    <div className="app">
      <div className="app-body">
        <ProjectRail />
        <div className="workspace">
          {active ? <ProjectView key={active.id} project={active} /> : <Welcome />}
        </div>
      </div>
      <StatusBar project={active} />
      <SearchEverywhere project={active} />
      <FindInFiles project={active} />
      <UsagesPopup project={active} />
      <BranchesPopup project={active} />
      <PushDialog project={active} />
      <RebaseDialog project={active} />
      <CommitWindow project={active} />
      <DiffWindow />
      <SettingsDialog />
      <ContextMenu />
      <Dialogs />
      <Toasts />
    </div>
  );
}
