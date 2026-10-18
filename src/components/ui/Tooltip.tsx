"use client";

import { KbdGroup } from "@/components/ui/Kbd";

export type TooltipPlacement = "top" | "bottom";
/** "start" and "end" keep the label inside the window for a button on the left or right edge. */
export type TooltipAlign = "start" | "center" | "end";

/**
 * Hover label for an icon-only button. CSS-driven (300ms delay, fades in on
 * hover and on keyboard focus), so it never fights the popover state. Render it
 * inside a `group relative` wrapper around the button.
 */
export function Tooltip({
  label,
  shortcut,
  placement = "top",
  align = "center",
}: {
  label: string;
  shortcut?: string;
  placement?: TooltipPlacement;
  align?: TooltipAlign;
}) {
  const side = placement === "bottom" ? "top-full mt-2.5" : "bottom-full mb-2.5";
  const edge = align === "end" ? "right-0" : align === "start" ? "left-0" : "left-1/2 -translate-x-1/2";
  return (
    <span
      aria-hidden="true"
      className={`pointer-events-none absolute ${side} ${edge} z-10 flex items-center gap-1.5 whitespace-nowrap rounded-md squircle border border-white/10 bg-neutral-950 py-1 pl-2 pr-1.5 text-[10px] font-medium leading-3 text-neutral-200 opacity-0 shadow-[0_4px_12px_rgba(0,0,0,0.5)] transition-opacity delay-300 duration-[120ms] group-hover:opacity-100 group-has-focus-visible:opacity-100`}
    >
      {label}
      {shortcut && <KbdGroup keys={shortcut} size="xs" className="gap-0.5 [&_kbd]:text-neutral-400" />}
    </span>
  );
}
