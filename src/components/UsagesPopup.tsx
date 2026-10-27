// Results popup for Find Usages (Alt+F7), Go to Implementation (Ctrl+Alt+B)
// and Go to Declaration (Ctrl+B, Ctrl+Click) when there is more than one, and
// for a Unity script's asset usages (scenes, prefabs, assets). Usages move to
// the Find tool window (FindPanel) to keep them ("Open in Find Window").
import { PanelBottom } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { create } from "zustand";
import { getModel, isVirtualPath } from "../lib/buffers";
import * as L from "../lib/editorLayout";
import { api, errorMessage, type AssetUsage } from "../lib/ipc";
import type { FoundLocation } from "../lib/lsp/csharp";
import { basename, dirname, relative } from "../lib/path";
import { popupClosed } from "../store/ui";
import { unityCommand, useUnity } from "../store/unity";
import { useWorkspace, type Project } from "../store/workspace";
import { CodeLine } from "./CodePreview";
import { FileIcon } from "./FileIcon";
import { openInFindWindow } from "./FindPanel";
import { hostDocument, inDoc, toast } from "./Overlays";

export interface Usage extends FoundLocation {
  text: string;
  /** Asset usages: the GameObject, and the component's id to select it in Unity. */
  object?: string | null;
  fileId?: string | null;
}

/** Viewport point in `doc`'s window, under the symbol. */
export interface UsagesAnchor {
  x: number;
  y: number;
  doc: Document;
}

interface UsagesState {
  open: boolean;
  /** The project searched: not always the main window's, from a detached editor window. */
  projectId: string | null;
  /** The window it shows in: the one it was asked from. */
  doc: Document;
  /** Declarations are listed one row per place ("Declarations of …"). */
  kind: "usages" | "declarations" | "assets";
  title: string;
  loading: boolean;
  error: string | null;
  items: Usage[];
  /** Viewport point to open under (the symbol), else centred like Search Everywhere. */
  anchor: UsagesAnchor | null;
  /** Searches again, for the Find window's Rerun. */
  rerun: (() => Promise<Usage[]>) | null;
}

const useUsages = create<UsagesState>(() => ({
  open: false,
  projectId: null,
  doc: document,
  kind: "usages",
  title: "",
  loading: false,
  error: null,
  items: [],
  anchor: null,
  rerun: null,
}));

/** Where a popup opened now shows: under the symbol's editor, else in the window last focused. */
function placed(projectId: string | null, anchor: UsagesAnchor | null) {
  return { open: true, projectId, doc: anchor?.doc ?? hostDocument(), anchor, loading: true, error: null, items: [] };
}

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
  anchor: UsagesAnchor | null = null,
): Promise<void> {
  const rerun = async () => sortUsages(await withText(await query()));
  useUsages.setState({ ...placed(project.id, anchor), kind: "usages", title, rerun });
  try {
    const found = await query();
    if (jumpIfSingle && found.length === 1) {
      close();
      useWorkspace.getState().openFile(project.id, found[0].path, { line: found[0].line, column: found[0].column });
      return;
    }
    useUsages.setState({ loading: false, items: sortUsages(await withText(found)) });
  } catch (e) {
    useUsages.setState({ loading: false, error: errorMessage(e) });
  }
}

function sortUsages(items: Usage[]): Usage[] {
  return items.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column);
}

/** Lists the declarations of `name` to choose from, titled with its kind when they agree ("Declarations of class 'Foo'"). */
export async function showDeclarations(project: Project | null, name: string, found: FoundLocation[], anchor: UsagesAnchor | null): Promise<void> {
  useUsages.setState({ ...placed(project?.id ?? null, anchor), kind: "declarations", title: `Declarations of '${name}'`, rerun: null });
  try {
    const items = (await withText(found)).sort((a, b) => basename(a.path).localeCompare(basename(b.path)) || a.path.localeCompare(b.path) || a.line - b.line);
    const kinds = new Set(items.map((u) => declKind(u.text, name)));
    const kind = kinds.size === 1 ? [...kinds][0] : undefined;
    useUsages.setState({ loading: false, items, title: kind ? `Declarations of ${kind} '${name}'` : `Declarations of '${name}'` });
  } catch (e) {
    useUsages.setState({ loading: false, error: errorMessage(e) });
  }
}

