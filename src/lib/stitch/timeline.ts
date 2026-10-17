import type { StitchClipSource, StitchSequenceLayout, StitchTimelineClip } from "@/types";
import {
  buildEnvelope,
  domOpacities,
  envelopeAt,
  MAX_START_SEC,
  resolveStarts,
  SLOT_SEC,
  TIME_EPS,
  type StackEnvelope,
} from "./placement";
import { FRAME_RATE } from "./sequencePlan";
import { crossfadeGain, joinOverlaps } from "./stack";

export { MAX_START_SEC } from "./placement";

/**
 * The Stitch timeline's clip maths: lengths, spans, trims, splits and moves.
 *
 * Pure: no React, no DOM, no mediabunny. Times are seconds. A clip's In and
 * Out are in its source's time; a span's start and end are in sequence time
 * (one loop). In Track clips are butted together, so a span starts where
 * the one before it ends. A Stacked stack is lined up until some clip has a
 * startSec: then each clip starts where it was placed (placement.ts), and
 * until then each starts joinOverlaps' overlap before the end of the one
 * above.
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
  init: { id?: string; inSec?: number; outSec?: number | null; muted?: boolean; volume?: number; startSec?: number } = {},
): StitchTimelineClip {
  return {
    id: init.id ?? newClipId(),
    source,
    inSec: init.inSec ?? 0,
    outSec: init.outSec ?? null,
    muted: init.muted ?? false,
    volume: init.volume ?? 1,
    // Kept as given: sanitising is migrate's
    ...(init.startSec !== undefined ? { startSec: init.startSec } : {}),
  };
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/**
 * The trimmed length. An unknown source duration counts 0, and so does a length under one output frame: the encode
 * drops such a clip (planSequence), so the editor gives it no time either.
 */
export function clipLength(clip: StitchTimelineClip, sourceDuration: number | undefined): number {
  if (sourceDuration === undefined || !Number.isFinite(sourceDuration)) return 0;
  const end = Math.min(clip.outSec ?? sourceDuration, sourceDuration);
  const length = Math.max(0, end - Math.min(clip.inSec, sourceDuration));
  return length < 1 / FRAME_RATE ? 0 : length;
}

export interface ClipSpan {
  clip: StitchTimelineClip;
  index: number;
  start: number;
  end: number;
  length: number;
  /** Seconds this clip shares with the previous / next non-empty clip (0 in Track, at cuts and for empty clips). */
  overlapIn: number;
  overlapOut: number;
}

/**
 * One loop. start/end are in sequence seconds; zero-length spans are kept (start === end). overlapSec is the
 * effective overlap (effectiveOverlapSec): 0 butts the clips, and a non-finite value counts as 0. Each non-empty span
 * starts its joinOverlaps overlap before the previous non-empty span's end; an empty one sits at that end.
 */
export function clipSpans(
  timeline: readonly StitchTimelineClip[],
  durations: SourceDurations,
  overlapSec: number,
): ClipSpan[] {
  const lengths = timeline.map((clip) => clipLength(clip, durations.get(sourceKey(clip.source))));
  const overlaps = joinOverlaps(
    timeline.map((clip, i) => ({ length: lengths[i], source: sourceKey(clip.source) })),
    overlapSec,
  );
  let cursor = 0;
  const spans = timeline.map((clip, index): ClipSpan => {
    const length = lengths[index];
    if (!(length > 0)) return { clip, index, start: cursor, end: cursor, length, overlapIn: 0, overlapOut: 0 };
    const start = cursor - overlaps[index];
    cursor = start + length;
    return { clip, index, start, end: cursor, length, overlapIn: overlaps[index], overlapOut: 0 };
  });
  let next: ClipSpan | null = null;
  for (let i = spans.length - 1; i >= 0; i--) {
    if (!(spans[i].length > 0)) continue;
    if (next) spans[i].overlapOut = next.overlapIn;
    next = spans[i];
  }
  return spans;
}

