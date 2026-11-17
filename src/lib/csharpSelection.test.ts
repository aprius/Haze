import { describe, expect, it } from "vitest";
import { moveStatement, selectionRanges } from "./csharpSelection";

/** The texts selected step by step from `|`, as Monaco keeps them: nested, innermost first. */
function steps(src: string): string[] {
  const o = src.indexOf("|");
  const t = src.slice(0, o) + src.slice(o + 1);
  const spans = selectionRanges(t, o);
  // Monaco's order: by start descending, then end ascending; keep each that contains the last.
  spans.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  const kept: [number, number][] = [];
  for (const sp of spans) {
    const last = kept[kept.length - 1];
    if (!last || (sp[0] <= last[0] && sp[1] >= last[1] && (sp[0] !== last[0] || sp[1] !== last[1]))) kept.push(sp);
  }
  return kept.map(([a, b]) => t.slice(a, b));
}

const CODE = `class Player : MonoBehaviour
{
    /// <summary>Moves.</summary>
    void Update()
    {
        var speed = transform.position.x * Time.deltaTime;
        if (target != null)
        {
            Move(target.position, spe|ed + 1);
        }
    }
}`;

describe("selectionRanges", () => {
  it("climbs from a name to the class", () => {
    expect(steps(CODE)).toEqual([
      "speed",
      "speed + 1",
      "target.position, speed + 1",
      "(target.position, speed + 1)",
      "Move(target.position, speed + 1)",
      "Move(target.position, speed + 1);",
      "{\n            Move(target.position, speed + 1);\n        }",
      "if (target != null)\n        {\n            Move(target.position, speed + 1);\n        }",
      "var speed = transform.position.x * Time.deltaTime;\n        if (target != null)\n        {\n            Move(target.position, speed + 1);\n        }",
      expect.stringMatching(/^\{\n        var speed[\s\S]*\n    \}$/),
      expect.stringMatching(/^void Update\(\)[\s\S]*\n    \}$/),
      expect.stringMatching(/^\/\/\/ <summary>Moves.<\/summary>\n    void Update\(\)[\s\S]*\n    \}$/),
      expect.stringMatching(/^\{\n    \/\/\/[\s\S]*\n\}$/),
      CODE.replace("|", ""),
    ]);
  });

  it("follows member-access chains and the right-hand side", () => {
    const s = steps(CODE.replace("spe|ed + 1", "speed + 1").replace("transform.position.x", "transform.posi|tion.x"));
    expect(s.slice(0, 6)).toEqual([
      "position",
      "transform.position",
      "transform.position.x",
      "transform.position.x * Time.deltaTime",
      "var speed = transform.position.x * Time.deltaTime",
      "var speed = transform.position.x * Time.deltaTime;",
    ]);
  });

  it("selects through calls with type arguments", () => {
    expect(steps("void F()\n{\n    var rb = GetComponent<Rigidbody>().veloc|ity.y;\n}").slice(0, 4)).toEqual([
      "velocity",
      "GetComponent<Rigidbody>().velocity",
      "GetComponent<Rigidbody>().velocity.y",
      "var rb = GetComponent<Rigidbody>().velocity.y",
    ]);
  });

  it("selects inside strings, then the string", () => {
    expect(steps('void F()\n{\n    Debug.Log("Hello wo|rld");\n}').slice(0, 5)).toEqual(["world", "Hello world", '"Hello world"', '("Hello world")', 'Debug.Log("Hello world")']);
  });

  it("selects a lambda's body, then the lambda", () => {
    expect(steps("void F()\n{\n    items.Where(x => x.Al|ive).ToList();\n}").slice(0, 4)).toEqual(["Alive", "x.Alive", "x => x.Alive", "(x => x.Alive)"]);
  });

  it("keeps an initializer or lambda statement whole", () => {
    const s = steps("class A\n{\n    void F()\n    {\n        Action a = () =>\n        {\n            Fo|o();\n        };\n        Bar();\n    }\n}");
    expect(s).toContain("Action a = () =>\n        {\n            Foo();\n        };");
    const p = steps("class A\n{\n    public int Hp { get; set; } = 1|0;\n    void F() { }\n}");
    expect(p).toContain("public int Hp { get; set; } = 10;");
  });

  it("treats if-else and try-catch as one statement", () => {
    const s = steps("void F()\n{\n    if (a)\n    {\n        X();\n    }\n    else\n    {\n        |Y();\n    }\n    Z();\n}");
    expect(s).toContain("if (a)\n    {\n        X();\n    }\n    else\n    {\n        Y();\n    }");
  });
});

describe("moveStatement", () => {
  const move = (src: string, up: boolean) => {
    const o = src.indexOf("|");
    const t = src.slice(0, o) + src.slice(o + 1);
    const e = moveStatement(t, o, up);
    if (e === null || e === "edge") return e;
    const out = t.slice(0, e.start) + e.text + t.slice(e.end);
    return out.slice(0, e.caret) + "|" + out.slice(e.caret);
  };
  const CLASS = `class A
{
    /// <summary>First.</summary>
    void First()
    {
        X();
    }

    [ContextMenu("Go")]
    void Sec|ond() => Y();
}`;

  it("moves a member past the one above, doc comment and attribute along", () => {
    expect(move(CLASS, true)).toBe(`class A
{
    [ContextMenu("Go")]
    void Sec|ond() => Y();

    /// <summary>First.</summary>
    void First()
    {
        X();
    }
}`);
    expect(move(CLASS, false)).toBe("edge");
  });

  it("moves a whole block statement from its header or closing brace", () => {
    const src = "void F()\n{\n    A();\n    if (x)\n    {\n        B();\n    |}\n    C();\n}";
    expect(move(src, false)).toBe("void F()\n{\n    A();\n    C();\n    if (x)\n    {\n        B();\n    |}\n}");
    expect(move("void F()\n{\n    A();\n    i|f (x)\n    {\n        B();\n    }\n}", true)).toBe("void F()\n{\n    i|f (x)\n    {\n        B();\n    }\n    A();\n}");
  });

  it("moves a statement inside its block only", () => {
    expect(move("void F()\n{\n    if (x)\n    {\n        |B();\n    }\n}", true)).toBe("edge");
    expect(move("void F()\n{\n    A();\n    |B();\n}", true)).toBe("void F()\n{\n    |B();\n    A();\n}");
  });

  it("leaves statements sharing a line to the line move", () => {
    expect(move("void F()\n{\n    A(); |B();\n    C();\n}", false)).toBeNull();
  });
});
