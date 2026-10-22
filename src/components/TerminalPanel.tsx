import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type ILink } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { ChevronDown, ChevronRight, ChevronUp, Plus, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { codeFontFamily, loadCodeFont, useFonts } from "../lib/fonts";
import { api } from "../lib/ipc";
import { matches, shortcutLabel } from "../lib/keymap";
import { findPathCandidates, parseOscCwd } from "../lib/termLinks";
import { TERMINAL_THEMES, useTheme } from "../lib/theme";
import { agentBadge, agentName, closeTerminal, newTerminal, subscribeSession, syncSessions, terminalsListening, useTerminals } from "../store/terminals";
import { popupClosed } from "../store/ui";
import { useWorkspace, type Project } from "../store/workspace";
import { openMenu } from "./Overlays";

// xterm instances outlive React mounts so switching tabs or projects keeps
// their screen and scrollback.
interface View {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  /** Null while the DOM renderer draws (WebGL is off or its context was lost). */
  webgl: WebglAddon | null;
  el: HTMLDivElement;
  ready: boolean;
  /** The size last sent to the PTY, as `colsxrows`. */
  lastSize: string;
  /** Fits to the panel and tells the PTY, while the view is mounted. */
  refit: (() => void) | null;
  /** Directory the shell last reported (OSC 7 / OSC 9;9), if it does. */
  cwd: string | null;
}
const views = new Map<string, View>();

// Recolour every terminal, including ones in hidden projects, on a mode switch.
useTheme.subscribe((t) => {
  for (const v of views.values()) v.term.options.theme = TERMINAL_THEMES[t.mode];
});

// The terminal uses the code font family at its own size and line height.
// Shown terminals refit to the new cell size (see TerminalView); hidden ones
// refit when shown.
useFonts.subscribe((f, prev) => {
  if (f.terminalWebgl !== prev.terminalWebgl) for (const v of views.values()) setWebgl(v, f.terminalWebgl);
  if (f.codeFont === prev.codeFont && f.terminalSize === prev.terminalSize && f.terminalLineHeight === prev.terminalLineHeight) return;
  void loadCodeFont(f).then(() => {
    for (const v of views.values()) {
      v.term.options.fontFamily = codeFontFamily(f);
      v.term.options.fontSize = f.terminalSize;
      v.term.options.lineHeight = f.terminalLineHeight;
    }
    fontListeners.forEach((l) => l());
  });
});
const fontListeners = new Set<() => void>();

function setWebgl(v: View, on: boolean): void {
  if (!on) {
    v.webgl?.dispose();
    v.webgl = null;
    return;
  }
  if (v.webgl) return;
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      webgl.dispose();
      if (v.webgl === webgl) v.webgl = null;
    });
    v.term.loadAddon(webgl);
    v.webgl = webgl;
  } catch {
    // Falls back to the DOM renderer.
  }
}

/** A keydown that inserts text, as opposed to Enter, arrows, shortcuts or IME composition. */
function isTextKey(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || e.keyCode === 229) return false;
  if (e.key === "Dead" || e.key === "Process" || e.key === "Unidentified") return false;
  // Named keys ("Enter", "F5") are ASCII words; injected text arrives on a letter key.
  return [...e.key].length === 1 || /^(Key[A-Z]|Digit\d)$/.test(e.code) || !/^[A-Z][A-Za-z0-9]*$/.test(e.key);
}

function decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function createView(id: string, project: Project): View {
  const el = document.createElement("div");
  el.className = "xterm-host";
  const term = new Terminal({
    fontFamily: codeFontFamily(),
    fontSize: useFonts.getState().terminalSize,
    lineHeight: useFonts.getState().terminalLineHeight,
    scrollback: 10000,
    allowProposedApi: true,
    cursorBlink: true,
    theme: TERMINAL_THEMES[useTheme.getState().mode],
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  term.open(el);

  const view: View = { term, fit, search, webgl: null, el, ready: false, lastSize: "", refit: null, cwd: null };
  setWebgl(view, useFonts.getState().terminalWebgl);
  // Shells that report their directory make links right after `cd` even where
  // the OS does not tell (Windows).
  term.parser.registerOscHandler(7, (data) => {
    view.cwd = parseOscCwd(7, data) ?? view.cwd;
    return true;
  });
  term.parser.registerOscHandler(9, (data) => {
    const cwd = parseOscCwd(9, data);
    if (cwd) view.cwd = cwd;
    return !!cwd;
  });

  // One write in flight at a time: a Vietnamese input method fixes a word with
  // a burst of backspaces then the new text, and the shell must get them in order.
  let pending = "";
  let writing = false;
  const flush = () => {
    if (writing || !pending) return;
    const data = pending;
    pending = "";
    writing = true;
    void api
      .ptyWrite(id, data)
      .catch(() => {})
      .finally(() => {
        writing = false;
        flush();
      });
  };
  term.onData((data) => {
    pending += data;
    flush();
  });

  // Input methods that type by injecting key events (Gõ Nhanh, EVKey, OpenKey)
  // send several characters in one event, but xterm takes text from keydown or
  // keypress, which hold one, and then stops the rest. Text keys are left to
  // the browser and sent from the input event, which carries all of it.
  let typing = false;
  term.textarea?.addEventListener("input", (e) => {
    const ev = e as InputEvent;
    if (!typing || ev.isComposing) return;
    typing = false;
    if (ev.inputType === "insertText" && ev.data) term.input(ev.data);
    term.textarea!.value = "";
  });
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === "keypress") return !typing;
    if (e.type !== "keydown") {
      typing = false;
      return true;
    }
    typing = false;
    const mod = e.ctrlKey || e.metaKey;
    // Copy with Ctrl+C only when there is a selection; otherwise send SIGINT.
    if (mod && !e.shiftKey && e.key.toLowerCase() === "c" && term.hasSelection()) {
      void navigator.clipboard.writeText(term.getSelection());
      term.clearSelection();
      return false;
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === "c") {
      void navigator.clipboard.writeText(term.getSelection());
      return false;
    }
    if (mod && !e.shiftKey && e.key.toLowerCase() === "f") {
      window.dispatchEvent(new CustomEvent("haze:terminal-find"));
      return false;
    }
    // Leave app shortcuts (Alt+1, Ctrl+Tab...) to the window handler.
    if ((["projectView", "closeTab", "nextTab", "previousTab"] as const).some((c) => matches(e, c))) return false;
    typing = isTextKey(e);
    return !typing;
  });

  // Only absolute paths are cached: relative ones depend on the directory the shell is in now.
  const cache = new Map<string, string | null>();
  const absolute = (p: string) => /^([\\/~]|[A-Za-z]:[\\/])/.test(p);
  term.registerLinkProvider({
    provideLinks(y, callback) {
      const line = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
      const matches = findPathCandidates(line);
      if (!matches.length) return callback(undefined);
      const session = useTerminals.getState().sessions[id];
      const cwds = [view.cwd, session?.cwd ?? project.path].filter((c): c is string => !!c);
      const found = new Map<string, string | null>();
      const unknown = [...new Set(matches.map((m) => m.path))].filter((p) => {
        if (!cache.has(p)) return true;
        found.set(p, cache.get(p)!);
        return false;
      });
      const resolveAll = unknown.length
        ? api.resolvePaths(cwds, session?.pid ?? null, unknown).then((r) =>
            unknown.forEach((p, i) => {
              found.set(p, r[i]);
              if (absolute(p)) cache.set(p, r[i]);
            }),
          )
        : Promise.resolve();
      resolveAll
        .then(() => {
          const links: ILink[] = [];
          for (const m of matches) {
            const resolved = found.get(m.path);
            if (!resolved) continue;
            links.push({
              range: { start: { x: m.index + 1, y }, end: { x: m.index + m.text.length, y } },
              text: m.text,
              decorations: { underline: true, pointerCursor: true },
              activate(event) {
                if (!(event.ctrlKey || event.metaKey)) return;
                useWorkspace.getState().openFile(project.id, resolved, { line: m.line, column: m.column });
              },
            });
          }
          callback(links.length ? links : undefined);
        })
        .catch(() => callback(undefined));
    },
  });

  subscribeSession(id, (e) => {
    if (e.t === "snapshot") {
      term.reset();
      // Replay at the size the output was drawn for: a hidden terminal is
      // still 80x24, and cursor moves at another width overlap the text.
      // Then fit, and a program that draws the whole screen redraws on resize.
      if (e.size) {
        const [cols, rows] = e.size;
        term.resize(cols, rows);
        view.lastSize = `${cols}x${rows}`;
      }
      term.write(decode(e.data), () => view.refit?.());
      view.ready = true;
    } else if (e.t === "output") {
      if (view.ready) term.write(decode(e.data));
    } else if (e.t === "exit") {
      term.write(`\r\n\x1b[2m[Process exited${e.code != null ? ` with code ${e.code}` : ""}]\x1b[0m\r\n`);
    } else if (e.t === "disconnected") {
      view.ready = false;
    }
  });
  void terminalsListening.then(() => api.ptyAttach(id)).catch(() => {});
  return view;
}

