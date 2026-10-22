import type { ClipWarp } from "@/types";
import type { PicturePlan } from "./picturePlan";
import { FRAME_RATE } from "./sequencePlan";
import type { WarpMap } from "./warp";

/**
 * A warped clip's frames on the 60 fps grid: the source time each slot shows, the frame (or two) nearest it among the
 * clip's real frames, and the slots on which that changes. The render, Frame to canvas and the verification harness
 * all read it from here.
 *
 * Pure: no React, no DOM, no mediabunny.
 */

/** Out is exclusive: a warped clip's source time stops this far before it (as dissolveFrames' `within`, stack.ts). */
export const OUT_EPS = 1e-6;
/** Two source times this close are one: a tie goes to the earlier frame, and a blend this close to a frame is that frame. */
export const TIE_EPS = 1e-6;
/** A decoded frame is the listed frame whose time it is within this (decoders round to the track's time resolution). */
export const MATCH_EPS = 1e-6;
/**
 * Two blends of the same frames this close in alpha are one: a hold in a points curve wobbles by a few ulps, and even
 * 0.01× of a 24 fps source moves alpha by 0.004 a slot.
 */
export const ALPHA_EPS = 1e-9;

/** A planned clip that is retimed (planSequence sets warp only for an active warp). */
export function isWarpedPlan<T extends { warp?: ClipWarp }>(plan: T): plan is T & { warp: ClipWarp } {
  return plan.warp !== undefined;
}

/**
 * Per unit: where a retimed unit's frames may run to past its Out when that Out is a split's join, else null. At such a
 * join the pieces that play on are the same source, retimed and played the same way round (both forward or both
 * reversed), each one's In the Out before it, each next to the one before in time (after it forward, before it
 * reversed; in a placed stack, in its run). The whole clip could show the first frame at or after the join on the slots
 * before it, and a short piece may hold no frame of its own, so this piece lists that frame too, up to the last such
 * piece's Out, and a split changes no slot. Anywhere else Out stays exclusive: a trimmed-off frame is never shown.
 */
export function joinOuts(p: Pick<PicturePlan, "planned" | "sources" | "env">): Array<number | null> {
  /** Whether unit k2 plays on from unit k's Out. */
  const continues = (k: number, k2: number): boolean => {
    const unit = p.planned[k];
    const other = p.planned[k2];
    if (!other || !isWarpedPlan(unit) || !isWarpedPlan(other) || other.warp.reverse !== unit.warp.reverse) return false;
    if (p.sources[k2] !== p.sources[k] || Math.abs(other.inSec - unit.outSec) > TIE_EPS) return false;
    // Placed: unit k is the envelope's unit k, and pieces that continue each other share a run
    return !p.env || p.env.runOf[k2] === p.env.runOf[k];
  };
  return p.planned.map((unit, k) => {
    if (!isWarpedPlan(unit)) return null;
    const step = unit.warp.reverse ? -1 : 1;
    let last = k;
    while (continues(last, last + step)) last += step;
    return last === k ? null : p.planned[last].outSec;
  });
}

/**
 * The output offset slot n reads, counted from the clip's anchor: the earliest source instant the slot covers, which is
 * its start forward and its end reversed.
 */
function slotOffset(map: WarpMap, slot: number, anchorSlot: number, fps: number): number {
  return (slot - anchorSlot + (map.warp.reverse ? 1 : 0)) / fps;
}

/** Source seconds slot n shows, kept in [In, Out − OUT_EPS]. */
export function warpSlotTime(map: WarpMap, slot: number, anchorSlot: number, fps: number = FRAME_RATE): number {
  const { inSec, outSec } = map.range;
  const t = map.sourceTimeAt(slotOffset(map, slot, anchorSlot, fps));
  return Math.min(Math.max(t, inSec), Math.max(inSec, outSec - OUT_EPS));
}

/** Whether slot n blends two frames: Blend frames on, and the momentary speed where the slot reads below 1. */
export function blendsOnSlot(map: WarpMap, slot: number, anchorSlot: number, fps: number = FRAME_RATE): boolean {
  return map.warp.blend && map.speedAt(slotOffset(map, slot, anchorSlot, fps)) < 1;
}

/** One frame (b = −1) or a blend of frames a and b = a + 1 at alpha in (0, 1). Indices into the clip's frame times. */
export interface FramePick {
  a: number;
  b: number;
  alpha: number;
}

