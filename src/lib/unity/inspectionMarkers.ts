// Shows Unity's inspections in an editor (lib/unity/inspections.ts and
// asmdef.ts) as markers like the language server's, with a quick fix for a
// parent set after Instantiate, and completes the names a string can take:
// the project's tags in CompareTag(""), its scenes in LoadScene("")…
import { api, type ParentAfterInstantiate, type UnityCode } from "../ipc";
import { monaco } from "../monaco";
import { toMonacoRange } from "../lsp/convert";
import { useWorkspace } from "../../store/workspace";
import { inspectAsmdef } from "./asmdef";
import { inspectUnityCode, instantiateWithParent, unityNames, type UnityProblem } from "./inspections";
import { onUnityCodeChanged, projectDataFor, unityRootFor } from "./scripts";

const OWNER = "unity";

const SEVERITY: Record<UnityProblem["severity"], monaco.MarkerSeverity> = {
  error: monaco.MarkerSeverity.Error,
  warning: monaco.MarkerSeverity.Warning,
  info: monaco.MarkerSeverity.Info,
  hint: monaco.MarkerSeverity.Hint,
};

/** Editors showing each model: its markers go when the last one does. */
const showing = new Map<monaco.editor.ITextModel, number>();
/** The fixable Instantiate calls last found in each model. */
const parents = new WeakMap<monaco.editor.ITextModel, ParentAfterInstantiate[]>();

type Kind = "csharp" | "asmdef";

function kindOf(model: monaco.editor.ITextModel | null): { kind: Kind; root: string; path: string } | null {
  if (!model || model.uri.scheme !== "file") return null;
  const path = model.uri.fsPath;
  const root = unityRootFor(path);
  if (!root) return null;
  if (model.getLanguageId() === "csharp") return { kind: "csharp", root, path };
  if (/\.asmdef$/i.test(path)) return { kind: "asmdef", root, path };
  return null;
}

function setMarkers(model: monaco.editor.ITextModel, problems: UnityProblem[]) {
  monaco.editor.setModelMarkers(
    model,
    OWNER,
    problems.map((p) => ({ ...toMonacoRange(p.range), severity: SEVERITY[p.severity], message: p.message, code: p.code, source: "Unity" })),
  );
}

export function installUnityInspections(editor: monaco.editor.ICodeEditor): monaco.IDisposable {
  registerProviders();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: monaco.editor.ITextModel | null = null;

  const release = () => {
    if (!current) return;
    const n = (showing.get(current) ?? 1) - 1;
    if (n > 0) showing.set(current, n);
    else {
      showing.delete(current);
      if (!current.isDisposed()) monaco.editor.setModelMarkers(current, OWNER, []);
    }
    current = null;
  };

  const update = (delay: number) => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const model = editor.getModel();
      if (model !== current) {
        release();
        current = model;
        if (model) showing.set(model, (showing.get(model) ?? 0) + 1);
      }
      const file = kindOf(model);
      if (!model || !file || !useWorkspace.getState().unityInspections) {
        if (model && !model.isDisposed()) monaco.editor.setModelMarkers(model, OWNER, []);
        return;
      }
      const data = projectDataFor(file.root);
      if (file.kind === "asmdef") return setMarkers(model, inspectAsmdef(model.getValue(), file.path, data));
      const version = model.getVersionId();
      const code: UnityCode | null = await api.csharpUnity(model.getValue()).catch(() => null);
      if (!code || model.isDisposed() || model.getVersionId() !== version) return;
      parents.set(model, code.setParent);
      setMarkers(model, inspectUnityCode(code, data));
    }, delay);
  };

  const subs = [editor.onDidChangeModel(() => update(0)), editor.onDidChangeModelContent(() => update(400))];
  // Tags, scenes… arrive (or change) from the Unity index.
  const offUnity = onUnityCodeChanged(() => update(0));
  const offSettings = useWorkspace.subscribe((s, prev) => {
    if (s.unityInspections !== prev.unityInspections) update(0);
  });
  update(0);
  return {
    dispose() {
      clearTimeout(timer);
      subs.forEach((d) => d.dispose());
      offUnity();
      offSettings();
      release();
    },
  };
}

