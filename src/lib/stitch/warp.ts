import type { ClipWarp, ClipWarpCurve } from "@/types";
import {
  bezierCurve,
  isIdentityBezier,
  isIdentityPoints,
  isMonotoneEasing,
  LINEAR_CURVE,
  MIN_POINT_GAP,
  normalizePoints,
  pointsCurve,
  presetCurve,
  toPoints,
  windowCurve,
  type RemapCurve,
} from "@/lib/easing";

/**
 * A clip's warp: its speed, ramp, reverse and blend, and the map from output time to source time they make.
 *
 * Pure: no React, no DOM, no mediabunny, and nothing from the rest of the timeline maths (timeline.ts imports this;
 * the server runs it through sanitizeTimeline). Source times are the clip's source seconds; an offset is output
 * seconds from the clip's start on the timeline. The curve maps output progress to source progress over the whole
 * clip; a split piece plays a window of it, stretched back to [0, 1], so both pieces keep the picture.
 */

/** What the rail sets. */
export const MIN_SPEED = 0.1;
export const MAX_SPEED = 10;
/**
 * What a stored warp may hold. Far outside any edit: a split piece of a ramp keeps its picture only at its exact
 * average speed, which near a slow end can be very small; the range only bounds crafted values.
 */
export const MIN_STORED_SPEED = 1e-9;
export const MAX_STORED_SPEED = 1e9;
/** A constant speed outside these leaves the clip's own sound out; a ramp keeps it. */
export const SOUND_MIN_SPEED = 0.25;
export const SOUND_MAX_SPEED = 4;
/** The warp that changes nothing, for code that reads a clip's warp with a default. Never stored. */
export const IDENTITY_WARP: Readonly<ClipWarp> = Object.freeze({ speed: 1, curve: null, reverse: false, blend: false });

/** A split piece shows more source than this, or the ramp stands still there. */
const MIN_PIECE_SOURCE_SEC = 1e-6;
/** isPieceOfWarp's relative tolerance on the root speed: a piece's speed loses digits far into a long source. */
const PIECE_TOLERANCE = 1e-6;
const BAKE_MIN_ERROR = 0.002;
const BAKE_MAX_ERROR = 0.01;
const BAKE_DEFAULT_FPS = 30;

/** A clip's source range with Out resolved: 0 ≤ inSec ≤ outSec. */
export interface SourceRange {
  inSec: number;
  outSec: number;
}

/**
 * One piece of a split: its source range and warp (the identity only if the piece changes nothing, which a canonical
 * ramp never gives; store it through withWarp, which drops it).
 */
export interface WarpPiece {
  range: SourceRange;
  warp: ClipWarp;
}

/** NaN → lo. */
const clamp = (value: number, lo: number, hi: number) => (value > lo ? (value < hi ? value : hi) : lo);
const clamp01 = (value: number) => clamp(value, 0, 1);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** A curve within 1e-9 of the diagonal: preset linear; a bezier with each handle on it; points all on it. */
export function isIdentityWarpCurve(curve: ClipWarpCurve): boolean {
  switch (curve.kind) {
    case "preset":
      return curve.name === "linear";
    case "bezier":
      return isIdentityBezier(curve.handles);
    case "points":
      return isIdentityPoints(curve.points);
  }
}

/** A warp that changes something: speed ≠ 1, a ramp that is not the straight line, or reversed. */
export function isWarped(warp: ClipWarp | null | undefined): warp is ClipWarp {
  return (
    warp != null &&
    (warp.speed !== 1 || (warp.curve != null && !isIdentityWarpCurve(warp.curve)) || warp.reverse === true)
  );
}

/** The warp every engine and editor path branches on: null when absent or the identity. */
export function activeWarp(clip: { warp?: ClipWarp }): ClipWarp | null {
  return isWarped(clip.warp) ? clip.warp : null;
}

/** The same kind and the same name, handles or knots, number for number. */
export function sameWarpCurve(a: ClipWarpCurve | null, b: ClipWarpCurve | null): boolean {
  if (a === null || b === null) return a === b;
  switch (a.kind) {
    case "preset":
      return b.kind === "preset" && a.name === b.name;
    case "bezier":
      return b.kind === "bezier" && a.handles.every((value, i) => value === b.handles[i]);
    case "points":
      return (
        b.kind === "points" &&
        a.points.length === b.points.length &&
        a.points.every(([x, y], i) => x === b.points[i][0] && y === b.points[i][1])
      );
  }
}

const sameWindow = (a: readonly [number, number] | undefined, b: readonly [number, number] | undefined) => {
  const [a0, a1] = a ?? [0, 1];
  const [b0, b1] = b ?? [0, 1];
  return a0 === b0 && a1 === b1;
};

