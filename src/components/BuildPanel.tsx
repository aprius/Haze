// Build tool window: Problems from the last `dotnet build` (or Unity compilation) plus its output.
import { AlertCircle, AlertTriangle, ChevronDown, Hammer, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { basename, relative } from "../lib/path";
import { cancelBuild, useDotnet, type BuildState } from "../store/dotnet";
import { buildProject, useUnity } from "../store/unity";
import { useWorkspace, type BottomTab, type Project } from "../store/workspace";
import { shortcutLabel } from "../lib/keymap";
import { useFind } from "./FindPanel";

export function BuildPanel({ project }: { project: Project }) {
  const build = useDotnet((s) => s.builds[project.id]);
  const [filter, setFilter] = useState<"all" | "errors">("all");
  const outRef = useRef<HTMLPreElement>(null);
  const errors = build?.diagnostics.filter((d) => d.severity === "error") ?? [];
  const warnings = build?.diagnostics.filter((d) => d.severity === "warning") ?? [];
  const shown = filter === "errors" ? errors : [...errors, ...warnings];

  useEffect(() => {
    const el = outRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [build?.lines.length]);

  const status = buildStatus(build);

  return (
    <div className="terminal-panel build-panel">
      <div className="panel-header">
        <ToolTabs project={project} />
        <span className={"build-status" + (build?.result && build.result.code !== 0 && !build.running ? " failed" : "")}>{status}</span>
        <span className="build-counts">
          <AlertCircle size={13} className="sev-error" /> {errors.length}
          <AlertTriangle size={13} className="sev-warning" /> {warnings.length}
        </span>
        <div className="panel-actions">
          <div className="seg small">
            <button className={"seg-btn" + (filter === "all" ? " on" : "")} onClick={() => setFilter("all")}>
              All
            </button>
            <button className={"seg-btn" + (filter === "errors" ? " on" : "")} onClick={() => setFilter("errors")}>
              Errors
            </button>
          </div>
          {build?.running ? (
            <button className="icon-btn" title="Cancel build" onClick={() => cancelBuild(project.id)}>
              <Square size={16} />
            </button>
          ) : (
            <button
              className="icon-btn"
              title={`Build (${shortcutLabel("build")})`}
              onClick={() => void buildProject(project.id, project.path)}
            >
              <Hammer size={16} />
            </button>
          )}
          <button className="icon-btn" title="Hide" onClick={() => useWorkspace.getState().updateUi(project.id, { bottomVisible: false })}>
            <ChevronDown size={16} />
          </button>
        </div>
      </div>
      <div className="build-body">
        <div className="problems">
          {shown.length === 0 && <div className="se-empty">{build?.running ? "Building…" : build ? "No problems" : `Press ${shortcutLabel("build")} to build`}</div>}
          {shown.map((d, i) => (
            <div
              key={i}
              className="problem"
              title={d.project ?? undefined}
              onClick={() => d.file && useWorkspace.getState().openFile(project.id, d.file, d.line ? { line: d.line, column: d.column ?? 1 } : {})}
            >
              {d.severity === "error" ? <AlertCircle size={13} className="sev-error" /> : <AlertTriangle size={13} className="sev-warning" />}
              <span className="problem-msg">{d.message}</span>
              {d.code && <span className="problem-code">{d.code}</span>}
              {d.file && (
                <span className="problem-loc">
                  {basename(d.file)}
                  {d.line ? `:${d.line}` : ""} <span className="muted">{relative(project.path, d.file)}</span>
                </span>
              )}
            </div>
          ))}
        </div>
        <pre ref={outRef} className="build-output">
          {build?.lines.join("\n")}
        </pre>
      </div>
    </div>
  );
}

function buildStatus(build: BuildState | undefined): string {
  if (!build) return "No build yet";
  const took = build.result?.millis ? ` in ${(build.result.millis / 1000).toFixed(1)} s` : "";
  if (build.tool === "unity") {
    if (build.running) return "Compiling in Unity…";
    if (build.result?.cancelled) return "Not compiled";
    return build.result?.code === 0 ? `Unity: compiled${took}` : `Unity: compilation failed${took}`;
  }
  if (build.running) return `Running dotnet ${build.verb}…`;
  if (build.result?.cancelled) return "Cancelled";
  return build.result?.code === 0 ? `Succeeded${took}` : `Failed${took}`;
}

/** Switches the bottom panel between tool windows (Build, Git, and Unity's Console in Unity projects). */
export function ToolTabs({ project }: { project: Project }) {
  const tab = useWorkspace((s) => s.ui[project.id]?.bottomTab ?? "build");
  const unity = useUnity((s) => !!s.projects[project.id]);
  const find = useFind((s) => !!s.tabs[project.id]?.length);
  const set = (bottomTab: BottomTab) => useWorkspace.getState().updateUi(project.id, { bottomTab });
  return (
    <div className="tool-tabs">
      <button className={"tool-tab" + (tab === "build" ? " active" : "")} onClick={() => set("build")}>
        Build
      </button>
      <button className={"tool-tab" + (tab === "git" ? " active" : "")} onClick={() => set("git")} title="Git (Alt+9)">
        Git
      </button>
      {find && (
        <button className={"tool-tab" + (tab === "find" ? " active" : "")} onClick={() => set("find")} title="Find: usages opened in the Find window">
          Find
        </button>
      )}
      {unity && (
        <>
          <button className={"tool-tab" + (tab === "unity" ? " active" : "")} onClick={() => set("unity")} title="Unity's Console">
            Unity
          </button>
          <button className={"tool-tab" + (tab === "tests" ? " active" : "")} onClick={() => set("tests")} title="Unity tests">
            Tests
          </button>
        </>
      )}
    </div>
  );
}
