import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bumpVisionGeneration, QUICK_MS, setVisionRefresh, visionAnswer, type VisionAnswer } from "./visionCache";

const usages = (n: number): VisionAnswer => ({ title: `${n} usages`, n, real: true });
const after = (ms: number, a: VisionAnswer) => () => new Promise<VisionAnswer>((r) => setTimeout(() => r(a), ms));

describe("Code Vision answers", () => {
  let refreshed = 0;
  beforeEach(() => {
    vi.useFakeTimers();
    refreshed = 0;
    setVisionRefresh(() => refreshed++);
  });
  afterEach(() => vi.useRealTimers());

  it("waits briefly for a first answer, then fills in later with one redraw", async () => {
    const slow = visionAnswer("a", after(1000, usages(3)));
    await vi.advanceTimersByTimeAsync(QUICK_MS);
    expect(await slow).toBe(null);
    await vi.advanceTimersByTimeAsync(1200);
    expect(refreshed).toBe(1);
    // Answered from memory now, without computing again.
    const compute = vi.fn(after(10, usages(9)));
    expect(await visionAnswer("a", compute)).toEqual(usages(3));
    expect(compute).not.toHaveBeenCalled();
  });

  it("shows the last answer after a change and redraws only if the new one differs", async () => {
    const fast = visionAnswer("b", after(5, usages(1)));
    await vi.advanceTimersByTimeAsync(5);
    expect(await fast).toEqual(usages(1));
    await vi.advanceTimersByTimeAsync(200);
    refreshed = 0;

    bumpVisionGeneration();
    expect(await visionAnswer("b", after(50, usages(1)))).toEqual(usages(1));
    await vi.advanceTimersByTimeAsync(300);
    expect(refreshed).toBe(0);

    bumpVisionGeneration();
    expect(await visionAnswer("b", after(50, usages(2)))).toEqual(usages(1));
    await vi.advanceTimersByTimeAsync(300);
    expect(refreshed).toBe(1);
    expect(await visionAnswer("b", after(50, usages(7)))).toEqual(usages(2));
  });

  it("keeps the last answer instead of asking a server that cannot answer fully yet", async () => {
    const first = visionAnswer("c", after(1, usages(4)));
    await vi.advanceTimersByTimeAsync(1);
    await first;
    bumpVisionGeneration();
    const compute = vi.fn(after(1, usages(0)));
    expect(await visionAnswer("c", compute, false)).toEqual(usages(4));
    expect(compute).not.toHaveBeenCalled();
  });

  it("asks once for concurrent requests of the same lens", async () => {
    const compute = vi.fn(after(500, usages(5)));
    const a = visionAnswer("d", compute);
    const b = visionAnswer("d", compute);
    await vi.advanceTimersByTimeAsync(600);
    await Promise.all([a, b]);
    expect(compute).toHaveBeenCalledTimes(1);
  });
});
