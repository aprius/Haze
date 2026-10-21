// Terminal sessions live in the PTY host; this mirrors their list and routes
// host events to the xterm views.
import { create } from "zustand";
import { api, errorMessage, onPtyEvent, type AgentStatus, type PtyEvent, type SessionInfo } from "../lib/ipc";
import { useWorkspace } from "./workspace";

interface TerminalsState {
  sessions: Record<string, SessionInfo>;
  /** Terminals whose agent needs a look (waiting, finished, failed) and that you have not opened since. */
  attention: Record<string, boolean>;
  connected: boolean;
  error: string | null;
}

export const useTerminals = create<TerminalsState>(() => ({ sessions: {}, attention: {}, connected: false, error: null }));

const AGENT_NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex" };
export const agentName = (agent: string) => AGENT_NAMES[agent] ?? agent;

/** True when the user is looking at this terminal right now. */
function isWatching(id: string): boolean {
  if (!document.hasFocus()) return false;
  const ws = useWorkspace.getState();
  const project = ws.projects.find((p) => p.id === ws.activeProjectId);
  const ui = project ? ws.ui[project.id] : undefined;
  return !!ui && ui.terminalVisible && ui.bottomTab === "terminal" && ui.activeTerminal === id;
}

export function acknowledge(id: string): void {
  if (useTerminals.getState().attention[id]) {
    useTerminals.setState((s) => {
      const attention = { ...s.attention };
      delete attention[id];
      return { attention };
    });
  }
}

async function notify(title: string, body: string) {
  if (!useWorkspace.getState().notifyAgents) return;
  try {
    const n = await import("@tauri-apps/plugin-notification");
    let granted = await n.isPermissionGranted();
    if (!granted) granted = (await n.requestPermission()) === "granted";
    if (granted) n.sendNotification({ title, body });
  } catch (e) {
    console.warn("notification failed", e);
  }
}

function onAgent(id: string, status: AgentStatus | null) {
  const prev = useTerminals.getState().sessions[id];
  if (!prev) return;
  useTerminals.setState((s) => ({ sessions: { ...s.sessions, [id]: { ...prev, agent: status } } }));
  if (!status || prev.agent?.state === status.state) return;
  const needsLook = status.state === "waiting" || status.state === "done" || status.state === "error";
  if (!needsLook || isWatching(id)) return;
  useTerminals.setState((s) => ({ attention: { ...s.attention, [id]: true } }));
  const project = useWorkspace.getState().projects.find((p) => p.id === prev.projectId);
  const what = status.state === "waiting" ? "needs your input" : status.state === "done" ? "finished" : "stopped with an error";
  void notify(`${agentName(status.agent)} ${what}`, [project?.name, prev.title, status.message].filter(Boolean).join(" · "));
}

// Looking at a terminal acknowledges it.
if (typeof window !== "undefined") {
  window.addEventListener("focus", () => {
    for (const id of Object.keys(useTerminals.getState().attention)) if (isWatching(id)) acknowledge(id);
  });
}

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
    if (e.t === "agent") {
      onAgent(e.id, e.status);
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
  // Switching to a terminal (or showing the panel) acknowledges its agent.
  useWorkspace.subscribe(() => {
    for (const id of Object.keys(useTerminals.getState().attention)) if (isWatching(id)) acknowledge(id);
  });
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
      // Opened from the tree or a run configuration while Build or Git is showing.
      bottomTab: "terminal",
    }));
    return info.id;
  } catch (e) {
    useTerminals.setState({ error: errorMessage(e) });
    return null;
  }
}

/** Those of `ids` running a program, not just a shell at its prompt (asked fresh from the host). */
export async function busyTerminals(ids: string[]): Promise<string[]> {
  const fresh = await api.ptyList().catch(() => null);
  const byId = new Map((fresh ?? Object.values(useTerminals.getState().sessions)).map((s) => [s.id, s]));
  // An older host does not tell: then anything still running counts.
  return ids.filter((id) => {
    const s = byId.get(id);
    return !!s && (s.busy ?? s.running);
  });
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
