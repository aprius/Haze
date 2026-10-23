// Settings: fonts, layout style, keymap, AI agent hooks (opt-in, per agent), notifications, GitHub/GitLab accounts, file nesting, updates.
import { ArrowUpCircle, Bot, Box, Code, FolderTree, GitBranch, Keyboard, type LucideIcon, Plus, RotateCcw, Type, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { create } from "zustand";
import {
  CODE_FONT_SUGGESTIONS,
  DEFAULT_FONTS,
  MAX_LINE_HEIGHT,
  MAX_SIZE,
  MIN_LINE_HEIGHT,
  MIN_SIZE,
  resetFonts,
  setFonts,
  UI_FONT_SUGGESTIONS,
  useFonts,
  type FontSettings,
} from "../lib/fonts";
import { api, errorMessage, type HookAgent, type HookStatus } from "../lib/ipc";
import {
  type Command,
  COMMANDS,
  conflicts,
  keystrokeFromEvent,
  keystrokeLabel,
  keystrokes,
  resetKeystrokes,
  setKeystrokes,
  setRecordingKeys,
  useKeymap,
} from "../lib/keymap";
import { isMac } from "../lib/keymap";
import { setUiStyle, type UiStyle, useUiStyle } from "../lib/theme";
import { popupClosed } from "../store/ui";
import { BREW_UPGRADE, checkForUpdates, openRelease, useUpdates } from "../store/updates";
import { useWorkspace } from "../store/workspace";
import { GitAccountsSection } from "./GitAccounts";
import { toast } from "./Overlays";

type Page = "appearance" | "editor" | "keymap" | "agents" | "vcs" | "project" | "unity" | "updates";

// The page stays selected between openings.
const useSettings = create<{ open: boolean; page: Page }>(() => ({ open: false, page: "appearance" }));

export function openSettings(page?: Page): void {
  useSettings.setState(page ? { open: true, page } : { open: true });
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

const UI_STYLES: [UiStyle, string][] = [
  ["classic", "Classic"],
  ["islands", "Islands"],
];

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

function LineHeightInput() {
  const value = useFonts((s) => s.terminalLineHeight);
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return (
    <input
      className="modal-input settings-font-size"
      type="number"
      min={MIN_LINE_HEIGHT}
      max={MAX_LINE_HEIGHT}
      step={0.05}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value && n >= MIN_LINE_HEIGHT && n <= MAX_LINE_HEIGHT) setFonts({ terminalLineHeight: n });
      }}
      onBlur={() => setDraft(String(value))}
    />
  );
}

