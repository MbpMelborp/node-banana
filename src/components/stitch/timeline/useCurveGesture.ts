import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { hitCurve, type CurveModel } from "@/lib/stitch/curveModel";
import { isContextClick, isToggleClick } from "../selectionActions";
import { releaseTypingFocus } from "./releaseTypingFocus";

/**
 * Editing a curve drawn over a box on the timeline (an audio clip's volume,
 * a video clip's speed), on a box the caller marks editable. A press on a
 * point drags it (its neighbours bound it); a press on the line adds a
 * point there and drags that, or, for a model that adds only on a drag,
 * adds it once the press travels; ⌥ held at the press moves the whole line
 * up or down where the model allows it. While the pointer moves the curve
 * is this hook's state only; on release it is written once (the added point
 * with its move), so a gesture is one undo step and nothing reaches the
 * workflow store. Escape cancels. A double-click on a point removes it. A
 * press that hits neither a point nor the line, or the line where the model
 * adds no point (the speed curve's pinned ends), is not the curve's
 * (onPointerDown says false), and the box takes it, as it takes a Mac's
 * Ctrl-press (the clip menu's) and a toggle or range click anywhere. Where
 * a line press drags a point near it instead (the model's `takes`), the
 * hover shows that point, not a point added. The pointer is read against
 * the lane's content, so a scroll during the drag keeps the point under it.
 */

/** Travel before a press moves anything, so a click that selects a point (or starts a double-click) leaves it put. */
const DRAG_START_PX = 3;
/** Two presses this close in time and on screen are a double-click's. */
const DOUBLE_PRESS_MS = 500;
const DOUBLE_PRESS_PX = 5;

export interface CurveGestureLive<C> {
  curve: C;
  /** The point being dragged; null while ⌥ moves the whole line, or a press on the line has not travelled yet. */
  index: number | null;
}

/** Where a press would add a point: on the line under the pointer, lane x and box y. */
export interface CurveHover {
  x: number;
  y: number;
}

export interface CurveGestureOptions<C> {
  /** The curve's maths on screen; the press measures with the one it saw last, which a zoom mid-drag cannot change. */
  model: CurveModel<C>;
  /** The lane content (pointer x is measured from its left) and the box (y from its top). */
  contentRef: RefObject<HTMLDivElement | null>;
  blockRef: RefObject<HTMLDivElement | null>;
  /** Off: every press is the box's. */
  editable: boolean;
  /** The curve as the draft holds it now (a stable reference while unchanged); undefined once the clip is gone. */
  read: () => C | undefined;
  /** One gesture's result, as one undo step. */
  write: (curve: C) => void;
  /** The clip selected with this curve point (null: none), its last press on the curve; absent where points are not selectable. */
  selectPoint?: (point: number | null) => void;
  /** A double-click on a point takes it off. */
  removePoint: (index: number) => void;
}

/** One press on the box, kept to tell a double-click's two apart. */
interface Press<C> {
  time: number;
  clientX: number;
  clientY: number;
  /** The curve took this press. */
  editable: boolean;
  /** The point it took, and the curve it took it on. */
  point: number | null;
  curve: C | undefined;
}

