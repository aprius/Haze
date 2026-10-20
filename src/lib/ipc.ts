// Typed wrappers around the Rust commands in src-tauri/src/lib.rs.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  nestedUnder: string | null;
}

export type TextEncoding = "utf8" | "utf8-bom" | "utf16le" | "utf16be";
export type Eol = "lf" | "crlf";

export type FileContent =
  | { kind: "text"; content: string; encoding: TextEncoding; eol: Eol; mtime: number }
  | { kind: "binary"; size: number }
  | { kind: "tooLarge"; size: number };

export type WriteResult = { kind: "saved"; mtime: number } | { kind: "conflict"; mtime: number };

export type GitFileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "ignored"
  | "conflict";

export interface GitStatus {
  isRepo: boolean;
  root: string | null;
  branch: string | null;
  files: Record<string, GitFileStatus>;
}

export interface FsChange {
  root: string;
  dirs: string[];
  files: string[];
  overflow: boolean;
  git: boolean;
}

export interface SessionSpec {
  projectId: string | null;
  cwd: string;
  cols: number;
  rows: number;
  title?: string | null;
  command?: string[] | null;
  env?: [string, string][];
}

export interface SessionInfo {
  id: string;
  projectId: string | null;
  cwd: string;
  title: string;
  pid: number | null;
  createdAt: number;
  running: boolean;
  exitCode: number | null;
}

export type PtyEvent =
  | { t: "snapshot"; id: string; data: string }
  | { t: "output"; id: string; data: string }
  | { t: "exit"; id: string; code: number | null }
  | { t: "disconnected" };

export const api = {
  loadState: () => invoke<unknown>("load_state"),
  saveState: (value: unknown) => invoke<void>("save_state", { value }),

  listDir: (path: string, nest: boolean) => invoke<DirEntry[]>("list_dir", { path, nest }),
  readFile: (path: string) => invoke<FileContent>("read_file", { path }),
  writeFile: (path: string, content: string, encoding: TextEncoding, expectedMtime: number | null) =>
    invoke<WriteResult>("write_file", { path, content, encoding, expectedMtime }),
  createFile: (dir: string, name: string) => invoke<string>("create_file", { dir, name }),
  createDir: (dir: string, name: string) => invoke<string>("create_dir", { dir, name }),
  renamePath: (path: string, newName: string) => invoke<string>("rename_path", { path, newName }),
  trashPaths: (paths: string[]) => invoke<void>("trash_paths", { paths }),
  copyPaths: (sources: string[], destDir: string) => invoke<string[]>("copy_paths", { sources, destDir }),
  movePaths: (sources: string[], destDir: string) => invoke<string[]>("move_paths", { sources, destDir }),
  resolvePaths: (cwd: string, candidates: string[]) =>
    invoke<(string | null)[]>("resolve_paths", { cwd, candidates }),

  gitStatus: (dir: string) => invoke<GitStatus>("git_status", { dir }),
  watchProject: (root: string) => invoke<void>("watch_project", { root }),
  unwatchProject: (root: string) => invoke<void>("unwatch_project", { root }),

  ptyList: () => invoke<SessionInfo[]>("pty_list"),
  ptyCreate: (spec: SessionSpec) => invoke<SessionInfo>("pty_create", { spec }),
  ptyAttach: (id: string) => invoke<void>("pty_attach", { id }),
  ptyDetach: (id: string) => invoke<void>("pty_detach", { id }),
  ptyWrite: (id: string, data: string) => invoke<void>("pty_write", { id, data }),
  ptyResize: (id: string, cols: number, rows: number) => invoke<void>("pty_resize", { id, cols, rows }),
  ptyClose: (id: string) => invoke<void>("pty_close", { id }),
};

export function onFsChange(cb: (c: FsChange) => void): Promise<UnlistenFn> {
  return listen<FsChange>("fs://changed", (e) => cb(e.payload));
}

export function onPtyEvent(cb: (e: PtyEvent) => void): Promise<UnlistenFn> {
  return listen<PtyEvent>("pty://event", (e) => cb(e.payload));
}

export function errorMessage(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
}