/** Structural, numbers exact; absent ≡ the identity; the window counts only with a ramp (absent ≡ [0, 1]). */
export function sameWarp(a: ClipWarp | null | undefined, b: ClipWarp | null | undefined): boolean {
  const x = isWarped(a) ? a : undefined;
  const y = isWarped(b) ? b : undefined;
  if (!x || !y) return !x && !y;
  return (
    x.speed === y.speed &&
    x.reverse === y.reverse &&
    x.blend === y.blend &&
    sameWarpCurve(x.curve, y.curve) &&
    (x.curve === null || sameWindow(x.window, y.window))
  );
}

/** The render leaves the clip's own sound out: a constant speed above SOUND_MAX_SPEED or below SOUND_MIN_SPEED. */
export function dropsSound(warp: ClipWarp | null | undefined): boolean {
  return isWarped(warp) && warp.curve === null && (warp.speed > SOUND_MAX_SPEED || warp.speed < SOUND_MIN_SPEED);
}

/** A curve kind's remap. A stored curve is canonical; a preset name the library refuses plays straight. */
function curveOf(curve: ClipWarpCurve): RemapCurve {
  switch (curve.kind) {
    case "preset":
      return presetCurve(curve.name) ?? LINEAR_CURVE;
    case "bezier":
      return bezierCurve(curve.handles);
    case "points":
      return pointsCurve(curve.points);
  }
}

/** The canonical curve, or null for none or the straight line. Fresh objects; key `kind` first. */
function normalizeCurve(curve: ClipWarpCurve): ClipWarpCurve | null {
  switch (curve.kind) {
    case "preset":
      return typeof curve.name === "string" && isMonotoneEasing(curve.name) && curve.name !== "linear"
        ? { kind: "preset", name: curve.name }
        : null;
    case "bezier": {
      if (!Array.isArray(curve.handles) || curve.handles.length !== 4 || !curve.handles.every(finite)) return null;
      const handles = curve.handles.map(clamp01) as [number, number, number, number];
      const bezier: ClipWarpCurve = { kind: "bezier", handles };
      return isIdentityWarpCurve(bezier) ? null : bezier;
    }
    case "points": {
      const points = normalizePoints(curve.points);
      return !points || isIdentityPoints(points) ? null : { kind: "points", points };
    }
    default:
      return null;
  }
}

/**
 * The window a canonical curve keeps: absent for none, [0, 1], or one that is not two finite numbers; and absent where
 * the curve does not rise across it (b ≤ a, or inside a freeze). No width rule: Split's narrowest windows must survive.
 */
function normalizeWindow(
  window: readonly [number, number] | undefined,
  curve: ClipWarpCurve,
): [number, number] | undefined {
  if (!Array.isArray(window) || window.length !== 2 || !finite(window[0]) || !finite(window[1])) return undefined;
  const a = clamp01(window[0]);
  const b = clamp01(window[1]);
  if (a === 0 && b === 1) return undefined;
  return windowCurve(curveOf(curve), a, b) === null ? undefined : [a, b];
}

/**
 * The canonical warp, or undefined when it changes nothing (blend alone at 1× changes nothing). Every writer builds
 * through it or sanitizeWarp, so every stored warp is a fixed point of both. Always fresh objects; keys in the order
 * speed, curve, window, reverse, blend.
 */
export function normalizeWarp(warp: ClipWarp): ClipWarp | undefined {
  const speed = Number.isFinite(warp.speed) ? clamp(warp.speed, MIN_STORED_SPEED, MAX_STORED_SPEED) : 1;
  const curve = warp.curve ? normalizeCurve(warp.curve) : null;
  const window = curve ? normalizeWindow(warp.window, curve) : undefined;
  const reverse = warp.reverse === true;
  const blend = warp.blend === true;
  if (speed === 1 && curve === null && !reverse) return undefined;
  return { speed, curve, ...(window ? { window } : {}), reverse, blend };
}

function readCurve(raw: unknown): ClipWarpCurve | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const curve = raw as Record<string, unknown>;
  if (curve.kind === "preset" && typeof curve.name === "string") return { kind: "preset", name: curve.name };
  if (curve.kind === "bezier" && Array.isArray(curve.handles) && curve.handles.length === 4) {
    // Finiteness is normalizeCurve's
    return { kind: "bezier", handles: curve.handles as [number, number, number, number] };
  }
  if (curve.kind === "points" && Array.isArray(curve.points)) {
    // Each entry is normalizePoints'
    return { kind: "points", points: curve.points as Array<[number, number]> };
  }
  return null;
}

