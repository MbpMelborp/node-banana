"use client";

import {
  useLayoutEffect,
  useRef,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Plus } from "lucide-react";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { insetBox, JOIN_INSET_PX, type LaneBox } from "@/lib/stitch/laneLayout";
import { insertionX } from "@/lib/stitch/reorder";
import type { TimeAxis } from "@/lib/stitch/timeAxis";
import type { ClipSpan } from "@/lib/stitch/timeline";
import { openLibraryPicker } from "../editorActions";
import { GEOMETRY } from "../editorStyles";
import { useLibraryAvailable } from "../library/useLibraryAvailable";
import type { ClipMediaView } from "../useStitchEditorMedia";
import { ClipBox, type ClipBoxMode } from "./ClipBox";
import { EmptyClipSlot } from "./EmptyClipSlot";
import { Filmstrip } from "./Filmstrip";
import { releaseTypingFocus } from "./releaseTypingFocus";
import type { ReorderLive } from "./useClipReorder";
import type { TrimLive } from "./useTrimDrag";

/**
 * The clips row: one box per clip (a fixed slot for a clip with no length),
 * the trim ghost, and the insertion bar while a clip is dragged to a new
 * place. After the last clip a dashed + adds clips from the library; an
 * empty sequence shows a dashed placeholder across the lane that does the
 * same (both off while the library is).
 *
 * It is a listbox: the selected clip is its one tab stop, the arrows, Home
 * and End move the selection, and the context-menu key (or ⇧F10) opens the
 * clip menu at the clip. A mouse press does not focus a clip (the selection
 * ring shows which one is chosen). When the focused clip goes (⌫, or an undo
 * or redo that takes it away), focus moves to the new tab stop, or to the
 * panel when no clip is left, so it never drops out of the dialog. The same
 * holds for the empty lane's placeholder and the add slot (a redo that
 * brings clips back unmounts a focused placeholder).
 */
