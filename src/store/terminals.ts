// Terminal sessions live in the PTY host; this mirrors their list and routes
// host events to the xterm views.
import { create } from "zustand";
import { api, errorMessage, onPtyEvent, type AgentStatus, type PtyEvent, type SessionInfo } from "../lib/ipc";
import { useTheme } from "../lib/theme";
import { projectForPath, useWorkspace } from "./workspace";

interface TerminalsState {
  sessions: Record<string, SessionInfo>;
  /** Terminals whose agent needs a look (waiting, finished, failed) and that you have not opened since. */
  attention: Record<string, boolean>;
  connected: boolean;
  error: string | null;
}

export const useTerminals = create<TerminalsState>(() => ({ sessions: {}, attention: {}, connected: false, error: null }));

const AGENT_NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex", gemini: "Gemini CLI", opencode: "OpenCode", agent: "Agent" };
export const agentName = (agent: string) => AGENT_NAMES[agent] ?? agent;

const AGENT_BADGES: Record<string, string> = { claude: "CC", codex: "CX", gemini: "GM", opencode: "OC" };
/** Two letters for a terminal tab's agent badge. */
export const agentBadge = (agent: string) => AGENT_BADGES[agent] ?? (agent === "agent" ? "AI" : agent.slice(0, 2).toUpperCase());

/** The turn ended but a check its hooks run (`haze report`) is not finished: the agent may go on to fix what it finds. */
export const isChecking = (a: AgentStatus | null | undefined): boolean =>
  a?.state === "done" && !!a.checks?.some((c) => c.state === "running");

/** The state a badge shows: "done" stays "working" while the turn's checks run. */
export const shownState = (a: AgentStatus): AgentStatus["state"] => (isChecking(a) ? "working" : a.state);

export const failedChecks = (a: AgentStatus | null | undefined) => a?.checks?.filter((c) => c.state === "fail") ?? [];

/** One line per check, for tooltips. */
export const checkLines = (a: AgentStatus): string[] =>
  (a.checks ?? []).map((c) => `${c.state === "ok" ? "✓" : c.state === "fail" ? "✗" : "…"} ${c.name}${c.summary ? ` — ${c.summary}` : ""}`);

/** Worth a look: waiting for you, failed, or done with its checks finished. */
export const needsLook = (a: AgentStatus | null | undefined): boolean =>
  !!a && (a.state === "waiting" || a.state === "error" || (a.state === "done" && !isChecking(a)));