/** Whatever was stored → a canonical warp, or undefined. */
export function sanitizeWarp(raw: unknown): ClipWarp | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const warp = raw as Record<string, unknown>;
  return normalizeWarp({
    speed: typeof warp.speed === "number" ? warp.speed : Number.NaN,
    curve: readCurve(warp.curve),
    ...(Array.isArray(warp.window) ? { window: warp.window as [number, number] } : {}),
    reverse: warp.reverse === true,
    blend: warp.blend === true,
  });
}

function cloneCurve(curve: ClipWarpCurve): ClipWarpCurve {
  switch (curve.kind) {
    case "preset":
      return { kind: "preset", name: curve.name };
    case "bezier":
      return { kind: "bezier", handles: [...curve.handles] };
    case "points":
      return { kind: "points", points: curve.points.map(([x, y]): [number, number] => [x, y]) };
  }
}

/** A deep copy: nothing shared with the warp given. */
export function cloneWarp(warp: ClipWarp): ClipWarp {
  return {
    speed: warp.speed,
    curve: warp.curve ? cloneCurve(warp.curve) : null,
    ...(warp.window ? { window: [warp.window[0], warp.window[1]] } : {}),
    reverse: warp.reverse,
    blend: warp.blend,
  };
}

/**
 * The item with this warp: { ...item, warp } when it changes something (a key it had keeps its place, a new one goes
 * last); otherwise the item without the key, or the item itself when it has none. The warp must be canonical
 * (normalizeWarp, sanitizeWarp or a split piece). Every edit that sets or clears a clip's warp writes it here; the
 * carriers that copy a clip field by field (sanitizeTimeline, readClip, copyItems, pasteIntoTimeline, clipTrim,
 * fetchClipBlobs) spread a warp already sanitized or found active, and createClip keeps init.warp as given.
 */
export function withWarp<T extends { warp?: ClipWarp }>(item: T, warp: ClipWarp | null | undefined): T {
  if (isWarped(warp)) return { ...item, warp };
  if (!("warp" in item)) return item;
  const next = { ...item };
  delete next.warp;
  return next;
}

/**
 * The curve a clip plays: output progress → source progress over the clip. Straight for none; the kind's curve; or,
 * with a window, its part [a, b] stretched back to [0, 1] (straight for a window inside a freeze, which no canonical
 * warp holds).
 */
export function warpCurve(curve: ClipWarpCurve | null, window?: readonly [number, number]): RemapCurve {
  if (curve === null) return LINEAR_CURVE;
  const base = curveOf(curve);
  if (!window || (window[0] === 0 && window[1] === 1)) return base;
  return windowCurve(base, window[0], window[1]) ?? LINEAR_CURVE;
}

/** The output length of a source length: len / speed under an active warp; exactly len without one. */
export function warpedLength(sourceLength: number, warp: ClipWarp | null | undefined): number {
  return isWarped(warp) ? sourceLength / warp.speed : sourceLength;
}

/** An active warp over a source range: where the clip is in its source at each moment, and back. */
export interface WarpMap {
  readonly range: Readonly<SourceRange>;
  /** Never the identity: maps exist for active warps only. */
  readonly warp: ClipWarp;
  /** (outSec − inSec) / speed: bit for bit warpedLength(outSec − inSec, warp). */
  readonly length: number;
  /**
   * Source seconds at output offset o (clamped to [0, length]), inside the range: exactly the end shown first (forward
   * In, reversed Out) at 0, and the other end at length.
   */
  sourceTimeAt(offset: number): number;
  /** The earliest offset that shows sourceSec (clamped to the range): a freeze maps to its first offset. */
  offsetAt(sourceSec: number): number;
  /** The momentary rate at o: speed × the curve's slope; ≥ 0 and finite (reverse is the flag). */
  speedAt(offset: number): number;
}

/**
 * An active warp's map. Only for activeWarp(...): an unwarped clip keeps its plain arithmetic and never gets one.
 * Its functions are closures (safe to pass detached) and the map is frozen, since callers cache and share it.
 * Compile one per clip, never inside a per-sample loop.
 */
