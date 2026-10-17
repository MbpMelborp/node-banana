"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { cn } from "@/components/nodes/ui/cn";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { clipName } from "@/lib/stitch/labels";
import { gaps as envelopeGaps, weightPieces, type WeightPiece } from "@/lib/stitch/placement";
import { stackedInsertionY } from "@/lib/stitch/reorder";
import { clipIdsOf, type HitBox } from "@/lib/stitch/selection";
import { DEFAULT_SEQUENCE_LAYOUT, effectiveOverlapSec } from "@/lib/stitch/stack";
import {
  clipSpans,
  isPlaced,
  layoutSpans,
  moveClip,
  pinStarts,
  shiftRows,
  spansEnvelope,
  topSpanAt,
  type ClipSpan,
} from "@/lib/stitch/timeline";
import type { StitchTimelineClip, VolumePoint } from "@/types";
import { buildTimeAxis } from "@/lib/stitch/timeAxis";
import { insetBox, laneBoxes, liveSpans, stackedBoxes, trimEdgeX } from "@/lib/stitch/laneLayout";
import { liveFitZoom } from "../liveFitZoom";
import { GEOMETRY, LANE_TRAILING_PX } from "../editorStyles";
import type { ClipMediaView, MusicView } from "../useStitchEditorMedia";
import { AudioLane } from "./AudioLane";
import { ClipContextMenu } from "./ClipContextMenu";
import { ClipsLane } from "./ClipsLane";
import { MoveOverlay } from "./MoveOverlay";
import { Playhead } from "./Playhead";
import { Ruler } from "./Ruler";
import { StackedClipsLane, type LaneMarks } from "./StackedClipsLane";
import { TrackHeaders } from "./TrackHeaders";
import { TrimMarks, TrimOverlay } from "./TrimOverlay";
import { useClipMove } from "./useClipMove";
import { useClipReorder } from "./useClipReorder";
import { useMarqueeSelect } from "./useMarqueeSelect";
import type { TimelineZoom } from "./useTimelineZoom";
import { useTrimDrag } from "./useTrimDrag";

/** Lane pixels drawn beyond each side of the view, so a short scroll shows no blank edge. */
const OVERSCAN = 120;
/** ⌘ wheel / pinch: zoom by e^(−deltaY / this). */
const WHEEL_ZOOM_SCALE = 200;
const NO_CURVE: VolumePoint[] = [];
const NO_CLIPS: StitchTimelineClip[] = [];
const NO_GAPS: ReadonlyArray<{ fromSec: number; toSec: number }> = [];
/** A clip moved by the keys or the rail to a place out of view is scrolled to this far inside the lanes' left, px. */
const REVEAL_INSET_PX = 64;

/** The rows' scroll is the scroller's own, measured after layout; until then, what the height leaves without a scrollbar. */
interface RowsMeasure {
  /** The lanes' horizontal scrollbar, px. */
  hBar: number;
  /** The rows' visible height between the sticky ruler and the sticky audio row. */
  viewport: number;
}

/** Scrolls Stacked's rows just enough to show row `index` whole in a viewport `viewport` px tall. */
function revealRow(el: HTMLElement | null, index: number, viewport: number): void {
  if (!el || index < 0) return;
  const top = index * GEOMETRY.stackRow;
  const bottom = top + GEOMETRY.stackRow;
  if (top < el.scrollTop) el.scrollTop = top;
  else if (bottom > el.scrollTop + viewport) el.scrollTop = bottom - viewport;
}

/** Scrolls the lanes so a box wholly out of view sits REVEAL_INSET_PX inside their left; whether they scrolled. */
function revealBox(el: HTMLElement | null, box: { x: number; width: number }): boolean {
  if (!el) return false;
  if (box.x + box.width > el.scrollLeft && box.x < el.scrollLeft + el.clientWidth) return false;
  el.scrollLeft = Math.max(0, box.x - REVEAL_INSET_PX);
  return true;
}

