// Git popups: Branches (status bar / Ctrl+Shift+`), Push (Ctrl+Shift+K),
// Pull ("Pull to <branch>"), Update Project (Ctrl+T), plus branch actions shared with the Log.
import { GitBranch, Tag } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { api, errorMessage, type Branch } from "../lib/ipc";
import { validBranch } from "../lib/gitView";
import { parseWorktrees, type Worktree } from "../lib/worktrees";

export type { Worktree };
import { refreshRepo, repo, runGit, useGit } from "../store/git";
import { withTask } from "../store/tasks";
import { hostPopupHere, openCommitWindow, popupClosed } from "../store/ui";
import { useWorkspace, type Project } from "../store/workspace";
import { choose, confirmAction, openMenu, prompt, toast, windowOf, type MenuItem } from "./Overlays";
import { shortcutLabel } from "../lib/keymap";


// ------------------------------------------------------------------ branch actions

export async function checkout(project: Project, target: string, opts: { remote?: boolean } = {}): Promise<void> {
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
  if (!out?.ok) return;
  const unityRoot = await seedUnityWorktree(project, root, dir);
  openWorktree({ path: unityRoot ?? dir, branch, head: "", main: false });
}

/** A Unity project's new worktree gets the main checkout's Library, so Unity does not import everything again. */
async function seedUnityWorktree(project: Project, root: string, dir: string): Promise<string | null> {
  try {
    const seeded = await withTask(project.id, "Cloning the Unity Library", () => api.unitySeedWorktree(project.path, root, dir));
    if (seeded.cloned.length) toast(`Cloned ${seeded.cloned.join(" and ")} into the worktree: Unity opens it without importing everything again.`);
    else if (seeded.skipped) toast(`${seeded.skipped}. Unity imports the project when it first opens the worktree.`);
    return seeded.unityRoot;
  } catch (e) {
    toast(`Could not prepare the Unity project: ${errorMessage(e)}`, "error");
    return null;
  }
}

export async function newBranch(project: Project, from: string | null): Promise<void> {
  const name = await prompt(from ? `New Branch from ${from}` : "New Branch", "", { validate: validBranch, okLabel: "Create" });
  if (!name) return;
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
    if (current) {
      items.push(
        { separator: true },
        { label: `Pull into '${current}' Using Merge`, action: () => void pull(project, remote, rest.join("/"), "merge") },
        { label: `Pull into '${current}' Using Rebase`, action: () => void pull(project, remote, rest.join("/"), "rebase") },
      );
    }
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
  pull: { open: boolean; projectId: string | null };
}

const useGitDialogs = create<DialogState>(() => ({
  branches: { open: false, projectId: null },
  push: { open: false, projectId: null, branch: null },
  pull: { open: false, projectId: null },
}));

export function openBranchesPopup(project: Project): void {
  hostPopupHere();
  useGitDialogs.setState({ branches: { open: true, projectId: project.id } });
}

export function openPushDialog(project: Project, branch: string | null = null): void {
  hostPopupHere();
  useGitDialogs.setState({ push: { open: true, projectId: project.id, branch } });
}

export function openPullDialog(project: Project): void {
  hostPopupHere();
  useGitDialogs.setState({ pull: { open: true, projectId: project.id } });
}

