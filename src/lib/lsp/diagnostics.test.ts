import { describe, expect, it } from "vitest";
import { isImportFix, parseRuleIds, pragmaSuppression, referencesMissing, ruleId, Severity, shownByBuild, toMarker, touches, unitySuppressed, withSeverity, type LspDiagnostic } from "./diagnostics";

const at = (line: number, from: number, to: number) => ({ start: { line, character: from }, end: { line, character: to } });
const diag = (code: string, line = 0, severity = 2): LspDiagnostic => ({ code, severity, message: code, range: at(line, 0, 4) });

describe("live diagnostics", () => {
  it("maps severities and tags like Rider's inspections", () => {
    expect(toMarker({ ...diag("CS0103"), severity: 1 }).severity).toBe(Severity.Error);
    expect(toMarker({ ...diag("IDE0090"), severity: 3 }).severity).toBe(Severity.Info);
    const hint = toMarker({ ...diag("IDE0005"), severity: 4, tags: [1, 2147483642] });
    expect(hint.severity).toBe(Severity.Hint);
    expect(hint.tags).toEqual([1]);
    expect(toMarker({ ...diag("CS0168"), codeDescription: { href: "https://x" } }).code).toEqual({ value: "CS0168", target: "https://x" });
    expect(toMarker({ ...diag("CS0168"), range: at(2, 4, 9) })).toMatchObject({ startLineNumber: 3, startColumn: 5, endColumn: 10 });
  });

  it("tells a project with no references", () => {
    expect(referencesMissing([diag("CS0246"), diag("CS0518")])).toBe(true);
    expect(referencesMissing([diag("CS0246")])).toBe(false);
  });

  it("suppresses what Unity's analyzers would", () => {
    const lines = [
      "public class Player : MonoBehaviour {",
      "  [SerializeField]",
      "  [Range(0, 1)]",
      "  private float speed;",
      "  private int count;",
      "  void OnTriggerEnter(Collider other) { }",
      "  void Helper(int unused) { }",
    ];
    const src = { line: (n: number) => lines[n - 1] ?? "", isMessage: (n: string) => n === "OnTriggerEnter" };
    expect(unitySuppressed(diag("IDE0031"), src)).toBe(true);
    expect(unitySuppressed(diag("IDE0044", 3), src)).toBe(true);
    expect(unitySuppressed(diag("CS0649", 3), src)).toBe(true);
    expect(unitySuppressed(diag("IDE0044", 4), src)).toBe(false);
    expect(unitySuppressed(diag("IDE0060", 5), src)).toBe(true);
    expect(unitySuppressed(diag("IDE0051", 5), src)).toBe(true);
    expect(unitySuppressed(diag("IDE0060", 6), src)).toBe(false);
    expect(unitySuppressed(diag("CS0103", 6), src)).toBe(false);
  });

  it("leaves to the build what it shows", () => {
    const build = [{ code: "CS0103", startLineNumber: 3 }];
    expect(shownByBuild(diag("CS0103", 2), build)).toBe(true);
    expect(shownByBuild(diag("CS0103", 4), build)).toBe(false);
  });

  it("finds the diagnostic under the caret", () => {
    expect(touches(at(0, 21, 34), at(0, 34, 34))).toBe(true);
    expect(touches(at(0, 21, 34), at(0, 25, 25))).toBe(true);
    expect(touches(at(0, 21, 34), at(0, 35, 35))).toBe(false);
    expect(touches(at(0, 21, 34), at(1, 0, 0))).toBe(false);
  });

  it("knows the missing-namespace fixes", () => {
    expect(isImportFix("using UnityEngine;")).toBe(true);
    expect(isImportFix("GameObject - using UnityEngine;")).toBe(true);
    expect(isImportFix("Generate class 'MonoBehaviour'")).toBe(false);
  });
});

describe("ignoring a rule", () => {
  it("takes rule IDs, not Unity's inspection names", () => {
    expect(ruleId(diag("IDE0130"))).toBe("IDE0130");
    expect(ruleId(diag("CS0168"))).toBe("CS0168");
    expect(ruleId({ ...diag("x"), code: "InstantiateWithoutParent" })).toBeUndefined();
    // No #pragma or severity turns an error off.
    expect(ruleId(diag("CS0103", 0, 1))).toBeUndefined();
    expect(parseRuleIds("ide0130, CS0168;IDE0130  nope")).toEqual(["IDE0130", "CS0168"]);
  });

  it("wraps the lines in #pragma, indented like the first", () => {
    const lines = ["using System;", "    namespace Game.Config", "{"];
    const r = { start: { line: 1, character: 14 }, end: { line: 1, character: 25 } };
    expect(pragmaSuppression("IDE0130", r, (n) => lines[n], 3).map((e) => [e.range.start, e.newText])).toEqual([
      [{ line: 1, character: 0 }, "    #pragma warning disable IDE0130\n"],
      [{ line: 2, character: 0 }, "    #pragma warning restore IDE0130\n"],
    ]);
    // On the last line the restore goes after it.
    expect(pragmaSuppression("IDE0130", r, (n) => lines[n], 2)[1]).toEqual({
      range: { start: { line: 1, character: 25 }, end: { line: 1, character: 25 } },
      newText: "\n    #pragma warning restore IDE0130",
    });
  });

  it("sets the severity in .editorconfig", () => {
    expect(withSeverity("", "IDE0130")).toBe("[*.cs]\ndotnet_diagnostic.IDE0130.severity = none\n");
    expect(withSeverity("root = true\n", "IDE0130")).toBe("root = true\n\n[*.cs]\ndotnet_diagnostic.IDE0130.severity = none\n");
    expect(withSeverity("[*.cs]\nindent_size = 4\n\n[*.json]\nindent_size = 2\n", "IDE0130")).toBe(
      "[*.cs]\nindent_size = 4\ndotnet_diagnostic.IDE0130.severity = none\n\n[*.json]\nindent_size = 2\n",
    );
    // Set for another language: the C# section gets its own.
    expect(withSeverity("[*.vb]\ndotnet_diagnostic.IDE0130.severity = warning\n", "IDE0130")).toBe(
      "[*.vb]\ndotnet_diagnostic.IDE0130.severity = warning\n\n[*.cs]\ndotnet_diagnostic.IDE0130.severity = none\n",
    );
    expect(withSeverity("[*.{cs,vb}]\r\ndotnet_diagnostic.IDE0130.severity = warning\r\n", "IDE0130")).toBe(
      "[*.{cs,vb}]\r\ndotnet_diagnostic.IDE0130.severity = none\r\n",
    );
  });
});