/**
 * The 200px timeline under the stage: the track headers, then the lanes,
 * which scroll sideways under a fixed header column. The lanes hold the
 * ruler, the clips row, the audio row and the playhead. The zoom comes from
 * useTimelineZoom (shared with the transport); ⌘ wheel or a pinch zooms
 * around the pointer, any other wheel scrolls. While the audio track is
 * selected its row grows, and the timeline with it (272px), taking the room
 * from the stage above.
 *
 * Stacked has one 52px row per clip, up to three and a half rows high; more
 * scroll vertically between a sticky ruler and a sticky audio row, in the
 * same scroller as the sideways scroll, and the header rows follow the
 * scroll through a transform written straight to them (no render per
 * scroll). There a plain wheel, over the lanes or their headers, scrolls
 * the rows when they overflow (⇧ wheel scrolls along the timeline), and the
 * row of the clip that drives the preview, or of a clip selected by a key,
 * is scrolled into view.
 *
 * In Stacked a clip's box drags it in time and across rows (useClipMove),
 * its row header across rows only (useClipReorder). A placed stack (some
 * clip placed by hand) marks how each clip layers and where the gaps are;
 * every drag draws them from the timeline its release will leave. A clip
 * moved out of view by the rail or the keys is scrolled back into view, and
 * so is a new clip that becomes the selection (a paste, a duplicate).
 *
 * Several clips can be selected (a ⌘- or ⇧-click, the selection box drawn
 * on empty lane space, ⌘A); a drag of one of them carries them all.
 */
