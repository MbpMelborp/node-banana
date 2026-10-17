import type { StitchSequenceLayout, StitchTimelineClip, VideoStitchNodeData, VolumePoint } from "@/types";
import { sameCurve, sortCurve } from "./curve";
import { isLegacyStitch, migrateStitchTimeline, reconcileTimelineWithEdges, sanitizeTimeline } from "./migrate";
import { clampOverlapSec, DEFAULT_SEQUENCE_LAYOUT } from "./stack";
import {
  edgeIdsInOrder,
  isPlaced,
  layoutSpans,
  sourceKey,
  spansEnd,
  type ClipSpan,
  type SourceDurations,
} from "./timeline";

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
  sequenceLayout: StitchSequenceLayout;
}

export interface StitchReadContext {
  liveEdgeIds: readonly string[];
  hasMusic: boolean;
}

function readLoopCount(value: unknown): 1 | 2 | 3 {
  return value === 2 || value === 3 ? value : 1;
}

/**
 * Not an object → DEFAULT_SEQUENCE_LAYOUT. mode "stacked" only when raw.mode === "stacked" and the node is not legacy
 * (a legacy node always reads as Track, keeping the values); overlapSec via clampOverlapSec when finite, else the
 * default; crossfade = raw.crossfade !== false.
 */
export function readSequenceLayout(raw: unknown, legacy: boolean): StitchSequenceLayout {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_SEQUENCE_LAYOUT };
  const { mode, overlapSec, crossfade } = raw as Record<string, unknown>;
  return {
    mode: mode === "stacked" && !legacy ? "stacked" : "track",
    overlapSec:
      typeof overlapSec === "number" && Number.isFinite(overlapSec)
        ? clampOverlapSec(overlapSec)
        : DEFAULT_SEQUENCE_LAYOUT.overlapSec,
    crossfade: crossfade !== false,
  };
}

export function sameLayout(a: StitchSequenceLayout, b: StitchSequenceLayout): boolean {
  return a.mode === b.mode && a.overlapSec === b.overlapSec && a.crossfade === b.crossfade;
}

/** The draft's spans as its layout lays them out (layoutSpans: Track, lined up or placed). */
export function draftSpans(
  d: Pick<StitchDraft, "timeline" | "sequenceLayout">,
  durations: SourceDurations,
): ClipSpan[] {
  return layoutSpans(d.timeline, durations, d.sequenceLayout);
}

/** One loop of the draft: the latest end of a non-empty clip (spansEnd). */
export function draftDuration(d: Pick<StitchDraft, "timeline" | "sequenceLayout">, durations: SourceDurations): number {
  return spansEnd(draftSpans(d, durations));
}

/**
 * legacy: migrateStitchTimeline (it already includes the live edges).
 * otherwise: reconcileTimelineWithEdges(sanitizeTimeline(data.timeline), live, { muteNew }), where
 *   muteNew = ctx.hasMusic && at least one edge clip survives reconciliation && every such clip is muted
 *   (a video connected later to a node whose clips are all muted under music follows them, so the mix stays uniform).
 */
export function readStitchDraft(
  data: Pick<VideoStitchNodeData, "timeline" | "clipOrder" | "audioCurve" | "audioMuted" | "loopCount" | "sequenceLayout">,
  ctx: StitchReadContext,
): StitchDraft {
  let timeline: StitchTimelineClip[];
  const legacy = isLegacyStitch(data);
  if (legacy) {
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
    sequenceLayout: readSequenceLayout(data.sequenceLayout, legacy),
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
    a.volume === b.volume &&
    a.startSec === b.startSec
  );
}

export function sameDraft(a: StitchDraft, b: StitchDraft): boolean {
  return (
    a.loopCount === b.loopCount &&
    a.audioMuted === b.audioMuted &&
    sameLayout(a.sequenceLayout, b.sequenceLayout) &&
    a.timeline.length === b.timeline.length &&
    a.timeline.every((clip, i) => sameClip(clip, b.timeline[i])) &&
    sameCurve(a.audioCurve, b.audioCurve)
  );
}

