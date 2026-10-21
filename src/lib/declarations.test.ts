import { describe, expect, it } from "vitest";
import { declarationRegex, declarationsInLine, familyOf, isSearchableName } from "./declarations";

const names = (line: string, word: string, ext = "cs") => declarationsInLine(line, word, ext).map((h) => line.slice(h.start, h.end) + "@" + h.start);

describe("declarations", () => {
  it("finds C# declarations", () => {
    expect(names("public class OrderService : IService", "OrderService")).toEqual(["OrderService@13"]);
    expect(names("    public async Task<int> CountAsync(int id)", "CountAsync")).toEqual(["CountAsync@27"]);
    expect(names("    private readonly List<int> _items = new();", "_items")).toEqual(["_items@31"]);
    expect(names("    public Color Color { get; set; }", "Color")).toEqual(["Color@17"]);
    expect(names("    public string? Name { get; }", "Name")).toEqual(["Name@19"]);
    expect(names("        var total = 0;", "total")).toEqual(["total@12"]);
    expect(names("    void Run(int count, string name)", "count")).toEqual(["count@17"]);
    expect(names("    public OrderService(ILogger logger)", "OrderService")).toEqual(["OrderService@11"]);
    expect(names("namespace Shop.Orders;", "Orders")).toEqual([]);
    expect(names("public record struct Point(int X, int Y);", "Point")).toEqual(["Point@21"]);
  });

  it("ignores usages", () => {
    expect(names("        return Count(items);", "Count")).toEqual([]);
    expect(names("        var s = new OrderService(log);", "OrderService")).toEqual([]);
    expect(names("        await service.CountAsync(1);", "CountAsync")).toEqual([]);
    expect(names("        if (a > total) return;", "total")).toEqual([]);
    expect(names("        var x = ok ? Fallback() : y;", "Fallback")).toEqual([]);
    expect(names("        else Reset();", "Reset")).toEqual([]);
    expect(names("        // int total = 0;", "total")).toEqual([]);
    expect(names("        total = 1;", "total")).toEqual([]);
  });

  it("finds declarations in other languages", () => {
    expect(names("export function useCart() {", "useCart", "ts")).toEqual(["useCart@16"]);
    expect(names("const total = items.length;", "total", "tsx")).toEqual(["total@6"]);
    expect(names("  private count = 0;", "count", "ts")).toEqual(["count@10"]);
    expect(names("  async load(id: string): Promise<void> {", "load", "ts")).toEqual(["load@8"]);
    expect(names("  load(id);", "load", "ts")).toEqual([]);
    expect(names("void main(x)", "main", "js")).toEqual([]);
    expect(names("def load_items(path):", "load_items", "py")).toEqual(["load_items@4"]);
    expect(names("    self.cache = {}", "cache", "py")).toEqual(["cache@9"]);
    expect(names("    if cache == None:", "cache", "py")).toEqual([]);
    expect(names("func (r *Repo) Save(o Order) error {", "Save", "go")).toEqual(["Save@15"]);
    expect(names("    let mut count = 0;", "count", "rs")).toEqual(["count@12"]);
    expect(names("float4 frag(v2f i) : SV_Target", "frag", "shader")).toEqual(["frag@7"]);
  });

  it("builds one regex for the project search", () => {
    const re = declarationRegex("Foo", "cs");
    expect(new RegExp(re, "m").test("x\nclass Foo {")).toBe(true);
    expect(declarationRegex("a$b", "ts")).toContain("a\\$b");
  });

  it("knows which names and files to search", () => {
    expect(isSearchableName("OrderService")).toBe(true);
    expect(isSearchableName("return")).toBe(false);
    expect(isSearchableName("1abc")).toBe(false);
    expect(familyOf("TSX")).toContain("ts");
    expect(familyOf("md")).toBeNull();
  });
});
