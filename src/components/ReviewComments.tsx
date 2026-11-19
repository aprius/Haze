// Review comments in a diff: a "+" in the gutter (or "Add Review Comment" in
// the editor's menu) opens a box under the line; saved comments show there
// until they are sent to an agent's terminal as one prompt.
import { MessageSquarePlus, Send } from "lucide-react";
import { errorMessage } from "../lib/ipc";
import { buildReviewPrompt, type ReviewTarget } from "../lib/review";
import { monaco } from "../lib/monaco";
import { isMac } from "../lib/keymap";
import { isWithin } from "../lib/path";
import { wheelScroll } from "../lib/wheel";
import { addComment, clearComments, commentsIn, commentsOn, editComment, removeComment, useReview } from "../store/review";
import { agentName, shownState, useTerminals } from "../store/terminals";
import { projectForRoot } from "../store/git";
import { confirmAction, copyText, openMenu, toast, type MenuItem } from "./Overlays";
import { sendToTerminal } from "./TerminalPanel";

export interface ReviewHandle extends monaco.IDisposable {
  /** Opens a comment box for the selected lines, or the caret's line. */
  comment(): void;
}

const NONE: ReviewHandle = { dispose() {}, comment() {} };

/**
 * Shows the comments on `target` in `ed` and lets new ones be written.
 * `gutterButton` puts a "+" in the glyph margin of the hovered line (the
 * editor needs `glyphMargin: true`).
 */
