"use client";

import type { ReactNode } from "react";
import { cn } from "@/components/nodes/ui/cn";
import { Kbd } from "@/components/ui/Kbd";
import { MenuShortcut } from "@/components/ui/Menu";
import { RAIL_BUTTON } from "./editorStyles";

/** A rail row: its label at the left, its control at the right. */
export function RailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="h-7 flex items-center justify-between gap-3">
      <span className="text-xs text-neutral-400">{label}</span>
      {children}
    </div>
  );
}

/** The keys under a rail's actions, each beside what it does. */
export function KeyHints({ hints }: { hints: ReadonlyArray<{ key: string; text: string }> }) {
  return (
    <div className="mt-4 flex flex-col gap-1.5 text-[11px] text-neutral-500">
      {hints.map((hint) => (
        <div key={hint.key} className="flex items-start gap-1.5">
          {/* One cap width that never gives way to a long text, so the texts start in one column (⇧ and ⌥ are wider
              than I and O); a text that wraps lines up with the cap by its first line */}
          <Kbd size="sm" className="w-[22px] shrink-0 px-0">
            {hint.key}
          </Kbd>
          <span className="leading-[18px]">{hint.text}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * A rail action. Busy keeps the button focusable (aria-disabled, not disabled, which would drop focus) and ignores
 * its clicks until the work it started ends.
 */
export function RailButton({
  icon,
  label,
  shortcut,
  danger,
  disabled,
  busy,
  title,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  busy?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(RAIL_BUTTON, danger && "text-red-400", busy && "cursor-progress")}
      disabled={disabled}
      aria-busy={busy || undefined}
      aria-disabled={busy || undefined}
      title={title}
      onClick={busy ? undefined : onClick}
    >
      {icon}
      <span className="flex-1">{label}</span>
      {shortcut && <MenuShortcut>{shortcut}</MenuShortcut>}
    </button>
  );
}
