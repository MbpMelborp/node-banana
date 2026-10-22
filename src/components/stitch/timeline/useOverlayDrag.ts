import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { flushSync } from "react-dom";
import { overlaySelectionOf, useStitchEditorStore } from "@/store/stitchEditorStore";
import { audioMoveAt, type AudioMoveResult, type AudioMoveTarget } from "@/lib/stitch/audioDrag";
import { overlayMoveTargets, overlayRowAt, overlayTrimAt, overlayTrimBounds } from "@/lib/stitch/overlayDrag";
import { clampOverlayScroll, overlayScrollTop, type OverlaySectionLayout } from "@/lib/stitch/overlayLayout";
import { draftOverlays, moveOverlays, overlayRowCount } from "@/lib/stitch/overlays";
import { MAX_START_SEC } from "@/lib/stitch/placement";
import type { TimeAxis } from "@/lib/stitch/timeAxis";
import type { ClipSpan } from "@/lib/stitch/timeline";
import type { StitchOverlay } from "@/types";
import { pause } from "../editorActions";
import { GEOMETRY } from "../editorStyles";
import { moveOverlaysBody, trimOverlayBody } from "../overlayActions";
import {
  clearTextSelection,
  clickOverlay,
  isContextClick,
  isToggleClick,
  keepOverlayGroupSelected,
  pressOverlayGroup,
} from "../selectionActions";
import { armed, DRAG_START_PX, edgeSpeed } from "./autoScroll";
import { releaseTypingFocus } from "./releaseTypingFocus";

/**
 * Dragging text layers' boxes, as audio boxes drag (useAudioClipDrag). A
 * press on a box's body that never travels 4px selects on release, and
 * playback goes on. Past that the preview pauses and the box (with the rest
 * of the selection, when it is one of several) follows the pointer: in time
 * by the lead's snapped delta (audioMoveAt), across rows by the row under
 * its centre (overlayRowAt: the rows run up from the video, and above the
 * top one is a new row), on the layout of the press. What release applies
 * (moveOverlays over the overlays at the press) is drawn as the landing: the
 * rows it lands on, the line where an overlap inserts a row, or a new row on
 * top. A press on an edge moves that edge of the layer alone (its start or
 * its end), the other kept. Release applies once (one undo step); a release
 * onto overlays that changed under the drag is dropped; Escape puts the
 * layers and both scrolls back. The lanes scroll sideways near their sides,
 * and the overlay rows near the top or bottom of their view.
 */

/** Where release puts a move, as drawn. */
export type OverlayLanding =
  | { kind: "none" }
  /** Onto existing rows (press rows, as numbered at the press). */
  | { kind: "rows"; rows: ReadonlySet<number> }
  /** Onto new rows inserted above this row (an overlap on the target row). */
  | { kind: "insert"; after: number }
  /** Onto a new row above the top one. */
  | { kind: "append" };

export interface OverlayMoveLive {
  kind: "move";
  /** The pressed layer, which snaps. */
  id: string;
  ids: readonly string[];
  result: AudioMoveResult;
  /** Pointer travel down the screen since the press, px: the moving boxes follow it. */
  dy: number;
  landing: OverlayLanding;
  /** The overlays at the press and what release applies. */
  from: StitchOverlay[];
  next: ReturnType<typeof moveOverlays>;
  /** How far the rows block was scrolled from its top at the press. */
  topAtPress: number;
}

export interface OverlayTrimLive {
  kind: "trim";
  id: string;
  edge: "in" | "out";
  /** The layer as release leaves it. */
  overlay: StitchOverlay;
  snapped: AudioMoveTarget | null;
}

export type OverlayDragLive = OverlayMoveLive | OverlayTrimLive;

export interface OverlayDragOptions {
  /** The overlay section's layout (the press's is kept for the drag). */
  layout: () => OverlaySectionLayout;
  /** The rows' scroll, kept from the bottom. */
  scroll: () => number;
  setScroll: (scroll: number) => void;
  /** The overlay rows' view on screen, for the up-and-down auto-scroll. */
  viewRect: () => DOMRect | null;
  videoSpans: () => readonly ClipSpan[];
  /** A layer's name in a snap chip: its first line, quoted. */
  nameOf: (overlay: StitchOverlay) => string;
}

