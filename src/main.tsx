import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "@fontsource/inter/400.css";
import "@fontsource/inter/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/400-italic.css";
import "@fontsource/jetbrains-mono/700.css";
import "./styles.css";
// Sets <html data-theme> before the first render.
import "./lib/theme";
// Applies the saved UI and code fonts.
import { loadCodeFont } from "./lib/fonts";
// Restores the saved zoom and listens for Ctrl+wheel.
import "./lib/zoom";

// Native-feeling: no browser context menu except in text inputs.
window.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement;
  if (!t.closest("input, textarea, .monaco-editor")) e.preventDefault();
});

// Ctrl+A outside text fields would select the whole UI.
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
    const t = e.target as HTMLElement;
    if (!t.closest("input, textarea, .monaco-editor, .xterm, .markdown-body")) e.preventDefault();
  }
});

// The terminal and editors measure glyphs once when created; load the bundled
// font first so they do not measure the fallback.
void loadCodeFont().then(() =>
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <App />
      </StrictMode>,
    ),
  );
