import type { ClipWarp, ClipWarpCurve } from "@/types";
import {
  DEFAULT_CUSTOM_BEZIER,
  getAllEasingNames,
  getEasingBezier,
  isIdentityPoints,
  isMonotoneEasing,
  toPoints,
} from "@/lib/easing";
import { isWindowed, pointsOfWarp, warpCurve } from "./warp";

/**
 * The rail's Ramp picker: which of its four modes a stored ramp shows as, and the ramp a press on a mode writes.
 * Pure.
 */

export type RampMode = "none" | "preset" | "bezier" | "points";

/** The preset a mode switch starts from when there is none to keep: the Ease Curve node's own default. */
export const DEFAULT_RAMP = "easeInOutSine";

/** The names the Preset grid offers, in the library's order: every one that may remap time but linear (None). */
export const RAMP_PRESETS: readonly string[] = getAllEasingNames().filter(
  (name) => name !== "linear" && isMonotoneEasing(name),
);

/** What the picker shows: none for constant speed; a split piece (a window) is a drawn curve, points. */
export function rampModeOf(curve: ClipWarpCurve | null, window?: readonly [number, number]): RampMode {
  if (curve === null) return "none";
  return isWindowed(window) ? "points" : curve.kind;
}

/**
 * The curve played, over the whole clip, as points within maxError (a points curve unwindowed: its own knots). One that
 * never strays maxError from the diagonal would bake to the straight line, which stores as no ramp: that bake starts
 * from the knot that strays most, so Points stays a ramp, and goes on to maxError (one knot alone misses the other half
 * of an S by more than the straight line does).
 */
function bake(curve: ClipWarpCurve, window: readonly [number, number] | undefined, maxError: number): ClipWarpCurve {
  const warp: ClipWarp = {
    speed: 1,
    curve,
    ...(isWindowed(window) ? { window: [window[0], window[1]] } : {}),
    reverse: false,
    blend: false,
  };
  const baked = pointsOfWarp(warp, maxError);
  if (!baked) return curve;
  if (!isIdentityPoints(baked.points)) return baked;
  const ease = warpCurve(curve, window).ease;
  return { kind: "points", points: toPoints(ease, maxError, { seed: toPoints(ease, 0, { maxPoints: 3 }) }) };
}

/**
 * The curve a press on `mode` writes, from the stored curve and window (the action drops the window). Preset keeps a
 * preset's name, else starts from DEFAULT_RAMP; Bezier keeps a bezier's handles, takes a preset's bezier, else the
 * default bezier; Points bakes what plays (DEFAULT_RAMP from None) within maxError. Pressing a mode a curve already
 * shows as gives the curve back.
 */
export function seedRamp(
  mode: RampMode,
  curve: ClipWarpCurve | null,
  window?: readonly [number, number],
  maxError = 0.01,
): ClipWarpCurve | null {
  switch (mode) {
    case "none":
      return null;
    case "preset":
      return { kind: "preset", name: curve?.kind === "preset" ? curve.name : DEFAULT_RAMP };
    case "bezier":
      if (curve?.kind === "bezier") return { kind: "bezier", handles: [...curve.handles] };
      return {
        kind: "bezier",
        handles: curve?.kind === "preset" ? getEasingBezier(curve.name) : [...DEFAULT_CUSTOM_BEZIER],
      };
    case "points":
      return bake(curve ?? { kind: "preset", name: DEFAULT_RAMP }, curve ? window : undefined, maxError);
  }
}
