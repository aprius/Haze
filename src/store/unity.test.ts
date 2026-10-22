import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FsChange, UnityEvent } from "../lib/ipc";

const ipc = vi.hoisted(() => ({
  emit: (_: UnityEvent) => {},
  sent: [] as string[],
}));

vi.mock("../lib/ipc", () => ({
  api: {
    unityConnect: async () => true,
    unityDisconnect: async () => {},
    unitySend: async (_root: string, message: { t: string }) => {
      ipc.sent.push(message.t);
      return true;
    },
    buildStart: async () => 1,
    buildCancel: async () => {},
  },
  onUnityEvent: async (cb: (e: UnityEvent) => void) => {
    ipc.emit = cb;
    return () => {};
  },
  onBuildEvent: async () => () => {},
  errorMessage: (e: unknown) => String(e),
}));

vi.mock("../lib/monaco", () => ({
  monaco: {
    editor: { getModels: () => [], onDidCreateModel: () => ({ dispose() {} }), setModelMarkers: () => {} },
    MarkerSeverity: { Error: 8, Warning: 4 },
  },
}));

const { useDotnet } = await import("./dotnet");
const { buildProject, runUnityTests, startUnityLink, stopUnityLink, unityFilesChanged, useUnity } = await import("./unity");

const ROOT = "/u/Game";
const emit = (event: UnityEvent["event"]) => ipc.emit({ root: ROOT, event });
const change = (files: string[]): FsChange => ({ root: ROOT, dirs: [], files, created: [], removed: [], overflow: false, lost: false, git: false });

beforeEach(async () => {
  vi.useFakeTimers();
  ipc.sent = [];
  useDotnet.setState({ builds: {} });
  await startUnityLink("p", ROOT);
  emit({ t: "link", connected: true });
});

afterEach(() => {
  stopUnityLink("p");
  vi.useRealTimers();
});

describe("Unity link", () => {
  it("tracks the connection and play mode", () => {
    emit({ t: "state", unity: "6000.0.1f1", playing: true, paused: false, compiling: false });
    expect(useUnity.getState().projects.p).toMatchObject({ connected: true, version: "6000.0.1f1", playing: true });
    emit({ t: "link", connected: false });
    expect(useUnity.getState().projects.p).toMatchObject({ connected: false, playing: false });
  });

  it("shows Unity's compilation as the project's build", () => {
    emit({ t: "compileStarted" });
    expect(useDotnet.getState().builds.p).toMatchObject({ tool: "unity", running: true });
    const error = { severity: "error" as const, code: "CS1002", message: "; expected", file: "/u/Game/Assets/A.cs", line: 3, column: 5, project: "Assembly-CSharp" };
    emit({ t: "compileFinished", messages: [error, error] });
    const build = useDotnet.getState().builds.p;
    expect(build).toMatchObject({ tool: "unity", running: false, result: { code: 1 } });
    expect(build.diagnostics).toHaveLength(1);
    expect(build.lines[1]).toBe("/u/Game/Assets/A.cs(3,5): error CS1002: ; expected");
  });

  it("batches Console messages and clears them on Play", () => {
    emit({ t: "log", type: "log", message: "a", stack: null });
    emit({ t: "log", type: "error", message: "b", stack: "Foo () (at Assets/Foo.cs:1)" });
    expect(useUnity.getState().projects.p.logs).toHaveLength(0);
    vi.advanceTimersByTime(100);
    expect(useUnity.getState().projects.p.logs.map((l) => l.message)).toEqual(["a", "b"]);
    emit({ t: "state", unity: "6000.0.1f1", playing: true, paused: false, compiling: false });
    expect(useUnity.getState().projects.p.logs).toHaveLength(0);
  });

  it("refreshes Unity once for a burst of imported files, not for .meta or Library", async () => {
    unityFilesChanged("p", change(["/u/Game/Assets/A.cs.meta", "/u/Game/Library/x"]));
    unityFilesChanged("p", change(["/u/Game/Assets/A.cs"]));
    unityFilesChanged("p", change(["/u/Game/Packages/com.x/B.cs"]));
    await vi.advanceTimersByTimeAsync(1000);
    expect(ipc.sent).toEqual(["refresh"]);
  });

  it("records test runs: results by full name, the run's order and its summary", async () => {
    expect(await runUnityTests("p", "^Game\\.PlayerTests\\.", "PlayerTests")).toBe(true);
    expect(ipc.sent).toEqual(["runTests"]);
    expect(useUnity.getState().projects.p.tests).toMatchObject({ running: true, label: "PlayerTests" });
    emit({ t: "testRunStarted", pattern: "^Game\\.PlayerTests\\." });
    emit({ t: "testStarted", fullName: "Game.PlayerTests.Jumps" });
    expect(useUnity.getState().projects.p.tests.results["Game.PlayerTests.Jumps"].status).toBe("running");
    emit({ t: "testFinished", fullName: "Game.PlayerTests.Jumps", name: "Jumps", status: "failed", duration: 3, message: "Expected 1", stack: null, output: null });
    emit({ t: "testRunFinished", passed: 0, failed: 1, skipped: 0, error: null });
    const tests = useUnity.getState().projects.p.tests;
    expect(tests).toMatchObject({ running: false, order: ["Game.PlayerTests.Jumps"], summary: { failed: 1 } });
    expect(tests.results["Game.PlayerTests.Jumps"]).toMatchObject({ status: "failed", message: "Expected 1" });
  });

  it("builds by asking Unity to compile, and stops waiting when it does not answer", async () => {
    await buildProject("p", ROOT);
    expect(ipc.sent).toEqual(["compile"]);
    expect(useDotnet.getState().builds.p).toMatchObject({ tool: "unity", running: true });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(useDotnet.getState().builds.p).toMatchObject({ running: false, result: { cancelled: true } });
  });
});
