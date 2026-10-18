"use client";

import { useRef, type MouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { Plus, VolumeX } from "lucide-react";
import { cn } from "@/components/nodes/ui/cn";
import { audioSelectionOf, useStitchEditorStore } from "@/store/stitchEditorStore";
import { useStitchWaveform } from "@/hooks/useStitchWaveform";
import { formatDb, gainToLevel } from "@/lib/stitch/curve";
import { COLLAPSED_CURVE, EXPANDED_CURVE, levelToY, type CurveWindow } from "@/lib/stitch/curveGeometry";
import type { TimeAxis } from "@/lib/stitch/timeAxis";
import { formatSeconds, formatTimecode } from "@/lib/stitch/timecode";
import type { StitchAudioClip } from "@/types";
import { removeAudioCurvePoint, setAudioCurve } from "../editorActions";
import { EDITOR_CHIP, GEOMETRY, LABEL_BAR, MOVING_CLIP } from "../editorStyles";
import type { AudioClipView } from "../useStitchEditorMedia";
import { EdgeHandle, handleWidthFor, keepFocus } from "./ClipBox";
import { CurveLayer } from "./CurveLayer";
import { useCurveDrag } from "./useCurveDrag";
import { Waveform } from "./Waveform";

/** Room a chip beside a point needs before it would pass the visible lanes' right side; it goes left of the point then. */
const CHIP_ROOM = 130;

/** What a box says instead of its file name when it has nothing to play. */
function stateLabel(view: AudioClipView | undefined): string | null {
  if (!view) return null;
  if (view.missing) return "Not in the library";
  if (view.status === "empty") return "No audio connected";
  if (view.status === "error") return "Can't read this audio";
  return null;
}

/**
 * One audio clip on its row: the waveform of the part it plays, its volume
 * curve over it (editable when it is the single selection on an expanded
 * row, drawn only otherwise), the label bar with the file name, the source
 * and the length, and the In and Out handles once the file's length is
 * known. A muted clip keeps a faint waveform and a "Muted" chip instead of
 * the curve. Past the sequence's last frame the box is hatched: that part
 * is not heard. Music that is not connected, a library file that is gone and
 * a file that cannot be read are drawn dashed and say so.
 *
 * It is an option of the "Audio clips" listbox. A press on the curve is the
 * curve's (useCurveDrag); any other press is the box's (a click selects, a
 * drag moves).
 */
export function AudioClipBox({
  clip,
  start,
  length,
  view,
  rowLabel,
  x,
  width,
  top,
  expanded,
  selected,
  multi,
  focusable,
  editable,
  selectedPoint,
  moving,
  trimEdge,
  axis,
  endX,
  viewLeft,
  viewRight,
  visibleRight,
  contentWidth,
  contentRef,
  onBodyPointerDown,
  onHandlePointerDown,
  onContextMenu,
}: {
  /** As drawn: a trim drag's live clip. */
  clip: StitchAudioClip;
  /** Where its In plays as drawn, sequence seconds. */
  start: number;
  /** Its drawn length in seconds; 0 while unknown (the box is then a fixed width). */
  length: number;
  view: AudioClipView | undefined;
  /** "Audio 2". */
  rowLabel: string;
  /** In the row's own box: lane x and the block's top in its row. */
  x: number;
  width: number;
  top: number;
  expanded: boolean;
  selected: boolean;
  /** One of several selected: handles on hover only, as a trim acts on one clip. */
  multi: boolean;
  focusable: boolean;
  /** The single selection on an expanded row, unmuted: its curve takes presses. */
  editable: boolean;
  selectedPoint: number | null;
  /** Carried by a body drag: raised, ringed, without its handles. */
  moving: boolean;
  /** The edge a trim drag holds on this clip. */
  trimEdge: "in" | "out" | null;
  axis: TimeAxis;
  /** The sequence's end on the lane: the box is hatched right of it. */
  endX: number;
  viewLeft: number;
  viewRight: number;
  visibleRight: number;
  contentWidth: number;
  contentRef: RefObject<HTMLDivElement | null>;
  onBodyPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  /** null while the length is unknown: no handles. */
  onHandlePointerDown: ((event: ReactPointerEvent<HTMLElement>, edge: "in" | "out") => void) | null;
  onContextMenu: (event: MouseEvent<HTMLElement>) => void;
}) {
  const blockRef = useRef<HTMLDivElement>(null);
  const waveform = useStitchWaveform(view?.status === "ready" ? view.src : null);
  const height = expanded ? GEOMETRY.audioBlockExpanded : GEOMETRY.audioBlock;
  const metrics = expanded ? EXPANDED_CURVE : COLLAPSED_CURVE;
  const offset = clip.inSec - start;
  const curveWindow: CurveWindow = { offset, from: clip.inSec, to: clip.inSec + length };
  const drag = useCurveDrag({
    axis,
    metrics,
    curveWindow,
    contentRef,
    blockRef,
    editable,
    read: () => useStitchEditorStore.getState().draft?.audioClips.find((c) => c.id === clip.id)?.curve,
    write: (curve) => setAudioCurve(clip.id, curve),
    selectPoint: (point) => useStitchEditorStore.getState().select(audioSelectionOf({ clipId: clip.id }, point, true)),
    removePoint: (index) => removeAudioCurvePoint(clip.id, index),
  });

  const label = stateLabel(view);
  const fileName = view?.fileName ?? "Audio";
  const broken = view?.missing || view?.status === "error";
  const dashed = label !== null;
  const muted = clip.muted;
  const handlesShown = (selected && !multi) || trimEdge !== null;
  const handleWidth = handleWidthFor(width);
  const hatchFrom = Math.max(0, endX - x);
  const shown = drag.live?.curve ?? clip.curve;

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.onPointerDown(event)) return;
    onBodyPointerDown(event);
  };

  // The readout follows the dragged point; the hint follows the ghost
  const dragged = drag.live && drag.live.index !== null ? drag.live.curve[drag.live.index] : null;
  const readout = dragged
    ? { x: axis.timeToX(dragged.t - offset), y: top + levelToY(gainToLevel(dragged.gain), metrics), point: dragged }
    : null;
  const hint = drag.hover ? { x: drag.hover.x, y: top + drag.hover.y } : null;
  const beside = (at: number, gap: number) =>
    at + gap + CHIP_ROOM > Math.min(contentWidth, visibleRight) ? { right: `calc(100% - ${at - gap}px)` } : { left: at + gap };

  return (
    <>
      <div
        ref={blockRef}
        role="option"
        aria-selected={selected}
        aria-label={`${label ?? fileName}, ${rowLabel}, starts ${formatTimecode(clip.startSec)}${muted ? ", muted" : ""}`}
        tabIndex={focusable ? 0 : -1}
        data-audio-clip-id={clip.id}
        onPointerDown={onPointerDown}
        onPointerMove={drag.onPointerMove}
        onPointerLeave={drag.onPointerLeave}
        onDoubleClick={drag.onDoubleClick}
        onMouseDown={keepFocus}
        onContextMenu={onContextMenu}
        className={cn(
          "group absolute overflow-hidden rounded-media select-none outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70",
          dashed
            ? cn("border border-dashed", broken ? "border-red-400/40" : "border-handle-audio/30")
            : muted
              ? "bg-handle-audio/4"
              : "bg-handle-audio/8",
          moving
            ? MOVING_CLIP
            : selected || trimEdge
              ? "ring-2 ring-selection"
              : dashed
                ? undefined
                : cn("ring-1", muted ? "ring-handle-audio/15" : "ring-handle-audio/35"),
          editable &&
            (drag.live ? "cursor-grabbing" : drag.overPoint ? "cursor-grab" : drag.hover ? "cursor-pointer" : undefined),
        )}
        style={{ left: x, top, width, height }}
      >
        {!dashed && waveform?.status === "ready" && waveform.peaks && waveform.duration !== null && (
          <div className={cn("absolute inset-0", muted && "opacity-35")}>
            <Waveform
              peaks={waveform.peaks}
              duration={waveform.duration}
              axis={axis}
              blockX={x}
              blockWidth={width}
              height={height}
              expanded={expanded}
              viewLeft={viewLeft}
              viewRight={viewRight}
              sourceOffset={offset}
            />
          </div>
        )}
        {muted ? (
          <span
            data-testid="stitch-audio-muted"
            className="pointer-events-none absolute left-2 top-3.5 inline-flex items-center gap-1.5 rounded-[5px] bg-black/50 px-1.5 py-0.5 text-[10px] text-neutral-400"
          >
            <VolumeX size={11} strokeWidth={2} />
            Muted
          </span>
        ) : (
          length > 0 &&
          !dashed && (
            <CurveLayer
              curve={shown}
              axis={axis}
              metrics={metrics}
              window={curveWindow}
              blockX={x}
              blockWidth={width}
              height={height}
              expanded={expanded}
              dragIndex={drag.live?.index ?? null}
              selectedIndex={editable ? selectedPoint : null}
              hover={drag.hover}
            />
          )
        )}
        {hatchFrom < width && (
          <div
            data-testid="stitch-audio-after-end"
            title="After the last frame: not heard"
            className="absolute inset-y-0 right-0 editor-ghost-hatch opacity-60"
            style={{ left: hatchFrom }}
          />
        )}
        {/* Over the curve, as the boards draw it: the line's floor runs inside the label bar */}
        <div
          className={cn(
            "pointer-events-none absolute bottom-0 flex items-center gap-1.5 px-2 text-[11px] leading-none",
            LABEL_BAR,
            handlesShown ? "left-2.5 right-2.5" : "left-0 right-0",
          )}
          style={{ height: GEOMETRY.labelBar }}
        >
          <span className={cn("truncate font-medium", label ? "text-neutral-400" : "text-neutral-100")}>
            {label ?? fileName}
          </span>
          {/* On a short box the source label gives way before the file name */}
          {!label && <span className="min-w-0 shrink-[1000] truncate text-neutral-400">{view?.sourceLabel ?? ""}</span>}
          {length > 0 && (
            <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-neutral-300">
              {formatSeconds(length, trimEdge ? 2 : 1)}
            </span>
          )}
        </div>
        {onHandlePointerDown && !moving && (
          <>
            <EdgeHandle
              side="in"
              width={handleWidth}
              selected={handlesShown}
              active={trimEdge === "in"}
              onPointerDown={(event) => onHandlePointerDown(event, "in")}
            />
            <EdgeHandle
              side="out"
              width={handleWidth}
              selected={handlesShown}
              active={trimEdge === "out"}
              onPointerDown={(event) => onHandlePointerDown(event, "out")}
            />
          </>
        )}
      </div>

      {readout && (
        <div
          aria-hidden="true"
          data-testid="stitch-curve-readout"
          className={cn(EDITOR_CHIP, "pointer-events-none absolute z-4 inline-flex -translate-y-1/2 items-center gap-2 whitespace-nowrap font-mono tabular-nums")}
          style={{ top: readout.y, ...beside(readout.x, 12) }}
        >
          <span className="text-neutral-200">{formatDb(readout.point.gain)}</span>
          <span className="text-neutral-500">{formatTimecode(readout.point.t - offset)}</span>
        </div>
      )}
      {hint && !drag.live && (
        <div
          aria-hidden="true"
          data-testid="stitch-add-point"
          className={cn(
            EDITOR_CHIP,
            "pointer-events-none absolute z-4 inline-flex -translate-y-full items-center gap-[5px] whitespace-nowrap px-[7px] py-[3px] text-neutral-300",
          )}
          style={{ top: hint.y - 4, ...beside(hint.x, 6) }}
        >
          <Plus size={10} strokeWidth={2.25} />
          Add point
        </div>
      )}
    </>
  );
}
