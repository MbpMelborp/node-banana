import type { ClipWarp, ClipWarpCurve, StitchClipSource, StitchSequenceLayout, StitchTimelineClip } from "@/types";
import {
  buildEnvelope,
  domOpacities,
  envelopeAt,
  MAX_START_SEC,
  resolveStarts,
  SLOT_SEC,
  TIME_EPS,
  warpedUnitEnds,
  type StackEnvelope,
} from "./placement";
import { FRAME_RATE } from "./sequencePlan";
import { crossfadeGain, joinOverlaps } from "./stack";
import {
  activeWarp,
  canSplitWarp,
  IDENTITY_WARP,
  MAX_SPEED,
  maxSourceLength,
  MIN_SPEED,
  minSourceLength,
  normalizeWarp,
  sameWarp,
  splitWarp,
  trimField,
  warpedLength,
  warpMap,
  withWarp,
  type SourceRange,
  type WarpMap,
} from "./warp";

export { MAX_START_SEC } from "./placement";

/**
 * The Stitch timeline's clip maths: lengths, spans, trims, splits and moves.
 *
 * Pure: no React, no DOM, no mediabunny. Times are seconds. A clip's In and
 * Out are in its source's time; a span's start and end are in sequence time
 * (one loop). A clip's warp (warp.ts) maps between them: its span lasts its
 * source range over its average speed. In Track clips are butted together,
 * so a span starts where the one before it ends. A Stacked stack is lined up
 * until some clip has a startSec: then each clip starts where it was placed
 * (placement.ts), and until then each starts joinOverlaps' overlap before the
 * end of the one above.
 */

/** The shortest a trimmed clip can be, in output seconds (clampTrim). */
export const MIN_CLIP_SEC = 0.1;
/** An Out this close to the source's end is stored as null ("to the end"); under a warp this much output at most. */
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
  init: {
    id?: string;
    inSec?: number;
    outSec?: number | null;
    muted?: boolean;
    volume?: number;
    startSec?: number;
    warp?: ClipWarp;
  } = {},
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
    ...(init.warp !== undefined ? { warp: init.warp } : {}),
  };
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/**
 * The trimmed length in output seconds: the source range over the warp's average speed. An unknown source duration
 * counts 0, and so does a length under one output frame: the encode drops such a clip (planSequence), so the editor
 * gives it no time either.
 */
export function clipLength(clip: StitchTimelineClip, sourceDuration: number | undefined): number {
  if (sourceDuration === undefined || !Number.isFinite(sourceDuration)) return 0;
  const end = Math.min(clip.outSec ?? sourceDuration, sourceDuration);
  const source = Math.max(0, end - Math.min(clip.inSec, sourceDuration));
  const warp = activeWarp(clip);
  const length = warp ? warpedLength(source, warp) : source;
  return length < 1 / FRAME_RATE ? 0 : length;
}

/**
 * The clip's resolved Out: its Out (the source's end when null) clamped to the source's duration, never before its In;
 * its In while the duration is unknown. With clip.inSec, the source range a warp map reads (planSequence clamps alike).
 */
export function clipSourceOut(
  clip: Pick<StitchTimelineClip, "inSec" | "outSec">,
  sourceDuration: number | undefined,
): number {
  if (sourceDuration === undefined || !Number.isFinite(sourceDuration)) return clip.inSec;
  return Math.max(clip.inSec, Math.min(clip.outSec ?? sourceDuration, sourceDuration));
}

