// Git popups: Branches (status bar / Ctrl+Shift+`), Push (Ctrl+Shift+K),
// Update Project (Ctrl+T), plus branch actions shared with the Log.
import { GitBranch, Tag } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { api, type Branch } from "../lib/ipc";
import { parseWorktrees, type Worktree } from "../lib/worktrees";

export type { Worktree };
import { saveAll } from "./EditorArea";
import { repo, runGit, useGit } from "../store/git";
import { popupClosed } from "../store/ui";
import { useWorkspace, type Project } from "../store/workspace";
import { choose, confirmAction, openMenu, prompt, toast, type MenuItem } from "./Overlays";
import { shortcutLabel } from "../lib/keymap";

const validBranch = (v: string) => (!v.trim() ? "Name cannot be empty" : /^-|[\s~^:?*[\\]|\.\.|@\{|\/$|\.lock$/.test(v.trim()) ? "Not a valid branch name" : null);

// ------------------------------------------------------------------ branch actions

export async function checkout(project: Project, target: string, opts: { remote?: boolean } = {}): Promise<void> {
  await saveAll();
  // A remote branch becomes a local tracking branch with the short name.
  const local = opts.remote ? target.replace(/^[^/]+\//, "") : null;
  const exists = local && repo(project.id).branches?.branches.some((b) => b.kind === "local" && b.name === local);
  const args = local && !exists ? ["checkout", "--track", target] : ["checkout", local ?? target];
  const out = await runGit(project.id, args, { label: `Checkout ${local ?? target}`, quiet: true });
  if (out && !out.ok && /would be overwritten|commit your changes or stash/i.test(out.stderr)) {
    const smart = await confirmAction(
      "Smart Checkout",
      "Local changes would be overwritten by checkout. Stash them, check out, and restore them afterwards?",
      "Smart Checkout",
    );
    if (!smart) return;
    const stash = await runGit(project.id, ["stash", "push", "--include-untracked", "-m", `Haze smart checkout to ${local ?? target}`], { quiet: true });
    if (!stash?.ok) return;
    // Nothing stashed: popping would apply an older, unrelated stash.
    const stashed = !/No local changes to save/i.test(stash.stdout + stash.stderr);
    const again = await runGit(project.id, args, { label: `Checkout ${local ?? target}`, quiet: true });
    if (stashed) await runGit(project.id, ["stash", "pop"], { label: "Restore local changes" });
    if (!again?.ok) return;
  }
  if (out?.ok) toast(`Checked out ${local ?? target}`);
}

// ------------------------------------------------------------------ worktrees

export async function listWorktrees(projectId: string): Promise<Worktree[]> {
  const root = repo(projectId).root;
  if (!root) return [];
  const out = await api.gitRun(root, ["worktree", "list", "--porcelain"]).catch(() => null);
  return out?.ok ? parseWorktrees(out.stdout) : [];
}

/** Opens a worktree as its own project (own terminals, tabs and drafts). */
export function openWorktree(w: Worktree): void {
  const ws = useWorkspace.getState();
  const id = ws.addProject(w.path);
  const base = w.path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? w.path;
  useWorkspace.setState((s) => ({
    projects: s.projects.map((p) => (p.id === id ? { ...p, name: w.branch ? `${base} [${w.branch}]` : base } : p)),
  }));
}

/** Creates a worktree with a new branch next to the repository and opens it — one per agent task. */
export async function newWorktree(project: Project, from: string | null = null): Promise<void> {
  const root = repo(project.id).root;
  if (!root) return;
  const name = await prompt(from ? `New Worktree from ${from}` : "New Worktree (new branch)", "", { validate: validBranch, okLabel: "Create" });
  if (!name) return;
  const branch = name.trim();
  const dir = `${root.replace(/[\\/]+$/, "")}-${branch.replace(/[^\w.-]+/g, "-")}`;
  const out = await runGit(project.id, ["worktree", "add", "-b", branch, dir, ...(from ? [from] : [])], { label: `Create worktree ${branch}` });
  if (out?.ok) openWorktree({ path: dir, branch, head: "", main: false });
}

export async function newBranch(project: Project, from: string | null): Promise<void> {
  const name = await prompt(from ? `New Branch from ${from}` : "New Branch", "", { validate: validBranch, okLabel: "Create" });
  if (!name) return;
  await saveAll();
  await runGit(project.id, ["checkout", "-b", name.trim(), ...(from ? [from] : [])], { label: `Create branch ${name.trim()}` });
}

function branchMenu(project: Project, b: Branch, current: string | null): MenuItem[] {
  const isCurrent = b.current;
  const items: MenuItem[] = [];
  if (b.kind !== "tag") items.push({ label: "Checkout", disabled: isCurrent, action: () => void checkout(project, b.name, { remote: b.kind === "remote" }) });
  items.push({ label: `New Branch from '${b.name}'…`, action: () => void newBranch(project, b.name) });
  items.push({ label: `New Worktree from '${b.name}'…`, action: () => void newWorktree(project, b.name) });
  if (current && !isCurrent) {
    items.push(
      { separator: true },
      { label: `Merge '${b.name}' into '${current}'`, action: () => void runGit(project.id, ["merge", "--no-edit", b.name], { label: `Merge ${b.name}` }) },
      { label: `Rebase '${current}' onto '${b.name}'`, action: () => void runGit(project.id, ["rebase", b.name], { label: `Rebase onto ${b.name}` }) },
      {
        label: `Compare with '${current}'`,
        action: () => {
          useWorkspace.getState().updateUi(project.id, { bottomVisible: true, bottomTab: "git" });
          setLogFilter(project.id, { refs: [`${current}..${b.name}`] });
        },
      },
    );
  }
  if (b.kind === "local") {
    items.push(
      { separator: true },
      { label: "Push…", action: () => openPushDialog(project, b.name) },
      {
        label: "Rename…",
        action: async () => {
          const name = await prompt("Rename Branch", b.name, { validate: validBranch, okLabel: "Rename" });
          if (name && name !== b.name) await runGit(project.id, ["branch", "-m", b.name, name.trim()], { label: "Rename branch" });
        },
      },
      {
        label: "Delete",
        danger: true,
        disabled: isCurrent,
        action: async () => {
          const out = await runGit(project.id, ["branch", "-d", b.name], { quiet: true });
          if (out && !out.ok && /not fully merged/.test(out.stderr)) {
            if (await confirmAction("Delete Branch", `'${b.name}' is not fully merged. Delete it anyway?`, "Force Delete", true)) {
              await runGit(project.id, ["branch", "-D", b.name], { label: "Delete branch" });
            }
          } else if (out?.ok) toast(`Deleted ${b.name}`);
        },
      },
    );
  } else if (b.kind === "remote") {
    const [remote, ...rest] = b.name.split("/");
    items.push(
      { separator: true },
      {
        label: "Delete on Remote",
        danger: true,
        action: async () => {
          if (await confirmAction("Delete Remote Branch", `Delete '${rest.join("/")}' on '${remote}'?`, "Delete", true)) {
            await runGit(project.id, ["push", remote, "--delete", rest.join("/")], { label: "Delete remote branch" });
          }
        },
      },
    );
  }
  return items;
}

// ------------------------------------------------------------------ log filter bridge

type LogFilterPatch = { refs?: string[]; path?: string | null };
const logFilterListeners = new Set<(projectId: string) => void>();
// Kept until the Git window takes it: it often mounts only after the filter is set.
const pendingLogFilters = new Map<string, LogFilterPatch>();

export function onLogFilter(cb: (projectId: string) => void): () => void {
  logFilterListeners.add(cb);
  return () => logFilterListeners.delete(cb);
}

export function setLogFilter(projectId: string, f: LogFilterPatch): void {
  pendingLogFilters.set(projectId, { ...pendingLogFilters.get(projectId), ...f });
  logFilterListeners.forEach((l) => l(projectId));
}

export function takeLogFilter(projectId: string): LogFilterPatch | undefined {
  const f = pendingLogFilters.get(projectId);
  pendingLogFilters.delete(projectId);
  return f;
}

// ------------------------------------------------------------------ dialogs store

interface DialogState {
  branches: { open: boolean; projectId: string | null };
  push: { open: boolean; projectId: string | null; branch: string | null };
}

const useGitDialogs = create<DialogState>(() => ({
  branches: { open: false, projectId: null },
  push: { open: false, projectId: null, branch: null },
}));

export function openBranchesPopup(project: Project): void {
  useGitDialogs.setState({ branches: { open: true, projectId: project.id } });
}

export function openPushDialog(project: Project, branch: string | null = null): void {
  useGitDialogs.setState({ push: { open: true, projectId: project.id, branch } });
}

function closeBranches() {
  useGitDialogs.setState({ branches: { open: false, projectId: null } });
  popupClosed();
}

function closePush() {
  useGitDialogs.setState({ push: { open: false, projectId: null, branch: null } });
  popupClosed();
}

let updateMode: "rebase" | "merge" = "rebase";

export async function updateProject(project: Project): Promise<void> {
  const r = repo(project.id);
  const cur = r.branches?.branches.find((b) => b.current);
  if (!cur?.upstream) return toast("The current branch has no upstream to update from.", "error");
  const mode = await choose("Update Project", `Update '${cur.name}' from '${cur.upstream}'. Local changes are stashed and restored automatically.`, [
    { label: "Cancel", value: "cancel" },
    { label: "Merge", value: "merge", primary: updateMode === "merge" },
    { label: "Rebase", value: "rebase", primary: updateMode === "rebase" },
  ]);
  if (!mode) return;
  updateMode = mode as "rebase" | "merge";
  await saveAll();
  await runGit(project.id, ["pull", "--autostash", mode === "rebase" ? "--rebase" : "--no-rebase"], { label: "Update Project" });
}

// ------------------------------------------------------------------ Branches popup

export function BranchesPopup({ project }: { project: Project | null }) {
  const { open, projectId } = useGitDialogs((s) => s.branches);
  const r = useGit((s) => (projectId ? s.repos[projectId] : undefined));
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
      requestAnimationFrame(() => input.current?.focus());
    }
  }, [open]);

  const current = r?.branches?.current ?? null;
  const rows = useMemo(() => {
    const list = (r?.branches?.branches ?? []).filter((b) => b.kind !== "tag" && b.name.toLowerCase().includes(q.toLowerCase()));
    return [...list.filter((b) => b.kind === "local"), ...list.filter((b) => b.kind === "remote")];
  }, [r, q]);

  if (!open || !project || project.id !== projectId) return null;
  const actions: { label: string; key?: string; run: () => void }[] = [
    { label: "Update Project…", key: shortcutLabel("updateProject"), run: () => void updateProject(project) },
    { label: "Commit…", key: shortcutLabel("commit"), run: () => useWorkspace.getState().updateUi(project.id, { sidebarVisible: true, sidebarTab: "commit" }) },
    { label: "Push…", key: shortcutLabel("push"), run: () => openPushDialog(project) },
    { label: "New Branch…", run: () => void newBranch(project, null) },
    { label: "New Worktree… (separate folder for a parallel task)", run: () => void newWorktree(project) },
    { label: "Fetch", run: () => void runGit(project.id, ["fetch", "--all", "--prune"], { label: "Fetch" }) },
  ].filter((a) => !q || a.label.toLowerCase().includes(q.toLowerCase()));
  const total = actions.length + rows.length;

  const activate = (i: number, anchor?: { clientX: number; clientY: number }) => {
    if (i < actions.length) {
      closeBranches();
      actions[i].run();
      return;
    }
    const b = rows[i - actions.length];
    if (!b) return;
    const el = document.querySelector(`.branch-row[data-i="${i}"]`)?.getBoundingClientRect();
    const pos = anchor ?? { clientX: (el?.right ?? 400) - 10, clientY: el?.top ?? 200 };
    const items = branchMenu(project, b, current).map((it) => (it.action ? { ...it, action: () => (closeBranches(), it.action!()) } : it));
    openMenu(pos, items);
  };

  let lastKind = "";
  return (
    <div className="modal-backdrop se-backdrop" onMouseDown={(e) => e.target === e.currentTarget && closeBranches()}>
      <div
        className="se-popup branches-popup"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Escape") closeBranches();
          else if (e.key === "ArrowDown") setSel((s) => Math.min(total - 1, s + 1));
          else if (e.key === "ArrowUp") setSel((s) => Math.max(0, s - 1));
          else if (e.key === "Enter" || e.key === "ArrowRight") activate(sel);
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <input ref={input} className="se-input" placeholder="Search branches and actions" value={q} onChange={(e) => (setQ(e.target.value), setSel(0))} />
        <div className="se-list">
          {actions.map((a, i) => (
            <div key={a.label} className={"se-item" + (sel === i ? " selected" : "")} onMouseMove={() => setSel(i)} onClick={() => activate(i)}>
              <span className="se-name">{a.label}</span>
              {a.key && <span className="se-shortcut">{a.key}</span>}
            </div>
          ))}
          {rows.map((b, j) => {
            const i = actions.length + j;
            const header = b.kind !== lastKind ? (b.kind === "local" ? "Local" : "Remote") : null;
            lastKind = b.kind;
            return (
              <div key={b.refname}>
                {header && <div className="se-group">{header}</div>}
                <div
                  data-i={i}
                  className={"se-item branch-row" + (sel === i ? " selected" : "")}
                  onMouseMove={() => setSel(i)}
                  onClick={(e) => activate(i, e)}
                >
                  <GitBranch size={13} className={b.current ? "sev-ok" : "ico"} />
                  <span className={"se-name" + (b.current ? " current-branch" : "")}>{b.name}</span>
                  {b.upstream && <span className="se-detail">{b.upstream}</span>}
                  {(b.ahead > 0 || b.behind > 0) && (
                    <span className="se-detail">
                      {b.ahead > 0 && `↑${b.ahead}`} {b.behind > 0 && `↓${b.behind}`}
                    </span>
                  )}
                  <span className="se-shortcut">›</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function BranchMenuButton({ project, branch }: { project: Project; branch: Branch }) {
  const current = useGit((s) => s.repos[project.id]?.branches?.current ?? null);
  return (
    <span
      className="branch-label"
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e, branchMenu(project, branch, current));
      }}
    >
      {branch.kind === "tag" ? <Tag size={11} /> : <GitBranch size={11} />} {branch.name}
    </span>
  );
}

export { branchMenu };

// ------------------------------------------------------------------ Push dialog

interface Outgoing {
  hash: string;
  subject: string;
}

export function PushDialog({ project }: { project: Project | null }) {
  const { open, projectId, branch: requested } = useGitDialogs((s) => s.push);
  const r = useGit((s) => (projectId ? s.repos[projectId] : undefined));
  const [commits, setCommits] = useState<Outgoing[] | null>(null);
  const [force, setForce] = useState(false);
  const [remote, setRemote] = useState("origin");
  const [target, setTarget] = useState("");

  const branchName = requested ?? r?.branches?.current ?? null;
  const branch = r?.branches?.branches.find((b) => b.kind === "local" && b.name === branchName);

  useEffect(() => {
    if (!open || !r?.root || !branchName) return;
    setForce(false);
    const upstream = branch?.upstream ?? null;
    setRemote(upstream ? upstream.split("/")[0] : (r.branches?.remotes[0] ?? "origin"));
    setTarget(upstream ? upstream.split("/").slice(1).join("/") : branchName);
    const range = upstream ? [`${upstream}..${branchName}`] : [branchName, "--not", "--remotes"];
    setCommits(null);
    void api
      .gitRun(r.root, ["log", "--format=%H%x1f%s", "--max-count=200", ...range])
      .then((out) =>
        setCommits(
          out.stdout
            .split("\n")
            .filter(Boolean)
            .map((l) => {
              const [hash, subject] = l.split("\u001f");
              return { hash, subject };
            }),
        ),
      )
      .catch(() => setCommits([]));
  }, [open, r?.root, branchName, branch?.upstream]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open || !project || project.id !== projectId || !branchName) return null;
  const push = async () => {
    closePush();
    const args = ["push", "--porcelain"];
    if (force) args.push("--force-with-lease");
    if (!branch?.upstream) args.push("--set-upstream");
    args.push(remote, `refs/heads/${branchName}:refs/heads/${target}`);
    await runGit(project.id, args, { label: `Push ${branchName}` });
  };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && closePush()}>
      <div
        className="modal push-dialog"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Escape") closePush();
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && (r?.branches?.remotes.length ?? 0) > 0) void push();
          e.stopPropagation();
        }}
      >
        <div className="modal-title">
          Push {branchName} → {remote}/{target}
        </div>
        {(r?.branches?.remotes.length ?? 0) === 0 ? (
          <div className="modal-message">This repository has no remote. Add one with `git remote add origin &lt;url&gt;`.</div>
        ) : (
          <>
            <div className="push-target">
              <select className="find-select" value={remote} onChange={(e) => setRemote(e.target.value)}>
                {r!.branches!.remotes.map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
              <input className="find-input small" value={target} onChange={(e) => setTarget(e.target.value)} />
            </div>
            <div className="push-commits">
              {commits === null && <div className="muted small">Loading…</div>}
              {commits?.length === 0 && <div className="muted small">Nothing new to push{branch?.upstream ? "" : " (new branch)"}.</div>}
              {commits?.map((c) => (
                <div key={c.hash} className="push-commit">
                  <span className="hash">{c.hash.slice(0, 8)}</span> {c.subject}
                </div>
              ))}
            </div>
            <label className="find-check">
              <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
              Force push (--force-with-lease)
            </label>
          </>
        )}
        <div className="modal-buttons">
          <button className="btn" onClick={closePush}>
            Cancel
          </button>
          <button
            autoFocus
            className={"btn " + (force ? "danger" : "primary")}
            disabled={(r?.branches?.remotes.length ?? 0) === 0}
            onClick={() => void push()}
          >
            {force ? "Force Push" : "Push"}
          </button>
        </div>
      </div>
    </div>
  );
}
