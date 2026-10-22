// The live link to the Unity Editor of each open Unity project (com.aprius.ide.haze's
// HazeLink): play mode, script compilations shown as builds, and the Console.
import { create } from "zustand";
import { api, onUnityEvent, type FsChange, type TestStatus, type UnityCommand, type UnityLogType, type UnityMessage, type UnityRequest } from "../lib/ipc";
import { isWithin } from "../lib/path";
import { defaultBuildTarget, startBuild, unityCompileFinished, unityCompileStarted, unityCompileUnanswered } from "./dotnet";
import { useWorkspace } from "./workspace";

export interface UnityLog {
  id: number;
  type: UnityLogType;
  message: string;
  stack: string;
  time: number;
}

export interface TestResult {
  fullName: string;
  name: string;
  status: TestStatus | "running";
  duration: number;
  message: string | null;
  stack: string | null;
  output: string | null;
}

export interface TestRun {
  running: boolean;
  /** What was run: "All tests", a fixture or a test. */
  label: string;
  /** Tests of the last run, in the order Unity ran them. */
  order: string[];
  /** Last result of every test run since Haze started, for Code Vision. */
  results: Record<string, TestResult>;
  summary: { passed: number; failed: number; skipped: number } | null;
  error: string | null;
}

export interface UnityProject {
  root: string;
  connected: boolean;
  version: string | null;
  playing: boolean;
  paused: boolean;
  compiling: boolean;
  logs: UnityLog[];
  tests: TestRun;
}

const noTests = (): TestRun => ({ running: false, label: "", order: [], results: {}, summary: null, error: null });

/** Unity projects by project id; absent for other projects. */
export const useUnity = create<{ projects: Record<string, UnityProject> }>(() => ({ projects: {} }));

const MAX_LOGS = 3000;
/** How long Haze waits for Unity to start compiling or answer a compile request. */
const ANSWER_TIMEOUT = 10_000;
let nextLogId = 1;
let listening = false;

function projectIdFor(root: string): string | null {
  return Object.entries(useUnity.getState().projects).find(([, u]) => u.root === root)?.[0] ?? null;
}

function patch(projectId: string, f: (u: UnityProject) => Partial<UnityProject>) {
  useUnity.setState((s) => {
    const cur = s.projects[projectId];
    return cur ? { projects: { ...s.projects, [projectId]: { ...cur, ...f(cur) } } } : {};
  });
}

/** Console messages arrive in bursts (a log per frame): they join the store at most every 100 ms. */
const pendingLogs = new Map<string, UnityLog[]>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function queueLog(projectId: string, log: UnityLog) {
  pendingLogs.set(projectId, [...(pendingLogs.get(projectId) ?? []), log]);
  flushTimer ??= setTimeout(() => {
    flushTimer = null;
    for (const [id, logs] of pendingLogs) {
      patch(id, (u) => {
        const all = u.logs.concat(logs);
        return { logs: all.length > MAX_LOGS ? all.slice(all.length - MAX_LOGS) : all };
      });
    }
    pendingLogs.clear();
  }, 100);
}

const answerTimers = new Map<string, ReturnType<typeof setTimeout>>();

function answered(projectId: string) {
  clearTimeout(answerTimers.get(projectId));
  answerTimers.delete(projectId);
}

function handle(projectId: string, e: UnityMessage) {
  switch (e.t) {
    case "link":
      // Unity drops the link while it reloads scripts after a compilation, and comes back.
      patch(projectId, () => (e.connected ? { connected: true } : { connected: false, playing: false, paused: false, compiling: false }));
      break;
    case "state":
      patch(projectId, (u) => ({
        version: e.unity,
        playing: e.playing,
        paused: e.paused,
        compiling: e.compiling,
        // Clear on Play, as Unity's Console does by default.
        logs: e.playing && !u.playing ? [] : u.logs,
      }));
      if (e.playing) pendingLogs.delete(projectId);
      break;
    case "compileStarted":
      answered(projectId);
      patch(projectId, () => ({ compiling: true }));
      unityCompileStarted(projectId);
      break;
    case "compileFinished":
      answered(projectId);
      patch(projectId, () => ({ compiling: false }));
      unityCompileFinished(projectId, e.messages);
      break;
    case "log":
      queueLog(projectId, { id: nextLogId++, type: e.type, message: e.message, stack: e.stack ?? "", time: Date.now() });
      break;
    case "testRunStarted":
      patchTests(projectId, (t) => ({ running: true, order: [], summary: null, error: null, label: t.label || e.pattern }));
      break;
    case "testStarted":
      patchTests(projectId, (t) => ({
        order: t.order.includes(e.fullName) ? t.order : [...t.order, e.fullName],
        results: { ...t.results, [e.fullName]: { fullName: e.fullName, name: e.fullName.split(".").pop() ?? e.fullName, status: "running", duration: 0, message: null, stack: null, output: null } },
      }));
      break;
    case "testFinished": {
      const { t: _t, ...result } = e;
      patchTests(projectId, (t) => ({
        order: t.order.includes(e.fullName) ? t.order : [...t.order, e.fullName],
        results: { ...t.results, [e.fullName]: result },
      }));
      break;
    }
    case "testRunFinished":
      patchTests(projectId, () => ({ running: false, summary: { passed: e.passed, failed: e.failed, skipped: e.skipped }, error: e.error }));
      break;
  }
}

