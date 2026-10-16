import type { StitchTimelineClip, VideoStitchNodeData, VolumePoint } from "@/types";
import { sameCurve, sortCurve } from "./curve";
import { isLegacyStitch, migrateStitchTimeline, reconcileTimelineWithEdges, sanitizeTimeline } from "./migrate";
import { edgeIdsInOrder, sourceKey } from "./timeline";

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

const COUNT_WORDS = ["", "", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

/** "a trim" / "two trims" / "12 trims": `one` is the singular with its article. */
function counted(n: number, one: string, many: string): string | null {
  if (n <= 0) return null;
  if (n === 1) return one;
  return `${n < COUNT_WORDS.length ? COUNT_WORDS[n] : n} ${many}`;
}

function joinWithAnd(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Whether a clip's only trim change is the cut its split pieces start at: In
 * unchanged, and pieces of the same source chained from its new Out to its
 * old one (a split keeps the id on the left piece and moves its Out).
 */
function onlySplit(was: StitchTimelineClip, clip: StitchTimelineClip, pieces: readonly StitchTimelineClip[]): boolean {
  if (was.inSec !== clip.inSec || clip.outSec === was.outSec || clip.outSec === null) return false;
  const key = sourceKey(clip.source);
  const left = pieces.filter((p) => sourceKey(p.source) === key);
  let cursor: number | null = clip.outSec;
  while (cursor !== was.outSec) {
    const at = cursor;
    const index = left.findIndex((p) => p.inSec === at);
    if (index === -1) return false;
    cursor = left[index].outSec;
    left.splice(index, 1);
    if (cursor === null && was.outSec !== null) return false;
  }
  return true;
}

/**
 * The discard sheet's sentence: what Cancel would lose, by kind, matching
 * clips by id. "Two trims, a new order and the volume curve will be lost.
 * The node keeps what it had." A new clip of a source that was already in
 * the sequence is a split; one of a new source was added. The Out a split
 * gives its left piece is part of the split, not a trim.
 */
export function describeDraftChanges(initial: StitchDraft, draft: StitchDraft): string {
  const before = new Map(initial.timeline.map((c) => [c.id, c]));
  const after = new Map(draft.timeline.map((c) => [c.id, c]));
  const sourcesBefore = new Set(initial.timeline.map((c) => sourceKey(c.source)));
  const added = draft.timeline.filter((c) => !before.has(c.id));
  const pieces = added.filter((c) => sourcesBefore.has(sourceKey(c.source)));

  let trims = 0;
  let muted = 0;
  let unmuted = 0;
  let volumes = 0;
  for (const clip of draft.timeline) {
    const was = before.get(clip.id);
    if (!was) continue;
    if ((was.inSec !== clip.inSec || was.outSec !== clip.outSec) && !onlySplit(was, clip, pieces)) trims++;
    if (!was.muted && clip.muted) muted++;
    if (was.muted && !clip.muted) unmuted++;
    if (was.volume !== clip.volume) volumes++;
  }
  const splits = pieces.length;
  const removed = initial.timeline.filter((c) => !after.has(c.id)).length;
  const commonBefore = initial.timeline.filter((c) => after.has(c.id)).map((c) => c.id);
  const commonAfter = draft.timeline.filter((c) => before.has(c.id)).map((c) => c.id);
  const reordered = commonBefore.some((id, i) => id !== commonAfter[i]);

  const parts = [
    counted(trims, "a trim", "trims"),
    reordered ? "a new order" : null,
    counted(splits, "a split", "splits"),
    counted(muted, "a muted clip", "muted clips"),
    counted(unmuted, "an unmuted clip", "unmuted clips"),
    counted(volumes, "a clip volume", "clip volumes"),
    counted(added.length - splits, "an added clip", "added clips"),
    counted(removed, "a removed clip", "removed clips"),
    sameCurve(initial.audioCurve, draft.audioCurve) ? null : "the volume curve",
    initial.audioMuted === draft.audioMuted ? null : "the music mute",
    initial.loopCount === draft.loopCount ? null : "the loop count",
  ].filter((part): part is string => part !== null);

  if (parts.length === 0) return "Your changes will be lost. The node keeps what it had.";
  const list = joinWithAnd(parts);
  return `${list[0].toUpperCase()}${list.slice(1)} will be lost. The node keeps what it had.`;
}
