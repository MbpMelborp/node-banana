import { easing, type EasingFunction } from "./functions";

/**
 * A curve used to remap time: output progress → source progress on [0, 1], non-decreasing, 0 at 0 and 1 at 1, with
 * its slope. Every kind (a named easing, a bezier, points) compiles to one; compile once, call often.
 */
export interface RemapCurve {
  /** u is clamped to [0, 1]; NaN reads as 0. */
  readonly ease: EasingFunction;
  /** d ease / du at u (clamped), ≥ 0 and finite. */
  readonly slope: (u: number) => number;
}

/** The steepest slope a curve reports: Circ's ends and some beziers are vertical. */
export const MAX_SLOPE = 1e6;

/** NaN → 0, a fall → 0, +Infinity → MAX_SLOPE: rate maths must never see Infinity or NaN. */
export const clampSlope = (s: number): number => (Number.isNaN(s) ? 0 : Math.min(Math.max(s, 0), MAX_SLOPE));

/** Progress kept to [0, 1], NaN → 0: Math.min and Math.max pass NaN through. */
export const clamp01 = (u: number): number => (u > 0 ? (u < 1 ? u : 1) : 0);

/** How far from the diagonal a curve may be and still be the straight line: a bezier's handles, points' knots. */
export const IDENTITY_TOLERANCE = 1e-9;

export const LINEAR_CURVE: RemapCurve = { ease: (u) => clamp01(u), slope: () => 1 };

/**
 * Whether a named easing may remap time: an own key of `easing` (never "toString" or "constructor"). Every name in the
 * library is monotone non-decreasing with f(0) = 0 and f(1) = 1 (remap.test.ts asserts each one); a name added that is
 * not must be refused here.
 */
export function isMonotoneEasing(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(easing, name);
}

const SLOPE_STEP = 1e-4;
// Keeps the Expo family's end jumps (2^-10) out of the difference
const SLOPE_EDGE = 1e-9;

/** A named easing as a remap; null for a name isMonotoneEasing refuses. Never calls getEasingFunction (it warns). */
export function presetCurve(name: string): RemapCurve | null {
  if (!isMonotoneEasing(name)) return null;
  const f = easing[name as keyof typeof easing];
  return {
    // The named functions do not clamp: Circ is NaN outside [0, 1]
    ease: (u) => f(clamp01(u)),
    slope: (u) => {
      const x = clamp01(u);
      const a = Math.max(x - SLOPE_STEP, SLOPE_EDGE);
      const b = Math.min(x + SLOPE_STEP, 1 - SLOPE_EDGE);
      return clampSlope((f(b) - f(a)) / (b - a));
    },
  };
}

/**
 * The part [a, b] of a curve, stretched back to [0, 1]: (c(a + p(b − a)) − c(a)) / (c(b) − c(a)). null when the part
 * rises by 1e-9 or less (wholly inside a freeze) or b ≤ a. p ≤ 0 gives exactly 0, p ≥ 1 exactly 1.
 */
export function windowCurve(curve: RemapCurve, a: number, b: number): RemapCurve | null {
  const ca = curve.ease(a);
  const rise = curve.ease(b) - ca;
  const width = b - a;
  if (!(rise > 1e-9) || !(width > 0)) return null;
  return {
    ease: (p) => (p <= 0 ? 0 : p >= 1 ? 1 : clamp01((curve.ease(a + p * width) - ca) / rise)),
    slope: (p) => clampSlope((curve.slope(a + clamp01(p) * width) * width) / rise),
  };
}
