// Which command writes the commit message (Commit window › Generate). Kept in localStorage like the fonts.
// The prompt reaches the command on stdin (or, on macOS/Linux, through {prompt}); {model} is the model id typed in Settings.
import { create } from "zustand";

export interface Generator {
  id: string;
  name: string;
  /** The command; empty for Custom. */
  command: string;
  /** Model id the preset starts with; "" when it has none. */
  model: string;
}

// All presets read the prompt on stdin, so they work the same on Windows (where {prompt} isn't allowed).
export const GENERATORS: Generator[] = [
  { id: "claude", name: "Claude Code", command: "claude -p --model {model}", model: "haiku" },
  { id: "opencode", name: "OpenCode", command: "opencode run -m {model}", model: "opencode/deepseek-v4.1-flash-free" },
  { id: "codex", name: "Codex", command: "codex exec -s read-only --skip-git-repo-check --ephemeral -", model: "" },
  { id: "gemini", name: "Gemini CLI", command: 'gemini -p "Answer with the commit message only."', model: "" },
  { id: "custom", name: "Custom command", command: "", model: "" },
];


export interface CommitMessageSettings {
  generator: string;
  command: string;
  model: string;
  prompt: string;
  timeoutSecs: number;
}

export const DEFAULT_PROMPT =
  "Write a git commit message in English for the changes below. A short imperative subject line (max 72 characters), " +
  "then, only if useful, a blank line and a few bullet points on what and why. Match the style of the recent commits. " +
  "Answer with the message only: no quotes, no code fence, no explanation.";

const KEY = "haze.commitMessage";
const first = GENERATORS[0];
export const DEFAULT_COMMIT_MESSAGE: CommitMessageSettings = {
  generator: first.id,
  command: first.command,
  model: first.model,
  prompt: DEFAULT_PROMPT,
  timeoutSecs: 90,
};

function sanitize(s: Partial<CommitMessageSettings>): CommitMessageSettings {
  const d = DEFAULT_COMMIT_MESSAGE;
  const str = (v: unknown, f: string) => (typeof v === "string" ? v : f);
  const secs = Number(s.timeoutSecs);
  return {
    generator: GENERATORS.some((g) => g.id === s.generator) ? (s.generator as string) : d.generator,
    command: str(s.command, d.command),
    model: str(s.model, d.model),
    prompt: str(s.prompt, d.prompt).trim() ? str(s.prompt, d.prompt) : d.prompt,
    timeoutSecs: Number.isFinite(secs) ? Math.min(600, Math.max(5, Math.round(secs))) : d.timeoutSecs,
  };
}

function initial(): CommitMessageSettings {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) return sanitize(JSON.parse(saved));
  } catch {}
  return DEFAULT_COMMIT_MESSAGE;
}

export const useCommitMessage = create<CommitMessageSettings>(() => initial());

export function setCommitMessage(patch: Partial<CommitMessageSettings>): void {
  const next = sanitize({ ...useCommitMessage.getState(), ...patch });
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {}
  useCommitMessage.setState(next);
}

/** Pick a preset: its command and model replace the current ones (Custom keeps the command). */
export function chooseGenerator(id: string): void {
  const g = GENERATORS.find((x) => x.id === id);
  if (!g) return;
  setCommitMessage({ generator: id, ...(id === "custom" ? {} : { command: g.command, model: g.model }) });
}
