"use client";

import { useRef, type KeyboardEvent, type RefObject } from "react";
import { Plus, VolumeX } from "lucide-react";
import { cn } from "@/components/nodes/ui/cn";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { useStitchWaveform } from "@/hooks/useStitchWaveform";
import { formatDb, gainToLevel } from "@/lib/stitch/curve";
import { COLLAPSED_CURVE, EXPANDED_CURVE, levelToY } from "@/lib/stitch/curveGeometry";
import type { TimeAxis } from "@/lib/stitch/timeAxis";
import { formatTimecode } from "@/lib/stitch/timecode";
import type { VolumePoint } from "@/types";
import { EDITOR_CHIP, GEOMETRY } from "../editorStyles";
import type { MusicView } from "../useStitchEditorMedia";
import { CurveLayer } from "./CurveLayer";
import { useCurveDrag } from "./useCurveDrag";
import { Waveform } from "./Waveform";

/** Room a chip beside a point needs before it would pass the visible lanes' right side; it goes left of the point then. */
const CHIP_ROOM = 130;
/** The "Connect audio to the node" box is never narrower than its copy. */
const CONNECT_MIN_WIDTH = 180;

function LabelBar({ music }: { music: MusicView }) {
  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-linear-to-t from-black/60 to-transparent px-2 text-[11px] leading-none"
      style={{ height: GEOMETRY.labelBar }}
    >
      <span className="truncate font-medium text-neutral-100">{music.fileName}</span>
      <span className="shrink-0 text-neutral-400">{music.sourceLabel}</span>
    </div>
  );
}

/**
 * The audio row under the clips: the music as a block over one loop of the
 * sequence, with its waveform, its volume curve and its file name. Clicking
 * the block selects the track, which grows the row (and the timeline) to
 * show dB guides and makes the curve editable (useCurveDrag); selecting a
 * clip collapses it again. A muted track keeps a faint waveform and no
 * curve. With nothing connected the row says so; with music but no timed
 * clips it holds a placeholder the length of the lane.
 */