/** True when the user is looking at this terminal right now. */
function isWatching(id: string): boolean {
  if (!document.hasFocus()) return false;
  const ws = useWorkspace.getState();
  const project = ws.projects.find((p) => p.id === ws.activeProjectId);
  const ui = project ? ws.ui[project.id] : undefined;
  return !!ui && ui.terminalVisible && ui.activeTerminal === id;
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

/**
 * How long "done" waits before it is announced: a hook that checks the turn
 * (compile, lint) starts beside Haze's own and reports a moment later.
 */
const DONE_GRACE_MS = 2000;
const pendingDone = new Map<string, ReturnType<typeof setTimeout>>();

function cancelDone(id: string) {
  clearTimeout(pendingDone.get(id));
  pendingDone.delete(id);
}

function onAgent(id: string, status: AgentStatus | null) {
  const prev = useTerminals.getState().sessions[id];
  if (!prev) return;
  useTerminals.setState((s) => ({ sessions: { ...s.sessions, [id]: { ...prev, agent: status } } }));
  if (!status || !needsLook(status)) return cancelDone(id);
  // A check finishing on a turn already announced (or about to be) is not news.
  if (needsLook(prev.agent) && prev.agent?.state === status.state) return;
  if (status.state !== "done") return announce(id);
  cancelDone(id);
  pendingDone.set(
    id,
    setTimeout(() => {
      pendingDone.delete(id);
      if (useTerminals.getState().sessions[id]?.agent?.state === "done") announce(id);
    }, DONE_GRACE_MS),
  );
}

/** Marks a terminal for a look and notifies, unless the user is looking at it. */
function announce(id: string) {
  const session = useTerminals.getState().sessions[id];
  const status = session?.agent;
  if (!status || !needsLook(status) || isWatching(id)) return;
  useTerminals.setState((s) => ({ attention: { ...s.attention, [id]: true } }));
  const project = useWorkspace.getState().projects.find((p) => p.id === session.projectId);
  const failed = failedChecks(status);
  const what =
    status.state === "waiting"
      ? "needs your input"
      : status.state === "error"
        ? "stopped with an error"
        : failed.length
          ? "finished, checks failed"
          : "finished";
  const checks = failed.map((c) => (c.summary ? `${c.name}: ${c.summary}` : c.name)).join(", ");
  void notify(`${agentName(status.agent)} ${what}`, [project?.name, session.title, status.message, checks].filter(Boolean).join(" · "));
}

// Looking at a terminal acknowledges it.
if (typeof window !== "undefined") {
  window.addEventListener("focus", () => {
    for (const id of Object.keys(useTerminals.getState().attention)) if (isWatching(id)) acknowledge(id);
  });
}

/**
 * What to do with terminal views when the session list changes: drop those
 * whose session the host no longer has, and attach again those a disconnect
 * cut off once it is back (`wasConnected` false). Nothing while disconnected:
 * the list is not known then.
 */
export function reconcileViews(
  views: { id: string; detached: boolean }[],
  state: { connected: boolean; sessions: Record<string, unknown> },
  wasConnected: boolean,
): { dispose: string[]; attach: string[] } {
  if (!state.connected) return { dispose: [], attach: [] };
  return {
    dispose: views.filter((v) => !state.sessions[v.id]).map((v) => v.id),
    attach: wasConnected ? [] : views.filter((v) => v.detached && state.sessions[v.id]).map((v) => v.id),
  };
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

/** Starts listening at once; the session list waits for the workspace (`restored`) to sort into projects. */
export async function startTerminals(restored: Promise<void>): Promise<void> {
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
  await restored;
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
  // Terminals started by `haze agent` / `haze run` belong to the project their folder is in.
  const sessions = Object.fromEntries(list.map((s) => [s.id, s.projectId ? s : { ...s, projectId: projectForPath(s.cwd)?.id ?? null }]));
  useTerminals.setState({ sessions, connected: true, error: null });
  const ws = useWorkspace.getState();
  for (const p of ws.projects) {
    const ui = ws.ui[p.id];
    if (!ui) continue;
    const mine = list.filter((s) => sessions[s.id].projectId === p.id).map((s) => s.id);
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
  // Creating reconnects to the host, maybe a new one: its list then replaces the old.
  const reconnecting = !useTerminals.getState().connected;
  try {
    const info = await api.ptyCreate({
      projectId,
      cwd,
      cols: 120,
      rows: 30,
      title: opts.title ?? null,
      command: opts.command ?? null,
      // Programs that pick their colours by the terminal's background (Claude
      // Code's "auto" theme) read it here; without it they assume dark and
      // draw dark blocks on the light theme. Only new sessions see a change.
      env: [["COLORFGBG", useTheme.getState().mode === "light" ? "0;15" : "15;0"]],
    });
    useTerminals.setState((s) => ({ sessions: { ...s.sessions, [info.id]: info }, connected: true, error: null }));
    useWorkspace.getState().updateUi(projectId, (ui) => ({
      terminalOrder: [...ui.terminalOrder, info.id],
      activeTerminal: info.id,
      terminalVisible: true,
    }));
    // After the new tab is in the order, which the sync keeps.
    if (reconnecting) await syncSessions();
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
    // Closing the last tab hides the panel rather than letting it spawn a fresh shell.
    return { terminalOrder: order, activeTerminal: active, ...(order.length === 0 && { terminalVisible: false }) };
  });
}