/**
 * What Done writes: timeline, audioCurve, audioMuted, loopCount, sequenceLayout, clipOrder = edgeIdsInOrder(timeline).
 * commitStitchEdit leaves sequenceLayout out when the node's stored value already reads as it.
 */
export function draftPatch(
  d: StitchDraft,
): Required<Pick<VideoStitchNodeData, "timeline" | "audioCurve" | "audioMuted" | "sequenceLayout">> &
  Pick<VideoStitchNodeData, "loopCount" | "clipOrder"> {
  return {
    timeline: d.timeline,
    audioCurve: d.audioCurve,
    audioMuted: d.audioMuted,
    loopCount: d.loopCount,
    sequenceLayout: { ...d.sequenceLayout },
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

/** Clips with a start in the draft whose frames' anchor (start − In) differs from the one they had in `initial`. */
function movedClips(initial: StitchDraft, draft: StitchDraft, durations: SourceDurations): number {
  const spans = layoutSpans(initial.timeline, durations, { ...initial.sequenceLayout, mode: "stacked" });
  const anchorBefore = new Map(spans.map((span) => [span.clip.id, span.start - span.clip.inSec]));
  return draft.timeline.filter((clip) => {
    const was = anchorBefore.get(clip.id);
    return clip.startSec !== undefined && was !== undefined && Math.abs(clip.startSec - clip.inSec - was) > 1e-9;
  }).length;
}

/** The layout's parts of the discard sheet's sentence, saying which way each changed. */
function layoutChanges(was: StitchSequenceLayout, now: StitchSequenceLayout): string[] {
  const parts: string[] = [];
  if (was.mode !== now.mode) parts.push(now.mode === "stacked" ? "the switch to Stacked" : "the switch to Track");
  if (was.overlapSec !== now.overlapSec) parts.push("the overlap");
  if (was.crossfade !== now.crossfade) parts.push(now.crossfade ? "turning the crossfade on" : "turning the crossfade off");
  return parts;
}

/**
 * The discard sheet's sentence: what Cancel would lose, by kind, matching
 * clips by id. "Two trims, a new order and the volume curve will be lost.
 * The node keeps what it had." A new clip of a source that was already in
 * the sequence is a split; one of a new source was added. The Out a split
 * gives its left piece is part of the split, not a trim.
 *
 * A clip placed in the draft whose frames moved (its start less its In, the
 * stored start in `initial` or else where the stacked layout put it, with
 * these durations) is a moved clip: pinning alone, and an In trim that keeps
 * the frames where they were, are not. Dropping every placement is "lining up
 * the clips" instead.
 */
export function describeDraftChanges(
  initial: StitchDraft,
  draft: StitchDraft,
  durations: SourceDurations = new Map(),
): string {
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
  const linedUp = isPlaced(initial.timeline) && !isPlaced(draft.timeline);
  const moved = linedUp ? 0 : movedClips(initial, draft, durations);

  const parts = [
    counted(trims, "a trim", "trims"),
    reordered ? "a new order" : null,
    linedUp ? "lining up the clips" : counted(moved, "a moved clip", "moved clips"),
    counted(splits, "a split", "splits"),
    counted(muted, "a muted clip", "muted clips"),
    counted(unmuted, "an unmuted clip", "unmuted clips"),
    counted(volumes, "a clip volume", "clip volumes"),
    counted(added.length - splits, "an added clip", "added clips"),
    counted(removed, "a removed clip", "removed clips"),
    sameCurve(initial.audioCurve, draft.audioCurve) ? null : "the volume curve",
    initial.audioMuted === draft.audioMuted ? null : "the music mute",
    initial.loopCount === draft.loopCount ? null : "the loop count",
    ...layoutChanges(initial.sequenceLayout, draft.sequenceLayout),
  ].filter((part): part is string => part !== null);

  if (parts.length === 0) return "Your changes will be lost. The node keeps what it had.";
  const list = joinWithAnd(parts);
  return `${list[0].toUpperCase()}${list.slice(1)} will be lost. The node keeps what it had.`;
}
