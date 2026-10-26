import { describe, expect, it } from "vitest";
import type { PerfMethod } from "../ipc";
import { analyzePerf } from "./perf";

const r = (line: number) => ({ start: { line, character: 0 }, end: { line, character: 4 } });
const method = (name: string, line: number, calls: string[] = [], expensive: string[] = [], extra: Partial<PerfMethod> = {}): PerfMethod => ({
  class: "Player",
  name,
  range: r(line),
  nameRange: r(line),
  coroutine: false,
  calls: calls.map((c) => ({ name: c, range: r(line + 1) })),
  expensive: expensive.map((e) => ({ name: e, range: r(line + 2) })),
  ...extra,
});

describe("performance-critical context", () => {
  it("follows calls from Update and flags expensive work", () => {
    const methods = [
      method("Update", 0, ["Move", "Shoot"], ["Camera.main"]),
      method("Move", 10, ["Helper"]),
      method("Helper", 20, [], ["GetComponent"]),
      method("Shoot", 30),
      method("Start", 40, ["Helper"]),
    ];
    const report = analyzePerf(methods, () => true);
    expect(report.hot.map((h) => [h.method.name, h.from])).toEqual([
      ["Update", "Update"],
      ["Move", "Update"],
      ["Shoot", "Update"],
      ["Helper", "Update"],
    ]);
    const messages = report.costly.map((c) => c.message);
    expect(messages[0]).toMatch(/^Camera\.main in a performance-critical context \(Update\)/);
    // Update → Move (calls Helper, which uses GetComponent), and Helper's own GetComponent.
    expect(messages).toContain("Expensive method invocation in a performance-critical context (Update): Move uses GetComponent.");
    expect(messages.some((m) => m.startsWith("GetComponent in a performance-critical context (Update)"))).toBe(true);
    // Start runs once.
    expect(report.costly.every((c) => c.range.start.line < 40)).toBe(true);
  });

  it("knows coroutines and leaves other classes alone", () => {
    const methods = [method("Spawn", 0, [], ["Find"], { coroutine: true }), method("Update", 10, [], ["Find"], { class: "Plain" })];
    const report = analyzePerf(methods, (cls) => cls === "Player");
    expect(report.hot.map((h) => [h.method.name, h.from])).toEqual([["Spawn", "coroutine"]]);
    expect(report.costly).toHaveLength(1);
  });

  it("stops at recursion", () => {
    const report = analyzePerf([method("Update", 0, ["Loop"]), method("Loop", 10, ["Loop"])], () => true);
    expect(report.hot).toHaveLength(2);
    expect(report.costly).toHaveLength(0);
  });
});