/** Lists scenes, prefabs and assets using a script or method; picking one selects it in Unity when it is linked. */
export function showAssetUsages(project: Project | null, title: string, usages: AssetUsage[], anchor: UsagesAnchor | null): void {
  const items = usages.map((u) => ({ path: u.path, line: u.line, column: 1, endLine: u.line, endColumn: 1, text: "", object: u.object, fileId: u.fileId }));
  useUsages.setState({ ...placed(project?.id ?? null, anchor), kind: "assets", title, loading: false, items, rerun: null });
}

/** What `name` is declared as on `line` ("class", "method"), as far as the text tells. */
function declKind(line: string, name: string): string | undefined {
  const n = name.replace(/\$/g, "\\$&");
  const type = new RegExp(`\\b(class|struct|interface|enum|record|delegate|namespace|trait|protocol)\\b[^;{=(]*?\\b${n}\\b`).exec(line);
  if (type) return type[1];
  // `void Save(`, `T Get<T>(`, `func save(`: the name, then its parameters.
  if (new RegExp(`\\b${n}\\s*(?:<[^>]*>)?\\s*\\(`).test(line) && !new RegExp(`\\bnew\\s+${n}\\b`).test(line)) return "method";
}

/** The usage's line coloured like the editor, indentation dropped and the usage marked. */
export function UsageCode({ usage: u }: { usage: Usage }) {
  const lead = u.text.length - u.text.trimStart().length;
  const text = u.text.slice(lead).trimEnd();
  const hl: [number, number] = u.line === u.endLine ? [u.column - 1 - lead, u.endColumn - 1 - lead] : [0, 0];
  return <CodeLine path={u.path} hash={null} line={u.line} from={lead} text={text} hl={hl} hlClass="usage-hl" />;
}

/** Adds each location's line text: from open buffers, else read from disk in one batch. */
async function withText(found: FoundLocation[]): Promise<Usage[]> {
  const byFile = new Map<string, number[]>();
  // Decompiled code not open yet has no file to read: its lines show empty.
  for (const f of found) if (!getModel(f.path) && !isVirtualPath(f.path)) byFile.set(f.path, [...(byFile.get(f.path) ?? []), f.line]);
  const files = [...byFile.keys()];
  const texts = files.length ? await api.readLines(files.map((path) => ({ path, lines: byFile.get(path)! }))) : [];
  const lookup = new Map<string, string>();
  files.forEach((path, i) => byFile.get(path)!.forEach((line, j) => lookup.set(`${path}:${line}`, texts[i][j])));
  return found.map((f) => ({ ...f, text: getModel(f.path)?.getLineContent(f.line) ?? lookup.get(`${f.path}:${f.line}`) ?? "" }));
}