export function attachReview(ed: monaco.editor.IStandaloneCodeEditor, target: ReviewTarget | null, gutterButton: boolean): ReviewHandle {
  if (!target) return NONE;
  const t = target;
  const doc = ed.getContainerDomNode().ownerDocument;
  // The window the editor is in (the Commit window is one of its own): its frames run while Haze's main window is hidden.
  const win = doc.defaultView ?? window;
  const marks = ed.createDecorationsCollection();
  const hover = ed.createDecorationsCollection();
  // Each box: a view zone that makes room under its line, and an overlay widget
  // over that room holding the box (Monaco's text layer covers view zones, so
  // nothing in a zone can be clicked or typed in; VS Code's zone widgets do the same).
  let zones: { id: string; ro: ResizeObserver; widget: monaco.editor.IOverlayWidget }[] = [];
  let widgetSeq = 0;
  // The comment box being written (`id` set when editing a saved comment), kept across redraws.
  let draft: { id: string | null; startLine: number; endLine: number; text: string } | null = null;
  let shown = "";

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string) => {
    const e = doc.createElement(tag);
    e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const button = (label: string, cls: string, onClick: () => void) => {
    const b = el("button", cls, label);
    b.type = "button";
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  };
  const linesLabel = (s: number, e: number) => (s === e ? `Line ${s}` : `Lines ${s}–${e}`);

  const save = () => {
    if (!draft) return;
    const { id, startLine, endLine, text } = draft;
    draft = null;
    if (!text.trim()) return void (id && removeComment(id), render(true));
    if (id) editComment(id, text);
    else {
      const model = ed.getModel();
      const last = model?.getLineCount() ?? 1;
      const code = model ? model.getValueInRange(new monaco.Range(startLine, 1, Math.min(endLine, last), model.getLineMaxColumn(Math.min(endLine, last)))) : "";
      addComment(t, startLine, endLine, code, text);
    }
    render(true);
    ed.focus();
  };
  const cancel = () => {
    draft = null;
    render(true);
    ed.focus();
  };

  const draftNode = () => {
    const d = draft!;
    const card = el("div", "rv-card editing");
    card.append(el("div", "rv-head", linesLabel(d.startLine, d.endLine)));
    const input = el("textarea", "rv-input");
    input.placeholder = "Comment for the agent…";
    input.value = d.text;
    input.rows = 3;
    input.addEventListener("input", () => (d.text = input.value));
    input.addEventListener("keydown", (e) => {
      // Kept from Monaco and the app's shortcuts (Escape would close a floating window).
      e.stopPropagation();
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        save();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    });
    const actions = el("div", "rv-actions");
    actions.append(el("span", "muted small", `${isMac ? "⌘" : "Ctrl+"}Enter to save`), el("span", "rv-spacer"), button("Cancel", "btn small", cancel), button(d.id ? "Save" : "Add Comment", "btn small primary", save));
    card.append(input, actions);
    win.requestAnimationFrame(() => {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
    return card;
  };

  const commentNode = (c: ReturnType<typeof commentsOn>[number]) => {
    const card = el("div", "rv-card");
    const head = el("div", "rv-head", linesLabel(c.startLine, c.endLine));
    head.append(
      el("span", "rv-spacer"),
      button("Edit", "rv-link", () => {
        draft = { id: c.id, startLine: c.startLine, endLine: c.endLine, text: c.text };
        render(true);
      }),
      button("Delete", "rv-link", () => removeComment(c.id)),
    );
    card.append(head, el("div", "rv-text", c.text));
    return card;
  };

  function render(force = false) {
    const list = commentsOn(useReview.getState().comments, t);
    const sig = JSON.stringify([list.map((c) => [c.id, c.text, c.startLine, c.endLine]), draft && [draft.id, draft.startLine]]);
    if (!force && sig === shown) return;
    shown = sig;
    const width = Math.max(240, Math.min(720, ed.getLayoutInfo().contentWidth - 32));
    const left = ed.getLayoutInfo().contentLeft + 12;
    ed.changeViewZones((acc) => {
      for (const z of zones) {
        acc.removeZone(z.id);
        z.ro.disconnect();
        ed.removeOverlayWidget(z.widget);
      }
      zones = [];
      const add = (after: number, card: HTMLElement) => {
        const node = el("div", "rv-zone");
        card.style.width = `${width}px`;
        node.append(card);
        // Clicks and keys stay in the box instead of moving Monaco's caret.
        for (const type of ["mousedown", "pointerdown"]) node.addEventListener(type, (e) => e.stopPropagation());
        // The wheel over the box scrolls the editor, as over the code (a textarea with more to show scrolls itself).
        node.addEventListener(
          "wheel",
          (e) => {
            const area = (e.target as HTMLElement).closest("textarea");
            if (area && area.scrollHeight > area.clientHeight) return;
            e.preventDefault();
            wheelScroll(ed, e);
          },
          { passive: false },
        );
        const position: monaco.editor.IOverlayWidgetPosition = { preference: { top: -1e6, left } };
        const wid = `haze.review.${++widgetSeq}`;
        const widget: monaco.editor.IOverlayWidget = { getId: () => wid, getDomNode: () => node, getPosition: () => position };
        ed.addOverlayWidget(widget);
        const zone: monaco.editor.IViewZone = {
          afterLineNumber: after,
          heightInPx: 72,
          domNode: el("div", "rv-zone-space"),
          onDomNodeTop: (top) => {
            if (position.preference && typeof position.preference === "object" && position.preference.top !== top) {
              position.preference = { top, left };
              ed.layoutOverlayWidget(widget);
            }
          },
        };
        const id = acc.addZone(zone);
        const ro = new win.ResizeObserver(() => {
          const h = card.offsetHeight + 12;
          if (h > 12 && h !== zone.heightInPx) {
            zone.heightInPx = h;
            ed.changeViewZones((a) => a.layoutZone(id));
          }
        });
        ro.observe(card);
        zones.push({ id, ro, widget });
      };
      for (const c of list) if (c.id !== draft?.id) add(c.endLine, commentNode(c));
      if (draft) add(draft.endLine, draftNode());
    });
    marks.set(
      [...list, ...(draft && !draft.id ? [draft] : [])].map((c) => ({
        range: new monaco.Range(c.startLine, 1, c.endLine, 1),
        options: { isWholeLine: true, linesDecorationsClassName: "rv-mark" },
      })),
    );
  }

  function comment(line?: number) {
    const model = ed.getModel();
    if (!model) return;
    const sel = ed.getSelection();
    const at = line ?? sel?.positionLineNumber ?? 1;
    let start = at;
    let end = at;
    if (sel && !sel.isEmpty() && at >= sel.startLineNumber && at <= sel.endLineNumber) {
      start = sel.startLineNumber;
      // A selection that ends at the start of a line does not take that line.
      end = sel.endColumn === 1 && sel.endLineNumber > start ? sel.endLineNumber - 1 : sel.endLineNumber;
    }
    // A comment being written elsewhere in this editor is kept, not lost.
    if (draft && !draft.id && draft.text.trim()) save();
    draft = { id: null, startLine: start, endLine: end, text: "" };
    render(true);
    ed.revealLineInCenterIfOutsideViewport(end);
  }

  const subs: monaco.IDisposable[] = [
    ed.addAction({ id: "haze.review.comment", label: "Add Review Comment", contextMenuGroupId: "navigation", contextMenuOrder: 0, run: () => comment() }),
    ed.onDidChangeModel(() => render(true)),
  ];
  if (gutterButton) {
    let hovered = 0;
    const setHover = (line: number) => {
      if (line === hovered) return;
      hovered = line;
      hover.set(line ? [{ range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: "rv-add", glyphMarginHoverMessage: { value: "Add review comment" } } }] : []);
    };
    const T = monaco.editor.MouseTargetType;
    subs.push(
      ed.onMouseMove((e) => setHover(e.target.type === T.CONTENT_VIEW_ZONE ? 0 : (e.target.position?.lineNumber ?? 0))),
      ed.onMouseLeave(() => setHover(0)),
      ed.onMouseDown((e) => {
        if (e.target.type === T.GUTTER_GLYPH_MARGIN && e.target.position) {
          e.event.preventDefault();
          comment(e.target.position.lineNumber);
        }
      }),
    );
  }
  const unsub = useReview.subscribe((s, prev) => s.comments !== prev.comments && render());
  render(true);

  return {
    comment: () => comment(),
    dispose() {
      unsub();
      subs.forEach((s) => s.dispose());
      ed.changeViewZones((acc) => zones.forEach((z) => acc.removeZone(z.id)));
      zones.forEach((z) => {
        z.ro.disconnect();
        ed.removeOverlayWidget(z.widget);
      });
      zones = [];
      marks.clear();
      hover.clear();
    },
  };
}

/** Running terminals of the repository at `root`, the ones with an agent first. */
function terminalsFor(root: string) {
  const project = projectForRoot(root);
  return Object.values(useTerminals.getState().sessions)
    .filter((s) => s.running && ((project && s.projectId === project.id) || isWithin(s.cwd, root)))
    .sort((a, b) => Number(!!b.agent) - Number(!!a.agent) || b.createdAt - a.createdAt);
}

async function send(root: string, id: string, label: string) {
  const list = commentsIn(useReview.getState().comments, root);
  if (!list.length) return;
  const session = useTerminals.getState().sessions[id];
  try {
    await sendToTerminal(session?.projectId ?? projectForRoot(root)?.id ?? null, id, buildReviewPrompt(list));
    clearComments(root);
    toast(`Sent ${list.length} comment${list.length === 1 ? "" : "s"} to ${label}`);
  } catch (e) {
    toast(`Could not send the comments: ${errorMessage(e)}`, "error");
  }
}

function sendMenu(e: React.MouseEvent, root: string) {
  const list = commentsIn(useReview.getState().comments, root);
  const terminals = terminalsFor(root);
  const items: MenuItem[] = terminals.length
    ? terminals.map((s) => {
        const label = s.agent ? agentName(s.agent.agent) : s.title;
        const state = s.agent ? ` — ${shownState(s.agent)}` : "";
        return { label: `${label}${s.agent ? ` (${s.title})` : ""}${state}`, action: () => void send(root, s.id, label) };
      })
    : [{ label: "No terminal is open in this project", disabled: true }];
  openMenu(e, [
    { label: "Send to", disabled: true },
    ...items,
    { separator: true },
    { label: "Copy as Prompt", action: () => void copyText(buildReviewPrompt(list)) },
    {
      label: `Discard ${list.length} Comment${list.length === 1 ? "" : "s"}…`,
      danger: true,
      action: () =>
        void confirmAction("Discard Review Comments", `Discard ${list.length} review comment${list.length === 1 ? "" : "s"} without sending them?`, "Discard", true).then(
          (ok) => ok && clearComments(root),
        ),
    },
  ]);
}

/**
 * The diff toolbar's review controls: add a comment, and once there are
 * comments in the repository (any file), send them to an agent.
 */
export function ReviewBar({ root, onComment }: { root: string; onComment: () => void }) {
  const count = useReview((s) => commentsIn(s.comments, root).length);
  return (
    <>
      <button className="icon-btn" title="Add review comment (or click the + beside a line)" onClick={onComment}>
        <MessageSquarePlus size={15} />
      </button>
      {count > 0 && (
        <button className="btn small rv-send" title="Send the review comments of every file to an agent" onClick={(e) => sendMenu(e, root)}>
          <Send size={12} /> Send {count} comment{count === 1 ? "" : "s"}
        </button>
      )}
    </>
  );
}
