"use client";

import type { MouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { cn } from "@/components/nodes/ui/cn";
import { overlayFadeKnees } from "@/lib/stitch/overlays";
import type { TimeAxis } from "@/lib/stitch/timeAxis";
import { formatSeconds, formatTimecode } from "@/lib/stitch/timecode";
import type { StitchOverlay } from "@/types";
import { GEOMETRY, MOVING_CLIP, SELECTED_RING } from "../editorStyles";
import { EdgeHandle, handleWidthFor, keepFocus, LENGTH_CHIP } from "./ClipBox";

/** A layer's first line with any text in it, trimmed; null when it has none. */
export function overlayFirstLine(text: string): string | null {
  return text.split("\n").find((line) => line.trim() !== "")?.trim() ?? null;
}

/**
 * The opacity a layer is shown at, as ramps over its box: the part of the
 * box above the line it climbs at its start and falls at its end is lit
 * faintly, from the same corners the render's fades take (overlayFadeKnees),
 * so fades that overlap meet in one corner below the top.
 */
function FadeRamps({ overlay, axis, x, width }: { overlay: StitchOverlay; axis: TimeAxis; x: number; width: number }) {
  if (!(overlay.fadeInSec > 0) && !(overlay.fadeOutSec > 0)) return null;
  const height = GEOMETRY.overlayBlock;
  const { fadeInEnd, fadeOutStart, peak } = overlayFadeKnees(overlay);
  const inX = Math.min(width, Math.max(0, axis.timeToX(fadeInEnd) - x));
  const outX = Math.min(width, Math.max(inX, axis.timeToX(fadeOutStart) - x));
  const peakY = height * (1 - peak);
  return (
    <svg
      aria-hidden="true"
      data-testid="stitch-overlay-fades"
      className="pointer-events-none absolute inset-0"
      width={width}
      height={height}
    >
      <polygon
        points={`0,0 0,${height} ${inX},${peakY} ${outX},${peakY} ${width},${height} ${width},0`}
        className="fill-white/6"
      />
      {inX > 0 && (
        <line
          data-testid="stitch-overlay-fade-in"
          x1={0}
          y1={height}
          x2={inX}
          y2={peakY}
          strokeWidth={1}
          className="stroke-white/30"
        />
      )}
      {outX < width && (
        <line
          data-testid="stitch-overlay-fade-out"
          x1={outX}
          y1={peakY}
          x2={width}
          y2={height}
          strokeWidth={1}
          className="stroke-white/30"
        />
      )}
    </svg>
  );
}

/**
 * One text layer on its row: a 40px box on the edit-clip body holding the
 * first line of its text ("Empty text" when it has none), and its fades as
 * ramps at its ends. Selected (one of several too, or while an edge is
 * dragged) it is ringed in white. On hover: its length, and its start and
 * end handles. Past the sequence's last frame the box is hatched: that part
 * is not shown (unless there is no video at all, where there is no last
 * frame to pass). It is an option of the "Text layers" listbox; a press is
 * the box's (a click selects, a drag moves).
 */
export function OverlayClipBox({
  overlay,
  rowLabel,
  x,
  width,
  top,
  selected,
  multi,
  focusable,
  moving,
  trimEdge,
  axis,
  endX,
  onBodyPointerDown,
  onHandlePointerDown,
  onContextMenu,
}: {
  /** As drawn: a trim drag's live layer. */
  overlay: StitchOverlay;
  /** "Text 2". */
  rowLabel: string;
  /** In the rows' own box: lane x and the block's top. */
  x: number;
  width: number;
  top: number;
  selected: boolean;
  /** One of several selected: handles on hover only, as a trim acts on one layer. */
  multi: boolean;
  focusable: boolean;
  /** Carried by a body drag: raised, ringed, without its handles. */
  moving: boolean;
  /** The edge a trim drag holds on this layer. */
  trimEdge: "in" | "out" | null;
  axis: TimeAxis;
  /** The sequence's end on the lane: the box is hatched right of it; null with no video. */
  endX: number | null;
  onBodyPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  /** null while it is carried: no handles. */
  onHandlePointerDown: ((event: ReactPointerEvent<HTMLElement>, edge: "in" | "out") => void) | null;
  onContextMenu: (event: MouseEvent<HTMLElement>) => void;
}) {
  const line = overlayFirstLine(overlay.text);
  const hatchFrom = endX === null ? Infinity : Math.max(0, endX - x);
  const handleWidth = handleWidthFor(width);

  return (
    <div
      role="option"
      aria-selected={selected}
      aria-label={`${line ?? "Empty text"}, ${rowLabel}, starts ${formatTimecode(overlay.startSec)}`}
      title={line ? overlay.text : undefined}
      tabIndex={focusable ? 0 : -1}
      data-overlay-id={overlay.id}
      onPointerDown={onBodyPointerDown}
      onMouseDown={keepFocus}
      onContextMenu={onContextMenu}
      className={cn(
        "group absolute overflow-hidden rounded-md bg-edit-clip select-none outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-pane",
        moving && MOVING_CLIP,
      )}
      style={{ left: x, top, width, height: GEOMETRY.overlayBlock }}
    >
      <FadeRamps overlay={overlay} axis={axis} x={x} width={width} />
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-x-3 top-1/2 -translate-y-1/2 truncate text-[11px] leading-4",
          line ? "text-neutral-300" : "text-ink-3",
        )}
      >
        {line ?? "Empty text"}
      </span>
      {hatchFrom < width && (
        <div
          data-testid="stitch-overlay-after-end"
          title="After the last frame: not shown"
          className="absolute inset-y-0 right-0 editor-ghost-hatch opacity-60"
          style={{ left: hatchFrom }}
        />
      )}
      {(selected || trimEdge) && !moving && <span aria-hidden="true" data-selected-ring="" className={SELECTED_RING} />}
      <span
        className={cn(LENGTH_CHIP, trimEdge ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100")}
      >
        {formatSeconds(overlay.endSec - overlay.startSec, trimEdge ? 2 : 1)}
      </span>
      {onHandlePointerDown && !moving && (
        <>
          <EdgeHandle
            side="in"
            width={handleWidth}
            selected={selected && !multi}
            active={trimEdge === "in"}
            onPointerDown={(event) => onHandlePointerDown(event, "in")}
          />
          <EdgeHandle
            side="out"
            width={handleWidth}
            selected={selected && !multi}
            active={trimEdge === "out"}
            onPointerDown={(event) => onHandlePointerDown(event, "out")}
          />
        </>
      )}
    </div>
  );
}
