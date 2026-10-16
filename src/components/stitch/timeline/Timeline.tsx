"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { cn } from "@/components/nodes/ui/cn";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { stackedInsertionY } from "@/lib/stitch/reorder";
import { DEFAULT_SEQUENCE_LAYOUT, effectiveOverlapSec } from "@/lib/stitch/stack";
import { clipSpans, moveClip, topSpanAt, trimClip, type ClipSpan } from "@/lib/stitch/timeline";
import type { StitchTimelineClip, VolumePoint } from "@/types";
import { buildTimeAxis } from "@/lib/stitch/timeAxis";
import { laneBoxes, liveSpans, stackedBoxes, trimEdgeX } from "@/lib/stitch/laneLayout";
import { EDITOR_CHIP, GEOMETRY, LANE_TRAILING_PX } from "../editorStyles";
import type { ClipMediaView, MusicView } from "../useStitchEditorMedia";
import { AudioLane } from "./AudioLane";
import { ClipContextMenu } from "./ClipContextMenu";
import { ClipsLane } from "./ClipsLane";
import { Playhead } from "./Playhead";
import { Ruler } from "./Ruler";
import { StackedClipsLane } from "./StackedClipsLane";
import { TrackHeaders } from "./TrackHeaders";
import { TrimMarks, TrimOverlay } from "./TrimOverlay";
import { useClipReorder } from "./useClipReorder";
import type { TimelineZoom } from "./useTimelineZoom";
import { useTrimDrag } from "./useTrimDrag";

