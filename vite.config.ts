import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

// Parts of `monaco-editor` Haze never uses: its own LSP client (Haze has one
// in src/lib/lsp) and the TypeScript/CSS/HTML language services, whose
// workers Haze does not start (every worker is the plain editor worker).
// They cost startup parse time and ~9 MB of workers in the installer.
// Syntax highlighting for those languages comes from the basic languages.
const MONACO_UNUSED = /monaco-editor\/esm\/(external\/monaco-lsp-client\/out\/index|vs\/languages\/features\/(typescript|css|html)\/register)\.js$/;

function trimMonaco(): Plugin {
  return {
    name: "haze-trim-monaco",
    enforce: "pre",
    load(id) {
      if (MONACO_UNUSED.test(id.replace(/\\/g, "/").split("?")[0])) return "export {};";
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
