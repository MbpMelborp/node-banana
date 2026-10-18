"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Check, ChevronRight, MoreHorizontal } from "lucide-react";
import { cn } from "@/components/nodes/ui/cn";
import { MenuDivider, MenuItem, MenuSurface } from "@/components/ui/Menu";
import { HEADER_ICON_BUTTON } from "./editorStyles";

/** One of a set; picking it closes the menu like an item. */
export type ActionMenuRadio = { kind: "radio"; label: string; checked: boolean; onSelect: () => void; disabled?: boolean };

export type ActionMenuEntry =
  | { kind: "item"; label: string; onSelect: () => void; disabled?: boolean }
  | {
      kind: "submenu";
      label: string;
      entries: ActionMenuEntry[];
      /** What it is set to, at the row's right (Loop's "2×"). */
      value?: string;
      disabled?: boolean;
      /** A muted line under the submenu's rows. */
      footer?: ReactNode;
    }
  | ActionMenuRadio
  /** A set of radios in the menu itself under a muted label (the dialog's Loop), with a muted note under them. */
  | { kind: "group"; label: string; entries: ActionMenuRadio[]; footer?: ReactNode }
  | { kind: "divider" };

/** The rows ↑ ↓ Home End move between: the menu's own, a submenu's trigger and a group's radios included, never a submenu's rows. */
const ROWS = [
  ':scope > [role^="menuitem"]:not(:disabled)',
  ':scope > [role="none"] > [role="menuitem"]:not(:disabled)',
  ':scope > [role="group"] > [role^="menuitem"]:not(:disabled)',
].join(", ");

/** How long a submenu stays once the pointer leaves its row: long enough to cross a row on the way into it. */
const SUBMENU_CLOSE_MS = 300;

/** The shared menu surface in the boards' skin for the edit menu: 220px, a hairline on neutral-900, 10px corners. Submenus hang outside it. */
const SURFACE = "w-[220px] overflow-visible rounded-[10px] border-neutral-800 bg-neutral-900 p-1 shadow-edit-menu";

/** The shared menu row at the boards' size: 32px in 13px type, lit on hover, on keyboard focus and while its submenu is open. */
const ROW =
  "h-8 rounded-md py-0 text-[13px] text-neutral-200 hover:bg-white/6 focus-visible:bg-white/6 disabled:cursor-default disabled:text-neutral-600 disabled:opacity-100";

/** A muted line in the menu: a group's label and note, the footer. */
const MUTED = "px-2.5 text-xs leading-4 tabular-nums text-ink-3";

/** Focus a menu's first row; with none to take it (each one off), the menu itself, so its Escape and Tab still work. */
function focusFirstRow(menu: HTMLElement | null, options?: FocusOptions) {
  if (!menu) return;
  (menu.querySelector<HTMLElement>(ROWS) ?? menu).focus(options);
}

/**
 * A list menu drawn in place under its trigger (no portal: the Edit video
 * view's key handling finds it inside `[data-edit-chrome]`, the dialog's
 * inside its header), on the shared menu parts in the boards' skin. It
 * focuses its first row (or itself, when every row is off); ↑ ↓ Home End
 * move, Enter or a click picks, → or a click opens a submenu and ← or Escape
 * closes it again. Escape and Tab close the menu and give focus back to the
 * trigger, as a pick does unless the pick moved focus itself (Rename's
 * field); a press outside closes it. A `footer` is a muted line under the
 * rows (the edit's clips, size and rate), which the menu names as its
 * description.
 */
export function ActionMenu({
  label,
  entries,
  footer,
  triggerRef,
  onClose,
  submenuSide = "right",
  className,
}: {
  label: string;
  entries: ActionMenuEntry[];
  footer?: ReactNode;
  triggerRef: RefObject<HTMLElement | null>;
  onClose: (refocus: boolean) => void;
  /** Where submenus open: "left" for a menu at the window's right edge. */
  submenuSide?: "left" | "right";
  className?: string;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });

  useEffect(() => {
    const surface = surfaceRef.current;
    // The trigger stays while its menu is open; a closed menu gives focus back to it (if it is still there)
    const trigger = triggerRef.current;
    focusFirstRow(menuRef.current, { preventScroll: true });
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (surface?.contains(target) || trigger?.contains(target)) return;
      close.current(false);
    };
    document.addEventListener("pointerdown", onPointerDown, { capture: true });
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, { capture: true });
      // The focused row goes with the menu: focus would fall to <body>, outside a dialog's Tab trap
      const active = document.activeElement;
      if (trigger?.isConnected && (!active || active === document.body || surface?.contains(active))) {
        trigger.focus({ preventScroll: true });
      }
    };
  }, [triggerRef]);

  return (
    <MenuList
      surfaceRef={surfaceRef}
      menuRef={menuRef}
      label={label}
      entries={entries}
      footer={footer}
      submenuSide={submenuSide}
      className={cn("absolute top-full z-100 mt-1", className)}
      onEscape={() => close.current(true)}
      onPicked={() => close.current(false)}
    />
  );
}

