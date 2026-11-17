// Haze's own C# editing providers, from text (they work before Roslyn loads):
// live templates (csharpTemplates.ts) and postfix templates (csharpPostfix.ts)
// in completion, and Extend Selection's steps (csharpSelection.ts).
import { monaco } from "./monaco";
import { selectionRanges } from "./csharpSelection";
import { blockContext, templateBody, templatesFor } from "./csharpTemplates";
import { postfixExpression, postfixFor, postfixSnippet } from "./csharpPostfix";

let registered = false;

export function registerCsharpProviders(): void {
  if (registered) return;
  registered = true;
  monaco.languages.registerCompletionItemProvider("csharp", {
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const lineBefore = model.getLineContent(position.lineNumber).slice(0, word.startColumn - 1);
      // Not after a `.`: member access is not a statement (postfix templates live there).
      if (!word.word || /\.\s*$/.test(lineBefore)) return { suggestions: [] };
      const context = blockContext(model.getValue(), model.getOffsetAt(position));
      const fileName = model.uri.path.split("/").pop()!.replace(/\.[^.]*$/, "");
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, position.column);
      const suggestions = templatesFor(context, lineBefore, word.word).map((t) => {
        const body = templateBody(t, { typeName: context.typeName, fileName });
        return {
          label: { label: t.key, description: t.description },
          kind: monaco.languages.CompletionItemKind.Snippet,
          detail: t.description,
          // The expansion, without the snippet's field markers.
          documentation: { value: "```csharp\n" + body.replace(/\$\{\d+:?([^}]*)\}/g, "$1").replace(/\$\d+/g, "").replace(/\\(.)/g, "$1") + "\n```" },
          insertText: body,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
          // An exact abbreviation goes first, ahead of Roslyn's keyword of the same name.
          sortText: (t.key === word.word ? "!" : "~") + t.key,
        } satisfies monaco.languages.CompletionItem;
      });
      return { suggestions };
    },
  });

  // Postfix templates, after the `.` of an expression in code: listed after Roslyn's members.
  monaco.languages.registerCompletionItemProvider("csharp", {
    triggerCharacters: ["."],
    provideCompletionItems(model, position) {
      const none = { suggestions: [] };
      const word = model.getWordUntilPosition(position);
      const line = model.getLineContent(position.lineNumber);
      const dot = word.startColumn - 2;
      if (line[dot] !== ".") return none;
      const expr = postfixExpression(line, dot);
      if (!expr || blockContext(model.getValue(), model.getOffsetAt(position)).kind !== "code") return none;
      const range = new monaco.Range(position.lineNumber, expr.start + 1, position.lineNumber, position.column);
      return {
        suggestions: postfixFor(expr).map((p) => ({
          label: { label: p.key, description: p.description },
          kind: monaco.languages.CompletionItemKind.Snippet,
          detail: `Postfix: ${p.description}`,
          insertText: postfixSnippet(p, expr),
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
          // Monaco filters on the text from the range start: the expression, the dot, then the key.
          filterText: `${expr.text}.${p.key}`,
          sortText: "~" + p.key,
        })),
      };
    },
  });

  // Extend Selection (Ctrl+W, Alt+Up on macOS) by C# syntax. Monaco drops its bracket
  // steps once a language has a provider, so these include the brackets.
  monaco.languages.registerSelectionRangeProvider("csharp", {
    provideSelectionRanges(model, positions) {
      const text = model.getValue();
      return positions.map((p) =>
        selectionRanges(text, model.getOffsetAt(p)).map(([a, b]) => ({ range: monaco.Range.fromPositions(model.getPositionAt(a), model.getPositionAt(b)) })),
      );
    },
  });
}
