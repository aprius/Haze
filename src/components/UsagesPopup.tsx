// Results popup for Find Usages (Alt+F7), Go to Implementation (Ctrl+Alt+B)
// and Go to Declaration (Ctrl+B, Ctrl+Click) when there is more than one.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { create } from "zustand";
import { getModel } from "../lib/buffers";
import { api, errorMessage } from "../lib/ipc";
import type { FoundLocation } from "../lib/lsp/csharp";
import { basename, dirname, relative } from "../lib/path";
import { popupClosed } from "../store/ui";
import { useWorkspace, type Project } from "../store/workspace";
import { FileIcon } from "./FileIcon";

interface Usage extends FoundLocation {
  text: string;
}

interface UsagesState {
  open: boolean;
  /** Declarations are listed one row per place, like Rider's "Declarations of …" list. */
  kind: "usages" | "declarations";
  title: string;
  loading: boolean;
  error: string | null;
  items: Usage[];
  /** Viewport point to open under (the symbol), else centred like Search Everywhere. */
  anchor: { x: number; y: number } | null;
}

const useUsages = create<UsagesState>(() => ({ open: false, kind: "usages", title: "", loading: false, error: null, items: [], anchor: null }));

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
  anchor: { x: number; y: number } | null = null,
): Promise<void> {
  useUsages.setState({ open: true, kind: "usages", title, loading: true, error: null, items: [], anchor });
  try {
    const found = await query();
    if (jumpIfSingle && found.length === 1) {
      close();
      useWorkspace.getState().openFile(project.id, found[0].path, { line: found[0].line, column: found[0].column });
      return;
    }
    const items = (await withText(found)).sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
    useUsages.setState({ loading: false, items });
  } catch (e) {
    useUsages.setState({ loading: false, error: errorMessage(e) });
  }
}

/** Lists the declarations of `name` to choose from, titled with its kind when they agree ("Declarations of class 'Foo'"). */
export async function showDeclarations(name: string, found: FoundLocation[], anchor: { x: number; y: number } | null): Promise<void> {
  useUsages.setState({ open: true, kind: "declarations", title: `Declarations of '${name}'`, loading: true, error: null, items: [], anchor });
  try {
    const items = (await withText(found)).sort((a, b) => basename(a.path).localeCompare(basename(b.path)) || a.path.localeCompare(b.path) || a.line - b.line);
    const re = new RegExp(`\\b(class|struct|interface|enum|record|delegate|namespace|trait|protocol)\\b[^;{=(]*?\\b${name.replace(/\$/g, "\\$&")}\\b`);
    const kinds = new Set(items.map((u) => re.exec(u.text)?.[1]));
    const kind = kinds.size === 1 ? [...kinds][0] : undefined;
    useUsages.setState({ loading: false, items, title: kind ? `Declarations of ${kind} '${name}'` : `Declarations of '${name}'` });
  } catch (e) {
    useUsages.setState({ loading: false, error: errorMessage(e) });
  }
}

/** Adds each location's line text: from open buffers, else read from disk in one batch. */
async function withText(found: FoundLocation[]): Promise<Usage[]> {
  const byFile = new Map<string, number[]>();
  for (const f of found) if (!getModel(f.path)) byFile.set(f.path, [...(byFile.get(f.path) ?? []), f.line]);
  const files = [...byFile.keys()];
  const texts = files.length ? await api.readLines(files.map((path) => ({ path, lines: byFile.get(path)! }))) : [];
  const lookup = new Map<string, string>();
  files.forEach((path, i) => byFile.get(path)!.forEach((line, j) => lookup.set(`${path}:${line}`, texts[i][j])));
  return found.map((f) => ({ ...f, text: getModel(f.path)?.getLineContent(f.line) ?? lookup.get(`${f.path}:${f.line}`) ?? "" }));
}

export function UsagesPopup({ project }: { project: Project | null }) {
  const { open, kind, title, loading, error, items, anchor } = useUsages();
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  // Under the symbol, kept inside the window: above it when there is no room below.
  useLayoutEffect(() => {
    const el = popupRef.current;
    if (!el || !anchor) return;
    const { width, height } = el.getBoundingClientRect();
    const below = anchor.y + 4;
    const top = below + height <= window.innerHeight - 8 ? below : Math.max(8, anchor.y - height - 24);
    el.style.left = `${Math.max(8, Math.min(anchor.x, window.innerWidth - width - 8))}px`;
    el.style.top = `${top}px`;
  });

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
    <div className={"modal-backdrop se-backdrop" + (anchor ? " anchored" : "")} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={popupRef}
        className={"se-popup usages-popup" + (kind === "declarations" ? " decls-popup" : "")}
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
          {(kind === "usages" || loading) && <span className="muted small">{loading ? "Searching…" : `${items.length} in ${files} file(s)`}</span>}
        </div>
        <div className="se-list" ref={listRef} tabIndex={-1}>
          {error && <div className="se-empty error">{error}</div>}
          {!loading && !error && items.length === 0 && <div className="se-empty">Nothing found</div>}
          {kind === "declarations" &&
            items.map((u, i) => (
              <div
                key={`${u.path}:${u.line}:${u.column}:${i}`}
                className={"se-item usage decl" + (i === selected ? " selected" : "")}
                onMouseMove={() => setSelected(i)}
                onClick={() => go(u)}
              >
                <FileIcon name={basename(u.path)} />
                <span className="decl-name">
                  {basename(u.path)} <span className="decl-line">({u.line})</span>
                </span>
                <span className="decl-where">in {relative(project.path, dirname(u.path)) || basename(project.path)}</span>
              </div>
            ))}
          {kind === "usages" && items.map((u, i) => {
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
