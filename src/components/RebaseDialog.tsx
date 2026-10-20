// Interactive rebase dialog: reorder commits and pick, reword, squash,
// fixup, edit or drop each, then run it without any text editor.
import { ArrowDown, ArrowUp } from "lucide-react";
import { useEffect, useState } from "react";
import { create } from "zustand";
import { api, errorMessage, type RebaseStep } from "../lib/ipc";
import { saveAll } from "./EditorArea";
import { patchRepo, refreshRepo, repo } from "../store/git";
import { popupClosed } from "../store/ui";
import { useWorkspace, type Project } from "../store/workspace";
import { toast } from "./Overlays";

interface Row {
  hash: string;
  subject: string;
  action: RebaseStep["action"];
  message: string;
}

const useRebase = create<{ projectId: string | null; from: string | null }>(() => ({ projectId: null, from: null }));

/** Opens the dialog for commits from `from` (inclusive) up to HEAD. */
export function openRebaseDialog(project: Project, from: string): void {
  useRebase.setState({ projectId: project.id, from });
}

function close() {
  useRebase.setState({ projectId: null, from: null });
  popupClosed();
}

const ACTIONS: RebaseStep["action"][] = ["pick", "reword", "edit", "squash", "fixup", "drop"];

export function RebaseDialog({ project }: { project: Project | null }) {
  const { projectId, from } = useRebase();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [base, setBase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const root = projectId ? repo(projectId).root : null;

  useEffect(() => {
    if (!root || !from) return;
    setRows(null);
    setError(null);
    void (async () => {
      try {
        // Oldest first, like the rebase todo; the selected commit's parent is the base.
        const parent = await api.gitRun(root, ["rev-parse", "--verify", "-q", `${from}^`]);
        const b = parent.ok ? parent.stdout.trim() : null;
        setBase(b);
        const range = b ? [`${b}..HEAD`] : ["HEAD"];
        const merges = await api.gitRun(root, ["rev-list", "--merges", "--count", ...range]);
        if (merges.ok && merges.stdout.trim() !== "0") throw new Error("The range contains merge commits; interactive rebase would flatten them.");
        const out = await api.gitRun(root, ["log", "--reverse", "--format=%H%x1f%s%x1f%B%x1e", ...range]);
        if (!out.ok) throw new Error(out.stderr);
        setRows(
          out.stdout
            .split("\u001e")
            .map((r) => r.replace(/^\n/, ""))
            .filter(Boolean)
            .map((r) => {
              const [hash, subject, body] = r.split("\u001f");
              return { hash, subject, action: "pick" as const, message: (body ?? subject).trim() };
            }),
        );
      } catch (e) {
        setError(errorMessage(e));
      }
    })();
  }, [root, from]);

  if (!project || project.id !== projectId || !from) return null;
  const set = (i: number, patch: Partial<Row>) => setRows((rs) => rs && rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const move = (i: number, d: number) =>
    setRows((rs) => {
      if (!rs || i + d < 0 || i + d >= rs.length) return rs;
      const next = [...rs];
      [next[i], next[i + d]] = [next[i + d], next[i]];
      return next;
    });
  const firstKept = rows?.find((r) => r.action !== "drop");
  const invalid =
    !rows || !firstKept ? "Nothing to rebase" : firstKept.action === "squash" || firstKept.action === "fixup" ? "The first commit cannot be squashed or fixed up." : null;

  const start = async () => {
    if (!rows || !root || invalid) return;
    close();
    await saveAll();
    patchRepo(project.id, { busy: "Rebasing…" });
    const steps: RebaseStep[] = rows.map((r) => ({ action: r.action, hash: r.hash, message: r.action === "reword" ? r.message : null }));
    const out = await api.gitRebaseInteractive(root, base, steps).catch((e) => ({ ok: false, stdout: "", stderr: errorMessage(e), code: null }));
    patchRepo(project.id, (s) => ({
      busy: null,
      console: [...s.console.slice(-199), { time: Date.now(), args: ["rebase", "-i", base ?? "--root"], output: out }],
    }));
    refreshRepo(project.id, project.path);
    const text = out.stdout + out.stderr;
    if (out.ok) toast("Rebase finished.");
    else if (/CONFLICT|could not apply/.test(text)) {
      useWorkspace.getState().updateUi(project.id, { sidebarVisible: true, sidebarTab: "commit" });
      toast("Rebase stopped on conflicts — resolve them in the Commit window, then Continue.", "error");
    } else if (/Stopped at/.test(text)) toast("Rebase stopped for editing — amend, then Continue in the Commit window.");
    else toast(`Rebase failed: ${text.trim().split("\n").slice(-2).join(" ")}`, "error");
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal rebase-dialog" tabIndex={-1} onKeyDown={(e) => (e.key === "Escape" && close(), e.stopPropagation())}>
        <div className="modal-title">Interactive Rebase from {from.slice(0, 8)}</div>
        {error && <div className="modal-error">{error}</div>}
        {!rows && !error && <div className="muted small">Loading…</div>}
        <div className="rebase-rows">
          {rows?.map((r, i) => (
            <div key={r.hash} className={"rebase-row" + (r.action === "drop" ? " dropped" : "")}>
              <select className="find-select" value={r.action} onChange={(e) => set(i, { action: e.target.value as Row["action"] })}>
                {ACTIONS.map((a) => (
                  <option key={a}>{a}</option>
                ))}
              </select>
              <span className="hash">{r.hash.slice(0, 8)}</span>
              {r.action === "reword" ? (
                <input className="find-input small rebase-msg" value={r.message} onChange={(e) => set(i, { message: e.target.value })} />
              ) : (
                <span className="rebase-subject">{r.subject}</span>
              )}
              <button className="icon-btn" title="Move up" onClick={() => move(i, -1)}>
                <ArrowUp size={13} />
              </button>
              <button className="icon-btn" title="Move down" onClick={() => move(i, 1)}>
                <ArrowDown size={13} />
              </button>
            </div>
          ))}
        </div>
        <div className="muted small">Oldest at the top. squash/fixup merge a commit into the one above it.</div>
        {invalid && rows && <div className="modal-error">{invalid}</div>}
        <div className="modal-buttons">
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" disabled={!!invalid} onClick={() => void start()}>
            Start Rebasing
          </button>
        </div>
      </div>
    </div>
  );
}
