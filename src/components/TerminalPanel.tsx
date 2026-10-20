import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type ILink } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { ChevronDown, ChevronUp, Plus, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/ipc";
import { findPathCandidates } from "../lib/termLinks";
import { closeTerminal, newTerminal, subscribeSession, syncSessions, terminalsListening, useTerminals } from "../store/terminals";
import { useWorkspace, type Project } from "../store/workspace";
import { confirmAction, openMenu } from "./Overlays";

// xterm instances outlive React mounts so switching tabs or projects keeps
// their screen and scrollback.
interface View {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  el: HTMLDivElement;
  ready: boolean;
  lastSize: string;
}
const views = new Map<string, View>();

function themeColors() {
  const css = getComputedStyle(document.documentElement);
  const v = (n: string) => css.getPropertyValue(n).trim();
  return {
    background: v("--term-bg"),
    foreground: v("--term-fg"),
    cursor: v("--accent"),
    selectionBackground: v("--term-selection"),
  };
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
    fontFamily: 'JetBrains Mono, "Cascadia Mono", Menlo, Consolas, monospace',
    fontSize: 13,
    lineHeight: 1.15,
    scrollback: 10000,
    allowProposedApi: true,
    cursorBlink: true,
    theme: themeColors(),
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  term.open(el);
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch {
    // Falls back to the DOM renderer.
  }

  const view: View = { term, fit, search, el, ready: false, lastSize: "" };

  term.onData((data) => void api.ptyWrite(id, data).catch(() => {}));
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
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
    // Leave app shortcuts (Alt+F12, Alt+1, Ctrl+Tab...) to the window handler.
    if ((e.altKey && (e.key === "F12" || e.key === "1")) || (e.ctrlKey && e.key === "Tab")) return false;
    return true;
  });

  const cache = new Map<string, string | null>();
  term.registerLinkProvider({
    provideLinks(y, callback) {
      const line = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
      const matches = findPathCandidates(line);
      if (!matches.length) return callback(undefined);
      const session = useTerminals.getState().sessions[id];
      const cwd = session?.cwd ?? project.path;
      const unknown = [...new Set(matches.map((m) => m.path).filter((p) => !cache.has(p)))];
      const resolveAll = unknown.length
        ? api.resolvePaths(cwd, unknown).then((r) => unknown.forEach((p, i) => cache.set(p, r[i])))
        : Promise.resolve();
      resolveAll
        .then(() => {
          const links: ILink[] = [];
          for (const m of matches) {
            const resolved = cache.get(m.path);
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
      term.write(decode(e.data));
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
    return () => ro.disconnect();
  }, [id, project]);

  useEffect(() => {
    const v = views.get(id);
    if (active && v) {
      requestAnimationFrame(() => {
        try {
          v.fit.fit();
        } catch {
          /* hidden */
        }
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

/** Switches the bottom panel between tool windows (Terminal, Build). */
export function ToolTabs({ project }: { project: Project }) {
  const tab = useWorkspace((s) => s.ui[project.id]?.bottomTab ?? "terminal");
  const set = (bottomTab: "terminal" | "build" | "git") => useWorkspace.getState().updateUi(project.id, { bottomTab });
  return (
    <div className="tool-tabs">
      <button className={"tool-tab" + (tab === "terminal" ? " active" : "")} onClick={() => set("terminal")}>
        Terminal
      </button>
      <button className={"tool-tab" + (tab === "build" ? " active" : "")} onClick={() => set("build")}>
        Build
      </button>
      <button className={"tool-tab" + (tab === "git" ? " active" : "")} onClick={() => set("git")} title="Git (Alt+9)">
        Git
      </button>
    </div>
  );
}

export function TerminalPanel({ project }: { project: Project }) {
  const ui = useWorkspace((s) => s.ui[project.id]);
  const updateUi = useWorkspace((s) => s.updateUi);
  const sessions = useTerminals((s) => s.sessions);
  const error = useTerminals((s) => s.error);
  const connected = useTerminals((s) => s.connected);
  const [searching, setSearching] = useState(false);
  const order = ui?.terminalOrder ?? [];
  const active = ui?.activeTerminal ?? null;

  useEffect(() => {
    if (ui?.terminalVisible && ui.bottomTab === "terminal" && order.length === 0 && connected) void newTerminal(project.id, project.path);
    // Only when the panel is shown empty.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ui?.terminalVisible, ui?.bottomTab, order.length === 0, connected]);

  useEffect(() => {
    const onFind = () => setSearching(true);
    window.addEventListener("haze:terminal-find", onFind);
    return () => window.removeEventListener("haze:terminal-find", onFind);
  }, []);

  const close = async (id: string) => {
    const s = sessions[id];
    if (s?.running && !(await confirmAction("Close terminal", `"${s.title}" is still running. Terminate it?`, "Terminate", true)))
      return;
    disposeView(id);
    await closeTerminal(project.id, id);
  };

  return (
    <div className="terminal-panel">
      <div className="panel-header">
        <ToolTabs project={project} />
        <div className="term-tabs">
          {order.map((id) => {
            const s = sessions[id];
            return (
              <div
                key={id}
                className={"term-tab" + (id === active ? " active" : "")}
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
                title={s ? `${s.title} — ${s.cwd}` : id}
              >
                <span className={"dot" + (s?.running ? " running" : "")} />
                <span className="term-tab-title">{s?.title ?? "Terminal"}</span>
                <button
                  className="tab-close"
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
          <button className="icon-btn" title="Hide (Alt+F12)" onClick={() => updateUi(project.id, { terminalVisible: false })}>
            <ChevronDown size={14} />
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