/**
 * The latest end over the spans with length > 0; 0 when there are none. Equals the last span's end for Track and
 * lined-up stacks.
 */
export function spansEnd(spans: readonly ClipSpan[]): number {
  let end = 0;
  for (const span of spans) if (span.length > 0) end = Math.max(end, span.end);
  return end;
}

/** One loop: spansEnd of the spans (0 when empty). */
export function sequenceDuration(
  timeline: readonly StitchTimelineClip[],
  durations: SourceDurations,
  overlapSec: number,
): number {
  return spansEnd(clipSpans(timeline, durations, overlapSec));
}

/** Whether some clip carries startSec. A Stacked draft is placed when this holds. */
export function isPlaced(timeline: readonly StitchTimelineClip[]): boolean {
  return timeline.some((clip) => typeof clip.startSec === "number" && Number.isFinite(clip.startSec));
}

/**
 * Row order; start = resolveStarts(…, overlapSec)[i]; end = start + length; an empty clip sits at its start with end =
 * start; overlapIn = overlapOut = 0 (placed stacks are drawn from the envelope).
 */
export function placedSpans(
  timeline: readonly StitchTimelineClip[],
  durations: SourceDurations,
  overlapSec: number,
): ClipSpan[] {
  const lengths = timeline.map((clip) => clipLength(clip, durations.get(sourceKey(clip.source))));
  const starts = resolveStarts(
    timeline.map((clip, i) => ({ start: clip.startSec, length: lengths[i], source: sourceKey(clip.source) })),
    overlapSec,
  );
  return timeline.map((clip, index): ClipSpan => {
    const length = lengths[index] > 0 ? lengths[index] : 0;
    const start = starts[index];
    return { clip, index, start, end: start + length, length, overlapIn: 0, overlapOut: 0 };
  });
}

/** Track: clipSpans(…, 0) (startSec ignored). Stacked lined up: clipSpans(…, overlapSec). Stacked placed: placedSpans. */
export function layoutSpans(
  timeline: readonly StitchTimelineClip[],
  durations: SourceDurations,
  layout: StitchSequenceLayout,
): ClipSpan[] {
  if (layout.mode !== "stacked") return clipSpans(timeline, durations, 0);
  return isPlaced(timeline)
    ? placedSpans(timeline, durations, layout.overlapSec)
    : clipSpans(timeline, durations, layout.overlapSec);
}

const envelopes = new WeakMap<readonly ClipSpan[], { on?: StackEnvelope; off?: StackEnvelope }>();

/**
 * The envelope of these spans: units are the spans with length > 0, row = span.index, source = sourceKey(clip.source),
 * inSec = clip.inSec. Cached per spans array and flag. The lane, the gap bands, the summary, the card, the modal and
 * placedLayersAt all call this; none builds units itself.
 */
export function spansEnvelope(spans: readonly ClipSpan[], crossfade: boolean): StackEnvelope {
  let cached = envelopes.get(spans);
  if (!cached) {
    cached = {};
    envelopes.set(spans, cached);
  }
  const key = crossfade ? "on" : "off";
  const hit = cached[key];
  if (hit) return hit;
  const env = buildEnvelope(
    spans
      .filter((span) => span.length > 0)
      .map((span) => ({
        start: span.start,
        length: span.length,
        row: span.index,
        source: sourceKey(span.clip.source),
        inSec: span.clip.inSec,
      })),
    crossfade,
  );
  cached[key] = env;
  return env;
}

/** Over precomputed spans: the non-empty span with start <= t < end; the last non-empty one at or past the end, the first before 0; null when none. */
export function spanAtTime(spans: readonly ClipSpan[], t: number): ClipSpan | null {
  const filled = spans.filter((s) => s.length > 0);
  if (filled.length === 0) return null;
  if (t < 0) return filled[0];
  return filled.find((s) => s.start <= t && t < s.end) ?? filled[filled.length - 1];
}

