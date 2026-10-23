// Check for Updates: the latest GitHub release, at most every few hours
// (Settings › Updates), or on demand. Haze only points at the release; it does not install it.
// Kept off the startup path: the first check waits until Haze has settled, the
// request runs on a Rust worker thread, and the last result is saved with the
// workspace so a relaunch shows it without asking GitHub again.
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { create } from "zustand";
import { toast } from "../components/Overlays";
import { api, errorMessage, type UpdateInfo } from "../lib/ipc";
import { useWorkspace } from "./workspace";

/** The earliest automatic check after launch. */
const FIRST_CHECK_MS = 30_000;
const INTERVAL_MS = 6 * 60 * 60 * 1000;

export const BREW_UPGRADE = "brew upgrade --cask haze";

interface UpdatesState {
  info: UpdateInfo | null;
  checking: boolean;
  error: string | null;
  checkedAt: number | null;
}

export const useUpdates = create<UpdatesState>(() => ({ info: null, checking: false, error: null, checkedAt: null }));

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
      toast(`Haze ${info.latest} is available (you have ${info.current}).`, "info", { label: "Download", run: openRelease });
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
