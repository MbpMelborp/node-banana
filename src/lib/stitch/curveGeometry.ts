import type { VolumePoint } from "@/types";
import { gainAt, gainToLevel, levelToGain } from "./curve";
import type { TimeAxis } from "./timeAxis";

/**
 * Where the music's volume curve is drawn in the audio lane, and what a
 * pointer there means. y runs down from the audio block's top: 0 dB at
 * `top`, −∞ at `top + span`, linear in display level (curve.ts), so the
 * straight segments drawn between vertices are exactly what is heard.
 * x is the lane's own (TimeAxis.timeToX), slots included: the line runs
 * flat across a clip with no length, which takes no time.
 *
 * Pure: no React, no DOM.
 */

export interface CurveMetrics {
  /** y of 0 dB, relative to the audio block's top. */
  top: number;
  /** Pixels from 0 dB down to −∞. */
  span: number;
}

/** The 48px block of the collapsed lane. */
export const COLLAPSED_CURVE: CurveMetrics = { top: 10, span: 31 };
/** The 120px block of the lane while the audio is selected. */
export const EXPANDED_CURVE: CurveMetrics = { top: 16, span: 90 };

export interface CurveVertex {
  x: number;
  y: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

export function levelToY(level: number, m: CurveMetrics): number {
  return m.top + clamp(Number.isFinite(level) ? level : 0, 0, 1) * m.span;
}

/** Clamped to 0..1: a pointer above the line's top is 0 dB, below its floor −∞. */
export function yToLevel(y: number, m: CurveMetrics): number {
  if (!Number.isFinite(y) || !(m.span > 0)) return 0;
  return clamp((y - m.top) / m.span, 0, 1);
}

/**
 * Vertices at x(0), at each point inside the sequence, at each slot's entry and exit (a flat run across the
 * slot), and at x(sequenceSec), in order. Points past the end are not drawn, but they still shape the line up to
 * the end (the last vertex reads gainAt there).
 */
export function curvePolyline(
  curve: readonly VolumePoint[],
  sequenceSec: number,
  axis: Pick<TimeAxis, "timeToX" | "slots">,
  m: CurveMetrics,
): CurveVertex[] {
  if (!(sequenceSec > 0) || !Number.isFinite(sequenceSec)) return [];
  const yAt = (t: number) => levelToY(gainToLevel(gainAt(curve, t)), m);
  const vertices: CurveVertex[] = [{ x: axis.timeToX(0), y: yAt(0) }];
  const inside = curve.filter((p) => p.t > 0 && p.t < sequenceSec);
  // A slot sits at one instant: its entry is timeToX(t), its exit that plus its width
  const slots = axis.slots.filter((s) => s.t < sequenceSec);
  let p = 0;
  for (const slot of slots) {
    while (p < inside.length && inside[p].t <= slot.t) {
      vertices.push({ x: axis.timeToX(inside[p].t), y: levelToY(gainToLevel(inside[p].gain), m) });
      p++;
    }
    const y = yAt(slot.t);
    vertices.push({ x: slot.x, y }, { x: slot.x + slot.width, y });
  }
  for (; p < inside.length; p++) {
    vertices.push({ x: axis.timeToX(inside[p].t), y: levelToY(gainToLevel(inside[p].gain), m) });
  }
  vertices.push({ x: axis.timeToX(sequenceSec), y: yAt(sequenceSec) });
  return vertices;
}

/** The shortest distance from p to the polyline's segments; Infinity for no vertices. */
export function distanceToPolyline(p: CurveVertex, poly: readonly CurveVertex[]): number {
  if (poly.length === 0) return Infinity;
  if (poly.length === 1) return Math.hypot(p.x - poly[0].x, p.y - poly[0].y);
  let best = Infinity;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1];
    const b = poly[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    const u = lengthSq === 0 ? 0 : clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq, 0, 1);
    best = Math.min(best, Math.hypot(p.x - (a.x + u * dx), p.y - (a.y + u * dy)));
  }
  return best;
}

/** The point a pointer at (x, y) means: t = clamp(xToTime(x), 0, seq), gain = levelToGain(yToLevel(y)). */
export function pointerToPoint(
  x: number,
  y: number,
  axis: Pick<TimeAxis, "xToTime">,
  m: CurveMetrics,
  sequenceSec: number,
): VolumePoint {
  const end = Number.isFinite(sequenceSec) && sequenceSec > 0 ? sequenceSec : 0;
  const t = axis.xToTime(x);
  return { t: clamp(Number.isFinite(t) ? t : 0, 0, end), gain: levelToGain(yToLevel(y, m)) };
}