/**
 * Every non-empty span with start <= t < end, in span order: at most 2 in Track and lined-up stacks, earlier first
 * (joinOverlaps never lets three meet); any number in a placed stack, top row first.
 */
export function spansAt(spans: readonly ClipSpan[], t: number): ClipSpan[] {
  return spans.filter((s) => s.length > 0 && s.start <= t && t < s.end);
}

/**
 * The clip the editor means at t: the preferred span when t is inside it; else the first live span (the earlier clip
 * in Track and lined-up stacks, the top row in a placed one: in front in both Crossfade states). Else, inside
 * [0, spansEnd), null (a gap); before 0 the first non-empty span; at or past the end the non-empty span that ends
 * latest (the later one on a tie). Track and lined-up stacks have no gaps and their last non-empty span ends latest.
 */
export function topSpanAt(spans: readonly ClipSpan[], t: number, preferClipId?: string | null): ClipSpan | null {
  const live = spansAt(spans, t);
  if (preferClipId) {
    const preferred = live.find((s) => s.clip.id === preferClipId);
    if (preferred) return preferred;
  }
  if (live.length > 0) return live[0];
  const filled = spans.filter((s) => s.length > 0);
  if (filled.length === 0) return null;
  if (t < 0) return filled[0];
  if (t < spansEnd(spans)) return null;
  return filled.reduce((latest, s) => (s.end >= latest.end ? s : latest));
}

/** Whether two clips play at t. */
export function inOverlap(spans: readonly ClipSpan[], t: number): boolean {
  return spansAt(spans, t).length >= 2;
}

/** One clip as the preview shows it at an instant: its picture's opacity and its sound's gain. */
export interface PreviewLayer {
  span: ClipSpan;
  opacity: number;
  gain: number;
}

/**
 * The clips the preview plays at t, earlier first. Outside an overlap the one clip at t (spanAtTime) at full opacity
 * and gain. Inside the overlap of A and B, p = (t − B.start) / B.overlapIn: crossfade on, A at opacity 1 under B at p,
 * the sound at equal power; off, A in front and B hidden, both heard in full. No non-empty span → [].
 */
export function layersAt(spans: readonly ClipSpan[], t: number, crossfade: boolean): PreviewLayer[] {
  const live = spansAt(spans, t);
  if (live.length >= 2) {
    const [a, b] = live;
    if (!crossfade) return [{ span: a, opacity: 1, gain: 1 }, { span: b, opacity: 0, gain: 1 }];
    const p = b.overlapIn > 0 ? Math.min(Math.max((t - b.start) / b.overlapIn, 0), 1) : 1;
    return [
      { span: a, opacity: 1, gain: crossfadeGain(p, "out") },
      { span: b, opacity: p, gain: crossfadeGain(p, "in") },
    ];
  }
  const span = spanAtTime(spans, t);
  return span ? [{ span, opacity: 1, gain: 1 }] : [];
}

/**
 * Where t lands after the spans change (a layout switch, a new overlap): the same clip and the same frame of it, in
 * `after`. At or past the end it stays at the end; a clip gone from `after` keeps t, clamped to the new total; in a gap
 * of `before` t stays, clamped to the new total.
 */
export function reanchorTime(
  before: readonly ClipSpan[],
  after: readonly ClipSpan[],
  t: number,
  preferClipId?: string | null,
): number {
  const total = spansEnd(after);
  const end = spansEnd(before);
  const span = topSpanAt(before, t, preferClipId);
  if (!span) return t >= 0 && t < end ? clamp(t, 0, total) : total;
  if (t >= end) return total;
  const moved = after.find((s) => s.clip.id === span.clip.id);
  const at = moved ? moved.start + (t - span.start) : t;
  return clamp(at, 0, total);
}

