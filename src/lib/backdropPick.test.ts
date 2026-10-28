import { describe, expect, it } from "vitest";
import { periodAt, pick, poolFor } from "./backdropPick";

const at = (h: number, m = 0) => new Date(2026, 0, 1, h, m);
const hours = { dayStart: 6 * 60, nightStart: 18 * 60 };

describe("periodAt", () => {
  it("is day between the starts", () => {
    expect(periodAt(at(5, 59), hours)).toBe("night");
    expect(periodAt(at(6), hours)).toBe("day");
    expect(periodAt(at(17, 59), hours)).toBe("day");
    expect(periodAt(at(18), hours)).toBe("night");
    expect(periodAt(at(0), hours)).toBe("night");
  });

  it("wraps past midnight when night starts first", () => {
    const late = { dayStart: 20 * 60, nightStart: 4 * 60 };
    expect(periodAt(at(22), late)).toBe("day");
    expect(periodAt(at(2), late)).toBe("day");
    expect(periodAt(at(12), late)).toBe("night");
  });

  it("is always day with the same start for both", () => {
    expect(periodAt(at(3), { dayStart: 60, nightStart: 60 })).toBe("day");
  });
});

describe("poolFor", () => {
  it("takes the period's folder, else the top, else the other period's", () => {
    expect(poolFor({ root: ["r"], day: ["d"], night: ["n"] }, "night")).toEqual(["n"]);
    expect(poolFor({ root: ["r"], day: ["d"], night: [] }, "night")).toEqual(["r"]);
    expect(poolFor({ root: [], day: ["d"], night: [] }, "night")).toEqual(["d"]);
    expect(poolFor({ root: ["r"], day: [], night: [] }, "day")).toEqual(["r"]);
  });
});

describe("pick", () => {
  it("goes through the files in order, round and round", () => {
    expect(pick(["a", "b", "c"], null, false)).toBe("a");
    expect(pick(["a", "b", "c"], "a", false)).toBe("b");
    expect(pick(["a", "b", "c"], "c", false)).toBe("a");
    expect(pick(["a", "b"], "elsewhere", false)).toBe("a");
  });

  it("never picks the one showing at random, unless it is the only one", () => {
    for (const r of [0, 0.5, 0.99]) expect(pick(["a", "b"], "a", true, () => r)).toBe("b");
    expect(pick(["a"], "a", true)).toBe("a");
    expect(pick([], "a", true)).toBeNull();
  });
});
