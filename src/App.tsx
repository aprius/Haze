import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import { closeTabsWithPrompt, EditorArea, saveAll } from "./components/EditorArea";
import { FileTree } from "./components/FileTree";
import { ContextMenu, Dialogs, Toasts } from "./components/Overlays";
import { ProjectRail, Splitter, StatusBar, Welcome } from "./components/Shell";
import { TerminalPanel } from "./components/TerminalPanel";
import { handleDiskChanges } from "./lib/buffers";
import { api, onFsChange } from "./lib/ipc";
import { basename } from "./lib/path";
import { restore } from "./store/persist";
import { startTerminals } from "./store/terminals";
import { handleFsChange, refreshGit, useTree } from "./store/tree";
import { useWorkspace, type Project } from "./store/workspace";

function ProjectView({ project }: { project: Project }) {
  const ui = useWorkspace((s) => s.ui[project.id]);
  const updateUi = useWorkspace((s) => s.updateUi);
  if (!ui) return null;
  return (
    <div className="project-view">
      <div className="main-row">
        {ui.sidebarVisible && (
          <>
            <div className="sidebar" style={{ width: ui.sidebarWidth }}>
              <FileTree project={project} />
            </div>
            <Splitter vertical value={ui.sidebarWidth} min={160} max={800} onChange={(v) => updateUi(project.id, { sidebarWidth: v })} />
          </>
        )}
        <div className="center">
          <EditorArea project={project} />
        </div>
      </div>
      {ui.terminalVisible && (
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
            <TerminalPanel project={project} />
          </div>
        </>
      )}
    </div>
  );
}

function useGlobalShortcuts(project: Project | null) {
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
      if ((e.altKey && e.key === "F12") || (e.ctrlKey && e.key === "`")) {
        e.preventDefault();
        const inTerminal = (document.activeElement as HTMLElement | null)?.closest(".terminal-panel");
        // Like Rider: Alt+F12 focuses the terminal, pressing it there hides it.
        ws.updateUi(project.id, { terminalVisible: !(ui.terminalVisible && inTerminal) });
        return;
      }
      if (e.altKey && e.key === "1") {
        e.preventDefault();
        const inTree = (document.activeElement as HTMLElement | null)?.closest(".file-tree");
        ws.updateUi(project.id, { sidebarVisible: !(ui.sidebarVisible && inTree) });
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

export default function App() {
  const loaded = useWorkspace((s) => s.loaded);
  const projects = useWorkspace((s) => s.projects);
  const activeId = useWorkspace((s) => s.activeProjectId);
  const active = projects.find((p) => p.id === activeId && p.open) ?? null;
  const activeTab = useWorkspace((s) => (activeId ? s.ui[activeId]?.activeTab : null));

  useEffect(() => {
    void restore().then(() => startTerminals());
  }, []);

  // Watch open projects; keep tree, git and buffers in sync with disk.
  const openRoots = projects.filter((p) => p.open).map((p) => p.path).join("\n");
  useEffect(() => {
    if (!loaded) return;
    const open = useWorkspace.getState().projects.filter((p) => p.open);
    for (const p of open) {
      void api.watchProject(p.path).catch((e) => console.warn("watch failed", p.path, e));
      refreshGit(p.id, p.path);
    }
    return () => {
      for (const p of open) void api.unwatchProject(p.path).catch(() => {});
    };
  }, [loaded, openRoots]);

  useEffect(() => {
    const un = onFsChange((change) => {
      const ws = useWorkspace.getState();
      const project = ws.projects.find((p) => p.path === change.root);
      if (!project) return;
      handleFsChange(project.id, change, ws.nestFiles);
      void handleDiskChanges(change.overflow ? "all" : change.files);
    });
    return () => void un.then((f) => f());
  }, []);

  // Re-list directories when nesting is toggled.
  const nest = useWorkspace((s) => s.nestFiles);
  useEffect(() => {
    useTree.setState({ dirs: {} });
  }, [nest]);

  useEffect(() => {
    const title = active ? `${active.name}${activeTab ? " – " + basename(activeTab) : ""} — Haze` : "Haze";
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
      <ContextMenu />
      <Dialogs />
      <Toasts />
    </div>
  );
}
