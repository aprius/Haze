// Build tool window: Problems from the last `dotnet build` plus its output.
import { AlertCircle, AlertTriangle, ChevronDown, Hammer, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { basename, relative } from "../lib/path";
import { cancelBuild, defaultBuildTarget, startBuild, useDotnet } from "../store/dotnet";
import { useWorkspace, type Project } from "../store/workspace";
import { ToolTabs } from "./TerminalPanel";

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

  const status = !build
    ? "No build yet"
    : build.running
      ? `Running dotnet ${build.verb}…`
      : build.result?.cancelled
        ? "Cancelled"
        : build.result?.code === 0
          ? `Succeeded in ${((build.result?.millis ?? 0) / 1000).toFixed(1)} s`
          : `Failed${build.result ? ` in ${(build.result.millis / 1000).toFixed(1)} s` : ""}`;

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
              <Square size={14} />
            </button>
          ) : (
            <button
              className="icon-btn"
              title="Build (Ctrl+Shift+B)"
              onClick={() => void startBuild(project.id, project.path, "build", build?.target ?? defaultBuildTarget(project.id))}
            >
              <Hammer size={14} />
            </button>
          )}
          <button className="icon-btn" title="Hide (Alt+F12)" onClick={() => useWorkspace.getState().updateUi(project.id, { terminalVisible: false })}>
            <ChevronDown size={14} />
          </button>
        </div>
      </div>
      <div className="build-body">
        <div className="problems">
          {shown.length === 0 && <div className="se-empty">{build?.running ? "Building…" : build ? "No problems" : "Press Ctrl+Shift+B to build"}</div>}
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
