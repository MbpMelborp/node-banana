"use client";

import { useRef, type MouseEvent, type ReactNode, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { Rewind, Volume1, VolumeX } from "lucide-react";
import { cn } from "@/components/nodes/ui/cn";
import { clipName } from "@/lib/stitch/labels";
import { progressToY, remapMetrics } from "@/lib/stitch/remapGeometry";
import { formatSeconds, formatTimecode } from "@/lib/stitch/timecode";
import { spanRange, type ClipSpan } from "@/lib/stitch/timeline";
import { activeWarp, bakeError, formatSpeed, IDENTITY_WARP, isWarped, warpMap, warpRateLabel } from "@/lib/stitch/warp";
import { setClipMuted } from "../editorActions";
import { GEOMETRY, LIFTED_CLIP, MOVING_CLIP, SELECTED_RING } from "../editorStyles";
import { isToggleClick } from "../selectionActions";
import type { ClipMediaView } from "../useStitchEditorMedia";
import { AddPointHint, CurveReadout } from "./CurveChips";
import { Filmstrip, frameCellFor } from "./Filmstrip";
import { SpeedCurveLayer } from "./SpeedCurveLayer";
import { useSpeedCurveDrag } from "./useSpeedCurveDrag";

/**
 * At rest; "dimmed" while another clip is being dragged to a new place; "lifted" while this one is; "moving" while
 * Stacked's body drag carries it in time and across rows.
 */
export type ClipBoxMode = "rest" | "dimmed" | "lifted" | "moving";

/** ⌘ (Ctrl off a Mac) or ⇧: a click on the box under the sound button, which then selects instead of muting. */
const selectsClip = (event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) =>
  isToggleClick(event) || event.shiftKey;
const stopPress = (event: ReactPointerEvent) => {
  if (!selectsClip(event)) event.stopPropagation();
};
/** Each handle takes at most this share of a narrow clip, so its middle third stays a body to press and drag. */
const HANDLE_SHARE = 1 / 3;
/** A handle narrower than this shows no grip. */
const MIN_GRIP_HANDLE_PX = 4;
/** The handles' width on a clip drawn this wide: the boards' 10px, narrower on a clip too short for two. */
export const handleWidthFor = (width: number) => Math.min(GEOMETRY.handle, width * HANDLE_SHARE);
/** A box narrower than this shows no length chip. */
const MIN_CHIP_BOX_PX = 56;
/** The length chip, at the box's bottom right, clear of the Out handle: shown on hover, and live while trimming. */
export const LENGTH_CHIP =
  "pointer-events-none absolute bottom-1 right-3 z-2 rounded-[4px] bg-black/60 px-1 text-[10px] leading-4 tabular-nums text-neutral-100";
/**
 * A compact box narrower than this has no hover mute button, and its muted badge is a mark the press passes through:
 * on a short box they would cover most of the body, which is what a drag holds.
 */
const MIN_SOUND_BUTTON_BOX_PX = 96;
/** A muted clip's mark (video or audio): an 18px VolumeX square, placed by the box. */
export const MUTED_BADGE =
  "pointer-events-none absolute z-2 inline-flex h-[18px] w-[18px] items-center justify-center rounded-[5px] bg-black/60 text-neutral-300";
/** A retimed clip's mark: its rate ("2×", "Ramp") and Rewind while reversed, beside the sound badge; presses pass through. */
export const SPEED_BADGE =
  "pointer-events-none absolute z-2 inline-flex h-[18px] min-w-[18px] items-center justify-center gap-0.5 rounded-[5px] bg-black/60 px-1 text-[10px] font-medium leading-none tabular-nums text-neutral-200";
/**
 * About how wide the speed badge draws, never less: 4px padding a side, Rewind 11px (2px more before text), 7px a
 * character (the system font's "Ramp" draws 27.9px, its numerals under 6.6px).
 */
export const speedBadgePx = (text: string | null, reversed: boolean): number =>
  Math.max(18, 8 + (reversed ? 11 : 0) + (reversed && text ? 2 : 0) + (text ? 7 * text.length : 0));
/** How far in from the box's right the length chip reaches, and a gap: right-3, 4px padding a side, 6px a character. */
const lengthChipPx = (text: string): number => 22 + 6 * text.length;
/** A mouse press takes no focus: a focused clip or button would be unmounted by its own action and drop focus out of the editor. */
export const keepFocus = (event: MouseEvent) => event.preventDefault();
/** A box with no lane content to measure against: its curve takes no press. */
const NO_CONTENT: RefObject<HTMLDivElement | null> = { current: null };

/**
 * A clip's In or Out handle, on a video box or an audio box: shown on hover (white on the one selected clip), and
 * while its edge is dragged. Hidden, it still takes a press at the box's edge.
 */
export function EdgeHandle({
  side,
  width,
  selected,
  active,
  onPointerDown,
}: {
  side: "in" | "out";
  width: number;
  selected: boolean;
  active: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
}) {
  return (
    <div
      role="presentation"
      data-trim-handle={side}
      onPointerDown={onPointerDown}
      className={cn(
        "absolute inset-y-0 z-1 flex items-center justify-center cursor-ew-resize",
        side === "in" ? "left-0" : "right-0",
        active
          ? "bg-neutral-200"
          : cn("opacity-0 group-hover:opacity-100", selected ? "bg-neutral-100" : "bg-white/18"),
      )}
      style={{ width }}
    >
      {/* The grip, where the handle has room for it */}
      {width >= MIN_GRIP_HANDLE_PX && (
        <span
          aria-hidden="true"
          className={cn("h-3.5 w-0.5 rounded-[1px]", active || selected ? "bg-neutral-900" : "bg-white/80")}
        />
      )}
    </div>
  );
}

/**
 * One clip on the lane: at rest only its frames, on the edit-field ground
 * with 6px corners, the muted badge on a muted clip, and on a retimed or
 * reversed one its speed badge, where the box has room for it beside the
 * sound badge and the handles. Selected (one of several too, or while an
 * edge is dragged) it is ringed in white over its frames. On hover: its
 * trimmed length at the bottom right (also while trimming, to two
 * decimals), its trim handles, and its sound button (the badge unmutes, or
 * a button mutes). Those buttons are pointer shortcuts, hidden from the
 * accessibility tree and the tab order: an option holds no controls, and
 * ⌥M and the clip menu do the same. Its name is its accessible name; a box
 * lifted to be dragged shows it.
 *
 * Compact (a Stacked row's 40px box): the sound badges centred at the left.
 * Its accessible name says where it starts, and a box under 96px keeps its
 * middle for the body drag: no hover mute button, and the muted badge only
 * marks it (⌥M and the menu unmute).
 *
 * On a row open for its speed curve the box is taller, its frames wider,
 * and its time remap is drawn over them (SpeedCurveLayer). The single
 * selected clip there takes presses on its line and knots
 * (useSpeedCurveDrag): its hover mute button gives way to them; any other
 * press is the body's, as everywhere. While a knot is dragged its momentary
 * speed and sequence time show beside it; over the line a hint says a drag
 * adds a point, except near a knot, where the press drags that knot (drawn
 * larger).
 */
export function ClipBox({
  span,
  view,
  x,
  width,
  selected,
  focusable,
  mode,
  trimEdge,
  inSec,
  lengthSec,
  pxPerSec,
  viewLeft,
  viewRight,
  top = GEOMETRY.clipTop,
  height = GEOMETRY.clipHeight,
  compact = false,
  multi = false,
  expanded = false,
  curveEditable = false,
  curveOffsetX = 0,
  curveWidth,
  contentRef,
  visibleRight = Infinity,
  contentWidth = Infinity,
  overlay,
  onBodyPointerDown,
  onHandlePointerDown,
  onContextMenu,
}: {
  span: ClipSpan;
  view: ClipMediaView | undefined;
  x: number;
  width: number;
  selected: boolean;
  /** The listbox's one tab stop. */
  focusable: boolean;
  mode: ClipBoxMode;
  /** The edge being dragged on this clip, if any. */
  trimEdge: "in" | "out" | null;
  /** Live while trimming: the In and the length the drag gives. */
  inSec: number;
  lengthSec: number;
  pxPerSec: number;
  viewLeft: number;
  viewRight: number;
  /** In its row: Track's clips row by default, a Stacked row's box otherwise. */
  top?: number;
  height?: number;
  compact?: boolean;
  /** One of several selected clips: its handles show on hover only, since a trim acts on one clip. */
  multi?: boolean;
  /** On a row open for its speed curve: the box is taller, its curve drawn over its frames. */
  expanded?: boolean;
  /** The single selected clip on an open row, at rest and not trimmed: presses on its curve are the curve's. */
  curveEditable?: boolean;
  /** Where the clip's time starts from the box's own left (≤ 0 where it is inset at a join), and its width on the lane. */
  curveOffsetX?: number;
  curveWidth?: number;
  /** The lane content, which the curve's presses are measured against. */
  contentRef?: RefObject<HTMLDivElement | null>;
  /** For the readout's side: the visible lanes' right and the content's width. */
  visibleRight?: number;
  contentWidth?: number;
  /** Drawn over the frames, under the badges and handles (Stacked's crossfade marks). */
  overlay?: ReactNode;
  onBodyPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onHandlePointerDown: (event: ReactPointerEvent<HTMLElement>, edge: "in" | "out") => void;
  onContextMenu: (event: MouseEvent<HTMLElement>) => void;
}) {
  const { clip } = span;
  const name = clipName(span.index);
  const atRest = mode === "rest";
  const showHandles = atRest;
  const handleWidth = handleWidthFor(width);
  // White on the one selected clip; a trim acts on one clip, so several selected keep the quiet ones
  const handlesWhite = selected && !multi;
  // The badges make room for the handles while they show
  const badgeLeft = trimEdge ? "left-4" : "left-1.5 group-hover:left-4";
  const badgeTop = compact && !expanded ? "top-[11px]" : "top-1.5";
  const soundButtons = !compact || width >= MIN_SOUND_BUTTON_BOX_PX;
  const ringed = (selected || trimEdge !== null) && (mode === "rest" || mode === "dimmed");
  // The hover mute button: Track's at the right, a compact box's in the first slot; none while the curve is edited
  const hoverMute = atRest && !clip.muted && !trimEdge && soundButtons && !curveEditable;
  const warp = activeWarp(clip);
  const rate = warpRateLabel(warp);
  const reversed = warp?.reverse === true;
  // The second slot, after a muted badge (or a compact box's hover mute button): 28px, 38px while the handles show
  const secondSlot = trimEdge ? "left-[38px]" : "left-7 group-hover:left-[38px]";
  const speedLeft = clip.muted ? secondSlot : compact && hoverMute ? "left-1.5 group-hover:left-[38px]" : badgeLeft;
  const lengthText = formatSeconds(lengthSec, trimEdge ? 2 : 1);
  // It must fit where it sits on hover, clear of what shares its line at the right: a compact box's length chip, the
  // Track mute button, else the Out handle
  const leftPx = clip.muted || (compact && hoverMute) ? 38 : 16;
  const rightPx = compact && !expanded ? lengthChipPx(lengthText) : !compact && hoverMute ? 38 : 14;
  const speedBadge = warp !== null && mode !== "lifted" && leftPx + speedBadgePx(rate, reversed) + rightPx <= width;

  const blockRef = useRef<HTMLDivElement>(null);
  const metrics = remapMetrics(height);
  const curveW = curveWidth ?? width;
  // Lane content x of the clip's first frame (a lifted box's travel moves its line with it)
  const curveX = x + curveOffsetX;
  const drag = useSpeedCurveDrag({
    clipId: clip.id,
    x: curveX,
    width: curveW,
    metrics,
    // A drag that turns a preset or bezier into points bakes it to the clip's budget, which toPoints can miss beside a
    // steep stretch or a vertical tangent
    maxError: bakeError(span.sourceOut - clip.inSec, view?.fps),
    contentRef: contentRef ?? NO_CONTENT,
    blockRef,
    editable: curveEditable,
  });
  // A drag's curve is the hook's until its release: the frames follow it as the line does
  const liveWarp = drag.live?.curve ?? clip.warp;
  const shownWarp = liveWarp ?? IDENTITY_WARP;
  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (drag.onPointerDown(event)) return;
    onBodyPointerDown(event);
  };
  // The dragged knot's readout, in the row's coordinates: its momentary speed and its sequence time
  const live = drag.live;
  const dragged =
    live && live.index !== null && live.curve.curve?.kind === "points" ? live.curve.curve.points[live.index] : null;
  const readout =
    live && dragged
      ? {
          x: curveX + dragged[0] * curveW,
          y: top + progressToY(dragged[1], metrics),
          speed: isWarped(live.curve) ? warpMap(spanRange(span), live.curve).speedAt(dragged[0] * span.length) : 1,
          time: span.start + dragged[0] * span.length,
        }
      : null;
  const chipsRight = Math.min(contentWidth, visibleRight);

  return (
    <>
      <div
        ref={blockRef}
        data-clip-id={clip.id}
        aria-label={compact ? `${name}, starts ${formatTimecode(span.start)}` : name}
        aria-selected={selected}
        role="option"
        tabIndex={focusable ? 0 : -1}
        onPointerDown={onPointerDown}
        onPointerMove={drag.onPointerMove}
        onPointerLeave={drag.onPointerLeave}
        onDoubleClick={drag.onDoubleClick}
        onMouseDown={keepFocus}
        onContextMenu={onContextMenu}
        className={cn(
          // The focus ring, outside the box, marks the focused clip apart from the others a group selection rings
          "group absolute overflow-hidden rounded-md bg-edit-field select-none outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-pane",
          mode === "moving"
            ? MOVING_CLIP
            : mode === "lifted"
              ? cn(LIFTED_CLIP, "ring-1 ring-white/20")
              : mode === "dimmed" && "opacity-40",
          trimEdge === "in" && "z-1",
          // Stacked: the body drags on both axes; only the row grip's drag lifts a box, up or down
          compact && mode === "rest" && "cursor-grab",
          compact && mode === "lifted" && "cursor-ns-resize",
          // Last, so it wins the compact box's cursor-grab
          curveEditable &&
            (drag.live ? "cursor-grabbing" : drag.overPoint ? "cursor-grab" : drag.hover ? "cursor-pointer" : undefined),
        )}
        style={{ left: x, top, width, height }}
      >
        <Filmstrip
          frames={view?.frames ?? []}
          duration={view?.duration ?? null}
          inSec={inSec}
          lengthSec={lengthSec}
          warp={liveWarp}
          pxPerSec={pxPerSec}
          width={width}
          boxX={x}
          viewLeft={viewLeft}
          viewRight={viewRight}
          cell={expanded ? frameCellFor(height) : undefined}
        />
        {overlay}
        {expanded && span.length > 0 && (
          <SpeedCurveLayer
            warp={shownWarp}
            offsetX={curveOffsetX}
            width={curveW}
            height={height}
            selected={selected && !multi}
            editable={curveEditable}
            pointIndex={drag.live?.index ?? drag.hoverPoint}
            hover={drag.hover && { x: drag.hover.x - x, y: drag.hover.y }}
          />
        )}
        {ringed && <span aria-hidden="true" data-selected-ring="" className={SELECTED_RING} />}

        {/* A box lifted to a new place says which clip it is */}
        {mode === "lifted" && (
          <span className={cn(LENGTH_CHIP, "left-1.5 right-auto font-medium")}>{name}</span>
        )}
        {/* A box in motion keeps its length, without the buttons a press would reach */}
        {(atRest || mode === "moving") && width >= MIN_CHIP_BOX_PX && (
          // On hover, and on keyboard focus (the box is the group), as the length is drawn nowhere else
          <span
            className={cn(
              LENGTH_CHIP,
              trimEdge || mode === "moving" ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100",
            )}
          >
            {lengthText}
          </span>
        )}

        {clip.muted && ((atRest && !soundButtons) || mode === "moving") && (
          <span aria-hidden="true" data-muted-mark="" className={cn(MUTED_BADGE, badgeTop, badgeLeft)}>
            <VolumeX size={11} strokeWidth={2} />
          </span>
        )}
        {speedBadge && (
          <span aria-hidden="true" data-speed-badge="" className={cn(SPEED_BADGE, badgeTop, speedLeft)}>
            {reversed && <Rewind size={11} strokeWidth={2} />}
            {rate && <span>{rate}</span>}
          </span>
        )}
        {atRest && clip.muted && soundButtons && (
          <button
            type="button"
            aria-label="Unmute clip audio"
            aria-hidden="true"
            tabIndex={-1}
            title="Clip audio muted"
            onPointerDown={stopPress}
            onMouseDown={keepFocus}
            onClick={(event) => {
              if (!selectsClip(event)) setClipMuted(clip.id, false);
            }}
            className={cn(
              "absolute z-2 inline-flex h-[18px] w-[18px] items-center justify-center rounded-[5px] bg-black/60 text-neutral-300 hover:text-neutral-100",
              badgeTop,
              badgeLeft,
            )}
          >
            <VolumeX size={11} strokeWidth={2} />
          </button>
        )}
        {hoverMute && (
          <button
            type="button"
            aria-label="Mute clip audio"
            aria-hidden="true"
            tabIndex={-1}
            onPointerDown={stopPress}
            onMouseDown={keepFocus}
            onClick={(event) => {
              if (!selectsClip(event)) setClipMuted(clip.id, true);
            }}
            className={cn(
              "absolute z-2 inline-flex h-[18px] w-[18px] items-center justify-center rounded-[5px] bg-black/60 text-neutral-100 opacity-0 group-hover:opacity-100",
              badgeTop,
              compact ? badgeLeft : "right-4",
            )}
          >
            <Volume1 size={11} strokeWidth={2} />
          </button>
        )}

        {showHandles && (
          <>
            <EdgeHandle
              side="in"
              width={handleWidth}
              selected={handlesWhite}
              active={trimEdge === "in"}
              onPointerDown={(event) => onHandlePointerDown(event, "in")}
            />
            <EdgeHandle
              side="out"
              width={handleWidth}
              selected={handlesWhite}
              active={trimEdge === "out"}
              onPointerDown={(event) => onHandlePointerDown(event, "out")}
            />
          </>
        )}
      </div>
      {readout && (
        <CurveReadout x={readout.x} y={readout.y} right={chipsRight} testId="stitch-speed-readout">
          <span className="text-neutral-200">{formatSpeed(readout.speed)}</span>
          <span className="text-neutral-500">{formatTimecode(readout.time)}</span>
        </CurveReadout>
      )}
      {drag.hover && !drag.live && (
        <AddPointHint
          x={drag.hover.x}
          y={top + drag.hover.y}
          right={chipsRight}
          testId="stitch-speed-add-point"
          label="Drag to add point"
        />
      )}
    </>
  );
}
