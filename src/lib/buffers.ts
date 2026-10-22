// Open file buffers. Text lives in Monaco models (kept here, outside React);
// the metadata the UI renders lives in a small zustand store.
//
// Rules (from the "no silent overwrite" principle):
// - a clean buffer follows the disk automatically;
// - a dirty buffer is never replaced; it gets a "changed on disk" notice;
// - saving refuses to overwrite a file that changed since it was loaded.
import { create } from "zustand";
import { api, errorMessage, type Eol, type FileContent, type TextEncoding } from "./ipc";
import { languageFor, monaco } from "./monaco";

export type BufferMeta =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "binary"; size: number }
  | { status: "tooLarge"; size: number }
  | {
      status: "text";
      encoding: TextEncoding;
      eol: Eol;
      mtime: number;
      dirty: boolean;
      /** Disk changed under a dirty buffer, or a save hit a conflict. */
      diskChanged: boolean;
      saving: boolean;
    };

export const useBuffers = create<{ meta: Record<string, BufferMeta> }>(() => ({ meta: {} }));

/** Whether a buffer holds unsaved edits. */
export function metaDirty(meta: BufferMeta | undefined): boolean {
  return meta?.status === "text" && meta.dirty;
}

interface Entry {
  model: monaco.editor.ITextModel;
  /** Alternative version id at the last load/save, to compute dirtiness. */
  savedVersion: number;
}

const models = new Map<string, Entry>();
const loading = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

