"use client";

import type { ReactNode } from "react";
import { Plus } from "lucide-react";
import { cn } from "@/components/nodes/ui/cn";
import { EDITOR_CHIP } from "../editorStyles";

/**
 * The chips beside a curve a box draws (an audio clip's volume, a video clip's speed): the dragged point's readout and
 * the hint where a press would add one. Siblings of the box, in its row's coordinates (lane x, the row's y); they pass
 * presses through and are no options of the lane's listbox.
 */

/** Room a chip beside a point needs before it would pass the visible lanes' right side; it goes left of the point then. */
const CHIP_ROOM = 130;

/** `gap` px right of x, or left of it when the chip would pass `right` (the visible lanes' right, or the content's end). */
const beside = (at: number, gap: number, right: number) =>
  at + gap + CHIP_ROOM > right ? { right: `calc(100% - ${at - gap}px)` } : { left: at + gap };

/** What the dragged point says, centred on it: its value, then its time. */
export function CurveReadout({
  x,
  y,
  right,
  testId,
  children,
}: {
  x: number;
  y: number;
  right: number;
  testId: string;
  children: ReactNode;
}) {
  return (
    <div
      aria-hidden="true"
      data-testid={testId}
      className={cn(EDITOR_CHIP, "pointer-events-none absolute z-4 inline-flex -translate-y-1/2 items-center gap-2 whitespace-nowrap tabular-nums")}
      style={{ top: y, ...beside(x, 12, right) }}
    >
      {children}
    </div>
  );
}

/** Over the hover ghost: what a press there does. */
export function AddPointHint({
  x,
  y,
  right,
  testId,
  label,
}: {
  x: number;
  y: number;
  right: number;
  testId: string;
  label: string;
}) {
  return (
    <div
      aria-hidden="true"
      data-testid={testId}
      className={cn(
        EDITOR_CHIP,
        "pointer-events-none absolute z-4 inline-flex -translate-y-full items-center gap-[5px] whitespace-nowrap px-[7px] py-[3px] text-neutral-300",
      )}
      style={{ top: y - 4, ...beside(x, 6, right) }}
    >
      <Plus size={10} strokeWidth={2.25} />
      {label}
    </div>
  );
}
