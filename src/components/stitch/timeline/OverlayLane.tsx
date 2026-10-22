"use client";

import {
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type UIEvent,
} from "react";
import { cn } from "@/components/nodes/ui/cn";
import { overlaySelectionOf, selectedOverlayIds, useStitchEditorStore } from "@/store/stitchEditorStore";
import { audioSnapText } from "@/lib/stitch/audioDrag";
import { overlayScrollTop, type OverlaySectionLayout } from "@/lib/stitch/overlayLayout";
import type { TimeAxis } from "@/lib/stitch/timeAxis";
import { formatSeconds, formatTimecode } from "@/lib/stitch/timecode";
import type { StitchOverlay } from "@/types";
import { EDITOR_CHIP, GEOMETRY } from "../editorStyles";
import { keepFocus } from "./ClipBox";
import { useLaneFocus } from "./ClipsLane";
import { OverlayClipBox, overlayFirstLine } from "./OverlayClipBox";
import { releaseTypingFocus } from "./releaseTypingFocus";
import { SnapGuide } from "./TrimOverlay";
import type { OverlayDragLive } from "./useOverlayDrag";

/** The move chip's gap from the moving box, and its drop from the box's top, px. */
const CHIP_GAP = 12;
const CHIP_DROP = 10;

/** One text layer as the lane draws it at rest. */
export interface OverlayBox {
  overlay: StitchOverlay;
  x: number;
  width: number;
}

/** Each layer's box, from its start to its end on the lane's axis. */
export function overlayBoxes(axis: TimeAxis, overlays: readonly StitchOverlay[]): OverlayBox[] {
  return overlays.map((overlay) => {
    const x = axis.timeToX(overlay.startSec);
    return { overlay, x, width: axis.timeToX(overlay.endSec) - x };
  });
}

/** "Text 2". */
export const overlayRowName = (row: number) => `Text ${row + 1}`;

/** A layer's name in a snap chip or a menu's heading: its first line, quoted; "Empty text" when it has none. */
export function overlayName(overlay: StitchOverlay): string {
  const line = overlayFirstLine(overlay.text);
  return line ? `“${line}”` : "Empty text";
}

/** Opens the text layer menu at a point, selecting the layer unless it is one of the selection; not over a drag. */
function openOverlayMenuAt(id: string, x: number, y: number): void {
  const s = useStitchEditorStore.getState();
  if (s.cancelGesture) return;
  if (!selectedOverlayIds(s).includes(id)) s.select(overlaySelectionOf({ clipId: id }));
  s.openMenu({ kind: "overlay", clipId: id, x, y });
}

/** A text layer box's contextmenu event: at the pointer, or under the box when the keyboard sent it. */
export function openOverlayMenu(event: MouseEvent<HTMLElement>, id: string): void {
  event.preventDefault();
  if (useStitchEditorStore.getState().cancelGesture) return;
  releaseTypingFocus(event.currentTarget);
  if (event.clientX === 0 && event.clientY === 0) {
    const rect = event.currentTarget.getBoundingClientRect();
    openOverlayMenuAt(id, rect.left, rect.bottom + 4);
    return;
  }
  openOverlayMenuAt(id, event.clientX, event.clientY);
}

/**
 * The listbox's keys: ← and → the previous or next layer in overlay order, Home and End the first and last, ↑ and ↓
 * the layer on the row above or below (rows run up from the video) whose start is nearest; each selects one layer and
 * takes focus. The context-menu key or ⇧F10 opens the layer's menu.
 */
