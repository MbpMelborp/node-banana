import type { EasingFunction } from "@/lib/easing";
import type { CurveVertex } from "./curveGeometry";

/**
 * Where a clip's time remap is drawn: output progress across (0 at the left, 1 at `width`), source progress up (1 at
 * `top`, 0 at `top + span`). The rail's ramp preview draws it. Pure: no React, no DOM.
 */

/** Where a time remap is drawn in its box: source progress 1 at `top`, 0 at `top + span`. */
export interface RemapMetrics {
  top: number;
  span: number;
}

const clamp01 = (value: number) => (value > 0 ? (value < 1 ? value : 1) : 0);

/** A box of this height: 12px clear over 1 and under 0 (120 → { 12, 96 }; 64 → { 12, 40 }). */
export const remapMetrics = (boxHeight: number): RemapMetrics => ({ top: 12, span: Math.max(0, boxHeight - 24) });

export const progressToY = (q: number, m: RemapMetrics): number => m.top + (1 - clamp01(q)) * m.span;

/** The drawn line: a vertex every 4px (16–512 of them) and one at each knot (output progress), box-local x. */
export function remapPolyline(
  fn: EasingFunction,
  width: number,
  m: RemapMetrics,
  knots: readonly number[] = [],
): CurveVertex[] {
  if (!(width > 0)) return [];
  const steps = Math.min(512, Math.max(16, Math.ceil(width / 4)));
  const xs = Array.from({ length: steps + 1 }, (_, k) => k / steps);
  for (const knot of knots) if (knot > 0 && knot < 1) xs.push(knot);
  xs.sort((a, b) => a - b);
  return xs
    .filter((p, i) => i === 0 || p !== xs[i - 1])
    .map((p) => ({ x: p * width, y: progressToY(fn(p), m) }));
}
