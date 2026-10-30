import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStatus, SessionInfo } from "../lib/ipc";

const ipc = vi.hoisted(() => ({ list: [] as SessionInfo[] }));

vi.mock("../lib/ipc", () => ({
  errorMessage: String,
  onPtyEvent: async () => () => {},
  api: {
    ptyCreate: async (spec: { projectId: string; cwd: string }) => {
      const s = session("new", spec.projectId);
      ipc.list.push(s);
      return s;
    },
    ptyList: async () => ipc.list,
  },
}));

vi.mock("../lib/theme", () => ({ useTheme: { getState: () => ({ mode: "dark" }) } }));

const { checkLines, failedChecks, isChecking, needsLook, newTerminal, reconcileViews, shownState, useTerminals } = await import("./terminals");
const { defaultUi, useWorkspace } = await import("./workspace");

function session(id: string, projectId: string | null = "p"): SessionInfo {
  return { id, projectId, cwd: "/p", title: "Terminal", pid: 1, createdAt: 0, running: true, exitCode: null, agent: null, busy: false };
}

describe("reconcileViews", () => {
  const views = [
    { id: "alive", detached: true },
    { id: "gone", detached: true },
    { id: "attached", detached: false },
  ];
  const sessions = { alive: session("alive"), attached: session("attached") };

  it("waits while disconnected: the list is not known", () => {
    expect(reconcileViews(views, { connected: false, sessions: {} }, true)).toEqual({ dispose: [], attach: [] });
  });

  it("drops views of sessions gone, and attaches cut-off ones once back", () => {
    expect(reconcileViews(views, { connected: true, sessions }, false)).toEqual({ dispose: ["gone"], attach: ["alive"] });
    // Already connected: a list change attaches nothing again.
    expect(reconcileViews(views, { connected: true, sessions }, true)).toEqual({ dispose: ["gone"], attach: [] });
  });
});

describe("newTerminal after the host restarted", () => {
  beforeEach(() => {
    ipc.list = [];
    useWorkspace.setState({
      projects: [{ id: "p", path: "/p", name: "p", favorite: false, open: true, lastOpenedAt: 0 }],
      ui: { p: { ...defaultUi(), terminalOrder: ["old"], activeTerminal: "old" } },
    });
    // The old host's session, lost with it.
    useTerminals.setState({ sessions: { old: session("old") }, connected: false, error: "Terminal host disconnected" });
  });

  it("replaces the old host's sessions with the new host's", async () => {
    const id = await newTerminal("p", "/p");
    expect(id).toBe("new");
    expect(Object.keys(useTerminals.getState().sessions)).toEqual(["new"]);
    expect(useWorkspace.getState().ui.p.terminalOrder).toEqual(["new"]);
    expect(useWorkspace.getState().ui.p.activeTerminal).toBe("new");
    expect(useTerminals.getState().connected).toBe(true);
  });
});

describe("agent checks", () => {
  const status = (state: AgentStatus["state"], checks?: AgentStatus["checks"]): AgentStatus => ({ agent: "claude", state, message: null, at: 1, checks });
  const check = (name: string, state: "running" | "ok" | "fail", summary: string | null = null) => ({ name, state, summary });

  it("keeps a done turn working while its checks run", () => {
    const running = status("done", [check("compile", "ok"), check("lint", "running")]);
    expect(isChecking(running)).toBe(true);
    expect(shownState(running)).toBe("working");
    expect(needsLook(running)).toBe(false);
  });

  it("is worth a look once the checks finish, or without any", () => {
    expect(needsLook(status("done", [check("compile", "fail", "2 errors")]))).toBe(true);
    expect(needsLook(status("done"))).toBe(true);
    expect(needsLook(status("working", [check("compile", "running")]))).toBe(false);
    expect(isChecking(status("waiting", [check("compile", "running")]))).toBe(false);
  });

  it("lists the checks for a tooltip", () => {
    const done = status("done", [check("compile", "ok"), check("lint", "fail", "2 issues"), check("style", "running")]);
    expect(checkLines(done)).toEqual(["✓ compile", "✗ lint — 2 issues", "… style"]);
    expect(failedChecks(done).map((c) => c.name)).toEqual(["lint"]);
  });
});