function onOverlayLaneKeyDown(event: KeyboardEvent<HTMLDivElement>, overlays: readonly StitchOverlay[], tabStop: string | null) {
  const at = overlays.findIndex((o) => o.id === tabStop);
  const options = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="option"]'));
  const optionOf = (id: string) => options.find((el) => el.dataset.overlayId === id);
  if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
    const option = at === -1 ? undefined : optionOf(overlays[at].id);
    if (!option) return;
    event.preventDefault();
    const rect = option.getBoundingClientRect();
    openOverlayMenuAt(overlays[at].id, rect.left, rect.bottom + 4);
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey || overlays.length === 0) return;
  let next: StitchOverlay | undefined;
  if (event.key === "ArrowRight") next = overlays[Math.min(overlays.length - 1, at + 1)];
  else if (event.key === "ArrowLeft") next = overlays[Math.max(0, at - 1)];
  else if (event.key === "Home") next = overlays[0];
  else if (event.key === "End") next = overlays[overlays.length - 1];
  else if ((event.key === "ArrowUp" || event.key === "ArrowDown") && at !== -1) {
    const current = overlays[at];
    const rows = [...new Set(overlays.map((o) => o.row))].sort((a, b) => a - b);
    const row = rows[rows.indexOf(current.row) + (event.key === "ArrowUp" ? 1 : -1)];
    const onRow = row === undefined ? [] : overlays.filter((o) => o.row === row);
    next = onRow.reduce<StitchOverlay | undefined>(
      (best, o) => (!best || Math.abs(o.startSec - current.startSec) < Math.abs(best.startSec - current.startSec) ? o : best),
      undefined,
    );
    if (!next) {
      event.preventDefault();
      return;
    }
  } else return;
  if (!next) return;
  event.preventDefault();
  useStitchEditorStore.getState().select(overlaySelectionOf({ clipId: next.id }));
  optionOf(next.id)?.focus();
}

/**
 * The text layers' rows, under the ruler and over the video, in both
 * layouts: 52px each, row 0 nearest the video and each higher row above it
 * (it draws in front), every layer a box from its start to its end. It
 * depends on the rows only, never on the selection, so a click moves
 * nothing. Past two rows (fewer when the window is short) the rows scroll
 * inside it by a translate the timeline owns, kept from the bottom. Without
 * text layers the timeline leaves it out.
 *
 * During a body drag the moving boxes leave the rows' clip and follow the
 * pointer; the landing is drawn where release puts it: a band on the rows it
 * lands on, or a line where it goes onto a new row (one an overlap inserts,
 * or a new row on top, past the section's top edge). The chip beside the
 * lead names where it shows, how far it moved and what it snapped to.
 */
