"use client";

import { useStitchEditorStore } from "@/store/stitchEditorStore";
import type { TimeAxis } from "@/lib/stitch/timeAxis";

/**
 * The playhead: a 1px line down the lanes and a small pentagon head on the
 * ruler. The only part of the timeline that renders per frame while the
 * preview plays (useTimelineZoom keeps it in view). While a trim is snapped
 * to it, the line is left out and the trim's dashed guide takes its place
 * under the head (Trim.png). While a trim lengthens a clip, the timeline
 * passes the axis release will leave (liveSpans), so the playhead moves with
 * the pushed clips and slots. Stacked draws the head in the sticky ruler
 * and the line down the scrolling rows, so each takes one part; the head's
 * part carries the line on through the ruler, which covers the rows' line.
 */
export function Playhead({
  axis,
  limit = axis.total,
  hideLine = false,
  part = "all",
}: {
  axis: TimeAxis;
  /** The playhead is drawn no later than this (the sequence's end at rest; a stored one past it sits there). */
  limit?: number;
  hideLine?: boolean;
  part?: "all" | "line" | "head";
}) {
  const playhead = useStitchEditorStore((s) => s.playhead);
  const x = axis.timeToX(Math.min(playhead, limit));

  return (
    <>
      {!hideLine && (
        <div
          aria-hidden="true"
          data-testid={part === "head" ? undefined : "stitch-playhead-line"}
          className="pointer-events-none absolute inset-y-0 z-3 w-px bg-neutral-200"
          style={{ left: x }}
        />
      )}
      {part !== "line" && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-0 z-3 h-[13px] w-[11px] bg-neutral-200 [clip-path:polygon(0_0,100%_0,100%_55%,50%_100%,0_55%)]"
          style={{ left: x - 5 }}
        />
      )}
    </>
  );
}
