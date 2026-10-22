// Context menu and modal dialogs, driven by small global stores so any
// module can open them imperatively.
import { Check, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { matches } from "../lib/keymap";

export interface MenuItem {
  label?: string;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  separator?: boolean;
  /** Set on choices: a check mark when true, the same space when false. */
  checked?: boolean;
  action?: () => void;
}

const useMenu = create<{ x: number; y: number; items: MenuItem[] | null; doc: Document }>(() => ({ x: 0, y: 0, items: null, doc: document }));

/** Opens at the event's position, in the window it happened in. */
export function openMenu(e: { clientX: number; clientY: number; target?: EventTarget | null }, items: MenuItem[]): void {
  const doc = (e.target as Node | null | undefined)?.ownerDocument ?? useHost.getState().doc;
  useMenu.setState({ x: e.clientX, y: e.clientY, items, doc });
}

function closeMenu() {
  useMenu.setState({ items: null });
}

export function ContextMenu() {
  const { x, y, items, doc } = useMenu();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const win = doc.defaultView ?? window;

  useLayoutEffect(() => {
    if (!items || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({
      x: Math.min(x, win.innerWidth - r.width - 4),
      y: Math.min(y, win.innerHeight - r.height - 4),
    });
  }, [items, x, y, win]);

  useEffect(() => {
    if (!items) return;
    const window = win;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) closeMenu();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeMenu();
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", closeMenu);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", closeMenu);
    };
  }, [items, win]);

  if (!items) return null;
  return inDoc(
    doc,
    <div ref={ref} className="context-menu" style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="menu-sep" />
        ) : (
          <button
            key={i}
            className={"menu-item" + (it.danger ? " danger" : "")}
            disabled={it.disabled}
            onClick={() => {
              closeMenu();
              it.action?.();
            }}
          >
            <span className="menu-label">
              {it.checked !== undefined && <span className="menu-check">{it.checked && <Check size={13} />}</span>}
              {it.label}
            </span>
            {it.shortcut && <span className="menu-shortcut">{it.shortcut}</span>}
          </button>
        ),
      )}
    </div>,
  );
}

// ------------------------------------------------------------------ dialogs

interface DialogButton {
  label: string;
  value: string;
  primary?: boolean;
  danger?: boolean;
}

interface DialogRequest {
  title: string;
  message?: string;
  input?: { value: string; selectStem?: boolean; validate?: (v: string) => string | null };
  buttons: DialogButton[];
  resolve: (r: { button: string | null; value: string }) => void;
  /** Shown in the window that asked. */
  doc: Document;
}

const useDialog = create<{ current: DialogRequest | null }>(() => ({ current: null }));

function show(req: Omit<DialogRequest, "resolve" | "doc">): Promise<{ button: string | null; value: string }> {
  return new Promise((resolve) => useDialog.setState({ current: { ...req, resolve, doc: useHost.getState().doc } }));
}

/** Text input dialog; resolves to `null` when cancelled. */
export async function prompt(
  title: string,
  value = "",
  opts: { selectStem?: boolean; validate?: (v: string) => string | null; okLabel?: string } = {},
): Promise<string | null> {
  const r = await show({
    title,
    input: { value, selectStem: opts.selectStem, validate: opts.validate },
    buttons: [
      { label: "Cancel", value: "cancel" },
      { label: opts.okLabel ?? "OK", value: "ok", primary: true },
    ],
  });
  return r.button === "ok" ? r.value : null;
}

/** Message with custom buttons; resolves to the chosen button value or `null`. */
export async function choose(title: string, message: string, buttons: DialogButton[]): Promise<string | null> {
  return (await show({ title, message, buttons })).button;
}

export async function confirmAction(title: string, message: string, okLabel = "OK", danger = false): Promise<boolean> {
  return (
    (await choose(title, message, [
      { label: "Cancel", value: "cancel" },
      { label: okLabel, value: "ok", primary: !danger, danger },
    ])) === "ok"
  );
}

