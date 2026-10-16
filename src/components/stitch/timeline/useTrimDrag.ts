import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { trimDragAt, trimTargets, type TrimDragResult, type TrimDragStart } from "@/lib/stitch/trimDrag";
import { clipSpans, sourceKey, trimClip, type ClipSpan } from "@/lib/stitch/timeline";
import type { TimeAxis } from "@/lib/stitch/timeAxis";
import { pause } from "../editorActions";
import { releaseTypingFocus } from "./releaseTypingFocus";

/**
 * Dragging a clip's In or Out handle. While the pointer moves, the trim is
 * this hook's state only; on release it is applied to the draft once, so a
 * drag is one undo step and nothing reaches the workflow store. A press
 * that never moves changes nothing. Shift turns snapping off for the move it
 * is held on; Escape cancels. The editor's other keys and the ⌘ wheel zoom
 * wait while it runs (useStitchEditorKeys, Timeline), and a release onto a
 * draft that changed under the drag anyway is dropped.
 */

export interface TrimLive {
  clipId: string;
  edge: "in" | "out";
  start: TrimDragStart;
  result: TrimDragResult;
  /** The lane content's top-left on screen, and the visible lanes' sides, for the frame popover outside the lane. */
  laneLeft: number;
  laneTop: number;
  viewLeft: number;
  viewRight: number;
}

/** axisNow: the lane's axis for the editor's state at the press (useTimelineZoom), after the field's blur. */
export function useTrimDrag(axisNow: () => TimeAxis, contentRef: RefObject<HTMLDivElement | null>) {
  const [trim, setTrim] = useState<TrimLive | null>(null);
  const live = useRef<TrimLive | null>(null);
  const stop = useRef<(() => void) | null>(null);

  useEffect(() => () => stop.current?.(), []);

  const onHandlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>, pressed: ClipSpan, edge: "in" | "out") => {
      if (event.button !== 0 || !contentRef.current) return;
      // A focused In/Out field commits (or reverts) now, so the editor's Escape reaches this drag
      releaseTypingFocus(event.currentTarget);
      event.preventDefault();
      event.stopPropagation();
      stop.current?.();
      const handle = event.currentTarget;
      const pointerId = event.pointerId;
      const startClientX = event.clientX;

      // The draft as it is now (the field's blur may just have changed it), not as the last render saw it
      const editor = useStitchEditorStore.getState();
      const timelineAtStart = editor.draft?.timeline;
      if (!timelineAtStart) return;
      const spans = clipSpans(timelineAtStart, editor.durations);
      const span = spans.find((s) => s.clip.id === pressed.clip.id);
      if (!span) return;
      // In Fit, a length the blur changed changes the zoom the lane re-renders at: measure with that one
      const axis = axisNow();
      handle.setPointerCapture?.(pointerId);
      // The playhead holds still for the drag: it is one of the targets
      pause();
      editor.select({ kind: "clip", clipId: span.clip.id });

      const laneX = (clientX: number) => clientX - (contentRef.current?.getBoundingClientRect().left ?? 0);
      const start: TrimDragStart = {
        span,
        edge,
        sourceDuration: editor.durations.get(sourceKey(span.clip.source)),
        pointerX: laneX(startClientX),
        pxPerSec: axis.pxPerSec,
        xToTime: axis.xToTime,
        // The playhead as drawn: one left past a sequence that got shorter sits at its end
        targets: trimTargets(spans, span.clip.id, edge, Math.min(editor.playhead, axis.total)),
      };
      let moved = false;
      const update = (clientX: number, shiftKey: boolean) => {
        const content = contentRef.current;
        const rect = content?.getBoundingClientRect();
        const visible = content?.parentElement?.getBoundingClientRect();
        // Until the pointer moves, the edge stays where it is (no snap on the press)
        const snap = moved && useStitchEditorStore.getState().snap && !shiftKey;
        const next: TrimLive = {
          clipId: span.clip.id,
          edge,
          start,
          result: trimDragAt(start, moved ? laneX(clientX) : start.pointerX, { snap }),
          laneLeft: rect?.left ?? 0,
          laneTop: rect?.top ?? 0,
          viewLeft: visible?.left ?? 0,
          viewRight: visible?.right ?? 0,
        };
        live.current = next;
        setTrim(next);
      };

      const end = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", end);
        if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
        live.current = null;
        stop.current = null;
        setTrim(null);
        const s = useStitchEditorStore.getState();
        if (s.cancelGesture === end) s.setCancelGesture(null);
      };
      const onMove = (e: PointerEvent) => {
        if (!moved && Math.abs(e.clientX - startClientX) < 1) return;
        moved = true;
        update(e.clientX, e.shiftKey);
      };
      const onUp = (e: PointerEvent) => {
        onMove(e);
        const result = live.current?.result;
        end();
        if (!moved || !result) return;
        const s = useStitchEditorStore.getState();
        if (s.draft?.timeline !== timelineAtStart) return;
        const patch = edge === "out" ? { outSec: result.outSec } : { inSec: result.inSec };
        s.apply((d) => ({ ...d, timeline: trimClip(d.timeline, span.clip.id, s.durations, patch) }));
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", end);
      stop.current = end;
      useStitchEditorStore.getState().setCancelGesture(end);
      update(startClientX, event.shiftKey);
    },
    [axisNow, contentRef],
  );

  return { trim, onHandlePointerDown };
}