/** `active`: the main window's project, for a popup not tied to one. */
export function UsagesPopup({ active }: { active: Project | null }) {
  const { open, projectId, doc, kind, title, loading, error, items, anchor, rerun } = useUsages();
  const project = useWorkspace((s) => s.projects.find((p) => p.id === projectId && p.open)) ?? active;
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  // Under the symbol, kept inside the window: above it when there is no room below.
  useLayoutEffect(() => {
    const el = popupRef.current;
    if (!el || !anchor) return;
    const win = el.ownerDocument.defaultView ?? window;
    const { width, height } = el.getBoundingClientRect();
    const below = anchor.y + 4;
    const top = below + height <= win.innerHeight - 8 ? below : Math.max(8, anchor.y - height - 24);
    el.style.left = `${Math.max(8, Math.min(anchor.x, win.innerWidth - width - 8))}px`;
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
  const unityLinked = !!useUnity.getState().projects[project.id]?.connected;
  const go = (u: Usage | undefined, openFile = false) => {
    if (!u) return;
    close();
    if (kind === "assets" && unityLinked && !openFile) {
      const name = u.object ? `${u.object} in ${basename(u.path)}` : basename(u.path);
      void unityCommand(project.id, { t: "show", path: relative(project.path, u.path).replace(/\\/g, "/"), fileId: u.fileId ?? null }).then((ok) =>
        toast(ok ? `Selected ${name} in Unity` : "Unity is not connected", ok ? "info" : "error"),
      );
      return;
    }
    useWorkspace.getState().openFile(project.id, u.path, { line: u.line, column: u.column });
  };
  const toFindWindow = () => {
    close();
    // Asked from a detached editor window: to that window's own Find window.
    const ui = useWorkspace.getState().ui[project.id];
    const win = doc !== document && ui ? L.windowOf(ui, ui.activeGroup) : null;
    openInFindWindow(project.id, title, items, rerun, win?.id ?? null);
  };
  const files = new Set(items.map((i) => i.path)).size;
  let lastFile = "";

  return inDoc(
    doc,
    <div className={"modal-backdrop se-backdrop" + (anchor ? " anchored" : "")} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={popupRef}
        className={"se-popup usages-popup" + (kind === "declarations" ? " decls-popup" : "")}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
          else if (e.key === "ArrowDown") setSelected((s) => Math.min(items.length - 1, s + 1));
          else if (e.key === "ArrowUp") setSelected((s) => Math.max(0, s - 1));
          else if (e.key === "Enter") go(items[selected], e.ctrlKey || e.metaKey);
          // Find Usages again in the popup moves the results to the Find window.
          else if (e.key === "F7" && e.altKey && kind === "usages" && !loading) toFindWindow();
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <div className="usages-title">
          <b>{title}</b>
          {(kind !== "declarations" || loading) && (
            <span className="muted small">
              {loading ? "Searching…" : kind === "usages" ? `${items.length} usage${items.length === 1 ? "" : "s"}` : `${items.length} in ${files} file(s)`}
            </span>
          )}
          {kind === "usages" && (
            <button className="icon-btn usages-to-window" disabled={loading} title="Open in Find Window (Alt+F7)" onClick={toFindWindow}>
              <PanelBottom size={15} />
            </button>
          )}
          {kind === "assets" && <span className="muted small">{unityLinked ? "Click selects it in Unity; Ctrl+click opens the file" : "Unity is not linked: opens the file"}</span>}
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
          {kind === "assets" &&
            items.map((u, i) => {
              const header = u.path !== lastFile;
              lastFile = u.path;
              return (
                <div key={`${u.path}:${u.line}:${i}`}>
                  {header && (
                    <div className="se-group">
                      <FileIcon name={basename(u.path)} /> {basename(u.path)} <span className="muted">{relative(project.path, dirname(u.path))}</span>
                    </div>
                  )}
                  <div className={"se-item usage" + (i === selected ? " selected" : "")} onMouseMove={() => setSelected(i)} onClick={(e) => go(u, e.ctrlKey || e.metaKey)}>
                    <span className="find-lineno">{u.line}</span>
                    <span className="se-line">{u.object ? <>GameObject <b>{u.object}</b></> : <span className="muted">component</span>}</span>
                  </div>
                </div>
              );
            })}
          {kind === "usages" &&
            items.map((u, i) => (
              <div
                key={`${u.path}:${u.line}:${u.column}:${i}`}
                className={"se-item usage usage-row" + (i === selected ? " selected" : "")}
                title={relative(project.path, u.path)}
                onMouseMove={() => setSelected(i)}
                onClick={() => go(u)}
              >
                <FileIcon name={basename(u.path)} />
                <span className="se-line">
                  <UsageCode usage={u} />
                </span>
                <span className="usage-where">
                  {basename(u.path)} <span className="decl-line">{u.line}</span>
                </span>
              </div>
            ))}
        </div>
      </div>
    </div>,
  );
}
