// Title bar: the window's drag area with the project name, and for a .NET project
// the C# server status, run configuration and Build / Run / Test; for a Unity
// project, Play / Pause / Step and Refresh in its Unity Editor.
import { homeDir } from "@tauri-apps/api/path";
import { FlaskConical, Hammer, Pause, Play, RefreshCw, Square, StepForward, X } from "lucide-react";
import { useMemo, useState } from "react";
import { api, type DotnetInfo } from "../lib/ipc";
import { restartCsharp } from "../lib/lsp/csharp";
import { basename, dirname } from "../lib/path";
import { cancelBuild, defaultBuildTarget, loadDotnetInfo, useDotnet, type CsharpStatus } from "../store/dotnet";
import { buildProject, unityCommand, useUnity } from "../store/unity";
import { closeTerminal, newTerminal, useTerminals } from "../store/terminals";
import { useWorkspace, type Project } from "../store/workspace";
import { confirmAction } from "./Overlays";
import { isMac, isWindows, shortcutLabel } from "../lib/keymap";
import { useZoom } from "../lib/zoom";

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

const ROSLYN_INSTALL = ["dotnet", "tool", "install", "--global", "roslyn-language-server", "--prerelease"];
/** Set when the user chose to stay on csharp-ls: Haze stops suggesting Roslyn. */
const KEEP_CSHARP_LS = "haze.keepCsharpLs";

function keepsCsharpLs(): boolean {
  try {
    return localStorage.getItem(KEEP_CSHARP_LS) === "1";
  } catch {
    return false;
  }
}

/**
 * The .NET SDK from the system's package manager (Homebrew, winget) where it
 * has one, else Microsoft's `dotnet-install` script into ~/.dotnet, which needs
 * no admin rights. Haze looks in both places (shell_env.rs), with no restart.
 */
const DOTNET_INSTALL = isWindows
  ? [
      "powershell.exe",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "if (Get-Command winget -ErrorAction SilentlyContinue) { winget install --id Microsoft.DotNet.SDK.10 --exact --accept-source-agreements --accept-package-agreements; exit $LASTEXITCODE } " +
        "else { & ([scriptblock]::Create((Invoke-RestMethod https://dot.net/v1/dotnet-install.ps1))) -Channel LTS }",
    ]
  : [
      "/bin/sh",
      "-c",
      // Downloaded first: `curl | bash` succeeds when the download fails.
      (isMac ? "if command -v brew >/dev/null 2>&1; then brew install --cask dotnet-sdk; else " : "{ ") +
        'f=$(mktemp) && curl -fsSL https://dot.net/v1/dotnet-install.sh -o "$f" && bash "$f" --channel LTS' +
        (isMac ? "; fi" : "; }"),
    ];

/**
 * Runs a global install in a terminal (which shows any failure); whether it
 * succeeded. From the home folder: `dotnet tool install --global` still reads
 * the folder it runs in, and fails in one with several project files (Unity's).
 */
async function installInTerminal(project: Project, title: string, command: string[]): Promise<boolean> {
  const id = await newTerminal(project.id, await homeDir(), { title, command });
  if (!id) return false;
  return new Promise((resolve) => {
    const unsubscribe = useTerminals.subscribe((s) => {
      const t = s.sessions[id];
      if (t?.running) return;
      unsubscribe();
      resolve(t?.exitCode === 0);
    });
  });
}

/** Starts C# again in the open projects where it was missing or failed, or where csharp-ls ran. */
function restartWhereNeeded(): void {
  const { csharp } = useDotnet.getState();
  for (const p of useWorkspace.getState().projects) {
    const status = csharp[p.id];
    if (p.open && status && (status.state === "missing" || status.state === "stopped" || status.state === "error" || status.kind === "csharp-ls")) void restartCsharp(p.id, p.path);
  }
}

/** Installs Roslyn's language server, then starts C# again, now with Roslyn. */
async function installRoslyn(project: Project): Promise<void> {
  if (await installInTerminal(project, "Install C# server", ROSLYN_INSTALL)) restartWhereNeeded();
}

/**
 * Installs the .NET SDK, then Roslyn's language server unless one is there
 * already, then starts C# again: one click from nothing to C# support.
 */
