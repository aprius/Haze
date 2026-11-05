import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

// Parts of `monaco-editor` Haze never uses: its own LSP client (Haze has one
// in src/lib/lsp) and the TypeScript/CSS/HTML language services, whose
// workers Haze does not start (every worker is the plain editor worker).
// They cost startup parse time and ~9 MB of workers in the installer.
// Syntax highlighting for those languages comes from the basic languages.
const MONACO_UNUSED = /monaco-editor\/esm\/(external\/monaco-lsp-client\/out\/index|vs\/languages\/features\/(typescript|css|html)\/register)\.js$/;

// Editor contributions for features Haze has no provider for (inlay
// hints, linked editing) or never shows (GPU
// rendering, iPad keyboard, token inspector, high contrast toggle). Only
// Monaco's feature lists import these files.
const MONACO_CONTRIB_UNUSED = new RegExp(
  "monaco-editor/esm/vs/editor/(" +
    [
      "contrib/inlayHints/browser/inlayHintsContribution",
      "contrib/linkedEditing/browser/linkedEditing",
      "contrib/gpu/browser/gpuActions",
      "standalone/browser/(iPadShowKeyboard/iPadShowKeyboard|inspectTokens/inspectTokens|toggleHighContrast/toggleHighContrast)",
    ].join("|") +
    ")\\.js$",
);

function trimMonaco(): Plugin {
  return {
    name: "haze-trim-monaco",
    enforce: "pre",
    load(id) {
      const path = id.replace(/\\/g, "/").split("?")[0];
      if (MONACO_UNUSED.test(path) || MONACO_CONTRIB_UNUSED.test(path)) return "export {};";
    },
  };
}

// Monaco tracks focus only in the windows it knows of (`registerWindow`, which
// it does not export): in a window of its own an editor never counts as focused
// and hides its cursor. Exported here so Overlays.tsx can register Haze's windows.
// In the dependency optimizer too: `vite dev` pre-bundles Monaco without plugins.
const MONACO_DOM = /monaco-editor\/esm\/vs\/base\/browser\/dom\.js$/;
const MONACO_WINDOWS = "const { getWindow, getDocument, getWindows,";

function exposeMonacoWindows() {
  return {
    name: "haze-monaco-register-window",
    transform(code: string, id: string) {
      if (!MONACO_DOM.test(id.replace(/\\/g, "/").split("?")[0])) return;
      if (!code.includes(MONACO_WINDOWS)) throw new Error("monaco-editor's dom.js changed: update exposeMonacoWindows in vite.config.ts");
      return code.replace(MONACO_WINDOWS, "const { registerWindow, getWindow, getDocument, getWindows,") + "\nexport { registerWindow };\n";
    },
  };
}

// Monaco's colour picker has no field to type or paste a colour into (its
// header only shows the value; a click cycles rgb/hsl/hex). Add one: a row of
// its own under the header, with a hex field that applies on Enter, on blur and
// after a paste. Spliced into the header's constructor, where the model, `$`,
// `append` and `Color` are in scope. Styled in styles.css (`.haze-hex-row`).
const MONACO_PICKER_HEADER = /monaco-editor\/esm\/vs\/editor\/contrib\/colorPicker\/browser\/colorPickerParts\/colorPickerHeader\.js$/;
const PICKER_ANCHOR = "this.onDidChangeColor(this.model.color);";
const PICKER_HEX_FIELD = `
        {
            const model = this.model;
            const input = append(append(container, $('.haze-hex-row')), $('input.haze-hex'));
            input.type = 'text';
            input.spellcheck = false;
            input.placeholder = '#RRGGBB';
            input.title = 'Hex color: type or paste, then Enter';
            let dirty = false;
            const show = (c) => { if (!dirty) input.value = Color.Format.CSS.formatHexA(c, true); };
            const apply = () => {
                const text = input.value.trim();
                // parseHex reads any non-hex digit as 0, so check the digits first.
                const color = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(text) ? Color.Format.CSS.parseHex(text.startsWith('#') ? text : '#' + text) : null;
                dirty = false;
                input.classList.toggle('invalid', !color);
                if (!color) return;
                model.color = color;
                model.flushColor();
                show(color);
            };
            show(model.color);
            this._register(model.onDidChangeColor(show));
            this._register(addDisposableListener(input, 'input', () => { dirty = true; input.classList.remove('invalid'); }));
            this._register(addDisposableListener(input, 'paste', () => setTimeout(apply, 0)));
            this._register(addDisposableListener(input, 'change', apply));
            this._register(addDisposableListener(input, 'keydown', (e) => {
                if (e.key === 'Enter') apply();
                // Keys typed here are not the editor's; Escape gives it the focus back.
                e.stopPropagation();
                if (e.key === 'Escape') input.closest('.monaco-editor')?.querySelector('textarea')?.focus();
            }));
        }`;

function pickerHexField(): Plugin {
  return {
    name: "haze-monaco-picker-hex",
    transform(code: string, id: string) {
      if (!MONACO_PICKER_HEADER.test(id.replace(/\\/g, "/").split("?")[0])) return;
      if (!code.includes(PICKER_ANCHOR)) throw new Error("monaco-editor's colorPickerHeader.js changed: update pickerHexField in vite.config.ts");
      return code.replace(PICKER_ANCHOR, PICKER_ANCHOR + PICKER_HEX_FIELD);
    },
  };
}

export default defineConfig({
  plugins: [trimMonaco(), exposeMonacoWindows(), pickerHexField(), react()],
  optimizeDeps: {
    rolldownOptions: { plugins: [exposeMonacoWindows(), pickerHexField()] },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 8000,
  },
});
