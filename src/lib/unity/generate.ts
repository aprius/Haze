// Unity event functions in completion: typing "OnTrig" in the body
// of a MonoBehaviour offers OnTriggerEnter(Collider other) and the rest, with
// the right signature; Generate (Alt+Insert, Ctrl+Enter on macOS) lists all of the
// class's event functions not declared yet.
import { monaco } from "../monaco";
import { sessionForPath } from "../lsp/csharp";
import { toMonacoRange, type LspRange } from "../lsp/convert";
import { messageSignature, UNITY_MESSAGES_BY_BASE } from "./messages";
import { requestUnityGenerate, unityBaseFor, unityGenerateActive, unityRootFor } from "./scripts";
import { typeName } from "./tests";

interface DocSymbol {
  name: string;
  kind: number;
  range: LspRange;
  children?: DocSymbol[];
}

/**
 * The start of a member declaration: indentation, modifiers, then the name
 * being typed. Anything else on the line (a type, "=", "(") is not one.
 */
const MEMBER_START = /^(\s*)((?:(?:public|private|protected|internal|static|override|virtual|async|void)\s+)*)(\w*)$/;

/** The innermost symbol around a position, with the chain of its parents. */
function enclosing(symbols: DocSymbol[], pos: monaco.IPosition): DocSymbol[] {
  for (const s of symbols) {
    if (!monaco.Range.containsPosition(toMonacoRange(s.range), pos)) continue;
    return [s, ...enclosing(s.children ?? [], pos)];
  }
  return [];
}

let registered = false;

export function registerUnityCompletion(): void {
  if (registered) return;
  registered = true;
  monaco.languages.registerCompletionItemProvider("csharp", {
    async provideCompletionItems(model, position, _context, token) {
      const none = { suggestions: [] };
      const root = unityRootFor(model.uri.fsPath);
      if (!root) return none;
      const before = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      const m = MEMBER_START.exec(before);
      // On an empty line, only when asked for (Generate): not on every Ctrl+Space.
      if (!m || (!m[2] && !m[3] && !unityGenerateActive())) return none;
      const session = sessionForPath(model.uri.fsPath);
      if (!session?.usable) return none;
      const symbols = await session
        .request<DocSymbol[] | null>("textDocument/documentSymbol", { textDocument: { uri: model.uri.toString() } }, token)
        .catch(() => null);
      const chain = enclosing(symbols ?? [], position);
      const cls = chain[chain.length - 1];
      // In a class body, not in one of its members.
      if (!cls || cls.kind !== 5 || token.isCancellationRequested) return none;
      const base = unityBaseFor(root, typeName(cls.name));
      if (!base) return none;
      const declared = new Set((cls.children ?? []).filter((c) => c.kind === 6).map((c) => c.name.replace(/\(.*$/, "")));
      const access = /\b(public|private|protected|internal)\b/.exec(m[2])?.[0] ?? "private";
      const range = new monaco.Range(position.lineNumber, m[1].length + 1, position.lineNumber, position.column);
      const suggestions: monaco.languages.CompletionItem[] = UNITY_MESSAGES_BY_BASE[base]
        .filter((msg) => !declared.has(msg.name))
        .map((msg) => ({
          label: { label: msg.name, detail: `(${msg.params})`, description: `Unity ${base}` },
          kind: monaco.languages.CompletionItemKind.Method,
          documentation: msg.description,
          detail: messageSignature(msg, access),
          insertText: `${messageSignature(msg, access)}\n{\n\t$0\n}`,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
          // Monaco filters on the text from the range start: the modifiers typed, then the name.
          filterText: m[2] + msg.name,
          sortText: "!" + msg.name,
        }));
      return { suggestions };
    },
  });
}

/**
 * Generate: lists the event functions of the Unity class at the caret. On a
 * line with code, a new line is opened below first. False outside a Unity script.
 */
export function generateUnityMember(editor: monaco.editor.ICodeEditor): boolean {
  const model = editor.getModel();
  const pos = editor.getPosition();
  if (!model || !pos || model.getLanguageId() !== "csharp" || !unityRootFor(model.uri.fsPath)) return false;
  if (model.getLineContent(pos.lineNumber).trim()) {
    editor.setPosition({ lineNumber: pos.lineNumber, column: model.getLineMaxColumn(pos.lineNumber) });
    editor.trigger("haze.generate", "type", { text: "\n" });
  }
  requestUnityGenerate();
  editor.trigger("haze.generate", "editor.action.triggerSuggest", {});
  return true;
}
