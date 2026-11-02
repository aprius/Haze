// Terminals and agents as Search Everywhere results, across all projects.
import type { SessionInfo } from "./ipc";
import { scoreLabel } from "./scoreLabel";
import { basename } from "./path";
import { agentName } from "../store/terminals";

export interface TerminalHit {
  session: SessionInfo;
  project: string;
}

/** Waiting first (it blocks an agent), then failed, finished, working, the rest. */
const RANK: Record<string, number> = { waiting: 0, error: 1, done: 2, working: 3, idle: 4 };

/**
 * Terminals matching `query` (title, agent, project, folder), best first; all
 * of them without a query, those that need a look on top.
 */
export function findTerminals(sessions: SessionInfo[], projectNames: Record<string, string>, query: string): TerminalHit[] {
  const hits: { hit: TerminalHit; score: number; rank: number }[] = [];
  for (const session of sessions) {
    const project = (session.projectId && projectNames[session.projectId]) || "";
    const label = [session.title, session.agent && agentName(session.agent.agent), project, basename(session.cwd)].filter(Boolean).join(" ");
    const score = scoreLabel(label, query);
    if (score === null) continue;
    const a = session.agent;
    hits.push({ hit: { session, project }, score, rank: a ? (RANK[a.state] ?? 5) : 6 });
  }
  return hits.sort((x, y) => (query.trim() ? y.score - x.score || x.rank - y.rank : x.rank - y.rank)).map((x) => x.hit);
}
