import { api } from "../lib/ipc";
import { describe, expect, it, vi } from "vitest";
import { observedWindow, usageStatus, formatResetRemaining, limitTone, useAgentLimits } from "./agentLimits";

describe("agentLimits", () => {
  it("preserves zero usage but hides an expired or invalid observation", () => {
    const now = 1_776_000_000_000;
    expect(observedWindow({ usedPercent: 0, resetsAt: now + 1 }, now)?.usedPercent).toBe(0);
    expect(observedWindow({ usedPercent: 95, resetsAt: now }, now)).toBeNull();
    expect(observedWindow({ usedPercent: NaN }, now)).toBeNull();
    expect(observedWindow(null, now)).toBeNull();
  });

  it("labels old and legacy observations without pretending refresh made them fresh", () => {
    const now = 1_776_000_000_000;
    const data = { agent: "claude" as const, updatedAt: now - 600_000, source: "hook" as const };
    expect(usageStatus(data, now)).toBe("Agent hook · Updated 10m ago · Stale");
    expect(usageStatus({ ...data, updatedAt: now, source: null }, now)).toContain("Legacy cache");
    expect(usageStatus({ ...data, updatedAt: now }, now)).not.toContain("Stale");
  });

  it("selects the newest account snapshot regardless of input order and retains it on read failure", async () => {
    const latest = { agent: "claude" as const, accountId: "b", updatedAt: 200, source: "hook" as const };
    const request = vi.spyOn(api, "agentLimits").mockResolvedValue([
      latest, { ...latest, accountId: "a", updatedAt: 100 },
    ]);
    await useAgentLimits.getState().refresh();
    expect(useAgentLimits.getState().limits.claude).toEqual(latest);
    request.mockRejectedValueOnce(new Error("unavailable"));
    await useAgentLimits.getState().refresh();
    expect(useAgentLimits.getState().limits.claude).toEqual(latest);
    expect(useAgentLimits.getState().error).toContain("Could not read");
    expect(useAgentLimits.getState().refreshing).toBe(false);
    request.mockRestore();
  });

  it("formats reset remaining time and color tones", () => {
    const now = 1_776_000_000_000;
    expect(formatResetRemaining(now + (2 * 86400 + 5 * 3600) * 1000, now)).toBe("2d 5h");
    expect(formatResetRemaining(now + (3 * 3600 + 45 * 60) * 1000, now)).toBe("3h 45m");
    expect(formatResetRemaining(now + 18 * 60 * 1000, now)).toBe("18m");
    expect(formatResetRemaining(now - 1000, now)).toBe("");

    expect(limitTone(30)).toBe("ok");
    expect(limitTone(50)).toBe("warn");
    expect(limitTone(80)).toBe("err");
  });
});
