// Settings: fonts, AI agent hooks (opt-in, per agent), notifications, GitHub/GitLab accounts, file nesting.
import { Bot, FolderTree, GitBranch, type LucideIcon, Type, X } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
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
import { api, errorMessage, type HookAgent, type HookStatus } from "../lib/ipc";
import { popupClosed } from "../store/ui";
import { useWorkspace } from "../store/workspace";
import { GitAccountsSection } from "./GitAccounts";
import { toast } from "./Overlays";

type Page = "appearance" | "agents" | "vcs" | "project";

// The page stays selected between openings.
const useSettings = create<{ open: boolean; page: Page }>(() => ({ open: false, page: "appearance" }));

export function openSettings(): void {
  useSettings.setState({ open: true });
}

function close() {
  useSettings.setState({ open: false });
  popupClosed();
}

const AGENTS: { id: HookAgent; name: string; what: string }[] = [
  {
    id: "claude",
    name: "Claude Code",
    what: "Adds hooks to ~/.claude/settings.json (your other settings and hooks are kept). Tabs show working / waiting for you / done.",
  },
  {
    id: "codex",
    name: "Codex",
    what: "Adds lifecycle hooks to ~/.codex/hooks.json for working / waiting for you / done (Codex may ask you to trust them in /hooks), and sets `notify` in config.toml for older Codex versions unless you use it already.",
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    what: "Adds hooks to ~/.gemini/settings.json (your other settings and hooks are kept). Needs Gemini CLI 0.26 or later.",
  },
  {
    id: "opencode",
    name: "OpenCode",
    what: "Adds a plugin, haze.js, to OpenCode's global plugins folder; it reports working / waiting for you / done.",
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
      {status && (
        <div className="muted small settings-path" title={status.configPath}>
          {status.configPath}
        </div>
      )}
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
      <PageHeader title="Appearance" desc="Interface covers menus and tool windows (Project, Git, Commit, Build…). Any installed font can be typed.">
        {!isDefault && (
          <button className="btn small" onClick={resetFonts}>
            Reset to Defaults
          </button>
        )}
      </PageHeader>
      <div className="settings-card">
        <div className="settings-fonts">
          <span className="muted small">Fonts</span>
          <span className="muted small">Family</span>
          <span className="muted small">Size</span>
          <span>Interface</span>
          <FontInput field="uiFont" list="haze-ui-fonts" />
          <SizeInput field="uiSize" />
          <span>Code editor</span>
          <FontInput field="codeFont" list="haze-code-fonts" />
          <SizeInput field="codeSize" />
          <span>Terminal</span>
          <span className="muted small settings-ellipsis" title="The terminal uses the code editor's font">
            {codeFont} (same as code)
          </span>
          <SizeInput field="terminalSize" />
        </div>
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
    </>
  );
}

export function PageHeader({ title, desc, children }: { title: string; desc?: string; children?: ReactNode }) {
  return (
    <div className="settings-page-head">
      <div className="settings-page-title">
        <h2>{title}</h2>
        {children}
      </div>
      {desc && <div className="muted small">{desc}</div>}
    </div>
  );
}

function SwitchRow({ label, desc, checked, onChange }: { label: string; desc?: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="settings-row">
      <div className="settings-row-text">
        <div>{label}</div>
        {desc && <div className="muted small">{desc}</div>}
      </div>
      <span className="switch">
        <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span />
      </span>
    </label>
  );
}

function AgentsSection() {
  const notifyAgents = useWorkspace((s) => s.notifyAgents);
  return (
    <>
      <PageHeader
        title="AI Agents"
        desc="Agents running in Haze terminals report their state through these hooks. Nothing from your prompts or transcripts is stored. Restart running agents after installing."
      />
      {AGENTS.map((a) => (
        <AgentRow key={a.id} {...a} />
      ))}
      <div className="settings-card">
        <SwitchRow
          label="Desktop notifications"
          desc="When an agent needs you or finishes, while Haze is in the background."
          checked={notifyAgents}
          onChange={async (on) => {
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
      </div>
    </>
  );
}

function ProjectViewSection() {
  const nestFiles = useWorkspace((s) => s.nestFiles);
  return (
    <>
      <PageHeader title="Project View" />
      <div className="settings-card">
        <SwitchRow
          label="Nest related files"
          desc="appsettings.*.json, *.razor.cs, *.Designer.cs… appear under the file they belong to."
          checked={nestFiles}
          onChange={(on) => useWorkspace.setState({ nestFiles: on })}
        />
      </div>
    </>
  );
}

const PAGES: { id: Page; name: string; icon: LucideIcon; body: () => ReactNode }[] = [
  { id: "appearance", name: "Appearance", icon: Type, body: () => <FontSettingsSection /> },
  { id: "agents", name: "AI Agents", icon: Bot, body: () => <AgentsSection /> },
  { id: "vcs", name: "Version Control", icon: GitBranch, body: () => <GitAccountsSection /> },
  { id: "project", name: "Project View", icon: FolderTree, body: () => <ProjectViewSection /> },
];

export function SettingsDialog() {
  const open = useSettings((s) => s.open);
  const page = useSettings((s) => s.page);
  // Window-level: buttons that disable while busy drop focus out of the dialog.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  if (!open) return null;
  const current = PAGES.find((p) => p.id === page) ?? PAGES[0];
  return (
    <div className="modal-backdrop settings-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="settings-dialog" role="dialog" aria-label="Settings" tabIndex={-1} onKeyDown={(e) => (e.key === "Escape" && close(), e.stopPropagation())}>
        <nav className="settings-nav">
          <div className="settings-nav-title">Settings</div>
          {PAGES.map((p) => (
            <button key={p.id} className={"settings-nav-item" + (p.id === current.id ? " on" : "")} onClick={() => useSettings.setState({ page: p.id })}>
              <p.icon size={15} />
              <span>{p.name}</span>
            </button>
          ))}
        </nav>
        <div className="settings-main">
          <button className="icon-btn settings-close" title="Close (Esc)" onClick={close}>
            <X size={16} />
          </button>
          <div className="settings-content" key={current.id}>
            {current.body()}
          </div>
        </div>
      </div>
    </div>
  );
}
