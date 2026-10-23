import type { VolumePoint } from "@/types";
import { addPoint, gainAt, gainToLevel, MIN_POINT_GAP_SEC, movePoint, offsetCurve } from "./curve";
import {
  curvePolyline,
  distanceToPolyline,
  levelToY,
  pointerToPoint,
  type CurveMetrics,
  type CurveVertex,
  type CurveWindow,
} from "./curveGeometry";
import type { TimeAxis } from "./timeAxis";

/**
 * One curve edited on the timeline, as the pointer gesture sees it (useCurveGesture): its points and line on screen,
 * and what a press, a drag and a double-click do to it. An audio clip's volume curve and a video clip's speed curve
 * are two of them. x is the lane content's, y the box's own. Pure: no React, no DOM.
 */

/** A press this close to a point's centre takes the point. */
export const POINT_HIT_PX = 7;
/** A press this close to the line adds a point on it. */
export const LINE_HIT_PX = 6;

export interface CurveModel<C> {
  /** The points a press can take, by index into the curve. */
  points(curve: C): ReadonlyArray<{ index: number; x: number; y: number }>;
  line(curve: C): readonly CurveVertex[];
  /** A press on the line close to a point in the curve's own units takes it; -1: none. */
  nearPoint(curve: C, x: number, y: number): number;
  /**
   * Further off on the line, the point a press at x drags instead of adding one (add returns it): it shows as the
   * point's own press, its double-click excepted. -1 or absent: none.
   */
  takes?: (curve: C, x: number) => number;
  /** A point added on the line under x (on the line, not at the pointer's y), or taken there: its curve and index; -1 refused. */
  add(curve: C, x: number, y: number): { curve: C; index: number };
  /** `base` with point `index` centred at (x, y), the curve's own rules applied. */
  move(base: C, index: number, x: number, y: number): C;
  centre(curve: C, index: number): { x: number; y: number };
  /** The hover ghost for a pointer at x over the line (x clamped to the line's extent); null where add refuses or takes. */
  hover(curve: C, x: number): { x: number; y: number } | null;
  /** ⌥ at the press moves the whole line by dy px; absent: ⌥ changes nothing. */
  shift?: (start: C, dy: number) => C;
  /** Whether a line press with no travel writes its added point (the volume curve's, true); false: only a drag does. */
  addOnClick: boolean;
}

export type CurveHit = { kind: "point"; index: number } | { kind: "line" } | { kind: "none" };

/** The nearest point within POINT_HIT_PX (a later one wins a tie), else the line within LINE_HIT_PX, then nearPoint. */
export function hitCurve<C>(model: CurveModel<C>, curve: C, x: number, y: number): CurveHit {
  let index = -1;
  let best = POINT_HIT_PX;
  for (const p of model.points(curve)) {
    const d = Math.hypot(p.x - x, p.y - y);
    if (d <= best) {
      best = d;
      index = p.index;
    }
  }
  if (index !== -1) return { kind: "point", index };
  if (distanceToPolyline({ x, y }, model.line(curve)) > LINE_HIT_PX) return { kind: "none" };
  const near = model.nearPoint(curve, x, y);
  return near === -1 ? { kind: "line" } : { kind: "point", index: near };
}

const inWindow = (t: number, w: CurveWindow) => t >= w.from && t <= w.to;

/**
 * An audio clip's volume curve: its points in source seconds, drawn through the clip's window at sequence time
 * t − offset. On the line, a point closer in time than MIN_POINT_GAP_SEC is the hit: adding one there would replace it
 * (an instant step's two points, drawn as a tall vertical segment, would both go). A click on the line adds a point;
 * ⌥ moves the whole line.
 */
export function volumeCurveModel(axis: TimeAxis, m: CurveMetrics, w: CurveWindow): CurveModel<readonly VolumePoint[]> {
  const at = (x: number, y: number) => pointerToPoint(x, y, axis, m, axis.total, w);
  const centre = (p: VolumePoint) => ({ x: axis.timeToX(p.t - w.offset), y: levelToY(gainToLevel(p.gain), m) });
  return {
    points: (curve) => curve.flatMap((p, index) => (inWindow(p.t, w) ? [{ index, ...centre(p) }] : [])),
    line: (curve) => curvePolyline(curve, axis.total, axis, m, w),
    nearPoint: (curve, x, y) => {
      const t = at(x, y).t;
      let near = -1;
      let nearest = MIN_POINT_GAP_SEC;
      curve.forEach((p, i) => {
        const gap = Math.abs(p.t - t);
        if (inWindow(p.t, w) && gap < nearest) {
          nearest = gap;
          near = i;
        }
      });
      return near;
    },
    add: (curve, x, y) => addPoint(curve, at(x, y).t),
    move: (base, index, x, y) => {
      const point = at(x, y);
      return movePoint(base, index, point.t, point.gain);
    },
    centre: (curve, index) => centre(curve[index]),
    hover: (curve, x) => {
      const clamped = Math.min(Math.max(x, axis.timeToX(w.from - w.offset)), axis.timeToX(w.to - w.offset));
      return { x: clamped, y: levelToY(gainToLevel(gainAt(curve, axis.xToTime(clamped) + w.offset)), m) };
    },
    shift: (start, dy) => offsetCurve(start, dy / m.span, w.to),
    addOnClick: true,
  };
}
