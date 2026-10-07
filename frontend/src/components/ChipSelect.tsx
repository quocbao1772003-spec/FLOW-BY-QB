import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import "./ChipSelect.css";

/**
 * A pill-shaped picker that replaces the native <select> on node footers.
 *
 * The native popup is drawn by the OS (white/blue, tiny type) and ignores
 * the app theme; this renders the same choice list as a themed menu. The
 * menu is portalled to <body> because the ReactFlow canvas is CSS-scaled —
 * a menu inside it would zoom with the canvas and get clipped by the node.
 */

export interface ChipOption<V extends string | number> {
  value: V;
  /** Text on the chip when this option is selected. */
  label: ReactNode;
  /** Text in the menu row (defaults to `label`). */
  menuLabel?: ReactNode;
  /** Second, muted line in the menu row. */
  hint?: ReactNode;
}

interface Props<V extends string | number> {
  value: V;
  options: ChipOption<V>[];
  onChange(v: V): void;
  /** Small caps heading above the rows, e.g. "Model ảnh". */
  heading?: string;
  title?: string;
  ariaLabel?: string;
  className?: string;
  disabled?: boolean;
  /** "chip" = node footer pill, "field" = full-width form field. */
  variant?: "chip" | "field";
}

const MENU_GAP = 6;

export function ChipSelect<V extends string | number>({
  value,
  options,
  onChange,
  heading,
  title,
  ariaLabel,
  className,
  disabled,
  variant = "chip",
}: Props<V>) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; minWidth: number } | null>(null);

  const selectedIdx = Math.max(0, options.findIndex((o) => o.value === value));
  const selected = options[selectedIdx];

  const place = useCallback(() => {
    const b = btnRef.current;
    if (!b) return;
    const r = b.getBoundingClientRect();
    const menuH = menuRef.current?.offsetHeight ?? options.length * 40 + 40;
    const menuW = menuRef.current?.offsetWidth ?? 200;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top = r.bottom + MENU_GAP;
    if (top + menuH > vh - 8 && r.top - MENU_GAP - menuH > 8) top = r.top - MENU_GAP - menuH;
    let left = r.left;
    if (left + menuW > vw - 8) left = Math.max(8, vw - menuW - 8);
    setPos({ left, top, minWidth: Math.max(r.width, variant === "field" ? r.width : 168) });
  }, [options.length, variant]);

  const close = useCallback(() => setOpen(false), []);

  function toggle() {
    if (disabled) return;
    setActive(selectedIdx);
    setOpen((o) => !o);
  }

  function pick(i: number) {
    const o = options[i];
    if (!o) return;
    setOpen(false);
    if (o.value !== value) onChange(o.value);
    btnRef.current?.focus();
  }

  // Position on open, then again once the menu has a real size (flip up
  // when there's no room below).
  useLayoutEffect(() => {
    if (!open) return;
    place();
    const id = requestAnimationFrame(place);
    return () => cancelAnimationFrame(id);
  }, [open, place]);

  // Dismiss: outside press (capture phase — ReactFlow stops bubbling),
  // canvas pan/zoom (wheel), resize, scroll.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (menuRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onMove = (e: Event) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("wheel", onMove, { capture: true, passive: true });
    window.addEventListener("resize", close);
    window.addEventListener("scroll", onMove, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("wheel", onMove, { capture: true } as EventListenerOptions);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open, close]);

  function onKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>) {
    e.stopPropagation();
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % options.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a - 1 + options.length) % options.length);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(active);
    } else if (e.key === "Escape" || e.key === "Tab") {
      setOpen(false);
    }
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`chip-select chip-select--${variant}${open ? " chip-select--open" : ""}${
          variant === "chip" ? " node-chip" : ""
        } nodrag${className ? ` ${className}` : ""}`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          toggle();
        }}
        onKeyDown={onKeyDown}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
      >
        <span className="chip-select__value">{selected?.label}</span>
        <svg className="chip-select__chev" width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="chip-menu"
            role="listbox"
            aria-label={ariaLabel}
            style={{
              left: pos?.left ?? -9999,
              top: pos?.top ?? -9999,
              minWidth: pos?.minWidth,
              visibility: pos ? "visible" : "hidden",
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {heading && <div className="chip-menu__heading">{heading}</div>}
            {options.map((o, i) => {
              const isSel = i === selectedIdx;
              return (
                <div
                  key={String(o.value)}
                  role="option"
                  aria-selected={isSel}
                  className={`chip-menu__item${isSel ? " chip-menu__item--selected" : ""}${
                    i === active ? " chip-menu__item--active" : ""
                  }`}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(i)}
                >
                  <span className="chip-menu__check" aria-hidden="true">
                    {isSel && (
                      <svg width="12" height="12" viewBox="0 0 12 12">
                        <path d="M2.5 6.2l2.3 2.3 4.7-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </span>
                  <span className="chip-menu__text">
                    <span className="chip-menu__label">{o.menuLabel ?? o.label}</span>
                    {o.hint && <span className="chip-menu__hint">{o.hint}</span>}
                  </span>
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
