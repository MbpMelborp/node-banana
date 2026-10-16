import type { StitchTimelineClip, VideoStitchNodeData, VolumePoint } from "@/types";
import { sameCurve, sortCurve } from "./curve";
import { isLegacyStitch, migrateStitchTimeline, reconcileTimelineWithEdges, sanitizeTimeline } from "./migrate";
import { edgeIdsInOrder } from "./timeline";

/**
 * Everything the Stitch editor edits, read from a node the same way by the
 * card, the editor and the executor: migrated if legacy, then reconciled
 * against the live edges.
 */
export interface StitchDraft {
  timeline: StitchTimelineClip[];
  audioCurve: VolumePoint[];
  audioMuted: boolean;
  loopCount: 1 | 2 | 3;
}

export interface StitchReadContext {
  liveEdgeIds: readonly string[];
  hasMusic: boolean;
}

function readLoopCount(value: unknown): 1 | 2 | 3 {
  return value === 2 || value === 3 ? value : 1;
}

/**
 * legacy: migrateStitchTimeline (it already includes the live edges).
 * otherwise: reconcileTimelineWithEdges(sanitizeTimeline(data.timeline), live, { muteNew }), where
 *   muteNew = ctx.hasMusic && at least one edge clip survives reconciliation && every such clip is muted
 *   (a video connected later to a node whose clips are all muted under music follows them, so the mix stays uniform).
 */
export function readStitchDraft(
  data: Pick<VideoStitchNodeData, "timeline" | "clipOrder" | "audioCurve" | "audioMuted" | "loopCount">,
  ctx: StitchReadContext,
): StitchDraft {
  let timeline: StitchTimelineClip[];
  if (isLegacyStitch(data)) {
    timeline = migrateStitchTimeline(data, ctx);
  } else {
    const stored = sanitizeTimeline(data.timeline);
    const live = new Set(ctx.liveEdgeIds);
    const edgeClips = stored.filter((c) => c.source.kind === "edge" && live.has(c.source.edgeId));
    const muteNew = ctx.hasMusic && edgeClips.length > 0 && edgeClips.every((c) => c.muted);
    timeline = reconcileTimelineWithEdges(stored, ctx.liveEdgeIds, { muteNew }).timeline;
  }
  return {
    timeline,
    audioCurve: sortCurve(data.audioCurve),
    audioMuted: data.audioMuted === true,
    loopCount: readLoopCount(data.loopCount),
  };
}

function sameClip(a: StitchTimelineClip, b: StitchTimelineClip): boolean {
  const sameSource =
    a.source.kind === "edge"
      ? b.source.kind === "edge" && a.source.edgeId === b.source.edgeId
      : b.source.kind === "asset" && a.source.assetId === b.source.assetId;
  return (
    sameSource &&
    a.id === b.id &&
    a.inSec === b.inSec &&
    a.outSec === b.outSec &&
    a.muted === b.muted &&
    a.volume === b.volume
  );
}

export function sameDraft(a: StitchDraft, b: StitchDraft): boolean {
  return (
    a.loopCount === b.loopCount &&
    a.audioMuted === b.audioMuted &&
    a.timeline.length === b.timeline.length &&
    a.timeline.every((clip, i) => sameClip(clip, b.timeline[i])) &&
    sameCurve(a.audioCurve, b.audioCurve)
  );
}

/** Exactly what Done writes: timeline, audioCurve, audioMuted, loopCount, clipOrder = edgeIdsInOrder(timeline). */
export function draftPatch(
  d: StitchDraft,
): Required<Pick<VideoStitchNodeData, "timeline" | "audioCurve" | "audioMuted">> &
  Pick<VideoStitchNodeData, "loopCount" | "clipOrder"> {
  return {
    timeline: d.timeline,
    audioCurve: d.audioCurve,
    audioMuted: d.audioMuted,
    loopCount: d.loopCount,
    clipOrder: edgeIdsInOrder(d.timeline),
  };
}
