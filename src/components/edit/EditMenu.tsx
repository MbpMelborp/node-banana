"use client";

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/components/nodes/ui/cn";
import { MenuDivider, MenuItem, MenuSurface } from "@/components/ui/Menu";
import { resolvePlatform, revealLabel } from "@/components/assets/assetFormat";
import { getRecorderLibraryStatus } from "@/lib/assets/client/recorder";
import { useEditProjectStore } from "@/store/editProjectStore";
import { ICON_BUTTON } from "@/components/stitch/editorStyles";

/** How many other edits the Open submenu lists before "All edits…". */
const OPEN_LIMIT = 8;

export type ActionMenuEntry =
  | { kind: "item"; label: string; onSelect: () => void; disabled?: boolean; danger?: boolean }
  | { kind: "submenu"; label: string; entries: ActionMenuEntry[] }
  | { kind: "divider" };

/** "Show in Finder", "Show in Explorer" or "Show in folder", for the library's platform. */
export function revealText(): string {
  return revealLabel(resolvePlatform(getRecorderLibraryStatus()));
}

/**
 * A list menu drawn in place under its trigger (no portal: the Edit video
 * view's key handling finds it inside `[data-edit-chrome]`). It focuses its
 * first item; ↑ ↓ Home End move, Enter or a click picks, → opens a submenu
 * and ← or Escape closes it again. Escape and Tab close the menu and give
 * focus back to the trigger; a press outside closes it.
 */
export function ActionMenu({
  label,
  entries,
  triggerRef,
  onClose,
  className,
}: {
  label: string;
  entries: ActionMenuEntry[];
  triggerRef: RefObject<HTMLElement | null>;
  onClose: (refocus: boolean) => void;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (ref.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close.current(false);
    };
    document.addEventListener("pointerdown", onPointerDown, { capture: true });
    return () => document.removeEventListener("pointerdown", onPointerDown, { capture: true });
  }, [triggerRef]);

  return (
    <MenuList
      menuRef={ref}
      label={label}
      entries={entries}
      className={cn("absolute top-full z-100 mt-1 w-[200px]", className)}
      onEscape={() => close.current(true)}
      onPicked={() => close.current(false)}
    />
  );
}

function MenuList({
  menuRef,
  label,
  entries,
  className,
  onEscape,
  onPicked,
  onBack,
}: {
  menuRef: RefObject<HTMLDivElement | null>;
  label: string;
  entries: ActionMenuEntry[];
  className?: string;
  onEscape: () => void;
  onPicked: () => void;
  /** A submenu: ← closes it. */
  onBack?: () => void;
}) {
  const [openSub, setOpenSub] = useState<number | null>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<number, HTMLDivElement>());

  useEffect(() => {
    if (openSub !== null) subRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [openSub]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // A submenu's own keys stay in it
    if (event.target instanceof Node && subRef.current?.contains(event.target)) return;
    const rows = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>(
        ':scope > [role="menuitem"]:not(:disabled), :scope > [role="none"] > [role="menuitem"]',
      ) ?? [],
    );
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

  return (
    <MenuSurface ref={menuRef} role="menu" aria-label={label} floating={false} onKeyDown={onKeyDown} className={cn("py-1", className)}>
      {entries.map((entry, i) => {
        if (entry.kind === "divider") return <MenuDivider key={i} className="my-1" />;
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
              onMouseEnter={() => setOpenSub(i)}
              onMouseLeave={() => setOpenSub(null)}
            >
              <MenuItem
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={open}
                selected={open}
                onClick={() => setOpenSub(open ? null : i)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowRight" || event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    event.stopPropagation();
                    setOpenSub(i);
                  }
                }}
              >
                <span className="truncate">{entry.label}</span>
                <ChevronRight size={12} strokeWidth={2} className="ml-auto shrink-0 text-neutral-500" />
              </MenuItem>
              {open && (
                <MenuList
                  menuRef={subRef}
                  label={entry.label}
                  entries={entry.entries}
                  className="absolute left-full top-0 z-100 -mt-1 ml-1 w-[220px]"
                  onEscape={onEscape}
                  onPicked={onPicked}
                  onBack={() => {
                    setOpenSub(null);
                    itemRefs.current.get(i)?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
                  }}
                />
              )}
            </div>
          );
        }
        return (
          <MenuItem
            key={i}
            role="menuitem"
            disabled={entry.disabled}
            className={cn(entry.danger && "text-red-400 hover:text-red-300")}
            onClick={() => {
              onPicked();
              entry.onSelect();
            }}
          >
            <span className="truncate">{entry.label}</span>
          </MenuItem>
        );
      })}
    </MenuSurface>
  );
}

/**
 * The open edit's menu, beside its name in the header: New edit, Open (the
 * newest other edits, then All edits…), Duplicate, Rename, Show in Finder
 * and Delete… (to the Trash, after a confirm).
 */
export function EditMenu({ onRename }: { onRename: () => void }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const openId = useEditProjectStore((s) => s.open?.id ?? null);
  const edits = useEditProjectStore((s) => s.list.edits);

  const store = () => useEditProjectStore.getState();
  const others = edits.filter((edit) => edit.id !== openId).slice(0, OPEN_LIMIT);
  const entries: ActionMenuEntry[] = [
    { kind: "item", label: "New edit", onSelect: () => void store().newEdit() },
    {
      kind: "submenu",
      label: "Open",
      entries: [
        ...others.map((edit): ActionMenuEntry => ({ kind: "item", label: edit.name, onSelect: () => void store().openEditById(edit.id) })),
        ...(others.length > 0 ? [{ kind: "divider" } as const] : []),
        { kind: "item", label: "All edits…", onSelect: () => void store().goHome() },
      ],
    },
    { kind: "item", label: "Duplicate", onSelect: () => void store().duplicate() },
    { kind: "item", label: "Rename", onSelect: onRename },
    { kind: "item", label: revealText(), onSelect: () => void store().reveal() },
    { kind: "divider" },
    { kind: "item", label: "Delete…", danger: true, onSelect: () => store().requestDelete() },
  ];

  return (
    <div className="relative flex shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-label="Edit menu"
        aria-haspopup="menu"
        aria-expanded={open}
        className={ICON_BUTTON}
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronDown size={14} strokeWidth={2} />
      </button>
      {open && (
        <ActionMenu
          label="Edit menu"
          entries={entries}
          triggerRef={triggerRef}
          className="left-0"
          onClose={(refocus) => {
            setOpen(false);
            if (refocus) triggerRef.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </div>
  );
}
