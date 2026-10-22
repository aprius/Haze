// Unity tool windows, live over the com.aprius.ide.haze link: the Unity
// Editor's Console (errors, warnings and messages can be hidden and collapsed
// as in Unity; the selected message shows its stack trace, whose frames open
// the file) and Tests (results of tests run from Haze).
import { AlertCircle, AlertTriangle, CheckCircle2, ChevronDown, CircleDashed, CircleSlash, Info, LoaderCircle, Play, RotateCcw, Trash2, XCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { UnityLogType } from "../lib/ipc";
import { join } from "../lib/path";
import { workspaceSymbols } from "../lib/lsp/csharp";
import { clearUnityLogs, runUnityTests, useUnity, type TestResult, type UnityLog } from "../store/unity";
import { useWorkspace, type Project } from "../store/workspace";
import { ToolTabs } from "./BuildPanel";
import { toast } from "./Overlays";

type Kind = "error" | "warning" | "log";

function kindOf(type: UnityLogType): Kind {
  return type === "warning" ? "warning" : type === "log" ? "log" : "error";
}

function KindIcon({ kind }: { kind: Kind }) {
  if (kind === "error") return <AlertCircle size={13} className="sev-error" />;
  if (kind === "warning") return <AlertTriangle size={13} className="sev-warning" />;
  return <Info size={13} className="sev-info" />;
}

const isAbsolute = (p: string) => /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(p);

/** A stack frame's source: "Foo.Update () (at Assets/Foo.cs:12)". */
const FRAME = /\(at (.+?):(\d+)\)\s*$/;

function frameTarget(root: string, line: string): { path: string; line: number } | null {
  const m = FRAME.exec(line);
  if (!m || m[1] === "<00000000000000000000000000000000>") return null;
  return { path: isAbsolute(m[1]) ? m[1] : join(root, m[1]), line: Number(m[2]) };
}

interface Row {
  log: UnityLog;
  count: number;
}

/** A stack trace whose source frames open the file. */
function StackTrace({ project, text }: { project: Project; text: string }) {
  const open = (target: { path: string; line: number }) => useWorkspace.getState().openFile(project.id, target.path, { line: target.line, column: 1 });
  return (
    <>
      {text.split("\n").map((line, i) => {
        const target = frameTarget(project.path, line);
        return (
          <div key={i}>
            {target ? (
              <span className="unity-frame" onClick={() => open(target)}>
                {line}
              </span>
            ) : (
              line
            )}
          </div>
        );
      })}
    </>
  );
}

export function UnityPanel({ project }: { project: Project }) {
  const unity = useUnity((s) => s.projects[project.id]);
  const [shown, setShown] = useState<Record<Kind, boolean>>({ error: true, warning: true, log: true });
  const [collapse, setCollapse] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const logs = unity?.logs ?? [];

  const counts = useMemo(() => {
    const c = { error: 0, warning: 0, log: 0 };
    for (const l of logs) c[kindOf(l.type)]++;
    return c;
  }, [logs]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const visible = logs.filter((l) => shown[kindOf(l.type)] && (!q || l.message.toLowerCase().includes(q)));
    if (!collapse) return visible.map((log): Row => ({ log, count: 1 }));
    const groups = new Map<string, Row>();
    for (const log of visible) {
      const key = `${log.type}\n${log.message}\n${log.stack}`;
      const g = groups.get(key);
      if (g) g.count++;
      else groups.set(key, { log, count: 1 });
    }
    return [...groups.values()];
  }, [logs, shown, collapse, query]);

  // Follows new messages while scrolled to the end, as Unity's Console does.
  useEffect(() => {
    const el = listRef.current;
    if (el && atEnd.current) el.scrollTop = el.scrollHeight;
  }, [rows.length]);

  const current = logs.find((l) => l.id === selected) ?? null;
  const open = (target: { path: string; line: number } | null) => {
    if (target) useWorkspace.getState().openFile(project.id, target.path, { line: target.line, column: 1 });
  };
  const firstFrame = (log: UnityLog) => log.stack.split("\n").map((l) => frameTarget(project.path, l)).find(Boolean) ?? null;
  const toggle = (k: Kind) => setShown((s) => ({ ...s, [k]: !s[k] }));

  const status = !unity?.connected
    ? "Waiting for Unity…"
    : `Unity ${unity.version ?? ""}${unity.playing ? (unity.paused ? " · paused" : " · playing") : ""}${unity.compiling ? " · compiling" : ""}`;

  return (
    <div className="terminal-panel build-panel unity-panel">
      <div className="panel-header">
        <ToolTabs project={project} />
        <span
          className="build-status"
          title={unity?.connected ? undefined : "Open the project in Unity with Haze as External Script Editor (package com.aprius.ide.haze)."}
        >
          {status}
        </span>
        <div className="panel-actions">
          <input className="find-input small" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className={"seg-btn" + (collapse ? " on" : "")} onClick={() => setCollapse((c) => !c)} title="Collapse identical messages">
            Collapse
          </button>
          <div className="seg small">
            {(["error", "warning", "log"] as const).map((k) => (
              <button key={k} className={"seg-btn unity-count" + (shown[k] ? " on" : "")} onClick={() => toggle(k)} title={`Show ${k === "log" ? "messages" : k + "s"}`}>
                <KindIcon kind={k} /> {counts[k]}
              </button>
            ))}
          </div>
          <button className="icon-btn" title="Clear" onClick={() => clearUnityLogs(project.id)}>
            <Trash2 size={16} />
          </button>
          <button className="icon-btn" title="Hide" onClick={() => useWorkspace.getState().updateUi(project.id, { bottomVisible: false })}>
            <ChevronDown size={16} />
          </button>
        </div>
      </div>
      <div className="build-body">
        <div
          className="problems"
          ref={listRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
          }}
        >
          {rows.length === 0 && <div className="se-empty">{unity?.connected ? "No messages" : "Not connected to Unity"}</div>}
          {rows.map(({ log, count }) => (
            <div
              key={log.id}
              className={"problem" + (log.id === selected ? " selected" : "")}
              onClick={() => setSelected(log.id)}
              onDoubleClick={() => open(firstFrame(log))}
              title={log.message}
            >
              <KindIcon kind={kindOf(log.type)} />
              <span className="problem-msg">{log.message.split("\n")[0]}</span>
              {count > 1 && <span className="unity-collapsed">{count}</span>}
            </div>
          ))}
        </div>
        <pre className="build-output unity-details">
          {current ? (
            <>
              {current.message}
              {"\n\n"}
              <StackTrace project={project} text={current.stack} />
            </>
          ) : (
            "Select a message to see its stack trace. Double-click opens the code."
          )}
        </pre>
      </div>
    </div>
  );
}