export function useCurveGesture<C>(options: CurveGestureOptions<C>) {
  const { contentRef, blockRef, editable } = options;
  const [live, setLive] = useState<CurveGestureLive<C> | null>(null);
  const [hover, setHover] = useState<CurveHover | null>(null);
  // The point a press at the pointer drags: under it, or near it on the line
  const [overPoint, setOverPoint] = useState<number | null>(null);
  const stop = useRef<(() => void) | null>(null);
  // The last press, and the one before it when the two make a double-click
  const lastPress = useRef<Press<C> | null>(null);
  const pairedPress = useRef<Press<C> | null>(null);
  // The press measures with the model it saw last, which a zoom mid-drag cannot change (the ⌘ wheel waits)
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });
  useEffect(() => () => stop.current?.(), []);

  const position = useCallback(
    (clientX: number, clientY: number) => ({
      x: clientX - (contentRef.current?.getBoundingClientRect().left ?? 0),
      y: clientY - (blockRef.current?.getBoundingClientRect().top ?? 0),
    }),
    [contentRef, blockRef],
  );

  /** Whether the curve takes the press: a point, the line, or ⌥ anywhere on an editable box. */
  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>): boolean => {
      if (event.button !== 0) return false;
      const { model, editable: canEdit, read, write, selectPoint } = latest.current;
      const curveAtStart = read();
      const prev = lastPress.current;
      const repeat =
        prev !== null &&
        event.timeStamp - prev.time < DOUBLE_PRESS_MS &&
        Math.hypot(event.clientX - prev.clientX, event.clientY - prev.clientY) <= DOUBLE_PRESS_PX;
      pairedPress.current = repeat ? prev : null;
      const press: Press<C> = {
        time: event.timeStamp,
        clientX: event.clientX,
        clientY: event.clientY,
        editable: false,
        point: null,
        curve: curveAtStart,
      };
      lastPress.current = press;
      if (curveAtStart === undefined || !canEdit) return false;
      // A Mac's Ctrl-press opens the clip menu, and a toggle or range click selects, here as anywhere on the box
      if (isContextClick(event) || isToggleClick(event) || event.shiftKey) return false;
      const at = position(event.clientX, event.clientY);
      const lineMove = event.altKey && model.shift !== undefined;
      const hit = lineMove ? null : hitCurve(model, curveAtStart, at.x, at.y);
      if (hit?.kind === "none") return false;
      // The line where the model adds no point (the speed curve's pinned ends) is the box's, as off the curve
      const addition = hit?.kind === "line" ? model.add(curveAtStart, at.x, at.y) : null;
      if (addition?.index === -1) return false;
      releaseTypingFocus(event.currentTarget);
      event.preventDefault();
      stop.current?.();
      press.editable = true;

      // The curve the move starts from, and the point it moves: an added point is on the line where it was pressed
      let base: C = curveAtStart;
      let index: number | null = null;
      let added = false;
      if (hit?.kind === "point") {
        index = hit.index;
        press.point = index;
        selectPoint?.(index);
      } else if (addition) {
        base = addition.curve;
        index = addition.index;
        added = true;
      } else {
        selectPoint?.(null);
      }
      // An added point the model writes only once the press travels: until then the stored line is drawn
      const deferred = added && !model.addOnClick;
      // The pointer's offset from the point's centre, in lane content and box coordinates
      const startPoint = index === null ? null : model.centre(base, index);
      const offsetX = startPoint ? at.x - startPoint.x : 0;
      const offsetY = startPoint ? at.y - startPoint.y : 0;

      const target = event.currentTarget;
      const pointerId = event.pointerId;
      target.setPointerCapture?.(pointerId);
      const scroller = contentRef.current?.parentElement ?? null;
      let lastClientX = event.clientX;
      let lastClientY = event.clientY;
      let moved = false;
      let current: CurveGestureLive<C> = { curve: base, index };

      // Measured on the lane's content as it is now, so a scroll since the press counts as travel
      const update = () => {
        const p = position(lastClientX, lastClientY);
        if (!moved && Math.hypot(p.x - at.x, p.y - at.y) < DRAG_START_PX) return;
        moved = true;
        if (index === null) {
          current = { curve: model.shift!(curveAtStart, p.y - at.y), index: null };
        } else {
          current = { curve: model.move(base, index, p.x - offsetX, p.y - offsetY), index };
        }
        setLive(current);
      };

      const end = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", end);
        scroller?.removeEventListener("scroll", update);
        if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
        stop.current = null;
        setLive(null);
        setOverPoint(null);
        const s = useStitchEditorStore.getState();
        if (s.cancelGesture === end) s.setCancelGesture(null);
      };
      const onMove = (e: PointerEvent) => {
        lastClientX = e.clientX;
        lastClientY = e.clientY;
        update();
      };
      const onUp = (e: PointerEvent) => {
        onMove(e);
        end();
        if (!moved && (!added || deferred)) return;
        // A draft that changed under the drag is not overwritten with what was measured against the old one
        if (latest.current.read() !== curveAtStart) return;
        write(current.curve);
        // The store forgets a point when the curve changes: the dragged one is selected again by its new index
        latest.current.selectPoint?.(current.index);
      };

      setHover(null);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", end);
      scroller?.addEventListener("scroll", update, { passive: true });
      stop.current = end;
      useStitchEditorStore.getState().setCancelGesture(end);
      setLive(deferred ? { curve: curveAtStart, index: null } : current);
      return true;
    },
    [position, contentRef],
  );

  /**
   * Removes a point only when both presses of the double-click took that point, on the lane as it is, and neither
   * changed the curve: a double-click that opened the lane, or one on the line, removes nothing.
   */
  const onDoubleClick = useCallback(() => {
    const first = pairedPress.current;
    const second = lastPress.current;
    const curve = latest.current.read();
    if (!latest.current.editable || curve === undefined || !first || !second) return;
    if (!first.editable || !second.editable || first.point === null || first.point !== second.point) return;
    if (first.curve !== curve || second.curve !== curve) return;
    latest.current.removePoint(second.point);
  }, []);

  /**
   * The hover ghost and its chip: over the line where a press adds a point, away from the points, no drag running.
   * Over a point, or the line where a press drags a point near it, that point instead.
   */
  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      // A drag keeps the point it pressed shown until it ends; its press hid the ghost
      if (stop.current) return;
      const { model, editable: canEdit, read } = latest.current;
      const curve = canEdit ? read() : undefined;
      if (curve === undefined || (event.altKey && model.shift !== undefined)) {
        setHover(null);
        setOverPoint(null);
        return;
      }
      const at = position(event.clientX, event.clientY);
      const hit = hitCurve(model, curve, at.x, at.y);
      const point = hit.kind === "point" ? hit.index : hit.kind === "line" ? (model.takes?.(curve, at.x) ?? -1) : -1;
      setOverPoint(point === -1 ? null : point);
      setHover(hit.kind === "line" && point === -1 ? model.hover(curve, at.x) : null);
    },
    [position],
  );
  const onPointerLeave = useCallback(() => {
    setHover(null);
    setOverPoint(null);
  }, []);

  return {
    live,
    hover: editable ? hover : null,
    /** The pointer is where a press drags a point. */
    overPoint: editable && overPoint !== null,
    /** The point a press at the pointer drags; null: none. */
    hoverPoint: editable ? overPoint : null,
    onPointerDown,
    onDoubleClick,
    onPointerMove,
    onPointerLeave,
  };
}
