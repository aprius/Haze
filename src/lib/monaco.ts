// Monaco setup: bundled locally (no CDN).
import * as monaco from "monaco-editor";
// Monaco's own `new URL(worker, import.meta.url)` is copied by Vite without
// its imports, so the worker (diff computation, word suggestions) would fail.
// Vite's `?worker` import bundles it properly.
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/languages/features/json/json.worker?worker";
import { codeFontFamily, codeLineHeight, loadCodeFont, useFonts } from "./fonts";
import { monacoTheme, useTheme } from "./theme";

// JSON is the one language service Haze keeps (see vite.config.ts); it needs
// its own worker, or every request fails with "Missing requestHandler".
(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: (_id, label) => (label === "json" ? new JsonWorker() : new EditorWorker()),
};

// Monokai Pro (Filter: Pro for dark, Filter: Light for light). Monarch only
// emits coarse token classes, so these map the filter's palette onto them.
const MONOKAI = {
  dark: {
    bg: "#2d2a2e", fg: "#fcfcfa", dim: "#939293", comment: "#727072", red: "#ff6188", orange: "#fc9867",
    yellow: "#ffd866", green: "#a9dc76", blue: "#78dce8", purple: "#ab9df2",
    gutter: "#5b595c", gutterActive: "#c1c0c0", widget: "#403e41", border: "#221f22",
  },
  light: {
    bg: "#faf4f2", fg: "#29242a", dim: "#918c8e", comment: "#a59fa0", red: "#e14775", orange: "#e16032",
    yellow: "#cc7a0a", green: "#269d69", blue: "#1c8ca8", purple: "#7058be",
    gutter: "#bfb9ba", gutterActive: "#706b6e", widget: "#ede7e5", border: "#d3cdcc",
  },
};

function defineMonokai(name: string, base: "vs" | "vs-dark", c: (typeof MONOKAI)["dark"]) {
  const strip = (hex: string) => hex.slice(1);
  monaco.editor.defineTheme(name, {
    base,
    inherit: true,
    rules: [
      { token: "", foreground: strip(c.fg) },
      { token: "comment", foreground: strip(c.comment), fontStyle: "italic" },
      { token: "keyword", foreground: strip(c.red) },
      { token: "operator", foreground: strip(c.red) },
      { token: "delimiter", foreground: strip(c.dim) },
      { token: "string", foreground: strip(c.yellow) },
      { token: "string.escape", foreground: strip(c.purple) },
      { token: "string.key.json", foreground: strip(c.fg) },
      { token: "string.value.json", foreground: strip(c.yellow) },
      { token: "number", foreground: strip(c.purple) },
      { token: "constant", foreground: strip(c.purple) },
      { token: "regexp", foreground: strip(c.orange) },
      { token: "type", foreground: strip(c.blue), fontStyle: "italic" },
      { token: "type.identifier", foreground: strip(c.blue) },
      { token: "identifier", foreground: strip(c.fg) },
      { token: "variable", foreground: strip(c.fg) },
      { token: "variable.predefined", foreground: strip(c.purple) },
      { token: "predefined", foreground: strip(c.green) },
      { token: "annotation", foreground: strip(c.green) },
      { token: "metatag", foreground: strip(c.red) },
      { token: "tag", foreground: strip(c.red) },
      { token: "attribute.name", foreground: strip(c.blue), fontStyle: "italic" },
      { token: "attribute.value", foreground: strip(c.yellow) },
      { token: "key", foreground: strip(c.fg) },
      { token: "namespace", foreground: strip(c.fg) },
    ],
    colors: {
      "editor.background": c.bg,
      "editor.foreground": c.fg,
      "editorGutter.background": c.bg,
      "editor.lineHighlightBackground": c.fg + "0c",
      "editor.lineHighlightBorder": "#00000000",
      "editor.selectionBackground": c.gutterActive + "33",
      "editor.inactiveSelectionBackground": c.gutterActive + "1f",
      "editor.wordHighlightBackground": c.gutterActive + "26",
      "editor.findMatchBackground": c.yellow + "55",
      "editor.findMatchHighlightBackground": c.yellow + "26",
      "editorCursor.foreground": c.fg,
      "editorLineNumber.foreground": c.gutter,
      "editorLineNumber.activeForeground": c.gutterActive,
      "editorIndentGuide.background1": c.widget,
      "editorIndentGuide.activeBackground1": c.gutter,
      "editorWhitespace.foreground": c.gutter,
      "editorBracketMatch.background": c.gutter + "40",
      "editorBracketMatch.border": "#00000000",
      "editorWidget.background": c.widget,
      "editorWidget.border": c.border,
      "editorSuggestWidget.background": c.widget,
      "editorSuggestWidget.border": c.border,
      "editorSuggestWidget.selectedBackground": c.bg,
      "editorHoverWidget.background": c.widget,
      "editorHoverWidget.border": c.border,
      "editorStickyScroll.background": c.bg,
      "diffEditor.insertedTextBackground": c.green + "26",
      "diffEditor.removedTextBackground": c.red + "26",
      "diffEditor.insertedLineBackground": c.green + "14",
      "diffEditor.removedLineBackground": c.red + "14",
      "scrollbarSlider.background": c.gutter + "55",
      "scrollbarSlider.hoverBackground": c.gutter + "88",
      "scrollbarSlider.activeBackground": c.gutter + "aa",
    },
  });
}

defineMonokai("haze-dark", "vs-dark", MONOKAI.dark);
defineMonokai("haze-light", "vs", MONOKAI.light);

// Comments are dim by design, too dim on a diff block's tint. Token classes
// are numbered from the theme's colour map, so look up the comment's class
// and let a diff block lift it (`.rd-text` in DiffView, `--diff-comment`).
const diffCommentStyle = document.head.appendChild(document.createElement("style"));
const markComment = () =>
  void monaco.editor.colorize("// c", "javascript", {}).then((html) => {
    const cls = /class="(mtk\d+)/.exec(html)?.[1];
    diffCommentStyle.textContent = cls ? `.monaco-editor .rd-text.${cls} { color: var(--diff-comment); }` : "";
  });

// Theme names are global in Monaco: one setTheme repaints every editor.
monaco.editor.setTheme(monacoTheme());
markComment();
useTheme.subscribe((s) => {
  monaco.editor.setTheme(monacoTheme(s.mode));
  markComment();
});

/** Font options for a new editor; open editors follow later changes below. */
export const codeFontOptions = () => {
  const f = useFonts.getState();
  return { fontFamily: codeFontFamily(f), fontSize: f.codeSize, lineHeight: codeLineHeight(f.codeSize) };
};

// Fonts are per editor, so update every open one (diff editors list their two sides).
useFonts.subscribe((f, prev) => {
  if (f.codeFont === prev.codeFont && f.codeSize === prev.codeSize) return;
  void loadCodeFont(f).then(() => {
    monaco.editor.remeasureFonts();
    for (const ed of monaco.editor.getEditors()) ed.updateOptions(codeFontOptions());
  });
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
