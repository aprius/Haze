// Context menu and modal dialogs, driven by small global stores so any
// module can open them imperatively.
import { Check, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
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

const useMenu = create<{ x: number; y: number; items: MenuItem[] | null }>(() => ({ x: 0, y: 0, items: null }));

export function openMenu(e: { clientX: number; clientY: number }, items: MenuItem[]): void {
  useMenu.setState({ x: e.clientX, y: e.clientY, items });
}

function closeMenu() {
  useMenu.setState({ items: null });
}

export function ContextMenu() {
  const { x, y, items } = useMenu();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    if (!items || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({
      x: Math.min(x, window.innerWidth - r.width - 4),
      y: Math.min(y, window.innerHeight - r.height - 4),
    });
  }, [items, x, y]);

  useEffect(() => {
    if (!items) return;
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
  }, [items]);

  if (!items) return null;
  return (
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
    </div>
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
}

const useDialog = create<{ current: DialogRequest | null }>(() => ({ current: null }));

function show(req: Omit<DialogRequest, "resolve">): Promise<{ button: string | null; value: string }> {
  return new Promise((resolve) => useDialog.setState({ current: { ...req, resolve } }));
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

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && finish(null)}>
      <div
        className="modal"
        role="dialog"
        onKeyDown={(e) => {
          if (e.key === "Escape") finish(null);
          // A focused button (tabbed to "Cancel") handles Enter itself.
          if (e.key === "Enter" && !e.nativeEvent.isComposing && !(e.target instanceof HTMLButtonElement)) finish(primary ?? null);
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
    </div>
  );
}

// ------------------------------------------------------------------ floating windows

/** A window over the app, moved by its title bar and resized from its corner, like Rider's commit and diff dialogs. */
export function FloatWindow({
  title,
  className,
  width,
  height,
  onClose,
  children,
}: {
  title: ReactNode;
  className?: string;
  width: number;
  height: number;
  onClose: () => void;
  children: ReactNode;
}) {
  const [size] = useState(() => ({ w: Math.min(width, window.innerWidth - 32), h: Math.min(height, window.innerHeight - 32) }));
  const [pos, setPos] = useState(() => ({ x: (window.innerWidth - size.w) / 2, y: Math.max(16, (window.innerHeight - size.h) / 3) }));
  const ref = useRef<HTMLDivElement>(null);

  // Take focus so Escape closes it; the content may move focus further in.
  useEffect(() => ref.current?.focus(), []);

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

  return (
    <div
      ref={ref}
      className={"float-window" + (className ? " " + className : "")}
      role="dialog"
      tabIndex={-1}
      style={{ left: pos.x, top: pos.y, width: size.w, height: size.h }}
      onKeyDown={(e) => {
        // Monaco handles its own Escape (closing find, suggestions) first.
        if (e.key === "Escape" && !e.defaultPrevented) onClose();
        // Keep Ctrl+W, Ctrl+Tab… away from the editor tabs behind; saving still works.
        if (!matches(e.nativeEvent, "saveAll")) e.stopPropagation();
      }}
    >
      <div className="float-title" onPointerDown={drag} onDoubleClick={() => setPos({ x: (window.innerWidth - size.w) / 2, y: 16 })}>
        <span className="float-title-text">{title}</span>
        <button className="icon-btn" title="Close (Esc)" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <div className="float-body">{children}</div>
    </div>
  );
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
  return (
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
    </div>
  );
}