/**
 * topSpanAt over the spans: the preferred clip when t is inside it, else the earlier clip at t. If t >= total, the
 * last non-empty span. If t < 0, the first. No non-empty span → null. Track and lined-up stacks only (a number
 * overlap); a placed stack uses layoutSpans and topSpanAt.
 */
export function clipAtTime(
  timeline: readonly StitchTimelineClip[],
  durations: SourceDurations,
  t: number,
  overlapSec: number,
  preferClipId?: string | null,
): ClipSpan | null {
  return topSpanAt(clipSpans(timeline, durations, overlapSec), t, preferClipId);
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

/** Whether a clip has a trim to reset. */
export function isTrimmed(clip: Pick<StitchTimelineClip, "inSec" | "outSec">): boolean {
  return clip.inSec !== 0 || clip.outSec !== null;
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
 * Split the non-empty span containing t (opts.preferClipId's when t is inside it, else topSpanAt's), else null.
 * Spans: layoutSpans(…, opts.layout) when given, else clipSpans(…, opts.overlapSec ?? 0).
 * Track and lined-up stacks: only when t is at least MIN_CLIP_SEC inside the clip's solo part (its edges less its
 * overlaps); never inside an overlap. A placed stack: anywhere at least MIN_CLIP_SEC from the clip's ends, overlaps
 * included (the pieces form one run, so the picture and sound do not change); never in a gap.
 * The left piece keeps its id and in, and its out = sourceTimeAt(t). The right piece gets a new id, in = sourceTimeAt(t)
 * and the original out, and when the clip has a startSec, startSec + (cut − in): where its frames already were.
 * muted and volume are copied to both. A non-finite t splits nothing. Pieces of one source meet with a cut, so a
 * split outside an overlap moves nothing.
 */
export function splitClipAt(
  timeline: StitchTimelineClip[],
  durations: SourceDurations,
  t: number,
  makeId: () => string = newClipId,
  opts: { overlapSec?: number; preferClipId?: string | null; layout?: StitchSequenceLayout } = {},
): { timeline: StitchTimelineClip[]; leftId: string; rightId: string } | null {
  if (!Number.isFinite(t)) return null;
  const spans = opts.layout
    ? layoutSpans(timeline, durations, opts.layout)
    : clipSpans(timeline, durations, opts.overlapSec ?? 0);
  const placed = opts.layout?.mode === "stacked" && isPlaced(timeline);
  if (!placed && inOverlap(spans, t)) return null;
  const span = topSpanAt(spans, t, opts.preferClipId);
  if (!span) return null;
  const head = placed ? span.start : span.start + span.overlapIn;
  const tail = placed ? span.end : span.end - span.overlapOut;
  if (t - head < MIN_CLIP_SEC || tail - t < MIN_CLIP_SEC) return null;
  const cut = sourceTimeAt(span, t);
  const left: StitchTimelineClip = { ...span.clip, outSec: cut };
  const right: StitchTimelineClip = { ...span.clip, id: makeId(), inSec: cut, outSec: span.clip.outSec };
  if (span.clip.startSec !== undefined) right.startSec = span.clip.startSec + (cut - span.clip.inSec);
  const next = timeline.slice();
  next.splice(span.index, 1, left, right);
  return { timeline: next, leftId: left.id, rightId: right.id };
}

/**
 * I / O keys: set the clip's in or out to the source time under the playhead. null if the playhead is not inside
 * that clip (or not finite). The far boundary is outside: O at the clip's start, or I at its end, does nothing.
 * Track and lined-up stacks only (a number overlap); a placed stack uses layoutSpans and topSpanAt.
 */
export function setEdgeAtPlayhead(
  timeline: StitchTimelineClip[],
  durations: SourceDurations,
  clipId: string,
  edge: "in" | "out",
  playhead: number,
  overlapSec: number,
): StitchTimelineClip[] | null {
  if (!Number.isFinite(playhead)) return null;
  const span = clipSpans(timeline, durations, overlapSec).find((s) => s.clip.id === clipId);
  if (!span || span.length === 0 || playhead < span.start || playhead > span.end) return null;
  if (edge === "out" ? playhead <= span.start : playhead >= span.end) return null;
  const at = sourceTimeAt(span, playhead);
  return trimClip(timeline, clipId, durations, edge === "in" ? { inSec: at } : { outSec: at });
}

// Placing clips in Stacked. A pinning edit first writes every clip's current start as startSec, so no clip it does not
// edit moves; each returns the same array when the edit changes nothing (and then pins nothing either).

const stackedLayout = (overlapSec: number): StitchSequenceLayout => ({ mode: "stacked", overlapSec, crossfade: true });
const clampStart = (sec: number) => clamp(sec, 0, MAX_START_SEC);

/**
 * Every clip's start as layoutSpans(…, { mode: "stacked", overlapSec }) shows it, written as startSec. The same array
 * when every clip already has one.
 */
export function pinStarts(
  timeline: StitchTimelineClip[],
  durations: SourceDurations,
  overlapSec: number,
): StitchTimelineClip[] {
  if (timeline.every((clip) => clip.startSec !== undefined)) return timeline;
  const spans = layoutSpans(timeline, durations, stackedLayout(overlapSec));
  return timeline.map((clip, i) => (clip.startSec !== undefined ? clip : { ...clip, startSec: spans[i].start }));
}

/** Line up: every startSec removed. The same array when none has one. */
export function clearStarts(timeline: StitchTimelineClip[]): StitchTimelineClip[] {
  if (!timeline.some((clip) => clip.startSec !== undefined)) return timeline;
  return timeline.map((clip) => {
    if (clip.startSec === undefined) return clip;
    const next = { ...clip };
    delete next.startSec;
    return next;
  });
}

/** The start of the clip at index as the stacked layout shows it. */
function stackedStartOf(
  timeline: readonly StitchTimelineClip[],
  durations: SourceDurations,
  index: number,
  overlapSec: number,
): number {
  return layoutSpans(timeline, durations, stackedLayout(overlapSec))[index].start;
}

/**
 * pinStarts, then clipId starts at clamp(startSec, 0, MAX_START_SEC). The same array when nothing changes (pinning
 * alone included: the caller asks only when the start differs). A non-finite startSec changes nothing.
 */
export function moveClipStart(
  timeline: StitchTimelineClip[],
  durations: SourceDurations,
  clipId: string,
  startSec: number,
  overlapSec: number,
): StitchTimelineClip[] {
  return placeClip(timeline, durations, clipId, startSec, timeline.findIndex((c) => c.id === clipId), overlapSec);
}

/**
 * A body drag's release: pinStarts, then clipId starts at clamp(startSec, 0, MAX_START_SEC), then moveClip(…, its
 * index, toIndex). Every other clip keeps its start. The same array when the start and the row are both unchanged
 * (then nothing is pinned either: a drag back to where it began writes nothing).
 */
export function placeClip(
  timeline: StitchTimelineClip[],
  durations: SourceDurations,
  clipId: string,
  startSec: number,
  toIndex: number,
  overlapSec: number,
): StitchTimelineClip[] {
  const index = timeline.findIndex((c) => c.id === clipId);
  if (index === -1 || !Number.isFinite(startSec) || !Number.isFinite(toIndex)) return timeline;
  const start = clampStart(startSec);
  const to = clamp(Math.trunc(toIndex), 0, timeline.length - 1);
  if (to === index && start === stackedStartOf(timeline, durations, index, overlapSec)) return timeline;
  const pinned = pinStarts(timeline, durations, overlapSec).map((c, i) => (i === index ? { ...c, startSec: start } : c));
  return moveClip(pinned, index, to);
}

/**
 * Stacked trim with the frames fixed in time: pinStarts, then trimClip with patch.inSec raised to at least
 * inSec − start (the clip cannot start before 0); the clip's startSec moves by the In's change. Out keeps the start.
 * The same array when the trim changes nothing (then nothing is pinned either).
 */
export function trimClipInPlace(
  timeline: StitchTimelineClip[],
  clipId: string,
  durations: SourceDurations,
  patch: { inSec?: number; outSec?: number | null },
  overlapSec: number,
): StitchTimelineClip[] {
  const index = timeline.findIndex((c) => c.id === clipId);
  if (index === -1) return timeline;
  const clip = timeline[index];
  const start = stackedStartOf(timeline, durations, index, overlapSec);
  const bounded =
    patch.inSec !== undefined && Number.isFinite(patch.inSec)
      ? { ...patch, inSec: Math.max(patch.inSec, clip.inSec - start) }
      : patch;
  const trimmed = trimClip(timeline, clipId, durations, bounded);
  if (trimmed === timeline) return timeline;
  const next = trimmed[index];
  const startSec = clampStart(start + (next.inSec - clip.inSec));
  return pinStarts(timeline, durations, overlapSec).map((c, i) => (i === index ? { ...next, startSec } : c));
}

/** Reset trim in Stacked: pinStarts; startSec = max(0, start − inSec); In 0, Out null. The same array when untrimmed. */
export function resetTrimInPlace(
  timeline: StitchTimelineClip[],
  clipId: string,
  durations: SourceDurations,
  overlapSec: number,
): StitchTimelineClip[] {
  const index = timeline.findIndex((c) => c.id === clipId);
  if (index === -1 || !isTrimmed(timeline[index])) return timeline;
  const clip = timeline[index];
  const startSec = clampStart(stackedStartOf(timeline, durations, index, overlapSec) - clip.inSec);
  return pinStarts(timeline, durations, overlapSec).map((c, i) =>
    i === index ? { ...c, inSec: 0, outSec: null, startSec } : c,
  );
}

/**
 * The placed preview's layers at t in row order (the stage's DOM order): every live span with its gain and its DOM
 * opacity (domOpacities of the envelope's weights in that order; the shares composite the same in any order), from
 * spansEnvelope. Inside a run's gap under half a slot, the earlier piece's span (its element holds its last frame);
 * inside a bridged gap, the held spans too. Inside a gap under a slot, which the lane does not draw and the encode
 * holds the frame across, the layers just before it. In a gap []. At t >= total (> 0) the layers at total − 1e-6, so
 * the end shows the last frames of the clips that end last.
 */
export function placedLayersAt(spans: readonly ClipSpan[], t: number, crossfade: boolean): PreviewLayer[] {
  const total = spansEnd(spans);
  const at = total > 0 && t >= total ? total - 1e-6 : t;
  const env = spansEnvelope(spans, crossfade);
  let layers = envelopeAt(env, at);
  if (layers.length === 0) {
    let before = -Infinity;
    let after = Infinity;
    for (const u of env.units) {
      const end = u.start + u.length;
      if (end <= at + TIME_EPS) before = Math.max(before, end);
      if (u.start > at) after = Math.min(after, u.start);
    }
    if (after - before < SLOT_SEC - TIME_EPS) layers = envelopeAt(env, before - 2 * TIME_EPS);
  }
  const byRow = new Map(spans.map((span) => [span.index, span]));
  const rows = layers
    .flatMap((layer) => {
      const span = byRow.get(env.units[layer.unit].row);
      return span ? [{ span, weight: layer.weight, gain: layer.gain }] : [];
    })
    .sort((a, b) => a.span.index - b.span.index);
  const opacities = domOpacities(rows.map((row) => row.weight));
  return rows.map(({ span, gain }, k) => ({ span, opacity: opacities[k], gain }));
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

/** Stacked's second snap target: the dragged edge where it started, which gives the clip its original length back. */
export function originalEdgeTarget(span: ClipSpan, edge: "in" | "out"): SnapTarget {
  return { t: edge === "out" ? span.end : span.start, kind: "edge", label: "the original length" };
}
