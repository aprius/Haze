import { describe, expect, it } from "vitest";
import { backspaceEdit, completeStatement, mayApply, docCommentEdit, docCommentEnter, expandExpressionBody, expandInlineMethod, interpolateEdit, regionEdit, semicolonEdit, splitStringEdit } from "./csharpTyping";

/** Types `{` at `|` and returns the text with the caret marked, or null when nothing changes. */
function type(src: string, expand: (t: string, offset: number, unit: string) => ReturnType<typeof expandExpressionBody> = expandExpressionBody) {
  const offset = src.indexOf("|");
  const t = src.slice(0, offset) + src.slice(offset + 1);
  const e = expand(t, offset, "    ");
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

describe("expandInlineMethod", () => {
  const enter = (src: string) => type(src, expandInlineMethod);

  it("lays out a one-line method when Enter is pressed at its braces", () => {
    const src = "    private void OnActiveSceneChanged() { Refresh(); }";
    expect(enter(src.replace("{ ", "{| "))).toBe("    private void OnActiveSceneChanged()\n    {\n        |Refresh();\n    }");
    expect(enter(src.replace("{ ", "{ |"))).toBe("    private void OnActiveSceneChanged()\n    {\n        |Refresh();\n    }");
    expect(enter(src.replace("() {", "()| {"))).toBe("    private void OnActiveSceneChanged()\n    {\n        |Refresh();\n    }");
    expect(enter(src.replace(" }", "| }"))).toBe("    private void OnActiveSceneChanged()\n    {\n        Refresh();|\n    }");
    expect(enter(src.replace(" }", " |}"))).toBe("    private void OnActiveSceneChanged()\n    {\n        Refresh();|\n    }");
  });

  it("puts each statement on its own line, and an empty body on an empty line", () => {
    expect(enter("int F(int x) { var y = x * 2; return y; |}")).toBe("int F(int x)\n{\n    var y = x * 2;\n    return y;|\n}");
    expect(enter("void F() {| }")).toBe("void F()\n{\n    |\n}");
    expect(enter('void F() {| Log("a; }"); } // note')).toBe('void F()\n{\n    |Log("a; }");\n} // note');
  });

  it("leaves everything else to Enter", () => {
    expect(enter("void F() { Refresh(); }|")).toBeNull();
    expect(enter("void F() { Re|fresh(); }")).toBeNull();
    expect(enter("if (x) {| Refresh(); }")).toBeNull();
    expect(enter("var p = new Point() {| X = 1 };")).toBeNull();
    expect(enter("Action a = () => {| Refresh(); };")).toBeNull();
    expect(enter("public int X { get; |}")).toBeNull();
    expect(enter("void F() {|\n    Refresh(); }")).toBeNull();
  });
});

describe("docCommentEdit", () => {
  const slash = (src: string) => type(src, (t, o) => docCommentEdit(t, o));

  it("writes the doc comment of a method, caret in the summary", () => {
    expect(slash("    //|\n    public int Add(int a, int b = 2) => a + b;")).toBe(
      '    /// <summary>\n    /// |\n    /// </summary>\n    /// <param name="a"></param>\n    /// <param name="b"></param>\n    /// <returns></returns>\n    public int Add(int a, int b = 2) => a + b;',
    );
    expect(slash("//|\n[ContextMenu(\"Run\")]\nprivate void Run()\n{")).toBe("/// <summary>\n/// |\n/// </summary>\n[ContextMenu(\"Run\")]\nprivate void Run()\n{");
    expect(slash("//|\npublic async Task Load(string path, CancellationToken ct) {")).toBe(
      '/// <summary>\n/// |\n/// </summary>\n/// <param name="path"></param>\n/// <param name="ct"></param>\npublic async Task Load(string path, CancellationToken ct) {',
    );
    expect(slash("//|\npublic T Get<T>(Dictionary<string, T> map) where T : class;")).toBe(
      '/// <summary>\n/// |\n/// </summary>\n/// <typeparam name="T"></typeparam>\n/// <param name="map"></param>\n/// <returns></returns>\npublic T Get<T>(Dictionary<string, T> map) where T : class;',
    );
    expect(slash("//|\npublic Player(int hp,\n    int mana) : base(hp) {")).toBe(
      '/// <summary>\n/// |\n/// </summary>\n/// <param name="hp"></param>\n/// <param name="mana"></param>\npublic Player(int hp,\n    int mana) : base(hp) {',
    );
  });

  it("writes a summary for types, properties and fields", () => {
    expect(slash("//|\npublic class Pool<T> : MonoBehaviour where T : Component\n{")).toBe(
      '/// <summary>\n/// |\n/// </summary>\n/// <typeparam name="T"></typeparam>\npublic class Pool<T> : MonoBehaviour where T : Component\n{',
    );
    expect(slash("//|\n[SerializeField] private float speed = 5f;")).toBe("/// <summary>\n/// |\n/// </summary>\n[SerializeField] private float speed = 5f;");
    expect(slash("//|\npublic int Count { get; private set; }")).toBe("/// <summary>\n/// |\n/// </summary>\npublic int Count { get; private set; }");
  });

  it("types a plain slash elsewhere", () => {
    expect(slash("//|\n\nvoid F() {}")).toBeNull();
    expect(slash("/// <summary>\n//|\nvoid F() {}")).toBeNull();
    expect(slash("var x = 1; //|\nvoid F() {}")).toBeNull();
    expect(slash("//| text\nvoid F() {}")).toBeNull();
  });
});

describe("docCommentEnter", () => {
  const enter = (src: string) => type(src, (t, o) => docCommentEnter(t, o));
  it("continues a /// comment", () => {
    expect(enter("    /// Moves the player.|")).toBe("    /// Moves the player.\n    /// |");
    expect(enter("    /// Moves the| player.")).toBe("    /// Moves the\n    /// |player.");
    expect(enter("    // Moves the player.|")).toBeNull();
    expect(enter("    /|// x")).toBeNull();
  });
});

describe("interpolateEdit", () => {
  const brace = (src: string) => type(src, (t, o) => interpolateEdit(t, o));
  it("makes a plain string interpolated", () => {
    expect(brace('Debug.Log("Hp: |");')).toBe('Debug.Log($"Hp: {|}");');
    expect(brace('Debug.Log(@"C:\\|");')).toBe('Debug.Log($@"C:\\{|}");');
    expect(brace('var a = "x"; Log("Hp: |" + a);')).toBe('var a = "x"; Log($"Hp: {|}" + a);');
  });
  it("leaves other braces alone", () => {
    expect(brace('Log($"Hp: |");')).toBeNull();
    expect(brace('Log(string.Format("{0} |", hp));')).toBeNull();
    expect(brace("Log(|);")).toBeNull();
    expect(brace('// Log("|");')).toBeNull();
    expect(brace("var c = '|';")).toBeNull();
    expect(brace('Log("unterminated |')).toBeNull();
  });
});

describe("splitStringEdit", () => {
  const enter = (src: string) => type(src, splitStringEdit);
  it("splits a string at the caret", () => {
    expect(enter('    Log("Hello |world");')).toBe('    Log("Hello " +\n        "|world");');
    expect(enter('    Log($"Hp {hp} |of {max}");')).toBe('    Log($"Hp {hp} " +\n        $"|of {max}");');
  });
  it("leaves verbatim strings, holes and code alone", () => {
    expect(enter('Log(@"Hello |world");')).toBeNull();
    expect(enter('Log($"Hp {h|p}");')).toBeNull();
    expect(enter('Log("a")|;')).toBeNull();
    expect(enter('Log("a\\"b|c");')).toBe('Log("a\\"b" +\n    "|c");');
  });
});

describe("semicolonEdit", () => {
  const semi = (src: string) => type(src, (t, o) => semicolonEdit(t, o));
  it("puts the semicolon after the closing brackets", () => {
    expect(semi("    Foo(Bar(x|))")).toBe("    Foo(Bar(x));|");
    expect(semi("    var a = items[i|]\nNext();")).toBe("    var a = items[i];|\nNext();");
    expect(semi("    Foo(x|);")).toBe("    Foo(x);|");
    expect(semi('    Log("a)", x|)')).toBe('    Log("a)", x);|');
  });
  it("types it in place elsewhere", () => {
    expect(semi("for (int i = 0|)")).toBeNull();
    expect(semi("Foo(x|) + 1")).toBeNull();
    expect(semi('Log("a|")')).toBeNull();
    expect(semi("// Foo(x|)")).toBeNull();
    expect(semi("Foo(x|")).toBeNull();
    expect(semi("    a,\n    b|)")).toBeNull();
  });
});

describe("backspaceEdit", () => {
  const back = (src: string) => type(src, (t, o, unit) => backspaceEdit(t, o, unit, 4));
  it("goes back to the proper indentation, then joins a blank line", () => {
    expect(back("void F()\n{\n            |\n}")).toBe("void F()\n{\n    |\n}");
    expect(back("void F()\n{\n    |\n}")).toBe("void F()\n{|\n}");
    expect(back("    Foo();\n\n            |Bar();")).toBe("    Foo();\n\n    |Bar();");
    expect(back("    if (x)\n    {\n        Foo();\n        |}")).toBe("    if (x)\n    {\n        Foo();\n    |}");
  });
  it("leaves the rest to Backspace", () => {
    expect(back("    Foo();\n    |Bar();")).toBeNull();
    expect(back("    Foo(|);")).toBeNull();
    expect(back("    |")).toBeNull();
    expect(back("a\n|b")).toBeNull();
    expect(back("Foo(a,\n        |b);")).toBeNull();
    expect(back("    if (x)\n            |Foo();")).toBe("    if (x)\n        |Foo();");
  });
});

describe("regionEdit", () => {
  const enter = (src: string) => type(src, (t, o) => regionEdit(t, o));
  it("closes a new region", () => {
    expect(enter("    #region Unity|\n    void Start() {}")).toBe("    #region Unity\n    |\n    #endregion\n    void Start() {}");
    expect(enter("#region A|\n#region B\n#endregion")).toBe("#region A\n|\n#endregion\n#region B\n#endregion");
  });
  it("leaves a closed region alone", () => {
    expect(enter("#region A|\nvoid F() {}\n#endregion")).toBeNull();
    expect(enter("#region| A\n")).toBeNull();
  });
});

describe("completeStatement", () => {
  const complete = (src: string) => type(src, completeStatement);
  it("closes brackets and ends the statement", () => {
    expect(complete("    Foo(Bar(x|")).toBe("    Foo(Bar(x));\n    |");
    expect(complete("    var a = b|")).toBe("    var a = b;\n    |");
    expect(complete('    Log("a(b|" // note')).toBe('    Log("a(b"); // note\n    |');
    expect(complete("    Foo();|\n    Bar();")).toBe("    Foo();\n    |\n    Bar();");
  });
  it("adds the block a statement or declaration lacks", () => {
    expect(complete("    if (x > 0|")).toBe("    if (x > 0)\n    {\n        |\n    }");
    expect(complete("    foreach (var e in enemies|)")).toBe("    foreach (var e in enemies)\n    {\n        |\n    }");
    expect(complete("    else|")).toBe("    else\n    {\n        |\n    }");
    expect(complete("    private void Update(|")).toBe("    private void Update()\n    {\n        |\n    }");
    expect(complete("public class Player : MonoBehaviour|")).toBe("public class Player : MonoBehaviour\n{\n    |\n}");
    expect(complete("    if (x|)\n    {\n        Foo();")).toBe("    if (x)\n    {\n        |\n        Foo();");
  });
  it("does not take calls or one-line ifs for blocks", () => {
    expect(complete("    if (x) Foo(|")).toBe("    if (x) Foo();\n    |");
    expect(complete("    Foo(x|)")).toBe("    Foo(x);\n    |");
    expect(complete("    return Foo(x|")).toBe("    return Foo(x);\n    |");
    expect(complete("    {|")).toBe("    {\n        |");
  });
});

describe("regressions", () => {
  const U = "    ";
  it("{ at an arrow: not in comments, not a lambda's arrow; accessors stay on their line", () => {
    expect(type("// void F() => |\nFoo();")).toBeNull();
    expect(type("Func<int, int> Square => x => |x * x;")).toBeNull();
    expect(type("var f = c ? x => |x : null;")).toBeNull();
    expect(type("    public int X { get => |_x; set => _x = value; }")).toBe("    public int X { get { return _x;| } set => _x = value; }");
    expect(type("    public int X { get => _x; set => |_x = value; }")).toBe("    public int X { get => _x; set { _x = value;| } }");
    expect(type("public int? Find() => |null;")).toBe("public int? Find()\n{\n    return null;|\n}");
  });

  it("strings: never inside an escape", () => {
    expect(type('Log("a\\|nb");', (t, o) => splitStringEdit(t, o, U))).toBeNull();
    expect(type('Log($"a{|{b");', (t, o) => splitStringEdit(t, o, U))).toBeNull();
    expect(type('Log("a\\\\|");', (t, o) => interpolateEdit(t, o))).toBe('Log($"a\\\\{|}");');
  });

  it("; stays in conditions and attributes", () => {
    const semi = (src: string) => type(src, (t, o) => semicolonEdit(t, o));
    expect(semi("    if (Foo(x|))")).toBeNull();
    expect(semi("    } else if (Foo(x|))")).toBeNull();
    expect(semi("    while (Next(|))")).toBeNull();
    expect(semi("    [Range(0, 10|)]")).toBeNull();
  });

  it("Backspace leaves lines after multi-line statements alone", () => {
    const back = (src: string) => type(src, (t, o) => backspaceEdit(t, o, U, 4));
    expect(back("    Foo(a,\n        b);\n    |")).toBeNull();
    expect(back("        Foo();\n    |")).toBeNull();
  });

  it("#endregion when a region above is left open", () => {
    expect(type("#region Outer\n#region Inner|\n#endregion", (t, o) => regionEdit(t, o))).toBe("#region Outer\n#region Inner\n|\n#endregion\n#endregion");
  });

  it("doc comments skip tuple return types and keep operator parameters", () => {
    const slash = (src: string) => type(src, (t, o) => docCommentEdit(t, o));
    expect(slash("//|\npublic (int, string) Get(int id) {")).toBe(
      '/// <summary>\n/// |\n/// </summary>\n/// <param name="id"></param>\n/// <returns></returns>\npublic (int, string) Get(int id) {',
    );
    expect(slash("//|\npublic static Vec operator +(Vec a, Vec b) => new(a.X + b.X);")).toBe(
      '/// <summary>\n/// |\n/// </summary>\n/// <param name="a"></param>\n/// <param name="b"></param>\n/// <returns></returns>\npublic static Vec operator +(Vec a, Vec b) => new(a.X + b.X);',
    );
  });

  it("Complete Statement knows else after a brace, labels, attributes, directives and comments", () => {
    const complete = (src: string) => type(src, completeStatement);
    expect(complete("    } else|")).toBe("    } else\n    {\n        |\n    }");
    expect(complete("    } while (x|")).toBe("    } while (x);\n    |");
    expect(complete("    [SerializeField|")).toBe("    [SerializeField]\n    |");
    expect(complete("#if UNITY_EDITOR|")).toBe("#if UNITY_EDITOR\n|");
    expect(complete("        case 1:|")).toBe("        case 1:\n            |");
    expect(complete("    if (x // note|")).toBe("    if (x) // note\n    {\n        |\n    }");
    expect(complete("    // note|")).toBe("    // note\n    |");
  });
});

describe("mayApply", () => {
  it("agrees with the assists on the caret's line", () => {
    expect(mayApply("Backspace", "    ", "")).toBe(true);
    expect(mayApply("Backspace", "  x", "")).toBe(false);
    expect(mayApply("/", "    //", "")).toBe(true);
    expect(mayApply("/", "x //", "")).toBe(false);
    expect(mayApply(";", "Foo(x", "))")).toBe(true);
    expect(mayApply(";", "Foo(x)", "")).toBe(false);
    expect(mayApply("{", "void F() ", "=> x;")).toBe(true);
    expect(mayApply("{", "if (x) ", "")).toBe(false);
    expect(mayApply("Enter", "void F() ", "{ x(); }")).toBe(true);
    expect(mayApply("Enter", "    Foo();", "")).toBe(false);
  });
});
