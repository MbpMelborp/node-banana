import type { EasingFunction } from "./functions";
import { clamp01, clampSlope, IDENTITY_TOLERANCE, MAX_SLOPE, type RemapCurve } from "./remap";

/**
 * A time remap drawn as points: a monotone cubic Hermite (Fritsch–Carlson) through them, the same arithmetic as the
 * ComfyUI tone curve (src/lib/comfy/curve.ts), with a time remap's rules: the ends are locked at (0, 0) and (1, 1)
 * and y never falls, so a flat run is a freeze and time never runs back.
 */

export type CurvePoint = readonly [number, number];

/** Knots closer than this on x read as one and cannot be dragged apart (comfy's value; output progress). */
export const MIN_POINT_GAP = 0.02;
/** A stored curve with more knots than this is not one the editor made (the gap allows 51). */
export const MAX_CURVE_POINTS = 64;
/** A knot nearer an end than this merges into it; nearer another knot, the later one is dropped. */
const SAME_X = 1e-6;

const isPair = (entry: unknown): entry is [number, number] =>
  Array.isArray(entry) &&
  entry.length === 2 &&
  typeof entry[0] === "number" &&
  typeof entry[1] === "number" &&
  Number.isFinite(entry[0]) &&
  Number.isFinite(entry[1]);

/**
 * A well-formed remap from whatever was stored: pairs of finite numbers clamped to [0, 1] and sorted by x, the ends
 * forced to (0, 0) and (1, 1), a knot within 1e-6 of another on x dropped (the first kept), y raised to never fall.
 * null for a value that is not an array, or more than MAX_CURVE_POINTS knots. Idempotent; always fresh arrays.
 */
export function normalizePoints(raw: unknown): Array<[number, number]> | null {
  if (!Array.isArray(raw)) return null;
  const pairs = (raw as unknown[])
    .filter(isPair)
    .map(([x, y]): [number, number] => [clamp01(x), clamp01(y)])
    .sort((a, b) => a[0] - b[0]);
  const points: Array<[number, number]> = [[0, 0]];
  for (const [x, y] of pairs) {
    if (x < SAME_X || x > 1 - SAME_X) continue;
    if (x - points[points.length - 1][0] >= SAME_X) points.push([x, y]);
  }
  points.push([1, 1]);
  let floor = 0;
  for (const point of points) {
    floor = Math.max(floor, point[1]);
    point[1] = floor;
  }
  points[points.length - 1][1] = 1;
  return points.length > MAX_CURVE_POINTS ? null : points;
}

/** Every knot within 1e-9 of the diagonal: the curve is the straight line (Fritsch–Carlson keeps it straight). */
export function isIdentityPoints(points: ReadonlyArray<CurvePoint>): boolean {
  return points.every(([x, y]) => Math.abs(y - x) <= IDENTITY_TOLERANCE);
}

/**
 * Tangents for a monotone cubic Hermite spline (Fritsch–Carlson), exactly as src/lib/comfy/curve.ts computes them:
 * the limiting step keeps each segment within its knots' y.
 */
function monotoneTangents(points: ReadonlyArray<CurvePoint>): number[] {
  const n = points.length;
  const secants: number[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    const dx = points[i + 1][0] - points[i][0];
    secants.push(dx === 0 ? 0 : (points[i + 1][1] - points[i][1]) / dx);
  }
  const tangents: number[] = new Array(n);
  tangents[0] = secants[0] ?? 0;
  tangents[n - 1] = secants[n - 2] ?? 0;
  for (let i = 1; i < n - 1; i += 1) {
    const a = secants[i - 1];
    const b = secants[i];
    tangents[i] = a * b <= 0 ? 0 : (a + b) / 2;
  }
  for (let i = 0; i < n - 1; i += 1) {
    const secant = secants[i];
    if (secant === 0) {
      tangents[i] = 0;
      tangents[i + 1] = 0;
      continue;
    }
    const alpha = tangents[i] / secant;
    const beta = tangents[i + 1] / secant;
    const magnitude = alpha * alpha + beta * beta;
    if (magnitude > 9) {
      const tau = 3 / Math.sqrt(magnitude);
      tangents[i] = tau * alpha * secant;
      tangents[i + 1] = tau * beta * secant;
    }
  }
  return tangents;
}

