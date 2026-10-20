// App chrome: project rail, welcome screen, splitters and status bar.
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { FolderOpen, GitBranch, Plus, Star, TerminalSquare } from "lucide-react";
import { useRef } from "react";
import { useBuffers } from "../lib/buffers";
import { basename } from "../lib/path";
import { useTree } from "../store/tree";
import { useWorkspace, type Project } from "../store/workspace";
import { closeTabsWithPrompt, useCursor } from "./EditorArea";
import { openMenu } from "./Overlays";

export async function openFolder(): Promise<void> {
  const dir = await open({ directory: true, multiple: false, title: "Open Folder" });
  if (typeof dir === "string") useWorkspace.getState().addProject(dir);
}

function hue(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function initials(name: string): string {
  const words = name.split(/[\s._-]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export function ProjectAvatar({ project, size = 30 }: { project: Project; size?: number }) {
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, background: `hsl(${hue(project.path)} 45% 42%)`, fontSize: size * 0.4 }}
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

export function ProjectRail() {
  const projects = useWorkspace((s) => s.projects);
  const activeId = useWorkspace((s) => s.activeProjectId);
  const ws = useWorkspace.getState;
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
          <ProjectAvatar project={p} />
          {p.favorite && <Star size={9} className="rail-star" />}
        </button>
      ))}
      <button className="rail-item add" title="Open Folder…" onClick={() => void openFolder()}>
        <Plus size={18} />
      </button>
      <div className="rail-spacer" />
      <button
        className={"rail-item" + (activeId === null ? " active" : "")}
        title="Welcome / Recent Projects"
        onClick={() => ws().activateProject(null)}
      >
        <FolderOpen size={18} />
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
                      { label: "Remove from List", danger: true, action: () => ws().removeProject(p.id) },
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

export function StatusBar({ project }: { project: Project | null }) {
  const git = useTree((s) => (project ? s.git[project.id] : undefined));
  const ui = useWorkspace((s) => (project ? s.ui[project.id] : undefined));
  const meta = useBuffers((s) => (ui?.activeTab ? s.meta[ui.activeTab] : undefined));
  const cursor = useCursor();
  const updateUi = useWorkspace((s) => s.updateUi);
  return (
    <div className="status-bar">
      {project && (
        <>
          <span className="status-item">{project.name}</span>
          {git?.status.isRepo && (
            <span className="status-item">
              <GitBranch size={12} /> {git.status.branch ?? "detached"}
            </span>
          )}
          {ui?.activeTab && <span className="status-item muted">{basename(ui.activeTab)}</span>}
        </>
      )}
      <span className="status-spacer" />
      {meta?.status === "text" && (
        <>
          <span className="status-item">
            {cursor.line}:{cursor.column}
            {cursor.selected > 0 && ` (${cursor.selected} chars)`}
          </span>
          <span className="status-item">{meta.eol.toUpperCase()}</span>
          <span className="status-item">{meta.encoding.toUpperCase().replace("UTF", "UTF-").replace("-BOM", " BOM")}</span>
        </>
      )}
      {project && (
        <button
          className={"status-item status-btn" + (ui?.terminalVisible ? " on" : "")}
          onClick={() => updateUi(project.id, (u) => ({ terminalVisible: !u.terminalVisible }))}
          title="Terminal (Alt+F12)"
        >
          <TerminalSquare size={12} /> Terminal
        </button>
      )}
    </div>
  );
}