function MenuList({
  surfaceRef,
  menuRef,
  label,
  entries,
  footer,
  submenuSide,
  className,
  onEscape,
  onPicked,
  onBack,
}: {
  surfaceRef?: RefObject<HTMLDivElement | null>;
  menuRef: RefObject<HTMLDivElement | null>;
  label: string;
  entries: ActionMenuEntry[];
  footer?: ReactNode;
  submenuSide: "left" | "right";
  className?: string;
  onEscape: () => void;
  onPicked: () => void;
  /** A submenu: ← closes it. */
  onBack?: () => void;
}) {
  const [openSub, setOpenSub] = useState<number | null>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<number, HTMLDivElement>());
  // A pending close of the open submenu; a timer left at unmount only sets state that is gone
  const closeTimer = useRef<number | null>(null);
  const id = useId();

  const cancelClose = () => {
    if (closeTimer.current === null) return;
    window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };

  /** The row that opens submenu `i`. */
  const submenuTrigger = (i: number) => itemRefs.current.get(i)?.querySelector<HTMLElement>(':scope > [role="menuitem"]') ?? null;

  /** → Enter Space on a submenu's row: open it, or go into it when it is open already (a hover opened it). */
  const enterSubmenu = (i: number) => {
    cancelClose();
    if (openSub === i) focusFirstRow(subRef.current);
    else setOpenSub(i);
  };

  useEffect(() => {
    if (openSub !== null) focusFirstRow(subRef.current);
  }, [openSub]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // A submenu's own keys stay in it
    if (event.target instanceof Node && subRef.current?.contains(event.target)) return;
    const rows = Array.from(menuRef.current?.querySelectorAll<HTMLElement>(ROWS) ?? []);
    const index = rows.indexOf(document.activeElement as HTMLElement);
    let next: number | null = null;
    if (event.key === "ArrowDown") next = index < 0 ? 0 : (index + 1) % rows.length;
    else if (event.key === "ArrowUp") next = index <= 0 ? rows.length - 1 : index - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = rows.length - 1;
    else if (event.key === "ArrowLeft" && onBack) {
      event.preventDefault();
      event.stopPropagation();
      onBack();
      return;
    } else if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      if (onBack && event.key === "Escape") onBack();
      else onEscape();
      return;
    }
    if (next === null) return;
    event.preventDefault();
    rows[next]?.focus();
  };

  const pick = (onSelect: () => void) => {
    onPicked();
    onSelect();
  };

  const radio = (entry: ActionMenuRadio, key: string | number) => (
    <MenuItem
      key={key}
      role="menuitemradio"
      aria-checked={entry.checked}
      disabled={entry.disabled}
      className={ROW}
      onClick={() => pick(entry.onSelect)}
    >
      <span className="truncate">{entry.label}</span>
      {entry.checked && <Check size={14} strokeWidth={1.5} className="ml-auto shrink-0" aria-hidden="true" />}
    </MenuItem>
  );

  return (
    <MenuSurface ref={surfaceRef} floating={false} className={cn(SURFACE, className)}>
      <div
        ref={menuRef}
        role="menu"
        aria-label={label}
        aria-describedby={footer ? `${id}-footer` : undefined}
        // Focusable itself for a menu whose every row is off: its Escape and Tab must still be heard
        tabIndex={-1}
        className="outline-none"
        onKeyDown={onKeyDown}
      >
        {entries.map((entry, i) => {
          if (entry.kind === "divider") return <MenuDivider key={i} role="separator" className="my-1 border-neutral-800" />;
          if (entry.kind === "radio") return radio(entry, i);
          if (entry.kind === "group") {
            const note = entry.footer ? `${id}-${i}-note` : undefined;
            return (
              <div key={i} role="group" aria-label={entry.label} aria-describedby={note}>
                <div aria-hidden="true" className={cn(MUTED, "pb-1 pt-1.5")}>
                  {entry.label}
                </div>
                {entry.entries.map((r, j) => radio(r, j))}
                {entry.footer && (
                  <div id={note} className={cn(MUTED, "pb-1.5 pt-1")}>
                    {entry.footer}
                  </div>
                )}
              </div>
            );
          }
          if (entry.kind === "submenu") {
            const open = openSub === i;
            return (
              <div
                key={i}
                ref={(el) => {
                  if (el) itemRefs.current.set(i, el);
                  else itemRefs.current.delete(i);
                }}
                role="none"
                className="relative"
                onMouseEnter={() => {
                  cancelClose();
                  if (!entry.disabled) setOpenSub(i);
                }}
                // Not at once: a pointer headed for the submenu often crosses the row under this one first
                onMouseLeave={() => {
                  cancelClose();
                  closeTimer.current = window.setTimeout(() => {
                    closeTimer.current = null;
                    // Its focused row goes with it: focus stays in the menu, on the row that opened it
                    const row = itemRefs.current.get(i);
                    const trigger = submenuTrigger(i);
                    if (row?.contains(document.activeElement) && document.activeElement !== trigger) {
                      trigger?.focus({ preventScroll: true });
                    }
                    setOpenSub((current) => (current === i ? null : current));
                  }, SUBMENU_CLOSE_MS);
                }}
              >
                <MenuItem
                  role="menuitem"
                  aria-haspopup="menu"
                  aria-expanded={open}
                  // "Loop: 2×", not the run-together "Loop2×" its two spans would make
                  aria-label={entry.value !== undefined ? `${entry.label}: ${entry.value}` : undefined}
                  disabled={entry.disabled}
                  className={cn(ROW, open && "bg-white/6 text-neutral-100")}
                  // Opens it and leaves it open: a hover has usually opened it already, and a click must not shut it
                  onClick={() => {
                    cancelClose();
                    setOpenSub(i);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowRight" || event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      event.stopPropagation();
                      enterSubmenu(i);
                    }
                  }}
                >
                  <span className="truncate">{entry.label}</span>
                  <span className="ml-auto flex shrink-0 items-center gap-1 text-ink-3">
                    {entry.value !== undefined && <span className="tabular-nums">{entry.value}</span>}
                    <ChevronRight size={14} strokeWidth={1.5} aria-hidden="true" />
                  </span>
                </MenuItem>
                {open && (
                  <MenuList
                    menuRef={subRef}
                    label={entry.label}
                    entries={entry.entries}
                    footer={entry.footer}
                    submenuSide={submenuSide}
                    // Its first row level with the trigger, and touching it: a pointer crossing a gap would close it
                    className={cn("absolute top-0 z-100 -mt-[5px]", submenuSide === "left" ? "right-full" : "left-full")}
                    onEscape={onEscape}
                    onPicked={onPicked}
                    onBack={() => {
                      cancelClose();
                      setOpenSub(null);
                      submenuTrigger(i)?.focus();
                    }}
                  />
                )}
              </div>
            );
          }
          return (
            <MenuItem key={i} role="menuitem" disabled={entry.disabled} className={ROW} onClick={() => pick(entry.onSelect)}>
              <span className="truncate">{entry.label}</span>
            </MenuItem>
          );
        })}
      </div>
      {footer && (
        <div id={`${id}-footer`} className={cn(MUTED, "pb-1.5 pt-2")}>
          {footer}
        </div>
      )}
    </MenuSurface>
  );
}

/**
 * A header's ⋯: a 32px button, filled while its menu is open, and the menu
 * under it at its right edge, its submenus opening leftward (the headers end
 * at the window's right edge).
 */
export function MoreMenu({
  label,
  entries,
  footer,
}: {
  label: string;
  entries: ActionMenuEntry[];
  footer?: ReactNode;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <div className="relative flex shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        className={HEADER_ICON_BUTTON}
        onClick={() => setOpen((o) => !o)}
      >
        <MoreHorizontal size={16} strokeWidth={1.5} />
      </button>
      {open && (
        <ActionMenu
          label={label}
          entries={entries}
          footer={footer}
          triggerRef={triggerRef}
          submenuSide="left"
          className="right-0 mt-1.5"
          onClose={(refocus) => {
            setOpen(false);
            if (refocus) triggerRef.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </div>
  );
}