export function Timeline({
  spans,
  media,
  zoom,
  srcFor,
  music,
  stacked = false,
}: {
  spans: readonly ClipSpan[];
  media: ReadonlyMap<string, ClipMediaView>;
  zoom: TimelineZoom;
  /** The connected music, or null. */
  music: MusicView | null;
  /** The playable URL of a clip's source, for the frame under a dragged handle. */
  srcFor: (clipId: string) => string | null;
  /** The draft's layout is Stacked: one row per clip, placed anywhere in time. */
  stacked?: boolean;
}) {
  const { axis, axisNow, scroller, scrollerRef, laneWidth, scrollPosition } = zoom;
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const headerRowsRef = useRef<HTMLDivElement>(null);
  const selectedId = useStitchEditorStore((s) => (s.selection?.kind === "clip" ? s.selection.clipId : null));
  const selection = useStitchEditorStore((s) => s.selection);
  const audioSelected = useStitchEditorStore((s) => s.selection?.kind === "audio");
  const curve = useStitchEditorStore((s) => s.draft?.audioCurve ?? NO_CURVE);
  const audioMuted = useStitchEditorStore((s) => s.draft?.audioMuted ?? false);
  const layout = useStitchEditorStore((s) => s.draft?.sequenceLayout ?? DEFAULT_SEQUENCE_LAYOUT);
  const timeline = useStitchEditorStore((s) => s.draft?.timeline ?? NO_CLIPS);
  const durations = useStitchEditorStore((s) => s.durations);
  const overlapSec = effectiveOverlapSec(layout);
  // The lanes' scroll position, for virtualising ticks and frames: the zoom publishes its own scrolls in the same
  // tick, so the drawn range never lags them. Their width is the zoom's own measurement.
  const scrollLeft = useSyncExternalStore(scrollPosition.subscribe, scrollPosition.get, scrollPosition.get);

  const placed = stacked && isPlaced(timeline);
  const order = useMemo(() => timeline.map((c) => c.id), [timeline]);
  const selectedIds = useMemo(
    (): ReadonlySet<string> => new Set(selection?.kind === "clip" ? clipIdsOf(selection, order) : []),
    [selection, order],
  );

  const { trim, onHandlePointerDown, takeReleased: takeTrimReleased } = useTrimDrag(axisNow, contentRef);
  const restBoxes = useMemo(
    () => (stacked ? stackedBoxes(axis, spans, GEOMETRY.emptySlot) : laneBoxes(axis, spans, null)),
    [stacked, axis, spans],
  );
  // Stacked draws a trim as release leaves it: an In edge moves the clip's start, and nothing else moves
  const trimTimeline = stacked ? (trim?.timeline ?? null) : null;
  const drawnSpans = useMemo(
    () => (trimTimeline ? layoutSpans(trimTimeline, durations, layout) : spans),
    [trimTimeline, spans, durations, layout],
  );
  const boxes = useMemo(() => {
    if (!stacked) return laneBoxes(axis, spans, trim);
    return drawnSpans === spans ? restBoxes : stackedBoxes(axis, drawnSpans, GEOMETRY.emptySlot);
  }, [stacked, axis, spans, trim, drawnSpans, restBoxes]);
  // Where release leaves the playhead: on the live spans' axis while a trim lengthens a clip (Stacked's is linear)
  const playheadAxis = useMemo(() => {
    const live = stacked ? spans : liveSpans(spans, trim);
    return live === spans ? axis : buildTimeAxis(live, axis.pxPerSec, GEOMETRY.origin, GEOMETRY.emptySlot);
  }, [stacked, axis, spans, trim]);

  // Stacked geometry: the rows' viewport is measured from the scroller, so the scrollbars never clip the audio row
  const rowCount = Math.max(1, spans.length);
  const rowsHeight = rowCount * GEOMETRY.stackRow;
  // Only a block there is to edit grows: music connected, under a sequence with some length
  const audioExpanded = audioSelected && music !== null && axis.total > 0;
  const audioRow = audioExpanded ? GEOMETRY.audioRowExpanded : GEOMETRY.audioRow;
  const height = stacked
    ? Math.max(
        GEOMETRY.timeline,
        GEOMETRY.ruler + Math.min(rowsHeight, GEOMETRY.stackRowsCap) + audioRow + GEOMETRY.stackSlack,
      )
    : audioExpanded
      ? GEOMETRY.timelineExpanded
      : GEOMETRY.timeline;
  const [measured, setMeasured] = useState<RowsMeasure | null>(null);
  // The 1px top border is the only thing between the timeline's height and the scroller's before it is measured
  const hBar = stacked ? (measured?.hBar ?? 0) : 0;
  const rowsViewport = measured?.viewport ?? height - 1 - GEOMETRY.ruler - audioRow;
  const rowsOverflow = stacked && rowsHeight > rowsViewport;
  const rowsBlock = Math.max(rowsHeight, rowsViewport);

  // Each size change of the scroller (the timeline's height, a scrollbar appearing either way) measures the rows again
  useEffect(() => {
    const el = scroller.current;
    if (!stacked || !el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      if (!(el.clientHeight > 0)) return;
      const next = { hBar: el.offsetHeight - el.clientHeight, viewport: el.clientHeight - GEOMETRY.ruler - audioRow };
      setMeasured((prev) => (prev && prev.hBar === next.hBar && prev.viewport === next.viewport ? prev : next));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [stacked, scroller, audioRow]);

  const rowsView = () => {
    const el = scroller.current;
    if (!el) return null;
    const top = el.getBoundingClientRect().top + GEOMETRY.ruler;
    return { top, bottom: top + latest.current.rowsViewport };
  };
  const reorderOptions = { stacked, rowCount: spans.length, rowsView };
  // The lanes' content width as last drawn, for a body drag's release
  const drawnWidth = useRef(0);
  // Track: a clip's body reorders it. Stacked: a row header does, and a box's body moves it in time and across rows
  const { reorder, onBodyPointerDown, takeReleased: takeRowReleased } = useClipReorder(restBoxes, contentRef, reorderOptions);
  const { move, onMovePointerDown, pressing, takeReleased: takeMoveReleased, releasedWidth } = useClipMove(axisNow, contentRef, {
    rowCount: spans.length,
    rowsView,
    drawnWidth: () => drawnWidth.current,
  });
  // The selection box hits the boxes as drawn: Track's inset at their joins, Stacked's in their rows
  const hitBoxes = (): HitBox[] => {
    const { stacked: inStacked, restBoxes: rest } = latest.current;
    return rest.map((box, i) =>
      inStacked
        ? {
            x: box.x,
            width: box.width,
            top: GEOMETRY.ruler + i * GEOMETRY.stackRow + GEOMETRY.stackClipTop,
            height: GEOMETRY.stackClipHeight,
          }
        : { ...insetBox(box, i, rest.length), top: GEOMETRY.ruler + GEOMETRY.clipTop, height: GEOMETRY.clipHeight },
    );
  };
  const { marquee, onLanePointerDown, pressing: marqueePressing } = useMarqueeSelect(contentRef, {
    stacked,
    hitBoxes,
    order: () => latest.current.spans.map((span) => span.clip.id),
    rowsView: stacked ? rowsView : () => null,
    bounds: () => ({
      top: GEOMETRY.ruler,
      bottom: GEOMETRY.ruler + (stacked ? spans.length * GEOMETRY.stackRow : GEOMETRY.clipRow),
    }),
  });
  // While the box is drawn, what it would select is drawn selected
  const drawnSelectedIds = marquee ? marquee.selectedIds : selectedIds;
  // From what is drawn, so the clips a running box touches already show the group look release gives them.
  const multi = drawnSelectedIds.size > 1;

  // Latest values for the handlers bound once (the wheel, the scroll, the playback follow)
  const latest = useRef({ zoom, stacked, rowsOverflow, rowsViewport, spans, restBoxes, pressing, marqueePressing });
  useEffect(() => {
    latest.current = { zoom, stacked, rowsOverflow, rowsViewport, spans, restBoxes, pressing, marqueePressing };
  });

  // A lined-up stack draws a header-lifted clip (or each of a lifted group) at the start it will have in the order it
  // would drop into; a placed one keeps every start, so the lifted boxes keep their x
  const liftId = stacked && reorder ? reorder.clipId : null;
  const liftIds = stacked && reorder ? reorder.clipIds : null;
  const liftFrom = reorder?.index ?? -1;
  const liftTo = reorder?.dropIndex ?? -1;
  /** The row move a header drag's release makes: one clip's, or a group's with its spacing kept. */
  const liftMove = useCallback(
    (from: StitchTimelineClip[]) =>
      liftIds && liftIds.length > 1 ? shiftRows(from, new Set(liftIds), liftTo - liftFrom) : moveClip(from, liftFrom, liftTo),
    [liftIds, liftFrom, liftTo],
  );
  const liftedX = useMemo(() => {
    if (!liftIds || placed) return null;
    const xs = new Map<string, number>();
    for (const span of clipSpans(liftMove(timeline), durations, overlapSec)) {
      if (liftIds.includes(span.clip.id)) xs.set(span.clip.id, axis.timeToX(span.start));
    }
    return xs;
  }, [liftIds, liftMove, placed, timeline, durations, overlapSec, axis]);

  // The timeline the marks are drawn from: the one release would leave while a drag runs (a body drag always pins, so
  // its marks are placed ones in a lined-up stack too), else the draft's
  const markTimeline = useMemo(() => {
    if (!stacked) return null;
    if (move) return move.timeline;
    if (trimTimeline) return trimTimeline;
    if (liftId !== null && placed) return liftMove(pinStarts(timeline, durations, layout.overlapSec));
    return timeline;
  }, [stacked, move, trimTimeline, liftId, liftMove, placed, timeline, durations, layout.overlapSec]);
  const markSpans = useMemo(() => {
    if (!markTimeline || markTimeline === timeline) return spans;
    return markTimeline === trimTimeline ? drawnSpans : layoutSpans(markTimeline, durations, layout);
  }, [markTimeline, timeline, spans, trimTimeline, drawnSpans, durations, layout]);
  const markEnvelope = markTimeline && isPlaced(markTimeline) ? spansEnvelope(markSpans, layout.crossfade) : null;
  const pxPerSec = axis.pxPerSec;
  const marks = useMemo((): LaneMarks | null => {
    if (!markEnvelope || !markTimeline) return null;
    const pieces = new Map<string, readonly WeightPiece[]>();
    for (const span of markSpans) {
      const unit = markEnvelope.units.findIndex((u) => u.row === span.index);
      if (unit !== -1) pieces.set(span.clip.id, weightPieces(markEnvelope, unit, pxPerSec));
    }
    // Rows keep their names until release: a covering clip is named by its row at the press
    const coverName = (row: number) => {
      const id = markTimeline[row]?.id;
      const at = timeline.findIndex((clip) => clip.id === id);
      return clipName(at === -1 ? row : at);
    };
    return { pieces, coverName };
  }, [markEnvelope, markTimeline, markSpans, timeline, pxPerSec]);
  const gapBands = useMemo(() => (markEnvelope ? envelopeGaps(markEnvelope) : NO_GAPS), [markEnvelope]);

  // The rail and the keys move clips from outside the lane: in Fit they keep the zoom this lane draws at
  useLayoutEffect(() => {
    liveFitZoom.set(axis.pxPerSec);
  });
  useEffect(() => () => liveFitZoom.set(null), []);

  useEffect(() => {
    const el = scroller.current;
    const root = rootRef.current;
    if (!el || !root) return;
    // A scroll event comes at most once a frame, before it is painted
    const onScroll = () => {
      scrollPosition.set(el.scrollLeft);
      const rows = headerRowsRef.current;
      if (rows) rows.style.transform = `translateY(${-el.scrollTop}px)`;
    };
    // Native and non-passive, so a wheel over the timeline neither scrolls the page nor reaches anything behind. Bound on
    // the whole timeline: a wheel over the header column (Stacked's row names) scrolls the lanes as one over them does
    const onWheel = (event: WheelEvent) => {
      // The clip menu is drawn inside the timeline: a wheel over it is the menu's, and moves nothing behind it
      if (event.target instanceof Element && event.target.closest('[role="menu"]')) return;
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        // Not mid-drag: a drag measures from the zoom it started at, and a box's press (or the selection box's) from
        // its press
        const { pressing: boxPress, marqueePressing: lanePress } = latest.current;
        if (useStitchEditorStore.getState().cancelGesture || boxPress.current || lanePress.current) return;
        const z = latest.current.zoom;
        const viewX = Math.max(0, event.clientX - el.getBoundingClientRect().left);
        z.zoomAround(z.pxPerSec * Math.exp(-event.deltaY / WHEEL_ZOOM_SCALE), viewX);
        return;
      }
      // Stacked rows that overflow take the vertical wheel; ⇧ keeps it for the sideways scroll
      if (latest.current.rowsOverflow && !event.shiftKey) {
        el.scrollTop += event.deltaY;
        el.scrollLeft += event.deltaX;
        return;
      }
      el.scrollLeft += event.deltaX !== 0 ? event.deltaX : event.deltaY;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("scroll", onScroll);
      root.removeEventListener("wheel", onWheel);
    };
  }, [scroller, scrollPosition]);

  // The header rows are mounted again on a switch to Stacked: they start where the rows are
  useLayoutEffect(() => {
    const el = scroller.current;
    const rows = headerRowsRef.current;
    if (el && rows) rows.style.transform = `translateY(${-el.scrollTop}px)`;
  });

  // A switch of layout (the toggle, ⌘Z) swaps the lane and the header +: focus on them is removed with them. It goes to
  // the new lane's tab stop, or the dialog, never <body>, so the arrows and Tab carry on from there
  const focusInside = useRef(false);
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (!focusInside.current || (active && active !== document.body && active.isConnected)) return;
    const root = rootRef.current;
    const target =
      root?.querySelector<HTMLElement>('[role="option"][tabindex="0"]') ?? root?.closest<HTMLElement>('[role="dialog"]');
    target?.focus({ preventScroll: true });
  }, [stacked]);

  // While the preview plays, the row of the clip it is driven by stays in view (as the playhead does sideways)
  useEffect(
    () =>
      useStitchEditorStore.subscribe((s) => {
        const live = latest.current;
        if (!s.playing || !live.stacked || !live.rowsOverflow) return;
        const span = topSpanAt(live.spans, s.playhead);
        if (span) revealRow(scroller.current, span.index, live.rowsViewport);
      }),
    [scroller],
  );

  // A clip selected some other way (a key, a split), or moved to another row while selected (an undo or redo of a
  // reorder), is scrolled into view
  const selectedRow = selectedId === null ? -1 : spans.findIndex((s) => s.clip.id === selectedId);
  useEffect(() => {
    if (!stacked || selectedRow === -1) return;
    revealRow(scroller.current, selectedRow, latest.current.rowsViewport);
  }, [stacked, selectedId, selectedRow, scroller]);

  // From a press anywhere in the timeline to its release. A press lets a focused field go, and a Start typed there
  // commits then: the lanes must not scroll away from under the pointer
  const pressDown = useRef(false);
  const onPressCapture = () => {
    pressDown.current = true;
    const done = () => {
      pressDown.current = false;
      window.removeEventListener("pointerup", done, true);
      window.removeEventListener("pointercancel", done, true);
    };
    window.addEventListener("pointerup", done, true);
    window.addEventListener("pointercancel", done, true);
  };

  // The selected clip moved by the rail's Start, the keys or an undo to a place wholly out of view is scrolled to
  // 64px inside the lanes. Never for a move made in the timeline: not while a press is down (a Start committed by the
  // press), and not for what a drag's release applies (a box's body, a row header, a trim handle), which lands where
  // it was drawn
  const selectedStart = stacked && selectedRow !== -1 ? spans[selectedRow].start : null;
  const selectedBox = selectedRow === -1 ? null : restBoxes[selectedRow];
  const shownStart = useRef<{ id: string; start: number } | null>(null);
  useEffect(() => {
    const before = shownStart.current;
    shownStart.current = selectedId !== null && selectedStart !== null ? { id: selectedId, start: selectedStart } : null;
    // Each is taken, so a release that moved nothing the reveal watches is not left over for the next change
    const released = [takeMoveReleased(), takeRowReleased(), takeTrimReleased()];
    if (pressDown.current || released.includes(selectedId)) return;
    if (!selectedBox || !before || before.id !== selectedId || before.start === selectedStart) return;
    const el = scroller.current;
    if (el && revealBox(el, selectedBox)) scrollPosition.set(el.scrollLeft);
  }, [selectedId, selectedStart, selectedBox, scroller, scrollPosition, takeMoveReleased, takeRowReleased, takeTrimReleased]);

  // A new clip that becomes the selection (a paste, a duplicate) is brought into view, and takes focus from the clip
  // that had it, so the arrows carry on from there
  const knownIds = useRef<ReadonlySet<string> | null>(null);
  const leadRow = selectedId === null ? -1 : spans.findIndex((s) => s.clip.id === selectedId);
  const leadBox = leadRow === -1 ? null : restBoxes[leadRow];
  useEffect(() => {
    const before = knownIds.current;
    knownIds.current = new Set(order);
    if (!before || selectedId === null || before.has(selectedId) || !leadBox) return;
    const root = rootRef.current;
    const active = document.activeElement;
    if (root && active instanceof HTMLElement && active.getAttribute("role") === "option" && root.contains(active)) {
      const option = Array.from(root.querySelectorAll<HTMLElement>('[role="option"]')).find(
        (el) => el.dataset.clipId === selectedId,
      );
      if (option && option !== active) option.focus();
    }
    const el = scroller.current;
    if (el && revealBox(el, leadBox)) scrollPosition.set(el.scrollLeft);
  }, [order, selectedId, leadBox, scroller, scrollPosition]);

  const empty = spans.length === 0;
  const stackedRight = stacked
    ? restBoxes.reduce((right, box, i) => (spans[i].length > 0 ? right : Math.max(right, box.x + box.width)), axis.endX)
    : axis.endX;
  const moveBox = move ? restBoxes[move.index] : undefined;
  // A box dragged past the end widens the lanes with it, so they can scroll on under it
  const movedRight = move && moveBox ? move.x + moveBox.width : 0;
  // A body drag that shortens the sequence keeps the width it was drawn at until the lanes scroll back from it: the
  // browser would otherwise pull a scroll at the end back by what was lost, and every box would jump on release
  const heldWidth = releasedWidth && releasedWidth.pxPerSec === axis.pxPerSec ? Math.min(releasedWidth.width, scrollLeft + laneWidth) : 0;
  const contentWidth = Math.max(Math.max(stackedRight, movedRight) + LANE_TRAILING_PX, laneWidth, heldWidth);
  useLayoutEffect(() => {
    drawnWidth.current = contentWidth;
  });
  const viewLeft = scrollLeft - OVERSCAN;
  const viewRight = scrollLeft + Math.max(laneWidth, 1) + OVERSCAN;
  const trimView = trim ? media.get(trim.clipId) : undefined;
  const trimIndex = trim ? spans.findIndex((s) => s.clip.id === trim.clipId) : -1;
  const trimBox = trimIndex === -1 ? null : boxes[trimIndex];
  const edgeX = trim && trimBox ? trimEdgeX(trimBox, trim.edge) : 0;
  const trimRowTop = GEOMETRY.ruler + trimIndex * GEOMETRY.stackRow + GEOMETRY.stackClipTop;
  const trimRow = stacked && trimIndex !== -1 ? { top: trimRowTop, bottom: trimRowTop + GEOMETRY.stackClipHeight } : undefined;
  const rowDrag = stacked ? (reorder ?? move) : null;
  const insertionY = rowDrag ? stackedInsertionY(rowDrag.dropIndex, rowDrag.index, GEOMETRY.stackRow) : null;
  const snappedToPlayhead =
    trim?.result.snapped?.kind === "playhead" || move?.result.snapped?.kind === "playhead";
  // The moving box as the lane draws it: its row's top plus the travel (clamped to the rows by useClipMove)
  const moveTop = move ? move.index * GEOMETRY.stackRow + GEOMETRY.stackClipTop + move.dy : 0;
  const moveTargetRow = move?.result.snapped?.row ?? null;
  // A group's chip spans every moved clip, read from the timeline release leaves
  const moveGroup = useMemo(() => {
    if (!move || move.clipIds.length <= 1) return null;
    const moved = markSpans.filter((span) => move.clipIds.includes(span.clip.id));
    if (moved.length === 0) return null;
    return { fromSec: Math.min(...moved.map((s) => s.start)), toSec: Math.max(...moved.map((s) => s.end)) };
  }, [move, markSpans]);
  const marqueeBox = marquee ? (
    <div
      aria-hidden="true"
      data-testid="stitch-marquee"
      className="pointer-events-none absolute z-20 rounded-[2px] border border-selection bg-selection/10"
      style={{
        left: marquee.drawn.left,
        top: marquee.drawn.top,
        width: marquee.drawn.right - marquee.drawn.left,
        height: marquee.drawn.bottom - marquee.drawn.top,
      }}
    />
  ) : null;

  return (
    <div
      ref={rootRef}
      className="relative flex shrink-0 overflow-hidden border-t border-chrome-border bg-editor-lanes"
      style={{ height }}
      onPointerDownCapture={onPressCapture}
      onFocus={() => {
        focusInside.current = true;
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) focusInside.current = false;
      }}
    >
      <TrackHeaders
        clipCount={spans.length}
        audioExpanded={audioExpanded}
        audioMuted={audioMuted}
        canMuteAudio={music !== null || audioMuted}
        stackedRows={
          stacked
            ? {
                spans,
                media,
                selectedIds: drawnSelectedIds,
                rowsRef: headerRowsRef,
                insertionY,
                hBar,
                onRowPointerDown: onBodyPointerDown,
              }
            : null
        }
      />
      <div
        ref={scrollerRef}
        data-testid="stitch-lanes"
        className={cn("relative min-w-0 flex-1 overflow-x-auto", rowsOverflow ? "overflow-y-auto" : "overflow-y-hidden")}
      >
        {stacked ? (
          <div
            ref={contentRef}
            className="relative"
            style={{ width: contentWidth, height: GEOMETRY.ruler + rowsBlock + audioRow }}
          >
            <div className="sticky top-0 z-4 h-6 bg-editor-lanes">
              <Ruler
                axis={axis}
                axisNow={axisNow}
                viewLeft={viewLeft}
                viewRight={Math.min(viewRight, contentWidth)}
                maxX={contentWidth}
                contentRef={contentRef}
                showLabels={!empty}
              />
              {gapBands.map((gap) => (
                <div
                  key={gap.fromSec}
                  aria-hidden="true"
                  data-testid="stitch-ruler-gap"
                  className="pointer-events-none absolute bottom-0 h-[3px] bg-black"
                  style={{ left: axis.timeToX(gap.fromSec), width: axis.timeToX(gap.toSec) - axis.timeToX(gap.fromSec) }}
                />
              ))}
              {!empty && <Playhead axis={playheadAxis} limit={axis.total} hideLine={snappedToPlayhead} part="head" />}
            </div>
            <div data-testid="stitch-rows" className="relative z-0" style={{ height: rowsBlock }}>
              <StackedClipsLane
                axis={axis}
                spans={drawnSpans}
                boxes={boxes}
                restBoxes={restBoxes}
                media={media}
                selectedId={selectedId}
                selectedIds={drawnSelectedIds}
                multi={multi}
                trim={trim}
                reorder={reorder}
                liftedX={liftedX}
                move={move}
                insertionY={insertionY}
                marks={marks}
                gaps={gapBands}
                crossfade={layout.crossfade}
                viewLeft={viewLeft}
                viewRight={viewRight}
                contentWidth={contentWidth}
                onBodyPointerDown={onMovePointerDown}
                onHandlePointerDown={onHandlePointerDown}
                onLanePointerDown={onLanePointerDown}
              />
            </div>
            <div className="sticky bottom-0 z-2 bg-editor-lanes" style={{ height: audioRow }}>
              <AudioLane
                axis={axis}
                music={music}
                curve={curve}
                muted={audioMuted}
                expanded={audioExpanded}
                viewLeft={viewLeft}
                viewRight={viewRight}
                visibleRight={laneWidth > 0 ? scrollLeft + laneWidth : contentWidth}
                contentWidth={contentWidth}
                contentRef={contentRef}
                top={0}
              />
            </div>
            {!empty && <Playhead axis={playheadAxis} limit={axis.total} hideLine={snappedToPlayhead} part="line" />}
            {trim && trimBox && (
              <TrimMarks trim={trim} axis={playheadAxis} edgeX={edgeX} scrollLeft={scrollLeft} row={trimRow} />
            )}
            {move && moveBox && (
              <MoveOverlay
                move={move}
                axis={axis}
                lengthSec={spans[move.index]?.length ?? 0}
                boxWidth={moveBox.width}
                boxTop={moveTop}
                targetBoxTop={
                  moveTargetRow === null ? null : moveTargetRow * GEOMETRY.stackRow + GEOMETRY.stackClipTop
                }
                scrollLeft={scrollLeft}
                laneWidth={laneWidth}
                group={moveGroup}
              />
            )}
            {marqueeBox}
          </div>
        ) : (
          <div ref={contentRef} className="relative h-full" style={{ width: contentWidth }}>
            <Ruler
              axis={axis}
              axisNow={axisNow}
              viewLeft={viewLeft}
              viewRight={Math.min(viewRight, contentWidth)}
              maxX={contentWidth}
              contentRef={contentRef}
              showLabels={!empty}
            />
            <ClipsLane
              axis={axis}
              spans={spans}
              boxes={boxes}
              media={media}
              selectedId={selectedId}
              selectedIds={drawnSelectedIds}
              multi={multi}
              trim={trim}
              reorder={reorder}
              viewLeft={viewLeft}
              viewRight={viewRight}
              laneWidth={contentWidth}
              onBodyPointerDown={onBodyPointerDown}
              onHandlePointerDown={onHandlePointerDown}
              onLanePointerDown={onLanePointerDown}
            />
            <AudioLane
              axis={axis}
              music={music}
              curve={curve}
              muted={audioMuted}
              expanded={audioExpanded}
              viewLeft={viewLeft}
              viewRight={viewRight}
              visibleRight={laneWidth > 0 ? scrollLeft + laneWidth : contentWidth}
              contentWidth={contentWidth}
              contentRef={contentRef}
            />
            {trim && trimBox && <TrimMarks trim={trim} axis={playheadAxis} edgeX={edgeX} scrollLeft={scrollLeft} />}
            {/* Snapped to the playhead, the dashed guide stands in for its line */}
            {!empty && <Playhead axis={playheadAxis} limit={axis.total} hideLine={snappedToPlayhead} />}
            {marqueeBox}
          </div>
        )}
      </div>
      {trim && trimBox && (
        <TrimOverlay
          trim={trim}
          edgeX={edgeX}
          view={trimView}
          src={srcFor(trim.clipId)}
          contentRef={contentRef}
          rowTop={trimRow?.top}
        />
      )}
      <ClipContextMenu media={media} />
    </div>
  );
}
