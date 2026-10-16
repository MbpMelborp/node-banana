import type { StitchClipSource, StitchTimelineClip } from "@/types";

/**
 * The Stitch timeline's clip maths: lengths, spans, trims, splits and moves.
 *
 * Pure: no React, no DOM, no mediabunny. Times are seconds. A clip's In and
 * Out are in its source's time; a span's start and end are in sequence time
 * (one loop). Clips are butted together, so a span starts where the one
 * before it ends.
 */

/** The shortest a trimmed clip can be. */
export const MIN_CLIP_SEC = 0.1;
/** An Out this close to the source's end is stored as null ("to the end"). */
export const END_EPSILON_SEC = 0.005;

export type SourceKey = `edge:${string}` | `asset:${string}`;

export function sourceKey(source: StitchClipSource): SourceKey {
  return source.kind === "edge" ? `edge:${source.edgeId}` : `asset:${source.assetId}`;
}

/** Known durations in seconds. A missing key means not generated, loading or unreadable: such a clip counts 0 s. */
export type SourceDurations = ReadonlyMap<SourceKey, number>;

export function newClipId(): string {
  return `clip_${crypto.randomUUID().slice(0, 8)}`;
}

export function createClip(
  source: StitchClipSource,
  init: { id?: string; inSec?: number; outSec?: number | null; muted?: boolean; volume?: number } = {},
): StitchTimelineClip {
  return {
    id: init.id ?? newClipId(),
    source,
    inSec: init.inSec ?? 0,
    outSec: init.outSec ?? null,
    muted: init.muted ?? false,
    volume: init.volume ?? 1,
  };
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/** The trimmed length. An unknown source duration counts 0. */
export function clipLength(clip: StitchTimelineClip, sourceDuration: number | undefined): number {
  if (sourceDuration === undefined || !Number.isFinite(sourceDuration)) return 0;
  const end = Math.min(clip.outSec ?? sourceDuration, sourceDuration);
  return Math.max(0, end - Math.min(clip.inSec, sourceDuration));
}

export interface ClipSpan {
  clip: StitchTimelineClip;
  index: number;
  start: number;
  end: number;
  length: number;
}

/** One loop. start/end are in sequence seconds; zero-length spans are kept (start === end). */
export function clipSpans(timeline: readonly StitchTimelineClip[], durations: SourceDurations): ClipSpan[] {
  let start = 0;
  return timeline.map((clip, index) => {
    const length = clipLength(clip, durations.get(sourceKey(clip.source)));
    const span = { clip, index, start, end: start + length, length };
    start += length;
    return span;
  });
}

export function sequenceDuration(timeline: readonly StitchTimelineClip[], durations: SourceDurations): number {
  return timeline.reduce((sum, clip) => sum + clipLength(clip, durations.get(sourceKey(clip.source))), 0);
}

function spanAt(spans: readonly ClipSpan[], t: number): ClipSpan | null {
  const filled = spans.filter((s) => s.length > 0);
  if (filled.length === 0) return null;
  if (t < 0) return filled[0];
  return filled.find((s) => s.start <= t && t < s.end) ?? filled[filled.length - 1];
}

/** The non-empty span with start <= t < end. If t >= total, the last non-empty span. If t < 0, the first. No non-empty span → null. */
export function clipAtTime(
  timeline: readonly StitchTimelineClip[],
  durations: SourceDurations,
  t: number,
): ClipSpan | null {
  return spanAt(clipSpans(timeline, durations), t);
}

/** Source seconds shown at sequence time t: clip.inSec + clamp(t − start, 0, length). */
export function sourceTimeAt(span: ClipSpan, t: number): number {
  return span.clip.inSec + clamp(t - span.start, 0, span.length);
}

const finiteOr = (value: number | undefined, fallback: number) =>
  value !== undefined && Number.isFinite(value) ? value : fallback;

/**
 * Trim rules. With D known: 0 <= in <= effOut − MIN, in + MIN <= out <= D, and out >= D − EPS becomes null.
 * With D unknown: in >= 0, a numeric out >= in + MIN. If D < MIN: { inSec: 0, outSec: null }.
 * patch.outSec === null means "to the end". The edge the patch moves gives way; the other one holds.
 */
export function clampTrim(
  clip: StitchTimelineClip,
  sourceDuration: number | undefined,
  patch: { inSec?: number; outSec?: number | null },
): { inSec: number; outSec: number | null } {
  const movesOut = patch.outSec !== undefined && (patch.outSec === null || Number.isFinite(patch.outSec));
  const nextIn = Math.max(0, finiteOr(patch.inSec, clip.inSec));

  if (sourceDuration === undefined || !Number.isFinite(sourceDuration)) {
    const out = movesOut ? (patch.outSec ?? null) : clip.outSec;
    if (out === null) return { inSec: nextIn, outSec: null };
    if (movesOut) return { inSec: nextIn, outSec: Math.max(out, nextIn + MIN_CLIP_SEC) };
    // Only In moved: it stops short of the Out, unless the Out itself is under the minimum.
    if (out - MIN_CLIP_SEC < 0) return { inSec: 0, outSec: MIN_CLIP_SEC };
    return { inSec: Math.min(nextIn, out - MIN_CLIP_SEC), outSec: out };
  }

  const d = sourceDuration;
  if (d < MIN_CLIP_SEC) return { inSec: 0, outSec: null };

  let inSec: number;
  let outSec: number;
  if (movesOut) {
    inSec = clamp(nextIn, 0, d - MIN_CLIP_SEC);
    outSec = clamp(patch.outSec ?? d, inSec + MIN_CLIP_SEC, d);
  } else {
    const baseIn = clamp(clip.inSec, 0, d - MIN_CLIP_SEC);
    outSec = clamp(clip.outSec ?? d, baseIn + MIN_CLIP_SEC, d);
    inSec = clamp(nextIn, 0, outSec - MIN_CLIP_SEC);
  }
  return { inSec, outSec: outSec >= d - END_EPSILON_SEC ? null : outSec };
}

// Timeline operations. Each returns the SAME array reference when nothing
// changes: the editor's store relies on it to tell a no-op from an edit.

export function trimClip(
  timeline: StitchTimelineClip[],
  clipId: string,
  durations: SourceDurations,
  patch: { inSec?: number; outSec?: number | null },
): StitchTimelineClip[] {
  const index = timeline.findIndex((c) => c.id === clipId);
  if (index === -1) return timeline;
  const clip = timeline[index];
  const next = clampTrim(clip, durations.get(sourceKey(clip.source)), patch);
  if (next.inSec === clip.inSec && next.outSec === clip.outSec) return timeline;
  return timeline.map((c, i) => (i === index ? { ...c, ...next } : c));
}

export function resetTrim(timeline: StitchTimelineClip[], clipId: string): StitchTimelineClip[] {
  const index = timeline.findIndex((c) => c.id === clipId);
  if (index === -1) return timeline;
  const clip = timeline[index];
  if (clip.inSec === 0 && clip.outSec === null) return timeline;
  return timeline.map((c, i) => (i === index ? { ...c, inSec: 0, outSec: null } : c));
}

/** The clip's own sound; volume is clamped to 0..1. */
export function updateClipAudio(
  timeline: StitchTimelineClip[],
  clipId: string,
  patch: { muted?: boolean; volume?: number },
): StitchTimelineClip[] {
  const index = timeline.findIndex((c) => c.id === clipId);
  if (index === -1) return timeline;
  const clip = timeline[index];
  const muted = patch.muted ?? clip.muted;
  const volume = clamp(finiteOr(patch.volume, clip.volume), 0, 1);
  if (muted === clip.muted && volume === clip.volume) return timeline;
  return timeline.map((c, i) => (i === index ? { ...c, muted, volume } : c));
}

/** Final-index semantics: the moved clip ends up at toIndex (truncated). A non-integer fromIndex or non-finite toIndex moves nothing. */
export function moveClip(timeline: StitchTimelineClip[], fromIndex: number, toIndex: number): StitchTimelineClip[] {
  if (!Number.isInteger(fromIndex) || fromIndex < 0 || fromIndex >= timeline.length) return timeline;
  if (!Number.isFinite(toIndex)) return timeline;
  const to = clamp(Math.trunc(toIndex), 0, timeline.length - 1);
  if (to === fromIndex) return timeline;
  const next = timeline.slice();
  const [moved] = next.splice(fromIndex, 1);
  next.splice(to, 0, moved);
  return next;
}

/** orphanedEdgeId: the removed clip's edge when no other clip still references it, else null. */
export function removeClip(
  timeline: StitchTimelineClip[],
  clipId: string,
): { timeline: StitchTimelineClip[]; orphanedEdgeId: string | null } {
  const clip = timeline.find((c) => c.id === clipId);
  if (!clip) return { timeline, orphanedEdgeId: null };
  const next = timeline.filter((c) => c !== clip);
  const { source } = clip;
  const orphanedEdgeId =
    source.kind === "edge" && !next.some((c) => c.source.kind === "edge" && c.source.edgeId === source.edgeId)
      ? source.edgeId
      : null;
  return { timeline: next, orphanedEdgeId };
}

export function appendClips(timeline: StitchTimelineClip[], clips: StitchTimelineClip[]): StitchTimelineClip[] {
  return clips.length === 0 ? timeline : [...timeline, ...clips];
}

/**
 * Split the non-empty span containing t, if t is at least MIN_CLIP_SEC inside both edges. Otherwise null.
 * The left piece keeps its id and in, and its out = sourceTimeAt(t). The right piece gets a new id, in = sourceTimeAt(t) and the original out.
 * muted and volume are copied to both. A non-finite t splits nothing.
 */
export function splitClipAt(
  timeline: StitchTimelineClip[],
  durations: SourceDurations,
  t: number,
  makeId: () => string = newClipId,
): { timeline: StitchTimelineClip[]; leftId: string; rightId: string } | null {
  if (!Number.isFinite(t)) return null;
  const span = clipAtTime(timeline, durations, t);
  if (!span || t - span.start < MIN_CLIP_SEC || span.end - t < MIN_CLIP_SEC) return null;
  const cut = sourceTimeAt(span, t);
  const left: StitchTimelineClip = { ...span.clip, outSec: cut };
  const right: StitchTimelineClip = { ...span.clip, id: makeId(), inSec: cut, outSec: span.clip.outSec };
  const next = timeline.slice();
  next.splice(span.index, 1, left, right);
  return { timeline: next, leftId: left.id, rightId: right.id };
}

/**
 * I / O keys: set the clip's in or out to the source time under the playhead. null if the playhead is not inside
 * that clip (or not finite). The far boundary is outside: O at the clip's start, or I at its end, does nothing.
 */
export function setEdgeAtPlayhead(
  timeline: StitchTimelineClip[],
  durations: SourceDurations,
  clipId: string,
  edge: "in" | "out",
  playhead: number,
): StitchTimelineClip[] | null {
  if (!Number.isFinite(playhead)) return null;
  const span = clipSpans(timeline, durations).find((s) => s.clip.id === clipId);
  if (!span || span.length === 0 || playhead < span.start || playhead > span.end) return null;
  if (edge === "out" ? playhead <= span.start : playhead >= span.end) return null;
  const at = sourceTimeAt(span, playhead);
  return trimClip(timeline, clipId, durations, edge === "in" ? { inSec: at } : { outSec: at });
}

/** Unique edge ids, by first appearance; this is what clipOrder holds. */
export function edgeIdsInOrder(timeline: readonly StitchTimelineClip[]): string[] {
  const ids: string[] = [];
  for (const clip of timeline) {
    if (clip.source.kind === "edge" && !ids.includes(clip.source.edgeId)) ids.push(clip.source.edgeId);
  }
  return ids;
}

/** label: "the playhead" | "Clip 3" */
export interface SnapTarget {
  t: number;
  kind: "playhead" | "edge";
  label: string;
}

/** The nearest target within threshold (inclusive). On a tie the playhead wins. */
export function snapTo(
  value: number,
  targets: readonly SnapTarget[],
  threshold: number,
): { value: number; target: SnapTarget | null } {
  let best: SnapTarget | null = null;
  let bestDistance = Infinity;
  for (const target of targets) {
    const distance = Math.abs(target.t - value);
    if (distance > threshold) continue;
    if (distance < bestDistance || (distance === bestDistance && target.kind === "playhead")) {
      best = target;
      bestDistance = distance;
    }
  }
  return best ? { value: best.t, target: best } : { value, target: null };
}

/**
 * The one neighbouring clip edge a ripple trim can meet: the adjacent non-empty clip's touching edge at drag start
 * (Out: the next clip's start; In: the previous clip's end), labelled with that clip ("Clip 3"). null at the sequence ends.
 * In a gapless ripple timeline that position is the dragged edge's own start position, so snapping to it restores the
 * original length; the neighbour is drawn exactly there whenever the snap holds (delta 0). Every other boundary is either
 * out of reach of this edge or moves with the drag (the clips after a lengthening edge are pushed live), so none is a target.
 */
export function neighbourTarget(spans: readonly ClipSpan[], clipId: string, edge: "in" | "out"): SnapTarget | null {
  const at = spans.findIndex((s) => s.clip.id === clipId);
  if (at === -1) return null;
  if (edge === "out") {
    const next = spans.slice(at + 1).find((s) => s.length > 0);
    return next ? { t: next.start, kind: "edge", label: `Clip ${next.index + 1}` } : null;
  }
  const previous = spans.slice(0, at).reverse().find((s) => s.length > 0);
  return previous ? { t: previous.end, kind: "edge", label: `Clip ${previous.index + 1}` } : null;
}