const overlaysNow = () => {
  const draft = useStitchEditorStore.getState().draft;
  return draft ? draftOverlays(draft) : null;
};

function landingOf(
  from: readonly StitchOverlay[],
  next: ReturnType<typeof moveOverlays>,
  ids: ReadonlySet<string>,
): OverlayLanding {
  if (next.overlays === from) return { kind: "none" };
  if (next.insertedAfter !== null) return { kind: "insert", after: next.insertedAfter };
  const rows = new Set(next.overlays.filter((o) => ids.has(o.id)).map((o) => o.row));
  const rowCount = overlayRowCount(from);
  if ([...rows].some((row) => row >= rowCount)) return { kind: "append" };
  return { kind: "rows", rows };
}

/** axisNow: the lane's axis for the editor's state at the press (useTimelineZoom). */
export function useOverlayDrag(
  axisNow: () => TimeAxis,
  contentRef: RefObject<HTMLDivElement | null>,
  options: OverlayDragOptions,
) {
  const [drag, setDrag] = useState<OverlayDragLive | null>(null);
  const latestOptions = useRef(options);
  const stop = useRef<(() => void) | null>(null);
  // From the press to the release: the ⌘ wheel waits
  const pressing = useRef(false);
  useEffect(() => {
    latestOptions.current = options;
  });
  useEffect(() => () => stop.current?.(), []);

  /** Pointer and key listeners for one gesture; returns its end. */
  const listen = useCallback(
    (handlers: {
      onMove: (e: PointerEvent) => void;
      onUp: (e: PointerEvent) => void;
      onShift: (e: KeyboardEvent) => void;
      onScroll: () => void;
      end: () => void;
    }) => {
      const scroller = contentRef.current?.parentElement ?? null;
      window.addEventListener("pointermove", handlers.onMove);
      window.addEventListener("pointerup", handlers.onUp);
      window.addEventListener("pointercancel", handlers.end);
      window.addEventListener("keydown", handlers.onShift);
      window.addEventListener("keyup", handlers.onShift);
      scroller?.addEventListener("scroll", handlers.onScroll, { passive: true });
      return () => {
        window.removeEventListener("pointermove", handlers.onMove);
        window.removeEventListener("pointerup", handlers.onUp);
        window.removeEventListener("pointercancel", handlers.end);
        window.removeEventListener("keydown", handlers.onShift);
        window.removeEventListener("keyup", handlers.onShift);
        scroller?.removeEventListener("scroll", handlers.onScroll);
      };
    },
    [contentRef],
  );

  const onBodyPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>, id: string) => {
      if (event.button !== 0 || isContextClick(event)) return;
      releaseTypingFocus(event.currentTarget);
      clearTextSelection();
      stop.current?.();
      const mods = { toggle: isToggleClick(event), range: event.shiftKey };
      const from = overlaysNow();
      const lead = from?.find((o) => o.id === id);
      if (!from || !lead) return;
      const group = pressOverlayGroup(id);
      const groupSet = new Set(group);
      const axis = axisNow();
      const layout = latestOptions.current.layout();
      const topAtPress = overlayScrollTop(latestOptions.current.scroll(), layout);
      const target = event.currentTarget;
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startY = event.clientY;
      const scroller = contentRef.current?.parentElement ?? null;
      const scrollLeftAtPress = scroller?.scrollLeft ?? 0;
      const scrollAtPress = latestOptions.current.scroll();
      const laneX = (clientX: number) => clientX - (contentRef.current?.getBoundingClientRect().left ?? 0);
      const startLaneX = laneX(startX);
      // The lead's block centre in the rows block at the press
      const centreAtPress = (layout.rowTops[lead.row] ?? 0) + GEOMETRY.overlayBlockTop + GEOMETRY.overlayBlock / 2;
      const groupStarts = from.filter((o) => groupSet.has(o.id)).map((o) => o.startSec);
      const leadSpan = {
        start: lead.startSec,
        length: lead.endSec - lead.startSec,
        min: lead.startSec - Math.min(...groupStarts),
        max: MAX_START_SEC - (Math.max(...groupStarts) - lead.startSec),
      };
      pressing.current = true;
      let targets: AudioMoveTarget[] = [];
      let lifted = false;
      let lastClientX = startX;
      let lastClientY = startY;
      let lastShift = event.shiftKey;
      let row = lead.row;
      let current: OverlayMoveLive | null = null;

      const place = () => {
        if (!lifted) return;
        const snap = useStitchEditorStore.getState().snap && !lastShift;
        const result = audioMoveAt(axis, leadSpan, laneX(lastClientX) - startLaneX, targets, { snap });
        const topNow = overlayScrollTop(latestOptions.current.scroll(), layout);
        const centre = centreAtPress + (lastClientY - startY) + (topNow - topAtPress);
        row = overlayRowAt(centre, row, layout.rowTops.length);
        const next = moveOverlays(from, group, result.deltaSec, row - lead.row);
        current = {
          kind: "move",
          id,
          ids: group,
          result,
          dy: lastClientY - startY,
          landing: landingOf(from, next, groupSet),
          from,
          next,
          topAtPress,
        };
        setDrag(current);
      };

      // Sideways near the lanes' sides, up and down near the rows view's top or bottom
      let speedX = 0;
      let speedY = 0;
      let frame = 0;
      const step = () => {
        frame = 0;
        if (!current || (speedX === 0 && speedY === 0)) return;
        if (speedX !== 0 && scroller) scroller.scrollLeft += speedX;
        if (speedY !== 0) {
          const { scroll, setScroll } = latestOptions.current;
          // Down the screen is down the rows: toward row 0, less scrolled up from the bottom
          const next = clampOverlayScroll(scroll() - speedY, layout);
          if (next !== scroll()) flushSync(() => setScroll(next));
        }
        flushSync(place);
        frame = requestAnimationFrame(step);
      };
      const autoScroll = (clientX: number, clientY: number) => {
        const lanes = scroller?.getBoundingClientRect();
        const view = latestOptions.current.viewRect();
        speedX = lanes && lanes.right > lanes.left ? armed(edgeSpeed(clientX, lanes.left, lanes.right), clientX - startX) : 0;
        speedY = view && layout.maxScroll > 0 ? armed(edgeSpeed(clientY, view.top, view.bottom), clientY - startY) : 0;
        if ((speedX !== 0 || speedY !== 0) && !frame) frame = requestAnimationFrame(step);
      };

      let unlisten = () => {};
      const end = () => {
        unlisten();
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        speedX = 0;
        speedY = 0;
        if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
        pressing.current = false;
        stop.current = null;
        current = null;
        setDrag(null);
        const s = useStitchEditorStore.getState();
        if (s.cancelGesture === cancel) s.setCancelGesture(null);
      };
      // Escape: the layers stay where they were, and both scrolls go back to where the press found them
      const cancel = () => {
        if (scroller) scroller.scrollLeft = scrollLeftAtPress;
        latestOptions.current.setScroll(scrollAtPress);
        end();
      };
      const lift = () => {
        lifted = true;
        target.setPointerCapture?.(pointerId);
        useStitchEditorStore.getState().setCancelGesture(cancel);
        // The playhead stops before it is taken as a target, so the target is where it is drawn
        pause();
        const s = useStitchEditorStore.getState();
        const { videoSpans, nameOf } = latestOptions.current;
        targets = overlayMoveTargets(from, videoSpans(), groupSet, Math.min(s.playhead, axis.total), axis.total, nameOf);
      };
      const onMove = (e: PointerEvent) => {
        if (!lifted) {
          if (Math.max(Math.abs(e.clientX - startX), Math.abs(e.clientY - startY)) <= DRAG_START_PX) return;
          // A key changed the overlays while the button was down: the press's picture of them is stale
          if (overlaysNow() !== from || !target.isConnected) {
            end();
            return;
          }
          lift();
        }
        lastClientX = e.clientX;
        lastClientY = e.clientY;
        lastShift = e.shiftKey;
        place();
        autoScroll(e.clientX, e.clientY);
      };
      const onShift = (e: KeyboardEvent) => {
        if (e.key !== "Shift" || e.shiftKey === lastShift) return;
        lastShift = e.shiftKey;
        place();
      };
      const onUp = () => {
        const moved = current;
        const wasLifted = lifted;
        end();
        if (overlaysNow() !== from) return;
        if (!wasLifted) {
          clickOverlay(id, mods);
          return;
        }
        if (moved) moveOverlaysBody(from, moved.next);
        keepOverlayGroupSelected(group, id);
      };

      unlisten = listen({ onMove, onUp, onShift, onScroll: place, end });
      stop.current = end;
    },
    [axisNow, contentRef, listen],
  );

  const onHandlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>, id: string, edge: "in" | "out") => {
      if (event.button !== 0 || isContextClick(event)) return;
      releaseTypingFocus(event.currentTarget);
      clearTextSelection();
      event.preventDefault();
      event.stopPropagation();
      stop.current?.();
      const editor = useStitchEditorStore.getState();
      const from = overlaysNow();
      const o = from?.find((other) => other.id === id);
      if (!from || !o) return;
      const axis = axisNow();
      const handle = event.currentTarget;
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const laneX = (clientX: number) => clientX - (contentRef.current?.getBoundingClientRect().left ?? 0);
      const startLaneX = laneX(startX);
      handle.setPointerCapture?.(pointerId);
      pause();
      editor.select(overlaySelectionOf({ clipId: id }));
      pressing.current = true;

      const bounds = overlayTrimBounds(from, o, edge);
      const { videoSpans, nameOf } = latestOptions.current;
      const targets = overlayMoveTargets(
        from,
        videoSpans(),
        new Set([id]),
        Math.min(editor.playhead, axis.total),
        axis.total,
        nameOf,
      );
      let moved = false;
      let lastClientX = startX;
      let lastShift = event.shiftKey;
      let current: OverlayTrimLive | null = null;

      const place = () => {
        const snap = moved && useStitchEditorStore.getState().snap && !lastShift;
        const result = overlayTrimAt(axis, o, edge, moved ? laneX(lastClientX) - startLaneX : 0, bounds, targets, { snap });
        const live: StitchOverlay =
          edge === "in" ? { ...o, startSec: result.startSec ?? o.startSec } : { ...o, endSec: result.endSec ?? o.endSec };
        current = { kind: "trim", id, edge, overlay: live, snapped: result.snapped };
        setDrag(current);
      };

      let unlisten = () => {};
      const end = () => {
        unlisten();
        if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
        pressing.current = false;
        stop.current = null;
        current = null;
        setDrag(null);
        const s = useStitchEditorStore.getState();
        if (s.cancelGesture === end) s.setCancelGesture(null);
      };
      const onMove = (e: PointerEvent) => {
        if (!moved && Math.abs(e.clientX - startX) <= DRAG_START_PX) return;
        moved = true;
        lastClientX = e.clientX;
        lastShift = e.shiftKey;
        place();
      };
      const onShift = (e: KeyboardEvent) => {
        if (e.key !== "Shift" || e.shiftKey === lastShift) return;
        lastShift = e.shiftKey;
        if (moved) place();
      };
      const onUp = () => {
        const live = current;
        end();
        if (!moved || !live) return;
        trimOverlayBody(from, id, edge === "in" ? { startSec: live.overlay.startSec } : { endSec: live.overlay.endSec });
      };

      unlisten = listen({ onMove, onUp, onShift, onScroll: () => moved && place(), end });
      stop.current = end;
      useStitchEditorStore.getState().setCancelGesture(end);
      place();
    },
    [axisNow, contentRef, listen],
  );

  return { drag, onBodyPointerDown, onHandlePointerDown, pressing };
}