/** The curve through normalized points (normalizePoints' output); the tangents are computed once. */
export function pointsCurve(points: ReadonlyArray<CurvePoint>): RemapCurve {
  const n = points.length;
  const tangents = monotoneTangents(points);
  const first = points[0];
  const last = points[n - 1];
  // The last i in [0, n − 2] with points[i].x ≤ u
  const segment = (u: number): number => {
    let lo = 0;
    let hi = n - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (points[mid][0] <= u) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  return {
    ease: (value) => {
      const u = clamp01(value);
      if (u <= first[0]) return first[1];
      if (u >= last[0]) return last[1];
      const i = segment(u);
      const a = points[i];
      const b = points[i + 1];
      const h = b[0] - a[0];
      if (h === 0) return b[1];
      const t = (u - a[0]) / h;
      if (n === 2) return a[1] + t * (b[1] - a[1]);
      const t2 = t * t;
      const t3 = t2 * t;
      return (
        (2 * t3 - 3 * t2 + 1) * a[1] +
        (t3 - 2 * t2 + t) * h * tangents[i] +
        (-2 * t3 + 3 * t2) * b[1] +
        (t3 - t2) * h * tangents[i + 1]
      );
    },
    slope: (value) => {
      const u = clamp01(value);
      const i = segment(u);
      const a = points[i];
      const b = points[i + 1];
      const h = b[0] - a[0];
      if (h === 0) return MAX_SLOPE;
      if (n === 2) return clampSlope((b[1] - a[1]) / h);
      const s = (u - a[0]) / h;
      const s2 = s * s;
      return clampSlope(
        ((6 * s2 - 6 * s) * a[1] +
          (3 * s2 - 4 * s + 1) * h * tangents[i] +
          (-6 * s2 + 6 * s) * b[1] +
          (3 * s2 - 2 * s) * h * tangents[i + 1]) /
          h,
      );
    },
  };
}

/** The knot nearest x on x; the earlier of two as near. */
function nearestKnot(points: ReadonlyArray<CurvePoint>, x: number): number {
  let nearest = 0;
  for (let i = 1; i < points.length; i++) {
    if (Math.abs(points[i][0] - x) < Math.abs(points[nearest][0] - x)) nearest = i;
  }
  return nearest;
}

/**
 * A knot at x, at y (on the curve when omitted), held between its neighbours' y. Within MIN_POINT_GAP of an interior
 * knot it takes that knot instead ({ points: the same array, index: that knot }); within the gap of an end, or for a
 * non-finite x, nothing ({ points: the same array, index: −1 }). The nearest knot decides.
 */
export function addRemapPoint(
  points: ReadonlyArray<CurvePoint>,
  x: number,
  y?: number,
): { points: ReadonlyArray<CurvePoint>; index: number } {
  if (!Number.isFinite(x)) return { points, index: -1 };
  const at = clamp01(x);
  const nearest = nearestKnot(points, at);
  if (Math.abs(points[nearest][0] - at) < MIN_POINT_GAP) {
    const isEnd = nearest === 0 || nearest === points.length - 1;
    return { points, index: isEnd ? -1 : nearest };
  }
  const index = points.findIndex(([px]) => px > at);
  const wanted = y !== undefined && Number.isFinite(y) ? y : pointsCurve(points).ease(at);
  const knot: [number, number] = [at, Math.min(Math.max(wanted, points[index - 1][1]), points[index][1])];
  return { points: [...points.slice(0, index), knot, ...points.slice(index)], index };
}

/**
 * Move an interior knot: x kept MIN_POINT_GAP from both neighbours (left as it is when that range is empty, which only
 * a crowded stored curve has), y held between the neighbours' y. The ends never move; a non-finite x or y keeps the
 * knot's.
 */
export function moveRemapPoint(
  points: ReadonlyArray<CurvePoint>,
  index: number,
  x: number,
  y: number,
): ReadonlyArray<CurvePoint> {
  if (!Number.isInteger(index) || index <= 0 || index >= points.length - 1) return points;
  const [px, py] = points[index];
  const before = points[index - 1];
  const after = points[index + 1];
  const lower = before[0] + MIN_POINT_GAP;
  const upper = after[0] - MIN_POINT_GAP;
  const nextX = Number.isFinite(x) && lower <= upper ? Math.min(Math.max(x, lower), upper) : px;
  const nextY = Number.isFinite(y) ? Math.min(Math.max(y, before[1]), after[1]) : py;
  if (nextX === px && nextY === py) return points;
  return points.map((point, i): CurvePoint => (i === index ? [nextX, nextY] : point));
}

/** Remove an interior knot; the ends are permanent. */
export function removeRemapPoint(points: ReadonlyArray<CurvePoint>, index: number): ReadonlyArray<CurvePoint> {
  if (!Number.isInteger(index) || index <= 0 || index >= points.length - 1) return points;
  return points.filter((_, i) => i !== index);
}

const BAKE_GRID = 512;

/**
 * Knots whose curve follows f vertically (source progress at the same output time), added greedily on a 512-step grid:
 * each round adds the grid point with the largest error that is at least MIN_POINT_GAP from every knot, until every
 * such point is within maxError or the knots run out (16, or 64 when seeded; a seed's knots are kept). Within a knot's
 * gap no knot can go, so the error there may stay above maxError, with knots to spare, and the more so the steeper f
 * is there: about 4× at the 0.002 floor for Expo, Quint and the hybrids; 0.01–0.04 beside a stretch steeper than
 * about 5 (a steep bezier end or inflection, one random bezier in twenty); and lossy at a vertical tangent, at an end
 * or inside, which the curve cannot follow (the Circ family about 0.05, a bezier with a handle on or near the box's
 * left or right edge up to about 0.3). About 0.3 ms: call it once per press or bake, never per pointer move.
 */
export function toPoints(
  f: EasingFunction,
  maxError = 0.01,
  opts: { seed?: ReadonlyArray<CurvePoint>; maxPoints?: number } = {},
): Array<[number, number]> {
  const maxPoints = Math.min(opts.maxPoints ?? (opts.seed ? MAX_CURVE_POINTS : 16), MAX_CURVE_POINTS);
  let points = normalizePoints(opts.seed ?? []) ?? normalizePoints([])!;
  const target = Array.from({ length: BAKE_GRID + 1 }, (_, i) => clamp01(f(i / BAKE_GRID)));
  for (;;) {
    const ease = pointsCurve(points).ease;
    let worst = 0;
    let best = -1;
    let bestError = 0;
    let knot = 0;
    for (let i = 0; i <= BAKE_GRID; i++) {
      const x = i / BAKE_GRID;
      const error = Math.abs(ease(x) - target[i]);
      worst = Math.max(worst, error);
      while (knot < points.length - 1 && points[knot + 1][0] <= x) knot++;
      const clear =
        x - points[knot][0] >= MIN_POINT_GAP && (knot + 1 >= points.length || points[knot + 1][0] - x >= MIN_POINT_GAP);
      if (i > 0 && i < BAKE_GRID && clear && error > bestError) {
        best = i;
        bestError = error;
      }
    }
    if (worst <= maxError || points.length >= maxPoints || best < 0 || bestError <= maxError) return points;
    points = normalizePoints([...points, [best / BAKE_GRID, target[best]]])!;
  }
}