/** Called whenever drafts change, so persistence can save them. */
export function onDraftsChanged(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function setMeta(path: string, meta: BufferMeta | ((m: BufferMeta | undefined) => BufferMeta)) {
  useBuffers.setState((s) => ({
    meta: { ...s.meta, [path]: typeof meta === "function" ? meta(s.meta[path]) : meta },
  }));
}

function patchText(path: string, patch: Partial<Extract<BufferMeta, { status: "text" }>>) {
  setMeta(path, (m) => (m && m.status === "text" ? { ...m, ...patch } : (m ?? { status: "loading" })));
}

export function getModel(path: string): monaco.editor.ITextModel | null {
  return models.get(path)?.model ?? null;
}

function uriFor(path: string): monaco.Uri {
  return monaco.Uri.file(path);
}

function isDirty(path: string): boolean {
  const e = models.get(path);
  return !!e && e.model.getAlternativeVersionId() !== e.savedVersion;
}

function trackDirty(path: string, model: monaco.editor.ITextModel) {
  model.onDidChangeContent(() => {
    const dirty = isDirty(path);
    const m = useBuffers.getState().meta[path];
    if (m?.status === "text" && m.dirty !== dirty) patchText(path, { dirty });
    listeners.forEach((l) => l());
  });
}

/** Loads a file into a model once. A `draft` (recovered unsaved text) is applied on top. */
export function ensureBuffer(path: string, draft?: { content: string; baseMtime: number }): Promise<void> {
  const existing = models.get(path);
  if (existing) {
    // Loaded earlier without its draft (a replace or rename touched the file first).
    const meta = useBuffers.getState().meta[path];
    if (draft && meta?.status === "text" && !isDirty(path) && draft.content !== existing.model.getValue()) {
      existing.model.pushEditOperations([], [{ range: existing.model.getFullModelRange(), text: draft.content }], () => null);
      patchText(path, { diskChanged: draft.baseMtime !== meta.mtime });
    }
    return Promise.resolve();
  }
  const pending = loading.get(path);
  if (pending) return pending.then(() => (draft ? ensureBuffer(path, draft) : undefined));
  setMeta(path, { status: "loading" });
  const p = (async () => {
    try {
      const file = await api.readFile(path);
      if (file.kind === "binary") return setMeta(path, { status: "binary", size: file.size });
      if (file.kind === "tooLarge") return setMeta(path, { status: "tooLarge", size: file.size });
      const model = monaco.editor.createModel(file.content, languageFor(path), uriFor(path));
      model.setEOL(file.eol === "crlf" ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
      const entry: Entry = { model, savedVersion: model.getAlternativeVersionId() };
      models.set(path, entry);
      let diskChanged = false;
      if (draft && draft.content !== file.content) {
        model.setValue(draft.content);
        diskChanged = draft.baseMtime !== file.mtime;
      }
      trackDirty(path, model);
      setMeta(path, {
        status: "text",
        encoding: file.encoding,
        eol: file.eol,
        mtime: file.mtime,
        dirty: isDirty(path),
        diskChanged,
        saving: false,
      });
    } catch (e) {
      if (draft && !monaco.editor.getModel(uriFor(path))) {
        // The file is gone (an agent moved or deleted it): keep the unsaved text; saving recreates the file.
        const model = monaco.editor.createModel(draft.content, languageFor(path), uriFor(path));
        models.set(path, { model, savedVersion: -1 });
        trackDirty(path, model);
        const eol = model.getEOL() === "\r\n" ? "crlf" : "lf";
        setMeta(path, { status: "text", encoding: "utf8", eol, mtime: 0, dirty: true, diskChanged: true, saving: false });
        return;
      }
      setMeta(path, { status: "error", message: errorMessage(e) });
    } finally {
      loading.delete(path);
    }
  })();
  loading.set(path, p);
  return p;
}

export async function saveBuffer(path: string, opts: { force?: boolean } = {}): Promise<boolean> {
  const entry = models.get(path);
  const meta = useBuffers.getState().meta[path];
  if (!entry || meta?.status !== "text") return false;
  const version = entry.model.getAlternativeVersionId();
  patchText(path, { saving: true });
  try {
    const res = await api.writeFile(path, entry.model.getValue(), meta.encoding, opts.force ? null : meta.mtime);
    if (res.kind === "conflict") {
      patchText(path, { saving: false, diskChanged: true });
      return false;
    }
    entry.savedVersion = version;
    patchText(path, { saving: false, mtime: res.mtime, dirty: isDirty(path), diskChanged: false });
    listeners.forEach((l) => l());
    return true;
  } catch (e) {
    patchText(path, { saving: false });
    throw e;
  }
}

let reloading = false;

/** True while a buffer is being replaced by the disk content (not an edit by the user). */
export function reloadingFromDisk(): boolean {
  return reloading;
}

/** Replaces the buffer with the disk content (`file`, when just read), discarding local edits. */
export async function reloadBuffer(path: string, read?: FileContent): Promise<void> {
  const entry = models.get(path);
  if (!entry) return;
  const file = read ?? (await api.readFile(path));
  if (file.kind !== "text") {
    disposeBuffer(path);
    setMeta(path, file.kind === "binary" ? { status: "binary", size: file.size } : { status: "tooLarge", size: file.size });
    return;
  }
  reloading = true;
  try {
    if (entry.model.getValue() !== file.content) {
      // pushEditOperations keeps undo history, so a reload can be undone.
      entry.model.pushEditOperations([], [{ range: entry.model.getFullModelRange(), text: file.content }], () => null);
    }
    // Line endings can change on disk too (checkout with autocrlf); saving must keep the new ones.
    const eol = file.eol === "crlf" ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF;
    if (entry.model.getEndOfLineSequence() !== eol) entry.model.pushEOL(eol);
  } finally {
    reloading = false;
  }
  entry.savedVersion = entry.model.getAlternativeVersionId();
  patchText(path, { mtime: file.mtime, encoding: file.encoding, eol: file.eol, dirty: false, diskChanged: false });
  listeners.forEach((l) => l());
}

/** Reacts to files changed on disk (from the watcher). */
export async function handleDiskChanges(paths: string[] | "all"): Promise<void> {
  const targets = paths === "all" ? [...models.keys()] : paths.filter((p) => models.has(p));
  for (const path of targets) {
    const meta = useBuffers.getState().meta[path];
    if (meta?.status !== "text" || meta.saving) continue;
    let file;
    try {
      file = await api.readFile(path);
    } catch {
      // Deleted or unreadable: keep the buffer; saving will recreate the file.
      continue;
    }
    if (file.kind !== "text" || file.mtime === meta.mtime) continue;
    if (isDirty(path)) {
      if (file.content !== models.get(path)?.model.getValue()) patchText(path, { diskChanged: true });
    } else {
      // Applied right away: reading the file again would leave room for a keystroke to be overwritten.
      await reloadBuffer(path, file);
    }
  }
}

export function disposeBuffer(path: string): void {
  const e = models.get(path);
  if (e) {
    e.model.dispose();
    models.delete(path);
  }
  useBuffers.setState((s) => {
    const meta = { ...s.meta };
    delete meta[path];
    return { meta };
  });
  listeners.forEach((l) => l());
}

/** Moves a buffer to a new path after a rename in the tree. */
export function renameBuffer(from: string, to: string): void {
  // Moving into the folder it is already in: creating a model for the same URI would throw.
  if (from === to) return;
  for (const [path, entry] of [...models.entries()]) {
    const target =
      path === from
        ? to
        : path.startsWith(from + "/") || path.startsWith(from + "\\")
          ? to + path.slice(from.length)
          : null;
    if (!target) continue;
    const meta = useBuffers.getState().meta[path];
    const model = monaco.editor.createModel(entry.model.getValue(), languageFor(target), uriFor(target));
    model.setEOL(entry.model.getEndOfLineSequence());
    const dirty = isDirty(path);
    entry.model.dispose();
    models.delete(path);
    models.set(target, { model, savedVersion: dirty ? -1 : model.getAlternativeVersionId() });
    trackDirty(target, model);
    useBuffers.setState((s) => {
      const m = { ...s.meta };
      delete m[path];
      if (meta) m[target] = meta;
      return { meta: m };
    });
  }
}

export function dirtyPaths(): string[] {
  return [...models.keys()].filter(isDirty);
}

/** Unsaved text for persistence: path -> { content, baseMtime }. */
export function collectDrafts(): Record<string, { content: string; baseMtime: number }> {
  const out: Record<string, { content: string; baseMtime: number }> = {};
  for (const path of dirtyPaths()) {
    const meta = useBuffers.getState().meta[path];
    out[path] = {
      content: models.get(path)!.model.getValue(),
      baseMtime: meta?.status === "text" ? meta.mtime : 0,
    };
  }
  return out;
}
