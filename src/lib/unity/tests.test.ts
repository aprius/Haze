import { describe, expect, it } from "vitest";
import { fixtureName, isTestHead, namespaceAt, testPattern } from "./tests";
import { messageSignature, unityBaseOf, unityMessage } from "./messages";

describe("Unity tests in source", () => {
  it("recognises test attributes", () => {
    expect(isTestHead("[Test]\n        public void Jumps")).toBe(true);
    expect(isTestHead("[UnityTest] public IEnumerator Falls")).toBe(true);
    expect(isTestHead("[TestCase(1, 2)]\n[TestCase(3, 4)] public void Adds")).toBe(true);
    expect(isTestHead("[NUnit.Framework.TestAttribute] void X")).toBe(true);
    expect(isTestHead("[TestFixture] public class Foo")).toBe(false);
    expect(isTestHead("[Testing] void X")).toBe(false);
  });

  it("finds the namespace and builds NUnit names", () => {
    const text = "using X;\nnamespace Game.Tests\n{\n  class PlayerTests {}\n}\n";
    expect(namespaceAt(text, text.indexOf("class"))).toBe("Game.Tests");
    expect(namespaceAt("namespace A.B;\nclass C {}", 20)).toBe("A.B");
    expect(namespaceAt("class C {}", 5)).toBe("");
    expect(fixtureName("Game.Tests", ["Outer<T>", "Inner"])).toBe("Game.Tests.Outer+Inner");
  });

  it("matches a test and its cases, or a whole fixture", () => {
    const one = new RegExp(testPattern("Game.PlayerTests", "Adds"));
    expect(one.test("Game.PlayerTests.Adds")).toBe(true);
    expect(one.test("Game.PlayerTests.Adds(1,2)")).toBe(true);
    expect(one.test("Game.PlayerTests.AddsMore")).toBe(false);
    const all = new RegExp(testPattern("Game.PlayerTests"));
    expect(all.test("Game.PlayerTests.Adds(1,2)")).toBe(true);
    expect(all.test("Game.PlayerTestsOther.X")).toBe(false);
  });
});

describe("Unity event functions", () => {
  const classes = { Enemy: ["Character", "IDamageable"], Character: ["MonoBehaviour"], Settings: ["ScriptableObject"], Loop: ["Loop"], Plain: [] };

  it("follows base classes to a Unity type", () => {
    expect(unityBaseOf(classes, "Enemy")).toBe("MonoBehaviour");
    expect(unityBaseOf(classes, "Settings")).toBe("ScriptableObject");
    expect(unityBaseOf(classes, "Plain")).toBe(null);
    expect(unityBaseOf(classes, "Loop")).toBe(null);
    expect(unityBaseOf(classes, "Unknown")).toBe(null);
  });

  it("knows the messages of each base and their signatures", () => {
    expect(unityMessage("MonoBehaviour", "Update")).toBeDefined();
    expect(unityMessage("ScriptableObject", "Update")).toBeUndefined();
    expect(messageSignature(unityMessage("MonoBehaviour", "OnTriggerEnter")!)).toBe("private void OnTriggerEnter(Collider other)");
    expect(messageSignature(unityMessage("AssetPostprocessor", "OnPostprocessAllAssets")!, "")).toMatch(/^static void OnPostprocessAllAssets\(string\[\] importedAssets/);
  });
});