async function installDotnet(project: Project): Promise<void> {
  if (!(await installInTerminal(project, "Install .NET", DOTNET_INSTALL))) return;
  const open = useWorkspace.getState().projects.filter((p) => p.open);
  await Promise.all(open.map((p) => loadDotnetInfo(p.id, p.path)));
  if (await api.lspFindServer()) restartWhereNeeded();
  else await installRoslyn(project);
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

function RunControls({ project }: { project: Project }) {
  const info = useDotnet((s) => s.info[project.id]);
  const build = useDotnet((s) => s.builds[project.id]);
  const csharp = useDotnet((s) => s.csharp[project.id]);
  const selected = useWorkspace((s) => s.ui[project.id]?.runConfig ?? null);
  const configs = useMemo(() => runConfigs(info), [info]);
  const unity = useUnity((s) => !!s.projects[project.id]);
  const [keepCsharpLs, setKeepCsharpLs] = useState(keepsCsharpLs);
  if (!info || info.projects.length === 0)
    return unity ? (
      <>
        <span className="run-spacer" data-tauri-drag-region />
        <UnityControls project={project} />
      </>
    ) : null;
  const current = configs.find((c) => c.id === selected) ?? configs[0];
  const target = defaultBuildTarget(project.id);
  // Without .NET nothing C# works (server, build, run): that is the one thing to fix.
  const noDotnet = !info.dotnetVersion && csharp?.state !== "ready";
  const label = noDotnet ? { text: ".NET SDK not installed", tone: "warn" } : csharpLabel(csharp);
  // Roslyn loads projects faster and has more fixes and refactorings; it needs the .NET 10 runtime.
  const suggestRoslyn = csharp?.kind === "csharp-ls" && csharp.state !== "missing" && !keepCsharpLs && Number(info.dotnetVersion?.split(".")[0]) >= 10;

  return (
    <>
      {label.text && (
        <span className={"csharp-status " + label.tone} title={[csharp?.kind && `Language server: ${csharp.kind}`, csharp?.message].filter(Boolean).join("\n") || undefined}>
          {label.text}
          {noDotnet && (
            <button
              className="btn small"
              title={"Installs the .NET SDK (" + DOTNET_INSTALL.join(" ") + "), then the C# language server, then starts C#."}
              onClick={() => void installDotnet(project)}
            >
              Install .NET
            </button>
          )}
          {!noDotnet && csharp?.state === "missing" && (
            <button className="btn small" onClick={() => void installRoslyn(project)}>
              Install
            </button>
          )}
          {suggestRoslyn && (
            <>
              <button
                className="btn small"
                title={"C# runs on csharp-ls. Microsoft's Roslyn language server loads projects faster and offers more quick fixes and refactorings.\nInstalls it (" + ROSLYN_INSTALL.join(" ") + "), then starts C# again with it."}
                onClick={() => void installRoslyn(project)}
              >
                Use Roslyn
              </button>
              <button
                className="icon-btn"
                title="Keep csharp-ls (stop suggesting Roslyn)"
                onClick={() => {
                  try {
                    localStorage.setItem(KEEP_CSHARP_LS, "1");
                  } catch {
                    /* storage unavailable: hidden until Haze restarts */
                  }
                  setKeepCsharpLs(true);
                }}
              >
                <X size={16} />
              </button>
            </>
          )}
          {(noDotnet || csharp?.state === "missing" || csharp?.state === "stopped" || csharp?.state === "error") && (
            <button
              className="icon-btn"
              title={noDotnet ? "Look for .NET and start the C# server again (after installing .NET yourself)" : "Start the C# server again"}
              onClick={() => void (noDotnet ? loadDotnetInfo(project.id, project.path) : Promise.resolve()).then(() => restartCsharp(project.id, project.path))}
            >
              <RefreshCw size={16} />
            </button>
          )}
        </span>
      )}
      <span className="run-spacer" data-tauri-drag-region />
      <UnityControls project={project} />
      {build?.running ? (
        <button className="icon-btn" title="Cancel build" onClick={() => cancelBuild(project.id)}>
          <Square size={16} />
        </button>
      ) : (
        <button className="icon-btn" title={`Build ${target ? basename(target) : project.name} (${shortcutLabel("build")})`} onClick={() => void buildProject(project.id, project.path)}>
          <Hammer size={16} />
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
          <button className="icon-btn run" title={`Run (${shortcutLabel("run")})`} onClick={() => current && void runConfig(project, current)}>
            {current?.id.startsWith("test:") ? <FlaskConical size={16} /> : <Play size={16} />}
          </button>
        </>
      )}
    </>
  );
}

/** Unity toolbar: the link to the Unity Editor, and its Play / Pause / Step. */
function UnityControls({ project }: { project: Project }) {
  const unity = useUnity((s) => s.projects[project.id]);
  if (!unity) return null;
  const off = !unity.connected;
  const hint = off ? "Unity is not connected: open the project in Unity with Haze as External Script Editor (package com.aprius.ide.haze)" : null;
  const send = (command: "play" | "pause" | "step" | "refresh") => void unityCommand(project.id, command);
  return (
    <span className="unity-controls">
      <span className={"unity-link" + (off ? "" : " on")} title={hint ?? `Connected to Unity ${unity.version ?? ""}`.trim()}>
        Unity
      </span>
      <button className={"icon-btn" + (unity.playing ? " on" : "")} disabled={off} title={hint ?? (unity.playing ? "Stop" : "Play")} onClick={() => send("play")}>
        {unity.playing ? <Square size={16} /> : <Play size={16} />}
      </button>
      <button className={"icon-btn" + (unity.paused ? " on" : "")} disabled={off} title={hint ?? "Pause"} onClick={() => send("pause")}>
        <Pause size={16} />
      </button>
      <button className="icon-btn" disabled={off || !unity.playing} title={hint ?? "Step"} onClick={() => send("step")}>
        <StepForward size={16} />
      </button>
      <button className="icon-btn" disabled={off || unity.playing} title={hint ?? "Refresh assets in Unity"} onClick={() => send("refresh")}>
        <RefreshCw size={16} />
      </button>
      <span className="unity-sep" />
    </span>
  );
}

/** Stands in for the native title bar, which on macOS is hidden under the web content. */
export function TitleBar({ project }: { project: Project | null }) {
  const zoom = useZoom((s) => s.zoom);
  // Webview zoom scales CSS pixels but not the traffic lights, so their room is kept in screen pixels.
  const style = isMac ? { paddingLeft: 78 / zoom, height: Math.max(36, 36 / zoom) } : undefined;
  return (
    <div className="title-bar" data-tauri-drag-region style={style}>
      <span className="title-name" data-tauri-drag-region title={project?.path}>
        {project?.name ?? "Haze"}
      </span>
      {project ? <RunControls project={project} /> : <span className="run-spacer" data-tauri-drag-region />}
    </div>
  );
}
