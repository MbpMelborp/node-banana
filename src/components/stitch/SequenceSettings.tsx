"use client";

import { useMemo } from "react";
import { cn } from "@/components/nodes/ui/cn";
import { Switch } from "@/components/ui/Controls";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { OVERLAP_STEP_SEC, stackSummary } from "@/lib/stitch/stack";
import { clipLength, sourceKey } from "@/lib/stitch/timeline";
import { formatSeconds, parseSeconds } from "@/lib/stitch/timecode";
import { setCrossfade, setOverlapSec } from "./editorActions";
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
 * what Overlap and Crossfade do to this sequence (stackSummary), then the
 * row with the Overlap well and the Crossfade switch. Inert, like the loop
 * row under it, while the draft has no clips.
 *
 * The line sits above the row so that nothing the line says can move the
 * row. The footer sits on the rail's bottom: the row rests on the fixed
 * Loop row, and a line that gains or loses a sentence takes its height from
 * the rail body above. Pressing the switch blurs a typed Overlap, whose
 * commit can change the line; the switch stays under the pointer. When the
 * body has no more room to give (a short window), the line is cut to what
 * fits, a whole text line at a time, with its full text on hover. One press
 * can still miss: with the body scrolled to its end, a commit that makes
 * the line one text line shorter lets the body grow 14px, and the body's
 * content moves down under the pointer.
 */
export function SequenceSettings({ empty }: { empty: boolean }) {
  const layout = useStitchEditorStore((s) => s.draft?.sequenceLayout);
  const timeline = useStitchEditorStore((s) => s.draft?.timeline);
  const loopCount = useStitchEditorStore((s) => s.draft?.loopCount ?? 1);
  const durations = useStitchEditorStore((s) => s.durations);
  const endGesture = useStitchEditorStore((s) => s.endGesture);

  const summary = useMemo(() => {
    if (!layout || !timeline) return "";
    const items = timeline.map((clip) => {
      const key = sourceKey(clip.source);
      return { length: clipLength(clip, durations.get(key)), source: key };
    });
    return stackSummary(items, layout, loopCount);
  }, [layout, timeline, durations, loopCount]);

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
        className="columns-1 overflow-hidden pt-2 text-[11px] leading-[14px] text-neutral-500 [orphans:1] [widows:1]"
        title={summary}
      >
        {summary}
      </p>
      <div className="h-9 shrink-0 flex items-center justify-between">
        {/* Leaving the well ends a run of ↑/↓ nudges: the next one is a new undo step */}
        <div className="flex items-center gap-2" onBlur={endGesture}>
          <span className="text-xs text-neutral-400">Overlap</span>
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
        <div className="flex items-center gap-2">
          <span className="text-xs text-neutral-400">Crossfade</span>
          <Switch label="Crossfade" checked={layout.crossfade} onChange={setCrossfade} />
        </div>
      </div>
    </div>
  );
}
