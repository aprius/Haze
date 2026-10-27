// Transient UI state: which popups are open. Not persisted.
import { create } from "zustand";
import type { DiffSpec } from "../components/DiffView";
import { hostDocument } from "../components/Overlays";
import { useWorkspace } from "./workspace";

export type SeTab = "all" | "files" | "symbols" | "actions" | "text";

interface UiState {
  searchEverywhere: { open: boolean; tab: SeTab; nonce: number; query: string | null };
  /** Search Everywhere's "Include non-solution items": ignored files (bin/, obj/, .gitignore'd) too. */
  seIncludeAll: boolean;
  findInFiles: { open: boolean; replace: boolean; initialQuery: string | null; directory: string | null; nonce: number };
  /** Project whose floating Commit window is open. */
  commitWindow: string | null;
  /** Floating diff window (Ctrl+D in the Commit window). */
  diffWindow: { projectId: string; spec: DiffSpec } | null;
  /**
   * Where Search Everywhere, Find in Files and the Git popups show: the window
   * they were opened from, and its project when that is a detached editor window.
   */
  popupHost: { doc: Document; projectId: string | null };
}

export const useUi = create<UiState>(() => ({
  searchEverywhere: { open: false, tab: "all", nonce: 0, query: null },
  seIncludeAll: false,
  findInFiles: { open: false, replace: false, initialQuery: null, directory: null, nonce: 0 },
  commitWindow: null,
  diffWindow: null,
  popupHost: { doc: document, projectId: null },
}));

/** The detached editor window showing `doc`, and its project; null for the main window. */
export function editorWindowAt(doc: Document): { projectId: string; windowId: string } | null {
  const id = doc === document ? undefined : doc.querySelector<HTMLElement>("[data-editor-window]")?.dataset.editorWindow;
  if (!id) return null;
  for (const [projectId, ui] of Object.entries(useWorkspace.getState().ui)) if (ui.windows.some((w) => w.id === id)) return { projectId, windowId: id };
  return null;
}

/** A popup opening now shows in the window last focused (see popupHost). */
export function hostPopupHere(): void {
  const doc = hostDocument();
  useUi.setState({ popupHost: { doc, projectId: editorWindowAt(doc)?.projectId ?? null } });
}

/** `query` replaces the previous text when given (Ctrl+E passes "" to list recent files). */
export function openSearchEverywhere(tab: SeTab = "all", query: string | null = null): void {
  hostPopupHere();
  useUi.setState({ searchEverywhere: { open: true, tab, nonce: Date.now(), query } });
}

/** Lets the editor take focus back after a popup closes (see EditorArea). */
export function popupClosed(): void {
  window.dispatchEvent(new Event("haze:popup-closed"));
}

export function toggleSeIncludeAll(): void {
  useUi.setState((s) => ({ seIncludeAll: !s.seIncludeAll }));
}

export function closeSearchEverywhere(): void {
  useUi.setState((s) => ({ searchEverywhere: { ...s.searchEverywhere, open: false } }));
  popupClosed();
}

export function openFindInFiles(opts: { replace?: boolean; query?: string | null; directory?: string | null } = {}): void {
  hostPopupHere();
  useUi.setState({
    findInFiles: {
      open: true,
      replace: opts.replace ?? false,
      initialQuery: opts.query ?? null,
      directory: opts.directory ?? null,
      nonce: Date.now(),
    },
  });
}

export function closeFindInFiles(): void {
  useUi.setState((s) => ({ findInFiles: { ...s.findInFiles, open: false } }));
  popupClosed();
}

/** Brings an open floating window (by its class) to the front, maybe from behind another window (see FloatWindow). */
function raiseWindow(className: string): void {
  window.dispatchEvent(new CustomEvent("haze:raise-window", { detail: className }));
}

export function openCommitWindow(projectId: string): void {
  if (useUi.getState().commitWindow === projectId) return raiseWindow("commit-window");
  useUi.setState({ commitWindow: projectId });
  // Commit window: type the message straight away.
  requestAnimationFrame(() => (document.querySelector(".commit-window .commit-message") as HTMLElement | null)?.focus());
}

export function closeCommitWindow(): void {
  useUi.setState({ commitWindow: null, diffWindow: null });
  popupClosed();
}

export function toggleCommitWindow(projectId: string): void {
  if (useUi.getState().commitWindow === projectId) closeCommitWindow();
  else openCommitWindow(projectId);
}

export function openDiffWindow(projectId: string, spec: DiffSpec): void {
  const open = !!useUi.getState().diffWindow;
  // The selected file's diff, in the window already open (raised) or a new one.
  useUi.setState({ diffWindow: { projectId, spec } });
  if (open) raiseWindow("diff-window");
}

export function closeDiffWindow(): void {
  useUi.setState({ diffWindow: null });
  // Back to the Commit window when it is still open.
  requestAnimationFrame(() => (document.querySelector(".commit-window .changes-list") as HTMLElement | null)?.focus());
}
