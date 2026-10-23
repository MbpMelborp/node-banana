import type { RefObject } from "react";
import { volumeCurveModel } from "@/lib/stitch/curveModel";
import type { CurveMetrics, CurveWindow } from "@/lib/stitch/curveGeometry";
import type { TimeAxis } from "@/lib/stitch/timeAxis";
import type { VolumePoint } from "@/types";
import { useCurveGesture } from "./useCurveGesture";

/**
 * Editing an audio clip's volume curve, on the single selected clip of an
 * expanded row: useCurveGesture with the volume curve's model. A press on a
 * point drags it (its neighbours bound it); a press on the line adds a point
 * there and drags that; ⌥ held at the press moves the whole line up or down.
 * Times are the clip's source seconds, drawn through its window.
 */

export type { CurveHover } from "./useCurveGesture";

interface CurveDragOptions {
  axis: TimeAxis;
  metrics: CurveMetrics;
  /** The clip's part of its curve and where it is drawn. */
  curveWindow: CurveWindow;
  /** The lane content (pointer x is measured from its left) and the audio block (y from its top). */
  contentRef: RefObject<HTMLDivElement | null>;
  blockRef: RefObject<HTMLDivElement | null>;
  /** Off unless the clip is the single selection on an expanded row, unmuted: every press is the box's. */
  editable: boolean;
  /** The curve as the draft holds it now; undefined once the clip is gone. */
  read: () => readonly VolumePoint[] | undefined;
  /** One gesture's result, as one undo step. */
  write: (curve: VolumePoint[]) => void;
  /** The clip selected with this curve point (null: none), its last press on the curve. */
  selectPoint: (point: number | null) => void;
  /** A double-click on a point takes it off. */
  removePoint: (index: number) => void;
}

export function useCurveDrag(options: CurveDragOptions) {
  const { axis, metrics, curveWindow, write, ...rest } = options;
  return useCurveGesture<readonly VolumePoint[]>({
    ...rest,
    // A write only ever follows an addPoint, movePoint or offsetCurve result: the copy is of a fresh array
    write: (curve) => write([...curve]),
    model: volumeCurveModel(axis, metrics, curveWindow),
  });
}
