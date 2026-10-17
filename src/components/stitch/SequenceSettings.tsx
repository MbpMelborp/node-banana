"use client";

import { useEffect, useMemo, useRef } from "react";
import { cn } from "@/components/nodes/ui/cn";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { placedSummary } from "@/lib/stitch/placement";
import { OVERLAP_STEP_SEC, stackSummary } from "@/lib/stitch/stack";
import { clipLength, isPlaced, layoutSpans, sourceKey, spansEnvelope } from "@/lib/stitch/timeline";
import { formatSeconds, parseSeconds } from "@/lib/stitch/timecode";
import { setOverlapSec } from "./editorActions";
import { SECONDS_WELL } from "./editorStyles";
import { TimecodeField } from "./TimecodeField";

/** ⇧ + ↑/↓ in the Overlap well. */
const BIG_STEP_SEC = 1;

const formatOverlap = (seconds: number) => formatSeconds(seconds, 1);

/** ↑/↓: one step from what is stored, as part of one undo step until the field is left. */
function nudgeOverlap(direction: 1 | -1, big: boolean): number | null {
  const current = useStitchEditorStore.getState().draft?.sequenceLayout.overlapSec;
  if (current === undefined) return null;
  setOverlapSec(current + direction * (big ? BIG_STEP_SEC : OVERLAP_STEP_SEC), { gesture: true });
  return useStitchEditorStore.getState().draft?.sequenceLayout.overlapSec ?? null;
}

/**
 * The rail footer's Stacked block, above Loop sequence: a live line saying
 * what Overlap and Crossfade (in the transport) do to this sequence
 * (stackSummary; once a clip is placed, placedSummary), then the row with
 * the Overlap well. Inert, like the loop row under it, while the draft has
 * no clips.
 *
 * The line sits above the row so that nothing the line says can move the
 * row. The footer sits on the rail's bottom: the row rests on the fixed
 * Loop row, and a line that gains or loses a sentence takes its height from
 * the rail body above, which scrolls. When the body has no more room to
 * give (a short window), the line is cut to what fits, a whole text line at
 * a time, with its full text on hover.
 *
 * A press anywhere in the rail can blur a typed value (Start, In, Out,
 * Overlap) whose commit changes the line. From the press until its click
 * has landed the line keeps the height it had: a shorter line would let a
 * body scrolled to its end grow, and move the button under the pointer.
 */
export function SequenceSettings({
  empty,
  hasMusic = false,
}: {
  empty: boolean;
  /** Music plays under the sequence (connected and not muted): a gap then plays it on. */
  hasMusic?: boolean;
}) {
  const layout = useStitchEditorStore((s) => s.draft?.sequenceLayout);
  const timeline = useStitchEditorStore((s) => s.draft?.timeline);
  const loopCount = useStitchEditorStore((s) => s.draft?.loopCount ?? 1);
  const durations = useStitchEditorStore((s) => s.durations);
  const endGesture = useStitchEditorStore((s) => s.endGesture);
  const lineRef = useRef<HTMLParagraphElement>(null);
  const shown = layout !== undefined;

  useEffect(() => {
    const line = lineRef.current;
    const rail = line?.closest("aside");
    if (!line || !rail) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onPress = () => {
      clearTimeout(timer);
      line.style.minHeight = `${line.offsetHeight}px`;
      const done = () => {
        window.removeEventListener("pointerup", done, true);
        window.removeEventListener("pointercancel", done, true);
        // The click comes after the pointerup, in the same input: let go once it has
        timer = setTimeout(() => {
          line.style.minHeight = "";
        }, 0);
      };
      window.addEventListener("pointerup", done, true);
      window.addEventListener("pointercancel", done, true);
    };
    rail.addEventListener("pointerdown", onPress, true);
    return () => {
      rail.removeEventListener("pointerdown", onPress, true);
      clearTimeout(timer);
    };
  }, [shown]);

  const summary = useMemo(() => {
    if (!layout || !timeline) return "";
    if (isPlaced(timeline)) {
      return placedSummary(spansEnvelope(layoutSpans(timeline, durations, layout), layout.crossfade), loopCount, {
        hasMusic,
      });
    }
    const items = timeline.map((clip) => {
      const key = sourceKey(clip.source);
      return { length: clipLength(clip, durations.get(key)), source: key };
    });
    return stackSummary(items, layout, loopCount);
  }, [layout, timeline, durations, loopCount, hasMusic]);

  if (!layout) return null;
  return (
    <div
      className={cn(
        "flex min-h-0 flex-col border-t border-chrome-border/50 px-5",
        empty && "opacity-50 pointer-events-none",
      )}
      inert={empty}
    >
      {/* One column whose overflow flows to its right and is clipped, so a cut line loses whole lines */}
      <p
        ref={lineRef}
        data-testid="stitch-sequence-summary"
        className="columns-1 overflow-hidden pt-2 text-[11px] leading-[14px] text-neutral-500 [orphans:1] [widows:1]"
        title={summary}
      >
        {summary}
      </p>
      <div className="h-9 shrink-0 flex items-center">
        {/* Leaving the well ends a run of ↑/↓ nudges: the next one is a new undo step */}
        <div className="flex items-center gap-2" onBlur={endGesture}>
          <span
            className="text-xs text-neutral-400"
            title="How far each clip overlaps the one above when lined up, and where new clips go."
          >
            Overlap
          </span>
          <TimecodeField
            label="Overlap"
            value={layout.overlapSec}
            format={formatOverlap}
            parse={parseSeconds}
            className={SECONDS_WELL}
            onCommit={(seconds) => setOverlapSec(seconds)}
            onNudge={nudgeOverlap}
          />
        </div>
      </div>
    </div>
  );
}