/** Lane pixels drawn beyond each side of the view, so a short scroll shows no blank edge. */
const OVERSCAN = 120;
/** ⌘ wheel / pinch: zoom by e^(−deltaY / this). */
const WHEEL_ZOOM_SCALE = 200;
const NO_CURVE: VolumePoint[] = [];
const NO_CLIPS: StitchTimelineClip[] = [];
/** Stacked: a reorder drag this far sideways, and mostly sideways, explains why the clip will not move in time. */
const SIDEWAYS_CHIP_PX = 24;
/** Room for that chip, px: its one line of text measures 290 px. */
const SIDEWAYS_CHIP_WIDTH = 300;
/** The chip's gap from the pointer, px. */
const SIDEWAYS_CHIP_GAP = 14;

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
  /** The draft's layout is Stacked: one row per clip, each overlapping the one before. */
  stacked?: boolean;
}) {
  const { axis, axisNow, scroller, scrollerRef, laneWidth, scrollPosition } = zoom;
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const headerRowsRef = useRef<HTMLDivElement>(null);
  const selectedId = useStitchEditorStore((s) => (s.selection?.kind === "clip" ? s.selection.clipId : null));
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

  const { trim, onHandlePointerDown } = useTrimDrag(axisNow, contentRef);
  const restBoxes = useMemo(
    () => (stacked ? stackedBoxes(axis, spans, GEOMETRY.emptySlot) : laneBoxes(axis, spans, null)),
    [stacked, axis, spans],
  );
  // Stacked draws a trim as release leaves it: the half-clip cap can move the clip's own start and every later one
  const drawnSpans = useMemo(() => {
    if (!stacked || !trim) return spans;
    const patch = trim.edge === "out" ? { outSec: trim.result.outSec } : { inSec: trim.result.inSec };
    return clipSpans(trimClip(timeline, trim.clipId, durations, patch), durations, overlapSec);
  }, [stacked, trim, spans, timeline, durations, overlapSec]);
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

  // Latest values for the handlers bound once (the wheel, the scroll, the playback follow)
  const latest = useRef({ zoom, stacked, rowsOverflow, rowsViewport, spans });
  useEffect(() => {
    latest.current = { zoom, stacked, rowsOverflow, rowsViewport, spans };
  });

  const reorderOptions = {
    stacked,
    rowCount: spans.length,
    rowsView: () => {
      const el = scroller.current;
      if (!el) return null;
      const top = el.getBoundingClientRect().top + GEOMETRY.ruler;
      return { top, bottom: top + latest.current.rowsViewport };
    },
  };
  const { reorder, onBodyPointerDown } = useClipReorder(restBoxes, contentRef, reorderOptions);
  // The lifted clip is drawn at the start it will have in the order it would drop into
  const liftId = stacked && reorder ? reorder.clipId : null;
  const liftFrom = reorder?.index ?? -1;
  const liftTo = reorder?.dropIndex ?? -1;
  const liftedX = useMemo(() => {
    if (liftId === null) return null;
    const moved = clipSpans(moveClip(timeline, liftFrom, liftTo), durations, overlapSec);
    const span = moved.find((s) => s.clip.id === liftId);
    return span ? axis.timeToX(span.start) : null;
  }, [liftId, liftFrom, liftTo, timeline, durations, overlapSec, axis]);

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
        // Not mid-drag: a trim or reorder measures from the zoom it started at
        if (useStitchEditorStore.getState().cancelGesture) return;
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

  const empty = spans.length === 0;
  const stackedRight = stacked
    ? restBoxes.reduce((right, box, i) => (spans[i].length > 0 ? right : Math.max(right, box.x + box.width)), axis.endX)
    : axis.endX;
  const contentWidth = Math.max(stackedRight + LANE_TRAILING_PX, laneWidth);
  const viewLeft = scrollLeft - OVERSCAN;
  const viewRight = scrollLeft + Math.max(laneWidth, 1) + OVERSCAN;
  const trimView = trim ? media.get(trim.clipId) : undefined;
  const trimIndex = trim ? spans.findIndex((s) => s.clip.id === trim.clipId) : -1;
  const trimBox = trimIndex === -1 ? null : boxes[trimIndex];
  const edgeX = trim && trimBox ? trimEdgeX(trimBox, trim.edge) : 0;
  const trimRowTop = GEOMETRY.ruler + trimIndex * GEOMETRY.stackRow + GEOMETRY.stackClipTop;
  const trimRow = stacked && trimIndex !== -1 ? { top: trimRowTop, bottom: trimRowTop + GEOMETRY.stackClipHeight } : undefined;
  const insertionY = stacked && reorder ? stackedInsertionY(reorder.dropIndex, reorder.index, GEOMETRY.stackRow) : null;
  const sideways =
    stacked && reorder && Math.abs(reorder.dx) > SIDEWAYS_CHIP_PX && Math.abs(reorder.dx) > 2 * Math.abs(reorder.dy)
      ? reorder
      : null;
  const snappedToPlayhead = trim?.result.snapped?.kind === "playhead";
  // Right of the pointer, else left of it, else against the view's right edge: never past the visible lanes, where it
  // would be cut off and widen the scroll mid-drag. A drag from a row header starts left of the lanes: the chip then
  // sits against the view's left edge
  const sidewaysChipX = (() => {
    if (!sideways) return null;
    const viewEnd = scrollLeft + laneWidth;
    const right = sideways.x + SIDEWAYS_CHIP_GAP;
    if (laneWidth <= 0 || right + SIDEWAYS_CHIP_WIDTH <= viewEnd) return Math.max(scrollLeft, right);
    const left = sideways.x - SIDEWAYS_CHIP_GAP - SIDEWAYS_CHIP_WIDTH;
    return left >= scrollLeft ? left : Math.max(scrollLeft, viewEnd - SIDEWAYS_CHIP_WIDTH);
  })();

  return (
    <div
      ref={rootRef}
      className="relative flex shrink-0 overflow-hidden border-t border-chrome-border bg-editor-lanes"
      style={{ height }}
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
            ? { spans, media, selectedId, rowsRef: headerRowsRef, insertionY, hBar, onRowPointerDown: onBodyPointerDown }
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
                trim={trim}
                reorder={reorder}
                liftedX={liftedX}
                crossfade={layout.crossfade}
                viewLeft={viewLeft}
                viewRight={viewRight}
                contentWidth={contentWidth}
                onBodyPointerDown={onBodyPointerDown}
                onHandlePointerDown={onHandlePointerDown}
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
            {sideways && sidewaysChipX !== null && (
              <div
                aria-hidden="true"
                data-testid="stitch-reorder-chip"
                className={cn(EDITOR_CHIP, "pointer-events-none absolute z-20 whitespace-nowrap text-neutral-300")}
                style={{ left: sidewaysChipX, top: sideways.y + SIDEWAYS_CHIP_GAP }}
              >
                Clips stay in order. Overlap sets where each one starts.
              </div>
            )}
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
              trim={trim}
              reorder={reorder}
              viewLeft={viewLeft}
              viewRight={viewRight}
              laneWidth={contentWidth}
              onBodyPointerDown={onBodyPointerDown}
              onHandlePointerDown={onHandlePointerDown}
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