export function Dialogs() {
  const req = useDialog((s) => s.current);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!req) return;
    setValue(req.input?.value ?? "");
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const v = req.input?.value ?? "";
      const dot = v.lastIndexOf(".");
      if (req.input?.selectStem && dot > 0) el.setSelectionRange(0, dot);
      else el.select();
    });
  }, [req]);

  if (!req) return null;
  const error = req.input?.validate?.(value) ?? null;
  const finish = (button: string | null) => {
    if (button && button !== "cancel" && req.input && error) return;
    useDialog.setState({ current: null });
    req.resolve({ button: button === "cancel" ? null : button, value });
  };
  // Enter picks the primary button ("Save", not "Don't Save"); a lone danger
  // button (Delete…) is the default only when nothing is marked primary.
  const dangers = req.buttons.filter((b) => b.danger);
  const primary =
    req.buttons.find((b) => b.primary)?.value ?? (dangers.length === 1 ? dangers[0].value : req.buttons[req.buttons.length - 1]?.value);

  return inDoc(
    req.doc,
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && finish(null)}>
      <div
        className="modal"
        role="dialog"
        onKeyDown={(e) => {
          if (e.key === "Escape") finish(null);
          // A focused button (tabbed to "Cancel") handles Enter itself.
          if (e.key === "Enter" && !e.nativeEvent.isComposing && (e.target as HTMLElement).tagName !== "BUTTON") finish(primary ?? null);
          e.stopPropagation();
        }}
        tabIndex={-1}
        ref={(el) => {
          if (el && !req.input) el.focus();
        }}
      >
        <div className="modal-title">{req.title}</div>
        {req.message && <div className="modal-message">{req.message}</div>}
        {req.input && (
          <>
            <input
              ref={inputRef}
              className={"modal-input" + (error ? " invalid" : "")}
              value={value}
              spellCheck={false}
              onChange={(e) => setValue(e.target.value)}
            />
            {error && <div className="modal-error">{error}</div>}
          </>
        )}
        <div className="modal-buttons">
          {req.buttons.map((b) => (
            <button
              key={b.value}
              className={"btn" + (b.primary ? " primary" : "") + (b.danger ? " danger" : "")}
              disabled={b.value !== "cancel" && !!req.input && !!error}
              onClick={() => finish(b.value)}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </div>,
  );
}

// ------------------------------------------------------------------ floating windows

/**
 * The document popups (menus, dialogs, toasts) show in: the window last
 * focused, the main one or a floating window.
 */
const useHost = create<{ doc: Document }>(() => ({ doc: document }));
window.addEventListener("focus", () => useHost.setState({ doc: document }));

/** Renders `node` into `doc` when that is another window's document. */
function inDoc(doc: Document, node: ReactNode): ReactNode {
  return doc === document || !doc.defaultView || doc.defaultView.closed ? node : createPortal(node, doc.body);
}

let floatSeq = 0;
const isTauri = "__TAURI_INTERNALS__" in window;

/**
 * Keeps `win`'s head in step with ours: stylesheets (Vite and Monaco add and
 * change them as they go) and the theme and zoom set on `<html>`.
 */
function mirrorStyles(win: Window): () => void {
  const doc = win.document;
  const clones = new Map<Node, HTMLElement>();
  const sheetText = (el: HTMLStyleElement) => {
    // Rules added with insertRule are not in the element's text.
    try {
      const rules = el.sheet?.cssRules;
      return rules ? Array.from(rules, (r) => r.cssText).join("\n") : el.textContent ?? "";
    } catch {
      return el.textContent ?? "";
    }
  };
  const sync = () => {
    const live = new Set<Node>();
    for (const el of document.head.querySelectorAll<HTMLElement>("style, link[rel=stylesheet]")) {
      live.add(el);
      let c = clones.get(el);
      if (!c) {
        c = el instanceof HTMLStyleElement ? doc.createElement("style") : (el.cloneNode(true) as HTMLElement);
        doc.head.appendChild(c);
        clones.set(el, c);
      }
      if (el instanceof HTMLStyleElement) {
        const text = sheetText(el);
        if (c.textContent !== text) c.textContent = text;
      }
    }
    for (const [el, c] of clones) {
      if (!live.has(el)) {
        c.remove();
        clones.delete(el);
      }
    }
    const from = document.documentElement;
    const to = doc.documentElement;
    for (const a of Array.from(to.attributes)) if (!from.hasAttribute(a.name)) to.removeAttribute(a.name);
    for (const a of Array.from(from.attributes)) if (to.getAttribute(a.name) !== a.value) to.setAttribute(a.name, a.value);
    doc.body.className = document.body.className;
  };
  sync();
  let queued = false;
  const later = () => {
    if (queued) return;
    queued = true;
    // Not requestAnimationFrame: it stops while Haze's window is minimized.
    setTimeout(() => {
      queued = false;
      if (!win.closed) sync();
    }, 16);
  };
  const mo = new MutationObserver(later);
  mo.observe(document.head, { childList: true, subtree: true, characterData: true });
  mo.observe(document.documentElement, { attributes: true });
  mo.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  const timer = setInterval(later, 1000);
  return () => {
    mo.disconnect();
    clearInterval(timer);
  };
}

/**
 * Opens a real window that our React tree renders into (same JS context, so
 * stores and Monaco models are shared). Null outside Tauri or when refused.
 */
function useExternalWindow(width: number, height: number, onClose: () => void): { win: Window; root: HTMLElement } | "opening" | null {
  const [host, setHost] = useState<{ win: Window; root: HTMLElement } | "opening" | null>(isTauri ? "opening" : null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    if (!isTauri) return;
    const label = `float-${++floatSeq}-${Date.now().toString(36)}`;
    const w = Math.min(width, screen.availWidth - 40);
    const h = Math.min(height, screen.availHeight - 40);
    // The native side places it over the main window.
    const win = window.open(`about:blank#${label}`, label, `width=${w},height=${h}`);
    if (!win) return setHost(null);
    let doc = win.document;
    if (!doc.body) {
      doc.open();
      doc.write('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
      doc.close();
    }
    const mount = () => {
      const el = doc.createElement("div");
      el.className = "float-external";
      doc.body.appendChild(el);
      return el;
    };
    let root = mount();
    let unmirror = mirrorStyles(win);
    // WebKit may still load the window's URL into it, replacing the document:
    // render our content (and styles) again in the new one. Not moved: Monaco
    // keeps the old document, which has no window any more, and throws.
    const reattach = () => {
      if (win.closed || win.document === doc || !win.document.body) return;
      doc = win.document;
      unmirror();
      root.remove();
      root = mount();
      setHost({ win, root });
      unmirror = mirrorStyles(win);
      win.addEventListener("keydown", forward, true);
      win.addEventListener("focus", () => useHost.setState({ doc }));
      useHost.setState({ doc });
    };
    let closing = false;
    const closed = () => {
      if (closing) return;
      closing = true;
      closeRef.current();
    };
    // Shortcuts the app handles on the main window (Save All) still work here.
    const forward = (e: KeyboardEvent) => {
      if (matches(e, "saveAll")) {
        e.preventDefault();
        window.dispatchEvent(new KeyboardEvent("keydown", e));
      }
    };
    win.addEventListener("keydown", forward, true);
    win.addEventListener("focus", () => useHost.setState({ doc }));
    win.addEventListener("load", () => setTimeout(reattach));
    const poll = setInterval(() => (win.closed ? closed() : reattach()), 400);
    let unlisten: (() => void) | null = null;
    void import("@tauri-apps/api/webviewWindow").then(async ({ WebviewWindow }) => {
      const w = await WebviewWindow.getByLabel(label);
      if (!w) return;
      if (closing) return void w.destroy().catch(() => {});
      unlisten = await w.once("tauri://destroyed", closed);
      // The window opens hidden: show it once our content and stylesheets are in.
      const pending = Array.from(doc.querySelectorAll<HTMLLinkElement>("link[rel=stylesheet]")).filter((l) => !l.sheet);
      await Promise.race([
        Promise.all(pending.map((l) => new Promise((r) => (l.addEventListener("load", r), l.addEventListener("error", r))))),
        new Promise((r) => setTimeout(r, 500)),
      ]);
      await new Promise((r) => setTimeout(r, 16));
      if (closing) return;
      await w.show();
      await w.setFocus();
    });
    useHost.setState({ doc });
    setHost({ win, root });
    return () => {
      closing = true;
      clearInterval(poll);
      unmirror();
      unlisten?.();
      if (useHost.getState().doc === doc) useHost.setState({ doc: document });
      // WebKit ignores window.close() here; Tauri closes it by label.
      void import("@tauri-apps/api/webviewWindow").then(async ({ WebviewWindow }) => {
        const w = await WebviewWindow.getByLabel(label);
        await w?.destroy();
      }).catch(() => win.close());
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return host;
}

/**
 * Rider's commit and diff dialogs: a window of its own that can leave Haze's
 * window (another screen, behind the editor). Outside Tauri, or if the window
 * cannot be opened, a panel over the app moved by its title bar instead.
 */
export function FloatWindow({
  title,
  className,
  width,
  height,
  modal = false,
  onClose,
  children,
}: {
  title: ReactNode;
  className?: string;
  width: number;
  height: number;
  /** In-app fallback only: dims and blocks the app behind. */
  modal?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const host = useExternalWindow(width, height, onClose);
  const external = host === "opening" ? null : host;
  const [size] = useState(() => ({ w: Math.min(width, window.innerWidth - 32), h: Math.min(height, window.innerHeight - 32) }));
  const [pos, setPos] = useState(() => ({ x: (window.innerWidth - size.w) / 2, y: Math.max(16, (window.innerHeight - size.h) / 3) }));
  const ref = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLSpanElement>(null);

  // Take focus so Escape closes it; the content may move focus further in.
  useEffect(() => {
    if (external) external.win.focus();
    ref.current?.focus();
  }, [external]);

  // The native title bar shows the title.
  useEffect(() => {
    if (external && titleRef.current) external.win.document.title = titleRef.current.textContent ?? "";
  });

  const drag = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    const from = { x: e.clientX - pos.x, y: e.clientY - pos.y };
    // Keep the title bar reachable.
    const move = (ev: PointerEvent) =>
      setPos({
        x: Math.max(80 - size.w, Math.min(window.innerWidth - 80, ev.clientX - from.x)),
        y: Math.max(0, Math.min(window.innerHeight - 32, ev.clientY - from.y)),
      });
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Monaco handles its own Escape (closing find, suggestions) first.
    if (e.key === "Escape" && !e.defaultPrevented) onClose();
    // Keep Ctrl+W, Ctrl+Tab… away from the editor tabs behind; saving still works.
    if (!matches(e.nativeEvent, "saveAll")) e.stopPropagation();
  };

  if (host === "opening") return null;
  if (external) {
    return createPortal(
      <div ref={ref} className={"float-window external" + (className ? " " + className : "")} tabIndex={-1} onKeyDown={onKeyDown}>
        <span ref={titleRef} hidden>
          {title}
        </span>
        <div className="float-body">{children}</div>
      </div>,
      external.root,
    );
  }
  const panel = (
    <div
      ref={ref}
      className={"float-window" + (className ? " " + className : "")}
      role="dialog"
      tabIndex={-1}
      style={{ left: pos.x, top: pos.y, width: size.w, height: size.h }}
      onKeyDown={onKeyDown}
    >
      <div className="float-title" onPointerDown={drag} onDoubleClick={() => setPos({ x: (window.innerWidth - size.w) / 2, y: 16 })}>
        <span ref={titleRef} className="float-title-text">
          {title}
        </span>
        <button className="icon-btn" title="Close (Esc)" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <div className="float-body">{children}</div>
    </div>
  );
  return modal ? <div className="modal-backdrop float-backdrop">{panel}</div> : panel;
}

// ------------------------------------------------------------------ toasts

interface ToastAction {
  label: string;
  run: () => void;
}

const useToasts = create<{ items: { id: number; text: string; kind: "error" | "info"; action?: ToastAction }[] }>(() => ({
  items: [],
}));

function dismiss(id: number) {
  useToasts.setState((s) => ({ items: s.items.filter((t) => t.id !== id) }));
}

export function toast(text: string, kind: "error" | "info" = "info", action?: ToastAction): void {
  const id = Date.now() + Math.random();
  useToasts.setState((s) => ({ items: [...s.items, { id, text, kind, action }] }));
  setTimeout(() => dismiss(id), action ? 15000 : kind === "error" ? 8000 : 3500);
}

export function Toasts() {
  const items = useToasts((s) => s.items);
  const doc = useHost((s) => s.doc);
  return inDoc(
    doc,
    <div className="toasts">
      {items.map((t) => (
        <div key={t.id} className={"toast " + t.kind}>
          <span>{t.text}</span>
          {t.action && (
            <button
              className="btn small"
              onClick={() => {
                dismiss(t.id);
                t.action!.run();
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>,
  );
}