export function AudioLane({
  axis,
  music,
  curve,
  muted,
  expanded,
  viewLeft,
  viewRight,
  visibleRight,
  contentWidth,
  contentRef,
}: {
  axis: TimeAxis;
  music: MusicView | null;
  curve: readonly VolumePoint[];
  muted: boolean;
  expanded: boolean;
  viewLeft: number;
  viewRight: number;
  /** The visible lanes' right side on the content (scroll plus width): chips flip before it. */
  visibleRight: number;
  /** The lane content's width. */
  contentWidth: number;
  contentRef: RefObject<HTMLDivElement | null>;
}) {
  const blockRef = useRef<HTMLDivElement>(null);
  const selectedPoint = useStitchEditorStore((s) => (s.selection?.kind === "audio" ? s.selection.point : null));
  const waveform = useStitchWaveform(music?.src ?? null);
  const metrics = expanded ? EXPANDED_CURVE : COLLAPSED_CURVE;
  const drag = useCurveDrag({ axis, metrics, contentRef, blockRef, editable: expanded && !muted });

  const rowHeight = expanded ? GEOMETRY.audioRowExpanded : GEOMETRY.audioRow;
  const blockHeight = expanded ? GEOMETRY.audioBlockExpanded : GEOMETRY.audioBlock;
  const blockTop = GEOMETRY.audioBlockTop;
  const blockX = axis.timeToX(0);
  const blockWidth = Math.max(0, axis.timeToX(axis.total) - blockX);
  const rowStyle = { top: GEOMETRY.ruler + GEOMETRY.clipRow, height: rowHeight };

  const toLaneEnd = Math.max(0, contentWidth - GEOMETRY.origin - GEOMETRY.endMargin);
  if (!music) {
    const width = axis.total > 0 ? Math.min(Math.max(blockWidth, CONNECT_MIN_WIDTH), toLaneEnd) : toLaneEnd;
    return (
      <div data-testid="stitch-audio-row" className="absolute inset-x-0 border-b border-white/6" style={rowStyle}>
        <div
          className="absolute flex items-center justify-center gap-1.5 overflow-hidden whitespace-nowrap rounded-media border border-dashed border-handle-audio/40 bg-handle-audio/3 text-[11px] text-neutral-500"
          style={{ left: GEOMETRY.origin, top: blockTop, width, height: GEOMETRY.audioBlock }}
        >
          <Plus size={12} strokeWidth={2} className="shrink-0 text-handle-audio" />
          Connect audio to the node
        </div>
      </div>
    );
  }

  if (!(axis.total > 0)) {
    // Nothing timed to lay the music under: a placeholder with its name, not selectable
    return (
      <div data-testid="stitch-audio-row" className="absolute inset-x-0 border-b border-white/6" style={rowStyle}>
        <div
          data-testid="stitch-audio-placeholder"
          className="absolute overflow-hidden rounded-media border border-dashed border-handle-audio/30"
          style={{
            left: GEOMETRY.origin,
            top: blockTop,
            width: toLaneEnd,
            height: GEOMETRY.audioBlock,
          }}
        >
          <LabelBar music={music} />
        </div>
      </div>
    );
  }

  const shown = drag.live?.curve ?? curve;
  const select = () => useStitchEditorStore.getState().select({ kind: "audio", point: null });
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    select();
  };

  // The readout follows the dragged point; the hint follows the ghost
  const dragged = drag.live && drag.live.index !== null ? drag.live.curve[drag.live.index] : null;
  const readout = dragged
    ? { x: axis.timeToX(dragged.t), y: blockTop + levelToY(gainToLevel(dragged.gain), metrics), point: dragged }
    : null;
  const hint = drag.hover ? { x: drag.hover.x, y: blockTop + drag.hover.y } : null;
  const beside = (x: number, gap: number) =>
    x + gap + CHIP_ROOM > Math.min(contentWidth, visibleRight) ? { right: `calc(100% - ${x - gap}px)` } : { left: x + gap };

  return (
    <div data-testid="stitch-audio-row" className="absolute inset-x-0 border-b border-white/6" style={rowStyle}>
      <div
        ref={blockRef}
        role="button"
        tabIndex={0}
        aria-label="Audio track"
        aria-expanded={expanded}
        data-testid="stitch-audio-block"
        onPointerDown={drag.onPointerDown}
        onPointerMove={drag.onPointerMove}
        onPointerLeave={drag.onPointerLeave}
        onDoubleClick={drag.onDoubleClick}
        onKeyDown={onKeyDown}
        className={cn(
          "absolute overflow-hidden rounded-media select-none outline-none focus-visible:ring-2 focus-visible:ring-selection",
          // Selected (expanded), a muted block keeps a stronger ring than its unselected /15
          muted
            ? cn("bg-handle-audio/4 ring-1", expanded ? "ring-handle-audio/30" : "ring-handle-audio/15")
            : cn("bg-handle-audio/8 ring-1", expanded ? "ring-handle-audio/55" : "ring-handle-audio/35"),
          expanded &&
            !muted &&
            (drag.live
              ? "cursor-grabbing"
              : drag.overPoint
                ? "cursor-grab"
                : drag.hover
                  ? "cursor-pointer"
                  : "cursor-default"),
        )}
        style={{ left: blockX, top: blockTop, width: blockWidth, height: blockHeight }}
      >
        {waveform?.status === "ready" && waveform.peaks && waveform.duration !== null && (
          <div className={cn("absolute inset-0", muted && "opacity-35")}>
            <Waveform
              peaks={waveform.peaks}
              duration={waveform.duration}
              axis={axis}
              blockX={blockX}
              blockWidth={blockWidth}
              height={blockHeight}
              expanded={expanded}
              viewLeft={viewLeft}
              viewRight={viewRight}
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
          <CurveLayer
            curve={shown}
            axis={axis}
            metrics={metrics}
            blockX={blockX}
            blockWidth={blockWidth}
            height={blockHeight}
            expanded={expanded}
            dragIndex={drag.live?.index ?? null}
            selectedIndex={expanded ? selectedPoint : null}
            hover={drag.hover}
          />
        )}
        {/* Over the curve, as the boards draw it: the line's floor runs inside the label bar */}
        <LabelBar music={music} />
      </div>

      {readout && (
        <div
          aria-hidden="true"
          data-testid="stitch-curve-readout"
          className={cn(EDITOR_CHIP, "pointer-events-none absolute z-4 inline-flex -translate-y-1/2 items-center gap-2 whitespace-nowrap font-mono tabular-nums")}
          style={{ top: readout.y, ...beside(readout.x, 12) }}
        >
          <span className="text-neutral-200">{formatDb(readout.point.gain)}</span>
          <span className="text-neutral-500">{formatTimecode(readout.point.t)}</span>
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
    </div>
  );
}
