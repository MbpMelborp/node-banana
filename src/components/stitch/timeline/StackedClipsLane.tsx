"use client";

import type { KeyboardEvent, MouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { cn } from "@/components/nodes/ui/cn";
import { clipName } from "@/lib/stitch/labels";
import type { LaneBox } from "@/lib/stitch/laneLayout";
import { stackedInsertionY } from "@/lib/stitch/reorder";
import type { TimeAxis } from "@/lib/stitch/timeAxis";
import type { ClipSpan } from "@/lib/stitch/timeline";
import { GEOMETRY } from "../editorStyles";
import { useLibraryAvailable } from "../library/useLibraryAvailable";
import type { ClipMediaView } from "../useStitchEditorMedia";
import { ClipBox, type ClipBoxMode } from "./ClipBox";
import { AddSlotButton, EmptyLaneButton, laneTabStop, onLaneKeyDown, openClipMenu, useLaneFocus } from "./ClipsLane";
import { CrossfadeMarks } from "./CrossfadeMark";
import { EmptyClipSlot } from "./EmptyClipSlot";
import { Filmstrip } from "./Filmstrip";
import type { ReorderLive } from "./useClipReorder";
import type { TrimLive } from "./useTrimDrag";

const ROW = GEOMETRY.stackRow;
const BOX_TOP = GEOMETRY.stackClipTop;
const BOX_HEIGHT = GEOMETRY.stackClipHeight;
/** A ghost narrower than this is not drawn. */
const MIN_GHOST_PX = 1;

/**
 * Stacked's clip rows, inside the rows block under the sticky ruler: one
 * 52px row per clip, its 40px compact box at the clip's own start on a
 * linear axis (an empty clip is a 160px slot at its instant), the overlap
 * marks, and after the last row's box the dashed + that adds from the
 * library.
 *
 * While a trim runs the boxes are drawn from the spans release will give,
 * so nothing jumps on release; the ghost shows the frames the trim cuts, on
 * the side of the box they leave from.
 * While a clip is dragged up or down it is drawn at the start it will have
 * in its new place, with a line where it will land.
 *
 * The same listbox as Track's (one tab stop, focus kept in the lane, the
 * clip menu from the keyboard), running down: ↑/↓ as well as ←/→.
 */
export function StackedClipsLane({
  axis,
  spans,
  boxes,
  restBoxes,
  media,
  selectedId,
  trim,
  reorder,
  liftedX,
  crossfade,
  viewLeft,
  viewRight,
  contentWidth,
  onBodyPointerDown,
  onHandlePointerDown,
}: {
  axis: TimeAxis;
  /** As drawn: while a trim runs, the spans it gives. */
  spans: readonly ClipSpan[];
  boxes: readonly LaneBox[];
  /** The boxes at rest, for the trim ghost. */
  restBoxes: readonly LaneBox[];
  media: ReadonlyMap<string, ClipMediaView>;
  selectedId: string | null;
  trim: TrimLive | null;
  reorder: ReorderLive | null;
  /** The lifted clip's x at its start in the order it would drop into. */
  liftedX: number | null;
  crossfade: boolean;
  viewLeft: number;
  viewRight: number;
  contentWidth: number;
  onBodyPointerDown: (event: ReactPointerEvent<HTMLElement>, clipId: string, index: number) => void;
  onHandlePointerDown: (event: ReactPointerEvent<HTMLElement>, span: ClipSpan, edge: "in" | "out") => void;
}) {
  const { rowRef, onFocus, onBlur } = useLaneFocus();
  const libraryOn = useLibraryAvailable();
  const tabStop = laneTabStop(spans, selectedId);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => onLaneKeyDown(event, spans, tabStop, true);

  if (spans.length === 0) {
    return (
      <div ref={rowRef} className="absolute inset-x-0 top-0 border-b border-white/4" style={{ height: ROW }}>
        <EmptyLaneButton
          libraryOn={libraryOn}
          left={GEOMETRY.origin}
          top={BOX_TOP}
          width={Math.max(0, contentWidth - GEOMETRY.origin - GEOMETRY.endMargin)}
          height={BOX_HEIGHT}
          onFocus={onFocus}
          onBlur={onBlur}
        />
      </div>
    );
  }

  // The frames the trim cuts, drawn beside the live box on the side they leave from, in source order: the head just left
  // of the box for an In trim, the tail just right of it for an Out trim (the half-clip cap can move the box's start).
  // A head with no room left of the box (Clip 1 starts at the lane's origin) keeps its frames nearest the new In, from x 0
  const trimIndex = trim ? spans.findIndex((s) => s.clip.id === trim.clipId) : -1;
  let ghost: { x: number; width: number; inSec: number; side: "in" | "out" } | null = null;
  if (trim && trimIndex !== -1 && spans[trimIndex].length > 0) {
    const live = boxes[trimIndex];
    const rest = restBoxes[trimIndex];
    const width = live && rest ? (rest.lengthSec - live.lengthSec) * axis.pxPerSec : 0;
    if (live && rest && width >= MIN_GHOST_PX) {
      if (trim.edge === "out") {
        ghost = { x: live.x + live.width, width, inSec: live.inSec + live.lengthSec, side: "out" };
      } else {
        const x = Math.max(0, live.x - width);
        const shown = live.x - x;
        if (shown >= MIN_GHOST_PX) {
          ghost = { x, width: shown, inSec: rest.inSec + (width - shown) / axis.pxPerSec, side: "in" };
        }
      }
    }
  }
  const trimView = trimIndex === -1 ? undefined : media.get(spans[trimIndex].clip.id);

  const insertionY = reorder ? stackedInsertionY(reorder.dropIndex, reorder.index, ROW) : null;
  const last = boxes[boxes.length - 1];
  const slotX = (last ? last.x + last.width : axis.endX) + GEOMETRY.addSlotGap;

  // Each clip's name for the one above it: the previous clip with a length (an empty clip covers nothing)
  const above: (string | null)[] = [];
  let previous: string | null = null;
  for (const span of spans) {
    above.push(previous);
    if (span.length > 0) previous = clipName(span.index);
  }
  return (
    <>
      {spans.map((span, i) => (
        <div
          key={span.clip.id}
          aria-hidden="true"
          className={cn("absolute inset-x-0 border-b border-white/4", span.clip.id === selectedId && "bg-white/4")}
          style={{ top: i * ROW, height: ROW }}
        />
      ))}
      <div
        ref={rowRef}
        role="listbox"
        aria-label="Clips"
        aria-orientation="vertical"
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onBlur={onBlur}
        className="absolute inset-0"
      >
        {spans.map((span, i) => {
          const view = media.get(span.clip.id);
          const box = boxes[i];
          const mode: ClipBoxMode = !reorder ? "rest" : reorder.clipId === span.clip.id ? "lifted" : "dimmed";
          const lifted = mode === "lifted" && reorder;
          const x = lifted ? (liftedX ?? box.x) : box.x;
          const top = i * ROW + BOX_TOP + (lifted ? reorder.dy : 0);
          const selected = selectedId === span.clip.id;
          const focusable = tabStop === span.clip.id;
          const onBody = (event: ReactPointerEvent<HTMLElement>) => onBodyPointerDown(event, span.clip.id, i);
          const onMenu = (event: MouseEvent<HTMLElement>) => openClipMenu(event, span.clip.id);
          if (span.length <= 0) {
            return (
              <EmptyClipSlot
                key={span.clip.id}
                span={span}
                view={view}
                x={x}
                width={box.width}
                selected={selected}
                focusable={focusable}
                mode={mode}
                top={top}
                height={BOX_HEIGHT}
                onBodyPointerDown={onBody}
                onContextMenu={onMenu}
              />
            );
          }
          return (
            <ClipBox
              key={span.clip.id}
              span={span}
              view={view}
              x={x}
              width={box.width}
              selected={selected}
              focusable={focusable}
              mode={mode}
              trimEdge={trimIndex === i && trim ? trim.edge : null}
              inSec={box.inSec}
              lengthSec={box.lengthSec}
              pxPerSec={axis.pxPerSec}
              viewLeft={viewLeft}
              viewRight={viewRight}
              top={top}
              height={BOX_HEIGHT}
              compact
              overlay={
                // A lifted clip's overlaps are those of the place it leaves: not drawn
                mode === "lifted" ? null : (
                  <CrossfadeMarks
                    overlapIn={span.overlapIn}
                    overlapOut={span.overlapOut}
                    pxPerSec={axis.pxPerSec}
                    crossfade={crossfade}
                    coveredBy={above[i]}
                  />
                )
              }
              onBodyPointerDown={onBody}
              onHandlePointerDown={(event, edge) => onHandlePointerDown(event, span, edge)}
              onContextMenu={onMenu}
            />
          );
        })}

        {ghost && (
          <div
            aria-hidden="true"
            data-testid="stitch-trim-ghost"
            className={cn("absolute overflow-hidden", ghost.side === "out" ? "rounded-r-media" : "rounded-l-media")}
            style={{ left: ghost.x, top: trimIndex * ROW + BOX_TOP, width: ghost.width, height: BOX_HEIGHT }}
          >
            <Filmstrip
              frames={trimView?.frames ?? []}
              duration={trimView?.duration ?? null}
              inSec={ghost.inSec}
              pxPerSec={axis.pxPerSec}
              width={ghost.width}
              boxX={ghost.x}
              viewLeft={viewLeft}
              viewRight={viewRight}
              className="opacity-30"
            />
            <div className="absolute inset-0 editor-ghost-hatch" />
          </div>
        )}

        {insertionY !== null && (
          <div
            aria-hidden="true"
            data-testid="stitch-insertion-bar"
            className="pointer-events-none absolute inset-x-0 z-20 h-[3px] rounded-[2px] bg-selection"
            style={{ top: insertionY - 1.5 }}
          />
        )}
      </div>
      <AddSlotButton
        libraryOn={libraryOn}
        left={slotX}
        top={(spans.length - 1) * ROW + BOX_TOP}
        height={BOX_HEIGHT}
        onFocus={onFocus}
        onBlur={onBlur}
      />
    </>
  );
}
