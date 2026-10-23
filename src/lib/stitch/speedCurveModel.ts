import {
  addRemapPoint,
  MAX_CURVE_POINTS,
  MIN_POINT_GAP,
  moveRemapPoint,
  type CurvePoint,
  type EasingFunction,
} from "@/lib/easing";
import type { ClipWarp } from "@/types";
import { POINT_HIT_PX, type CurveModel } from "./curveModel";
import type { CurveVertex } from "./curveGeometry";
import { pointerToRemap, progressToY, remapPolyline, type RemapMetrics } from "./remapGeometry";
import { editablePoints, pointsOfWarp, warpCurve } from "./warp";

/**
 * A video clip's speed curve on its open row, as the pointer gesture edits it: the time remap (output progress across
 * the clip, source progress up the box) of its warp, IDENTITY_WARP for a clip at its own speed. Only a points curve
 * over the whole clip has knots to press; its ends are pinned. On it, a press on the line within MIN_POINT_GAP of a
 * knot drags that knot (`takes`, so the hover shows that knot, not a point added). A drag on any other line (a preset,
 * a bezier, the straight line of a constant speed, a split piece's part of a ramp) first bakes it into points at the
 * clip's bake budget with a knot where it was pressed, which toPoints can miss beside a steep stretch or a vertical
 * tangent, and moves that knot. Within the gap of an end, or where one more knot would pass MAX_CURVE_POINTS, the
 * line takes no press (add refuses, hover has no ghost) and the box has it. A press on the line writes nothing until
 * it travels (addOnClick false): a knot added on the line re-derives its neighbours' tangents, so even one put exactly
 * on it moves the frames shown. A toggle or range press on it selects, as anywhere on the box. Pure: no React, no DOM.
 */

export interface SpeedCurveView {
  /** The clip's first frame in lane content x, and the clip's width on the lane, px. */
  x: number;
  width: number;
  metrics: RemapMetrics;
  /** The bake budget of a drag that turns the line into points: bakeError of the clip. */
  maxError: number;
}

/** The warp with a new points curve over the whole clip: a split piece's window goes. */
function withPoints(w: ClipWarp, points: ReadonlyArray<CurvePoint>): ClipWarp {
  const next: ClipWarp = { ...w, curve: { kind: "points", points: points.map(([x, y]): [number, number] => [x, y]) } };
  delete next.window;
  return next;
}

const eases = new WeakMap<ClipWarp, EasingFunction>();
/** The curve a warp plays, built once per warp object (a drag's moves build one each). */
function easeOf(w: ClipWarp): EasingFunction {
  let ease = eases.get(w);
  if (!ease) {
    ease = warpCurve(w.curve, w.window).ease;
    eases.set(w, ease);
  }
  return ease;
}

/**
 * A press on a points curve's line at output progress p: the knot it adds, or the one it takes within the gap (the
 * same array back); index -1 within the gap of an end, or where one more knot would pass MAX_CURVE_POINTS (a stored
 * curve the store would then drop).
 */
function addToPoints(
  points: ReadonlyArray<CurvePoint>,
  p: number,
): { points: ReadonlyArray<CurvePoint>; index: number } {
  const added = addRemapPoint(points, p);
  return added.points.length > MAX_CURVE_POINTS ? { points, index: -1 } : added;
}

/** Clear of the pinned ends' gap, where a knot can go on a line with none of its own. */
const clearOfEnds = (p: number) => p >= MIN_POINT_GAP && p <= 1 - MIN_POINT_GAP;

const lines = new WeakMap<ClipWarp, { key: string; line: CurveVertex[] }>();
/** The drawn line in lane content x, kept per warp for the view it was drawn in (the hover tests it every move). */
function lineOf(w: ClipWarp, view: SpeedCurveView): CurveVertex[] {
  const { x, width, metrics } = view;
  const key = `${x}|${width}|${metrics.top}|${metrics.span}`;
  const cached = lines.get(w);
  if (cached?.key === key) return cached.line;
  const knots = editablePoints(w)?.map(([p]) => p) ?? [];
  const line = remapPolyline(easeOf(w), width, metrics, knots).map((v) => ({ x: v.x + x, y: v.y }));
  lines.set(w, { key, line });
  return line;
}

export function speedCurveModel(view: SpeedCurveView): CurveModel<ClipWarp> {
  const { x: left, width, metrics: m, maxError } = view;
  const progressAt = (x: number) => (width > 0 ? Math.min(Math.max((x - left) / width, 0), 1) : 0);
  return {
    points: (w) =>
      editablePoints(w)
        ?.slice(1, -1)
        .map(([p, q], k) => ({ index: k + 1, x: left + p * width, y: progressToY(q, m) })) ?? [],
    line: (w) => lineOf(w, view),
    // A line press near a knot is a press on it (its double-click too) within the gap and POINT_HIT_PX of it: the gap
    // is output progress, 77px of a minute's clip at 64 px/s, and a double-click that far off would remove it
    nearPoint: (w, x) => {
      const points = editablePoints(w);
      if (!points || !(width > 0)) return -1;
      const p = (x - left) / width;
      let near = -1;
      let nearest = Math.min(MIN_POINT_GAP, POINT_HIT_PX / width);
      for (let i = 1; i < points.length - 1; i++) {
        const gap = Math.abs(points[i][0] - p);
        if (gap < nearest) {
          nearest = gap;
          near = i;
        }
      }
      return near;
    },
    takes: (w, x) => {
      const points = editablePoints(w);
      if (!points) return -1;
      const added = addToPoints(points, progressAt(x));
      return added.points === points ? added.index : -1;
    },
    add: (w, x) => {
      const p = progressAt(x);
      const own = editablePoints(w);
      if (own) {
        const added = addToPoints(own, p);
        if (added.index === -1) return { curve: w, index: -1 };
        return { curve: withPoints(w, added.points), index: added.index };
      }
      if (!clearOfEnds(p)) return { curve: w, index: -1 };
      // No hidden knot of the bake can take the press: the knot added is the one pressed
      const points = pointsOfWarp(w, maxError, p)?.points ?? [[0, 0], [p, p], [1, 1]];
      return { curve: withPoints(w, points), index: points.findIndex(([q]) => q === p) };
    },
    move: (base, index, x, y) => {
      const points = editablePoints(base);
      if (!points) return base;
      const [p, q] = pointerToRemap(x - left, y, width, m);
      return withPoints(base, moveRemapPoint(points, index, p, q));
    },
    centre: (w, index) => {
      const [p, q] = editablePoints(w)?.[index] ?? [0, 0];
      return { x: left + p * width, y: progressToY(q, m) };
    },
    hover: (w, x) => {
      const p = progressAt(x);
      const own = editablePoints(w);
      // Where a press adds a knot: never where it takes one or refuses, and no bake per move
      if (own ? addToPoints(own, p).points === own : !clearOfEnds(p)) return null;
      return { x: left + p * width, y: progressToY(easeOf(w)(p), m) };
    },
    addOnClick: false,
    modifiersSelect: true,
  };
}
