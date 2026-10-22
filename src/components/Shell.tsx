// App chrome: project rail, welcome screen, splitters and status bar.
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { FolderOpen, FolderTree, GitBranch, GitCommitHorizontal, GitGraph, Hammer, LoaderCircle, Moon, Plus, RotateCcw, Settings, Star, Sun, TerminalSquare } from "lucide-react";
import { useRef } from "react";
import { useBuffers } from "../lib/buffers";
import { api, type TextEncoding } from "../lib/ipc";
import { toggleThemeMode, useTheme } from "../lib/theme";
import { useGit } from "../store/git";
import { useTasks } from "../store/tasks";
import { busyTerminals, closeTerminal, useTerminals } from "../store/terminals";
import { useTree } from "../store/tree";
import { toggleCommitWindow, useUi } from "../store/ui";
import { diffTitle, parseDiffPath } from "./DiffView";
import { openBranchesPopup } from "./GitDialogs";
import { openSettings } from "./SettingsDialog";
import { useWorkspace, type Project } from "../store/workspace";
import { closeTabsWithPrompt, PathCrumbs, useCursor } from "./EditorArea";
import { confirmAction, openMenu } from "./Overlays";
import { disposeView, toggleTerminal } from "./TerminalPanel";
import { shortcutLabel } from "../lib/keymap";
import { DEFAULT_ZOOM, resetZoom, useZoom } from "../lib/zoom";

export async function openFolder(): Promise<void> {
  const dir = await open({ directory: true, multiple: false, title: "Open Folder" });
  if (typeof dir === "string") useWorkspace.getState().addProject(dir);
}

function hue(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

const AVATAR_COLORS = ["cyan", "orange", "green", "purple", "red", "yellow"].map((c) => `var(--mk-${c})`);

function initials(name: string): string {
  const words = name.split(/[\s._-]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export function ProjectAvatar({ project, size = 30 }: { project: Project; size?: number }) {
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, background: AVATAR_COLORS[hue(project.path) % AVATAR_COLORS.length], fontSize: size * 0.4 }}
    >
      {initials(project.name)}
    </span>
  );
}

async function closeProject(project: Project) {
  const ui = useWorkspace.getState().ui[project.id];
  // Unsaved drafts are kept in the workspace file, so closing never loses them;
  // closing the tabs just asks first.
  if (ui && !(await closeTabsWithPrompt(project.id, ui.tabs.map((t) => t.path)))) return;
  useWorkspace.getState().closeProject(project.id);
}

/** Removes a project from the list, with its terminals: nothing would show them any more. */
async function removeFromList(project: Project) {
  const sessions = await api.ptyList().catch(() => Object.values(useTerminals.getState().sessions));
  const ids = sessions.filter((s) => s.projectId === project.id).map((s) => s.id);
  const busy = await busyTerminals(ids);
  if (
    busy.length &&
    !(await confirmAction(
      "Remove from List",
      `${project.name} has ${busy.length} terminal(s) still running. Terminate them and remove the project?`,
      "Terminate and Remove",
      true,
    ))
  )
    return;
  const ui = useWorkspace.getState().ui[project.id];
  if (ui && !(await closeTabsWithPrompt(project.id, ui.tabs.map((t) => t.path)))) return;
  for (const id of ids) {
    disposeView(id);
    await closeTerminal(project.id, id);
  }
  useWorkspace.getState().removeProject(project.id);
}

/** Dot on a project's avatar when one of its agents needs a look. */
function AgentBadge({ projectId }: { projectId: string }) {
  const state = useTerminals((s) => {
    const mine = Object.entries(s.sessions).filter(([, x]) => x.projectId === projectId);
    // Waiting for input stays visible until answered; "done" only until seen.
    if (mine.some(([, x]) => x.agent?.state === "waiting")) return "waiting";
    if (mine.some(([id]) => s.attention[id])) return "done";
    return mine.some(([, x]) => x.agent?.state === "working") ? "working" : null;
  });
  return state ? <span className={"rail-agent " + state} title={state === "waiting" ? "An agent needs your input" : state === "done" ? "An agent finished" : "An agent is working"} /> : null;
}