/**
 * Alt+F12, like Rider: shows the Terminal tool window and focuses it; pressed
 * inside the terminal it hides it. `hideOnlyWhenFocused: false` (the status
 * bar button) hides it whenever it is showing.
 */
export function toggleTerminal(projectId: string, hideOnlyWhenFocused = true): void {
  const ws = useWorkspace.getState();
  const ui = ws.ui[projectId];
  const shown = !!ui?.terminalVisible;
  const focused = !!(document.activeElement as HTMLElement | null)?.closest(".terminal-panel");
  if (shown && (focused || !hideOnlyWhenFocused)) {
    ws.updateUi(projectId, { terminalVisible: false });
    popupClosed();
    return;
  }
  ws.updateUi(projectId, { terminalVisible: true });
  requestAnimationFrame(() => {
    const id = useWorkspace.getState().ui[projectId]?.activeTerminal;
    if (id) views.get(id)?.term.focus();
  });
}

export function disposeView(id: string): void {
  const v = views.get(id);
  if (!v) return;
  v.term.dispose();
  v.el.remove();
  views.delete(id);
}

function TerminalView({ id, project, active }: { id: string; project: Project; active: boolean }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let view = views.get(id);
    if (!view) {
      view = createView(id, project);
      views.set(id, view);
    }
    host.current?.appendChild(view.el);
    const v = view;
    const fit = () => {
      if (!host.current || host.current.offsetParent === null) return;
      try {
        v.fit.fit();
      } catch {
        return;
      }
      const size = `${v.term.cols}x${v.term.rows}`;
      if (size !== v.lastSize) {
        v.lastSize = size;
        void api.ptyResize(id, v.term.cols, v.term.rows).catch(() => {});
      }
    };
    const ro = new ResizeObserver(fit);
    if (host.current) ro.observe(host.current);
    fit();
    fontListeners.add(fit);
    v.refit = fit;
    return () => {
      ro.disconnect();
      fontListeners.delete(fit);
      if (v.refit === fit) v.refit = null;
    };
  }, [id, project]);

  useEffect(() => {
    const v = views.get(id);
    if (active && v) {
      requestAnimationFrame(() => {
        v.refit?.();
        v.term.focus();
      });
    }
  }, [active, id]);

  return <div ref={host} className="terminal-view" style={{ display: active ? "block" : "none" }} />;
}

function SearchBar({ id, onClose }: { id: string; onClose: () => void }) {
  const [q, setQ] = useState("");
  const view = views.get(id);
  const opts = { caseSensitive: false, decorations: undefined };
  return (
    <div className="term-search">
      <input
        autoFocus
        value={q}
        placeholder="Find in terminal"
        onChange={(e) => {
          setQ(e.target.value);
          view?.search.findNext(e.target.value, { ...opts, incremental: true });
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            if (e.shiftKey) view?.search.findPrevious(q, opts);
            else view?.search.findNext(q, opts);
          }
          if (e.key === "Escape") {
            view?.search.clearDecorations();
            onClose();
            view?.term.focus();
          }
        }}
      />
      <button className="icon-btn" title="Previous (Shift+Enter)" onClick={() => view?.search.findPrevious(q, opts)}>
        <ChevronUp size={14} />
      </button>
      <button className="icon-btn" title="Next (Enter)" onClick={() => view?.search.findNext(q, opts)}>
        <ChevronDown size={14} />
      </button>
      <button className="icon-btn" title="Close (Esc)" onClick={onClose}>
        <X size={14} />
      </button>
    </div>
  );
}

