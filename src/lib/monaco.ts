// Monaco setup: bundled locally (no CDN).
import * as monaco from "monaco-editor";
// Monaco's own `new URL(worker, import.meta.url)` is copied by Vite without
// its imports, so the worker (diff computation, word suggestions) would fail.
// Vite's `?worker` import bundles it properly.
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/languages/features/json/json.worker?worker";
import { csharpLanguage } from "./csharpGrammar";
import { registerShaderLanguages } from "./shaderGrammar";
import { codeFontFamily, codeLineHeight, loadCodeFont, useFonts } from "./fonts";
import { monacoTheme, useGlass, useTheme } from "./theme";
import { useWorkspace } from "../store/workspace";

// JSON is the one language service Haze keeps (see vite.config.ts); it needs
// its own worker, or every request fails with "Missing requestHandler".
(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: (_id, label) => (label === "json" ? new JsonWorker() : new EditorWorker()),
};

// Monokai Pro (Filter: Pro for dark, Filter: Light for light). Monarch only
// emits coarse token classes, so these map the filter's palette onto them.
const MONOKAI = {
  dark: {
    // Text toned down from the filter's #fcfcfa, which glares.
    bg: "#2d2a2e", fg: "#d3d1cf", dim: "#939293", comment: "#727072", red: "#ff6188", orange: "#fc9867",
    yellow: "#ffd866", green: "#a9dc76", blue: "#78dce8", purple: "#ab9df2",
    gutter: "#5b595c", gutterActive: "#c1c0c0", widget: "#403e41", border: "#221f22",
  },
  light: {
    bg: "#faf4f2", fg: "#29242a", dim: "#918c8e", comment: "#a59fa0", red: "#e14775", orange: "#e16032",
    yellow: "#cc7a0a", green: "#269d69", blue: "#1c8ca8", purple: "#7058be",
    gutter: "#bfb9ba", gutterActive: "#706b6e", widget: "#ede7e5", border: "#d3cdcc",
  },
};

function defineMonokai(name: string, base: "vs" | "vs-dark", c: (typeof MONOKAI)["dark"], glass = false) {
  const strip = (hex: string) => hex.slice(1);
  // Rainbow Brackets: one colour per nesting depth, cycling after six. Each
  // pair's guide takes its brackets' colour, faint until the caret is inside.
  const rainbow = [c.yellow, c.purple, c.blue, c.green, c.orange, c.red];
  const rainbowColors = Object.fromEntries(
    rainbow.flatMap((col, i) => [
      [`editorBracketHighlight.foreground${i + 1}`, col],
      [`editorBracketPairGuide.background${i + 1}`, col + "30"],
      [`editorBracketPairGuide.activeBackground${i + 1}`, col + "a0"],
    ]),
  );
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
      // What Monokai Pro colours by meaning: C# (csharpGrammar.ts and
      // Roslyn's semantic tokens, lsp/csharp.ts) emits these.
      { token: "type.cs", foreground: strip(c.blue), fontStyle: "" },
      { token: "method", foreground: strip(c.green) },
      { token: "parameter", foreground: strip(c.orange), fontStyle: "italic" },
      { token: "static", foreground: strip(c.purple) },
      { token: "constant.cs", foreground: strip(c.purple), fontStyle: "italic" },
      { token: "variable.cs", foreground: strip(c.fg) },
      { token: "comment.doc.tag", foreground: strip(c.gutterActive), fontStyle: "italic bold" },
      { token: "comment.doc.value", foreground: strip(c.orange), fontStyle: "italic" },
      // Shader types (float4, Texture2D, vec3) read as C#'s do (shaderGrammar.ts).
      { token: "type.hlsl", foreground: strip(c.blue), fontStyle: "" },
      { token: "type.glsl", foreground: strip(c.blue), fontStyle: "" },
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
      ...rainbowColors,
      "editorBracketHighlight.unexpectedBracket.foreground": c.red,
      // Rider's inspection colours: suggestions green, hints a dashed green; the error stripe skips hints.
      "editorError.foreground": c.red,
      "editorWarning.foreground": c.yellow,
      "editorInfo.foreground": c.green,
      "editorHint.foreground": c.green + "b0",
      "editorOverviewRuler.errorForeground": c.red + "c0",
      "editorOverviewRuler.warningForeground": c.yellow + "c0",
      "editorOverviewRuler.infoForeground": c.green + "80",
      "editorWidget.background": c.widget,
      "editorWidget.border": c.border,
      "editorSuggestWidget.background": c.widget,
      "editorSuggestWidget.border": c.border,
      "editorSuggestWidget.selectedBackground": c.bg,
      "editorHoverWidget.background": c.widget,
      "editorHoverWidget.border": c.border,
      "editorStickyScroll.background": c.bg,
      // A hairline in the theme's border colour, not Monaco's black drop shadow.
      "editorStickyScroll.border": c.border,
      "editorStickyScroll.shadow": "#00000000",
      "diffEditor.insertedTextBackground": c.green + "26",
      "diffEditor.removedTextBackground": c.red + "26",
      "diffEditor.insertedLineBackground": c.green + "14",
      "diffEditor.removedLineBackground": c.red + "14",
      "scrollbarSlider.background": c.gutter + "55",
      "scrollbarSlider.hoverBackground": c.gutter + "88",
      "scrollbarSlider.activeBackground": c.gutter + "aa",
      // Glass: the island behind shows through; sticky scroll stays nearly
      // opaque, or the lines scrolling under it would show.
      ...(glass && {
        // Clear, in the theme's own colour: what Monaco derives from it (the
        // minimap's text) does not turn towards black.
        "editor.background": c.bg + "00",
        "editorGutter.background": c.bg + "00",
        "minimap.background": c.bg + "00",
        "editorStickyScroll.background": c.bg + "f2",
        // Its line numbers: by default the editor's background, clear here.
        "editorStickyScrollGutter.background": c.bg + "f2",
      }),
    },
  });
}

