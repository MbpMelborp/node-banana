import type { RefObject } from "react";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import type { RemapMetrics } from "@/lib/stitch/remapGeometry";
import { speedCurveModel } from "@/lib/stitch/speedCurveModel";
import { IDENTITY_WARP } from "@/lib/stitch/warp";
import type { ClipWarp } from "@/types";
import { removeClipWarpPoint, setClipCurve } from "../speedActions";
import { useCurveGesture } from "./useCurveGesture";

/**
 * Editing a video clip's speed curve on its open row: useCurveGesture with the speed curve's model. A drag on the line
 * adds a point where it was pressed (turning a preset or bezier into points first) and moves it; a drag on a knot, or
 * on the line near one, moves that knot; a double-click on a knot removes it. Each is one undo step, written through setClipCurve (a split piece's window goes, and a straight
 * line left is no ramp). Its knots are not selectable.
 */
export function useSpeedCurveDrag({
  clipId,
  x,
  width,
  metrics,
  maxError,
  contentRef,
  blockRef,
  editable,
}: {
  clipId: string;
  /** The clip's first frame in lane content x, and its width on the lane, px. */
  x: number;
  width: number;
  metrics: RemapMetrics;
  /** The bake budget of a drag that turns a preset or bezier into points. */
  maxError: number;
  contentRef: RefObject<HTMLDivElement | null>;
  blockRef: RefObject<HTMLDivElement | null>;
  editable: boolean;
}) {
  return useCurveGesture<ClipWarp>({
    model: speedCurveModel({ x, width, metrics, maxError }),
    contentRef,
    blockRef,
    editable,
    read: () => {
      const clip = useStitchEditorStore.getState().draft?.timeline.find((c) => c.id === clipId);
      return clip ? (clip.warp ?? IDENTITY_WARP) : undefined;
    },
    write: (warp) => setClipCurve(clipId, warp.curve),
    removePoint: (index) => removeClipWarpPoint(clipId, index),
  });
}
