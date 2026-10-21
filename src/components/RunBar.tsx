// Top toolbar of a .NET project: build target, run configuration, Build / Run / Test.
import { FlaskConical, Hammer, Play, RefreshCw, Square } from "lucide-react";
import { useMemo } from "react";
import type { DotnetInfo } from "../lib/ipc";
import { restartCsharp } from "../lib/lsp/csharp";
import { basename, dirname } from "../lib/path";
import { cancelBuild, defaultBuildTarget, startBuild, useDotnet, type CsharpStatus } from "../store/dotnet";
import { closeTerminal, newTerminal, useTerminals } from "../store/terminals";
import { useWorkspace, type Project } from "../store/workspace";
import { confirmAction } from "./Overlays";

export interface RunConfig {
  id: string;
  label: string;
  command: string[];
  cwd: string;
}

export function runConfigs(info: DotnetInfo | undefined): RunConfig[] {
  if (!info) return [];
  const out: RunConfig[] = [];
  for (const p of info.projects) {
    if (p.isTest || !p.runnable) continue;
    const profiles = p.launchProfiles.filter((l) => l.commandName === "Project");
    if (profiles.length) {
      for (const l of profiles) {
        out.push({
          id: `run:${p.path}:${l.name}`,
          label: profiles.length === 1 && l.name === p.name ? p.name : `${p.name}: ${l.name}`,
          command: ["dotnet", "run", "--project", p.path, "--launch-profile", l.name],
          cwd: dirname(p.path),
        });
      }
    } else {
      out.push({ id: `run:${p.path}`, label: p.name, command: ["dotnet", "run", "--project", p.path], cwd: dirname(p.path) });
    }
  }
  const testTarget = info.solutions[0] ?? info.projects.find((p) => p.isTest)?.path;
  if (testTarget && info.projects.some((p) => p.isTest)) {
    out.push({ id: `test:${testTarget}`, label: `Test: ${basename(testTarget)}`, command: ["dotnet", "test", testTarget], cwd: dirname(testTarget) });
  }
  return out;
}

/** Runs a configuration in its own terminal tab, restarting it if still running. */
export async function runConfig(project: Project, cfg: RunConfig): Promise<void> {
  const ui = useWorkspace.getState().ui[project.id];
  const sessions = useTerminals.getState().sessions;
  const existing = ui?.terminalOrder.find((id) => sessions[id]?.title === cfg.label);
  if (existing) {
    if (sessions[existing]?.running && !(await confirmAction("Run", `"${cfg.label}" is still running. Stop and run again?`, "Restart"))) {
      useWorkspace.getState().updateUi(project.id, { activeTerminal: existing, terminalVisible: true });
      return;
    }
    await closeTerminal(project.id, existing);
  }
  await newTerminal(project.id, cfg.cwd, { title: cfg.label, command: cfg.command });
}

function csharpLabel(s: CsharpStatus | undefined): { text: string; tone: string } {
  switch (s?.state) {
    case "ready":
      return { text: "C# ready", tone: "ok" };
    case "starting":
    case "loading":
      return { text: s.message ? `C#: ${s.message}` : "C#: loading…", tone: "busy" };
    case "missing":
      return { text: "C# server not installed", tone: "warn" };
    case "stopped":
    case "error":
      return { text: s.message ?? "C# server stopped", tone: "warn" };
    default:
      return { text: "", tone: "" };
  }
}

export function RunBar({ project }: { project: Project }) {
  const info = useDotnet((s) => s.info[project.id]);
  const build = useDotnet((s) => s.builds[project.id]);
  const csharp = useDotnet((s) => s.csharp[project.id]);
  const selected = useWorkspace((s) => s.ui[project.id]?.runConfig ?? null);
  const configs = useMemo(() => runConfigs(info), [info]);
  if (!info || info.projects.length === 0) return null;
  const current = configs.find((c) => c.id === selected) ?? configs[0];
  const target = defaultBuildTarget(project.id);
  const label = csharpLabel(csharp);

  return (
    <div className="run-bar">
      <span className="run-target" title={target ?? project.path}>
        {target ? basename(target) : project.name}
      </span>
      {label.text && (
        <span className={"csharp-status " + label.tone} title={[csharp?.kind && `Language server: ${csharp.kind}`, csharp?.message].filter(Boolean).join("\n") || undefined}>
          {label.text}
          {csharp?.state === "missing" && (
            <button
              className="btn small"
              onClick={() =>
                void newTerminal(project.id, project.path, {
                  title: "Install C# server",
                  command: ["dotnet", "tool", "install", "--global", "roslyn-language-server", "--prerelease"],
                })
              }
            >
              Install
            </button>
          )}
          {(csharp?.state === "missing" || csharp?.state === "stopped" || csharp?.state === "error") && (
            <button className="icon-btn" title="Start the C# server again" onClick={() => void restartCsharp(project.id, project.path)}>
              <RefreshCw size={12} />
            </button>
          )}
        </span>
      )}
      <span className="run-spacer" />
      {build?.running ? (
        <button className="icon-btn" title="Cancel build" onClick={() => cancelBuild(project.id)}>
          <Square size={14} />
        </button>
      ) : (
        <button className="icon-btn" title="Build (Ctrl+Shift+B)" onClick={() => void startBuild(project.id, project.path, "build", target)}>
          <Hammer size={14} />
        </button>
      )}
      {configs.length > 0 && (
        <>
          <select
            className="find-select run-select"
            value={current?.id}
            onChange={(e) => useWorkspace.getState().updateUi(project.id, { runConfig: e.target.value })}
          >
            {configs.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
          <button className="icon-btn run" title="Run (Shift+F10)" onClick={() => current && void runConfig(project, current)}>
            {current?.id.startsWith("test:") ? <FlaskConical size={14} /> : <Play size={14} />}
          </button>
        </>
      )}
    </div>
  );
}
