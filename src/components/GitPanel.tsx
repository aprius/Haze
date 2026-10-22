// Git tool window (Alt+9): branches, log with commit graph, commit details,
// and a console of the git commands Haze ran.
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Copy, Folder, FolderGit2, FolderTree, GitBranch, RefreshCw, Tag, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage, type Branch, type Commit, type CommitDetails, type GraphRow, type LogPage, type LogQuery } from "../lib/ipc";
import { branchTree, changeRows, type BranchFolder } from "../lib/gitView";
import { basename, dirname } from "../lib/path";
import { FileIcon } from "./FileIcon";
import { repo, runGit, useGit } from "../store/git";
import { useWorkspace, type Project } from "../store/workspace";
import { openDiff } from "./DiffView";
import { branchMenu, checkout, listWorktrees, newBranch, newWorktree, onLogFilter, openWorktree, setLogFilter, takeLogFilter, type Worktree } from "./GitDialogs";
import { choose, confirmAction, openMenu, prompt, toast } from "./Overlays";
import { openRebaseDialog } from "./RebaseDialog";
import { ToolTabs } from "./BuildPanel";
import { Splitter } from "./Shell";

const ROW_H = 22;
const LANE_W = 14;
const PAGE = 1000;
// Monokai Pro accents from styles.css, so the graph follows the light / dark filter.
const COLORS = ["cyan", "orange", "green", "purple", "red", "yellow"].map((c) => `var(--mk-${c})`);
const colorOf = (c: number) => COLORS[c % COLORS.length];

/** A Git tool window pane size, kept per project like the other panes. */
function usePaneSize(project: Project, key: "gitBranchesWidth" | "gitDetailsWidth" | "gitStashListWidth" | "gitMetaHeight") {
  const value = useWorkspace((s) => s.ui[project.id]?.[key]);
  return [value, (v: number) => useWorkspace.getState().updateUi(project.id, { [key]: v })] as const;
}

