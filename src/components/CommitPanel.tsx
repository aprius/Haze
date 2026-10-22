// Commit window (Ctrl+K / Alt+0), like Rider's commit dialog: a floating window
// with the changes and message on the left and the selected file's diff on the
// right. Tick files, write a message, Commit or Commit and Push — no staging
// area to manage. Ctrl+D opens the diff in a floating window of its own.
import { Camera, Check, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Eye, FolderTree, RefreshCw, Undo2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { saveAll } from "./EditorArea";
import { Splitter } from "./Shell";
import { api, type GitChange } from "../lib/ipc";
import { basename, dirname } from "../lib/path";
import { FileIcon } from "./FileIcon";
import { changeDiffSpec, changeRows, GROUPS, pickRows, shownFiles, toggleChecks } from "../lib/gitView";
import { absPath, checkedPaths, createCheckpoint, patchRepo, refreshRepo, repo, runGit, toggleReviewed, useGit } from "../store/git";
import { withTask } from "../store/tasks";
import { refreshGit as refreshTreeGit } from "../store/tree";
import { closeCommitWindow, openDiffWindow, useUi } from "../store/ui";
import { useWorkspace, type Project } from "../store/workspace";
import { DiffView } from "./DiffView";
import { openMerge } from "./MergeView";
import { choose, FloatWindow, openMenu, toast } from "./Overlays";
import { openPushDialog } from "./GitDialogs";

const indent = (depth: number) => ({ paddingLeft: 26 + depth * 20 });

/** Ctrl+D: the diff in its own floating window; a conflict opens the merge tool instead. */
export function showChangeDiff(project: Project, root: string, c: GitChange): void {
  if (c.status === "conflict") {
    closeCommitWindow();
    openMerge(project.id, { root, rel: c.rel });
    return;
  }
  openDiffWindow(project.id, changeDiffSpec(root, c));
}

/** F4: jumps to the file, leaving the Commit window. */
function openChangedFile(project: Project, root: string, c: GitChange): void {
  closeCommitWindow();
  useWorkspace.getState().openFile(project.id, absPath(root, c.rel));
}

export async function commitChanges(project: Project, push: boolean): Promise<void> {
  const r = repo(project.id);
  if (!r.root) return;
  const paths = [...checkedPaths(r)];
  const message = r.message.trim();
  if (!message) return toast("Enter a commit message.", "error");
  if (!paths.length && !r.amend) return toast("No changes selected.", "error");
  // Commit what the editor shows, not stale disk content.
  await saveAll();
  patchRepo(project.id, { busy: "Committing…" });
  const out = await withTask(project.id, r.amend ? "Amending commit" : "Committing", () => api.gitCommit(r.root!, message, paths, r.amend)).catch((e) => ({ ok: false, stdout: "", stderr: String(e), code: null }));
  patchRepo(project.id, (s) => ({
    busy: null,
    console: [...s.console.slice(-199), { time: Date.now(), args: ["commit", ...(r.amend ? ["--amend"] : []), "--", ...paths], output: out }],
  }));
  refreshRepo(project.id, project.path);
  refreshTreeGit(project.id, project.path, 0);
  if (!out.ok) return toast(`Commit failed: ${(out.stderr || out.stdout).trim()}`, "error");
  patchRepo(project.id, { message: "", amend: false, checked: null });
  if (useUi.getState().commitWindow === project.id) closeCommitWindow();
  toast(`Committed ${paths.length} file(s).`);
  if (push) openPushDialog(project);
}

/** Marks a file as reviewed; the mark disappears by itself when the file changes again. */
function ReviewToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      className={"review-toggle" + (on ? " on" : "")}
      title={on ? "Reviewed — click to unmark" : "Mark as reviewed"}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      {on ? <Check size={12} /> : <Eye size={12} />}
    </button>
  );
}

