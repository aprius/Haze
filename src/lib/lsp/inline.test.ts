import { describe, expect, it } from "vitest";
import { pickInline, type LspCompletionItem } from "./inline";

// The word "To" typed at line 3, characters 8-10.
const pick = (items: LspCompletionItem[], prefix = "To") => pickInline(items, prefix, 3, 8, 8 + prefix.length)?.text ?? null;
const range = (start: number, end: number, line = 3) => ({ start: { line, character: start }, end: { line, character: end } });

describe("pickInline", () => {
  it("continues the typed word with the lowest sort text", () => {
    expect(pick([{ label: "ToString" }, { label: "ToArray" }, { label: "Total" }])).toBe("ToArray");
    expect(pick([{ label: "ToString", sortText: "a" }, { label: "ToArray", sortText: "b" }])).toBe("ToString");
  });

  it("prefers Roslyn's preselected item", () => {
    expect(pick([{ label: "ToArray" }, { label: "ToList", preselect: true }])).toBe("ToList");
  });

  it("needs two typed characters and something left to add", () => {
    expect(pick([{ label: "ToString" }], "T")).toBeNull();
    expect(pick([{ label: "To" }])).toBeNull();
  });

  it("only continues the prefix exactly, in the same case", () => {
    expect(pick([{ label: "ToString" }], "to")).toBeNull();
    expect(pick([{ label: "Count" }, { label: "AToB" }])).toBeNull();
    expect(pick([{ label: "ToString", filterText: "string" }])).toBeNull();
  });

  it("inserts the item's text rather than its label", () => {
    expect(pick([{ label: "ToString()", insertText: "ToString" }])).toBe("ToString");
    expect(pick([{ label: "Tokens", textEdit: { newText: "Tokens", range: range(8, 10) } }])).toBe("Tokens");
  });

  it("skips items that replace more than the typed word", () => {
    expect(pick([{ label: "ToString", textEdit: { newText: "ToString", range: range(7, 10) } }])).toBeNull();
    expect(pick([{ label: "ToString", textEdit: { newText: "ToString", insert: range(8, 11) } }])).toBeNull();
    expect(pick([{ label: "ToString", textEdit: { newText: "ToString", range: range(8, 10, 2) } }])).toBeNull();
  });

  it("skips snippets with placeholders and multi-line inserts", () => {
    expect(pick([{ label: "ToDo", insertText: "ToDo($1)", insertTextFormat: 2 }])).toBeNull();
    expect(pick([{ label: "Total", insertText: "Total", insertTextFormat: 2 }])).toBe("Total");
    expect(pick([{ label: "ToBlock", insertText: "ToBlock\n{\n}" }])).toBeNull();
  });

  it("returns the item so its resolved edits can be applied", () => {
    const item = { label: "ToImmutableList", additionalTextEdits: [{ range: range(0, 0, 0), newText: "using System.Collections.Immutable;\n" }] };
    expect(pickInline([item], "To", 3, 8, 10)?.item).toBe(item);
  });
});
