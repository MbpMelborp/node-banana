import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { flushSync } from "react-dom";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { draftSpans } from "@/lib/stitch/draft";
import { moveDragAt, moveRowAt, moveTargets, type MoveDragResult, type MoveDragStart } from "@/lib/stitch/moveDrag";
import type { TimeAxis } from "@/lib/stitch/timeAxis";
import { placeClip } from "@/lib/stitch/timeline";
import type { StitchTimelineClip } from "@/types";
import { moveClipBody, pause } from "../editorActions";
import { GEOMETRY } from "../editorStyles";
import { releaseTypingFocus } from "./releaseTypingFocus";

/**
 * Stacked's body drag: a press on a clip's box (or an empty clip's slot)
 * moves it in time and across rows in one gesture. A press that never
 * travels 4px only selects the clip, and playback goes on; past that the
 * clip lifts, the preview pauses, and the box follows the pointer on both
 * axes. Its start snaps (⇧ turns that off, also while the pointer rests);
 * it lands in the row under its centre, which changes only past half a row
 * and 4px more. The lanes scroll by themselves while the pointer is near
 * their sides, the rows near their top or bottom, once the pointer has moved
 * toward that edge since the press: a box pressed near an edge and dragged
 * along the other axis scrolls nothing. Until release the move is this
 * hook's state; release applies exactly what was drawn, once (one undo
 * step), and Escape puts the clip and the scroll back. A press whose draft
 * changes before the lift (a key, while the button is down) ends without a
 * drag, and a release onto a draft that changed under the drag is dropped.
 *
 * The row header's drag (rows only) is useClipReorder's.
 */

export interface MoveLive {
  clipId: string;
  /** Its row at the press. */
  index: number;
  /** The row it lands in. */
  dropIndex: number;
  result: MoveDragResult;
  /** What release applies: the press's timeline with the clip at its new start and row, every clip pinned. */
  timeline: StitchTimelineClip[];
  /** The box's left on the press axis, px. */
  x: number;
  /** Pointer travel down the rows since the press, px (a scroll of the rows counts). */
  dy: number;
}

export interface MoveOptions {
  rowCount: number;
  /** The visible rows' band on screen (clientY), for the auto-scroll; null while it is not laid out. */
  rowsView: () => { top: number; bottom: number } | null;
  /** The lanes' content width as last drawn, px. */
  drawnWidth: () => number;
}

/** The lanes' width a release was drawn at, on the zoom it was drawn at. */
export interface ReleasedWidth {
  width: number;
  pxPerSec: number;
}

const DRAG_START_PX = 4;
/** The lanes scroll while the pointer is this near their sides or the rows' top or bottom, this far each frame. */
const AUTO_SCROLL_EDGE_PX = 20;
const AUTO_SCROLL_STEP_PX = 6;

const edgeSpeed = (at: number, from: number, to: number) =>
  at < from + AUTO_SCROLL_EDGE_PX ? -AUTO_SCROLL_STEP_PX : at > to - AUTO_SCROLL_EDGE_PX ? AUTO_SCROLL_STEP_PX : 0;
/** An edge's scroll, only once the pointer has travelled toward that edge since the press (travel: now − press). */
const armed = (speed: number, travel: number) =>
  (speed > 0 && travel > DRAG_START_PX) || (speed < 0 && travel < -DRAG_START_PX) ? speed : 0;

