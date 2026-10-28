// Settings: fonts, layout style, background, keymap, AI agent hooks (opt-in, per agent), OpenCode model providers, notifications, GitHub/GitLab accounts, file nesting, updates.
import {
  ArrowUpCircle,
  Bot,
  Box,
  BrainCircuit,
  Code,
  Film,
  FolderTree,
  GitBranch,
  ImageIcon,
  Keyboard,
  type LucideIcon,
  Moon,
  Plus,
  RotateCcw,
  Shuffle,
  SkipForward,
  Sun,
  Type,
  Wallpaper,
  X,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { BACKDROP_EXTENSIONS, BACKDROP_LIMITS, DEFAULT_BACKDROP, setBackdrop, useBackdrop, useBackdropImage } from "../lib/backdrop";
import { rotateNow, useRotation } from "../lib/backdropRotate";
import { basename } from "../lib/path";
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
import { setUiStyle, type UiStyle, useUiStyle } from "../lib/theme";
import { popupClosed } from "../store/ui";
import { checkForUpdates, openRelease, updateLabel, updateNow, useUpdates } from "../store/updates";
import { useWorkspace, type PerfContextMode } from "../store/workspace";
import { GitAccountsSection } from "./GitAccounts";
import { OpenCodeModelsSection } from "./OpenCodeModels";
import { toast } from "./Overlays";
import { parseRuleIds } from "../lib/lsp/diagnostics";

type Page = "appearance" | "background" | "editor" | "keymap" | "agents" | "models" | "vcs" | "project" | "unity" | "updates";

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

async function chooseBackdrop() {
  const path = await openDialog({
    multiple: false,
    title: "Background",
    filters: [{ name: "Images and videos", extensions: BACKDROP_EXTENSIONS }],
  });
  if (typeof path === "string") void setBackdrop({ path, folder: null });
}

async function chooseBackdropFolder() {
  const folder = await openDialog({
    directory: true,
    multiple: false,
    title: "Background folder",
  });
  if (typeof folder === "string") void setBackdrop({ folder });
}

const ROTATE_EVERY: [number, string][] = [
  [1, "Every minute"],
  [5, "Every 5 minutes"],
  [10, "Every 10 minutes"],
  [15, "Every 15 minutes"],
  [30, "Every 30 minutes"],
  [60, "Every hour"],
  [120, "Every 2 hours"],
  [240, "Every 4 hours"],
  [0, "When day or night begins"],
];

const clockTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const parseClock = (v: string) => {
  const [h, m] = v.split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
};

function ClockInput({ field }: { field: "dayStart" | "nightStart" }) {
  const value = useBackdrop((s) => s[field]);
  return (
    <input
      type="time"
      className="modal-input bg-clock"
      value={clockTime(value)}
      onChange={(e) => {
        const m = parseClock(e.target.value);
        if (m !== null) void setBackdrop({ [field]: m });
      }}
    />
  );
}

function BackdropSlider({ field, label, unit }: { field: keyof typeof BACKDROP_LIMITS; label: string; unit: string }) {
  const value = useBackdrop((s) => s[field]);
  const [min, max] = BACKDROP_LIMITS[field];
  return (
    <>
      <span>{label}</span>
      <input type="range" className="settings-range" min={min} max={max} value={value} onChange={(e) => void setBackdrop({ [field]: Number(e.target.value) })} />
      <span className="muted small settings-range-value">
        {value}
        {unit}
      </span>
    </>
  );
}

/** What Reset puts back: the look, not the file or folder. */
const BACKDROP_TUNING = [
  "blur",
  "dim",
  "opacity",
  "popupOpacity",
  "ambient",
  "agentGlow",
  "pauseInBackground",
  "interval",
  "shuffle",
  "dayStart",
  "nightStart",
  "fade",
] as const;

/**
 * The background as the window shows it, with panels and a popup in miniature
 * over it at the opacity set, so the sliders show what they do.
 */
function BackdropPreview() {
  const url = useBackdropImage((s) => s.url);
  const video = useBackdropImage((s) => !!s.live);
  const path = useBackdrop((s) => s.path);
  const folder = useBackdrop((s) => s.folder);
  const period = useRotation((s) => s.period);
  if (!url)
    return (
      <div className="bg-preview empty">
        <Wallpaper size={26} />
        <span>No background</span>
      </div>
    );
  return (
    <div className="bg-preview">
      <div className="bg-preview-island side" />
      <div className="bg-preview-island editor">
        <i style={{ width: "46%" }} />
        <i style={{ width: "70%" }} />
        <i style={{ width: "58%" }} />
        <i style={{ width: "34%" }} />
      </div>
      <div className="bg-preview-island bottom" />
      <div className="bg-preview-popup" />
      {path && (
        <div className="bg-preview-caption" title={path}>
          {video ? <Film size={12} /> : <ImageIcon size={12} />}
          <span>{basename(path)}</span>
          {folder && period && (period === "day" ? <Sun size={12} /> : <Moon size={12} />)}
        </div>
      )}
    </div>
  );
}

/** A file or folder chosen, and the button that chooses it. */
function PathPicker({ value, placeholder, onChoose, children }: { value: string | null; placeholder: string; onChoose: () => void; children?: ReactNode }) {
  return (
    <div className="bg-picker">
      <span className={"bg-picker-path" + (value ? "" : " muted")} title={value ?? undefined}>
        {/* Right to left, so a long path loses its start, not the name. */}
        <bdi dir="ltr">{value ?? placeholder}</bdi>
      </span>
      {children}
      <button className="btn small" onClick={onChoose}>
        {value ? "Change…" : "Choose…"}
      </button>
    </div>
  );
}

/** A folder to rotate through (src/lib/backdropRotate.ts), and what is in it. */
function RotateFolder() {
  const folder = useBackdrop((s) => s.folder);
  const r = useRotation();
  const split = r.day > 0 || r.night > 0;
  return (
    <>
      <PathPicker value={folder} placeholder="No folder chosen" onChoose={() => void chooseBackdropFolder()}>
        {folder && (
          <button className="btn small" onClick={rotateNow} title="Show another background now">
            <SkipForward size={12} /> Next
          </button>
        )}
      </PathPicker>
      {folder && r.error && <div className="modal-error">Cannot rotate: {r.error}</div>}
      {folder && r.period && !r.error && (
        <div className="bg-chips">
          {split ? (
            <>
              <span className={"bg-chip" + (r.period === "day" ? " on" : "")} title="In the days folder">
                <Sun size={12} /> {r.day} by day
              </span>
              <span className={"bg-chip" + (r.period === "night" ? " on" : "")} title="In the nights folder">
                <Moon size={12} /> {r.night} by night
              </span>
              {r.root > 0 && (
                <span className="bg-chip" title="At the top of the folder: used when the days or nights folder is empty">
                  {r.root} for either
                </span>
              )}
            </>
          ) : (
            <>
              <span className="bg-chip on">
                {r.period === "day" ? <Sun size={12} /> : <Moon size={12} />} {r.root} day and night
              </span>
              <span className="muted small">Add days and nights folders to it to pick by the time of day.</span>
            </>
          )}
        </div>
      )}
      {!folder && <div className="muted small">Folders named days and nights inside it are used by day and by night; without them, the folder's own files are.</div>}
    </>
  );
}

/** When a rotating background changes, and how. */
function RotateSchedule() {
  const interval = useBackdrop((s) => s.interval);
  const shuffle = useBackdrop((s) => s.shuffle);
  return (
    <div className="settings-backdrop-grid">
      <span>Change</span>
      <select className="find-select bg-field" value={interval} onChange={(e) => void setBackdrop({ interval: Number(e.target.value) })}>
        {ROTATE_EVERY.map(([m, label]) => (
          <option key={m} value={m}>
            {label}
          </option>
        ))}
      </select>
      <span />
      <span>Order</span>
      <div className="seg bg-field">
        <button className={"seg-btn" + (shuffle ? " on" : "")} onClick={() => void setBackdrop({ shuffle: true })}>
          <Shuffle size={11} /> Random
        </button>
        <button className={"seg-btn" + (shuffle ? "" : " on")} onClick={() => void setBackdrop({ shuffle: false })}>
          By name
        </button>
      </div>
      <span />
      <span>Day / night</span>
      <div className="bg-clocks">
        <Sun size={13} className="muted" />
        <ClockInput field="dayStart" />
        <Moon size={13} className="muted" />
        <ClockInput field="nightStart" />
      </div>
      <span />
      <BackdropSlider field="fade" label="Transition" unit=" s" />
    </div>
  );
}

type BackdropSource = "none" | "file" | "folder";
const SOURCES: [BackdropSource, string][] = [
  ["none", "None"],
  ["file", "Image or video"],
  ["folder", "Folder"],
];

/** Background image or video, islands layout only (src/lib/backdrop.ts). */
function BackgroundSection() {
  const path = useBackdrop((s) => s.path);
  const folder = useBackdrop((s) => s.folder);
  const isDefault = useBackdrop((s) => BACKDROP_TUNING.every((k) => s[k] === DEFAULT_BACKDROP[k]));
  const error = useBackdropImage((s) => s.error);
  const moving = useBackdropImage((s) => !!s.live);
  const agentGlow = useBackdrop((s) => s.agentGlow);
  const pauseInBackground = useBackdrop((s) => s.pauseInBackground);
  const islands = useUiStyle((s) => s.style === "islands");
  // Picking File or Folder shows its picker before anything is chosen.
  const [source, setSource] = useState<BackdropSource>(folder ? "folder" : path ? "file" : "none");
  const choose = (s: BackdropSource) => {
    setSource(s);
    if (s === "none") void setBackdrop({ path: null, folder: null });
  };
  return (
    <>
      <PageHeader title="Background" desc="An image or video behind the Islands layout: the panels and popups turn to tinted glass over it.">
        {!isDefault && (
          <button className="btn small" onClick={() => void setBackdrop(Object.fromEntries(BACKDROP_TUNING.map((k) => [k, DEFAULT_BACKDROP[k]])))}>
            Reset to Defaults
          </button>
        )}
      </PageHeader>
      {path && !islands && (
        <div className="settings-card bg-notice">
          <div className="settings-row static">
            <div className="settings-row-text muted small">The background shows with the Islands layout only.</div>
            <button className="btn small" onClick={() => setUiStyle("islands")}>
              Use Islands
            </button>
          </div>
        </div>
      )}
      <div className="settings-card bg-source">
        <div className="bg-source-top">
          <BackdropPreview />
          <div className="bg-source-body">
            <div className="seg bg-source-seg">
              {SOURCES.map(([id, name]) => (
                <button key={id} className={"seg-btn" + (source === id ? " on" : "")} onClick={() => choose(id)}>
                  {name}
                </button>
              ))}
            </div>
            {source === "none" && (
              <div className="muted small">PNG, JPEG, WebP or BMP images, MP4, MOV or WebM videos, one at a time or a folder of them taking turns.</div>
            )}
            {source === "file" && <PathPicker value={folder ? null : path} placeholder="No file chosen" onChoose={() => void chooseBackdrop()} />}
            {source === "folder" && <RotateFolder />}
            {error && <div className="modal-error">Cannot read the file: {error}</div>}
          </div>
        </div>
        {source === "folder" && folder && <RotateSchedule />}
      </div>
      {path && (
        <>
          <div className="settings-card">
            <div className="bg-card-title">Glass</div>
            <div className="settings-backdrop-grid">
              <BackdropSlider field="blur" label="Blur" unit="px" />
              <BackdropSlider field="dim" label="Dim" unit="%" />
              <BackdropSlider field="opacity" label="Panel opacity" unit="%" />
              <BackdropSlider field="popupOpacity" label="Popup opacity" unit="%" />
            </div>
          </div>
          <div className="settings-card">
            <div className="bg-card-title">Glow</div>
            <div className="settings-backdrop-grid">
              <BackdropSlider field="ambient" label="Ambient glow" unit="%" />
            </div>
            <SwitchRow
              label="Agent status glow"
              desc="The terminal panel glows while its agents work, wait for you, finish or fail."
              checked={agentGlow}
              onChange={(on) => void setBackdrop({ agentGlow: on })}
            />
          </div>
          {moving && (
            <div className="settings-card">
              <SwitchRow
                label="Pause video in background"
                desc="The video stops while another app has focus, and plays on when you come back."
                checked={pauseInBackground}
                onChange={(on) => void setBackdrop({ pauseInBackground: on })}
              />
            </div>
          )}
        </>
      )}
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

function IgnoredRulesInput() {
  const value = useWorkspace((s) => s.ignoredRules).join(", ");
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const ignoredRules = parseRuleIds(draft);
    if (ignoredRules.join(", ") === value) setDraft(value);
    else useWorkspace.setState({ ignoredRules });
  };
  return (
    <input
      className="modal-input settings-rules"
      value={draft}
      spellCheck={false}
      placeholder="IDE0130, CS0168"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
    />
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
        <div className="settings-row static">
          <div className="settings-row-text">
            <div>Ignored C# rules</div>
            <div className="muted small">Warnings and suggestions with these IDs are not shown in any project. Alt+Enter on one adds it (Ignore … in all projects); errors always show.</div>
          </div>
          <IgnoredRulesInput />
        </div>
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

const PERF_CONTEXT: [PerfContextMode, string][] = [
  ["everywhere", "Everywhere"],
  ["current", "Current method"],
  ["never", "Never"],
];

function UnitySection() {
  const autoRefresh = useWorkspace((s) => s.unityAutoRefresh);
  const perfContext = useWorkspace((s) => s.unityPerfContext);
  const perfHints = useWorkspace((s) => s.unityPerfHints);
  const inspections = useWorkspace((s) => s.unityInspections);
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
      <div className="settings-card">
        <div className="settings-row static">
          <div className="settings-row-text">
            <div>Highlight performance-critical context</div>
            <div className="muted small">A bar in the gutter beside methods Unity runs every frame (Update, FixedUpdate, coroutines…) and the methods they call, as in Rider.</div>
          </div>
          <div className="seg">
            {PERF_CONTEXT.map(([id, name]) => (
              <button key={id} className={"seg-btn" + (perfContext === id ? " on" : "")} onClick={() => useWorkspace.setState({ unityPerfContext: id })}>
                {name}
              </button>
            ))}
          </div>
        </div>
        <SwitchRow
          label="Point out expensive calls in it"
          desc="GetComponent, Find, Camera.main, Debug.Log, SendMessage, calls by name, null checks of Unity objects and multidimensional arrays, and calls to methods that make them, get a dotted underline."
          checked={perfHints}
          onChange={(on) => useWorkspace.setState({ unityPerfHints: on })}
        />
      </div>
      <div className="settings-card">
        <SwitchRow
          label="Check names against the project"
          desc="Tags, layers, input axes, scenes, Resources paths, Animator states and shaders a script names that the project does not have, a parent set right after Instantiate, and broken references in assembly definitions."
          checked={inspections}
          onChange={(on) => useWorkspace.setState({ unityInspections: on })}
        />
      </div>
    </>
  );
}

function UpdatesSection() {
  const checkUpdates = useWorkspace((s) => s.checkUpdates);
  const { info, checking, error, checkedAt, kind, progress } = useUpdates();
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
      <PageHeader
        title="Updates"
        desc="Haze asks GitHub for its latest release. Nothing is downloaded or installed until you choose Update Now; a Homebrew install updates through Homebrew in Terminal."
      />
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
            <button className="btn small primary" disabled={progress !== null} onClick={() => void updateNow()}>
              {progress ? "Updating…" : updateLabel(kind)}
            </button>
          )}
          {info?.available && kind !== "manual" && (
            <button className="btn small" onClick={openRelease}>
              Release Notes…
            </button>
          )}
          <button className="btn small" disabled={checking} onClick={() => void checkForUpdates(true)}>
            Check Now
          </button>
        </div>
      </div>
    </>
  );
}

const PAGES: { id: Page; name: string; icon: LucideIcon; body: () => ReactNode }[] = [
  { id: "appearance", name: "Appearance", icon: Type, body: () => <FontSettingsSection /> },
  { id: "background", name: "Background", icon: Wallpaper, body: () => <BackgroundSection /> },
  { id: "editor", name: "Editor", icon: Code, body: () => <EditorSection /> },
  { id: "keymap", name: "Keymap", icon: Keyboard, body: () => <KeymapSection /> },
  { id: "agents", name: "AI Agents", icon: Bot, body: () => <AgentsSection /> },
  { id: "models", name: "AI Models", icon: BrainCircuit, body: () => <OpenCodeModelsSection /> },
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
