// Transient UI state: which popups are open. Not persisted.
import { create } from "zustand";

export type SeTab = "all" | "files" | "actions" | "text";

interface UiState {
  searchEverywhere: { open: boolean; tab: SeTab; nonce: number; query: string | null };
  findInFiles: { open: boolean; replace: boolean; initialQuery: string | null; directory: string | null; nonce: number };
}

export const useUi = create<UiState>(() => ({
  searchEverywhere: { open: false, tab: "all", nonce: 0, query: null },
  findInFiles: { open: false, replace: false, initialQuery: null, directory: null, nonce: 0 },
}));

/** `query` replaces the previous text when given (Ctrl+E passes "" to list recent files). */
export function openSearchEverywhere(tab: SeTab = "all", query: string | null = null): void {
  useUi.setState({ searchEverywhere: { open: true, tab, nonce: Date.now(), query } });
}

export function closeSearchEverywhere(): void {
  useUi.setState((s) => ({ searchEverywhere: { ...s.searchEverywhere, open: false } }));
}

export function openFindInFiles(opts: { replace?: boolean; query?: string | null; directory?: string | null } = {}): void {
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
}
