"use client";

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import type { ClipSpan } from "@/lib/stitch/timeline";
import { buildTimeAxis } from "@/lib/stitch/timeAxis";
import { laneBoxes, liveSpans, trimEdgeX } from "@/lib/stitch/laneLayout";
import { GEOMETRY, LANE_TRAILING_PX } from "../editorStyles";
import type { ClipMediaView } from "../useStitchEditorMedia";
import { ClipContextMenu } from "./ClipContextMenu";
import { ClipsLane } from "./ClipsLane";
import { Playhead } from "./Playhead";
import { Ruler } from "./Ruler";
import { TrackHeaders } from "./TrackHeaders";
import { TrimMarks, TrimOverlay } from "./TrimOverlay";
import { useClipReorder } from "./useClipReorder";
import type { TimelineZoom } from "./useTimelineZoom";
import { useTrimDrag } from "./useTrimDrag";

/** Lane pixels drawn beyond each side of the view, so a short scroll shows no blank edge. */
const OVERSCAN = 120;
/** ⌘ wheel / pinch: zoom by e^(−deltaY / this). */
const WHEEL_ZOOM_SCALE = 200;

/**
 * The 200px timeline under the stage: the track headers, then the lanes,
 * which scroll sideways under a fixed header column. The lanes hold the
 * ruler, the clips row, the audio row and the playhead. The zoom comes from
 * useTimelineZoom (shared with the transport); ⌘ wheel or a pinch zooms
 * around the pointer, any other wheel scrolls.
 */
export function Timeline({
  spans,
  media,
  zoom,
  srcFor,
}: {
  spans: readonly ClipSpan[];
  media: ReadonlyMap<string, ClipMediaView>;
  zoom: TimelineZoom;
  /** The playable URL of a clip's source, for the frame under a dragged handle. */
  srcFor: (clipId: string) => string | null;
}) {
  const { axis, axisNow, scroller, scrollerRef, laneWidth, scrollPosition } = zoom;
  const contentRef = useRef<HTMLDivElement>(null);
  const selectedId = useStitchEditorStore((s) => (s.selection?.kind === "clip" ? s.selection.clipId : null));
  // The lanes' scroll position, for virtualising ticks and frames: the zoom publishes its own scrolls in the same
  // tick, so the drawn range never lags them. Their width is the zoom's own measurement.
  const scrollLeft = useSyncExternalStore(scrollPosition.subscribe, scrollPosition.get, scrollPosition.get);

  const { trim, onHandlePointerDown } = useTrimDrag(axisNow, contentRef);
  const boxes = useMemo(() => laneBoxes(axis, spans, trim), [axis, spans, trim]);
  // Where release leaves the playhead: on the live spans' axis while a trim lengthens a clip
  const playheadAxis = useMemo(() => {
    const live = liveSpans(spans, trim);
    return live === spans ? axis : buildTimeAxis(live, axis.pxPerSec, GEOMETRY.origin, GEOMETRY.emptySlot);
  }, [axis, spans, trim]);
  const restBoxes = useMemo(() => laneBoxes(axis, spans, null), [axis, spans]);
  const { reorder, onBodyPointerDown } = useClipReorder(restBoxes, contentRef);

  // Latest zoom for the wheel handler, which is bound once
  const latestZoom = useRef(zoom);
  useEffect(() => {
    latestZoom.current = zoom;
  });

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    // A scroll event comes at most once a frame, before it is painted
    const onScroll = () => scrollPosition.set(el.scrollLeft);
    // Native and non-passive, so a wheel over the lanes neither scrolls the page nor reaches anything behind
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        // Not mid-drag: a trim or reorder measures from the zoom it started at
        if (useStitchEditorStore.getState().cancelGesture) return;
        const z = latestZoom.current;
        const viewX = event.clientX - el.getBoundingClientRect().left;
        z.zoomAround(z.pxPerSec * Math.exp(-event.deltaY / WHEEL_ZOOM_SCALE), viewX);
        return;
      }
      el.scrollLeft += event.deltaX !== 0 ? event.deltaX : event.deltaY;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
    };
  }, [scroller, scrollPosition]);

  const empty = spans.length === 0;
  const contentWidth = Math.max(axis.endX + LANE_TRAILING_PX, laneWidth);
  const viewLeft = scrollLeft - OVERSCAN;
  const viewRight = scrollLeft + Math.max(laneWidth, 1) + OVERSCAN;
  const trimView = trim ? media.get(trim.clipId) : undefined;
  const trimIndex = trim ? spans.findIndex((s) => s.clip.id === trim.clipId) : -1;
  const trimBox = trimIndex === -1 ? null : boxes[trimIndex];
  const edgeX = trim && trimBox ? trimEdgeX(trimBox, trim.edge) : 0;

  return (
    <div
      className="relative flex shrink-0 overflow-hidden border-t border-chrome-border bg-editor-lanes"
      style={{ height: GEOMETRY.timeline }}
    >
      <TrackHeaders clipCount={spans.length} />
      <div
        ref={scrollerRef}
        data-testid="stitch-lanes"
        className="relative min-w-0 flex-1 overflow-x-auto overflow-y-hidden"
      >
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
          {/* The audio row; the audio lane fills it */}
          <div
            className="absolute inset-x-0 border-b border-white/6"
            style={{ top: GEOMETRY.ruler + GEOMETRY.clipRow, height: GEOMETRY.audioRow }}
          />
          {trim && trimBox && <TrimMarks trim={trim} axis={playheadAxis} edgeX={edgeX} scrollLeft={scrollLeft} />}
          {/* Snapped to the playhead, the dashed guide stands in for its line */}
          {!empty && (
            <Playhead axis={playheadAxis} limit={axis.total} hideLine={trim?.result.snapped?.kind === "playhead"} />
          )}
        </div>
      </div>
      {trim && trimBox && (
        <TrimOverlay
          trim={trim}
          edgeX={edgeX}
          view={trimView}
          src={srcFor(trim.clipId)}
        />
      )}
      <ClipContextMenu media={media} />
    </div>
  );
}
