import { create } from "zustand";
import { api, onAppActive, onPtyEvent, type AgentLimit, type LimitAgent, type LimitWindow } from "../lib/ipc";

interface AgentLimitsStore {
  limits: Record<LimitAgent, AgentLimit | null>;
  refresh: () => Promise<void>;
  report: (limit: AgentLimit) => Promise<void>;
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
      next[item.agent] = item;
    }
  }
  return next;
}

export const useAgentLimits = create<AgentLimitsStore>((set) => ({
  limits: EMPTY,
  refresh: async () => {
    try {
      const list = await api.agentLimits();
      set({ limits: toMap(list) });
    } catch {
      // Ignore transient IPC errors before backend is ready.
    }
  },
  report: async (limit) => {
    try {
      const list = await api.agentLimitsReport(limit);
      set({ limits: toMap(list) });
    } catch {
      set((s) => ({ limits: { ...s.limits, [limit.agent]: limit } }));
    }
  },
}));

// Strip ANSI CSI/OSC sequences so we can match terminal status lines cleanly.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

// Matches usage-line / status patterns like:
//   `5h ████░░░░░░ 85% 4h 0m` or `5h: 42% (2h 15m)` or `7d ██░░░░░░░░ 18% 1d 23h`
const WINDOW_RE = /\b(5h|7d)\b[^\d%\n]{0,24}(\d{1,3}(?:\.\d+)?)%(?:[^\d\n]{1,6}(?:(\d+)d\s*(\d+)h|(\d+)h\s*(\d+)m|(\d+)m))?/gi;

function parseDurationMs(match: RegExpExecArray): number | null {
  if (match[3] !== undefined && match[4] !== undefined) {
    return (Number(match[3]) * 86_400 + Number(match[4]) * 3_600) * 1000;
  }
  if (match[5] !== undefined && match[6] !== undefined) {
    return (Number(match[5]) * 3_600 + Number(match[6]) * 60) * 1000;
  }
  if (match[7] !== undefined) {
    return Number(match[7]) * 60 * 1000;
  }
  return null;
}

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

export function extractLimitsFromTerminalText(
  raw: string,
  agent: LimitAgent = "claude",
  nowMs = Date.now(),
): AgentLimit | null {
  if (!raw.includes("%") || (!raw.includes("5h") && !raw.includes("7d"))) return null;
  const clean = raw.replace(ANSI_RE, " ");
  let fiveHour: LimitWindow | null = null;
  let sevenDay: LimitWindow | null = null;

  WINDOW_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WINDOW_RE.exec(clean)) !== null) {
    const kind = m[1].toLowerCase();
    const pct = Math.max(0, Math.min(100, Number(m[2])));
    if (!Number.isFinite(pct)) continue;
    const dur = parseDurationMs(m);
    const win: LimitWindow = {
      usedPercent: pct,
      resetsAt: dur !== null ? nowMs + dur : null,
    };
    if (kind === "5h") fiveHour = win;
    else if (kind === "7d") sevenDay = win;
  }

  if (!fiveHour && !sevenDay) return null;
  return {
    agent,
    fiveHour,
    sevenDay,
    updatedAt: nowMs,
  };
}

let lastReportedSig = "";
let lastReportedAt = 0;

export function scanTerminalOutputForLimits(data: string, agentHint?: string | null): void {
  const hint = (agentHint ?? "").toLowerCase();
  const agent: LimitAgent = hint.includes("codex")
    ? "codex"
    : hint.includes("antigravity")
      ? "antigravity"
      : "claude";
  const parsed = extractLimitsFromTerminalText(data, agent);
  if (!parsed) return;
  const sig = `${parsed.agent}:${parsed.fiveHour?.usedPercent ?? "-"}:${parsed.sevenDay?.usedPercent ?? "-"}`;
  const now = Date.now();
  if (sig === lastReportedSig && now - lastReportedAt < 30_000) return;
  lastReportedSig = sig;
  lastReportedAt = now;
  void useAgentLimits.getState().report(parsed);
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
