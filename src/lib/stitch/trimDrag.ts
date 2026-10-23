import { clipName } from "./labels";
import {
  clampTrim,
  clipLength,
  neighbourTarget,
  originalEdgeTarget,
  snapTo,
  type ClipSpan,
  type SnapTarget,
} from "./timeline";
import { activeWarp, trimField } from "./warp";

/**
 * One trim drag on a clip's edge, as a pure function of the pointer: the
 * trim it gives, where the edge sits, the length change and the part the
 * edge has crossed. The lane draws this while the pointer moves and applies
 * it once, on release.
 *
 * Ripple trims: a clip's start in the sequence never moves during the drag.
 * The tail edge follows the pointer at start + new length. The head edge
 * follows it at start + the head's change over the speed (new In − old In,
 * or a reversed clip's old Out − new Out), and the clip closes up to its
 * start on release. In Stacked the start moves with the head edge (the
 * frames stay where they are) and nothing else moves.
 *
 * A retimed clip's edge moves its source field by the travel times the speed
 * (the head of a reversed clip is its Out); a ramp re-stretches over the new
 * range.
 */

export interface TrimDragStart {
  span: ClipSpan;
  edge: "in" | "out";
  sourceDuration: number | undefined;
  pointerX: number;
  pxPerSec: number;
  /**
   * The press axis's xToTime. An In edge measures the pointer's travel on it: the clips and slots before the clip
   * stay put, so a lengthening In that crosses an empty slot counts its pixels as no time and meets the playhead
   * where it is drawn. Without it, or for an Out edge (whose later slots are pushed along), travel is pixels / pps.
   */
  xToTime?: (x: number) => number;
  /** trimTargets(…): nothing that moves with the drag. */
  targets: readonly SnapTarget[];
  /**
   * The earliest the clip may start, sequence seconds: an edge that lengthens the head stops there. Stacked passes 0,
   * so the clip never starts before 0:00; Track passes nothing (a ripple trim never moves the start).
   */
  minStartSec?: number;
}

export interface TrimDragResult {
  /** clampTrim applied. */
  inSec: number;
  outSec: number | null;
  /** Where the dragged edge sits in sequence time (out: start + new length; in: start + the head's change at speed). */
  edgeSeqTime: number;
  /** The trimmed field's value in its source: the In or Out the rail would show. */
  edgeSourceTime: number;
  /** New length − old length (the "−0.80 s" chip). */
  deltaSec: number;
  /** New length. */
  lengthSec: number;
  snapped: SnapTarget | null;
  /** The span the edge has crossed when shortening, in sequence time; null when lengthening. */
  ghost: { fromSec: number; toSec: number } | null;
  /** The source field the dragged side trims (warp.ts trimField): the head's In, the tail's Out; reversed, swapped. */
  field: "inSec" | "outSec";
}

/** How near (px) an edge must come to a target to snap. The boards do not draw it; design-spec §7.5 suggests 8. */
export const SNAP_THRESHOLD_PX = 8;
/** A snapped edge that the trim limits pulled further than this is not snapped. */
const SNAP_HELD = 1e-6;

/**
 * What a dragged edge can snap to. Track: the playhead, and the one neighbouring edge a ripple trim can meet
 * (neighbourTarget); nothing that moves with the drag, since the clips after a lengthening edge are pushed live.
 * Stacked, where nothing else moves: the playhead; for an In edge 0:00 ("the start"); every other non-empty clip's
 * start and end ("Clip 3's start", "Clip 3's end"); and the edge's own start position (originalEdgeTarget, "the
 * original length").
 */
export function trimTargets(
  spans: readonly ClipSpan[],
  clipId: string,
  edge: "in" | "out",
  playhead: number,
  mode: "track" | "stacked" = "track",
): SnapTarget[] {
  const targets: SnapTarget[] = [{ t: playhead, kind: "playhead", label: "the playhead" }];
  if (mode === "stacked") {
    if (edge === "in") targets.push({ t: 0, kind: "edge", label: "the start" });
    for (const other of spans) {
      if (other.clip.id === clipId || !(other.length > 0)) continue;
      targets.push(
        { t: other.start, kind: "edge", label: `${clipName(other.index)}'s start` },
        { t: other.end, kind: "edge", label: `${clipName(other.index)}'s end` },
      );
    }
    const span = spans.find((s) => s.clip.id === clipId);
    if (span) targets.push(originalEdgeTarget(span, edge));
    return targets;
  }
  const neighbour = neighbourTarget(spans, clipId, edge);
  if (neighbour) targets.push(neighbour);
  return targets;
}