export function ClipsLane({
  axis,
  spans,
  boxes,
  media,
  selectedId,
  trim,
  reorder,
  viewLeft,
  viewRight,
  laneWidth,
  onBodyPointerDown,
  onHandlePointerDown,
}: {
  axis: TimeAxis;
  spans: readonly ClipSpan[];
  boxes: readonly LaneBox[];
  media: ReadonlyMap<string, ClipMediaView>;
  selectedId: string | null;
  trim: TrimLive | null;
  reorder: ReorderLive | null;
  viewLeft: number;
  viewRight: number;
  laneWidth: number;
  onBodyPointerDown: (event: ReactPointerEvent<HTMLElement>, clipId: string, index: number) => void;
  onHandlePointerDown: (event: ReactPointerEvent<HTMLElement>, span: ClipSpan, edge: "in" | "out") => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const libraryOn = useLibraryAvailable();
  /**
   * Focus is on a clip, the placeholder or the add slot. A focused element that is removed fires no blur, so
   * this outlives it.
   */
  const focusInside = useRef(false);
  const onFocus = () => {
    focusInside.current = true;
  };
  const onBlur = (event: FocusEvent<HTMLElement>) => {
    // A blur some browser fires for the clip's own removal is not focus leaving
    if (!event.relatedTarget && !event.target.isConnected) return;
    focusInside.current = event.currentTarget.contains(event.relatedTarget as Node | null);
  };
  useLayoutEffect(() => {
    if (!focusInside.current) return;
    const row = rowRef.current;
    const active = document.activeElement;
    if (!row || (active && active !== document.body && active.isConnected)) return;
    focusInside.current = false;
    const stop = row.querySelector<HTMLElement>('[role="option"][tabindex="0"]');
    (stop ?? row.closest<HTMLElement>('[role="dialog"]'))?.focus({ preventScroll: true });
  });

  const openMenuAt = (clipId: string, x: number, y: number) => {
    const s = useStitchEditorStore.getState();
    // A drag applies what it measured at the press on release: no menu opens over it (a right press mid-trim)
    if (s.cancelGesture) return;
    s.select({ kind: "clip", clipId });
    s.openMenu({ clipId, x, y });
  };
  const openMenu = (event: MouseEvent<HTMLElement>, clipId: string) => {
    event.preventDefault();
    if (useStitchEditorStore.getState().cancelGesture) return;
    // A right press leaves a focused In/Out field focused (the clip's mousedown keeps focus): it commits now, to
    // the clip it was typed for, before the selection moves
    releaseTypingFocus(event.currentTarget);
    // A context menu from the keyboard can arrive without a pointer position: under the clip then
    if (event.clientX === 0 && event.clientY === 0) {
      const rect = event.currentTarget.getBoundingClientRect();
      openMenuAt(clipId, rect.left, rect.bottom + 4);
      return;
    }
    openMenuAt(clipId, event.clientX, event.clientY);
  };
  const tabStop = spans.some((s) => s.clip.id === selectedId) ? selectedId : (spans[0]?.clip.id ?? null);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const options = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="option"]'));
    const at = spans.findIndex((s) => s.clip.id === tabStop);
    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      const option = options[at];
      if (!option || at === -1) return;
      event.preventDefault();
      const rect = option.getBoundingClientRect();
      openMenuAt(spans[at].clip.id, rect.left, rect.bottom + 4);
      return;
    }
    let next: number | null = null;
    if (event.key === "ArrowRight") next = Math.min(spans.length - 1, at + 1);
    else if (event.key === "ArrowLeft") next = Math.max(0, at - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = spans.length - 1;
    if (next === null || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    const clipId = spans[next].clip.id;
    useStitchEditorStore.getState().select({ kind: "clip", clipId });
    options.find((el) => el.dataset.clipId === clipId)?.focus();
  };

  const rowStyle = { top: GEOMETRY.ruler, height: GEOMETRY.clipRow };
  if (spans.length === 0) {
    return (
      <div ref={rowRef} className="absolute inset-x-0 border-b border-white/6" style={rowStyle}>
        <button
          type="button"
          data-testid="stitch-empty-lane"
          aria-label="Add a clip from the library"
          title={libraryOn ? "Add from library" : undefined}
          disabled={!libraryOn}
          onClick={openLibraryPicker}
          onFocus={onFocus}
          onBlur={onBlur}
          className="absolute flex items-center justify-center rounded-md border border-dashed border-white/12 text-neutral-500 transition-colors hover:border-white/18 hover:bg-white/2 hover:text-neutral-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection disabled:pointer-events-none"
          style={{
            left: GEOMETRY.origin,
            top: GEOMETRY.clipTop,
            width: Math.max(0, laneWidth - GEOMETRY.origin - GEOMETRY.endMargin),
            height: GEOMETRY.clipHeight,
          }}
        >
          {libraryOn && <Plus size={16} strokeWidth={2} />}
        </button>
      </div>
    );
  }

  const trimIndex = trim ? spans.findIndex((s) => s.clip.id === trim.clipId) : -1;
  const ghost = (() => {
    if (!trim || trimIndex === -1 || !trim.result.ghost) return null;
    const span = spans[trimIndex];
    const base = axis.clipBox(trimIndex);
    const { fromSec, toSec } = trim.result.ghost;
    const raw = { x: base.x + (fromSec - span.start) * axis.pxPerSec, width: (toSec - fromSec) * axis.pxPerSec };
    // The ghost keeps the gap on the side it shares with the clip, and the clip's own rounded outer side
    const out = trim.edge === "out";
    const left = out ? JOIN_INSET_PX : trimIndex > 0 ? JOIN_INSET_PX : 0;
    const right = out ? (trimIndex < spans.length - 1 ? JOIN_INSET_PX : 0) : JOIN_INSET_PX;
    return {
      x: raw.x + left,
      width: Math.max(0, raw.width - left - right),
      inSec: out ? trim.result.edgeSourceTime : span.clip.inSec,
      view: media.get(span.clip.id),
      out,
    };
  })();

  // The add slot sits after the last clip as it is drawn or its resting end, whichever is further right: a
  // lengthening trim pushes it along, a shortening one leaves it after the ghost (the clips close up on release)
  const last = boxes[boxes.length - 1];
  const slotX = Math.max(last ? last.x + last.width : 0, axis.endX) + GEOMETRY.addSlotGap;

  return (
    <>
      <div
        ref={rowRef}
        role="listbox"
        aria-label="Clips"
        aria-orientation="horizontal"
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onBlur={onBlur}
        className="absolute inset-x-0 border-b border-white/6"
        style={rowStyle}
      >
        {spans.map((span, i) => {
          const view = media.get(span.clip.id);
          const box = boxes[i];
          const drawn = insetBox(box, i, spans.length);
          const mode: ClipBoxMode = !reorder ? "rest" : reorder.clipId === span.clip.id ? "lifted" : "dimmed";
          const x = mode === "lifted" && reorder ? drawn.x + reorder.dx : drawn.x;
          const selected = selectedId === span.clip.id;
          const focusable = tabStop === span.clip.id;
          const onBody = (event: ReactPointerEvent<HTMLElement>) => onBodyPointerDown(event, span.clip.id, i);
          const onMenu = (event: MouseEvent<HTMLElement>) => openMenu(event, span.clip.id);
          if (span.length <= 0) {
            return (
              <EmptyClipSlot
                key={span.clip.id}
                span={span}
                view={view}
                x={x}
                width={drawn.width}
                selected={selected}
                focusable={focusable}
                mode={mode}
                onBodyPointerDown={onBody}
                onContextMenu={onMenu}
              />
            );
          }
          return (
            <ClipBox
              key={span.clip.id}
              span={span}
              view={view}
              x={x}
              width={drawn.width}
              selected={selected}
              focusable={focusable}
              mode={mode}
              trimEdge={trimIndex === i && trim ? trim.edge : null}
              inSec={box.inSec}
              lengthSec={box.lengthSec}
              pxPerSec={axis.pxPerSec}
              viewLeft={viewLeft}
              viewRight={viewRight}
              onBodyPointerDown={onBody}
              onHandlePointerDown={(event, edge) => onHandlePointerDown(event, span, edge)}
              onContextMenu={onMenu}
            />
          );
        })}

        {ghost && ghost.width > 0 && (
          <div
            aria-hidden="true"
            data-testid="stitch-trim-ghost"
            className={ghost.out ? "absolute overflow-hidden rounded-r-media" : "absolute overflow-hidden rounded-l-media"}
            style={{ left: ghost.x, top: GEOMETRY.clipTop, width: ghost.width, height: GEOMETRY.clipHeight }}
          >
            <Filmstrip
              frames={ghost.view?.frames ?? []}
              duration={ghost.view?.duration ?? null}
              inSec={ghost.inSec}
              pxPerSec={axis.pxPerSec}
              width={ghost.width}
              boxX={ghost.x}
              viewLeft={viewLeft}
              viewRight={viewRight}
              className="opacity-30"
            />
            <div className="absolute inset-0 editor-ghost-hatch" />
          </div>
        )}

        {reorder && reorder.dropIndex !== reorder.index && (
          <div
            aria-hidden="true"
            data-testid="stitch-insertion-bar"
            className="absolute w-[3px] rounded-[2px] bg-selection"
            style={{
              left: insertionX(reorder.dropIndex, boxes, reorder.index) - 1.5,
              top: GEOMETRY.clipTop - 4,
              height: GEOMETRY.clipHeight + 8,
            }}
          />
        )}
      </div>
      <button
        type="button"
        data-testid="stitch-add-slot"
        aria-label="Add a clip from the library"
        title={libraryOn ? "Add from library" : "The asset library is off"}
        disabled={!libraryOn}
        onClick={openLibraryPicker}
        onFocus={onFocus}
        onBlur={onBlur}
        className="absolute flex items-center justify-center rounded-media border border-dashed border-white/18 bg-white/2 text-neutral-500 transition-colors hover:border-white/24 hover:text-neutral-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection disabled:opacity-40 disabled:hover:border-white/18 disabled:hover:text-neutral-500"
        style={{ left: slotX, top: GEOMETRY.ruler + GEOMETRY.clipTop, width: GEOMETRY.addSlot, height: GEOMETRY.clipHeight }}
      >
        <Plus size={16} strokeWidth={2} />
      </button>
    </>
  );
}
