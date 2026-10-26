// Saves the workspace (and unsaved drafts) to disk, debounced, and restores
// it at startup.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { collectDrafts, ensureBuffer, getModel, isVirtualPath, onDraftsChanged } from "../lib/buffers";
import { api } from "../lib/ipc";
import { closeTabs, MAIN_GROUP, normalizeEditors, type EditorTab } from "../lib/editorLayout";
import { restoreUpdateCheck, savedUpdateCheck, useUpdates, type SavedUpdateCheck } from "./updates";
import { defaultUi, useWorkspace, type PerfContextMode, type Project, type ProjectUi } from "./workspace";

const VERSION = 1;

interface Persisted {
  version: number;
  projects: Project[];
  activeProjectId: string | null;
  ui: Record<string, ProjectUi>;
  drafts: Record<string, { content: string; baseMtime: number }>;
  nestFiles: boolean;
  selectOpenedFile?: boolean;
  stickyScroll?: boolean;
  lineBlame?: boolean;
  codeVision?: boolean;
  rainbowBrackets?: boolean;
  rainbowGuides?: boolean;
  notifyAgents?: boolean;
  unityAutoRefresh?: boolean;
  unityPerfContext?: PerfContextMode;
  unityPerfHints?: boolean;
  checkUpdates?: boolean;
  updateCheck?: SavedUpdateCheck;
}

/** Drafts restored from the last run, consumed when their tab first opens. */
export const recoveredDrafts = new Map<string, { content: string; baseMtime: number }>();

let timer: ReturnType<typeof setTimeout> | null = null;

function snapshot(): Persisted {
  const s = useWorkspace.getState();
  // Drafts of tabs not reopened yet must survive another restart too.
  const drafts = { ...Object.fromEntries(recoveredDrafts), ...collectDrafts() };
  return {
    version: VERSION,
    projects: s.projects,
    activeProjectId: s.activeProjectId,
    ui: s.ui,
    drafts,
    nestFiles: s.nestFiles,
    selectOpenedFile: s.selectOpenedFile,
    stickyScroll: s.stickyScroll,
    lineBlame: s.lineBlame,
    codeVision: s.codeVision,
    rainbowBrackets: s.rainbowBrackets,
    rainbowGuides: s.rainbowGuides,
    notifyAgents: s.notifyAgents,
    unityAutoRefresh: s.unityAutoRefresh,
    unityPerfContext: s.unityPerfContext,
    unityPerfHints: s.unityPerfHints,
    checkUpdates: s.checkUpdates,
    updateCheck: savedUpdateCheck(),
  };
}

let saving: Promise<unknown> = Promise.resolve();

export function flush(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  // One save at a time, each taking its snapshot when it starts: overlapping
  // saves (debounced + on close) could otherwise land older state last.
  const next = saving.then(() => api.saveState(snapshot()));
  saving = next.catch(() => {});
  return next;
}

function schedule() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void flush().catch(console.error), 400);
}

let restoring: Promise<void> | null = null;

export function restore(): Promise<void> {
  restoring ??= doRestore();
  return restoring;
}

async function doRestore(): Promise<void> {
  let data: Partial<Persisted> | null = null;
  try {
    data = (await api.loadState()) as Partial<Persisted> | null;
  } catch (e) {
    console.error("loading workspace failed", e);
  }
  if (data && data.version === VERSION) {
    const ui: Record<string, ProjectUi> = {};
    for (const p of data.projects ?? []) {
      const saved = (data.ui?.[p.id] ?? {}) as Partial<ProjectUi> & { tabs?: EditorTab[]; activeTab?: string | null };
      const { tabs: oldTabs, activeTab: oldActive, ...rest } = saved;
      ui[p.id] = { ...defaultUi(), ...rest };
      // Before editor splits: one list of tabs, now the main window's group.
      if (!saved.groups && oldTabs) ui[p.id].groups = [{ id: MAIN_GROUP, tabs: oldTabs, activeTab: oldActive ?? null }];
      Object.assign(ui[p.id], normalizeEditors(ui[p.id]));
      // Decompiled code is read from the C# server, which is not up yet: those tabs are not reopened.
      const virtual = ui[p.id].groups.flatMap((g) => g.tabs.map((t) => t.path)).filter(isVirtualPath);
      if (virtual.length) Object.assign(ui[p.id], closeTabs(ui[p.id], virtual));
      // The terminal used to share the bottom panel.
      if ((ui[p.id].bottomTab as string) === "terminal") ui[p.id].bottomTab = "build";
      // Find results are not kept.
      if (ui[p.id].bottomTab === "find") ui[p.id].bottomTab = "build";
    }
    for (const [path, d] of Object.entries(data.drafts ?? {})) recoveredDrafts.set(path, d);
    // Load every draft now, not when its tab is first shown: background tabs
    // then show as unsaved, Save All includes them, and closing one asks first.
    // The draft stays listed until its buffer holds it, so a save meanwhile keeps it.
    for (const [path, d] of recoveredDrafts) {
      void ensureBuffer(path, d).finally(() => {
        if (getModel(path) && recoveredDrafts.get(path) === d) recoveredDrafts.delete(path);
      });
    }
    useWorkspace.setState({
      projects: data.projects ?? [],
      activeProjectId: data.activeProjectId ?? null,
      ui,
      nestFiles: data.nestFiles ?? true,
      selectOpenedFile: data.selectOpenedFile ?? true,
      stickyScroll: data.stickyScroll ?? true,
      lineBlame: data.lineBlame ?? true,
      codeVision: data.codeVision ?? true,
      rainbowBrackets: data.rainbowBrackets ?? true,
      rainbowGuides: data.rainbowGuides ?? true,
      notifyAgents: data.notifyAgents ?? true,
      unityAutoRefresh: data.unityAutoRefresh ?? true,
      unityPerfContext: data.unityPerfContext ?? "everywhere",
      unityPerfHints: data.unityPerfHints ?? true,
      checkUpdates: data.checkUpdates ?? true,
    });
    restoreUpdateCheck(data.updateCheck);
  }
  useWorkspace.setState({ loaded: true });

  useWorkspace.subscribe(schedule);
  onDraftsChanged(schedule);
  useUpdates.subscribe((s, prev) => s.checkedAt !== prev.checkedAt && schedule());
  await getCurrentWindow().onCloseRequested(async () => {
    await flush().catch(console.error);
  });
}
