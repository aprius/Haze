// Commit tool window (Alt+0), like Rider's: tick files, write a message,
// Commit or Commit and Push — no staging area to manage.
import { ChevronDown, ChevronRight, RefreshCw, Undo2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { saveAll } from "./EditorArea";
import { api, type GitChange } from "../lib/ipc";
import { basename, dirname } from "../lib/path";
import { absPath, checkedPaths, patchRepo, refreshRepo, repo, runGit, useGit } from "../store/git";
import { refreshGit as refreshTreeGit } from "../store/tree";
import { useWorkspace, type Project } from "../store/workspace";
import { openDiff } from "./DiffView";
import { choose, openMenu, toast } from "./Overlays";
import { openPushDialog } from "./GitDialogs";

const GROUPS: { id: string; label: string; match: (c: GitChange) => boolean }[] = [
  { id: "conflicts", label: "Merge Conflicts", match: (c) => c.status === "conflict" },
  { id: "changes", label: "Changes", match: (c) => c.status !== "untracked" && c.status !== "conflict" },
  { id: "unversioned", label: "Unversioned Files", match: (c) => c.status === "untracked" },
];

export function showChangeDiff(project: Project, root: string, c: GitChange): void {
  if (c.status === "untracked" || c.status === "added") {
    useWorkspace.getState().openFile(project.id, absPath(root, c.rel), { preview: true });
    return;
  }
  openDiff(project.id, { root, rel: c.rel, oldRel: c.oldRel, left: "HEAD", right: "working" });
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
  const out = await api.gitCommit(r.root, message, paths, r.amend).catch((e) => ({ ok: false, stdout: "", stderr: String(e), code: null }));
  patchRepo(project.id, (s) => ({
    busy: null,
    console: [...s.console.slice(-199), { time: Date.now(), args: ["commit", ...(r.amend ? ["--amend"] : []), "--", ...paths], output: out }],
  }));
  refreshRepo(project.id, project.path);
  refreshTreeGit(project.id, project.path, 0);
  if (!out.ok) return toast(`Commit failed: ${(out.stderr || out.stdout).trim()}`, "error");
  patchRepo(project.id, { message: "", amend: false, checked: null });
  toast(`Committed ${paths.length} file(s).`);
  if (push) openPushDialog(project);
}

export function CommitPanel({ project }: { project: Project }) {
  const r = useGit((s) => s.repos[project.id]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const checked = useMemo(() => (r ? checkedPaths(r) : new Set<string>()), [r]);

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

  const menu = (c: GitChange) => [
    { label: "Show Diff", shortcut: "Ctrl+D", action: () => showChangeDiff(project, root, c) },
    { label: "Open File", shortcut: "F4", disabled: c.status === "deleted", action: () => useWorkspace.getState().openFile(project.id, absPath(root, c.rel)) },
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
        <span className="muted small">{r.branches?.current ? `On ${r.branches.current}` : r.branches?.detached ? "Detached HEAD" : ""}</span>
        <div className="panel-actions">
          <button className="icon-btn" title="Refresh" onClick={() => refreshRepo(project.id, project.path)}>
            <RefreshCw size={14} />
          </button>
          <button
            className="icon-btn"
            title="Rollback checked changes (Ctrl+Alt+Z)"
            onClick={() => void rollback(r.changes.filter((c) => checked.has(c.rel) && c.status !== "untracked"))}
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
      <div className="changes-list" tabIndex={0}>
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
                items.map((c) => (
                  <div
                    key={c.rel}
                    className={"change-row git-" + c.status + (selected === c.rel ? " selected" : "")}
                    onClick={() => setSelected(c.rel)}
                    onDoubleClick={() => showChangeDiff(project, root, c)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setSelected(c.rel);
                      openMenu(e, menu(c));
                    }}
                    title={c.oldRel ? `${c.oldRel} → ${c.rel}` : c.rel}
                  >
                    <input type="checkbox" checked={checked.has(c.rel)} onChange={() => toggle(c.rel)} onClick={(e) => e.stopPropagation()} />
                    <span className="tree-name">{basename(c.rel)}</span>
                    <span className="tree-hint">{dirname(c.rel)}</span>
                  </div>
                ))}
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
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
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
