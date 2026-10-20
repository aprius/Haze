// Settings: AI agent hooks (opt-in, per agent), notifications, file nesting.
import { useEffect, useState } from "react";
import { create } from "zustand";
import { api, errorMessage, type HookStatus } from "../lib/ipc";
import { useTree } from "../store/tree";
import { popupClosed } from "../store/ui";
import { useWorkspace } from "../store/workspace";
import { toast } from "./Overlays";

const useSettings = create<{ open: boolean }>(() => ({ open: false }));

export function openSettings(): void {
  useSettings.setState({ open: true });
}

function close() {
  useSettings.setState({ open: false });
  popupClosed();
}

const AGENTS: { id: "claude" | "codex"; name: string; what: string }[] = [
  {
    id: "claude",
    name: "Claude Code",
    what: "Adds hooks to ~/.claude/settings.json (your other settings and hooks are kept). Tabs show working / waiting for you / done.",
  },
  {
    id: "codex",
    name: "Codex",
    what: "Sets `notify` in ~/.codex/config.toml. Codex only reports finished turns, so tabs show when it is done.",
  },
];

function AgentRow({ id, name, what }: (typeof AGENTS)[number]) {
  const [status, setStatus] = useState<HookStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.agentHooksStatus(id).then(setStatus, (e) => setError(errorMessage(e)));
  }, [id]);
  const run = async (f: () => Promise<HookStatus>) => {
    setBusy(true);
    try {
      setStatus(await f());
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const label = !status ? "…" : status.installed ? (status.stale ? "Needs update" : "Installed") : "Not installed";
  return (
    <div className="settings-agent">
      <div className="settings-agent-head">
        <b>{name}</b>
        <span className={"tag" + (status?.installed && !status.stale ? "" : " off")}>{label}</span>
        <span className="run-spacer" />
        {status?.installed ? (
          <>
            {status.stale && (
              <button className="btn small" disabled={busy} onClick={() => void run(() => api.agentHooksInstall(id))}>
                Update
              </button>
            )}
            <button className="btn small" disabled={busy} onClick={() => void run(() => api.agentHooksUninstall(id))}>
              Remove
            </button>
          </>
        ) : (
          <button className="btn small primary" disabled={busy || !!status?.conflict} onClick={() => void run(() => api.agentHooksInstall(id))}>
            Install
          </button>
        )}
      </div>
      <div className="muted small">{what}</div>
      {status && <div className="muted small">Config: {status.configPath}</div>}
      {status?.conflict && <div className="modal-error">{status.conflict}. Haze will not overwrite it.</div>}
      {error && <div className="modal-error">{error}</div>}
    </div>
  );
}

export function SettingsDialog() {
  const open = useSettings((s) => s.open);
  const notifyAgents = useWorkspace((s) => s.notifyAgents);
  const nestFiles = useWorkspace((s) => s.nestFiles);
  // Window-level: buttons that disable while busy drop focus out of the dialog.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal settings-dialog" tabIndex={-1} onKeyDown={(e) => (e.key === "Escape" && close(), e.stopPropagation())}>
        <div className="modal-title">Settings</div>
        <div className="settings-section">AI agents</div>
        <div className="muted small">
          Agents running in Haze terminals report their state through these hooks. Nothing from your prompts or transcripts is stored. Restart
          running agents after installing.
        </div>
        {AGENTS.map((a) => (
          <AgentRow key={a.id} {...a} />
        ))}
        <label className="find-check">
          <input
            type="checkbox"
            checked={notifyAgents}
            onChange={async (e) => {
              const on = e.target.checked;
              useWorkspace.setState({ notifyAgents: on });
              if (on) {
                try {
                  const n = await import("@tauri-apps/plugin-notification");
                  if (!(await n.isPermissionGranted()) && (await n.requestPermission()) !== "granted") toast("Notifications are blocked by the system.", "error");
                } catch {
                  /* not available */
                }
              }
            }}
          />
          Desktop notification when an agent needs you or finishes (while Haze is in the background)
        </label>
        <div className="settings-section">Project view</div>
        <label className="find-check">
          <input
            type="checkbox"
            checked={nestFiles}
            onChange={(e) => {
              useWorkspace.setState({ nestFiles: e.target.checked });
              useTree.setState({ dirs: {} });
            }}
          />
          Nest related files (appsettings.*.json, *.razor.cs, *.Designer.cs…)
        </label>
        <div className="modal-buttons">
          <button className="btn primary" onClick={close}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
