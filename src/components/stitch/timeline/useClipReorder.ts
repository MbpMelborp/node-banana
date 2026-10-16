import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { dropIndexAt, stackedDropIndex } from "@/lib/stitch/reorder";
import { moveClipTo } from "../editorActions";
import { GEOMETRY } from "../editorStyles";
import { releaseTypingFocus } from "./releaseTypingFocus";

/**
 * A pointer down on a clip's body: a click selects it, and a move of more
 * than 4px lifts it and drags it to a new place in the sequence. The place
 * is this hook's state until release, which moves the clip once (one undo
 * step). Escape puts it back. A release onto a draft that changed under the
 * drag is dropped (the editor's keys wait while it runs).
 *
 * In Stacked the drag is vertical, from a clip's box or its row header: the
 * place comes from the lifted box's centre crossing half a row, and the
 * rows scroll by themselves while the pointer is near their top or bottom.
 */

export interface ReorderLive {
  clipId: string;
  index: number;
  /** Pointer travel since the press across the lane's content, px: a scroll during the drag (a wheel, the playback follow) counts, so the clip stays under the pointer. */
  dx: number;
  /** The same down the rows (Stacked; 0 in Track). */
  dy: number;
  /** The pointer on the lane's content, px: Stacked's sideways chip sits beside it. */
  x: number;
  y: number;
  dropIndex: number;
}

export interface ReorderOptions {
  /** Rows, not a row: the drag is vertical. */
  stacked?: boolean;
  rowCount?: number;
  /** The visible rows' band on screen (clientY), for the auto-scroll; null while it is not laid out. */
  rowsView?: () => { top: number; bottom: number } | null;
}

const DRAG_START_PX = 4;
/** Stacked: the rows scroll while the pointer is this near their top or bottom, this far each frame. */
const AUTO_SCROLL_EDGE_PX = 20;
const AUTO_SCROLL_STEP_PX = 6;

export function useClipReorder(
  boxes: ReadonlyArray<{ x: number; width: number }>,
  contentRef: RefObject<HTMLDivElement | null>,
  options: ReorderOptions = {},
) {
  const [reorder, setReorder] = useState<ReorderLive | null>(null);
  const latestBoxes = useRef(boxes);
  const latestOptions = useRef(options);
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => {
    latestBoxes.current = boxes;
    latestOptions.current = options;
  });
  useEffect(() => () => stop.current?.(), []);

  const onBodyPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>, clipId: string, index: number) => {
      if (event.button !== 0) return;
      // A focused In/Out field commits now, before the drag takes its picture of the draft
      releaseTypingFocus(event.currentTarget);
      stop.current?.();
      const timelineAtStart = useStitchEditorStore.getState().draft?.timeline;
      const { stacked = false, rowCount = 0 } = latestOptions.current;
      const target = event.currentTarget;
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startY = event.clientY;
      let current: ReorderLive | null = null;

      const contentRect = () => contentRef.current?.getBoundingClientRect();
      const laneX = (clientX: number) => clientX - (contentRect()?.left ?? 0);
      const laneY = (clientY: number) => clientY - (contentRect()?.top ?? 0);
      const startLaneX = laneX(startX);
      const startLaneY = laneY(startY);
      let lastClientX = startX;
      let lastClientY = startY;
      const scroller = contentRef.current?.parentElement ?? null;
      const place = () => {
        const x = laneX(lastClientX);
        const y = laneY(lastClientY);
        const dy = stacked ? y - startLaneY : 0;
        const dropIndex = stacked
          ? stackedDropIndex(index, dy, rowCount, GEOMETRY.stackRow)
          : dropIndexAt(x, latestBoxes.current, index);
        current = { clipId, index, dx: x - startLaneX, dy, x, y, dropIndex };
        setReorder(current);
      };
      const onScroll = () => {
        if (current) place();
      };

      // Stacked: scroll the rows while the pointer rests near their edge; each scroll re-places the drop
      let speed = 0;
      let frame = 0;
      const step = () => {
        frame = 0;
        if (!current || speed === 0 || !scroller) return;
        scroller.scrollTop += speed;
        frame = requestAnimationFrame(step);
      };
      const autoScroll = (clientY: number) => {
        const view = stacked ? latestOptions.current.rowsView?.() : null;
        speed = !view
          ? 0
          : clientY < view.top + AUTO_SCROLL_EDGE_PX
            ? -AUTO_SCROLL_STEP_PX
            : clientY > view.bottom - AUTO_SCROLL_EDGE_PX
              ? AUTO_SCROLL_STEP_PX
              : 0;
        if (speed !== 0 && !frame) frame = requestAnimationFrame(step);
      };

      const end = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", end);
        scroller?.removeEventListener("scroll", onScroll);
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        speed = 0;
        if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
        stop.current = null;
        setReorder(null);
        const s = useStitchEditorStore.getState();
        if (s.cancelGesture === end) s.setCancelGesture(null);
      };
      const onMove = (e: PointerEvent) => {
        const travel = stacked
          ? Math.max(Math.abs(e.clientX - startX), Math.abs(e.clientY - startY))
          : Math.abs(e.clientX - startX);
        if (!current && travel <= DRAG_START_PX) return;
        if (!current) {
          target.setPointerCapture?.(pointerId);
          useStitchEditorStore.getState().setCancelGesture(end);
        }
        lastClientX = e.clientX;
        lastClientY = e.clientY;
        place();
        autoScroll(e.clientY);
      };
      const onUp = () => {
        const moved = current;
        end();
        const s = useStitchEditorStore.getState();
        if (s.draft?.timeline !== timelineAtStart) return;
        s.select({ kind: "clip", clipId });
        if (moved && moved.dropIndex !== index) moveClipTo(clipId, moved.dropIndex);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", end);
      scroller?.addEventListener("scroll", onScroll, { passive: true });
      stop.current = end;
    },
    [contentRef],
  );

  return { reorder, onBodyPointerDown };
}
