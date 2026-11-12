import type { AgentLimit } from "../lib/ipc";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (value: unknown) => [typeof value === "boolean" ? true : typeof value === "function" ? value() : value, vi.fn()],
}));
vi.mock("../store/workspace", () => ({
  useWorkspace: (select: (s: unknown) => unknown) => select({ showAgentLimits: true }),
}));
vi.mock("../store/terminals", () => ({
  useTerminals: (select: (s: unknown) => unknown) => select({ sessions: {} }),
}));
const { limits } = vi.hoisted(() => ({
  limits: { claude: { agent: "claude", updatedAt: 1 } as AgentLimit | null, codex: null, antigravity: null },
}));
vi.mock("../store/agentLimits", async (original) => ({
  ...await original<typeof import("../store/agentLimits")>(),
  useAgentLimits: (select: (s: unknown) => unknown) => select({ limits, refresh: vi.fn() }),
}));
import { AgentLimitsBar } from "./AgentLimits";

it("omits agents without usage or sessions from both the bar and open details", () => {
  const html = renderToStaticMarkup(<AgentLimitsBar />);
  expect(html).toContain("agent-limits-popover");
  expect(html).toContain("Claude Code");
  expect(html).not.toContain("Antigravity");
  expect(html).not.toContain("Codex");
});

it("shows unknown usage after reset and labels provenance, age, and account", () => {
  limits.claude = {
    agent: "claude", source: "hook", accountId: "account-a", updatedAt: Date.now() - 600_000,
    fiveHour: { usedPercent: 95, resetsAt: Date.now() - 1 },
  };
  const html = renderToStaticMarkup(<AgentLimitsBar />);
  expect(html).toContain("Awaiting update");
  expect(html).not.toContain("95%");
  expect(html).not.toContain(">0%<");
  expect(html).toContain("Agent hook · Updated 10m ago · Stale");
  expect(html).toContain("Last reported account: account-a");
});

it("shows an empty state without listing all providers", () => {
  limits.claude = null;
  const html = renderToStaticMarkup(<AgentLimitsBar />);
  expect(html).toContain("No usage data yet");
  expect(html).not.toContain("Antigravity");
  expect(html).not.toContain("Claude Code");
});