export function warpMap(range: SourceRange, warp: ClipWarp): WarpMap {
  const { inSec, outSec } = range;
  const { speed, reverse } = warp;
  const len = Math.max(0, outSec - inSec);
  const length = len / speed;
  const startEnd = reverse ? outSec : inSec;
  const finishEnd = reverse ? inSec : outSec;
  const inRange = (sourceSec: number) => Math.min(outSec, Math.max(inSec, sourceSec));
  const base = { range: Object.freeze({ inSec, outSec }), warp, length };

  if (warp.curve === null) {
    // Constant: analytic, so a round trip through offsetAt is exact
    return Object.freeze({
      ...base,
      sourceTimeAt: (offset: number) => {
        if (!(offset > 0)) return startEnd;
        if (offset >= length) return finishEnd;
        return inRange(reverse ? outSec - offset * speed : inSec + offset * speed);
      },
      offsetAt: (sourceSec: number) => clamp(reverse ? outSec - sourceSec : sourceSec - inSec, 0, len) / speed,
      speedAt: () => speed,
    });
  }

  const curve = warpCurve(warp.curve, warp.window);
  const progress = (offset: number) => (length > 0 && offset > 0 ? Math.min(offset / length, 1) : 0);
  return Object.freeze({
    ...base,
    sourceTimeAt: (offset: number) => {
      const p = progress(offset);
      if (p <= 0) return startEnd;
      if (p >= 1) return finishEnd;
      const q = curve.ease(p) * len;
      return inRange(reverse ? outSec - q : inSec + q);
    },
    offsetAt: (sourceSec: number) => {
      if (!(len > 0)) return 0;
      const q = clamp01((reverse ? outSec - sourceSec : sourceSec - inSec) / len);
      if (curve.ease(0) >= q) return 0;
      // The smallest p with ease(p) ≥ q: the curve never falls, so a freeze answers with its first offset
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 52; i++) {
        const mid = (lo + hi) / 2;
        if (curve.ease(mid) >= q) hi = mid;
        else lo = mid;
      }
      return hi * length;
    },
    speedAt: (offset: number) => speed * curve.slope(progress(offset)),
  });
}

interface Cut {
  at: number;
  first: SourceRange;
  second: SourceRange;
  /** Each piece's window and average speed; null for a constant warp: its pieces keep its speed, with no window. */
  ramp: { windows: [[number, number], [number, number]]; speeds: [number, number] } | null;
}

/** Where a split at offset falls, or null when it cannot: splitWarp and canSplitWarp share it, so they agree. */
function cut(range: SourceRange, warp: ClipWarp, offset: number): Cut | null {
  const map = warpMap(range, warp);
  if (!(offset > 0 && offset < map.length)) return null;
  const at = map.sourceTimeAt(offset);
  const first = warp.reverse ? { inSec: at, outSec: range.outSec } : { inSec: range.inSec, outSec: at };
  const second = warp.reverse ? { inSec: range.inSec, outSec: at } : { inSec: at, outSec: range.outSec };
  const firstLength = first.outSec - first.inSec;
  const secondLength = second.outSec - second.inSec;
  if (!(firstLength > MIN_PIECE_SOURCE_SEC) || !(secondLength > MIN_PIECE_SOURCE_SEC)) return null;
  if (warp.curve === null) return { at, first, second, ramp: null };
  const [a, b] = warp.window ?? [0, 1];
  const m = a + (offset / map.length) * (b - a);
  // Each piece's average speed is exactly what keeps its picture
  const speeds: [number, number] = [firstLength / offset, secondLength / (map.length - offset)];
  if (speeds.some((s) => !(s >= MIN_STORED_SPEED && s <= MAX_STORED_SPEED))) return null;
  const base = curveOf(warp.curve);
  // A piece wholly inside a freeze has no window to play
  if (windowCurve(base, a, m) === null || windowCurve(base, m, b) === null) return null;
  return { at, first, second, ramp: { windows: [[a, m], [m, b]], speeds } };
}

/**
 * Split at output offset o (0 < o < length) so both pieces keep the picture: each keeps the curve, reverse and blend,
 * plays its part of the ramp as its window, at the average speed that part had. The first piece is the one shown
 * first (reversed, the source's end). null when it cannot: at or past an end, a piece with 1e-6 s of source or less, a
 * piece inside a freeze, or a speed outside the stored range. `warp` is canonical and active.
 */
export function splitWarp(
  range: SourceRange,
  warp: ClipWarp,
  offset: number,
): { at: number; first: WarpPiece; second: WarpPiece } | null {
  const c = cut(range, warp, offset);
  if (!c) return null;
  const { ramp } = c;
  const piece = (i: 0 | 1): ClipWarp => {
    if (!ramp) return cloneWarp(warp);
    // A copy of the identity: IDENTITY_WARP is frozen
    return normalizeWarp({ ...warp, speed: ramp.speeds[i], window: ramp.windows[i] }) ?? { ...IDENTITY_WARP };
  };
  return { at: c.at, first: { range: c.first, warp: piece(0) }, second: { range: c.second, warp: piece(1) } };
}