function CommitPanel({ project, selected, setSelected }: { project: Project; selected: string | null; setSelected: (rel: string) => void }) {
  const r = useGit((s) => s.repos[project.id]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const byDir = useWorkspace((s) => !!s.ui[project.id]?.commitGroupByDir);
  const checked = useMemo(() => (r ? checkedPaths(r) : new Set<string>()), [r]);
  // Rows picked with Ctrl/Shift+click; the context menu and Ctrl+Alt+Z act on them.
  // `selected` (the file whose diff is shown) is always the last one clicked.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);

  useEffect(() => refreshRepo(project.id, project.path), [project.id, project.path]);

  if (!r?.root) {
    return (
      <div className="file-tree">
        <div className="panel-header">
          <span className="panel-title">Commit</span>
        </div>
        <div className="se-empty">This folder is not a git repository.</div>
      </div>
    );
  }
  const root = r.root;
  const setChecked = (paths: Set<string>) => patchRepo(project.id, { checked: [...paths] });
  const toggle = (rel: string) => {
    const next = new Set(checked);
    if (next.has(rel)) next.delete(rel);
    else next.add(rel);
    setChecked(next);
  };

  const rollback = async (changes: GitChange[]) => {
    if (!changes.length) return;
    const names = changes.length === 1 ? basename(changes[0].rel) : `${changes.length} files`;
    const created = changes.filter((c) => c.status === "added" || c.status === "untracked");
    const answer = await choose("Rollback Changes", `Revert ${names} to the last commit? Local changes will be lost.`, [
      { label: "Cancel", value: "cancel" },
      ...(created.length ? [{ label: "Rollback and delete new files", value: "delete", danger: true }] : []),
      { label: "Rollback", value: "ok", primary: !created.length, danger: !!created.length },
    ]);
    if (!answer) return;
    try {
      await saveAll();
      await api.gitRollback(root, changes.filter((c) => c.status !== "untracked").map((c) => c.rel));
      if (answer === "delete") await api.trashPaths(created.map((c) => absPath(root, c.rel)));
    } catch (e) {
      toast(`Rollback failed: ${String(e)}`, "error");
    }
    refreshRepo(project.id, project.path);
    refreshTreeGit(project.id, project.path, 0);
  };

  const rollbackChecked = () => void rollback(r.changes.filter((c) => checked.has(c.rel) && c.status !== "untracked"));

  const pickedChanges = () => r.changes.filter((c) => picked.has(c.rel));
  // Picks of files that were since committed or rolled back no longer count.
  const anyPicked = r.changes.some((c) => picked.has(c.rel));
  const isPicked = (rel: string) => (anyPicked ? picked.has(rel) : selected === rel);

  const select = (c: GitChange, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
    setSelected(c.rel);
    const shown = shownFiles(r.changes, byDir, collapsed).map((x) => x.rel);
    const next = pickRows(shown, { picked, anchor: anchor.current }, selected, c.rel, e);
    anchor.current = next.anchor;
    setPicked(next.picked);
  };

  // Several picked rows: roll those back; otherwise the checked ones, as before.
  const rollbackSelected = () => {
    const list = pickedChanges();
    if (list.length > 1) void rollback(list.filter((c) => c.status !== "untracked"));
    else rollbackChecked();
  };

  // The shortcuts shown in the menu and tooltips.
  const onListKey = (e: React.KeyboardEvent) => {
    // Keys on a focused checkbox are the checkbox's own.
    if (e.target !== e.currentTarget) return;
    const mod = e.ctrlKey || e.metaKey;
    const c = r.changes.find((x) => x.rel === selected);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const shown = shownFiles(r.changes, byDir, collapsed);
      const i = shown.findIndex((x) => x.rel === selected);
      const next = shown[Math.max(0, Math.min(shown.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next) select(next, { shiftKey: e.shiftKey, ctrlKey: false, metaKey: false });
    } else if (c && e.key === "Enter") showChangeDiff(project, root, c);
    else if (c && e.key === "F4" && c.status !== "deleted") openChangedFile(project, root, c);
    else if (c && e.key === " ") {
      // Space ticks every picked row, like the checkbox of one.
      const list = pickedChanges();
      if (list.length > 1) setChecked(toggleChecks(checked, list.map((x) => x.rel)));
      else toggle(c.rel);
    } else if (mod && e.altKey && e.code === "KeyZ") rollbackSelected();
    else if (mod && e.altKey && e.code === "KeyK") void commitChanges(project, true);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const resolveSide = async (c: GitChange, side: "--ours" | "--theirs") => {
    const out = await runGit(project.id, ["checkout", side, "--", c.rel], { quiet: true });
    // The file may not exist on that side (deleted there): resolve by removing it.
    if (out && !out.ok) await runGit(project.id, ["rm", "-q", "--", c.rel], { quiet: true });
    else await runGit(project.id, ["add", "--", c.rel], { quiet: true });
  };

  /** Menu for several picked rows. */
  const multiMenu = (list: GitChange[]) => {
    const tracked = list.filter((c) => c.status !== "untracked");
    return [
      { label: "Show Diff", shortcut: "Ctrl+D", action: () => list.forEach((c) => showChangeDiff(project, root, c)) },
      { separator: true },
      {
        label: `Rollback ${tracked.length} Files…`,
        shortcut: "Ctrl+Alt+Z",
        disabled: !tracked.length,
        action: () => void rollback(tracked),
      },
      {
        label: "Check Selected",
        action: () => setChecked(new Set([...checked, ...list.map((c) => c.rel)])),
      },
      {
        label: "Uncheck Selected",
        action: () => setChecked(new Set([...checked].filter((rel) => !picked.has(rel)))),
      },
      { separator: true },
      { label: "Copy Paths", action: () => void navigator.clipboard.writeText(list.map((c) => absPath(root, c.rel)).join("\n")) },
    ];
  };

  const menu = (c: GitChange) => [
    ...(c.status === "conflict"
      ? [
          { label: "Merge…", action: () => openMerge(project.id, { root, rel: c.rel }) },
          { label: "Accept Yours", action: () => void resolveSide(c, "--ours") },
          { label: "Accept Theirs", action: () => void resolveSide(c, "--theirs") },
          { separator: true },
        ]
      : []),
    { label: "Show Diff", shortcut: "Ctrl+D", action: () => showChangeDiff(project, root, c) },
    { label: "Open File", shortcut: "F4", disabled: c.status === "deleted", action: () => openChangedFile(project, root, c) },
    { separator: true },
    { label: "Rollback…", shortcut: "Ctrl+Alt+Z", disabled: c.status === "untracked", action: () => void rollback([c]) },
    ...(c.status === "untracked"
      ? [
          { label: "Add to VCS", action: () => void runGit(project.id, ["add", "--", c.rel]) },
          {
            label: "Add to .gitignore",
            action: () =>
              void api
                .readFile(absPath(root, ".gitignore"))
                .catch(() => ({ kind: "text" as const, content: "", encoding: "utf8" as const, eol: "lf" as const, mtime: 0 }))
                .then((f) => {
                  const cur = f.kind === "text" ? f.content : "";
                  const next = cur + (cur && !cur.endsWith("\n") ? "\n" : "") + "/" + c.rel + "\n";
                  return api.writeFile(absPath(root, ".gitignore"), next, f.kind === "text" ? f.encoding : "utf8", null);
                })
                .then(() => refreshRepo(project.id, project.path)),
          },
        ]
      : []),
    { separator: true },
    { label: "Copy Path", action: () => void navigator.clipboard.writeText(absPath(root, c.rel)) },
  ];

  return (
    <div className="file-tree commit-panel">
      <div className="panel-header slim">
        <div className="panel-actions">
          <button
            className="icon-btn"
            title="Create a checkpoint (before letting an AI agent work), to review what changed since"
            onClick={() => void createCheckpoint(project.id, project.path)}
          >
            <Camera size={14} />
          </button>
          <button
            className={"icon-btn" + (byDir ? " on" : "")}
            title="Group by Directory"
            onClick={() => useWorkspace.getState().updateUi(project.id, { commitGroupByDir: !byDir })}
          >
            <FolderTree size={14} />
          </button>
          <button className="icon-btn" title="Expand All" onClick={() => setCollapsed({})}>
            <ChevronsUpDown size={14} />
          </button>
          <button
            className="icon-btn"
            title="Collapse All"
            onClick={() => {
              const next: Record<string, boolean> = { since: true };
              for (const g of GROUPS) {
                next[g.id] = true;
                for (const row of changeRows(g.id, r.changes.filter(g.match), byDir, {})) if (row.kind === "dir") next[row.key] = true;
              }
              setCollapsed(next);
            }}
          >
            <ChevronsDownUp size={14} />
          </button>
          <button className="icon-btn" title="Refresh" onClick={() => refreshRepo(project.id, project.path)}>
            <RefreshCw size={14} />
          </button>
          <button
            className="icon-btn"
            title="Rollback selected changes, or the checked ones (Ctrl+Alt+Z)"
            onClick={rollbackSelected}
          >
            <Undo2 size={14} />
          </button>
        </div>
      </div>
      {r.branches?.operation && (
        <div className="banner warn">
          A {r.branches.operation} is in progress.
          <button className="btn small" onClick={() => void runGit(project.id, [r.branches!.operation!, "--continue"], { label: `Continue ${r.branches!.operation}` })}>
            Continue
          </button>
          <button className="btn small" onClick={() => void runGit(project.id, [r.branches!.operation!, "--abort"], { label: `Abort ${r.branches!.operation}` })}>
            Abort
          </button>
        </div>
      )}
      <div className="changes-list" tabIndex={0} onKeyDown={onListKey}>
        {r.checkpoint && (
          <div className="since-section">
            <div className="change-group">
              <span className="chevron" onClick={() => setCollapsed((c) => ({ ...c, since: !c.since }))}>
                {collapsed.since ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
              </span>
              <span className="change-group-name">Since checkpoint</span>
              <select
                className="find-select checkpoint-select"
                value={r.checkpoint}
                onChange={(e) => {
                  patchRepo(project.id, { checkpoint: e.target.value });
                  refreshRepo(project.id, project.path);
                }}
              >
                {r.checkpoints.map((c) => (
                  <option key={c.hash} value={c.hash}>
                    {c.label}
                  </option>
                ))}
              </select>
              <span className="muted small">
                {r.since.filter((f) => r.reviewed[f.rel]).length}/{r.since.length} reviewed
              </span>
              <button
                className="btn small"
                title="Delete all checkpoints"
                onClick={async () => {
                  await api.gitDeleteCheckpoints(root).catch(() => {});
                  patchRepo(project.id, { checkpoint: null, since: [], checkpoints: [] });
                }}
              >
                Clear
              </button>
            </div>
            {!collapsed.since &&
              (r.since.length === 0 ? (
                <div className="muted small since-empty">Nothing changed since this checkpoint.</div>
              ) : (
                r.since.map((f) => (
                  <div
                    key={f.rel}
                    className={"change-row git-" + (f.status === "copied" ? "added" : f.status) + (r.reviewed[f.rel] ? " reviewed" : "")}
                    onClick={() => openDiffWindow(project.id, { root, rel: f.rel, oldRel: f.oldRel, left: f.status === "added" ? null : r.checkpoint, right: "working" })}
                    title="Show what changed since the checkpoint"
                  >
                    <ReviewToggle on={!!r.reviewed[f.rel]} onToggle={() => void toggleReviewed(project.id, f.rel)} />
                    <FileIcon name={basename(f.rel)} />
                    <span className="tree-name">{basename(f.rel)}</span>
                    <span className="tree-hint">{dirname(f.rel)}</span>
                  </div>
                ))
              ))}
          </div>
        )}
        {r.changes.length === 0 && <div className="se-empty">No local changes</div>}
        {GROUPS.map((g) => {
          const items = r.changes.filter(g.match);
          if (!items.length) return null;
          const on = items.filter((c) => checked.has(c.rel)).length;
          return (
            <div key={g.id}>
              <div className="change-group">
                <span className="chevron" onClick={() => setCollapsed((c) => ({ ...c, [g.id]: !c[g.id] }))}>
                  {collapsed[g.id] ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                </span>
                <input
                  type="checkbox"
                  checked={on > 0}
                  ref={(el) => {
                    if (el) el.indeterminate = on > 0 && on < items.length;
                  }}
                  onChange={() => {
                    const next = new Set(checked);
                    items.forEach((c) => (on === items.length ? next.delete(c.rel) : next.add(c.rel)));
                    setChecked(next);
                  }}
                />
                <span className="change-group-name">{g.label}</span>
                <span className="muted small">{items.length}</span>
              </div>
              {!collapsed[g.id] &&
                changeRows(g.id, items, byDir, collapsed).map((row) => {
                  if (row.kind === "dir") {
                    const n = row.files.filter((c) => checked.has(c.rel)).length;
                    return (
                      <div key={row.key} className="change-row change-dir" style={{ paddingLeft: 6 + row.depth * 20 }} title={row.name}>
                        <span className="chevron" onClick={() => setCollapsed((c) => ({ ...c, [row.key]: !c[row.key] }))}>
                          {collapsed[row.key] ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                        </span>
                        <input
                          type="checkbox"
                          checked={n > 0}
                          ref={(el) => {
                            if (el) el.indeterminate = n > 0 && n < row.files.length;
                          }}
                          onChange={() => {
                            const next = new Set(checked);
                            row.files.forEach((c) => (n === row.files.length ? next.delete(c.rel) : next.add(c.rel)));
                            setChecked(next);
                          }}
                        />
                        <FileIcon name={row.name} isDir />
                        <span className="tree-name">{row.name}</span>
                        <span className="tree-hint">{row.files.length}</span>
                      </div>
                    );
                  }
                  const c = row.change;
                  return (
                    <div
                      key={c.rel}
                      className={"change-row git-" + c.status + (isPicked(c.rel) ? " selected" : "")}
                      style={indent(row.depth)}
                      onClick={(e) => select(c, e)}
                      onDoubleClick={() => showChangeDiff(project, root, c)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        const list = pickedChanges();
                        if (picked.has(c.rel) && list.length > 1) return openMenu(e, multiMenu(list));
                        select(c, { shiftKey: false, ctrlKey: false, metaKey: false });
                        openMenu(e, menu(c));
                      }}
                      title={c.oldRel ? `${c.oldRel} → ${c.rel}` : c.rel}
                    >
                      <input type="checkbox" checked={checked.has(c.rel)} onChange={() => toggle(c.rel)} onClick={(e) => e.stopPropagation()} />
                      <FileIcon name={basename(c.rel)} />
                      <span className={"tree-name" + (r.reviewed[c.rel] ? " reviewed-name" : "")}>{basename(c.rel)}</span>
                      <span className="tree-hint">{byDir ? "" : dirname(c.rel)}</span>
                      <ReviewToggle on={!!r.reviewed[c.rel]} onToggle={() => void toggleReviewed(project.id, c.rel)} />
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>
      <div className="commit-box">
        <textarea
          className="commit-message"
          placeholder="Commit message"
          value={r.message}
          spellCheck={false}
          onChange={(e) => patchRepo(project.id, { message: e.target.value })}
          onKeyDown={(e) => {
            const mod = e.ctrlKey || e.metaKey;
            if ((mod && e.key === "Enter") || (mod && e.altKey && e.code === "KeyK")) {
              e.preventDefault();
              void commitChanges(project, e.altKey);
            }
          }}
        />
        <div className="commit-actions">
          <label className="find-check">
            <input
              type="checkbox"
              checked={r.amend}
              onChange={async (e) => {
                const amend = e.target.checked;
                // Like Rider: amending pre-fills the last commit's message.
                let message = r.message;
                if (amend && !message.trim()) {
                  message = await api.gitCommitDetails(root, "HEAD").then((d) => d.message).catch(() => "");
                }
                patchRepo(project.id, { amend, message });
              }}
            />
            Amend
          </label>
          <span className="muted small">{checked.size} selected</span>
          <span className="run-spacer" />
          <button className="btn" disabled={!!r.busy} onClick={() => void commitChanges(project, true)} title="Commit and Push (Ctrl+Alt+K)">
            Commit and Push…
          </button>
          <button className="btn primary" disabled={!!r.busy} onClick={() => void commitChanges(project, false)} title="Commit (Ctrl+Enter)">
            {r.busy === "Committing…" ? "Committing…" : r.amend ? "Amend Commit" : "Commit"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function CommitWindow({ project }: { project: Project | null }) {
  const open = useUi((s) => s.commitWindow);
  if (!project || open !== project.id) return null;
  return <CommitWindowBody key={project.id} project={project} />;
}

function CommitWindowBody({ project }: { project: Project }) {
  const r = useGit((s) => s.repos[project.id]);
  const [selected, setSelected] = useState<string | null>(null);
  const [listWidth, setListWidth] = useState(400);
  const changes = r?.changes ?? [];
  const change = changes.find((c) => c.rel === selected) ?? null;

  // Show a diff from the start, and again once the selected file is committed or reverted.
  useEffect(() => {
    if (!change) setSelected(GROUPS.flatMap((g) => changes.filter(g.match))[0]?.rel ?? null);
  }, [change, changes]);

  const branch = r?.branches?.current ?? (r?.branches?.detached ? "detached HEAD" : null);
  return (
    <FloatWindow
      className="commit-window"
      width={1200}
      height={760}
      modal
      onClose={closeCommitWindow}
      title={
        <>
          Commit Changes{branch && <span className="muted"> — {branch}</span>}
        </>
      }
    >
      <div
        className="commit-window-body"
        onKeyDownCapture={(e) => {
          // Ctrl+D anywhere but the message (where it deletes a character on macOS).
          const mod = e.ctrlKey || e.metaKey;
          if (!(mod && !e.altKey && !e.shiftKey && e.code === "KeyD") || (e.target as HTMLElement).tagName === "TEXTAREA") return;
          if (!change || !r?.root) return;
          e.preventDefault();
          e.stopPropagation();
          showChangeDiff(project, r.root, change);
        }}
      >
        <div className="commit-window-changes" style={{ width: listWidth }}>
          <CommitPanel project={project} selected={selected} setSelected={setSelected} />
        </div>
        <Splitter vertical value={listWidth} min={260} max={900} onChange={setListWidth} />
        <div className="commit-window-diff">
          {r?.root && change && change.status !== "conflict" ? (
            <DiffView spec={changeDiffSpec(r.root, change)} />
          ) : change?.status === "conflict" ? (
            <div className="se-empty">
              {basename(change.rel)} has merge conflicts.{" "}
              <button className="btn small" onClick={() => showChangeDiff(project, r!.root!, change)}>
                Merge…
              </button>
            </div>
          ) : (
            <div className="se-empty">Select a file to see its changes.</div>
          )}
        </div>
      </div>
    </FloatWindow>
  );
}
