import { describe, expect, it } from "vitest";
import { expandExpressionBody } from "./expressionBody";

/** Types `{` at `|` and returns the text with the caret marked, or null when nothing changes. */
function type(src: string) {
  const offset = src.indexOf("|");
  const t = src.slice(0, offset) + src.slice(offset + 1);
  const e = expandExpressionBody(t, offset, "    ");
  if (!e) return null;
  const out = t.slice(0, e.start) + e.text + t.slice(e.end);
  return out.slice(0, e.caret) + "|" + out.slice(e.caret);
}

describe("expandExpressionBody", () => {
  it("turns a void method into a block, typed after or before the arrow", () => {
    const want = "    private void Start()\n    {\n        SceneManager.activeSceneChanged += OnActiveSceneChanged;|\n    }";
    expect(type("    private void Start() => |SceneManager.activeSceneChanged += OnActiveSceneChanged;")).toBe(want);
    expect(type("    private void Start() =>| SceneManager.activeSceneChanged += OnActiveSceneChanged;")).toBe(want);
    expect(type("    private void Start() |=> SceneManager.activeSceneChanged += OnActiveSceneChanged;")).toBe(want);
    expect(type("    private void Start()| => SceneManager.activeSceneChanged += OnActiveSceneChanged;")).toBe(want);
  });

  it("returns the value of a non-void method", () => {
    expect(type("int Count() => |items.Count;")).toBe("int Count()\n{\n    return items.Count;|\n}");
    expect(type("public List<int> Get<T>(T x) => |Make(x);")).toBe("public List<int> Get<T>(T x)\n{\n    return Make(x);|\n}");
    expect(type("int Fail() => |throw new Exception();")).toBe("int Fail()\n{\n    throw new Exception();|\n}");
  });

  it("knows async Task, constructors, destructors and local functions", () => {
    expect(type("public async Task Run() => |await Go();")).toBe("public async Task Run()\n{\n    await Go();|\n}");
    expect(type("public async Task<int> Run() => |await Go();")).toBe("public async Task<int> Run()\n{\n    return await Go();|\n}");
    expect(type("public Foo(int x) => |_x = x;")).toBe("public Foo(int x)\n{\n    _x = x;|\n}");
    expect(type("public Foo(int x) : base(x) => |_x = x;")).toBe("public Foo(int x) : base(x)\n{\n    _x = x;|\n}");
    expect(type("~Foo() => |Free();")).toBe("~Foo()\n{\n    Free();|\n}");
    expect(type("void IFoo.Bar() => |Baz();")).toBe("void IFoo.Bar()\n{\n    Baz();|\n}");
  });

  it("turns properties and indexers into getters, accessors into blocks", () => {
    expect(type("  public int Count => |_items.Count;")).toBe("  public int Count\n  {\n      get { return _items.Count;| }\n  }");
    expect(type("public int this[int i] => |_a[i];")).toBe("public int this[int i]\n{\n    get { return _a[i];| }\n}");
    expect(type("    get => |_x;")).toBe("    get\n    {\n        return _x;|\n    }");
    expect(type("    set => |_x = value;")).toBe("    set\n    {\n        _x = value;|\n    }");
  });

  it("keeps strings, comments and nested braces in the expression", () => {
    expect(type('void Log() => |Debug.Log($"a;{x};" + "}"); // done')).toBe('void Log()\n{\n    Debug.Log($"a;{x};" + "}");|\n} // done');
    expect(type("void Go() => |list.ForEach(x => { Use(x); });")).toBe("void Go()\n{\n    list.ForEach(x => { Use(x); });|\n}");
    expect(type("void Go() =>|\n    Foo(1,\n        2);")).toBe("void Go()\n{\n    Foo(1,\n            2);|\n}");
  });

  it("leaves lambdas, switch arms and other code alone", () => {
    expect(type("Func<int> f = () => |1;")).toBeNull();
    expect(type("var f = x => |x + 1;")).toBeNull();
    expect(type("items.Select(x => |x.Id);")).toBeNull();
    expect(type("Foo((a, b) => |a + b);")).toBeNull();
    expect(type("var r = shape switch { Circle c => |c.R, _ => 0 };")).toBeNull();
    expect(type("var r = shape switch { Circle c => |c.R };")).toBeNull();
    expect(type("return x => |x;")).toBeNull();
    expect(type("void Start() => Foo(|);")).toBeNull();
    expect(type("void Start() => Foo()|")).toBeNull();
  });
});