export function ProjectRail() {
  const projects = useWorkspace((s) => s.projects);
  const activeId = useWorkspace((s) => s.activeProjectId);
  const ws = useWorkspace.getState;
  const themeMode = useTheme((s) => s.mode);
  const open = projects.filter((p) => p.open).sort((a, b) => Number(b.favorite) - Number(a.favorite));

  return (
    <nav className="project-rail">
      {open.map((p) => (
        <button
          key={p.id}
          className={"rail-item" + (p.id === activeId ? " active" : "")}
          title={`${p.name}\n${p.path}`}
          onClick={() => ws().activateProject(p.id)}
          onContextMenu={(e) => {
            e.preventDefault();
            openMenu(e, [
              { label: p.favorite ? "Remove from Favorites" : "Add to Favorites", action: () => ws().toggleFavorite(p.id) },
              { label: "Move Up", action: () => ws().moveProject(p.id, -1) },
              { label: "Move Down", action: () => ws().moveProject(p.id, 1) },
              { separator: true },
              { label: "Reveal in File Manager", action: () => void revealItemInDir(p.path) },
              { separator: true },
              { label: "Close Project", action: () => void closeProject(p) },
            ]);
          }}
        >
          <ProjectAvatar project={p} size={24} />
          {p.favorite && <Star size={8} className="rail-star" />}
          <AgentBadge projectId={p.id} />
        </button>
      ))}
      <button className="rail-item add" title="Open Folder…" onClick={() => void openFolder()}>
        <Plus size={16} />
      </button>
      <div className="rail-spacer" />
      <button
        className="rail-item"
        title={themeMode === "dark" ? "Switch to Light Theme" : "Switch to Dark Theme"}
        onClick={toggleThemeMode}
      >
        {themeMode === "dark" ? <Sun size={15} /> : <Moon size={15} />}
      </button>
      <button className="rail-item" title={`Settings (${shortcutLabel("settings")})`} onClick={() => openSettings()}>
        <Settings size={15} />
      </button>
      <button
        className={"rail-item" + (activeId === null ? " active" : "")}
        title="Welcome / Recent Projects"
        onClick={() => ws().activateProject(null)}
      >
        <FolderOpen size={16} />
      </button>
    </nav>
  );
}

