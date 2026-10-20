// Monaco setup: bundled locally (no CDN).
import * as monaco from "monaco-editor";
// Monaco's own `new URL(worker, import.meta.url)` is copied by Vite without
// its imports, so the worker (diff computation, word suggestions) would fail.
// Vite's `?worker` import bundles it properly.
import EditorWorker from "monaco-editor/editor/editor.worker?worker";

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

monaco.editor.defineTheme("haze-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#1e1f22",
    "editorGutter.background": "#1e1f22",
    "editor.lineHighlightBackground": "#26282e",
    "editorLineNumber.foreground": "#4b5059",
    "editorLineNumber.activeForeground": "#a1a3ab",
  },
});

monaco.editor.defineTheme("haze-light", {
  base: "vs",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#ffffff",
    "editor.lineHighlightBackground": "#f5f8fe",
  },
});

export function languageFor(path: string): string {
  const lower = path.toLowerCase();
  const name = lower.split(/[\\/]/).pop() ?? lower;
  for (const lang of monaco.languages.getLanguages()) {
    if (lang.filenames?.some((f) => f.toLowerCase() === name)) return lang.id;
  }
  // Longest matching extension wins (`.razor.cs` before `.cs`).
  let best: { id: string; len: number } | null = null;
  for (const lang of monaco.languages.getLanguages()) {
    for (const ext of lang.extensions ?? []) {
      const e = ext.toLowerCase();
      if (name.endsWith(e) && (!best || e.length > best.len)) best = { id: lang.id, len: e.length };
    }
  }
  if (best) return best.id;
  if (/\.(csproj|fsproj|vbproj|props|targets|slnx|config|nuspec|resx|xaml|axaml)$/.test(name)) return "xml";
  if (name.endsWith(".sln")) return "ini";
  return "plaintext";
}

export { monaco };
