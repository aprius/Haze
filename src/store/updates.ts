// Check for Updates: the latest GitHub release, at most every few hours
// (Settings › Updates), or on demand. "Update Now" runs `haze update` in Terminal
// for a Homebrew install; a Haze.app, AppImage or haze.exe install downloads the release
// inside Haze and restarts into it (updates.rs); anything else opens the release page.
// Kept off the startup path: the first check waits until Haze has settled, the
// request runs on a Rust worker thread, and the last result is saved with the
// workspace so a relaunch shows it without asking GitHub again.
import { getVersion } from "@tauri-apps/api/app";
import { Channel } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { create } from "zustand";
import { toast } from "../components/Overlays";
import { api, errorMessage, type InstallKind, type UpdateInfo, type UpdateProgress } from "../lib/ipc";
import { flush } from "./persist";
import { useWorkspace } from "./workspace";

/** The earliest automatic check after launch. */
const FIRST_CHECK_MS = 30_000;
const INTERVAL_MS = 6 * 60 * 60 * 1000;

interface UpdatesState {
  info: UpdateInfo | null;
  checking: boolean;
  error: string | null;
  checkedAt: number | null;
  kind: InstallKind;
  /** Set while Update Now downloads (bundle installs); `received === total` while it installs. */
  progress: UpdateProgress | null;
}

export const useUpdates = create<UpdatesState>(() => ({ info: null, checking: false, error: null, checkedAt: null, kind: "manual", progress: null }));

/** What persist.ts saves: the last successful check. */
export interface SavedUpdateCheck {
  info: UpdateInfo;
  checkedAt: number;
}

export function savedUpdateCheck(): SavedUpdateCheck | undefined {
  const { info, checkedAt } = useUpdates.getState();
  return info && checkedAt ? { info, checkedAt } : undefined;
}

/** Restores the last check; dropped once Haze has been updated since (it compared another version). */
export function restoreUpdateCheck(saved: SavedUpdateCheck | undefined): void {
  if (!saved?.info) return;
  useUpdates.setState({ info: saved.info, checkedAt: saved.checkedAt });
  void getVersion()
    .then((v) => {
      if (v !== saved.info.current) useUpdates.setState({ info: null, checkedAt: null });
    })
    .catch(() => {});
}

export function openRelease(): void {
  const url = useUpdates.getState().info?.url;
  if (url) void openUrl(url);
}

/** The label of the action that updates this copy. */
export function updateLabel(kind: InstallKind): string {
  return kind === "manual" ? "Download…" : "Update Now";
}

export async function updateNow(): Promise<void> {
  const { kind, progress } = useUpdates.getState();
  if (progress) return;
  if (kind === "manual") return openRelease();
  if (kind === "brew") {
    try {
      await api.updateInTerminal();
      toast("Updating Haze in Terminal. Haze restarts when it is done.");
    } catch (e) {
      toast(`Cannot update: ${errorMessage(e)}`, "error", { label: "Download", run: openRelease });
    }
    return;
  }
  const channel = new Channel<UpdateProgress>();
  channel.onmessage = (p) => useUpdates.setState({ progress: p });
  useUpdates.setState({ progress: { received: 0, total: 0 } });
  try {
    await api.installUpdate(channel);
    await flush().catch(console.error);
    await api.relaunchUpdated();
  } catch (e) {
    useUpdates.setState({ progress: null });
    toast(`Cannot update: ${errorMessage(e)}`, "error", { label: "Download", run: openRelease });
  }
}

/** `manual`: from Settings, so the result is reported either way. */
export async function checkForUpdates(manual = false): Promise<void> {
  if (useUpdates.getState().checking) return;
  const before = useUpdates.getState().info;
  useUpdates.setState({ checking: true });
  try {
    const info = await api.checkUpdate();
    useUpdates.setState({ info, error: null, checkedAt: Date.now() });
    // Announced once per version; the rail button stays until Haze is updated.
    if (info.available && (manual || before?.latest !== info.latest)) {
      const kind = useUpdates.getState().kind;
      toast(`Haze ${info.latest} is available (you have ${info.current}).`, "info", {
        label: kind === "manual" ? "Download" : "Update",
        run: () => void updateNow(),
      });
    } else if (manual && !info.available) {
      toast(`Haze ${info.current} is the latest version.`);
    }
  } catch (e) {
    // checkedAt is kept: a failed check is retried at the next interval, not at the next launch.
    useUpdates.setState({ error: errorMessage(e) });
    if (manual) toast(`Cannot check for updates: ${errorMessage(e)}`, "error");
  } finally {
    useUpdates.setState({ checking: false });
  }
}

/** Runs the periodic check while the setting is on; returns the stop function. */
export function startUpdateChecks(): () => void {
  void api
    .updateInstallKind()
    .then((kind) => useUpdates.setState({ kind }))
    .catch(() => {});
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  // One timer at a time, aimed at INTERVAL_MS after the last check, so relaunching
  // Haze often does not mean a request each time.
  const next = (minDelay: number) => {
    stop();
    const last = useUpdates.getState().checkedAt ?? 0;
    const delay = Math.max(minDelay, last + INTERVAL_MS - Date.now());
    timer = setTimeout(async () => {
      await checkForUpdates();
      next(INTERVAL_MS);
    }, delay);
  };
  const sync = (on: boolean) => (on ? next(FIRST_CHECK_MS) : stop());
  sync(useWorkspace.getState().checkUpdates);
  const unsub = useWorkspace.subscribe((s, prev) => s.checkUpdates !== prev.checkUpdates && sync(s.checkUpdates));
  return () => {
    unsub();
    stop();
  };
}
