import { create } from "zustand";
import { api, onAppActive, onPtyEvent, type AgentLimit, type LimitAgent, type LimitWindow } from "../lib/ipc";

interface AgentLimitsStore {
  limits: Record<LimitAgent, AgentLimit | null>;
  refreshing: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const EMPTY: Record<LimitAgent, AgentLimit | null> = {
  claude: null,
  codex: null,
  antigravity: null,
};

function toMap(list: AgentLimit[]): Record<LimitAgent, AgentLimit | null> {
  const next: Record<LimitAgent, AgentLimit | null> = {
    claude: null,
    codex: null,
    antigravity: null,
  };
  for (const item of list) {
    if (item.agent === "claude" || item.agent === "codex" || item.agent === "antigravity") {
      if (!next[item.agent] || item.updatedAt >= next[item.agent]!.updatedAt) {
        next[item.agent] = item;
      }
    }
  }
  return next;
}

export const useAgentLimits = create<AgentLimitsStore>((set, get) => ({
  limits: EMPTY,
  refreshing: false,
  error: null,
  refresh: async () => {
    if (get().refreshing) return;
    set({ refreshing: true, error: null });
    try {
      const list = await api.agentLimits();
      set({ limits: toMap(list) });
    } catch {
      set({ error: "Could not read usage data. Showing the last observation." });
    } finally {
      set({ refreshing: false });
    }
  },
}));

export function limitTone(pct: number): "ok" | "warn" | "err" {
  if (pct >= 80) return "err";
  if (pct >= 50) return "warn";
  return "ok";
}

export function formatResetRemaining(resetsAt?: number | null, nowMs = Date.now()): string {
  if (!resetsAt || !Number.isFinite(resetsAt)) return "";
  const diffSec = Math.max(0, Math.floor((resetsAt - nowMs) / 1000));
  if (diffSec <= 0) return "";
  const days = Math.floor(diffSec / 86_400);
  const hours = Math.floor((diffSec % 86_400) / 3_600);
  const mins = Math.floor((diffSec % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export function usageStatus(limit: AgentLimit, nowMs = Date.now()): string {
  const age = Math.max(0, nowMs - limit.updatedAt);
  const ageText = age < 60_000 ? "just now" : age < 3_600_000
    ? `${Math.floor(age / 60_000)}m ago` : `${Math.floor(age / 3_600_000)}h ago`;
  const source = limit.source === "hook" ? "Agent hook" : limit.source === "session" ? "Agent session" : "Legacy cache";
  return `${source} · Updated ${ageText}${age >= 300_000 || !limit.source ? " · Stale" : ""}`;
}

export function observedWindow(win: LimitWindow | null | undefined, nowMs = Date.now()) {
  return win && Number.isFinite(win.usedPercent) && (!win.resetsAt || win.resetsAt > nowMs) ? win : null;
}

let subscribed = false;

export function initAgentLimitsWatcher(): void {
  if (subscribed) return;
  subscribed = true;
  void useAgentLimits.getState().refresh();

  void onPtyEvent((ev) => {
    if (ev.t === "agent") {
      void useAgentLimits.getState().refresh();
    }
  });

  void onAppActive((active) => {
    if (active) void useAgentLimits.getState().refresh();
  });

  window.setInterval(() => {
    if (!document.hidden) {
      void useAgentLimits.getState().refresh();
    }
  }, 15_000);
}
