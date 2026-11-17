import { describe, expect, it } from "vitest";
import { itemNameFor, nameFor, POSTFIX, postfixExpression, postfixFor, postfixSnippet } from "./csharpPostfix";

/** The expression before the last `.` of `line`, and whether it is a statement. */
const expr = (line: string) => {
  const e = postfixExpression(line, line.lastIndexOf("."));
  return e && `${e.text}${e.statement ? " (statement)" : ""}`;
};

describe("postfixExpression", () => {
  it("takes the whole statement so far", () => {
    expect(expr("        enemies.")).toBe("enemies (statement)");
    expect(expr("        GetComponent<Rigidbody>().")).toBe("GetComponent<Rigidbody>() (statement)");
    expect(expr("        player.Health > 0 && alive.")).toBe("player.Health > 0 && alive (statement)");
    expect(expr('        Find("a.b").')).toBe('Find("a.b") (statement)');
    expect(expr("        await LoadAsync(path).")).toBe("await LoadAsync(path) (statement)");
    expect(expr("        target?.transform.")).toBe("target?.transform (statement)");
    expect(expr("        a ?? b.")).toBe("a ?? b (statement)");
  });

  it("starts after assignments, arguments, keywords and lambdas", () => {
    expect(expr("        var rb = GetComponent<Rigidbody>().")).toBe("GetComponent<Rigidbody>()");
    expect(expr("        Foo(a, b.")).toBe("b");
    expect(expr("        return hp.")).toBe("hp");
    expect(expr("        items.ForEach(x => x.")).toBe("x");
    expect(expr("        if (x == y.")).toBe("x == y");
    expect(expr("        var a = c ? x : y.")).toBe("y");
  });

  it("finds no expression in comments, strings, numbers or after spaces", () => {
    expect(expr("        // enemies.")).toBeNull();
    expect(expr('        Log("enemies.')).toBeNull();
    expect(expr("        var f = 1.")).toBeNull();
    expect(expr("        .")).toBeNull();
  });
});

describe("names", () => {
  it("names a value after its expression", () => {
    expect(nameFor("GetComponent<Rigidbody>()")).toBe("rigidbody");
    expect(nameFor("player.GetHealth()")).toBe("health");
    expect(nameFor("new EnemySpawner()")).toBe("enemySpawner");
    expect(nameFor("UIManager.Instance")).toBe("instance");
    expect(nameFor("FindObjectsOfType<Enemy>()")).toBe("enemy");
    expect(nameFor("items[0]")).toBe("items");
    expect(nameFor("GetString()")).toBe("stringValue");
    expect(nameFor('"abc"')).toBe("value");
  });

  it("names a collection's items", () => {
    expect(itemNameFor("enemies")).toBe("enemy");
    expect(itemNameFor("transform.children")).toBe("child");
    expect(itemNameFor("GetComponentsInChildren<Collider>()")).toBe("collider");
    expect(itemNameFor("boxes")).toBe("box");
    expect(itemNameFor("enemyList")).toBe("enemy");
    expect(itemNameFor("points")).toBe("point");
    expect(itemNameFor("grass")).toBe("item");
    expect(itemNameFor("data")).toBe("item");
  });
});

describe("postfix templates", () => {
  const expand = (line: string, key: string) => {
    const e = postfixExpression(line, line.lastIndexOf("."))!;
    const p = POSTFIX.find((x) => x.key === key)!;
    return postfixFor(e).includes(p) ? postfixSnippet(p, e) : null;
  };
  it("wraps the expression", () => {
    expect(expand("        enemies.", "foreach")).toBe("foreach (var ${1:enemy} in enemies)\n{\n\t$0\n}");
    expect(expand("        GetComponent<Rigidbody>().", "var")).toBe("var ${1:rigidbody} = GetComponent<Rigidbody>();$0");
    expect(expand("        target.", "notnull")).toBe("if (target != null)\n{\n\t$0\n}");
    expect(expand("        a && b.", "else")).toBe("if (!(a && b))\n{\n\t$0\n}");
    expect(expand("        isDead.", "else")).toBe("if (!isDead)\n{\n\t$0\n}");
    expect(expand('        $"{hp}".', "log")).toBe('Debug.Log(\\$"{hp\\}");$0');
  });
  it("keeps statement templates to whole statements", () => {
    expect(expand("        var a = b.", "if")).toBeNull();
    expect(expand("        var a = b.", "not")).toBe("!b$0");
    expect(expand("        Foo(x.", "cast")).toBe("((${1:Type})x)$0");
  });
  it("has unique keys", () => {
    expect(new Set(POSTFIX.map((p) => p.key)).size).toBe(POSTFIX.length);
  });
});