function FontSettingsSection() {
  const codeFont = useFonts((s) => s.codeFont);
  const webgl = useFonts((s) => s.terminalWebgl);
  const uiStyle = useUiStyle((s) => s.style);
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
          <span>Terminal line height</span>
          <span />
          <LineHeightInput />
        </div>
      </div>
      <div className="settings-card">
        <div className="settings-row static">
          <div className="settings-row-text">
            <div>Layout</div>
            <div className="muted small">Islands draws each panel as a rounded block with gaps between them, and tabs as rounded chips.</div>
          </div>
          <div className="seg">
            {UI_STYLES.map(([id, name]) => (
              <button key={id} className={"seg-btn" + (uiStyle === id ? " on" : "")} onClick={() => setUiStyle(id)}>
                {name}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="settings-card">
        <SwitchRow
          label="GPU-accelerated terminal"
          desc="Draws the terminal with WebGL: faster with large output, but on macOS some glyphs, often accented ones, come out lighter than the rest."
          checked={webgl}
          onChange={(on) => setFonts({ terminalWebgl: on })}
        />
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

const commandName = (cmd: Command) => COMMANDS.find((c) => c.id === cmd)?.name ?? cmd;

/** Focused while it records: the next key press, with its modifiers, becomes a shortcut. Esc alone cancels. */
function KeyRecorder({ onKey, onCancel }: { onKey: (ks: string) => void; onCancel: () => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    setRecordingKeys(true);
    ref.current?.focus();
    return () => setRecordingKeys(false);
  }, []);
  return (
    <span
      className="keymap-chip recording"
      tabIndex={0}
      ref={ref}
      onBlur={onCancel}
      onKeyDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
        if (e.key === "Escape" && plain) return onCancel();
        const ks = keystrokeFromEvent(e.nativeEvent);
        if (ks) onKey(ks);
      }}
    >
      Press keys…
    </span>
  );
}

function KeymapRow({ id, name }: { id: Command; name: string }) {
  const changed = useKeymap((s) => id in s);
  const list = keystrokes(id);
  const [recording, setRecording] = useState(false);
  const clashes = list.flatMap((ks) => conflicts(id, ks).map((other) => `${keystrokeLabel(ks)} is also ${commandName(other)}`));
  return (
    <div className="keymap-row">
      <div className="keymap-name">
        <span className={changed ? "keymap-changed" : undefined}>{name}</span>
        {clashes.length > 0 && <span className="keymap-clash small">{clashes.join(" · ")}</span>}
      </div>
      <div className="keymap-keys">
        {list.map((ks) => (
          <span key={ks} className="keymap-chip">
            <kbd>{keystrokeLabel(ks)}</kbd>
            <button className="keymap-chip-x" title="Remove" onClick={() => setKeystrokes(id, list.filter((k) => k !== ks))}>
              <X size={10} strokeWidth={3} />
            </button>
          </span>
        ))}
        {id === "searchEverywhere" && <span className="muted small">Double Shift</span>}
        {recording ? (
          <KeyRecorder
            onCancel={() => setRecording(false)}
            onKey={(ks) => {
              if (!list.includes(ks)) setKeystrokes(id, [...list, ks]);
              setRecording(false);
            }}
          />
        ) : (
          <button className="icon-btn" title="Add Shortcut" onClick={() => setRecording(true)}>
            <Plus size={13} />
          </button>
        )}
        <button className="icon-btn" title="Reset to Default" style={{ visibility: changed ? undefined : "hidden" }} onClick={() => resetKeystrokes(id)}>
          <RotateCcw size={13} />
        </button>
      </div>
    </div>
  );
}

function KeymapSection() {
  const changed = useKeymap((s) => Object.keys(s).length > 0);
  // Labels and conflicts are read from the keymap, so any change redraws the page.
  useKeymap();
  const [filter, setFilter] = useState("");
  const q = filter.trim().toLowerCase();
  const shown = COMMANDS.filter((c) => !q || c.name.toLowerCase().includes(q) || keystrokes(c.id).some((ks) => keystrokeLabel(ks).toLowerCase().includes(q)));
  const groups = [...new Set(shown.map((c) => c.group))];
  return (
    <>
      <PageHeader title="Keymap" desc="Click + and press the keys to add a shortcut; a command can have several. Changed commands are highlighted.">
        {changed && (
          <button className="btn small" onClick={() => resetKeystrokes()}>
            Reset All
          </button>
        )}
      </PageHeader>
      <input className="modal-input" placeholder="Filter by action or shortcut" value={filter} spellCheck={false} onChange={(e) => setFilter(e.target.value)} />
      {groups.map((g) => (
        <div key={g} className="settings-card">
          <div className="muted small">{g}</div>
          {shown
            .filter((c) => c.group === g)
            .map((c) => (
              <KeymapRow key={c.id} id={c.id} name={c.name} />
            ))}
        </div>
      ))}
      {shown.length === 0 && <div className="muted small">No matching actions</div>}
    </>
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

function EditorSection() {
  const stickyScroll = useWorkspace((s) => s.stickyScroll);
  const lineBlame = useWorkspace((s) => s.lineBlame);
  const codeVision = useWorkspace((s) => s.codeVision);
  const rainbowBrackets = useWorkspace((s) => s.rainbowBrackets);
  const rainbowGuides = useWorkspace((s) => s.rainbowGuides);
  return (
    <>
      <PageHeader title="Editor" />
      <div className="settings-card">
        <SwitchRow
          label="Sticky scroll"
          desc="Keeps the enclosing namespace, class and method lines pinned at the top while you scroll."
          checked={stickyScroll}
          onChange={(on) => useWorkspace.setState({ stickyScroll: on })}
        />
        <SwitchRow
          label="Git blame for the current line"
          desc="Shows who last changed the caret line, when, and in which commit, at the end of the line."
          checked={lineBlame}
          onChange={(on) => useWorkspace.setState({ lineBlame: on })}
        />
        <SwitchRow
          label="Code Vision"
          desc="Usages and author above C# classes and methods; private members nothing uses are greyed out."
          checked={codeVision}
          onChange={(on) => useWorkspace.setState({ codeVision: on })}
        />
      </div>
      <div className="settings-card">
        <SwitchRow
          label="Rainbow brackets"
          desc="Colours (), [] and {} by how deeply they are nested, so the matching pair is easy to spot."
          checked={rainbowBrackets}
          onChange={(on) => useWorkspace.setState({ rainbowBrackets: on })}
        />
        {rainbowBrackets && (
          <SwitchRow
            label="Rainbow scope guides"
            desc="Draws each bracket pair's indent guide in its colour, brighter for the block around the caret."
            checked={rainbowGuides}
            onChange={(on) => useWorkspace.setState({ rainbowGuides: on })}
          />
        )}
      </div>
    </>
  );
}

function ProjectViewSection() {
  const nestFiles = useWorkspace((s) => s.nestFiles);
  const selectOpenedFile = useWorkspace((s) => s.selectOpenedFile);
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
        <SwitchRow
          label="Always select opened file"
          desc="The Project view selects the file of the active editor tab, expanding its folders."
          checked={selectOpenedFile}
          onChange={(on) => useWorkspace.setState({ selectOpenedFile: on })}
        />
      </div>
    </>
  );
}

function UnitySection() {
  const autoRefresh = useWorkspace((s) => s.unityAutoRefresh);
  return (
    <>
      <PageHeader
        title="Unity"
        desc="Add the com.aprius.ide.haze package to a Unity project and pick Haze as External Script Editor. Haze then links to the open Unity Editor: Build compiles in Unity, and its Console, Play, Pause and Step are in Haze."
      />
      <div className="settings-card">
        <SwitchRow
          label="Refresh assets in Unity when files change"
          desc="Saving in Haze or an agent's edits make Unity import and compile right away, without switching to it. Skipped in Play Mode."
          checked={autoRefresh}
          onChange={(on) => useWorkspace.setState({ unityAutoRefresh: on })}
        />
      </div>
    </>
  );
}

function UpdatesSection() {
  const checkUpdates = useWorkspace((s) => s.checkUpdates);
  const { info, checking, error, checkedAt } = useUpdates();
  const status = checking
    ? "Checking…"
    : error
      ? `Last check failed: ${error}`
      : info
        ? info.available
          ? `Haze ${info.latest} is available (you have ${info.current}).`
          : `Haze ${info.current} is the latest version.`
        : "Not checked yet.";
  return (
    <>
      <PageHeader title="Updates" desc="Haze asks GitHub for its latest release. Nothing is downloaded or installed until you choose to." />
      <div className="settings-card">
        <SwitchRow
          label="Check for updates automatically"
          desc="At startup and every 6 hours. A button appears above Settings when a new version is out."
          checked={checkUpdates}
          onChange={(on) => useWorkspace.setState({ checkUpdates: on })}
        />
        <div className="settings-row static">
          <div className="settings-row-text">
            <div>{status}</div>
            {checkedAt && !checking && <div className="muted small">Checked at {new Date(checkedAt).toLocaleTimeString()}</div>}
          </div>
          {info?.available && (
            <button className="btn small primary" onClick={openRelease}>
              Download…
            </button>
          )}
          <button className="btn small" disabled={checking} onClick={() => void checkForUpdates(true)}>
            Check Now
          </button>
        </div>
        {info?.available && isMac && (
          <div className="muted small">
            Installed with Homebrew? Run <code>{BREW_UPGRADE}</code>
          </div>
        )}
      </div>
    </>
  );
}

const PAGES: { id: Page; name: string; icon: LucideIcon; body: () => ReactNode }[] = [
  { id: "appearance", name: "Appearance", icon: Type, body: () => <FontSettingsSection /> },
  { id: "editor", name: "Editor", icon: Code, body: () => <EditorSection /> },
  { id: "keymap", name: "Keymap", icon: Keyboard, body: () => <KeymapSection /> },
  { id: "agents", name: "AI Agents", icon: Bot, body: () => <AgentsSection /> },
  { id: "vcs", name: "Version Control", icon: GitBranch, body: () => <GitAccountsSection /> },
  { id: "project", name: "Project View", icon: FolderTree, body: () => <ProjectViewSection /> },
  { id: "unity", name: "Unity", icon: Box, body: () => <UnitySection /> },
  { id: "updates", name: "Updates", icon: ArrowUpCircle, body: () => <UpdatesSection /> },
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
