// Rider's "Conflicts" popup: after a pull/merge/rebase stops on conflicts it lists
// the files with Accept Yours / Accept Theirs / Merge… for each. The merge
// window comes back to it after Apply; once no conflict is left it offers to
// finish what stopped (commit the merge, continue the rebase…), so the next
// step is never left to guess.
import { useEffect, useRef } from "react";
import { create } from "zustand";
import { basename, dirname } from "../lib/path";
import { runGit, useGit } from "../store/git";
import { hostPopupHere, popupClosed } from "../store/ui";
import type { Project } from "../store/workspace";
import { FileIcon } from "./FileIcon";
import { openMerge } from "./MergeView";
import { windowOf } from "./Overlays";

// `finish`: opened to finish up (from the merge window or the status bar), so
// it shows the next step even if no conflict was listed while it was open.
const useConflicts = create<{ projectId: string | null; finish: boolean }>(() => ({ projectId: null, finish: false }));

export function openConflictsDialog(projectId: string, finish = false): void {
  hostPopupHere();
  useConflicts.setState({ projectId, finish });
}

/** After the merge window applied a file: the files left, or the step that finishes the operation. */
export function afterMergeApplied(projectId: string): void {
  openConflictsDialog(projectId, true);
}

/** The button that finishes an operation once its conflicts are resolved. */
export function finishLabel(operation: string): string {
  return operation === "merge" ? "Commit Merge" : `Continue ${operation === "cherry-pick" ? "Cherry-Pick" : operation[0].toUpperCase() + operation.slice(1)}`;
}

function close() {
  useConflicts.setState({ projectId: null });
  popupClosed();
}

export async function resolveSide(projectId: string, rel: string, side: "--ours" | "--theirs"): Promise<void> {
  const out = await runGit(projectId, ["checkout", side, "--", rel], { quiet: true });
  // The file may not exist on that side (deleted there): resolve by removing it.
  if (out && !out.ok) await runGit(projectId, ["rm", "-q", "--", rel], { quiet: true });
  else await runGit(projectId, ["add", "--", rel], { quiet: true });
}

export function ConflictsDialog({ project }: { project: Project | null }) {
  const projectId = useConflicts((s) => s.projectId);
  const finish = useConflicts((s) => s.finish);
  const r = useGit((s) => (projectId ? s.repos[projectId] : undefined));
  const modal = useRef<HTMLDivElement>(null);
  const files = r?.changes.filter((c) => c.status === "conflict") ?? [];
  const shown = !!project && project.id === projectId;

  useEffect(() => {
    if (shown) windowOf(modal.current).requestAnimationFrame(() => modal.current?.focus());
  }, [shown]);
  // Everything resolved: the step that finishes the operation, or nothing
  // left to show. Only once the list has shown conflicts (or it was opened to
  // finish), since it opens before the refresh after the failed command brings them in.
  const sawConflicts = useRef(false);
  const operation = r?.branches?.operation ?? null;
  const done = shown && files.length === 0 && !r?.busy && (sawConflicts.current || finish);
  useEffect(() => {
    if (!shown) sawConflicts.current = false;
    else if (files.length > 0) sawConflicts.current = true;
    else if (done && !operation) close();
  });

  if (!shown || !r?.root) return null;
  const root = r.root;
  if (done && operation) {
    const run = (args: string[], label: string) => {
      close();
      void runGit(projectId!, args, { label });
    };
    return (
      <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
        <div ref={modal} className="modal conflicts-dialog" tabIndex={-1} onKeyDown={(e) => (e.key === "Escape" && close(), e.stopPropagation())}>
          <div className="modal-title">All conflicts are resolved</div>
          <div className="modal-message">
            {operation === "merge"
              ? "Commit the merge to finish it. Its message is the one Git prepared; to change it, commit from the Commit window instead."
              : `Continue the ${operation} to finish it.`}
          </div>
          <div className="modal-buttons">
            <button className="btn" onClick={() => run([operation, "--abort"], `Abort ${operation}`)}>
              Abort {operation}
            </button>
            <span className="run-spacer" />
            <button className="btn" onClick={close}>
              Later
            </button>
            <button className="btn primary" autoFocus onClick={() => run([operation, "--continue"], finishLabel(operation))}>
              {finishLabel(operation)}
            </button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={modal} className="modal conflicts-dialog" tabIndex={-1} onKeyDown={(e) => (e.key === "Escape" && close(), e.stopPropagation())}>
        <div className="modal-title">Conflicts</div>
        <div className="modal-message">Stopped on {files.length} file{files.length === 1 ? "" : "s"} with conflicts. Resolve them, then commit (or continue the rebase).</div>
        <div className="conflict-list">
          {files.map((c) => (
            <div key={c.rel} className="conflict-row">
              <FileIcon name={basename(c.rel)} />
              <span className="conflict-name">{basename(c.rel)}</span>
              <span className="muted small conflict-dir">{dirname(c.rel) === "." ? "" : dirname(c.rel)}</span>
              <button className="btn small" onClick={() => void resolveSide(project!.id, c.rel, "--ours")}>
                Accept Yours
              </button>
              <button className="btn small" onClick={() => void resolveSide(project!.id, c.rel, "--theirs")}>
                Accept Theirs
              </button>
              <button
                className="btn small primary"
                onClick={() => {
                  close();
                  openMerge(project!.id, { root, rel: c.rel });
                }}
              >
                Merge…
              </button>
            </div>
          ))}
        </div>
        <div className="modal-buttons">
          <button className="btn" onClick={close}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
