import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef } from "react";
import { closeTabsWithPrompt, EditorArea, revealInTree, saveAll, selectedText, triggerEditorAction } from "./components/EditorArea";
import { FileTree } from "./components/FileTree";
import { FindInFiles } from "./components/FindInFiles";
import { SearchEverywhere } from "./components/SearchEverywhere";
import { ContextMenu, Dialogs, Toasts } from "./components/Overlays";
import { ProjectRail, Splitter, StatusBar, Welcome } from "./components/Shell";
import { BuildPanel } from "./components/BuildPanel";
import { CommitPanel } from "./components/CommitPanel";
import { BranchesPopup, openBranchesPopup, openPushDialog, PushDialog, updateProject } from "./components/GitDialogs";
import { GitPanel } from "./components/GitPanel";
import { RebaseDialog } from "./components/RebaseDialog";
import { openSettings, SettingsDialog } from "./components/SettingsDialog";
import { refreshRepo } from "./store/git";
import { RunBar, runConfig, runConfigs } from "./components/RunBar";
import { TerminalPanel, toggleTerminal } from "./components/TerminalPanel";
import { UsagesPopup } from "./components/UsagesPopup";
import { notifyFileChanges, startCsharp, stopCsharp } from "./lib/lsp/csharp";
import { defaultBuildTarget, loadDotnetInfo, startBuild, useDotnet } from "./store/dotnet";
import { handleDiskChanges } from "./lib/buffers";
import { api, onFsChange, onOpenRequest, type OpenRequest } from "./lib/ipc";
import { basename, dirname } from "./lib/path";
import { restore } from "./store/persist";
import { startTerminals } from "./store/terminals";
import { affectsGit, handleFsChange, refreshGit, useTree } from "./store/tree";
import { openFindInFiles, openSearchEverywhere, useUi } from "./store/ui";
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
                <button className={"tool-tab" + (ui.sidebarTab !== "commit" ? " active" : "")} onClick={() => updateUi(project.id, { sidebarTab: "project" })} title="Project (Alt+1)">
                  Project
                </button>
                <button className={"tool-tab" + (ui.sidebarTab === "commit" ? " active" : "")} onClick={() => updateUi(project.id, { sidebarTab: "commit" })} title="Commit (Alt+0)">
                  Commit
                </button>
              </div>
              {ui.sidebarTab === "commit" ? <CommitPanel project={project} /> : <FileTree project={project} />}
            </div>
            <Splitter vertical value={ui.sidebarWidth} min={160} max={800} onChange={(v) => updateUi(project.id, { sidebarWidth: v })} />
          </>
        )}
        <div className="center">
          <EditorArea project={project} />
        </div>
        {ui.terminalVisible && ui.terminalDock === "right" && (
          <>
            <Splitter
              vertical
              value={ui.terminalWidth}
              min={280}
              max={Math.max(400, window.innerWidth - 360)}
              invert
              onChange={(v) => updateUi(project.id, { terminalWidth: v })}
            />
            <div className="bottom docked-right" style={{ width: ui.terminalWidth }}>
              <ToolPanel project={project} />
            </div>
          </>
        )}
      </div>
      {ui.terminalVisible && ui.terminalDock === "bottom" && (
        <>
          <Splitter
            vertical={false}
            value={ui.terminalHeight}
            min={100}
            max={Math.max(200, window.innerHeight - 160)}
            invert
            onChange={(v) => updateUi(project.id, { terminalHeight: v })}
          />
          <div className="bottom" style={{ height: ui.terminalHeight }}>
            <ToolPanel project={project} />
          </div>
        </>
      )}
    </div>
  );
}

