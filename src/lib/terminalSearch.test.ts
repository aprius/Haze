import { describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "./ipc";

vi.mock("./ipc", () => ({ api: {}, onPtyEvent: async () => () => {}, errorMessage: String }));
vi.mock("./theme", () => ({ useTheme: { getState: () => ({ mode: "dark" }) } }));

const { findTerminals } = await import("./terminalSearch");

const term = (id: string, title: string, projectId: string, state?: string, agent = "claude"): SessionInfo => ({
  id, projectId, cwd: `/w/${projectId}`, title, pid: 1, createdAt: 0, running: true, exitCode: null, busy: false,
  agent: state ? ({ agent, state, message: null, at: 1 } as SessionInfo["agent"]) : null,
});

const names = { a: "Alpha", b: "Beta" };
const list = [term("1", "zsh", "a"), term("2", "claude", "a", "working"), term("3", "claude · fix/login", "b", "waiting"), term("4", "codex", "b", "idle", "codex")];

describe("findTerminals", () => {
  it("lists all without a query, waiting agents first", () => {
    expect(findTerminals(list, names, "").map((h) => h.session.id)).toEqual(["3", "2", "4", "1"]);
  });

  it("matches title, agent, project and folder across projects", () => {
    expect(findTerminals(list, names, "login").map((h) => h.session.id)).toEqual(["3"]);
    expect(findTerminals(list, names, "beta").map((h) => h.session.id).sort()).toEqual(["3", "4"]);
    expect(findTerminals(list, names, "nothing")).toEqual([]);
  });

  it("names the project of each hit", () => {
    expect(findTerminals(list, names, "login")[0].project).toBe("Beta");
  });
});