function TestIcon({ status }: { status: TestResult["status"] }) {
  switch (status) {
    case "passed":
      return <CheckCircle2 size={13} className="test-passed" />;
    case "failed":
      return <XCircle size={13} className="sev-error" />;
    case "skipped":
      return <CircleSlash size={13} className="sev-info" />;
    case "running":
      return <LoaderCircle size={13} className="spin sev-info" />;
    default:
      return <CircleDashed size={13} className="sev-warning" />;
  }
}

/** "Game.Tests.PlayerTests.Adds(1,2)" is in fixture "Game.Tests.PlayerTests". */
function fixtureOf(fullName: string): string {
  const name = fullName.replace(/\(.*$/, "");
  return name.slice(0, name.lastIndexOf("."));
}

/** Opens a test's source: Roslyn's symbols named like it, in a class named like its fixture. */
async function openTest(project: Project, fullName: string) {
  const name = fullName.replace(/\(.*$/, "");
  const method = name.slice(name.lastIndexOf(".") + 1);
  const fixture = fixtureOf(fullName).split(/[.+]/).pop() ?? "";
  const hits = await workspaceSymbols(project.id, method).catch(() => []);
  const hit = hits.find((h) => h.name.replace(/\(.*$/, "") === method && (h.container ?? "").includes(fixture)) ?? hits.find((h) => h.name === method);
  if (hit) useWorkspace.getState().openFile(project.id, hit.path, { line: hit.line, column: hit.column });
  else toast(`Cannot find ${method} in the C# projects.`);
}

export function TestsPanel({ project }: { project: Project }) {
  const unity = useUnity((s) => s.projects[project.id]);
  const [selected, setSelected] = useState<string | null>(null);
  const [failedOnly, setFailedOnly] = useState(false);
  const tests = unity?.tests;
  const results = (tests?.order ?? []).map((n) => tests!.results[n]).filter(Boolean);
  const failed = results.filter((r) => r.status === "failed");
  const shown = failedOnly ? failed : results;
  const current = selected ? tests?.results[selected] : undefined;

  const run = (pattern: string, label: string) => {
    void runUnityTests(project.id, pattern, label).then((ok) => {
      if (!ok) toast("Unity is not connected: open the project in Unity with Haze as External Script Editor.", "error");
    });
  };
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const status = !tests
    ? ""
    : tests.running
      ? `Running ${tests.label}… ${results.filter((r) => r.status !== "running").length} done`
      : tests.error
        ? tests.error
        : tests.summary
          ? `${tests.label}: ${tests.summary.passed} passed, ${tests.summary.failed} failed${tests.summary.skipped ? `, ${tests.summary.skipped} skipped` : ""}`
          : "Run tests from Code Vision above a test, or run all";
  let lastFixture = "";

  return (
    <div className="terminal-panel build-panel unity-panel">
      <div className="panel-header">
        <ToolTabs project={project} />
        <span className={"build-status" + (failed.length || tests?.error ? " failed" : "")}>{status}</span>
        <div className="panel-actions">
          <button className={"seg-btn" + (failedOnly ? " on" : "")} onClick={() => setFailedOnly((f) => !f)} title="Show only failed tests">
            Failed only
          </button>
          <button
            className="icon-btn"
            disabled={tests?.running || failed.length === 0}
            title="Rerun failed tests"
            onClick={() => run(`^(${failed.map((f) => escape(f.fullName)).join("|")})$`, "Failed tests")}
          >
            <RotateCcw size={16} />
          </button>
          <button className="icon-btn run" disabled={tests?.running} title="Run all tests (Edit Mode and Play Mode)" onClick={() => run(".*", "All tests")}>
            <Play size={16} />
          </button>
          <button className="icon-btn" title="Hide" onClick={() => useWorkspace.getState().updateUi(project.id, { bottomVisible: false })}>
            <ChevronDown size={16} />
          </button>
        </div>
      </div>
      <div className="build-body">
        <div className="problems">
          {shown.length === 0 && <div className="se-empty">{tests?.running ? "Starting…" : failedOnly ? "No failed tests" : "No tests run yet"}</div>}
          {shown.map((r) => {
            const fixture = fixtureOf(r.fullName);
            const header = fixture !== lastFixture;
            lastFixture = fixture;
            return (
              <div key={r.fullName}>
                {header && <div className="se-group test-fixture">{fixture}</div>}
                <div
                  className={"problem test-row" + (r.fullName === selected ? " selected" : "")}
                  onClick={() => setSelected(r.fullName)}
                  onDoubleClick={() => void openTest(project, r.fullName)}
                  title={r.fullName}
                >
                  <TestIcon status={r.status} />
                  <span className="problem-msg">{r.fullName.slice(fixture.length + 1)}</span>
                  {r.status !== "running" && <span className="problem-code">{r.duration < 1 ? "<1" : Math.round(r.duration)} ms</span>}
                </div>
              </div>
            );
          })}
        </div>
        <pre className="build-output unity-details">
          {current ? (
            <>
              {current.fullName}
              {"\n"}
              {current.status}
              {current.message ? `\n\n${current.message}` : ""}
              {current.stack ? (
                <>
                  {"\n\n"}
                  <StackTrace project={project} text={current.stack} />
                </>
              ) : null}
              {current.output ? `\n\nOutput:\n${current.output}` : ""}
            </>
          ) : (
            "Select a test to see its result. Double-click opens the test."
          )}
        </pre>
      </div>
    </div>
  );
}