function formatDate(t: number): string {
  const d = new Date(t * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? `Today ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
    : d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

/** Commit graph for the visible rows, drawn as one SVG. */
function Graph({ rows, first, last, width }: { rows: GraphRow[]; first: number; last: number; width: number }) {
  const x = (lane: number) => lane * LANE_W + LANE_W / 2 + 4;
  const y = (i: number) => i * ROW_H + ROW_H / 2;
  const paths: React.ReactNode[] = [];
  const nodes: React.ReactNode[] = [];
  for (let i = Math.max(0, first - 1); i < Math.min(rows.length, last + 1); i++) {
    const r = rows[i];
    for (const e of r.edges) {
      const x1 = x(e.from);
      const x2 = x(e.to);
      const y1 = y(i);
      const y2 = y(i + 1);
      const d = x1 === x2 ? `M${x1},${y1}L${x2},${y2}` : `M${x1},${y1}C${x1},${y1 + ROW_H * 0.6} ${x2},${y2 - ROW_H * 0.6} ${x2},${y2}`;
      paths.push(<path key={`${i}-${e.from}-${e.to}`} d={d} style={{ stroke: colorOf(e.color) }} strokeWidth={1.6} fill="none" />);
    }
    if (i >= first && i < last) {
      nodes.push(<circle key={`n${i}`} cx={x(r.lane)} cy={y(i)} r={3.6} style={{ fill: colorOf(r.color) }} stroke="var(--editor-bg)" strokeWidth={1.2} />);
    }
  }
  return (
    <svg className="log-graph" width={width} height={rows.length * ROW_H} style={{ width }}>
      {paths}
      {nodes}
    </svg>
  );
}

function RefBadges({ refs, branches }: { refs: string[]; branches: Branch[] }) {
  return (
    <>
      {refs.map((r) => {
        const head = r.startsWith("HEAD -> ");
        const name = head ? r.slice(8) : r.replace(/^tag: /, "");
        const tag = r.startsWith("tag: ");
        const remote = !head && !tag && branches.some((b) => b.kind === "remote" && b.name === name);
        return (
          <span key={r} className={"ref-badge" + (head ? " head" : tag ? " tag" : remote ? " remote" : "")}>
            {tag ? <Tag size={10} /> : <GitBranch size={10} />}
            {name}
          </span>
        );
      })}
    </>
  );
}

function Details({ project, root, hash }: { project: Project; root: string; hash: string }) {
  const [d, setD] = useState<CommitDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const byDir = useWorkspace((s) => s.ui[project.id]?.logGroupByDir ?? true);
  const [metaHeight, setMetaHeight] = usePaneSize(project, "gitMetaHeight");
  useEffect(() => {
    let stale = false;
    setD(null);
    setError(null);
    setCollapsed({});
    api
      .gitCommitDetails(root, hash)
      .then((x) => !stale && setD(x))
      .catch((e) => !stale && setError(errorMessage(e)));
    return () => {
      stale = true;
    };
  }, [root, hash]);
  if (error) return <div className="se-empty error">{error}</div>;
  if (!d) return <div className="se-empty">Loading…</div>;
  const parent = d.parents[0] ?? null;
  return (
    <div className="commit-details">
      <div className="panel-header slim">
        <span className="muted small">{d.files.length === 1 ? "1 file" : `${d.files.length} files`}</span>
        <div className="panel-actions">
          <button
            className={"icon-btn" + (byDir ? " on" : "")}
            title="Group by Directory"
            onClick={() => useWorkspace.getState().updateUi(project.id, { logGroupByDir: !byDir })}
          >
            <FolderTree size={16} />
          </button>
          <button className="icon-btn" title="Expand All" onClick={() => setCollapsed({})}>
            <ChevronsUpDown size={16} />
          </button>
          <button
            className="icon-btn"
            title="Collapse All"
            onClick={() => setCollapsed(Object.fromEntries(changeRows("files", d.files, true, {}).flatMap((row) => (row.kind === "dir" ? [[row.key, true]] : []))))}
          >
            <ChevronsDownUp size={16} />
          </button>
        </div>
      </div>
      <div className="commit-files">
        {changeRows("files", d.files, byDir, collapsed).map((row) => {
          if (row.kind === "dir")
            return (
              <div
                key={row.key}
                className="change-row change-dir"
                style={{ paddingLeft: 6 + row.depth * 16 }}
                title={row.name}
                onClick={() => setCollapsed((c) => ({ ...c, [row.key]: !c[row.key] }))}
              >
                {collapsed[row.key] ? <ChevronRight size={14} className="ico" /> : <ChevronDown size={14} className="ico" />}
                <FileIcon name={row.name} isDir />
                <span className="tree-name">{row.name}</span>
                <span className="tree-hint">{row.files.length}</span>
              </div>
            );
          const f = row.change;
          return (
            <div
              key={f.rel}
              className={"change-row git-" + (f.status === "copied" ? "added" : f.status)}
              style={{ paddingLeft: byDir ? 24 + row.depth * 16 : 10 }}
              title={f.oldRel ? `${f.oldRel} → ${f.rel}` : f.rel}
              onClick={() =>
                openDiff(project.id, {
                  root,
                  rel: f.rel,
                  oldRel: f.oldRel,
                  left: f.status === "added" ? null : parent,
                  right: d.hash,
                })
              }
            >
              <FileIcon name={basename(f.rel)} />
              <span className="tree-name">{basename(f.rel)}</span>
              {!byDir && <span className="tree-hint">{dirname(f.rel)}</span>}
            </div>
          );
        })}
      </div>
      <Splitter vertical={false} value={metaHeight} min={40} max={800} invert onChange={setMetaHeight} />
      <div className="commit-meta" style={{ height: metaHeight }}>
        <pre className="commit-msg">{d.message}</pre>
        <div className="muted small">
          {d.author} &lt;{d.email}&gt; · {new Date(d.time * 1000).toLocaleString()}
        </div>
        {d.committer !== d.author && <div className="muted small">committed by {d.committer}</div>}
        <div className="small">
          <span className="hash">{d.hash.slice(0, 12)}</span>
          <button className="icon-btn" title="Copy revision number" onClick={() => void navigator.clipboard.writeText(d.hash).then(() => toast("Copied"))}>
            <Copy size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

function GroupHeader({ label, count, open, depth, onToggle }: { label: string; count?: number; open: boolean; depth: number; onToggle: () => void }) {
  return (
    <div className={"log-branch branch-folder" + (depth === 0 ? " top" : "")} style={{ paddingLeft: 6 + depth * 12 }} onClick={onToggle}>
      {open ? <ChevronDown size={12} className="ico" /> : <ChevronRight size={12} className="ico" />}
      {depth > 0 && <Folder size={12} className="ico" />}
      <span className="tree-name">{label}</span>
      {count != null && <span className="tree-hint">{count}</span>}
    </div>
  );
}

function BranchList({ project, branches, refs, onSelect }: { project: Project; branches: Branch[]; refs: string[]; onSelect: (refs: string[]) => void }) {
  const current = useGit((s) => s.repos[project.id]?.branches?.current ?? null);
  const [q, setQ] = useState("");
  const revision = useGit((s) => s.repos[project.id]?.revision ?? 0);
  const [width] = usePaneSize(project, "gitBranchesWidth");
  const collapsedList = useWorkspace((s) => s.ui[project.id]?.gitCollapsed);
  const collapsed = useMemo(() => new Set(collapsedList ?? []), [collapsedList]);
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  useEffect(() => {
    void listWorktrees(project.id).then(setWorktrees);
  }, [project.id, revision]);
  const groups: [string, Branch[]][] = [
    ["Local", branches.filter((b) => b.kind === "local")],
    ["Remote", branches.filter((b) => b.kind === "remote")],
    ["Tags", branches.filter((b) => b.kind === "tag")],
  ];
  // A filter shows every match, collapsed or not.
  const isOpen = (key: string) => q !== "" || !collapsed.has(key);
  const toggle = (key: string) =>
    useWorkspace.getState().updateUi(project.id, (u) => ({
      gitCollapsed: u.gitCollapsed.includes(key) ? u.gitCollapsed.filter((k) => k !== key) : [...u.gitCollapsed, key],
    }));

  const branchRow = (b: Branch, depth: number) => (
    <div
      key={b.refname}
      className={"log-branch" + (refs.length === 1 && refs[0] === b.refname ? " selected" : "") + (b.current ? " current-branch" : "")}
      style={{ paddingLeft: 6 + depth * 12 }}
      onClick={() => onSelect([b.refname])}
      onDoubleClick={() => b.kind !== "tag" && void checkout(project, b.name, { remote: b.kind === "remote" })}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e, branchMenu(project, b, current));
      }}
      title={b.upstream ? `${b.name} → ${b.upstream}` : b.name}
    >
      {b.kind === "tag" ? <Tag size={12} className="ico" /> : <GitBranch size={12} className="ico" />}
      <span className="tree-name">{b.name.split("/").pop()}</span>
      {(b.ahead > 0 || b.behind > 0) && (
        <span className="tree-hint">
          {b.ahead > 0 && `↑${b.ahead}`} {b.behind > 0 && `↓${b.behind}`}
        </span>
      )}
    </div>
  );

  const folderRows = (node: BranchFolder, key: string, depth: number): React.ReactNode[] => [
    ...[...node.folders].map(([name, child]) => {
      const k = `${key}/${name}`;
      return (
        <div key={k}>
          <GroupHeader label={name} open={isOpen(k)} depth={depth} onToggle={() => toggle(k)} />
          {isOpen(k) && folderRows(child, k, depth + 1)}
        </div>
      );
    }),
    ...node.branches.map((b) => branchRow(b, depth)),
  ];

  return (
    <div className="log-branches" style={{ flexBasis: width }}>
      <input className="find-input small" placeholder="Filter branches" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="log-branch-list">
        <div className={"log-branch" + (refs.length === 0 ? " selected" : "")} onClick={() => onSelect([])}>
          All branches
        </div>
        {current && (
          <div className={"log-branch" + (refs.length === 1 && refs[0] === "HEAD" ? " selected" : "")} onClick={() => onSelect(["HEAD"])}>
            HEAD ({current})
          </div>
        )}
        {groups.map(([label, list]) => {
          const shown = list.filter((b) => b.name.toLowerCase().includes(q.toLowerCase()));
          if (!shown.length) return null;
          return (
            <div key={label}>
              <GroupHeader label={label} count={shown.length} open={isOpen(label)} depth={0} onToggle={() => toggle(label)} />
              {isOpen(label) && folderRows(branchTree(shown), label, 1)}
            </div>
          );
        })}
        {worktrees.length > 1 && (
          <div>
            <GroupHeader label="Worktrees" count={worktrees.length} open={isOpen("Worktrees")} depth={0} onToggle={() => toggle("Worktrees")} />
            {isOpen("Worktrees") && worktrees.map((w) => (
              <div
                key={w.path}
                className="log-branch"
                style={{ paddingLeft: 18 }}
                title={w.path}
                onClick={() => w.branch && onSelect([`refs/heads/${w.branch}`])}
                onDoubleClick={() => openWorktree(w)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  openMenu(e, [
                    { label: "Open as Project", action: () => openWorktree(w) },
                    { label: "New Worktree…", action: () => void newWorktree(project, w.branch) },
                    ...(w.main
                      ? []
                      : [
                          {
                            label: "Remove Worktree…",
                            action: async () => {
                              if (await confirmAction("Remove Worktree", `Remove the worktree folder ${w.path}? Its branch is kept.`, "Remove", true))
                                await runGit(project.id, ["worktree", "remove", w.path], { label: "Remove worktree" });
                            },
                          },
                        ]),
                  ]);
                }}
              >
                <FolderGit2 size={12} className="ico" />
                <span className="tree-name">{w.branch ?? w.head.slice(0, 8)}</span>
                <span className="tree-hint">{w.main ? "main" : basename(w.path)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StashView({ project, root }: { project: Project; root: string }) {
  const stashes = useGit((s) => s.repos[project.id]?.stashes ?? []);
  const [selected, setSelected] = useState<number | null>(null);
  const sel = stashes.find((s) => s.index === selected) ?? stashes[0];
  const ref = (i: number) => `stash@{${i}}`;
  const [width, setWidth] = usePaneSize(project, "gitStashListWidth");
  return (
    <div className="log-body">
      <div className="stash-list" style={{ flexBasis: width }}>
        <div className="stash-actions">
          <button
            className="btn small"
            onClick={async () => {
              const msg = await prompt("Stash Changes", "", { okLabel: "Stash" });
              if (msg !== null) await runGit(project.id, ["stash", "push", "--include-untracked", ...(msg.trim() ? ["-m", msg.trim()] : [])], { label: "Stash" });
            }}
          >
            Stash Changes…
          </button>
        </div>
        {stashes.length === 0 && <div className="se-empty">No stashes</div>}
        {stashes.map((s) => (
          <div
            key={s.hash}
            className={"log-branch" + (sel?.index === s.index ? " selected" : "")}
            onClick={() => setSelected(s.index)}
            onContextMenu={(e) => {
              e.preventDefault();
              setSelected(s.index);
              openMenu(e, [
                { label: "Apply", action: () => void runGit(project.id, ["stash", "apply", ref(s.index)], { label: "Apply stash" }) },
                { label: "Pop", action: () => void runGit(project.id, ["stash", "pop", ref(s.index)], { label: "Pop stash" }) },
                { label: "Unstash as Branch…", action: async () => {
                  const name = await prompt("Unstash as Branch", "", { okLabel: "Create" });
                  if (name) await runGit(project.id, ["stash", "branch", name.trim(), ref(s.index)], { label: "Unstash as branch" });
                } },
                { separator: true },
                {
                  label: "Drop",
                  danger: true,
                  action: async () => {
                    if (await confirmAction("Drop Stash", `Drop ${ref(s.index)}: ${s.message}?`, "Drop", true))
                      await runGit(project.id, ["stash", "drop", ref(s.index)], { label: "Drop stash" });
                  },
                },
              ]);
            }}
            title={new Date(s.time * 1000).toLocaleString()}
          >
            <span className="hash">{ref(s.index)}</span>
            <span className="tree-name">{s.message}</span>
          </div>
        ))}
        {sel && (
          <div className="stash-actions">
            <button className="btn small" onClick={() => void runGit(project.id, ["stash", "apply", ref(sel.index)], { label: "Apply stash" })}>
              Apply
            </button>
            <button className="btn small primary" onClick={() => void runGit(project.id, ["stash", "pop", ref(sel.index)], { label: "Pop stash" })}>
              Pop
            </button>
          </div>
        )}
      </div>
      <Splitter vertical value={width} min={160} max={900} onChange={setWidth} />
      <div className="log-details wide">{sel ? <Details project={project} root={root} hash={sel.hash} /> : <div className="se-empty">Select a stash</div>}</div>
    </div>
  );
}

function ConsoleView({ project }: { project: Project }) {
  const entries = useGit((s) => s.repos[project.id]?.console ?? []);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [entries.length]);
  return (
    <div className="git-console" ref={ref}>
      {entries.length === 0 && <div className="se-empty">Git commands run by Haze appear here.</div>}
      {entries.map((e, i) => (
        <div key={i} className={"console-entry" + (e.output && !e.output.ok ? " failed" : "")}>
          <div className="console-cmd">
            <span className="muted">{new Date(e.time).toLocaleTimeString()}</span> git {e.args.join(" ")}
          </div>
          {e.output && (e.output.stdout || e.output.stderr) && <pre>{(e.output.stdout + e.output.stderr).trim()}</pre>}
          {e.error && <pre className="error">{e.error}</pre>}
        </div>
      ))}
    </div>
  );
}

export function GitPanel({ project }: { project: Project }) {
  const r = useGit((s) => s.repos[project.id]);
  const root = r?.root ?? null;
  const branches = useMemo(() => r?.branches?.branches ?? [], [r?.branches]);
  const [view, setView] = useState<"log" | "stashes" | "console">("log");
  const [branchesWidth, setBranchesWidth] = usePaneSize(project, "gitBranchesWidth");
  const [detailsWidth, setDetailsWidth] = usePaneSize(project, "gitDetailsWidth");
  const [query, setQuery] = useState<LogQuery>({ limit: PAGE, refs: [], text: null, author: null, path: null, firstParent: false });
  const [textInput, setTextInput] = useState("");
  const [authorInput, setAuthorInput] = useState("");
  const [page, setPage] = useState<LogPage | null>(null);
  // The page shown and the filter it was loaded with; `seq` drops answers a newer load replaced.
  const shown = useRef<{ query: LogQuery; page: LogPage } | null>(null);
  const seq = useRef(0);
  const loadingMore = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(300);
  const listRef = useRef<HTMLDivElement>(null);

  // Branch "Compare with" and file "Show History" set filters from outside,
  // usually just before this panel mounts.
  useEffect(() => {
    const apply = () => {
      const f = takeLogFilter(project.id);
      if (!f) return;
      setView("log");
      setQuery((q) => ({ ...q, limit: PAGE, ...(f.refs ? { refs: f.refs } : {}), ...(f.path !== undefined ? { path: f.path } : {}) }));
    };
    apply();
    return onLogFilter((pid) => pid === project.id && apply());
  }, [project.id]);

  const load = useCallback(async () => {
    if (!root) return;
    const n = ++seq.current;
    // A refresh keeps as many commits as were loaded; a new filter starts over.
    const prev = shown.current;
    const limit = prev && prev.query === query ? Math.max(PAGE, prev.page.commits.length) : PAGE;
    try {
      const p = await api.gitLog(root, { ...query, limit });
      if (n !== seq.current) return;
      shown.current = { query, page: p };
      setPage(p);
      setError(null);
    } catch (e) {
      if (n === seq.current) setError(errorMessage(e));
    }
  }, [root, query]);

  // Scrolling to the end fetches only the next page and continues its lanes;
  // listing the whole history again got slower with every page.
  const loadMore = async () => {
    const cur = shown.current;
    if (!root || !cur?.page.hasMore || loadingMore.current) return;
    loadingMore.current = true;
    const n = seq.current;
    try {
      const p = await api.gitLog(root, { ...cur.query, limit: PAGE, skip: cur.page.next, lanes: cur.page.lanes });
      if (n !== seq.current) return;
      const next = { ...p, commits: [...cur.page.commits, ...p.commits], graph: [...cur.page.graph, ...p.graph] };
      shown.current = { query: cur.query, page: next };
      setPage(next);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      loadingMore.current = false;
    }
  };

  useEffect(() => {
    void load();
  }, [load, r?.revision]);

  useEffect(() => {
    const t = setTimeout(
      () => setQuery((q) => ({ ...q, limit: PAGE, text: textInput.trim() || null, author: authorInput.trim() || null })),
      300,
    );
    return () => clearTimeout(t);
  }, [textInput, authorInput]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [view]);

  const commits = page?.commits ?? [];
  const graph = page?.graph ?? [];
  // Scrolling re-renders on every frame; this walks every loaded commit.
  const lanes = useMemo(() => graph.reduce((m, g) => Math.max(m, g.lane + 1, ...g.edges.map((e) => Math.max(e.from, e.to) + 1)), 1), [graph]);
  const graphWidth = Math.min(lanes, 12) * LANE_W + 10;
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 10);
  const last = Math.min(commits.length, Math.ceil((scrollTop + height) / ROW_H) + 10);
  const head = branches.find((b) => b.current)?.hash ?? null;

  const commitMenu = (c: Commit) => {
    const short = c.hash.slice(0, 8);
    const isHead = c.hash === head;
    return [
      { label: "Copy Revision Number", action: () => void navigator.clipboard.writeText(c.hash) },
      { separator: true },
      { label: "Checkout Revision", action: () => void checkout(project, c.hash) },
      { label: "New Branch…", action: () => void newBranch(project, c.hash) },
      {
        label: "New Tag…",
        action: async () => {
          const name = await prompt("New Tag", "", { okLabel: "Create" });
          if (name) await runGit(project.id, ["tag", name.trim(), c.hash], { label: `Tag ${name.trim()}` });
        },
      },
      { separator: true },
      { label: "Cherry-Pick", action: () => void runGit(project.id, ["cherry-pick", c.hash], { label: `Cherry-pick ${short}` }) },
      {
        label: "Revert Commit",
        action: () => void runGit(project.id, ["revert", "--no-edit", c.hash], { label: `Revert ${short}` }),
      },
      {
        label: "Undo Commit",
        disabled: !isHead,
        action: async () => {
          if (await confirmAction("Undo Commit", "Remove the last commit and keep its changes as local changes?", "Undo Commit")) {
            await runGit(project.id, ["reset", "--soft", "HEAD~1"], { label: "Undo commit" });
          }
        },
      },
      {
        label: "Interactively Rebase from Here…",
        action: () => openRebaseDialog(project, c.hash),
      },
      {
        label: "Reset Current Branch to Here…",
        action: async () => {
          const mode = await choose("Git Reset", `Reset the current branch to ${short}?`, [
            { label: "Cancel", value: "cancel" },
            { label: "Soft", value: "--soft" },
            { label: "Mixed", value: "--mixed", primary: true },
            { label: "Hard (discard changes)", value: "--hard", danger: true },
          ]);
          if (mode) await runGit(project.id, ["reset", mode, c.hash], { label: `Reset to ${short}` });
        },
      },
    ];
  };

  if (!root) {
    return (
      <div className="terminal-panel">
        <div className="panel-header">
          <ToolTabs project={project} />
        </div>
        <div className="se-empty">This folder is not a git repository.</div>
      </div>
    );
  }

  return (
    <div className="terminal-panel git-panel">
      <div className="panel-header">
        <ToolTabs project={project} />
        <div className="seg small">
          <button className={"seg-btn" + (view === "log" ? " on" : "")} onClick={() => setView("log")}>
            Log
          </button>
          <button className={"seg-btn" + (view === "stashes" ? " on" : "")} onClick={() => setView("stashes")}>
            Stashes{r?.stashes.length ? ` (${r.stashes.length})` : ""}
          </button>
          <button className={"seg-btn" + (view === "console" ? " on" : "")} onClick={() => setView("console")}>
            Console
          </button>
        </div>
        {view === "log" && (
          <>
            <input className="find-input small log-filter" placeholder="Text or hash" value={textInput} onChange={(e) => setTextInput(e.target.value)} />
            <input className="find-input small log-filter" placeholder="User" value={authorInput} onChange={(e) => setAuthorInput(e.target.value)} />
            {query.path && (
              <span className="filter-chip" title={query.path}>
                Path: {basename(query.path)}
                <button className="icon-btn" onClick={() => setQuery((q) => ({ ...q, path: null }))}>
                  <X size={12} />
                </button>
              </span>
            )}
            {query.refs.length === 1 && query.refs[0].includes("..") && (
              <span className="filter-chip">
                {query.refs[0]}
                <button className="icon-btn" onClick={() => setQuery((q) => ({ ...q, refs: [] }))}>
                  <X size={12} />
                </button>
              </span>
            )}
            <label className="find-check">
              <input type="checkbox" checked={query.firstParent} onChange={(e) => setQuery((q) => ({ ...q, firstParent: e.target.checked }))} />
              First parent
            </label>
          </>
        )}
        <div className="panel-actions">
          {r?.busy && <span className="muted small">{r.busy}</span>}
          <button className="icon-btn" title="Refresh" onClick={() => void load()}>
            <RefreshCw size={16} />
          </button>
          <button className="icon-btn" title="Hide (Alt+9)" onClick={() => useWorkspace.getState().updateUi(project.id, { bottomVisible: false })}>
            <ChevronDown size={16} />
          </button>
        </div>
      </div>
      {view === "console" ? (
        <ConsoleView project={project} />
      ) : view === "stashes" ? (
        <StashView project={project} root={root} />
      ) : (
        <div className="log-body">
          <BranchList project={project} branches={branches} refs={query.refs} onSelect={(refs) => setQuery((q) => ({ ...q, refs, limit: PAGE }))} />
          <Splitter vertical value={branchesWidth} min={120} max={600} onChange={setBranchesWidth} />
          <div
            ref={listRef}
            className="log-list"
            tabIndex={0}
            onScroll={(e) => {
              const el = e.currentTarget;
              setScrollTop(el.scrollTop);
              if (page?.hasMore && el.scrollTop + el.clientHeight > el.scrollHeight - ROW_H * 20) void loadMore();
            }}
            onKeyDown={(e) => {
              const i = commits.findIndex((c) => c.hash === selected);
              const go = (j: number) => {
                const c = commits[Math.max(0, Math.min(commits.length - 1, j))];
                if (!c) return;
                setSelected(c.hash);
                const el = listRef.current;
                const top = Math.max(0, Math.min(commits.length - 1, j)) * ROW_H;
                if (el && top < el.scrollTop) el.scrollTop = top;
                else if (el && top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
              };
              if (e.key === "ArrowDown") go(i + 1);
              else if (e.key === "ArrowUp") go(i - 1);
              else return;
              e.preventDefault();
            }}
          >
            {error && <div className="se-empty error">{error}</div>}
            {!error && page && commits.length === 0 && <div className="se-empty">No commits</div>}
            <div style={{ height: commits.length * ROW_H, position: "relative" }}>
              <Graph rows={graph} first={first} last={last} width={graphWidth} />
              {commits.slice(first, last).map((c, k) => {
                const i = first + k;
                return (
                  <div
                    key={c.hash}
                    className={"log-row" + (selected === c.hash ? " selected" : "") + (c.hash === head ? " head" : "")}
                    style={{ top: i * ROW_H, height: ROW_H, paddingLeft: graphWidth }}
                    onClick={() => setSelected(c.hash)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setSelected(c.hash);
                      openMenu(e, commitMenu(c));
                    }}
                    title={`${c.hash}\n${c.author} <${c.email}>`}
                  >
                    <span className="log-subject">
                      <RefBadges refs={c.refs} branches={branches} />
                      {c.subject}
                    </span>
                    <span className="log-author">{c.author}</span>
                    <span className="log-date">{formatDate(c.time)}</span>
                  </div>
                );
              })}
            </div>
          </div>
          <Splitter vertical value={detailsWidth} min={200} max={1200} invert onChange={setDetailsWidth} />
          <div className="log-details" style={{ flexBasis: detailsWidth }}>
            {selected ? <Details project={project} root={root} hash={selected} /> : <div className="se-empty">Select a commit</div>}
          </div>
        </div>
      )}
    </div>
  );
}

/** "Show History" for a file or folder: opens the Git log filtered by that path. */
export function showHistory(project: Project, absolute: string): void {
  const root = repo(project.id).root;
  if (!root) return toast("Not a git repository.", "error");
  const norm = (p: string) => p.replace(/\\/g, "/");
  const rel = norm(absolute).startsWith(norm(root) + "/") ? norm(absolute).slice(norm(root).length + 1) : norm(absolute);
  useWorkspace.getState().updateUi(project.id, { bottomVisible: true, bottomTab: "git" });
  setLogFilter(project.id, { path: rel });
}