/** The last i with times[i] <= t; −1 when none. */
function floorIndex(times: ArrayLike<number>, t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * times: the clip's frames in presentation order, rising. Before the first frame: the first; at or after the last: the
 * last. Blend: the frame at or before t and the next, alpha = (t − a)/(b − a); within TIE_EPS of either, that frame
 * alone. Else the nearer of the two; within TIE_EPS of the middle, the earlier. Callers never pass an empty list.
 */
export function pickFrame(times: ArrayLike<number>, t: number, blend: boolean): FramePick {
  const f = floorIndex(times, t);
  if (f < 0) return { a: 0, b: -1, alpha: 0 };
  if (f >= times.length - 1) return { a: f, b: -1, alpha: 0 };
  if (blend) {
    if (t - times[f] <= TIE_EPS) return { a: f, b: -1, alpha: 0 };
    if (times[f + 1] - t <= TIE_EPS) return { a: f + 1, b: -1, alpha: 0 };
    return { a: f, b: f + 1, alpha: (t - times[f]) / (times[f + 1] - times[f]) };
  }
  const before = t - times[f];
  const after = times[f + 1] - t;
  return { a: after < before - TIE_EPS ? f + 1 : f, b: -1, alpha: 0 };
}

export interface WarpSlots {
  /** The slot the clip's offset 0 lands on in this loop. */
  anchorSlot: number;
  /** The reader's slots: [fromSlot, endSlot). */
  fromSlot: number;
  endSlot: number;
  fps?: number;
}

/** The slots on which the picture changes, from fromSlot (always one) on, and what each shows. */
export interface WarpEvents {
  count: number;
  slots: Int32Array;
  a: Int32Array;
  b: Int32Array;
  alpha: Float64Array;
}

/**
 * Every slot of [fromSlot, endSlot) picked once; an event where the pick differs from the last event's, an alpha within
 * ALPHA_EPS of it counting as the same (a hold need not repeat its floats exactly).
 */
export function warpEvents(times: ArrayLike<number>, map: WarpMap, slots: WarpSlots): WarpEvents {
  const { anchorSlot, fromSlot, endSlot } = slots;
  const fps = slots.fps ?? FRAME_RATE;
  const size = times.length === 0 ? 0 : Math.max(0, endSlot - fromSlot);
  const events: WarpEvents = {
    count: 0,
    slots: new Int32Array(size),
    a: new Int32Array(size),
    b: new Int32Array(size),
    alpha: new Float64Array(size),
  };
  for (let n = fromSlot; n < fromSlot + size; n++) {
    const pick = pickFrame(times, warpSlotTime(map, n, anchorSlot, fps), blendsOnSlot(map, n, anchorSlot, fps));
    const last = events.count - 1;
    const same =
      last >= 0 &&
      events.a[last] === pick.a &&
      events.b[last] === pick.b &&
      Math.abs(events.alpha[last] - pick.alpha) <= ALPHA_EPS;
    if (same) continue;
    events.slots[events.count] = n;
    events.a[events.count] = pick.a;
    events.b[events.count] = pick.b;
    events.alpha[events.count] = pick.alpha;
    events.count++;
  }
  return events;
}

/** The last event at or before slot (−1 before the first). */
export function eventAt(events: WarpEvents, slot: number): number {
  let lo = 0;
  let hi = events.count - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (events.slots[mid] <= slot) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** The listed frame a decoded timestamp is: the last i with times[i] <= ts + MATCH_EPS (0 when none). */
export function frameIndexAt(times: ArrayLike<number>, ts: number): number {
  return Math.max(0, floorIndex(times, ts + MATCH_EPS));
}

/** A reverse chunk: events [first, end) and the frames they need, `need` rising, all within [lo, hi]. */
export interface ReverseChunk {
  first: number;
  end: number;
  lo: number;
  hi: number;
  need: Int32Array;
}

/** What a reversed reader keeps at once: at most this many byte copies, and at most this much memory. */
export const REVERSE_CACHE_BYTES = 192 * 2 ** 20;
export const REVERSE_CACHE_FRAMES = 96;

/** The frames a reversed reader keeps at once for frames of this many bytes (at least 2, so a blend pair always fits). */
export function reverseChunkFrames(frameBytes: number): number {
  return Math.max(2, Math.min(REVERSE_CACHE_FRAMES, Math.floor(REVERSE_CACHE_BYTES / Math.max(1, frameBytes))));
}

/** The frames events [from, end) show, rising. */
function framesOf(events: WarpEvents, from: number, end: number): Set<number> {
  const need = new Set<number>();
  for (let e = from; e < end; e++) {
    need.add(events.a[e]);
    if (events.b[e] >= 0) need.add(events.b[e]);
  }
  return need;
}

/**
 * From event `from`: as many events as keep their frames (a, and b when set) within maxFrames. When more events follow
 * and a key frame k lies in (lo, hi], the chunk stops at the first event needing a frame below the lowest such k
 * (keeping at least one event): the GOP below is decoded whole by the next chunk instead of twice. keys: key frame
 * indices into times, rising.
 */
export function reverseChunk(events: WarpEvents, from: number, maxFrames: number, keys: ArrayLike<number>): ReverseChunk {
  const need = new Set<number>();
  let end = from;
  for (let e = from; e < events.count; e++) {
    const a = events.a[e];
    const b = events.b[e];
    const grown = need.size + (need.has(a) ? 0 : 1) + (b >= 0 && b !== a && !need.has(b) ? 1 : 0);
    if (need.size > 0 && grown > maxFrames) break;
    need.add(a);
    if (b >= 0) need.add(b);
    end = e + 1;
  }
  let frames = need;
  let lo = Math.min(...frames);
  let hi = Math.max(...frames);
  if (end < events.count) {
    let key = -1;
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] > lo && keys[i] <= hi) {
        key = keys[i];
        break;
      }
    }
    if (key >= 0) {
      let cut = end;
      for (let e = from; e < end; e++) {
        if (events.a[e] < key || (events.b[e] >= 0 && events.b[e] < key)) {
          cut = e;
          break;
        }
      }
      if (cut > from) {
        end = cut;
        frames = framesOf(events, from, end);
        lo = Math.min(...frames);
        hi = Math.max(...frames);
      }
    }
  }
  return { first: from, end, lo, hi, need: Int32Array.from([...frames].sort((x, y) => x - y)) };
}