/** Snapping runs on the edge's sequence time when opts.snap is set, with threshold thresholdPx / pps (default 8 px). */
export function trimDragAt(
  start: TrimDragStart,
  pointerX: number,
  opts: { snap: boolean; thresholdPx?: number },
): TrimDragResult {
  const { span, edge, sourceDuration: d } = start;
  const clip = span.clip;
  const pps = start.pxPerSec > 0 ? start.pxPerSec : 1;
  const measurable = Number.isFinite(pointerX) && Number.isFinite(start.pointerX);
  const dx = !measurable
    ? 0
    : edge === "in" && start.xToTime
      ? start.xToTime(pointerX) - start.xToTime(start.pointerX)
      : (pointerX - start.pointerX) / pps;
  const startEdge = edge === "out" ? span.end : span.start;
  const pointerTime = startEdge + dx;
  // Each edge moves from its own stored value by the edge's travel, so no travel gives the clip's own In and Out
  // back exactly (rebuilding the Out from start + length would add float noise: (start + len) − start ≠ len)
  const known = d !== undefined && Number.isFinite(d);
  const warp = activeWarp(clip);
  const field = trimField(clip, edge);
  const effOut = known
    ? Math.min(clip.outSec ?? d, d)
    : (clip.outSec ?? clip.inSec + (warp ? span.length * warp.speed : span.length));
  // The head may reach back by the clip's start (less minStartSec) of output: that much source at the clip's speed
  const reach =
    start.minStartSec !== undefined && Number.isFinite(start.minStartSec) ? span.start - start.minStartSec : Infinity;
  const minIn = warp ? clip.inSec - reach * warp.speed : clip.inSec - reach;
  const maxOut = warp ? effOut + reach * warp.speed : Infinity;
  const trimAt = (edgeTime: number) => {
    if (!warp) {
      return edge === "out"
        ? clampTrim(clip, d, { outSec: effOut + (edgeTime - span.end) })
        : clampTrim(clip, d, { inSec: Math.max(clip.inSec + (edgeTime - span.start), minIn) });
    }
    // The output length changes by the edge's travel, so the source by the travel times the speed
    const travel = (edgeTime - startEdge) * warp.speed;
    const grows = edge === "out" ? travel : -travel;
    if (field === "inSec") {
      return clampTrim(clip, d, { inSec: edge === "in" ? Math.max(clip.inSec - grows, minIn) : clip.inSec - grows });
    }
    return clampTrim(clip, d, { outSec: edge === "in" ? Math.min(effOut + grows, maxOut) : effOut + grows });
  };
  const playedOut = (trim: { outSec: number | null }) =>
    known ? Math.min(trim.outSec ?? d, d) : (trim.outSec ?? effOut);
  const edgeOf = (trim: { inSec: number; outSec: number | null }) => {
    if (edge === "out") return span.start + clipLength({ ...clip, ...trim }, d);
    if (!warp) return span.start + (trim.inSec - clip.inSec);
    // The head moves by its own field's change over the speed: the start of a ripple trim, the start in Stacked
    return span.start + (field === "inSec" ? trim.inSec - clip.inSec : effOut - playedOut(trim)) / warp.speed;
  };

  let trim = trimAt(pointerTime);
  let target: SnapTarget | null = null;
  const snapped = opts.snap
    ? snapTo(pointerTime, start.targets, (opts.thresholdPx ?? SNAP_THRESHOLD_PX) / pps)
    : { value: pointerTime, target: null };
  if (snapped.target) {
    // The edge stays where the snap pulled it; when the trim limits pulled it off the target, it is not snapped
    trim = trimAt(snapped.value);
    if (Math.abs(edgeOf(trim) - snapped.target.t) <= SNAP_HELD) target = snapped.target;
  }

  const lengthSec = clipLength({ ...clip, ...trim }, d);
  const edgeSeqTime = edgeOf(trim);
  const edgeSourceTime = warp
    ? (field === "inSec" ? trim.inSec : playedOut(trim))
    : (edge === "out" ? trim.inSec + lengthSec : trim.inSec);
  const deltaSec = lengthSec - span.length;

  let ghost: TrimDragResult["ghost"] = null;
  if (deltaSec < 0) {
    ghost = edge === "out" ? { fromSec: edgeSeqTime, toSec: span.end } : { fromSec: span.start, toSec: edgeSeqTime };
  }
  return { ...trim, edgeSeqTime, edgeSourceTime, deltaSec, lengthSec, snapped: target, ghost, field };
}