/** Whether splitWarp would split, without building the pieces. */
export function canSplitWarp(range: SourceRange, warp: ClipWarp, offset: number): boolean {
  return cut(range, warp, offset) !== null;
}

/**
 * Whether `now` is `was` or a piece Split cut from it: the same curve, reverse and blend, a window inside was's, and
 * the same root speed (the unwindowed ramp's) to 1e-6 relative. The discard sheet's only use: a split is not a speed
 * change.
 */
export function isPieceOfWarp(was: ClipWarp | null | undefined, now: ClipWarp | null | undefined): boolean {
  if (sameWarp(was, now)) return true;
  if (!isWarped(was) || !isWarped(now) || was.curve === null || now.curve === null) return false;
  if (!sameWarpCurve(was.curve, now.curve) || was.reverse !== now.reverse || was.blend !== now.blend) return false;
  const [a, b] = was.window ?? [0, 1];
  const [c, d] = now.window ?? [0, 1];
  if (c < a - 1e-12 || d > b + 1e-12) return false;
  const base = curveOf(was.curve);
  const root = (w: ClipWarp) => {
    const [x, y] = w.window ?? [0, 1];
    return (w.speed * (y - x)) / (base.ease(y) - base.ease(x));
  };
  return Math.abs(root(now) - root(was)) <= PIECE_TOLERANCE * root(was);
}

/**
 * The stored field a box side trims: the head (left handle) is the In and the tail the Out, swapped on a reversed
 * clip, whose head shows its Out.
 */
export function trimField(clip: { warp?: ClipWarp }, side: "in" | "out"): "inSec" | "outSec" {
  return (side === "in") !== (activeWarp(clip)?.reverse === true) ? "inSec" : "outSec";
}

/** The least source length a clip may keep: minOutputSec of output at its speed; exactly minOutputSec unwarped. */
export function minSourceLength(warp: ClipWarp | null | undefined, minOutputSec: number): number {
  return isWarped(warp) ? minOutputSec * warp.speed : minOutputSec;
}

/**
 * The most source an edit may give a clip slower than 1×, so it never plays longer than maxOutputSec: maxOutputSec ×
 * speed. Infinity at 1× or faster and unwarped. A clip already holding more may only shrink: the caller bounds by
 * max(this, the clip's source length now).
 */
export function maxSourceLength(warp: ClipWarp | null | undefined, maxOutputSec: number): number {
  return isWarped(warp) && warp.speed < 1 ? maxOutputSec * warp.speed : Infinity;
}

/**
 * The budget a bake aims for (source progress; toPoints says where it can stay above it): half a source frame of the
 * clip's source range, kept to [0.002, 0.01], so a short clip bakes within about a frame and a long one into few
 * enough knots to edit. A missing fps reads as 30; a length that is not positive gives 0.01.
 */
export function bakeError(sourceSec: number, fps: number | null | undefined): number {
  if (!(sourceSec > 0)) return BAKE_MAX_ERROR;
  const rate = finite(fps) && fps > 0 ? fps : BAKE_DEFAULT_FPS;
  return clamp(1 / (2 * rate * sourceSec), BAKE_MIN_ERROR, BAKE_MAX_ERROR);
}

/**
 * The clip's ramp as points over the whole clip, for editing it as points: null without a ramp; an unwindowed points
 * curve's own knots (copied); else the curve it plays, baked by toPoints to maxError, seeded with a points curve's own
 * knots that fall inside its window (those within MIN_POINT_GAP of a new end dropped, as no knot may sit there). The
 * caller stores it as a new curve, which drops the window.
 */
export function pointsOfWarp(
  warp: ClipWarp | null | undefined,
  maxError = 0.01,
): { kind: "points"; points: Array<[number, number]> } | null {
  if (!isWarped(warp) || warp.curve === null) return null;
  const { curve, window } = warp;
  if (curve.kind === "points" && !window) {
    return { kind: "points", points: curve.points.map(([x, y]): [number, number] => [x, y]) };
  }
  const played = warpCurve(curve, window);
  if (curve.kind !== "points" || !window) return { kind: "points", points: toPoints(played.ease, maxError) };
  const [a, b] = window;
  const base = curveOf(curve);
  const ca = base.ease(a);
  const rise = base.ease(b) - ca;
  const seed = curve.points
    .map(([x, y]): [number, number] => [(x - a) / (b - a), (y - ca) / rise])
    .filter(([x]) => x >= MIN_POINT_GAP && x <= 1 - MIN_POINT_GAP);
  return { kind: "points", points: toPoints(played.ease, maxError, { seed: [[0, 0], ...seed, [1, 1]] }) };
}
