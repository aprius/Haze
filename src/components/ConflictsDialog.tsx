// Rider's "Conflicts" popup: after a pull/merge/rebase stops on conflicts it lists
// the files with Accept Yours / Accept Theirs / Merge… for each.
import { useEffect, useRef } from "react";
import { create } from "zustand";
import { basename, dirname } from "../lib/path";
import { runGit, useGit } from "../store/git";
import { hostPopupHere, popupClosed } from "../store/ui";
import type { Project } from "../store/workspace";
import { FileIcon } from "./FileIcon";
import { openMerge } from "./MergeView";
import { windowOf } from "./Overlays";

const useConflicts = create<{ projectId: string | null }>(() => ({ projectId: null }));

export function openConflictsDialog(projectId: string): void {
  hostPopupHere();
  useConflicts.setState({ projectId });
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
  const r = useGit((s) => (projectId ? s.repos[projectId] : undefined));
  const modal = useRef<HTMLDivElement>(null);
  const files = r?.changes.filter((c) => c.status === "conflict") ?? [];
  const shown = !!project && project.id === projectId;

  useEffect(() => {
    if (shown) windowOf(modal.current).requestAnimationFrame(() => modal.current?.focus());
  }, [shown]);
  // Everything resolved: nothing left to show. Only once the list has shown
  // conflicts, since it opens before the refresh after the failed command brings them in.
  const sawConflicts = useRef(false);
  useEffect(() => {
    if (!shown) sawConflicts.current = false;
    else if (files.length > 0) sawConflicts.current = true;
    else if (sawConflicts.current && !r?.busy) close();
  });

  if (!shown || !r?.root) return null;
  const root = r.root;
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
