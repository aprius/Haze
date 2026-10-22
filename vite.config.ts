import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

// Parts of `monaco-editor` Haze never uses: its own LSP client (Haze has one
// in src/lib/lsp) and the TypeScript/CSS/HTML language services, whose
// workers Haze does not start (every worker is the plain editor worker).
// They cost startup parse time and ~9 MB of workers in the installer.
// Syntax highlighting for those languages comes from the basic languages.
const MONACO_UNUSED = /monaco-editor\/esm\/(external\/monaco-lsp-client\/out\/index|vs\/languages\/features\/(typescript|css|html)\/register)\.js$/;

// Editor contributions for features Haze has no provider for (colors, inlay
// hints, linked editing) or never shows (GPU
// rendering, iPad keyboard, token inspector, high contrast toggle). Only
// Monaco's feature lists import these files.
const MONACO_CONTRIB_UNUSED = new RegExp(
  "monaco-editor/esm/vs/editor/(" +
    [
      "contrib/colorPicker/browser/colorPickerContribution",
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

export default defineConfig({
  plugins: [trimMonaco(), react()],
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
