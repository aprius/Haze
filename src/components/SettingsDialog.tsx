// Settings: fonts, AI agent hooks (opt-in, per agent), notifications, GitHub/GitLab accounts, file nesting.
import { useEffect, useState } from "react";
import { create } from "zustand";
import {
  CODE_FONT_SUGGESTIONS,
  DEFAULT_FONTS,
  MAX_SIZE,
  MIN_SIZE,
  resetFonts,
  setFonts,
  UI_FONT_SUGGESTIONS,
  useFonts,
  type FontSettings,
} from "../lib/fonts";
import { api, errorMessage, type HookStatus } from "../lib/ipc";
import { useTree } from "../store/tree";
import { popupClosed } from "../store/ui";
import { useWorkspace } from "../store/workspace";
import { GitAccountsSection } from "./GitAccounts";
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

/** A font name, applied on Enter or blur rather than per keystroke (editors re-measure on each change). */
function FontInput({ field, list }: { field: "uiFont" | "codeFont"; list: string }) {
  const value = useFonts((s) => s[field]);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => (draft.trim() ? setFonts({ [field]: draft }) : setDraft(value));
  return (
    <input
      className="modal-input settings-font-name"
      list={list}
      value={draft}
      spellCheck={false}
      placeholder={DEFAULT_FONTS[field]}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
    />
  );
}

function SizeInput({ field }: { field: "uiSize" | "codeSize" | "terminalSize" }) {
  const value = useFonts((s) => s[field]);
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return (
    <input
      className="modal-input settings-font-size"
      type="number"
      min={MIN_SIZE}
      max={MAX_SIZE}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value && n >= MIN_SIZE && n <= MAX_SIZE) setFonts({ [field]: n });
      }}
      onBlur={() => setDraft(String(value))}
    />
  );
}

function FontSettingsSection() {
  const codeFont = useFonts((s) => s.codeFont);
  const isDefault = useFonts((s) => (Object.keys(DEFAULT_FONTS) as (keyof FontSettings)[]).every((k) => s[k] === DEFAULT_FONTS[k]));
  return (
    <>
      <div className="settings-section">Fonts</div>
      <div className="settings-fonts">
        <span>Interface</span>
        <FontInput field="uiFont" list="haze-ui-fonts" />
        <SizeInput field="uiSize" />
        <span>Code editor</span>
        <FontInput field="codeFont" list="haze-code-fonts" />
        <SizeInput field="codeSize" />
        <span>Terminal</span>
        <span className="muted small" title="The terminal uses the code editor's font">
          {codeFont} (same as code)
        </span>
        <SizeInput field="terminalSize" />
      </div>
      <datalist id="haze-ui-fonts">
        {UI_FONT_SUGGESTIONS.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>
      <datalist id="haze-code-fonts">
        {CODE_FONT_SUGGESTIONS.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>
      <div className="muted small settings-fonts-hint">
        Interface covers menus and tool windows (Project, Git, Commit, Build…). Any installed font can be typed.
        {!isDefault && (
          <button className="btn small" onClick={resetFonts}>
            Reset to defaults
          </button>
        )}
      </div>
    </>
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
        <FontSettingsSection />
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
        <GitAccountsSection />
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
