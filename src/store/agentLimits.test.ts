import { describe, expect, it } from "vitest";
import { extractLimitsFromTerminalText, formatResetRemaining, limitTone } from "./agentLimits";

describe("agentLimits", () => {
  it("extracts 5h and 7d usage limits from terminal status lines with ANSI sequences", () => {
    const now = 1_776_000_000_000;
    const raw =
      "\x1b[38;5;244m5h\x1b[0m \x1b[31m████████░░\x1b[0m \x1b[31m85%\x1b[0m \x1b[2m4h 12m\x1b[0m  " +
      "\x1b[38;5;244m7d\x1b[0m \x1b[32m██░░░░░░░░\x1b[0m \x1b[32m18%\x1b[0m \x1b[2m1d 23h\x1b[0m";

    const parsed = extractLimitsFromTerminalText(raw, "claude", now);
    expect(parsed).not.toBeNull();
    expect(parsed?.agent).toBe("claude");
    expect(parsed?.fiveHour?.usedPercent).toBe(85);
    expect(parsed?.fiveHour?.resetsAt).toBe(now + (4 * 3600 + 12 * 60) * 1000);
    expect(parsed?.sevenDay?.usedPercent).toBe(18);
    expect(parsed?.sevenDay?.resetsAt).toBe(now + (1 * 86400 + 23 * 3600) * 1000);
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