export interface ClipSpan {
  clip: StitchTimelineClip;
  index: number;
  start: number;
  end: number;
  length: number;
  /** The clip's resolved Out (clipSourceOut, its In while the duration is unknown): with clip.inSec, what it plays. */
  sourceOut: number;
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
  const sourceDurations = timeline.map((clip) => durations.get(sourceKey(clip.source)));
  const lengths = timeline.map((clip, i) => clipLength(clip, sourceDurations[i]));
  const overlaps = joinOverlaps(
    timeline.map((clip, i) => ({ length: lengths[i], source: sourceKey(clip.source) })),
    overlapSec,
  );
  let cursor = 0;
  const spans = timeline.map((clip, index): ClipSpan => {
    const length = lengths[index];
    const sourceOut = clipSourceOut(clip, sourceDurations[index]);
    if (!(length > 0)) {
      return { clip, index, start: cursor, end: cursor, length, sourceOut, overlapIn: 0, overlapOut: 0 };
    }
    const start = cursor - overlaps[index];
    cursor = start + length;
    return { clip, index, start, end: cursor, length, sourceOut, overlapIn: overlaps[index], overlapOut: 0 };
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
  const sourceDurations = timeline.map((clip) => durations.get(sourceKey(clip.source)));
  const lengths = timeline.map((clip, i) => clipLength(clip, sourceDurations[i]));
  const starts = resolveStarts(
    timeline.map((clip, i) => ({ start: clip.startSec, length: lengths[i], source: sourceKey(clip.source) })),
    overlapSec,
  );
  return timeline.map((clip, index): ClipSpan => {
    const length = lengths[index] > 0 ? lengths[index] : 0;
    const start = starts[index];
    const sourceOut = clipSourceOut(clip, sourceDurations[index]);
    return { clip, index, start, end: start + length, length, sourceOut, overlapIn: 0, overlapOut: 0 };
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
 * inSec = clip.inSec, and a retimed clip's sourceEnds (warpedUnitEnds). Cached per spans array and flag. The lane, the
 * gap bands, the summary, the card, the modal and placedLayersAt all call this; none builds units itself.
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
      .map((span) => {
        const warp = activeWarp(span.clip);
        return {
          start: span.start,
          length: span.length,
          row: span.index,
          source: sourceKey(span.clip.source),
          inSec: span.clip.inSec,
          ...(warp ? { sourceEnds: warpedUnitEnds(span.clip.inSec, span.sourceOut, warp.reverse) } : {}),
        };
      }),
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

/** The span's source range, as warp.ts reads it: the clip's In and its resolved Out (sourceOut). */
export function spanRange(span: ClipSpan): SourceRange {
  return { inSec: span.clip.inSec, outSec: span.sourceOut };
}

const warpMaps = new WeakMap<ClipSpan, WarpMap>();

/**
 * The span's warp map, compiled once per span (a span never changes after clipSpans or placedSpans returns it); null
 * for a clip at its own speed or a span with no length.
 */
export function spanWarpMap(span: ClipSpan): WarpMap | null {
  const warp = activeWarp(span.clip);
  if (!warp || !(span.length > 0)) return null;
  let map = warpMaps.get(span);
  if (!map) {
    map = warpMap(spanRange(span), warp);
    warpMaps.set(span, map);
  }
  return map;
}

/**
 * Source seconds shown at sequence time t: clip.inSec + clamp(t − start, 0, length), through the clip's warp when it
 * has one (a reversed clip shows its Out at its start).
 */
export function sourceTimeAt(span: ClipSpan, t: number): number {
  const map = spanWarpMap(span);
  if (map) return map.sourceTimeAt(clamp(t - span.start, 0, span.length));
  return span.clip.inSec + clamp(t - span.start, 0, span.length);
}

const finiteOr = (value: number | undefined, fallback: number) =>
  value !== undefined && Number.isFinite(value) ? value : fallback;

/** Where a clip's frames end in its source: its Out, or the source's end when the Out is null or past it. */
const playedOut = (clip: Pick<StitchTimelineClip, "outSec">, sourceDuration: number) =>
  Math.min(clip.outSec ?? sourceDuration, sourceDuration);

/** The source a clip plays now; with no known duration a null Out counts as no end. */
function heldSource(clip: StitchTimelineClip, sourceDuration: number | undefined): number {
  const known = sourceDuration !== undefined && Number.isFinite(sourceDuration);
  return (known ? playedOut(clip, sourceDuration) : (clip.outSec ?? Infinity)) - clip.inSec;
}

/** The most source a retimed clip may play: MAX_START_SEC of output below 1×, or what it plays now when more. */
const sourceCap = (warp: ClipWarp, held: number) => Math.max(maxSourceLength(warp, MAX_START_SEC), held);

/** How near the source's end an Out is stored as null: END_EPSILON_SEC, and never more than that of output. */
const endSnap = (warp: ClipWarp | null) => (warp ? END_EPSILON_SEC * Math.min(1, warp.speed) : END_EPSILON_SEC);

/**
 * Trim rules. With D known: 0 <= in <= effOut − MIN, in + MIN <= out <= D, and out >= D − EPS becomes null.
 * With D unknown: in >= 0, a numeric out >= in + MIN. If D < MIN: { inSec: 0, outSec: null }.
 * patch.outSec === null means "to the end". The edge the patch moves gives way; the other one holds.
 * MIN is MIN_CLIP_SEC and EPS END_EPSILON_SEC; under a warp they are output time: MIN = MIN_CLIP_SEC × speed of source
 * (never more than the clip holds when that is at least MIN_CLIP_SEC), EPS = END_EPSILON_SEC × min(1, speed). Slower
 * than 1× a trim never gives the clip more than MAX_START_SEC of output; one that already plays longer may only
 * shrink.
 */
export function clampTrim(
  clip: StitchTimelineClip,
  sourceDuration: number | undefined,
  patch: { inSec?: number; outSec?: number | null },
): { inSec: number; outSec: number | null } {
  const movesOut = patch.outSec !== undefined && (patch.outSec === null || Number.isFinite(patch.outSec));
  const nextIn = Math.max(0, finiteOr(patch.inSec, clip.inSec));
  const warp = activeWarp(clip);
  const held = warp ? heldSource(clip, sourceDuration) : 0;
  const min = warp ? Math.min(minSourceLength(warp, MIN_CLIP_SEC), Math.max(MIN_CLIP_SEC, held)) : MIN_CLIP_SEC;
  const cap = warp ? sourceCap(warp, held) : Infinity;
  // At or over the cap the clip may only shrink: the edge it would grow keeps its stored value, never one rebuilt from
  // the cap an ulp away
  const full = Number.isFinite(cap) && cap === held;
  const endEpsilon = endSnap(warp);

  if (sourceDuration === undefined || !Number.isFinite(sourceDuration)) {
    const out = movesOut ? (patch.outSec ?? null) : clip.outSec;
    if (out === null) return { inSec: nextIn, outSec: null };
    if (movesOut) {
      const most = full && nextIn === clip.inSec && clip.outSec !== null ? clip.outSec : nextIn + cap;
      return { inSec: nextIn, outSec: Math.min(Math.max(out, nextIn + min), most) };
    }
    // Only In moved: it stops short of the Out, unless the Out itself is under the minimum.
    if (out - min < 0) return { inSec: 0, outSec: min };
    return { inSec: Math.max(Math.min(nextIn, out - min), full ? clip.inSec : out - cap), outSec: out };
  }

  const d = sourceDuration;
  if (d < min) return { inSec: 0, outSec: null };

  let inSec: number;
  let outSec: number;
  if (movesOut) {
    inSec = clamp(nextIn, 0, d - min);
    outSec = clamp(patch.outSec ?? d, inSec + min, d);
  } else {
    const baseIn = clamp(clip.inSec, 0, d - min);
    outSec = clamp(clip.outSec ?? d, baseIn + min, d);
    inSec = clamp(nextIn, 0, outSec - min);
  }
  if (outSec - inSec > cap) {
    if (movesOut) outSec = full && inSec === clip.inSec ? playedOut(clip, d) : inSec + cap;
    else inSec = full && outSec === playedOut(clip, d) ? clip.inSec : outSec - cap;
  }
  return { inSec, outSec: outSec >= d - endEpsilon ? null : outSec };
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

/**
 * The range Reset trim gives a clip: the whole source (In 0, Out null), unless the clip is slower than 1× and that
 * would play past MAX_START_SEC. Then the tail grows to that first and the head after it, so the clip keeps the frame
 * it starts on as long as it can; an Out in the end snap is null. A slow clip already at or past the cap keeps its
 * range (it may only shrink), and one whose source length is not known yet keeps it too: the cap needs that length.
 */
function resetRange(
  clip: StitchTimelineClip,
  sourceDuration: number | undefined,
): { inSec: number; outSec: number | null } {
  const warp = activeWarp(clip);
  const cap = maxSourceLength(warp, MAX_START_SEC);
  if (!warp || cap === Infinity) return { inSec: 0, outSec: null };
  const d = sourceDuration;
  if (d === undefined || !Number.isFinite(d)) return { inSec: clip.inSec, outSec: clip.outSec };
  const toEnd = (outSec: number) => (outSec >= d - endSnap(warp) ? null : outSec);
  if (heldSource(clip, d) >= cap) return { inSec: clip.inSec, outSec: toEnd(playedOut(clip, d)) };
  if (!(d > cap)) return { inSec: 0, outSec: null };
  if (!warp.reverse) {
    // The tail is the Out
    if (clip.inSec + cap <= d) return { inSec: clip.inSec, outSec: toEnd(clip.inSec + cap) };
    return { inSec: d - cap, outSec: null };
  }
  // Reversed, the tail is the In and the Out is shown first
  const out = playedOut(clip, d);
  return out - cap >= 0 ? { inSec: out - cap, outSec: toEnd(out) } : { inSec: 0, outSec: toEnd(cap) };
}

/**
 * Whether Reset trim would change the clip: isTrimmed, but false for a clip slower than 1× that already has the range
 * resetRange gives it (MAX_START_SEC of output, or more), which has nothing left to reset, and for one whose source
 * length is not known yet.
 */
export function canResetTrim(clip: StitchTimelineClip, sourceDuration: number | undefined): boolean {
  const range = resetRange(clip, sourceDuration);
  return clip.inSec !== range.inSec || clip.outSec !== range.outSec;
}

/** In 0 and Out null; with the durations, resetRange's range (a slow clip keeps to MAX_START_SEC of output). */
export function resetTrim(
  timeline: StitchTimelineClip[],
  clipId: string,
  durations?: SourceDurations,
): StitchTimelineClip[] {
  const index = timeline.findIndex((c) => c.id === clipId);
  if (index === -1) return timeline;
  const clip = timeline[index];
  const range = resetRange(clip, durations?.get(sourceKey(clip.source)));
  if (clip.inSec === range.inSec && clip.outSec === range.outSec) return timeline;
  return timeline.map((c, i) => (i === index ? { ...c, ...range } : c));
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

/** A positive value to three significant figures, rounded down or up with a 1e-9 give, so 0.3 / 0.1 gives 3, not 2.99. */
function sig3(value: number, dir: "down" | "up"): number {
  const unit = 10 ** (Math.floor(Math.log10(value)) - 2);
  const scaled = dir === "down" ? Math.floor(value / unit + 1e-9) : Math.ceil(value / unit - 1e-9);
  return Number((scaled * unit).toPrecision(3));
}

/**
 * The speeds the rail offers a clip with this much source (seconds; undefined while unknown): MIN_SPEED–MAX_SPEED,
 * never so slow that it plays past MAX_START_SEC, never so fast that it lasts under MIN_CLIP_SEC, the bounds rounded
 * inward to three significant figures; but 1× always, so "1×" and Reset speed reach it: at 1× a long source plays past
 * 10 minutes and a clip holding under 0.1 s of source lasts under 0.1 s, as unwarped clips do.
 */
export function speedLimits(sourceLength: number | undefined): { min: number; max: number } {
  if (sourceLength === undefined || !(sourceLength > 0) || !Number.isFinite(sourceLength)) {
    return { min: MIN_SPEED, max: MAX_SPEED };
  }
  const max = Math.max(1, Math.min(MAX_SPEED, sig3(sourceLength / MIN_CLIP_SEC, "down")));
  const min = Math.min(1, Math.max(MIN_SPEED, sig3(sourceLength / MAX_START_SEC, "up")));
  return { min, max };
}

/** speedLimits of the source a clip holds (MIN_SPEED–MAX_SPEED while the source's length is unknown). */
export function clipSpeedLimits(
  clip: StitchTimelineClip,
  sourceDuration: number | undefined,
): { min: number; max: number } {
  return speedLimits(sourceDuration === undefined ? undefined : clipSourceOut(clip, sourceDuration) - clip.inSec);
}

/** A change to clips' warps: each given field replaces the clip's; a curve (null included) replaces the ramp and drops its window. */
export interface WarpPatch {
  speed?: number;
  curve?: ClipWarpCurve | null;
  reverse?: boolean;
  blend?: boolean;
}

/**
 * The patch on every clip in ids. A patched speed is clamped to the clip's clipSpeedLimits (its source length from
 * durations); a stored speed outside them (a split piece's) is kept when the patch has none. Each result is canonical
 * (normalizeWarp, withWarp), so an identity warp is removed. A clip whose warp comes out the same keeps its object; the
 * same array when nothing changes.
 */
export function updateClipsWarp(
  timeline: StitchTimelineClip[],
  ids: ReadonlySet<string>,
  durations: SourceDurations,
  patch: WarpPatch,
): StitchTimelineClip[] {
  const newCurve = "curve" in patch;
  let changed = false;
  const next = timeline.map((clip) => {
    if (!ids.has(clip.id)) return clip;
    const was = clip.warp ?? IDENTITY_WARP;
    let speed = was.speed;
    if (patch.speed !== undefined && Number.isFinite(patch.speed)) {
      const { min, max } = clipSpeedLimits(clip, durations.get(sourceKey(clip.source)));
      speed = clamp(patch.speed, min, max);
    }
    const warp = normalizeWarp({
      speed,
      curve: newCurve ? (patch.curve ?? null) : was.curve,
      ...(!newCurve && was.window ? { window: was.window } : {}),
      reverse: patch.reverse ?? was.reverse,
      blend: patch.blend ?? was.blend,
    });
    if (sameWarp(warp, clip.warp)) return clip;
    changed = true;
    return withWarp(clip, warp);
  });
  return changed ? next : timeline;
}

/** updateClipsWarp on one clip. */
export function updateClipWarp(
  timeline: StitchTimelineClip[],
  clipId: string,
  durations: SourceDurations,
  patch: WarpPatch,
): StitchTimelineClip[] {
  return updateClipsWarp(timeline, new Set([clipId]), durations, patch);
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
 * Why splitClipAt would not split this span at t: "edge" within MIN_CLIP_SEC of its head or tail (its overlaps' edges
 * in Track and a lined-up stack, its own ends when placed); "warp" where its warp cannot be cut (warp.ts canSplitWarp:
 * a piece would stand still or lie inside a freeze) or a piece would hold under END_EPSILON_SEC of source (its
 * neighbour's Out would then sit in clampTrim's end snap); null when it can. t must be finite.
 */
export function splitRefusal(span: ClipSpan, t: number, placed: boolean): "edge" | "warp" | null {
  const head = placed ? span.start : span.start + span.overlapIn;
  const tail = placed ? span.end : span.end - span.overlapOut;
  if (t - head < MIN_CLIP_SEC || tail - t < MIN_CLIP_SEC) return "edge";
  const warp = activeWarp(span.clip);
  if (!warp) return null;
  const map = spanWarpMap(span);
  const offset = t - span.start;
  if (!map || !canSplitWarp(spanRange(span), warp, offset)) return "warp";
  const at = map.sourceTimeAt(offset);
  return Math.min(at - span.clip.inSec, span.sourceOut - at) < END_EPSILON_SEC ? "warp" : null;
}

/**
 * Split the non-empty span containing t (opts.preferClipId's when t is inside it, else topSpanAt's), else null.
 * Spans: layoutSpans(…, opts.layout) when given, else clipSpans(…, opts.overlapSec ?? 0).
 * Track and lined-up stacks: only when t is at least MIN_CLIP_SEC inside the clip's solo part (its edges less its
 * overlaps); never inside an overlap. A placed stack: anywhere at least MIN_CLIP_SEC from the clip's ends, overlaps
 * included (the pieces form one run, so the picture and sound do not change); never in a gap. A cut splitRefusal
 * refuses splits nothing.
 * The left piece keeps its id and in, and its out = sourceTimeAt(t). The right piece gets a new id, in = sourceTimeAt(t)
 * and the original out, and when the clip has a startSec, startSec + (cut − in): where its frames already were.
 * Under a warp the warp is cut too (warp.ts splitWarp): the pieces' lengths are t − start and the rest, the right
 * piece's startSec is startSec + (t − start), and every instant shows the frame it showed; a reversed clip's left piece
 * keeps its Out and gets In = the cut.
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
  if (!span || splitRefusal(span, t, placed) !== null) return null;
  const warp = activeWarp(span.clip);
  let left: StitchTimelineClip;
  let right: StitchTimelineClip;
  if (!warp) {
    const cut = sourceTimeAt(span, t);
    left = { ...span.clip, outSec: cut };
    right = { ...span.clip, id: makeId(), inSec: cut, outSec: span.clip.outSec };
    if (span.clip.startSec !== undefined) right.startSec = span.clip.startSec + (cut - span.clip.inSec);
  } else {
    // Each piece keeps its frames; stored edges are the cut and the clip's own, so a null Out stays "to the end"
    const offset = t - span.start;
    const cut = splitWarp(spanRange(span), warp, offset);
    if (!cut) return null;
    // The left piece plays first and keeps the id; reversed, it is the source's end part, so its In moves
    left = withWarp({ ...span.clip, ...(warp.reverse ? { inSec: cut.at } : { outSec: cut.at }) }, cut.first.warp);
    right = withWarp(
      { ...span.clip, id: makeId(), ...(warp.reverse ? { outSec: cut.at } : { inSec: cut.at }) },
      cut.second.warp,
    );
    if (span.clip.startSec !== undefined) right.startSec = span.clip.startSec + offset;
  }
  const next = timeline.slice();
  next.splice(span.index, 1, left, right);
  return { timeline: next, leftId: left.id, rightId: right.id };
}

/**
 * The trim I or O makes with the playhead at t inside the span: the edge moves as a trim drag of that edge snapped to
 * t would. At the clip's own speed (and at any constant one) the In or Out becomes the source time under t. Under a
 * warp the edge's field moves by t's distance from the clip's head times the average speed (a reversed clip's head is
 * its Out); on a ramp, which re-stretches over the new range, the edge still lands where the drag would and the far
 * edge stays.
 */
export function edgeAtPlayheadPatch(
  span: ClipSpan,
  edge: "in" | "out",
  t: number,
): { inSec: number } | { outSec: number } {
  const warp = activeWarp(span.clip);
  if (!warp) {
    const at = sourceTimeAt(span, t);
    return edge === "in" ? { inSec: at } : { outSec: at };
  }
  const into = clamp(t - span.start, 0, span.length) * warp.speed;
  const at = warp.reverse ? span.sourceOut - into : span.clip.inSec + into;
  return trimField(span.clip, edge) === "inSec" ? { inSec: at } : { outSec: at };
}

/**
 * I / O keys: trim the clip's head up to the playhead, or its tail back to it, as a drag of that edge snapped there
 * would (edgeAtPlayheadPatch): at the clip's own speed its In or Out becomes the source time under the playhead. null
 * if the playhead is not inside that clip (or not finite). The far boundary is outside: O at the clip's start, or I at
 * its end, does nothing. Track and lined-up stacks only (a number overlap); a placed stack uses layoutSpans and
 * topSpanAt.
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
  return trimClip(timeline, clipId, durations, edgeAtPlayheadPatch(span, edge, playhead));
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
 * Stacked trim with the frames fixed in time: pinStarts, then trimClip with the head bounded so the clip cannot start
 * before 0:00 (patch.inSec raised to at least inSec − start, through the speed); the clip's startSec moves by the
 * head's change over its speed (the head is the In, or a reversed clip's Out), and a tail change keeps the start. On a
 * ramp the frames between re-time; only the far edge stays where it was. The same array when the trim changes nothing
 * (then nothing is pinned either).
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
  const warp = activeWarp(clip);
  const d = durations.get(sourceKey(clip.source));
  const known = d !== undefined && Number.isFinite(d);
  let bounded = patch;
  if (!warp || !warp.reverse) {
    if (patch.inSec !== undefined && Number.isFinite(patch.inSec)) {
      bounded = { ...patch, inSec: Math.max(patch.inSec, warp ? clip.inSec - start * warp.speed : clip.inSec - start) };
    }
  } else if (known && (patch.outSec === null || (patch.outSec !== undefined && Number.isFinite(patch.outSec)))) {
    // Reversed, the head is the Out: it may reach out by the clip's start in output time
    const limit = playedOut(clip, d) + start * warp.speed;
    if ((patch.outSec ?? d) > limit) bounded = { ...patch, outSec: limit };
  }
  const trimmed = trimClip(timeline, clipId, durations, bounded);
  if (trimmed === timeline) return timeline;
  const next = trimmed[index];
  const startSec = clampStart(
    !warp
      ? start + (next.inSec - clip.inSec)
      : warp.reverse
        ? start + (known ? (playedOut(clip, d) - playedOut(next, d)) / warp.speed : 0)
        : start + (next.inSec - clip.inSec) / warp.speed,
  );
  return pinStarts(timeline, durations, overlapSec).map((c, i) => (i === index ? { ...next, startSec } : c));
}

/**
 * Reset trim in Stacked: pinStarts; resetRange's range (In 0, Out null but for a slow clip); the start moves back by
 * what the head gains over the clip's speed (the In, or a reversed clip's Out), never before 0:00. The same array when
 * nothing changes.
 */
export function resetTrimInPlace(
  timeline: StitchTimelineClip[],
  clipId: string,
  durations: SourceDurations,
  overlapSec: number,
): StitchTimelineClip[] {
  const index = timeline.findIndex((c) => c.id === clipId);
  if (index === -1) return timeline;
  const clip = timeline[index];
  const d = durations.get(sourceKey(clip.source));
  const range = resetRange(clip, d);
  if (clip.inSec === range.inSec && clip.outSec === range.outSec) return timeline;
  const warp = activeWarp(clip);
  const known = d !== undefined && Number.isFinite(d);
  const gained = !warp
    ? clip.inSec
    : warp.reverse
      ? (known ? playedOut(range, d) - playedOut(clip, d) : 0) / warp.speed
      : (clip.inSec - range.inSec) / warp.speed;
  const startSec = clampStart(stackedStartOf(timeline, durations, index, overlapSec) - gained);
  return pinStarts(timeline, durations, overlapSec).map((c, i) => (i === index ? { ...c, ...range, startSec } : c));
}

// Group operations: the same edits on several selected clips at once, each one undo step for the caller. Like the
// others, each returns the same array when nothing changes.

/** Removes every listed clip. orphanedEdgeIds: edges no remaining clip references (as removeClip). */
export function removeClips(
  timeline: StitchTimelineClip[],
  ids: ReadonlySet<string>,
): { timeline: StitchTimelineClip[]; orphanedEdgeIds: string[] } {
  const next = timeline.filter((c) => !ids.has(c.id));
  if (next.length === timeline.length) return { timeline, orphanedEdgeIds: [] };
  const kept = new Set(edgeIdsInOrder(next));
  const orphanedEdgeIds = edgeIdsInOrder(timeline.filter((c) => ids.has(c.id))).filter((edgeId) => !kept.has(edgeId));
  return { timeline: next, orphanedEdgeIds };
}

/** updateClipAudio for each listed clip. */
export function updateClipsAudio(
  timeline: StitchTimelineClip[],
  ids: ReadonlySet<string>,
  patch: { muted?: boolean; volume?: number },
): StitchTimelineClip[] {
  let changed = false;
  const next = timeline.map((clip) => {
    if (!ids.has(clip.id)) return clip;
    const muted = patch.muted ?? clip.muted;
    const volume = clamp(finiteOr(patch.volume, clip.volume), 0, 1);
    if (muted === clip.muted && volume === clip.volume) return clip;
    changed = true;
    return { ...clip, muted, volume };
  });
  return changed ? next : timeline;
}

/**
 * Track block move: the listed clips are taken out (keeping their order), then put back as one run before the
 * toIndex-th remaining clip (toIndex clamped to [0, others.length]).
 */
export function moveClipsBlock(
  timeline: StitchTimelineClip[],
  ids: ReadonlySet<string>,
  toIndex: number,
): StitchTimelineClip[] {
  const moved = timeline.filter((c) => ids.has(c.id));
  if (moved.length === 0 || !Number.isFinite(toIndex)) return timeline;
  const others = timeline.filter((c) => !ids.has(c.id));
  const to = clamp(Math.trunc(toIndex), 0, others.length);
  const next = [...others.slice(0, to), ...moved, ...others.slice(to)];
  return next.every((c, i) => c === timeline[i]) ? timeline : next;
}

/** The row delta shiftRows applies: rowDelta (truncated) clamped so every listed row stays in range; 0 when none is listed. */
function groupRowDelta(timeline: readonly StitchTimelineClip[], ids: ReadonlySet<string>, rowDelta: number): number {
  if (!Number.isFinite(rowDelta)) return 0;
  let first = -1;
  let last = -1;
  timeline.forEach((c, i) => {
    if (!ids.has(c.id)) return;
    if (first === -1) first = i;
    last = i;
  });
  if (first === -1) return 0;
  return clamp(Math.trunc(rowDelta), -first, timeline.length - 1 - last);
}

/**
 * Row move by rowDelta, keeping the spacing: each listed clip ends at its index + d, where
 * d = clamp(rowDelta, −minIndex, last − maxIndex). The other clips fill the free indices in their order.
 * Non-finite or 0 → same array.
 */
export function shiftRows(
  timeline: StitchTimelineClip[],
  ids: ReadonlySet<string>,
  rowDelta: number,
): StitchTimelineClip[] {
  const d = groupRowDelta(timeline, ids, rowDelta);
  if (d === 0) return timeline;
  const next: Array<StitchTimelineClip | undefined> = new Array(timeline.length);
  timeline.forEach((c, i) => {
    if (ids.has(c.id)) next[i + d] = c;
  });
  const others = timeline.filter((c) => !ids.has(c.id));
  let k = 0;
  for (let i = 0; i < next.length; i++) if (next[i] === undefined) next[i] = others[k++];
  return next as StitchTimelineClip[];
}

/**
 * Stacked group drag or nudge: pinStarts; each listed start += d, where d = clamp(deltaSec, −minStart,
 * MAX_START_SEC − maxStart) and the starts are those of the stacked layout; then shiftRows(…, rowDelta). The same
 * array when d === 0 and the rows do not change (then nothing is pinned).
 */
export function placeClips(
  timeline: StitchTimelineClip[],
  durations: SourceDurations,
  ids: ReadonlySet<string>,
  deltaSec: number,
  rowDelta: number,
  overlapSec: number,
): StitchTimelineClip[] {
  const spans = layoutSpans(timeline, durations, stackedLayout(overlapSec));
  const starts = spans.filter((span) => ids.has(span.clip.id)).map((span) => span.start);
  if (starts.length === 0) return timeline;
  const d = Number.isFinite(deltaSec)
    ? clamp(deltaSec, -Math.min(...starts), MAX_START_SEC - Math.max(...starts))
    : 0;
  if (d === 0 && groupRowDelta(timeline, ids, rowDelta) === 0) return timeline;
  const placed =
    d === 0
      ? pinStarts(timeline, durations, overlapSec)
      : pinStarts(timeline, durations, overlapSec).map((c, i) =>
          ids.has(c.id) ? { ...c, startSec: clampStart(spans[i].start + d) } : c,
        );
  return shiftRows(placed, ids, rowDelta);
}

/**
 * S with several selected: splitClipAt with preferClipId = each listed clip, in timeline order, on the timeline as
 * split so far. A split counts only when its leftId is that clip (splitClipAt's fallback to topSpanAt would cut an
 * unselected clip). null when nothing splits. In a lined-up stack and in Track, inOverlap refuses as it does today.
 * A placed stack's caller pins first: a split then moves nothing, so each split reads the positions the last left.
 */
export function splitClipsAt(
  timeline: StitchTimelineClip[],
  durations: SourceDurations,
  t: number,
  ids: readonly string[],
  opts: { layout: StitchSequenceLayout; makeId?: () => string },
): { timeline: StitchTimelineClip[]; rightIds: string[] } | null {
  const wanted = new Set(ids);
  const order = timeline.filter((c) => wanted.has(c.id)).map((c) => c.id);
  let current = timeline;
  const rightIds: string[] = [];
  for (const clipId of order) {
    const result = splitClipAt(current, durations, t, opts.makeId, { layout: opts.layout, preferClipId: clipId });
    if (!result || result.leftId !== clipId) continue;
    current = result.timeline;
    rightIds.push(result.rightId);
  }
  return rightIds.length > 0 ? { timeline: current, rightIds } : null;
}

/** Reset trim for each listed trimmed clip: resetTrim in Track, resetTrimInPlace in Stacked (which pins once). */
export function resetTrims(
  timeline: StitchTimelineClip[],
  durations: SourceDurations,
  ids: ReadonlySet<string>,
  layout: StitchSequenceLayout,
): StitchTimelineClip[] {
  let current = timeline;
  for (const clip of timeline) {
    if (!ids.has(clip.id)) continue;
    current =
      layout.mode === "stacked"
        ? resetTrimInPlace(current, clip.id, durations, layout.overlapSec)
        : resetTrim(current, clip.id, durations);
  }
  return current;
}

/**
 * The last row of the run that holds row `index`; `index` itself when that row is empty (length 0), is alone in its
 * run, or is out of range. Runs (pieces whose frames continue, placement.ts) do not depend on the crossfade flag.
 */
export function runEndIndex(spans: readonly ClipSpan[], index: number): number {
  if (index < 0 || index >= spans.length || !(spans[index].length > 0)) return index;
  const env = spansEnvelope(spans, false);
  const unit = env.units.findIndex((u) => u.row === index);
  if (unit === -1) return index;
  const run = env.runs[env.runOf[unit]];
  return env.units[run.units[run.units.length - 1]].row;
}

/**
 * Whether splitClipsAt would split one of these clips now, without copying the timeline (the rail and the menu ask
 * on every playhead change): t finite; not inside an overlap unless placed; and some listed span live at t (spansAt's
 * rule) with t at least MIN_CLIP_SEC from its head and tail and a cut its warp allows (splitRefusal), read as
 * splitClipAt reads them.
 */
export function canSplitClipsAt(
  spans: readonly ClipSpan[],
  t: number,
  ids: ReadonlySet<string>,
  placed: boolean,
): boolean {
  if (!Number.isFinite(t)) return false;
  if (!placed && inOverlap(spans, t)) return false;
  return spans.some((span) => {
    if (!ids.has(span.clip.id) || !(span.length > 0) || !(span.start <= t && t < span.end)) return false;
    return splitRefusal(span, t, placed) === null;
  });
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
