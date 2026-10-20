// Terminal sessions live in the PTY host; this mirrors their list and routes
// host events to the xterm views.
import { create } from "zustand";
import { api, errorMessage, onPtyEvent, type PtyEvent, type SessionInfo } from "../lib/ipc";
import { useWorkspace } from "./workspace";

interface TerminalsState {
  sessions: Record<string, SessionInfo>;
  connected: boolean;
  error: string | null;
}

export const useTerminals = create<TerminalsState>(() => ({ sessions: {}, connected: false, error: null }));

type Handler = (e: PtyEvent) => void;
const handlers = new Map<string, Handler>();

export function subscribeSession(id: string, h: Handler): () => void {
  handlers.set(id, h);
  return () => {
    if (handlers.get(id) === h) handlers.delete(id);
  };
}

let started = false;
let markListening: () => void;
/** Resolves once host events are being received; attaching earlier would lose the replay. */
export const terminalsListening = new Promise<void>((r) => (markListening = r));

export async function startTerminals(): Promise<void> {
  if (started) return;
  started = true;
  await onPtyEvent((e) => {
    if (e.t === "disconnected") {
      useTerminals.setState({ connected: false, error: "Terminal host disconnected" });
      handlers.forEach((h) => h(e));
      return;
    }
    if (e.t === "exit") {
      useTerminals.setState((s) => {
        const cur = s.sessions[e.id];
        return cur ? { sessions: { ...s.sessions, [e.id]: { ...cur, running: false, exitCode: e.code } } } : {};
      });
    }
    handlers.get(e.id)?.(e);
  });
  markListening();
  await syncSessions();
}

/** Reconciles the session list with the host and each project's tab order. */
export async function syncSessions(): Promise<void> {
  let list: SessionInfo[];
  try {
    list = await api.ptyList();
  } catch (e) {
    useTerminals.setState({ connected: false, error: errorMessage(e) });
    return;
  }
  const sessions = Object.fromEntries(list.map((s) => [s.id, s]));
  useTerminals.setState({ sessions, connected: true, error: null });
  const ws = useWorkspace.getState();
  for (const p of ws.projects) {
    const ui = ws.ui[p.id];
    if (!ui) continue;
    const mine = list.filter((s) => s.projectId === p.id).map((s) => s.id);
    const order = [...ui.terminalOrder.filter((id) => sessions[id]), ...mine.filter((id) => !ui.terminalOrder.includes(id))];
    const active = ui.activeTerminal && sessions[ui.activeTerminal] ? ui.activeTerminal : (order[0] ?? null);
    if (order.join() !== ui.terminalOrder.join() || active !== ui.activeTerminal) {
      ws.updateUi(p.id, { terminalOrder: order, activeTerminal: active });
    }
  }
}

export async function newTerminal(
  projectId: string,
  cwd: string,
  opts: { title?: string; command?: string[] } = {},
): Promise<string | null> {
  try {
    const info = await api.ptyCreate({
      projectId,
      cwd,
      cols: 120,
      rows: 30,
      title: opts.title ?? null,
      command: opts.command ?? null,
      env: [],
    });
    useTerminals.setState((s) => ({ sessions: { ...s.sessions, [info.id]: info }, connected: true, error: null }));
    useWorkspace.getState().updateUi(projectId, (ui) => ({
      terminalOrder: [...ui.terminalOrder, info.id],
      activeTerminal: info.id,
      terminalVisible: true,
    }));
    return info.id;
  } catch (e) {
    useTerminals.setState({ error: errorMessage(e) });
    return null;
  }
}

export async function closeTerminal(projectId: string, id: string): Promise<void> {
  try {
    await api.ptyClose(id);
  } catch (e) {
    console.warn("closing terminal failed", e);
  }
  useTerminals.setState((s) => {
    const sessions = { ...s.sessions };
    delete sessions[id];
    return { sessions };
  });
  useWorkspace.getState().updateUi(projectId, (ui) => {
    const idx = ui.terminalOrder.indexOf(id);
    const order = ui.terminalOrder.filter((t) => t !== id);
    const active =
      ui.activeTerminal === id ? (order[Math.max(0, Math.min(idx - 1, order.length - 1))] ?? null) : ui.activeTerminal;
    return { terminalOrder: order, activeTerminal: active };
  });
}
