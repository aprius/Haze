// Results popup for Find Usages (Alt+F7) and Go to Implementation (Ctrl+Alt+B).
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { getModel } from "../lib/buffers";
import { api, errorMessage } from "../lib/ipc";
import type { FoundLocation } from "../lib/lsp/csharp";
import { basename, dirname, relative } from "../lib/path";
import { popupClosed } from "../store/ui";
import { useWorkspace, type Project } from "../store/workspace";

interface Usage extends FoundLocation {
  text: string;
}

interface UsagesState {
  open: boolean;
  title: string;
  loading: boolean;
  error: string | null;
  items: Usage[];
}

const useUsages = create<UsagesState>(() => ({ open: false, title: "", loading: false, error: null, items: [] }));

function close() {
  useUsages.setState({ open: false });
  popupClosed();
}

/** Shows `query()` results; jumps straight there when there is exactly one and `jumpIfSingle`. */
export async function showLocations(
  project: Project,
  title: string,
  query: () => Promise<FoundLocation[]>,
  jumpIfSingle = false,
): Promise<void> {
  useUsages.setState({ open: true, title, loading: true, error: null, items: [] });
  try {
    const found = await query();
    if (jumpIfSingle && found.length === 1) {
      close();
      useWorkspace.getState().openFile(project.id, found[0].path, { line: found[0].line, column: found[0].column });
      return;
    }
    // Line text from open buffers, else read from disk in one batch.
    const byFile = new Map<string, number[]>();
    for (const f of found) if (!getModel(f.path)) byFile.set(f.path, [...(byFile.get(f.path) ?? []), f.line]);
    const files = [...byFile.keys()];
    const texts = files.length ? await api.readLines(files.map((path) => ({ path, lines: byFile.get(path)! }))) : [];
    const lookup = new Map<string, string>();
    files.forEach((path, i) => byFile.get(path)!.forEach((line, j) => lookup.set(`${path}:${line}`, texts[i][j])));
    const items = found
      .map((f) => ({ ...f, text: getModel(f.path)?.getLineContent(f.line) ?? lookup.get(`${f.path}:${f.line}`) ?? "" }))
      .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
    useUsages.setState({ loading: false, items });
  } catch (e) {
    useUsages.setState({ loading: false, error: errorMessage(e) });
  }
}

export function UsagesPopup({ project }: { project: Project | null }) {
  const { open, title, loading, error, items } = useUsages();
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSelected(0);
    if (open) requestAnimationFrame(() => listRef.current?.focus());
  }, [open, items]);

  useEffect(() => {
    listRef.current?.querySelector(".usage.selected")?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  if (!open || !project) return null;
  const go = (u: Usage | undefined) => {
    if (!u) return;
    close();
    useWorkspace.getState().openFile(project.id, u.path, { line: u.line, column: u.column });
  };
  const files = new Set(items.map((i) => i.path)).size;
  let lastFile = "";

  return (
    <div className="modal-backdrop se-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        className="se-popup usages-popup"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
          else if (e.key === "ArrowDown") setSelected((s) => Math.min(items.length - 1, s + 1));
          else if (e.key === "ArrowUp") setSelected((s) => Math.max(0, s - 1));
          else if (e.key === "Enter") go(items[selected]);
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <div className="usages-title">
          <b>{title}</b>
          <span className="muted small">{loading ? "Searching…" : `${items.length} in ${files} file(s)`}</span>
        </div>
        <div className="se-list" ref={listRef} tabIndex={-1}>
          {error && <div className="se-empty error">{error}</div>}
          {!loading && !error && items.length === 0 && <div className="se-empty">Nothing found</div>}
          {items.map((u, i) => {
            const header = u.path !== lastFile;
            lastFile = u.path;
            return (
              <div key={`${u.path}:${u.line}:${u.column}:${i}`}>
                {header && (
                  <div className="se-group">
                    {basename(u.path)} <span className="muted">{relative(project.path, dirname(u.path))}</span>
                  </div>
                )}
                <div className={"se-item usage" + (i === selected ? " selected" : "")} onMouseMove={() => setSelected(i)} onClick={() => go(u)}>
                  <span className="find-lineno">{u.line}</span>
                  <span className="se-line">
                    {u.line === u.endLine ? (
                      <>
                        {u.text.slice(0, u.column - 1).trimStart()}
                        <b>{u.text.slice(u.column - 1, u.endColumn - 1)}</b>
                        {u.text.slice(u.endColumn - 1)}
                      </>
                    ) : (
                      u.text.trim()
                    )}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
