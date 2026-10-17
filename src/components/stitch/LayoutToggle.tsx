"use client";

import { cn } from "@/components/nodes/ui/cn";
import { Tooltip } from "@/components/ui/Tooltip";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import type { StitchSequenceLayout } from "@/types";
import { setSequenceMode } from "./editorActions";
import { keepFocus } from "./timeline/ClipBox";
import { releaseTypingFocus } from "./timeline/releaseTypingFocus";

type Mode = StitchSequenceLayout["mode"];

/** Diagrams of the two layouts rather than symbols, so they stay hand-drawn (like the canvas's connector toggle). */
function LayoutGlyph({ mode }: { mode: Mode }) {
  // Track: three bars end to end on one line. Stacked: one bar per row, here as lined up, each starting before the one
  // above ends.
  // Each bar's ends and top sit on whole pixels (with the round caps), so the gaps stay clear at 1x.
  const d =
    mode === "track"
      ? "M1.75 4.75h1.5M5.75 4.75h1.5M9.75 4.75h1.5"
      : "M1.75 1.75h2.5M4.75 4.75h2.5M7.75 7.75h2.5";
  return (
    <svg
      width={12}
      height={10}
      viewBox="0 0 12 10"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

const OPTIONS: ReadonlyArray<{ mode: Mode; label: string; tip: string }> = [
  { mode: "track", label: "Track", tip: "Track: clips end to end on one row" },
  { mode: "stacked", label: "Stacked", tip: "Stacked: one row per clip, placed anywhere in time" },
];

/**
 * Track | Stacked, at the transport's right end after Fit. A switch changes
 * the timeline's height, and the timeline grows up from the panel's bottom,
 * so with three or more clips the transport, and the toggle in it, moves up
 * or down by the difference. A node setting, so a switch is one undo step
 * and Done writes it; the editor pauses on any switch (the modal's own
 * effect). Inert, like the rest of the transport, while the draft has no
 * clips.
 */
export function LayoutToggle() {
  const mode = useStitchEditorStore((s) => s.draft?.sequenceLayout.mode ?? "track");
  const empty = useStitchEditorStore((s) => (s.draft?.timeline.length ?? 0) === 0);
  return (
    <div
      role="group"
      aria-label="Timeline layout"
      inert={empty}
      className="flex h-7 shrink-0 gap-0.5 rounded-lg bg-editor-well px-0.5"
    >
      {OPTIONS.map((option) => {
        const pressed = option.mode === mode;
        return (
          // The tooltips open up, into the stage: the wrapper is the well's height, so they line up
          <div key={option.mode} className="group relative flex py-0.5">
            <button
              type="button"
              aria-label={option.label}
              aria-pressed={pressed}
              // Focus stays where it was, so the editor's keys keep working after a click; a field being typed in
              // (Overlap, which Track takes away) gives it up first and commits, as a click elsewhere would
              onMouseDown={(event) => {
                releaseTypingFocus(event.currentTarget);
                keepFocus(event);
              }}
              onClick={() => setSequenceMode(option.mode)}
              className={cn(
                "inline-flex h-6 w-7 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection",
                pressed ? "bg-white/12 text-neutral-100" : "text-neutral-500 hover:text-neutral-200",
              )}
            >
              <LayoutGlyph mode={option.mode} />
            </button>
            <Tooltip label={option.tip} placement="top" />
          </div>
        );
      })}
    </div>
  );
}