/** A session's directory relative to the project, for its tab's tooltip. */
function shortCwd(cwd: string, root: string): string {
  const c = cwd.replace(/[\\/]+$/, "");
  const r = root.replace(/[\\/]+$/, "");
  if (c === r) return r.split(/[\\/]/).pop() ?? c;
  if (c.startsWith(r + "/") || c.startsWith(r + "\\")) return c.slice(r.length + 1);
  return c;
}

export function TerminalPanel({ project }: { project: Project }) {
  const ui = useWorkspace((s) => s.ui[project.id]);
  const updateUi = useWorkspace((s) => s.updateUi);
  const sessions = useTerminals((s) => s.sessions);
  const attention = useTerminals((s) => s.attention);
  const error = useTerminals((s) => s.error);
  const connected = useTerminals((s) => s.connected);
  const [searching, setSearching] = useState(false);
  const order = ui?.terminalOrder ?? [];
  const active = ui?.activeTerminal ?? null;

  useEffect(() => {
    if (ui?.terminalVisible && order.length === 0 && connected) void newTerminal(project.id, project.path);
    // Only when the panel is shown empty.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ui?.terminalVisible, order.length === 0, connected]);

  useEffect(() => {
    const onFind = () => setSearching(true);
    window.addEventListener("haze:terminal-find", onFind);
    return () => window.removeEventListener("haze:terminal-find", onFind);
  }, []);

  const close = async (id: string) => {
    disposeView(id);
    await closeTerminal(project.id, id);
  };

  return (
    <div className="terminal-panel">
      <div className="panel-header term-header">
        <div className="term-tabs">
          {order.map((id) => {
            const s = sessions[id];
            return (
              <div
                key={id}
                className={"term-tab" + (id === active ? " active" : "") + (s && !s.running ? " exited" : "")}
                onMouseDown={(e) => {
                  if (e.button === 1) {
                    e.preventDefault();
                    void close(id);
                  }
                }}
                onClick={() => updateUi(project.id, { activeTerminal: id })}
                onContextMenu={(e) => {
                  e.preventDefault();
                  openMenu(e, [
                    { label: "New Terminal", action: () => void newTerminal(project.id, project.path) },
                    { label: "Clear", action: () => views.get(id)?.term.clear() },
                    { separator: true },
                    { label: "Close", action: () => void close(id) },
                  ]);
                }}
                title={s ? `${s.title} — ${shortCwd(s.cwd, project.path)}${s.agent?.message ? `\n${s.agent.message}` : ""}` : id}
              >
                {s?.agent ? (
                  <span
                    className={"agent-state " + s.agent.state + (attention[id] ? " attention" : "")}
                    title={`${agentName(s.agent.agent)}: ${s.agent.state}${s.agent.message ? ` — ${s.agent.message}` : ""}`}
                  >
                    {agentBadge(s.agent.agent)}
                  </span>
                ) : (
                  <span className={"dot" + (s?.running ? " running" : "")} />
                )}
                <span className="term-tab-title">{s?.title ?? "Terminal"}</span>
                <button
                  className="tab-close"
                  title="Close"
                  onClick={(e) => {
                    e.stopPropagation();
                    void close(id);
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
          <button className="icon-btn" title="New terminal" onClick={() => void newTerminal(project.id, project.path)}>
            <Plus size={14} />
          </button>
        </div>
        <div className="panel-actions">
          <button className="icon-btn" title="Find (Ctrl+F)" onClick={() => setSearching((v) => !v)}>
            <Search size={14} />
          </button>
          <button className="icon-btn" title={`Hide (${shortcutLabel("terminal")})`} onClick={() => updateUi(project.id, { terminalVisible: false })}>
            <ChevronRight size={14} />
          </button>
        </div>
      </div>
      {!connected && error && (
        <div className="banner warn">
          {error}
          <button
            className="btn small"
            onClick={async () => {
              await syncSessions();
              const alive = useTerminals.getState().sessions;
              for (const id of [...views.keys()]) {
                if (alive[id]) void api.ptyAttach(id).catch(() => {});
                else disposeView(id);
              }
            }}
          >
            Reconnect
          </button>
        </div>
      )}
      {searching && active && <SearchBar id={active} onClose={() => setSearching(false)} />}
      <div className="terminal-body">
        {order.map((id) => (
          <TerminalView key={id} id={id} project={project} active={id === active} />
        ))}
      </div>
    </div>
  );
}
