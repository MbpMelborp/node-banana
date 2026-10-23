import type { EasingFunction } from "./functions";
import { clamp01, clampSlope, IDENTITY_TOLERANCE, MAX_SLOPE, type RemapCurve } from "./remap";

// Tight enough that the curve is monotone to 1e-9 and a warp's inverse can bisect its output
const SOLVE_EPS = 1e-10;

/** A CSS cubic-bezier as a remap. Each handle is clamped to [0, 1], so it never overshoots and never runs back. */
export function bezierCurve(handles: readonly [number, number, number, number]): RemapCurve {
  const x1 = clamp01(handles[0]);
  const y1 = clamp01(handles[1]);
  const x2 = clamp01(handles[2]);
  const y2 = clamp01(handles[3]);
  const cx = 3 * x1; const bx = 3 * (x2 - x1) - cx; const ax = 1 - cx - bx;
  const cy = 3 * y1; const by = 3 * (y2 - y1) - cy; const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const derivativeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  // The slope's derivatives from the handles' differences: exactly 0 at an end whose handle sits on it, and accurate
  // beside it, where the power form above leaves only rounding
  const tangent = (d0: number, d1: number, d2: number, t: number) => {
    const s = 1 - t;
    return 3 * (s * s * d0 + 2 * s * t * d1 + t * t * d2);
  };
  const slopeAlong = (dx: number, dy: number) => (dx > 0 ? clampSlope(dy / dx) : dy > 0 ? MAX_SLOPE : 1);
  // The curve parameter t with X(t) = x. Newton only while it stays inside [0, 1] (outside, the cubic has other
  // roots), then bisection; X is monotone with handles in [0, 1], and 64 halvings reach the float spacing, so the
  // loop always ends
  const solve = (x: number): number => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < SOLVE_EPS) return t;
      const d = derivativeX(t);
      if (Math.abs(d) < 1e-6) break;
      const next = t - err / d;
      if (!(next >= 0 && next <= 1)) break;
      t = next;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 64; i++) {
      const v = sampleX(t);
      if (Math.abs(v - x) < SOLVE_EPS) return t;
      if (v < x) lo = t; else hi = t;
      t = (lo + hi) / 2;
    }
    return t;
  };
  return {
    ease: (u) => sampleY(solve(clamp01(u))),
    slope: (u) => {
      const t = solve(clamp01(u));
      const dx = tangent(x1, x2 - x1, 1 - x2, t);
      const dy = tangent(y1, y2 - y1, 1 - y2, t);
      if (dx > 0 || dy > 0) return slopeAlong(dx, dy);
      // Both stand still only at an end whose handle sits on it, which the curve leaves towards the next handle off
      // it (along the diagonal when there is none), or inside a curve on the diagonal
      if (t <= 0) return slopeAlong(x2, y2);
      if (t >= 1) return slopeAlong(1 - x1, 1 - y1);
      return 1;
    },
  };
}

/**
 * Each handle, clamped as bezierCurve clamps it, within 1e-9 of the diagonal: the curve plays the straight line, so a
 * raw curve with finite handles and its sanitized form agree.
 */
export function isIdentityBezier(handles: readonly [number, number, number, number]): boolean {
  return (
    Math.abs(clamp01(handles[0]) - clamp01(handles[1])) <= IDENTITY_TOLERANCE &&
    Math.abs(clamp01(handles[2]) - clamp01(handles[3])) <= IDENTITY_TOLERANCE
  );
}

/** The Ease Curve node's solver: bezierCurve's ease, handles clamped to [0, 1], accurate to 1e-10 in x. */
export function createBezierEasing(p1x: number, p1y: number, p2x: number, p2y: number): EasingFunction {
  return bezierCurve([p1x, p1y, p2x, p2y]).ease;
}