/** axisNow: the lane's axis for the editor's state at the press (useTimelineZoom), after a field's blur. */
export function useClipMove(
  axisNow: () => TimeAxis,
  contentRef: RefObject<HTMLDivElement | null>,
  options: MoveOptions,
) {
  const [move, setMove] = useState<MoveLive | null>(null);
  /** The width the last release that moved a clip was drawn at: the lanes hold it while they are scrolled into it. */
  const [releasedWidth, setReleasedWidth] = useState<ReleasedWidth | null>(null);
  /** The clip a release just moved, until the lane has drawn it: the lane's reveal of a moved clip leaves it alone. */
  const released = useRef<string | null>(null);
  const latestOptions = useRef(options);
  const stop = useRef<(() => void) | null>(null);
  // From the press to the release: the ⌘ wheel waits, so nothing zooms under the press's axis before the lift
  const pressing = useRef(false);
  useEffect(() => {
    latestOptions.current = options;
  });
  useEffect(() => () => stop.current?.(), []);

  const onMovePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>, clipId: string, index: number) => {
      if (event.button !== 0) return;
      // A focused field commits now, before the drag takes its picture of the draft
      releaseTypingFocus(event.currentTarget);
      stop.current?.();
      const editor = useStitchEditorStore.getState();
      const draftAtStart = editor.draft;
      if (!draftAtStart) return;
      const durationsAtStart = editor.durations;
      const spansAtStart = draftSpans(draftAtStart, durationsAtStart);
      const span = spansAtStart.find((s) => s.clip.id === clipId);
      if (!span) return;
      const overlapSec = draftAtStart.sequenceLayout.overlapSec;
      const axis = axisNow();
      const target = event.currentTarget;
      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startY = event.clientY;
      const scroller = contentRef.current?.parentElement ?? null;
      const scrollAtStart = { left: scroller?.scrollLeft ?? 0, top: scroller?.scrollTop ?? 0 };

      const contentRect = () => contentRef.current?.getBoundingClientRect();
      const laneX = (clientX: number) => clientX - (contentRect()?.left ?? 0);
      const laneY = (clientY: number) => clientY - (contentRect()?.top ?? 0);
      const startLaneX = laneX(startX);
      const startLaneY = laneY(startY);
      let lastClientX = startX;
      let lastClientY = startY;
      let lastShift = event.shiftKey;
      let start: MoveDragStart | null = null;
      let current: MoveLive | null = null;
      // Where the last place() measured the pointer in the lanes: a scroll event after the auto-scroll's own re-place
      // finds nothing new
      let placedAt = "";
      pressing.current = true;

      const place = () => {
        if (!start) return;
        const x = laneX(lastClientX);
        const dy = laneY(lastClientY) - startLaneY;
        const snap = useStitchEditorStore.getState().snap && !lastShift;
        const at = `${x}|${dy}|${snap}`;
        if (current && at === placedAt) return;
        placedAt = at;
        const result = moveDragAt(start, x, { snap });
        const { rowCount } = latestOptions.current;
        const dropIndex = moveRowAt(index, dy, current?.dropIndex ?? index, rowCount, GEOMETRY.stackRow);
        // The same place gives the same timeline: the lane's marks are not built again for a pointer that moved within it
        const timeline =
          current && current.result.startSec === result.startSec && current.dropIndex === dropIndex
            ? current.timeline
            : placeClip(draftAtStart.timeline, durationsAtStart, clipId, result.startSec, dropIndex, overlapSec);
        current = { clipId, index, dropIndex, result, timeline, x: axis.timeToX(result.startSec), dy };
        setMove(current);
      };
      const onScroll = () => place();

      // Near a side of the lanes, or the top or bottom of the rows, they scroll; each scroll re-places the clip
      let speedX = 0;
      let speedY = 0;
      let frame = 0;
      // The box is re-placed and drawn in the frame that scrolled, so it never trails the pointer by a frame and the
      // release applies what is on screen
      const step = () => {
        frame = 0;
        if (!current || !scroller || (speedX === 0 && speedY === 0)) return;
        if (speedX !== 0) scroller.scrollLeft += speedX;
        if (speedY !== 0) scroller.scrollTop += speedY;
        flushSync(place);
        frame = requestAnimationFrame(step);
      };
      // An edge the press was already near scrolls only once the pointer heads for it: a sideways drag of a box in a
      // half-shown bottom row keeps its row, and an upward drag of a box pressed by the lanes' right side keeps its time
      const autoScroll = (clientX: number, clientY: number) => {
        const lanes = scroller?.getBoundingClientRect();
        const rows = latestOptions.current.rowsView();
        speedX = lanes && lanes.right > lanes.left ? armed(edgeSpeed(clientX, lanes.left, lanes.right), clientX - startX) : 0;
        speedY = rows ? armed(edgeSpeed(clientY, rows.top, rows.bottom), clientY - startY) : 0;
        if ((speedX !== 0 || speedY !== 0) && !frame) frame = requestAnimationFrame(step);
      };

      const end = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", end);
        window.removeEventListener("keydown", onShift);
        window.removeEventListener("keyup", onShift);
        scroller?.removeEventListener("scroll", onScroll);
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        speedX = 0;
        speedY = 0;
        if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
        pressing.current = false;
        stop.current = null;
        current = null;
        setMove(null);
        const s = useStitchEditorStore.getState();
        if (s.cancelGesture === cancel) s.setCancelGesture(null);
      };
      // Escape: the clip stays where it was, and the lanes go back to where the press found them
      const cancel = () => {
        if (scroller) {
          scroller.scrollLeft = scrollAtStart.left;
          scroller.scrollTop = scrollAtStart.top;
        }
        end();
      };
      const lift = () => {
        target.setPointerCapture?.(pointerId);
        useStitchEditorStore.getState().setCancelGesture(cancel);
        // The playhead stops before it is taken as a target, so the target is where it is drawn
        pause();
        const s = useStitchEditorStore.getState();
        start = {
          clipId,
          startSec: span.start,
          lengthSec: span.length,
          pointerX: startLaneX,
          pxPerSec: axis.pxPerSec,
          targets: moveTargets(spansAtStart, clipId, Math.min(s.playhead, axis.total), overlapSec),
        };
        scroller?.addEventListener("scroll", onScroll, { passive: true });
        window.addEventListener("keydown", onShift);
        window.addEventListener("keyup", onShift);
      };
      const onMove = (e: PointerEvent) => {
        if (!start) {
          const travel = Math.max(Math.abs(e.clientX - startX), Math.abs(e.clientY - startY));
          if (travel <= DRAG_START_PX) return;
          // A key changed the draft while the button was down (or removed the pressed clip): the press's picture of it
          // is stale, so there is nothing to drag
          if (useStitchEditorStore.getState().draft?.timeline !== draftAtStart.timeline || !target.isConnected) {
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
      // ⇧ pressed or let go while the pointer rests: snapping turns off or on where the clip is
      const onShift = (e: KeyboardEvent) => {
        if (e.key !== "Shift" || e.shiftKey === lastShift) return;
        lastShift = e.shiftKey;
        place();
      };
      const onUp = () => {
        const moved = current;
        const width = latestOptions.current.drawnWidth();
        end();
        const s = useStitchEditorStore.getState();
        if (s.draft?.timeline !== draftAtStart.timeline) return;
        s.select({ kind: "clip", clipId });
        if (moved && moved.timeline !== draftAtStart.timeline) {
          released.current = clipId;
          setReleasedWidth({ width, pxPerSec: axis.pxPerSec });
          moveClipBody(clipId, moved.timeline);
        }
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", end);
      stop.current = end;
    },
    [axisNow, contentRef],
  );

  /** The clip the last release moved, once: the lane's reveal asks, and leaves that move where it was drawn. */
  const takeReleased = useCallback(() => {
    const clipId = released.current;
    released.current = null;
    return clipId;
  }, []);

  return { move, onMovePointerDown, pressing, takeReleased, releasedWidth };
}