export function Welcome() {
  const projects = useWorkspace((s) => s.projects);
  const ws = useWorkspace.getState;
  const sorted = [...projects].sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.lastOpenedAt - a.lastOpenedAt);
  return (
    <div className="welcome">
      <div className="welcome-inner">
        <h1>Haze</h1>
        <p className="muted">A quiet workspace for coding with AI agents.</p>
        <div className="welcome-actions">
          <button className="btn primary" onClick={() => void openFolder()}>
            <FolderOpen size={14} /> Open Folder…
          </button>
        </div>
        {sorted.length > 0 && (
          <>
            <h2>Projects</h2>
            <div className="recent-list">
              {sorted.map((p) => (
                <div
                  key={p.id}
                  className="recent-item"
                  onClick={() => ws().activateProject(p.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    openMenu(e, [
                      { label: p.favorite ? "Remove from Favorites" : "Add to Favorites", action: () => ws().toggleFavorite(p.id) },
                      { label: "Remove from List", danger: true, action: () => void removeFromList(p) },
                    ]);
                  }}
                >
                  <ProjectAvatar project={p} size={26} />
                  <div className="recent-text">
                    <div>
                      {p.name} {p.favorite && <Star size={11} className="inline-star" />}
                      {p.open && <span className="tag">open</span>}
                    </div>
                    <div className="muted small">{p.path}</div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Drag handle that resizes a neighbouring pane. */
export function Splitter({
  vertical,
  value,
  min,
  max,
  invert,
  onChange,
}: {
  vertical: boolean;
  value: number;
  min: number;
  max: number;
  invert?: boolean;
  onChange: (v: number) => void;
}) {
  const start = useRef<{ pos: number; value: number } | null>(null);
  return (
    <div
      className={"splitter " + (vertical ? "vertical" : "horizontal")}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { pos: vertical ? e.clientX : e.clientY, value };
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        const delta = (vertical ? e.clientX : e.clientY) - start.current.pos;
        onChange(Math.max(min, Math.min(max, start.current.value + (invert ? -delta : delta))));
      }}
      onPointerUp={() => (start.current = null)}
    />
  );
}

const ENCODING_LABELS: Record<TextEncoding, string> = {
  utf8: "UTF-8",
  "utf8-bom": "UTF-8 BOM",
  utf16le: "UTF-16LE",
  utf16be: "UTF-16BE",
  windows1252: "Windows-1252",
  "utf8-invalid": "UTF-8 (invalid bytes)",
  "utf8-bom-invalid": "UTF-8 BOM (invalid bytes)",
};

export function toggleSidebar(projectId: string): void {
  const ws = useWorkspace.getState();
  ws.updateUi(projectId, { sidebarVisible: !ws.ui[projectId]?.sidebarVisible });
}

/** Shows the bottom dock on `tab`, or hides it when that tab is already showing. */
export function toggleBottom(projectId: string, tab: "build" | "git"): void {
  const ws = useWorkspace.getState();
  const ui = ws.ui[projectId];
  const showing = !!ui?.bottomVisible && ui.bottomTab === tab;
  ws.updateUi(projectId, { bottomVisible: !showing, bottomTab: tab });
}

/** Rider's background-process indicator: the latest task, how many more, and a list on click. */
function BackgroundTasks({ projectId }: { projectId: string | null }) {
  const all = useTasks((s) => s.tasks);
  const tasks = all.filter((t) => t.projectId === null || t.projectId === projectId);
  if (!tasks.length) return null;
  const latest = tasks[tasks.length - 1];
  const open = (e: React.MouseEvent) =>
    openMenu(
      e,
      tasks.map((t) => {
        const label = `${t.label} (${Math.round((Date.now() - t.started) / 1000)}s)`;
        return t.cancel ? { label: `Cancel ${label}`, action: t.cancel } : { label, disabled: true };
      }),
    );
  return (
    <button className="status-item status-btn status-task" onClick={open} title={tasks.map((t) => t.label).join("\n")}>
      <LoaderCircle size={12} className="spin" />
      <span className="status-task-label">{latest.label}</span>
      {tasks.length > 1 && <span>+{tasks.length - 1}</span>}
    </button>
  );
}

export function StatusBar({ project }: { project: Project | null }) {
  const git = useTree((s) => (project ? s.git[project.id] : undefined));
  const operation = useGit((s) => (project ? s.repos[project.id]?.branches?.operation : null));
  const ui = useWorkspace((s) => (project ? s.ui[project.id] : undefined));
  const meta = useBuffers((s) => (ui?.activeTab ? s.meta[ui.activeTab] : undefined));
  const cursor = useCursor();
  const commitOpen = useUi((s) => !!project && s.commitWindow === project.id);
  const zoom = useZoom((s) => s.zoom);
  return (
    <div className="status-bar">
      {project && (
        <>
          <button
            className={"status-item status-btn" + (ui?.sidebarVisible ? " on" : "")}
            onClick={() => toggleSidebar(project.id)}
            title="Project (Alt+1)"
          >
            <FolderTree size={12} />
          </button>
          <button
            className={"status-item status-btn" + (commitOpen ? " on" : "")}
            onClick={() => toggleCommitWindow(project.id)}
            title="Commit (Alt+0)"
          >
            <GitCommitHorizontal size={12} />
          </button>
          {!ui?.activeTab && <span className="status-item">{project.name}</span>}
          {git?.status.isRepo && (
            <button className="status-item status-btn" title={`Branches (${shortcutLabel("branches")})`} onClick={() => openBranchesPopup(project)}>
              <GitBranch size={12} /> {git.status.branch ?? "detached"}
              {operation && <span className="status-op">({operation} in progress)</span>}
            </button>
          )}
          {ui?.activeTab &&
            (parseDiffPath(ui.activeTab) ? (
              <span className="status-item muted">{diffTitle(parseDiffPath(ui.activeTab)!)}</span>
            ) : ui.activeTab.startsWith("haze-merge:") ? (
              <span className="status-item muted">Merge</span>
            ) : (
              <PathCrumbs project={project} path={ui.activeTab} />
            ))}
        </>
      )}
      <span className="status-spacer" />
      <BackgroundTasks projectId={project?.id ?? null} />
      {meta?.status === "text" && (
        <>
          <span className="status-item">
            {cursor.line}:{cursor.column}
            {cursor.selected > 0 && ` (${cursor.selected} chars)`}
          </span>
          <span className="status-item">{meta.eol.toUpperCase()}</span>
          <span className="status-item" title={meta.encoding.endsWith("-invalid") ? "Invalid UTF-8 bytes are kept as they are when saving" : undefined}>
            {ENCODING_LABELS[meta.encoding]}
          </span>
        </>
      )}
      {zoom !== DEFAULT_ZOOM && (
        <button className="status-item status-btn" onClick={resetZoom} title={`Zoom ${Math.round(zoom * 100)}% — click to reset to 100% (${shortcutLabel("resetZoom")})`}>
          {Math.round(zoom * 100)}% <RotateCcw size={11} />
        </button>
      )}
      {project && (
        <>
          <button
            className={"status-item status-btn" + (ui?.bottomVisible && ui.bottomTab === "build" ? " on" : "")}
            onClick={() => toggleBottom(project.id, "build")}
            title="Build"
          >
            <Hammer size={12} /> Build
          </button>
          <button
            className={"status-item status-btn" + (ui?.bottomVisible && ui.bottomTab === "git" ? " on" : "")}
            onClick={() => toggleBottom(project.id, "git")}
            title="Git (Alt+9)"
          >
            <GitGraph size={12} /> Git
          </button>
        </>
      )}
      {project && (
        <button
          className={"status-item status-btn" + (ui?.terminalVisible ? " on" : "")}
          onClick={() => toggleTerminal(project.id, false)}
          title={`Terminal (${shortcutLabel("terminal")})`}
        >
          <TerminalSquare size={12} /> Terminal
        </button>
      )}
    </div>
  );
}
