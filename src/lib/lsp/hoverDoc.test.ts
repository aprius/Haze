import { describe, expect, it } from "vitest";
import { buildHover, declarationAt } from "./hoverDoc";

const SOURCE = `namespace Game
{
    /// <summary>A player, see <see cref="T:UnityEngine.MonoBehaviour"/>.</summary>
    /// <typeparam name="T">The state.</typeparam>
    [DisallowMultipleComponent]
    public sealed class Player<T> : MonoBehaviour, IDamageable where T : new()
    {
        [SerializeField] private float speed = 2f; // m/s

        /// <summary>Jumps <paramref name="h"/> high.</summary>
        /// <param name="h">Height, or <see langword="null"/>.</param>
        /// <param name="force">Unused.</param>
        /// <returns>True if jumped.</returns>
        /// <exception cref="T:System.ArgumentException">When h is negative.</exception>
        /// <remarks>Uses <c>Rigidbody</c>.</remarks>
        public virtual bool Jump(int h,
            float force = 1f) => true;
    }

    public enum Mode { Idle, Run = 2, Fly }
}`.split("\n");

const METADATA = `\uFEFF#region Assembly System.Collections, Version=8.0.0.0, Culture=neutral
// /x/System.Collections.dll
#endregion

namespace System.Collections.Generic
{
    public class List<T> : ICollection<T>, IList<T>
    {
        //
        // Summary:
        //     Adds an object to the end of the System.Collections.Generic.List\`1.
        //
        // Parameters:
        //   item:
        //     The object to be added to the end of the System.Collections.Generic.List\`1. The
        //     value can be null for reference types.
        //
        // Exceptions:
        //   T:System.NotSupportedException:
        //     The list is read-only.
        public void Add(T item);
    }
}`.split("\n");

describe("hover declarations", () => {
  it("reads a type's header, attributes and XML docs", () => {
    const d = declarationAt(SOURCE, 5)!;
    expect(d.header).toBe("public sealed class Player<T> : MonoBehaviour, IDamageable where T : new()");
    expect(d.attributes).toEqual(["[DisallowMultipleComponent]"]);
    expect(d.doc?.summary).toBe("A player, see `MonoBehaviour`.");
    expect(d.doc?.typeParams).toEqual([["T", "The state."]]);
    expect(d.namespace).toBe("Game");
    expect(d.container).toBeUndefined();
  });

  it("finds a member's type and namespace", () => {
    const d = declarationAt(SOURCE, 15)!;
    expect(d.container).toEqual({ kind: "class", name: "Player" });
    expect(d.namespace).toBe("Game");
    const m = declarationAt(METADATA, 20)!;
    expect(m.container).toEqual({ kind: "class", name: "List" });
    expect(m.namespace).toBe("System.Collections.Generic");
    expect(m.assembly).toBe("System.Collections");
    const sibling = ["namespace A;", "class Other { }", "struct Inner", "{", "    int x;", "}"];
    expect(declarationAt(sibling, 4)).toMatchObject({ container: { kind: "struct", name: "Inner" }, namespace: "A" });
  });

  it("reads a multi-line method and every doc section", () => {
    const d = declarationAt(SOURCE, 15)!;
    expect(d.header).toBe("public virtual bool Jump(int h, float force = 1f)");
    expect(d.doc).toEqual({
      summary: "Jumps `h` high.",
      returns: "True if jumped.",
      remarks: "Uses `Rigidbody`.",
      params: [
        ["h", "Height, or `null`."],
        ["force", "Unused."],
      ],
      typeParams: [],
      exceptions: [["ArgumentException", "When h is negative."]],
    });
  });

  it("stops at initializers and enum members", () => {
    const field = declarationAt(SOURCE, 7)!;
    expect(field.header).toBe("private float speed");
    expect(field.attributes).toEqual(["[SerializeField]"]);
    expect(declarationAt(["    Idle,", "    Run = 2,"], 0)!.header).toBe("Idle");
  });

  it("reads metadata-as-source docs", () => {
    const d = declarationAt(METADATA, 20)!;
    expect(d.header).toBe("public void Add(T item)");
    expect(d.doc?.params).toEqual([["item", "The object to be added to the end of the System.Collections.Generic.List\\`1. The value can be null for reference types."]]);
    expect(d.doc?.exceptions).toEqual([["NotSupportedException", "The list is read-only."]]);
  });
});

describe("Rider-like hovers", () => {
  it("shows the declaration, a docs table and where it is declared", () => {
    const roslyn = "```csharp\nvoid List<int>.Add(int item)\n```\n  \nAdds an object to the end of the&nbsp;List\\<T\\>\\.  \n";
    const [sig, body, where] = buildHover(roslyn, declarationAt(METADATA, 20)!);
    expect(sig).toBe("```csharp\npublic void Add(int item)\n```");
    expect(body).toMatch(/^Adds an object to the end of the System.Collections.Generic.List/);
    expect(body).toContain("| Params: | `item` – The object to be added");
    expect(body).toContain("| Exceptions: | `NotSupportedException` – The list is read-only. |");
    expect(where).toContain("in class **List**");
    expect(where).toContain("System.Collections");
  });

  it("shows a type's full header and its namespace", () => {
    const [sig, body, where] = buildHover("```csharp\nclass Game.Player<T>\n```\n  \nA player\\.  \n", declarationAt(SOURCE, 5)!);
    expect(sig).toBe("```csharp\n[DisallowMultipleComponent]\npublic sealed class Player<T> : MonoBehaviour, IDamageable where T : new()\n```");
    expect(body).toContain("| Type params: | `T` – The state. |");
    expect(where).toContain("in namespace **Game**");
  });

  it("orders a method's sections like its doc comment", () => {
    const roslyn = "```csharp\nbool Player<T>.Jump(int h, [float force = 1])\n```\n  \nJumps high\\.  \n  \nReturns:  \n&nbsp;&nbsp;True if jumped\\.  \n";
    const [sig, body] = buildHover(roslyn, declarationAt(SOURCE, 15)!);
    expect(sig).toBe("```csharp\npublic virtual bool Jump(int h, float force = 1)\n```");
    const rows = body.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| |")).map((l) => l.split(" | ")[0]);
    expect(rows).toEqual(["| Params:", "| Returns:", "| Exceptions:", "| Remarks:"]);
    expect(body).not.toContain("&nbsp;&nbsp;True");
  });

  it("shows locals as their declaration with the kind below", () => {
    expect(buildHover("```csharp\n(parameter) int h\n```\n  \nHeight\\.  \n", null)).toEqual(["```csharp\nint h\n```", "Height\\.", "<small>parameter</small>"]);
    expect(buildHover("```csharp\nnamespace System\n```\n  \n", null)).toEqual(["```csharp\nnamespace System\n```"]);
  });
});
