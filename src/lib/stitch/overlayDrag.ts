import type { StitchOverlay } from "@/types";
import type { AudioMoveTarget } from "./audioDrag";
import { clipName } from "./labels";
import { ROW_HYSTERESIS_PX } from "./moveDrag";
import { OVERLAY_ROW_PX } from "./overlayLayout";
import { MAX_OVERLAY_SEC, MIN_OVERLAY_SEC } from "./overlays";
import { MAX_START_SEC } from "./placement";
import type { TimeAxis } from "./timeAxis";
import { snapTo, type ClipSpan } from "./timeline";
import { SNAP_THRESHOLD_PX } from "./trimDrag";

/**
 * One drag of a text layer's box (its body, or an edge), as pure functions
 * of the pointer's travel, in sequence seconds. A move is the audio box's
 * (audioMoveAt, audioSnapText); a trim moves one edge of the layer and
 * leaves the other where it is; the rows run bottom-up (row 0 nearest the
 * video), so a new row is above the top one.
 */

/**
 * What a moved or trimmed layer snaps to: the playhead, 0:00 ("the start"), the sequence's end ("the end"), every
 * non-empty video clip's start and end ("Clip 3's end"), and the start and end of every layer that is not moving
 * ("“Title”'s start", by `names`).
 */
export function overlayMoveTargets(
  overlays: readonly StitchOverlay[],
  videoSpans: readonly ClipSpan[],
  ids: ReadonlySet<string>,
  playhead: number,
  total: number,
  names: (overlay: StitchOverlay) => string,
): AudioMoveTarget[] {
  const targets: AudioMoveTarget[] = [
    { t: playhead, kind: "playhead", label: "the playhead", edge: "both" },
    { t: 0, kind: "edge", label: "the start", edge: "start" },
  ];
  if (total > 0) targets.push({ t: total, kind: "edge", label: "the end", edge: "both" });
  for (const video of videoSpans) {
    if (!(video.length > 0)) continue;
    const name = clipName(video.index);
    targets.push(
      { t: video.start, kind: "edge", label: `${name}'s start`, edge: "both" },
      { t: video.end, kind: "edge", label: `${name}'s end`, edge: "both" },
    );
  }
  for (const o of overlays) {
    if (ids.has(o.id)) continue;
    const name = names(o);
    targets.push(
      { t: o.startSec, kind: "edge", label: `${name}'s start`, edge: "both" },
      { t: o.endSec, kind: "edge", label: `${name}'s end`, edge: "both" },
    );
  }
  return targets;
}

/**
 * Where trimOverlay lets an edge go, in sequence seconds. The start: from 0:00, the previous layer's end on its row
 * and MAX_OVERLAY_SEC before the end, to MIN_OVERLAY_SEC before the end. The end: from MIN_OVERLAY_SEC after the
 * start to the next layer's start on its row, or MAX_OVERLAY_SEC after the start.
 */
export function overlayTrimBounds(
  overlays: readonly StitchOverlay[],
  o: StitchOverlay,
  edge: "in" | "out",
): { min: number; max: number } {
  const onRow = overlays.filter((other) => other.row === o.row && other.id !== o.id);
  const previous = onRow.filter((other) => other.startSec <= o.startSec).pop();
  const next = onRow.find((other) => other.startSec > o.startSec);
  if (edge === "in") {
    return {
      min: Math.max(0, previous?.endSec ?? 0, o.endSec - MAX_OVERLAY_SEC),
      max: Math.min(o.endSec - MIN_OVERLAY_SEC, MAX_START_SEC),
    };
  }
  return { min: o.startSec + MIN_OVERLAY_SEC, max: Math.min(next?.startSec ?? Infinity, o.startSec + MAX_OVERLAY_SEC) };
}

export interface OverlayTrimResult {
  startSec?: number;
  endSec?: number;
  snapped: AudioMoveTarget | null;
}

/**
 * One edge of one box ("in" its start, "out" its end): read where it is drawn after dx, snapped (within 8 px, the
 * playhead winning a tie) and clamped to bounds (overlayTrimBounds). A snap the bounds pulled off its target is no
 * snap.
 */
export function overlayTrimAt(
  axis: Pick<TimeAxis, "timeToX" | "xToTime" | "pxPerSec">,
  o: Pick<StitchOverlay, "startSec" | "endSec">,
  edge: "in" | "out",
  dx: number,
  bounds: { min: number; max: number },
  targets: readonly AudioMoveTarget[],
  opts: { snap: boolean },
): OverlayTrimResult {
  const from = edge === "in" ? o.startSec : o.endSec;
  const raw = Number.isFinite(dx) ? axis.xToTime(axis.timeToX(from) + dx) : from;
  const pps = axis.pxPerSec > 0 ? axis.pxPerSec : 1;
  const snap = opts.snap ? snapTo(raw, targets, SNAP_THRESHOLD_PX / pps) : { value: raw, target: null };
  const value = Math.min(Math.max(snap.value, bounds.min), bounds.max);
  const snapped = snap.target !== null && Math.abs(value - snap.value) <= 1e-9 ? (snap.target as AudioMoveTarget) : null;
  return edge === "in" ? { startSec: value, snapped } : { endSec: value, snapped };
}

/**
 * The landing row, from the box centre's y in the rows block (from its top, the live scroll added), the rows running
 * bottom-up: rowCount means a new row above the top one. The current row is kept while the centre is within its band
 * and ROW_HYSTERESIS_PX more on either side; otherwise the row under the centre, a new row once it is above the top
 * row, row 0 once it is below the last. The row count is the press's: no row is added or dropped during a drag.
 */
export function overlayRowAt(centreY: number, current: number, rowCount: number, rowPx = OVERLAY_ROW_PX): number {
  const kept = Math.min(Math.max(current, 0), rowCount);
  if (!Number.isFinite(centreY)) return kept;
  const top = kept === rowCount ? -Infinity : (rowCount - 1 - kept) * rowPx;
  const bottom = kept === rowCount ? 0 : top + rowPx;
  if (centreY >= top - ROW_HYSTERESIS_PX && centreY <= bottom + ROW_HYSTERESIS_PX) return kept;
  if (centreY < 0) return rowCount;
  return Math.max(0, rowCount - 1 - Math.floor(centreY / rowPx));
}
