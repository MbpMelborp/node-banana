"use client";

import { useRef, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { rulerTicks } from "@/lib/stitch/rulerTicks";
import type { TimeAxis } from "@/lib/stitch/timeAxis";
import { pause } from "../editorActions";
import { GEOMETRY } from "../editorStyles";
import { releaseTypingFocus } from "./releaseTypingFocus";

/** A label sits 4px right of its tick and is at most this wide ("10:00.00" at 10px mono). */
const LABEL_ROOM = 52;

/**
 * The 24px ruler over the lanes: majors and minors from the zoom, labels on
 * every major or every second one, drawn only across the visible range.
 * Pressing or dragging on it pauses and moves the playhead. An empty
 * sequence shows the ticks without labels.
 */
export function Ruler({
  axis,
  axisNow,
  viewLeft,
  viewRight,
  maxX,
  contentRef,
  showLabels,
}: {
  axis: TimeAxis;
  /** The axis for the editor's state now: a press that commits a focused field seeks on the zoom it leads to. */
  axisNow: () => TimeAxis;
  viewLeft: number;
  viewRight: number;
  /** The content's width: nothing is drawn past it, so the ruler never widens the scroll area. */
  maxX: number;
  contentRef: RefObject<HTMLDivElement | null>;
  showLabels: boolean;
}) {
  const dragging = useRef(false);
  const ticks = rulerTicks(axis.pxPerSec, Math.max(0, axis.xToTime(viewLeft)), Math.max(0, axis.xToTime(viewRight - 1)));

  const seekTo = (clientX: number) => {
    const left = contentRef.current?.getBoundingClientRect().left ?? 0;
    const now = axisNow();
    const t = Math.min(Math.max(now.xToTime(clientX - left), 0), now.total);
    useStitchEditorStore.getState().setPlayhead(t);
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // preventDefault keeps focus where it is: a focused In/Out field lets go first, so I and O reach the editor
    releaseTypingFocus(event.currentTarget);
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragging.current = true;
    pause();
    seekTo(event.clientX);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragging.current) seekTo(event.clientX);
  };
  const onPointerUp = () => {
    dragging.current = false;
  };

  return (
    <div
      data-testid="stitch-ruler"
      className="absolute inset-x-0 top-0 cursor-pointer border-b border-white/6"
      style={{ height: GEOMETRY.ruler }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {ticks.minors.map((t) => (
        <span key={`m${t}`} aria-hidden="true" className="absolute bottom-0 h-1 w-px bg-white/7" style={{ left: axis.timeToX(t) }} />
      ))}
      {ticks.majors.map((t) => (
        <span key={`M${t}`} aria-hidden="true" className="absolute bottom-0 h-2 w-px bg-white/16" style={{ left: axis.timeToX(t) }} />
      ))}
      {showLabels &&
        ticks.labels
          .filter(({ t }) => axis.timeToX(t) + 4 + LABEL_ROOM <= maxX)
          .map(({ t, text }) => (
            <span
              key={`L${t}`}
              className="pointer-events-none absolute top-[5px] font-mono text-[10px] leading-3 tabular-nums text-neutral-500"
              style={{ left: axis.timeToX(t) + 4 }}
            >
              {text}
            </span>
          ))}
    </div>
  );
}
