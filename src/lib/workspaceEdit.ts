// Applies an LSP WorkspaceEdit (rename, code actions) through editor buffers:
// every touched file is loaded into a model, edited as one undo step, and
// saved again if it had no unsaved changes before. Returns an undo function.
import { ensureBuffer, getModel, saveBuffer, useBuffers } from "./buffers";
import { uriToPath, type LspTextEdit } from "./lsp/convert";
import { monaco } from "./monaco";

interface TextDocumentEdit {
  textDocument: { uri: string };
  edits: LspTextEdit[];
}

export interface WorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: (TextDocumentEdit | { kind: string })[];
}

export interface AppliedEdit {
  files: number;
  edits: number;
  skipped: string[];
  undo(): Promise<number>;
}

export function editsByPath(edit: WorkspaceEdit): Map<string, LspTextEdit[]> {
  const out = new Map<string, LspTextEdit[]>();
  const add = (uri: string, edits: LspTextEdit[]) => {
    const path = uriToPath(uri);
    out.set(path, [...(out.get(path) ?? []), ...edits]);
  };
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) add(uri, edits);
  for (const dc of edit.documentChanges ?? []) {
    // Resource operations (create/rename/delete file) are not applied.
    if ("textDocument" in dc) add(dc.textDocument.uri, dc.edits);
  }
  return out;
}

export async function applyWorkspaceEdit(edit: WorkspaceEdit): Promise<AppliedEdit> {
  const byPath = editsByPath(edit);
  const skipped: string[] = [];
  const applied: { path: string; model: monaco.editor.ITextModel; version: number; save: boolean }[] = [];
  let count = 0;
  for (const [path, edits] of byPath) {
    await ensureBuffer(path);
    const model = getModel(path);
    const meta = useBuffers.getState().meta[path];
    if (!model || meta?.status !== "text") {
      skipped.push(path);
      continue;
    }
    const wasClean = !meta.dirty;
    model.pushStackElement();
    model.pushEditOperations(
      [],
      edits.map((e) => ({
        range: new monaco.Range(e.range.start.line + 1, e.range.start.character + 1, e.range.end.line + 1, e.range.end.character + 1),
        text: e.newText,
      })),
      () => null,
    );
    model.pushStackElement();
    count += edits.length;
    if (wasClean) await saveBuffer(path).catch(() => skipped.push(path));
    applied.push({ path, model, version: model.getAlternativeVersionId(), save: wasClean });
  }
  return {
    files: applied.length,
    edits: count,
    skipped,
    async undo() {
      let failed = 0;
      for (const a of applied) {
        if (a.model.isDisposed() || a.model.getAlternativeVersionId() !== a.version) {
          failed++;
          continue;
        }
        a.model.undo();
        if (a.save) await saveBuffer(a.path).catch(() => failed++);
      }
      return failed;
    },
  };
}
