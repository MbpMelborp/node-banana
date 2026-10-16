import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { dropIndexAt } from "@/lib/stitch/reorder";
import { moveClipTo } from "../editorActions";
import { releaseTypingFocus } from "./releaseTypingFocus";

/**
 * A pointer down on a clip's body: a click selects it, and a move of more
 * than 4px lifts it and drags it to a new place in the sequence. The place
 * is this hook's state until release, which moves the clip once (one undo
 * step). Escape puts it back. A release onto a draft that changed under the
 * drag is dropped (the editor's keys wait while it runs).
 */

export interface ReorderLive {
  clipId: string;
  index: number;
  /** Pointer travel since the press across the lane's content, px: a scroll during the drag (a wheel, the playback follow) counts, so the clip stays under the pointer. */
  dx: number;
  dropIndex: number;
}

const DRAG_START_PX = 4;

export function useClipReorder(
  boxes: ReadonlyArray<{ x: number; width: number }>,
  contentRef: RefObject<HTMLDivElement | null>,
) {
  const [reorder, setReorder] = useState<ReorderLive | null>(null);
  const latestBoxes = useRef(boxes);
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => {
    latestBoxes.current = boxes;
  }, [boxes]);
  useEffect(() => () => stop.current?.(), []);

  const onBodyPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>, clipId: string, index: number) => {
      if (event.button !== 0) return;
      // A focused In/Out field commits now, before the drag takes its picture of the draft
      releaseTypingFocus(event.currentTarget);
      stop.current?.();
      const timelineAtStart = useStitchEditorStore.getState().draft?.timeline;
      const target = event.currentTarget;
      const pointerId = event.pointerId;
      const startX = event.clientX;
      let current: ReorderLive | null = null;

      const laneX = (clientX: number) => clientX - (contentRef.current?.getBoundingClientRect().left ?? 0);
      const startLaneX = laneX(startX);
      let lastClientX = startX;
      const scroller = contentRef.current?.parentElement ?? null;
      const place = () => {
        const x = laneX(lastClientX);
        current = { clipId, index, dx: x - startLaneX, dropIndex: dropIndexAt(x, latestBoxes.current, index) };
        setReorder(current);
      };
      const onScroll = () => {
        if (current) place();
      };
      const end = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", end);
        scroller?.removeEventListener("scroll", onScroll);
        if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
        stop.current = null;
        setReorder(null);
        const s = useStitchEditorStore.getState();
        if (s.cancelGesture === end) s.setCancelGesture(null);
      };
      const onMove = (e: PointerEvent) => {
        if (!current && Math.abs(e.clientX - startX) <= DRAG_START_PX) return;
        if (!current) {
          target.setPointerCapture?.(pointerId);
          useStitchEditorStore.getState().setCancelGesture(end);
        }
        lastClientX = e.clientX;
        place();
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