export function OverlayLane({
  axis,
  boxes,
  layout,
  scroll,
  selectedIds,
  leadId,
  drag,
  endX,
  viewRef,
  guideTop,
  scrollLeft,
  laneWidth,
  onBodyPointerDown,
  onHandlePointerDown,
  onLanePointerDown,
  onViewScroll,
}: {
  axis: TimeAxis;
  boxes: readonly OverlayBox[];
  layout: OverlaySectionLayout;
  /** The rows' scroll, kept from the bottom, px. */
  scroll: number;
  /** Every layer drawn selected (while a selection box runs, what it would select). */
  selectedIds: ReadonlySet<string>;
  /** The lead of the overlay selection: the listbox's tab stop. */
  leadId: string | null;
  drag: OverlayDragLive | null;
  /** The sequence's end on the lane, where the boxes' hatching starts; null with no video. */
  endX: number | null;
  /** The rows' view, for the drag's up-and-down auto-scroll. */
  viewRef: RefObject<HTMLDivElement | null>;
  /** The foot of the playhead's head in the section's own box (negative: above it), where a snap guide starts. */
  guideTop: number;
  scrollLeft: number;
  laneWidth: number;
  onBodyPointerDown: (event: ReactPointerEvent<HTMLElement>, id: string) => void;
  onHandlePointerDown: (event: ReactPointerEvent<HTMLElement>, id: string, edge: "in" | "out") => void;
  /** A press on empty row space: the selection box. */
  onLanePointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  /** The view was scrolled by the browser (focus moved into a hidden row): the scroll joins the shared translate. */
  onViewScroll: (event: UIEvent<HTMLDivElement>) => void;
}) {
  const { rowRef, onFocus, onBlur } = useLaneFocus();
  const overlays = boxes.map((b) => b.overlay);
  const tabStop = overlays.some((o) => o.id === leadId) ? leadId : (overlays[0]?.id ?? null);
  const multi = selectedIds.size > 1;
  const move = drag?.kind === "move" ? drag : null;
  const trim = drag?.kind === "trim" ? drag : null;
  const moving = new Set(move?.ids ?? []);
  const top = overlayScrollTop(scroll, layout);
  const blockTop = (row: number) => (layout.rowTops[row] ?? 0) + GEOMETRY.overlayBlockTop;

  const boxFor = (box: OverlayBox, opts: { moving: boolean; top: number; shift?: number }) => {
    const live = trim && trim.id === box.overlay.id ? trim.overlay : box.overlay;
    const shift = opts.shift ?? 0;
    // A trim draws the layer as release leaves it; a move carries it by its delta
    const overlay = shift === 0 ? live : { ...live, startSec: live.startSec + shift, endSec: live.endSec + shift };
    const x = axis.timeToX(overlay.startSec);
    return (
      <OverlayClipBox
        key={box.overlay.id}
        overlay={overlay}
        rowLabel={overlayRowName(box.overlay.row)}
        x={x}
        width={axis.timeToX(overlay.endSec) - x}
        top={opts.top}
        selected={selectedIds.has(box.overlay.id)}
        multi={multi}
        focusable={!opts.moving && tabStop === box.overlay.id}
        moving={opts.moving}
        trimEdge={trim?.id === box.overlay.id ? trim.edge : null}
        axis={axis}
        endX={endX}
        onBodyPointerDown={(event) => onBodyPointerDown(event, box.overlay.id)}
        onHandlePointerDown={opts.moving ? null : (event, edge) => onHandlePointerDown(event, box.overlay.id, edge)}
        onContextMenu={(event) => openOverlayMenu(event, box.overlay.id)}
      />
    );
  };

  const landing = move?.landing ?? null;
  const lead = move ? boxes.find((b) => b.overlay.id === move.id) : undefined;
  const movingTop = (row: number) => blockTop(row) - (move?.topAtPress ?? 0) + (move?.dy ?? 0);
  const leadX = lead && move ? axis.timeToX(lead.overlay.startSec + move.result.deltaSec) : 0;
  const leadBottom = lead ? movingTop(lead.overlay.row) + GEOMETRY.overlayBlock : 0;
  const snapText = move ? audioSnapText(move.result) : null;
  // A new row goes in above row `after`: the line is on that row's top edge, the section's top edge for a new top row
  const insertionY =
    landing?.kind === "append"
      ? 0
      : landing?.kind === "insert"
        ? Math.min(Math.max((layout.rowTops[landing.after] ?? 0) - top, 0), layout.viewHeight)
        : null;

  // The chip goes right of the lead box when it fits in the visible lanes, else left of it
  const chipRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = chipRef.current;
    if (!el || !lead || !move) return;
    const width = el.offsetWidth;
    const right = axis.timeToX(lead.overlay.endSec + move.result.deltaSec);
    const viewEnd = scrollLeft + laneWidth;
    let x = right + CHIP_GAP;
    if (laneWidth > 0 && x + width > viewEnd) {
      const before = leadX - CHIP_GAP - width;
      x = before >= scrollLeft ? before : Math.max(scrollLeft, viewEnd - width);
    }
    el.style.left = `${x}px`;
  });

  const moveChip = (() => {
    if (!move || !lead) return null;
    const from = lead.overlay.startSec + move.result.deltaSec;
    const to = lead.overlay.endSec + move.result.deltaSec;
    const count = move.ids.length > 1 ? `${move.ids.length} layers · ` : "";
    const newRow = insertionY !== null ? " · New row" : "";
    return `${count}${formatTimecode(from)}–${formatTimecode(to)} · ${formatSeconds(move.result.deltaSec, 2, { signed: true })}${newRow}`;
  })();

  const trimBox = trim ? boxes.find((b) => b.overlay.id === trim.id) : undefined;
  const trimChip = trim
    ? trim.edge === "in"
      ? `Start ${formatTimecode(trim.overlay.startSec)}`
      : `End ${formatTimecode(trim.overlay.endSec)}`
    : null;
  const trimEdgeX = trim ? axis.timeToX(trim.edge === "in" ? trim.overlay.startSec : trim.overlay.endSec) : 0;
  const trimTop = trimBox ? blockTop(trimBox.overlay.row) - top : 0;

  return (
    <div
      data-overlay-section=""
      data-testid="stitch-overlay-section"
      className="relative bg-pane"
      style={{ height: layout.sectionHeight }}
    >
      <div
        ref={viewRef}
        data-testid="stitch-overlay-view"
        className="relative overflow-hidden"
        style={{ height: layout.viewHeight }}
        onScroll={onViewScroll}
      >
        <div
          ref={rowRef}
          role="listbox"
          aria-label="Text layers"
          aria-multiselectable="true"
          onKeyDown={(event) => onOverlayLaneKeyDown(event, overlays, tabStop)}
          onPointerDown={onLanePointerDown}
          onMouseDown={keepFocus}
          onFocus={onFocus}
          onBlur={onBlur}
          data-testid="stitch-overlay-rows"
          className="absolute inset-x-0 top-0"
          style={{ height: Math.max(layout.rowsHeight, layout.viewHeight), transform: `translateY(${-top}px)` }}
        >
          {layout.rowTops.map((rowTop, row) => (
            <div
              key={row}
              aria-hidden="true"
              data-testid="stitch-overlay-row"
              data-row={row}
              className={cn(
                "pointer-events-none absolute inset-x-0",
                landing?.kind === "rows" && landing.rows.has(row) && "bg-white/6",
              )}
              style={{ top: rowTop, height: layout.rowHeights[row] }}
            />
          ))}
          {boxes.map((box) => (moving.has(box.overlay.id) ? null : boxFor(box, { moving: false, top: blockTop(box.overlay.row) })))}
        </div>
      </div>

      {insertionY !== null && (
        <div
          aria-hidden="true"
          data-testid="stitch-overlay-insertion"
          className="pointer-events-none absolute inset-x-0 z-1 h-[3px] rounded-[2px] bg-neutral-100"
          style={{ top: Math.min(Math.max(insertionY - 1.5, 0), Math.max(0, layout.viewHeight - 3)) }}
        />
      )}
      {/* Over the section, out of the rows' clip: the moving boxes follow the pointer anywhere */}
      {move && (
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-10">
          {boxes.map((box) =>
            moving.has(box.overlay.id)
              ? boxFor(box, { moving: true, top: movingTop(box.overlay.row), shift: move.result.deltaSec })
              : null,
          )}
          {moveChip && lead && (
            <div
              ref={chipRef}
              data-testid="stitch-overlay-move-chip"
              className={cn(EDITOR_CHIP, "absolute z-20 whitespace-nowrap tabular-nums text-neutral-200")}
              style={{ left: leadX + lead.width + CHIP_GAP, top: movingTop(lead.overlay.row) + CHIP_DROP }}
            >
              {moveChip}
            </div>
          )}
          {move.result.snapped && snapText && (
            <SnapGuide
              x={axis.timeToX(move.result.snapped.t)}
              top={guideTop}
              bottom={leadBottom}
              chipTop={leadBottom + 8}
              text={snapText}
            />
          )}
        </div>
      )}
      {trim && trimChip && (
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-10">
          <div
            data-testid="stitch-overlay-trim-chip"
            className={cn(EDITOR_CHIP, "absolute whitespace-nowrap tabular-nums text-neutral-200")}
            style={{ left: trimEdgeX + 8, top: trimTop + 4 }}
          >
            {trimChip}
          </div>
          {trim.snapped && (
            <SnapGuide
              x={axis.timeToX(trim.snapped.t)}
              top={guideTop}
              bottom={trimTop + GEOMETRY.overlayBlock}
              chipTop={trimTop + 30}
              text={`Snapped to ${trim.snapped.label}`}
            />
          )}
        </div>
      )}
    </div>
  );
}
