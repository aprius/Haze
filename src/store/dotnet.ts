// .NET state per project: discovered solutions/projects, the C# language
// server status, and the last build with its diagnostics (shown as editor
// markers — the only errors Haze shows, so they are always real).
import { create } from "zustand";
import { api, errorMessage, onBuildEvent, type BuildDiagnostic, type BuildEvent, type BuildVerb, type DotnetInfo } from "../lib/ipc";
import { monaco } from "../lib/monaco";
import { useWorkspace } from "./workspace";

export type CsharpState = "off" | "missing" | "starting" | "loading" | "ready" | "stopped" | "error";

export interface CsharpStatus {
  state: CsharpState;
  message?: string;
  kind?: string;
}

export interface BuildState {
  id: number | null;
  verb: BuildVerb;
  target: string | null;
  running: boolean;
  lines: string[];
  diagnostics: BuildDiagnostic[];
  result: { code: number | null; cancelled: boolean; millis: number } | null;
}

interface DotnetState {
  info: Record<string, DotnetInfo>;
  csharp: Record<string, CsharpStatus>;
  builds: Record<string, BuildState>;
}

export const useDotnet = create<DotnetState>(() => ({ info: {}, csharp: {}, builds: {} }));

export async function loadDotnetInfo(projectId: string, root: string): Promise<DotnetInfo | null> {
  try {
    const info = await api.dotnetInfo(root);
    useDotnet.setState((s) => ({ info: { ...s.info, [projectId]: info } }));
    return info;
  } catch {
    return null;
  }
}

export function setCsharpStatus(projectId: string, status: CsharpStatus): void {
  useDotnet.setState((s) => ({ csharp: { ...s.csharp, [projectId]: status } }));
}

/** Directories of the projects in the solution, for "Solution" search scope. */
export function solutionDirs(projectId: string): string[] {
  const info = useDotnet.getState().info[projectId];
  if (!info) return [];
  const dirs = info.projects.map((p) => p.path.replace(/[\\/][^\\/]+$/, ""));
  return [...new Set(dirs)];
}

// ------------------------------------------------------------------ builds

const MAX_LINES = 5000;
const buildProject = new Map<number, string>();
let listening = false;
/** Files edited since the last build: their build markers would point at the wrong lines. */
const editedSinceBuild = new Set<string>();

function diagKey(d: BuildDiagnostic): string {
  return [d.severity, d.code, d.file, d.line, d.column, d.message].join("|");
}

function samePath(a: string, b: string): boolean {
  const n = (p: string) => p.replace(/\\/g, "/").toLowerCase();
  return n(a) === n(b);
}

function markersFor(diags: BuildDiagnostic[]): monaco.editor.IMarkerData[] {
  return diags
    .filter((d) => d.line)
    .map((d) => ({
      severity: d.severity === "error" ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
      message: d.message,
      code: d.code ?? undefined,
      source: "build",
      startLineNumber: d.line!,
      startColumn: d.column ?? 1,
      endLineNumber: d.endLine ?? d.line!,
      endColumn: d.endColumn ?? (d.column ? d.column + 1 : 1000),
    }));
}

/** Puts build diagnostics on every open model (and on models opened later). */
function applyMarkers() {
  const all = Object.values(useDotnet.getState().builds).flatMap((b) => b.diagnostics);
  for (const model of monaco.editor.getModels()) {
    if (model.uri.scheme !== "file") continue;
    const path = model.uri.fsPath;
    const diags = editedSinceBuild.has(path) ? [] : all.filter((d) => d.file && samePath(d.file, path));
    monaco.editor.setModelMarkers(model, "build", markersFor(diags));
  }
}

function patchBuild(projectId: string, f: (b: BuildState) => Partial<BuildState>) {
  useDotnet.setState((s) => {
    const cur = s.builds[projectId];
    return cur ? { builds: { ...s.builds, [projectId]: { ...cur, ...f(cur) } } } : {};
  });
}

/** Events of builds whose id is not known yet, replayed once it is. */
const early = new Map<number, BuildEvent[]>();
const superseded = new Set<number>();
let handleEvent: (e: BuildEvent) => void = () => {};

function listen() {
  if (listening) return;
  listening = true;
  const track = (model: monaco.editor.ITextModel) =>
    model.onDidChangeContent(() => {
      const path = model.uri.fsPath;
      if (editedSinceBuild.has(path)) return;
      editedSinceBuild.add(path);
      monaco.editor.setModelMarkers(model, "build", []);
    });
  monaco.editor.getModels().forEach(track);
  monaco.editor.onDidCreateModel((m) => {
    track(m);
    setTimeout(applyMarkers, 0);
  });
  let pending = false;
  handleEvent = (e) => {
    if (superseded.has(e.id)) {
      // A build replaced by a newer one: its output and "cancelled" end are not the new build's.
      if (e.t === "done") superseded.delete(e.id);
      return;
    }
    const projectId = buildProject.get(e.id);
    if (!projectId) {
      // Output can arrive before build_start has returned the id.
      if (early.size < 50 || early.has(e.id)) early.set(e.id, [...(early.get(e.id) ?? []), e]);
      return;
    }
    if (e.t === "line") {
      patchBuild(projectId, (b) => {
        const lines = b.lines.length >= MAX_LINES ? [...b.lines.slice(-MAX_LINES / 2), e.text] : [...b.lines, e.text];
        const d = e.diagnostic;
        const diagnostics = d && !b.diagnostics.some((x) => diagKey(x) === diagKey(d)) ? [...b.diagnostics, d] : b.diagnostics;
        return { lines, diagnostics };
      });
      if (e.diagnostic && !pending) {
        pending = true;
        setTimeout(() => {
          pending = false;
          applyMarkers();
        }, 200);
      }
    } else {
      buildProject.delete(e.id);
      patchBuild(projectId, () => ({ running: false, result: { code: e.code, cancelled: e.cancelled, millis: e.millis } }));
      applyMarkers();
    }
  };
  void onBuildEvent((e) => handleEvent(e));
}

export async function startBuild(projectId: string, root: string, verb: BuildVerb, target: string | null): Promise<void> {
  listen();
  const cur = useDotnet.getState().builds[projectId];
  if (cur?.running && cur.id !== null) {
    superseded.add(cur.id);
    buildProject.delete(cur.id);
    await api.buildCancel(cur.id).catch(() => {});
  }
  useDotnet.setState((s) => ({
    builds: {
      ...s.builds,
      [projectId]: { id: null, verb, target, running: true, lines: [`> dotnet ${verb} ${target ?? ""}`.trim()], diagnostics: [], result: null },
    },
  }));
  editedSinceBuild.clear();
  applyMarkers();
  useWorkspace.getState().updateUi(projectId, { bottomVisible: true, bottomTab: "build" });
  try {
    const id = await api.buildStart(verb, target, root);
    buildProject.set(id, projectId);
    patchBuild(projectId, () => ({ id }));
    const missed = early.get(id) ?? [];
    early.delete(id);
    missed.forEach(handleEvent);
  } catch (e) {
    patchBuild(projectId, (b) => ({ running: false, lines: [...b.lines, errorMessage(e)], result: { code: null, cancelled: false, millis: 0 } }));
  }
}

export function cancelBuild(projectId: string): void {
  const b = useDotnet.getState().builds[projectId];
  if (b?.id != null) void api.buildCancel(b.id);
}

/** The solution if there is one, else the first project, else the folder itself. */
export function defaultBuildTarget(projectId: string): string | null {
  const info = useDotnet.getState().info[projectId];
  return info?.solutions[0] ?? info?.projects[0]?.path ?? null;
}