defineMonokai("haze-dark", "vs-dark", MONOKAI.dark);
defineMonokai("haze-light", "vs", MONOKAI.light);
defineMonokai("haze-dark-glass", "vs-dark", MONOKAI.dark, true);
defineMonokai("haze-light-glass", "vs", MONOKAI.light, true);

// Replaces Monaco's grammar (registered tokenizers win over the lazy one;
// the language configuration still comes from Monaco).
monaco.languages.setMonarchTokensProvider("csharp", csharpLanguage);
// Shaders: Monaco has no grammar for HLSL, GLSL or ShaderLab.
registerShaderLanguages(monaco);

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
const applyTheme = () => {
  monaco.editor.setTheme(monacoTheme());
  markComment();
};
useTheme.subscribe(applyTheme);
useGlass.subscribe(applyTheme);

// automaticLayout watches with the main window's ResizeObserver, which WebKit
// runs only when the main window draws: an editor in a Commit or Diff window of
// its own did not follow that window's resizing, and stayed cut at its old size.
// Watch it from its own window too. The editors inside a diff editor follow it.
type Laid = { getContainerDomNode(): HTMLElement; layout(): void; onDidDispose(listener: () => void): monaco.IDisposable };
function followOwnWindow(ed: Laid): void {
  const el = ed.getContainerDomNode();
  const win = el.ownerDocument.defaultView as (Window & typeof globalThis) | null;
  if (!win || win === window) return;
  const ro = new win.ResizeObserver(() => ed.layout());
  ro.observe(el);
  ed.onDidDispose(() => ro.disconnect());
}
monaco.editor.onDidCreateEditor((ed) => {
  if (!ed.getContainerDomNode().closest(".monaco-diff-editor")) followOwnWindow(ed);
});
monaco.editor.onDidCreateDiffEditor(followOwnWindow);

/** Font options for a new editor; open editors follow later changes below. */
export const codeFontOptions = () => {
  const f = useFonts.getState();
  return { fontFamily: codeFontFamily(f), fontSize: f.codeSize, lineHeight: codeLineHeight(f.codeSize) };
};

// Suggestions widen to fit long member names and their details (up to the
// editor's width; a size the user dragged still wins). Monaco reads this
// option but its typings (0.57) do not declare it yet.
export const suggestOptions = { fitWidthToDetails: true } as unknown as monaco.editor.ISuggestOptions;

// Fonts are per editor, so update every open one (diff editors list their two sides).
useFonts.subscribe((f, prev) => {
  if (f.codeFont === prev.codeFont && f.codeSize === prev.codeSize) return;
  void loadCodeFont(f).then(() => {
    monaco.editor.remeasureFonts();
    for (const ed of monaco.editor.getEditors()) ed.updateOptions(codeFontOptions());
  });
});

/**
 * Rainbow brackets: brackets coloured by depth (theme colours
 * above) and, with guides on, a line per pair in the same colour in place of
 * the plain indent guides; the pair around the caret is drawn brighter.
 */
function rainbowOptions(s: { rainbowBrackets: boolean; rainbowGuides: boolean }): monaco.editor.IEditorOptions {
  const guides = s.rainbowBrackets && s.rainbowGuides;
  return {
    bracketPairColorization: { enabled: s.rainbowBrackets },
    guides: { bracketPairs: guides, bracketPairsHorizontal: guides ? "active" : false, indentation: !guides },
  };
}

// Every editor follows the setting, diff and merge sides included: Monaco
// colours brackets by default, so one left alone would ignore it.
monaco.editor.onDidCreateEditor((ed) => ed.updateOptions(rainbowOptions(useWorkspace.getState())));
useWorkspace.subscribe((s, prev) => {
  if (s.rainbowBrackets === prev.rainbowBrackets && s.rainbowGuides === prev.rainbowGuides) return;
  for (const ed of monaco.editor.getEditors()) ed.updateOptions(rainbowOptions(s));
});

// The Find widget's Close button gets no tooltip: it opened over the button
// and got in the way of clicking it. Monaco shows it on the button's own
// mouseover, so stopping the event on its way down keeps it from firing.
window.addEventListener(
  "mouseover",
  (e) => {
    if (e.target instanceof Element && e.target.closest(".find-widget .codicon-widget-close")) e.stopPropagation();
  },
  true,
);

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
  // Unity's assembly definitions and references.
  if (/\.(asmdef|asmref)$/.test(name)) return "json";
  if (/\.(csproj|fsproj|vbproj|props|targets|slnx|config|nuspec|resx|xaml|axaml)$/.test(name)) return "xml";
  if (name.endsWith(".sln")) return "ini";
  return "plaintext";
}

export { monaco };