/** Terminal, Build and Git, docked below or beside the editor. */
function ToolPanel({ project }: { project: Project }) {
  const tab = useWorkspace((s) => s.ui[project.id]?.bottomTab ?? "terminal");
  return (
    <>
      {/* The terminal stays mounted so xterm keeps its screen while Build is shown. */}
      <div className="bottom-slot" style={{ display: tab === "terminal" ? "flex" : "none" }}>
        <TerminalPanel project={project} />
      </div>
      {tab === "build" && <BuildPanel project={project} />}
      {tab === "git" && <GitPanel project={project} />}
    </>
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
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      let handled = true;
      if (mod && e.shiftKey && k === "n") openSearchEverywhere("files");
      else if (mod && e.altKey && k === "s") openSettings();
      // Monaco does not always receive Shift+F6 (WebKitGTK); route it to Rename ourselves.
      else if (e.shiftKey && !mod && !e.altKey && e.key === "F6" && triggerEditorAction("haze.rename")) {
        /* handled */
      }
      // Capture phase: Monaco binds Alt+F12 to Peek Definition on Windows and macOS.
      else if (((e.altKey && !mod && e.key === "F12") || (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === "`")) && project) {
        toggleTerminal(project.id);
      } else if (mod && e.shiftKey && k === "k" && project) openPushDialog(project);
      else if (mod && !e.shiftKey && !e.altKey && k === "k" && project) {
        useWorkspace.getState().updateUi(project.id, { sidebarVisible: true, sidebarTab: "commit" });
        requestAnimationFrame(() => (document.querySelector(".commit-message") as HTMLElement | null)?.focus());
      } else if (mod && !e.shiftKey && !e.altKey && k === "t" && project) void updateProject(project);
      else if (mod && e.shiftKey && e.code === "Backquote" && project) openBranchesPopup(project);
      else if (e.altKey && !mod && e.key === "0" && project) {
        const ui = useWorkspace.getState().ui[project.id];
        const showing = ui?.sidebarVisible && ui.sidebarTab === "commit";
        useWorkspace.getState().updateUi(project.id, { sidebarVisible: !showing, sidebarTab: "commit" });
      } else if (e.altKey && !mod && e.key === "9" && project) {
        const ui = useWorkspace.getState().ui[project.id];
        const showing = ui?.terminalVisible && ui.bottomTab === "git";
        useWorkspace.getState().updateUi(project.id, { terminalVisible: !showing, bottomTab: "git" });
      } else if (mod && e.shiftKey && k === "b" && project) {
        void startBuild(project.id, project.path, "build", defaultBuildTarget(project.id));
      } else if (e.shiftKey && !mod && e.key === "F10" && project) {
        const configs = runConfigs(useDotnet.getState().info[project.id]);
        const id = useWorkspace.getState().ui[project.id]?.runConfig;
        const cfg = configs.find((c) => c.id === id) ?? configs[0];
        if (cfg) void runConfig(project, cfg);
      }
      else if (mod && e.shiftKey && k === "a") openSearchEverywhere("actions");
      else if (mod && !e.shiftKey && !e.altKey && k === "e" && project) openSearchEverywhere("files", "");
      else if (mod && e.shiftKey && (k === "f" || k === "r") && project) {
        openFindInFiles({ replace: k === "r", query: selectedText(), directory: selectedTreeDir(project) });
      } else if (e.altKey && e.key === "F1" && project) {
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
      const mod = e.ctrlKey || e.metaKey;
      const ws = useWorkspace.getState();
      if (mod && !e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveAll();
        return;
      }
      if (!project) return;
      const ui = ws.ui[project.id];
      if (!ui) return;
      if (e.altKey && e.key === "1") {
        e.preventDefault();
        const inTree = (document.activeElement as HTMLElement | null)?.closest(".file-tree");
        ws.updateUi(project.id, { sidebarVisible: !(ui.sidebarVisible && ui.sidebarTab !== "commit" && inTree), sidebarTab: "project" });
        requestAnimationFrame(() => (document.querySelector(".tree-scroll") as HTMLElement | null)?.focus());
        return;
      }
      if ((mod && e.key === "F4") || (mod && !e.shiftKey && e.key.toLowerCase() === "w" && e.metaKey)) {
        e.preventDefault();
        if (ui.activeTab) void closeTabsWithPrompt(project.id, [ui.activeTab]);
        return;
      }
      if (e.ctrlKey && e.key === "Tab" && ui.tabs.length > 1) {
        e.preventDefault();
        const i = ui.tabs.findIndex((t) => t.path === ui.activeTab);
        const n = ui.tabs.length;
        const next = ui.tabs[(i + (e.shiftKey ? n - 1 : 1)) % n];
        ws.updateUi(project.id, { activeTab: next.path });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [project]);
}

function openRequested(req: OpenRequest) {
  const ws = useWorkspace.getState();
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
      if (change.overflow || change.files.some((f) => /\.(csproj|fsproj|sln|slnx)$|launchSettings\.json$/i.test(f))) {
        void loadDotnetInfo(project.id, project.path).then((info) => {
          if (info && info.projects.length) void startCsharp(project.id, project.path);
        });
      }
    });
    return () => void un.then((f) => f());
  }, []);

  // Re-list directories when nesting is toggled.
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
      <SettingsDialog />
      <ContextMenu />
      <Dialogs />
      <Toasts />
    </div>
  );
}