function closePull() {
  useGitDialogs.setState({ pull: { open: false, projectId: null } });
  popupClosed();
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
      windowOf(input.current).requestAnimationFrame(() => input.current?.focus());
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
    { label: "Commit…", key: shortcutLabel("commit"), run: () => openCommitWindow(project.id) },
    { label: "Pull…", key: shortcutLabel("pull"), run: () => openPullDialog(project) },
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
    const el = (input.current?.ownerDocument ?? document).querySelector(`.branch-row[data-i="${i}"]`)?.getBoundingClientRect();
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
  const [editing, setEditing] = useState(false);

  const branchName = requested ?? r?.branches?.current ?? null;
  const branch = r?.branches?.branches.find((b) => b.kind === "local" && b.name === branchName);
  const remotes = r?.branches?.remotes ?? [];
  // A target that doesn't exist on the remote yet is tagged "New".
  const isNew = !r?.branches?.branches.some((b) => b.kind === "remote" && b.name === `${remote}/${target}`);

  useEffect(() => {
    if (!open || !r?.root || !branchName) return;
    setForce(false);
    setEditing(false);
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
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && remotes.length > 0 && !editing) void push();
          e.stopPropagation();
        }}
      >
        <div className="modal-title">Push Commits to {project.name}</div>
        {remotes.length === 0 ? (
          <div className="modal-message">This repository has no remote. Add one with `git remote add origin &lt;url&gt;`.</div>
        ) : (
          <>
            <div className="push-target">
              <GitBranch size={12} />
              <span className="push-local">{branchName}</span>
              <span className="muted">→</span>
              {remotes.length > 1 ? (
                <button
                  className="push-link"
                  title="Choose remote"
                  onClick={(e) => openMenu(e, remotes.map((x) => ({ label: x, checked: x === remote, action: () => setRemote(x) })))}
                >
                  {remote}
                </button>
              ) : (
                <span>{remote}</span>
              )}
              <span className="muted">:</span>
              {editing ? (
                <input
                  autoFocus
                  className="find-input small push-edit"
                  defaultValue={target}
                  onFocus={(e) => e.currentTarget.select()}
                  onBlur={(e) => {
                    setTarget(e.currentTarget.value.trim() || target);
                    setEditing(false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) e.currentTarget.blur();
                    if (e.key === "Escape") {
                      e.currentTarget.value = target;
                      e.currentTarget.blur();
                      e.stopPropagation();
                    }
                  }}
                />
              ) : (
                <button className="push-link" title="Click to push to another branch" onClick={() => setEditing(true)}>
                  {target}
                </button>
              )}
              {isNew && !editing && <span className="push-new">New</span>}
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
            disabled={remotes.length === 0}
            onClick={() => void push()}
          >
            {force ? "Force Push" : "Push"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Pull dialog

type PullMode = "merge" | "rebase" | "ff-only" | "no-ff" | "squash";

const pullModes: { value: PullMode; label: string; arg: string }[] = [
  { value: "merge", label: "Merge", arg: "--no-rebase" },
  { value: "rebase", label: "Rebase (--rebase)", arg: "--rebase" },
  { value: "ff-only", label: "Fast-forward only (--ff-only)", arg: "--ff-only" },
  { value: "no-ff", label: "Always create a merge commit (--no-ff)", arg: "--no-ff" },
  { value: "squash", label: "Squash commits (--squash)", arg: "--squash" },
];

let pullMode: PullMode = "merge";

/** Pulls `remote`/`branch` into the current branch; local changes are stashed and restored. */
async function pull(project: Project, remote: string, branch: string, mode: PullMode): Promise<void> {
  pullMode = mode;
  const arg = pullModes.find((m) => m.value === mode)!.arg;
  // --ff-only / --no-ff / --squash merge, so they need --no-rebase against a pull.rebase config.
  const extra = mode === "merge" || mode === "rebase" ? [arg] : ["--no-rebase", arg];
  await runGit(project.id, ["pull", "--autostash", ...extra, remote, branch], { label: `Pull ${remote}/${branch}` });
}

export function PullDialog({ project }: { project: Project | null }) {
  const { open, projectId } = useGitDialogs((s) => s.pull);
  const r = useGit((s) => (projectId ? s.repos[projectId] : undefined));
  const [remote, setRemote] = useState("origin");
  const [target, setTarget] = useState("");
  const [mode, setMode] = useState<PullMode>(pullMode);
  const [fetching, setFetching] = useState(false);
  const [commits, setCommits] = useState<Outgoing[] | null>(null);

  const current = r?.branches?.current ?? null;
  const cur = r?.branches?.branches.find((b) => b.kind === "local" && b.current);
  const remotes = r?.branches?.remotes ?? [];
  const targets = useMemo(
    () =>
      (r?.branches?.branches ?? [])
        .filter((b) => b.kind === "remote" && b.name.startsWith(`${remote}/`) && b.name !== `${remote}/HEAD`)
        .map((b) => b.name.slice(remote.length + 1)),
    [r?.branches, remote],
  );

  // The remote's branches are fetched when the dialog opens.
  useEffect(() => {
    if (!open || !r?.root || !project) return;
    const upstream = cur?.upstream ?? null;
    const rem = upstream ? upstream.split("/")[0] : (remotes[0] ?? "origin");
    setRemote(rem);
    setTarget(upstream ? upstream.split("/").slice(1).join("/") : (current ?? ""));
    setMode(pullMode);
    setFetching(true);
    void api
      .gitRun(r.root, ["fetch", "--prune", rem])
      .catch(() => null)
      .finally(() => {
        setFetching(false);
        refreshRepo(project.id, project.path);
      });
  }, [open, r?.root]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the branch valid for the chosen remote: same name, else main/master, else the first one.
  useEffect(() => {
    if (!open || targets.length === 0 || targets.includes(target)) return;
    setTarget(targets.find((t) => t === current) ?? targets.find((t) => t === "main" || t === "master") ?? targets[0]);
  }, [open, targets]); // eslint-disable-line react-hooks/exhaustive-deps

  const ref = `${remote}/${target}`;
  const known = targets.includes(target);
  useEffect(() => {
    if (!open || !r?.root || !known || fetching) return;
    // A branch picked while the previous one's log is still loading: only the latest answer shows.
    let stale = false;
    setCommits(null);
    void api
      .gitRun(r.root, ["log", "--format=%H%x1f%s", "--max-count=200", `HEAD..refs/remotes/${ref}`])
      .then((out) =>
        !stale && setCommits(
          out.stdout
            .split("\n")
            .filter(Boolean)
            .map((l) => {
              const [hash, subject] = l.split("\u001f");
              return { hash, subject };
            }),
        ),
      )
      .catch(() => !stale && setCommits([]));
    return () => {
      stale = true;
    };
  }, [open, r?.root, ref, known, fetching, r?.branches?.head]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open || !project || project.id !== projectId) return null;
  const canPull = remotes.length > 0 && !!current && !!target.trim();
  const run = () => {
    if (!canPull) return;
    closePull();
    void pull(project, remote, target.trim(), mode);
  };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && closePull()}>
      <div
        className="modal push-dialog"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Escape") closePull();
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") run();
          e.stopPropagation();
        }}
      >
        <div className="modal-title">Pull to {current ?? "(detached HEAD)"}</div>
        {remotes.length === 0 ? (
          <div className="modal-message">This repository has no remote. Add one with `git remote add origin &lt;url&gt;`.</div>
        ) : !current ? (
          <div className="modal-message">HEAD is detached. Check out a branch to pull into.</div>
        ) : (
          <>
            <div className="push-target">
              <select className="find-select" value={remote} onChange={(e) => setRemote(e.target.value)}>
                {remotes.map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
              <select className="find-select pull-branch" value={known ? target : ""} onChange={(e) => setTarget(e.target.value)}>
                {!known && <option value="">{fetching ? "Fetching…" : "No branches"}</option>}
                {targets.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
              <select className="find-select" value={mode} onChange={(e) => setMode(e.target.value as PullMode)}>
                {pullModes.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="push-commits">
              {(commits === null || fetching) && <div className="muted small">{fetching ? `Fetching ${remote}…` : "Loading…"}</div>}
              {!fetching && commits?.length === 0 && <div className="muted small">'{current}' is up to date with '{ref}'.</div>}
              {!fetching &&
                commits?.map((c) => (
                  <div key={c.hash} className="push-commit">
                    <span className="hash">{c.hash.slice(0, 8)}</span> {c.subject}
                  </div>
                ))}
            </div>
            <div className="muted small">Local changes are stashed and restored automatically.</div>
          </>
        )}
        <div className="modal-buttons">
          <button className="btn" onClick={closePull}>
            Cancel
          </button>
          <button autoFocus className="btn primary" disabled={!canPull || !known} onClick={run}>
            Pull
          </button>
        </div>
      </div>
    </div>
  );
}