let registered = false;

function registerProviders() {
  if (registered) return;
  registered = true;

  monaco.languages.registerCodeActionProvider("csharp", {
    provideCodeActions(model, _range, context) {
      const actions: monaco.languages.CodeAction[] = [];
      for (const marker of context.markers) {
        if (marker.source !== "Unity" || marker.code !== "InstantiateWithoutParent") continue;
        const p = parents.get(model)?.find((x) => x.range.start.line + 1 === marker.startLineNumber && x.range.start.character + 1 === marker.startColumn);
        if (!p || p.world === null) continue;
        const call = toMonacoRange(p.instantiate);
        const callText = model.getValueInRange(call);
        const close = callText.lastIndexOf(")");
        if (close < 0) continue;
        const args = `, ${p.parent}${p.world ? ", true" : ""}`;
        // The statement setting the parent goes, with its line when it is alone on it.
        const stmt = toMonacoRange(p.range);
        const line = model.getLineContent(stmt.startLineNumber);
        const alone = stmt.startLineNumber === stmt.endLineNumber && line.trim() === model.getValueInRange(stmt).trim();
        const remove = alone
          ? stmt.startLineNumber < model.getLineCount()
            ? new monaco.Range(stmt.startLineNumber, 1, stmt.startLineNumber + 1, 1)
            : new monaco.Range(stmt.startLineNumber - 1, model.getLineMaxColumn(stmt.startLineNumber - 1), stmt.startLineNumber, model.getLineMaxColumn(stmt.startLineNumber))
          : stmt;
        actions.push({
          title: `Set the parent in Instantiate: ${instantiateWithParent(p)}`,
          kind: "quickfix",
          diagnostics: [marker],
          isPreferred: true,
          edit: {
            edits: [
              { resource: model.uri, versionId: model.getVersionId(), textEdit: { range: remove, text: "" } },
              { resource: model.uri, versionId: model.getVersionId(), textEdit: { range: new monaco.Range(call.startLineNumber, call.startColumn, call.endLineNumber, call.endColumn), text: callText.slice(0, close) + args + callText.slice(close) } },
            ],
          },
        });
      }
      return { actions, dispose() {} };
    },
  });

  monaco.languages.registerCompletionItemProvider("csharp", {
    triggerCharacters: ['"', "/"],
    async provideCompletionItems(model, position) {
      const file = kindOf(model);
      if (!file || file.kind !== "csharp" || !useWorkspace.getState().unityInspections) return { suggestions: [] };
      const data = projectDataFor(file.root);
      // Only inside a string: an odd number of quotes before the caret (most completions are not).
      const before = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      if (!data || (before.replace(/\\./g, "").match(/"/g)?.length ?? 0) % 2 === 0) return { suggestions: [] };
      const code = await api.csharpUnity(model.getValue()).catch(() => null);
      const line = position.lineNumber - 1;
      const col = position.column - 1;
      // Inside the quotes of a string Unity is passed (on one line).
      const ref = code?.refs.find((r) => r.range.start.line === line && r.range.end.line === line && r.range.start.character < col && col < r.range.end.character);
      if (!ref) return { suggestions: [] };
      const text = model.getLineContent(position.lineNumber);
      const open = text.indexOf('"', ref.range.start.character);
      if (open < 0 || col <= open) return { suggestions: [] };
      const range = new monaco.Range(position.lineNumber, open + 2, position.lineNumber, ref.range.end.character);
      const names = [...new Set(unityNames(ref.kind, data))];
      return {
        suggestions: names.map((name, i) => ({
          label: name,
          kind: monaco.languages.CompletionItemKind.Value,
          detail: `Unity ${ref.kind.replace(/[A-Z]/g, (c) => " " + c.toLowerCase())}`,
          insertText: name,
          range,
          sortText: String(i).padStart(5, "0"),
        })),
      };
    },
  });
}
