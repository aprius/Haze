// Shows Unity's performance-critical context in an editor (lib/unity/perf.ts):
// a bar in the gutter beside the methods called every frame, and a dotted
// underline under the expensive calls in them, explained on hover.
import { api, type PerfMethod } from "../ipc";
import { monaco } from "../monaco";
import { toMonacoRange } from "../lsp/convert";
import { useWorkspace } from "../../store/workspace";
import { analyzePerf, type PerfReport } from "./perf";
import { onUnityCodeChanged, unityBaseFor, unityObjectFor, unityRootFor } from "./scripts";

export function installUnityPerf(editor: monaco.editor.ICodeEditor): monaco.IDisposable {
  const shown = editor.createDecorationsCollection();
  let report: PerfReport | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const render = () => {
    const { unityPerfContext: mode, unityPerfHints: hints } = useWorkspace.getState();
    if (!report) return shown.clear();
    const caret = editor.getPosition()?.lineNumber ?? 0;
    const decorations: monaco.editor.IModelDeltaDecoration[] = [];
    for (const { method, from } of report.hot) {
      const range = toMonacoRange(method.range);
      if (mode === "never" || (mode === "current" && (caret < range.startLineNumber || caret > range.endLineNumber))) continue;
      const why = from === "coroutine" ? "runs as a coroutine" : method.name === from ? "Unity calls it every frame" : `called from ${from}, every frame`;
      decorations.push(
        { range, options: { isWholeLine: true, linesDecorationsClassName: "unity-hot" } },
        { range: toMonacoRange(method.nameRange), options: { hoverMessage: { value: `**Performance-critical context**: ${why}.` } } },
      );
    }
    if (hints) {
      for (const c of report.costly) {
        decorations.push({ range: toMonacoRange(c.range), options: { inlineClassName: "unity-expensive", hoverMessage: { value: c.message } } });
      }
    }
    shown.set(decorations);
  };

  const update = (delay: number) => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const model = editor.getModel();
      const root = model?.uri.scheme === "file" && model.getLanguageId() === "csharp" ? unityRootFor(model.uri.fsPath) : null;
      const { unityPerfContext, unityPerfHints } = useWorkspace.getState();
      if (!model || !root || (unityPerfContext === "never" && !unityPerfHints)) {
        report = null;
        return render();
      }
      const version = model.getVersionId();
      const methods: PerfMethod[] = await api.csharpPerf(model.getValue()).catch(() => []);
      if (editor.getModel() !== model || model.getVersionId() !== version) return;
      report = analyzePerf(
        methods,
        (cls) => unityBaseFor(root, cls) === "MonoBehaviour",
        (type) => unityObjectFor(root, type),
      );
      render();
    }, delay);
  };

  const subs = [
    editor.onDidChangeModel(() => update(0)),
    editor.onDidChangeModelContent(() => update(400)),
    editor.onDidChangeCursorPosition(() => {
      if (useWorkspace.getState().unityPerfContext === "current") render();
    }),
  ];
  // Base classes arrive from the Unity index after the file opens.
  const offUnity = onUnityCodeChanged(() => update(0));
  const offSettings = useWorkspace.subscribe((s, prev) => {
    if (s.unityPerfContext !== prev.unityPerfContext || s.unityPerfHints !== prev.unityPerfHints) update(0);
  });
  update(0);
  return {
    dispose() {
      clearTimeout(timer);
      subs.forEach((d) => d.dispose());
      offUnity();
      offSettings();
      shown.clear();
    },
  };
}