function listen() {
  if (listening) return;
  listening = true;
  void onUnityEvent(({ root, events }) => {
    const id = projectIdFor(root);
    if (id) events.forEach((e) => handle(id, e));
  });
}

/** Links an open project to its Unity Editor, if it is a Unity project. */
export async function startUnityLink(projectId: string, root: string): Promise<void> {
  listen();
  if (useUnity.getState().projects[projectId]) return;
  // Known before connecting, so the link's first events find the project.
  useUnity.setState((s) => ({
    projects: {
      ...s.projects,
      [projectId]: { root, connected: false, version: null, playing: false, paused: false, compiling: false, logs: [], tests: noTests() },
    },
  }));
  const unity = await api.unityConnect(root).catch(() => false);
  if (!unity)
    forget(projectId);
}

function forget(projectId: string) {
  useUnity.setState((s) => {
    const projects = { ...s.projects };
    delete projects[projectId];
    return { projects };
  });
}

export function stopUnityLink(projectId: string): void {
  const u = useUnity.getState().projects[projectId];
  if (!u) return;
  void api.unityDisconnect(u.root).catch(() => {});
  answered(projectId);
  forget(projectId);
}

export function unityCommand(projectId: string, command: UnityCommand | UnityRequest): Promise<boolean> {
  const u = useUnity.getState().projects[projectId];
  const message = typeof command === "string" ? { t: command } : command;
  return u ? api.unitySend(u.root, message).catch(() => false) : Promise.resolve(false);
}

function patchTests(projectId: string, f: (t: TestRun) => Partial<TestRun>) {
  patch(projectId, (u) => ({ tests: { ...u.tests, ...f(u.tests) } }));
}

/**
 * Runs the tests whose full names match `pattern` in the Unity Editor; the
 * Tests tool window shows them. False when Unity is not connected.
 */
export async function runUnityTests(projectId: string, pattern: string, label: string): Promise<boolean> {
  const u = useUnity.getState().projects[projectId];
  if (!u?.connected) return false;
  patchTests(projectId, () => ({ running: true, label, order: [], summary: null, error: null }));
  useWorkspace.getState().updateUi(projectId, { bottomVisible: true, bottomTab: "tests" });
  if (await unityCommand(projectId, { t: "runTests", pattern })) return true;
  patchTests(projectId, () => ({ running: false, error: "Unity is not connected." }));
  return false;
}

export function clearUnityLogs(projectId: string): void {
  pendingLogs.delete(projectId);
  patch(projectId, () => ({ logs: [] }));
}

/**
 * Build (Ctrl+Shift+B): in a Unity project linked to its Editor, Unity
 * compiles the scripts and its own compiler's messages are the result, as
 * Unity would report them. Otherwise `dotnet build`.
 */
export async function buildProject(projectId: string, root: string): Promise<void> {
  const u = useUnity.getState().projects[projectId];
  if (u?.connected) {
    unityCompileStarted(projectId, "> Unity: refresh assets and compile scripts");
    useWorkspace.getState().updateUi(projectId, { bottomVisible: true, bottomTab: "build" });
    if (await unityCommand(projectId, "compile")) {
      answered(projectId);
      answerTimers.set(
        projectId,
        setTimeout(() => {
          answerTimers.delete(projectId);
          unityCompileUnanswered(projectId);
        }, ANSWER_TIMEOUT),
      );
      return;
    }
  }
  await startBuild(projectId, root, "build", defaultBuildTarget(projectId));
}

// ------------------------------------------------------------------ auto refresh

const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Files Unity imports: under Assets or Packages, not `.meta` (Unity writes those itself). */
function importsChange(root: string, change: FsChange): boolean {
  if (change.overflow) return true;
  return [...change.files, ...change.created, ...change.removed].some(
    (f) => !f.endsWith(".meta") && (isWithin(f, root + "/Assets") || isWithin(f, root + "/Packages")),
  );
}

/**
 * Files changed on disk (saved in Haze or written by an agent): Unity
 * refreshes its assets and compiles in the background, without waiting for
 * its window to be focused. Debounced, so an agent's burst of edits makes
 * one refresh. Unity skips it in Play Mode.
 */
export function unityFilesChanged(projectId: string, change: FsChange): void {
  const u = useUnity.getState().projects[projectId];
  if (!u?.connected || !useWorkspace.getState().unityAutoRefresh) return;
  if (!importsChange(u.root, change)) return;
  clearTimeout(refreshTimers.get(projectId));
  refreshTimers.set(
    projectId,
    setTimeout(() => {
      refreshTimers.delete(projectId);
      void unityCommand(projectId, "refresh");
    }, 1000),
  );
}
