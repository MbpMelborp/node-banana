"use client";

import { dbToGain, gainToLevel } from "@/lib/stitch/curve";
import { curvePolyline, levelToY, type CurveMetrics, type CurveWindow } from "@/lib/stitch/curveGeometry";
import type { TimeAxis } from "@/lib/stitch/timeAxis";
import type { VolumePoint } from "@/types";
import type { CurveHover } from "./useCurveDrag";

/** −12 dB, drawn on the middle guide. */
const MINUS_12_LEVEL = gainToLevel(dbToGain(-12));

/**
 * An audio clip's volume curve over its block. Selected, the line in white
 * and a dot per point inside the clip's window (its In to its drawn end, in
 * its source seconds, drawn at sequence time t − offset). Not selected, it
 * is drawn only on the expanded row, as a faint line with no dots: at rest a
 * clip shows its waveform alone, as the boards do. Points outside the window
 * keep shaping the line to its ends, but are not drawn. A point at either
 * end of the window (a fade's) gets no dot, as on the boards: the block's
 * rounded edge would cut it in half. It still takes a press, and shows while
 * it is dragged or selected. Expanded, it adds the 0 dB and −12 dB guides,
 * the dragged point drawn larger and the dashed ghost where a click would
 * add one. It draws only; the box takes the pointer.
 */
export function CurveLayer({
  curve,
  axis,
  metrics,
  window,
  blockX,
  blockWidth,
  height,
  expanded,
  selected,
  dragIndex,
  selectedIndex,
  hover,
}: {
  curve: readonly VolumePoint[];
  axis: TimeAxis;
  metrics: CurveMetrics;
  window: CurveWindow;
  blockX: number;
  blockWidth: number;
  height: number;
  expanded: boolean;
  /** The clip is selected: the line in white, with its points. */
  selected: boolean;
  dragIndex: number | null;
  selectedIndex: number | null;
  hover: CurveHover | null;
}) {
  if (!selected && !expanded) return null;
  const poly = curvePolyline(curve, axis.total, axis, metrics, window).map((v) => ({ x: v.x - blockX, y: v.y }));
  if (poly.length === 0) return null;
  const line = poly.map((v) => `${v.x},${v.y}`).join(" ");
  const zeroDb = levelToY(0, metrics);
  const minus12 = levelToY(MINUS_12_LEVEL, metrics);

  return (
    <svg
      aria-hidden="true"
      data-testid="stitch-curve"
      className="pointer-events-none absolute inset-0 overflow-visible"
      width={blockWidth}
      height={height}
    >
      {expanded && (
        <g data-testid="stitch-db-guides" strokeWidth={1} strokeDasharray="3 3">
          <line x1={0} x2={blockWidth} y1={zeroDb + 0.5} y2={zeroDb + 0.5} className="stroke-white/10" />
          <line x1={0} x2={blockWidth} y1={minus12 + 0.5} y2={minus12 + 0.5} className="stroke-white/7" />
        </g>
      )}
      <polyline
        points={line}
        fill="none"
        strokeWidth={1.5}
        strokeLinejoin="round"
        className={selected ? "stroke-neutral-100" : "stroke-white/35"}
      />
      {(selected || dragIndex !== null) && curve.map((p, i) => {
        if (p.t < window.from || p.t > window.to) return null;
        const big = expanded && (i === dragIndex || (dragIndex === null && i === selectedIndex));
        if (!big && (p.t <= window.from || p.t >= window.to)) return null;
        return (
          <circle
            key={i}
            data-testid="stitch-curve-point"
            data-index={i}
            data-selected={i === selectedIndex || undefined}
            cx={axis.timeToX(p.t - window.offset) - blockX}
            cy={levelToY(gainToLevel(p.gain), metrics)}
            r={big ? 6 : 4}
            strokeWidth={2}
            className="fill-neutral-100 stroke-edit-clip"
          />
        );
      })}
      {hover && (
        <circle
          cx={hover.x - blockX}
          cy={hover.y}
          r={4}
          fill="none"
          strokeWidth={1.5}
          strokeDasharray="2 2"
          className="stroke-neutral-100/60"
        />
      )}
    </svg>
  );
}
