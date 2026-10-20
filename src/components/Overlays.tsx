// Context menu and modal dialogs, driven by small global stores so any
// module can open them imperatively.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { create } from "zustand";

export interface MenuItem {
  label?: string;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  separator?: boolean;
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
            <span>{it.label}</span>
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
  const primary = req.buttons.find((b) => b.primary || b.danger)?.value ?? req.buttons[req.buttons.length - 1]?.value;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && finish(null)}>
      <div
        className="modal"
        role="dialog"
        onKeyDown={(e) => {
          if (e.key === "Escape") finish(null);
          if (e.key === "Enter" && !e.nativeEvent.isComposing) finish(primary ?? null);
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
