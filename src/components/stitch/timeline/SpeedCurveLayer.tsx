"use client";

import { useMemo } from "react";
import { POINT_HIT_PX } from "@/lib/stitch/curveModel";
import { progressToY, remapMetrics, remapPolyline } from "@/lib/stitch/remapGeometry";
import { editablePoints, warpCurve } from "@/lib/stitch/warp";
import type { ClipWarp } from "@/types";

/**
 * A video clip's speed curve over its box on a row open for it: the time
 * remap, the clip's output time across and its source progress up, so the
 * slope is the speed and the ends stay pinned to the clip's In and Out (a
 * reversed clip's line rises too: Reverse is the flag, its filmstrip runs
 * backwards). Under a dark wash over the frames, the dashed diagonal is the
 * clip at its average speed. Selected, the line is white, with a dot per
 * knot of a points curve over the whole clip (its pinned ends get none),
 * larger for the one dragged or that a press at the pointer would drag;
 * a preset, a bezier and a split piece's part of a ramp are a line only.
 * The single selected clip at rest takes presses on its knots through a hit
 * circle each, drawn above the trim handles and the sound buttons, so a knot
 * under a handle can still be dragged. It draws only; the box takes the
 * pointer.
 */
export function SpeedCurveLayer({
  warp,
  offsetX,
  width,
  height,
  selected,
  editable,
  pointIndex,
  hover,
}: {
  /** The warp as drawn: a drag's live one (IDENTITY_WARP for a clip at its own speed). */
  warp: ClipWarp;
  /** Box-local x of the clip's first frame, and the clip's width on the lane (the box may be inset at its joins). */
  offsetX: number;
  width: number;
  /** The box's height: the metrics are remapMetrics(height). */
  height: number;
  /** The single selected clip: the line in white, with its knots. */
  selected: boolean;
  /** The single selected clip at rest: the knots take presses. */
  editable: boolean;
  /** The knot dragged, or the one a press at the pointer would drag: drawn larger. */
  pointIndex: number | null;
  /** Where a drag would add a point, box-local. */
  hover: { x: number; y: number } | null;
}) {
  // The interior knots of a points curve over the whole clip: the ones a press can take
  const { m, knots, line } = useMemo(() => {
    const m = remapMetrics(height);
    const knots = editablePoints(warp)?.slice(1, -1) ?? [];
    const line = remapPolyline(
      warpCurve(warp.curve, warp.window).ease,
      width,
      m,
      knots.map(([p]) => p),
    )
      .map((v) => `${(v.x + offsetX).toFixed(1)},${v.y.toFixed(1)}`)
      .join(" ");
    return { m, knots, line };
  }, [warp, width, height, offsetX]);
  const dots = selected || pointIndex !== null ? knots : [];
  const at = ([p, q]: readonly [number, number]) => ({ cx: offsetX + p * width, cy: progressToY(q, m) });

  return (
    <>
      <div aria-hidden="true" data-testid="stitch-speed-wash" className="pointer-events-none absolute inset-0 bg-black/45" />
      <svg
        aria-hidden="true"
        data-testid="stitch-speed-curve"
        className="pointer-events-none absolute inset-0 overflow-visible"
        width="100%"
        height="100%"
      >
        <line
          data-testid="stitch-speed-guide"
          x1={offsetX}
          y1={progressToY(0, m)}
          x2={offsetX + width}
          y2={progressToY(1, m)}
          strokeWidth={1}
          strokeDasharray="3 3"
          className="stroke-white/10"
        />
        <polyline
          points={line}
          fill="none"
          strokeWidth={1.5}
          strokeLinejoin="round"
          className={selected ? "stroke-neutral-100" : "stroke-white/35"}
        />
        {dots.map((knot, k) => (
          <circle
            key={k}
            data-testid="stitch-speed-point"
            data-index={k + 1}
            {...at(knot)}
            r={k + 1 === pointIndex ? 6 : 4}
            strokeWidth={2}
            className="fill-neutral-100 stroke-pane"
          />
        ))}
        {hover && (
          <circle
            cx={hover.x}
            cy={hover.y}
            r={4}
            fill="none"
            strokeWidth={1.5}
            strokeDasharray="2 2"
            className="stroke-neutral-100/60"
          />
        )}
      </svg>
      {editable && knots.length > 0 && (
        <svg
          aria-hidden="true"
          data-testid="stitch-speed-hits"
          className="pointer-events-none absolute inset-0 z-3 overflow-visible"
          width="100%"
          height="100%"
        >
          {knots.map((knot, k) => (
            <circle
              key={k}
              data-speed-hit={k + 1}
              {...at(knot)}
              r={POINT_HIT_PX}
              fill="none"
              pointerEvents="all"
              className="cursor-grab"
            />
          ))}
        </svg>
      )}
    </>
  );
}
