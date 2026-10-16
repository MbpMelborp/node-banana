"use client";

import type { MouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { CircleAlert } from "lucide-react";
import { cn } from "@/components/nodes/ui/cn";
import { Spinner } from "@/components/nodes/ui/Spinner";
import { clipName } from "@/lib/stitch/labels";
import { clipLength, type ClipSpan } from "@/lib/stitch/timeline";
import { GEOMETRY, LIFTED_CLIP } from "../editorStyles";
import type { ClipMediaView } from "../useStitchEditorMedia";
import { keepFocus, type ClipBoxMode } from "./ClipBox";

/** Why a clip has no length on the timeline. */
export function emptyReason(
  span: ClipSpan,
  view: ClipMediaView | undefined,
): "gone" | "loading" | "error" | "past-end" | "under-frame" | "empty" {
  if (view?.missing) return "gone";
  if (view?.status === "loading") return "loading";
  if (view?.status === "error") return "error";
  if (view?.status === "ready" && view.duration !== null) {
    if (span.clip.inSec >= view.duration) return "past-end";
    // A source generated again shorter can leave a trim under one output frame, which the encode drops
    if (view.duration > 0 && clipLength(span.clip, view.duration) === 0) return "under-frame";
  }
  return "empty";
}

const COPY = {
  empty: "not generated yet",
  loading: "loading",
  error: "can't read this video",
  gone: "not in the library",
  "past-end": "trim starts past the end",
  "under-frame": "trim is shorter than a frame",
} as const;

/** What an empty clip's slot says after its name ("not generated yet"); Stacked's row header shows it too. */
export function emptyCopy(span: ClipSpan, view: ClipMediaView | undefined): string {
  return COPY[emptyReason(span, view)];
}

/**
 * A clip with no length: a source that has not run, one still being read
 * or one that cannot be, a library video the library no longer has, or a
 * trim that starts past the source's end or leaves less than a frame. It
 * keeps its place in the order as a fixed 160px slot that counts 0 s, and
 * can be selected like a clip (so Reset trim fixes a trim past the end).
 */
export function EmptyClipSlot({
  span,
  view,
  x,
  width,
  selected,
  focusable,
  mode,
  top = GEOMETRY.clipTop,
  height = GEOMETRY.clipHeight,
  onBodyPointerDown,
  onContextMenu,
}: {
  span: ClipSpan;
  view: ClipMediaView | undefined;
  x: number;
  width: number;
  selected: boolean;
  /** The listbox's one tab stop. */
  focusable: boolean;
  mode: ClipBoxMode;
  /** In its row: Track's clips row by default, a Stacked row's box otherwise. */
  top?: number;
  height?: number;
  onBodyPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onContextMenu: (event: MouseEvent<HTMLElement>) => void;
}) {
  const reason = emptyReason(span, view);
  const name = clipName(span.index);
  return (
    <div
      data-clip-id={span.clip.id}
      data-empty-reason={reason}
      aria-label={name}
      aria-selected={selected}
      role="option"
      tabIndex={focusable ? 0 : -1}
      onPointerDown={onBodyPointerDown}
      onMouseDown={keepFocus}
      onContextMenu={onContextMenu}
      className={cn(
        "absolute flex items-center justify-center gap-1.5 overflow-hidden rounded-media border border-dashed border-white/20 bg-white/2 text-[11px] text-neutral-500 select-none outline-none focus-visible:ring-2 focus-visible:ring-selection",
        mode === "lifted" && cn(LIFTED_CLIP, "bg-editor-chrome"),
        mode === "dimmed" && "opacity-40",
        mode === "rest" && selected && "ring-2 ring-selection",
      )}
      style={{ left: x, top, width, height }}
    >
      {reason === "loading" ? (
        <Spinner size={13} className="shrink-0" />
      ) : (
        <CircleAlert size={13} strokeWidth={1.75} className="shrink-0" />
      )}
      {/* No side padding, as on the States board, so "not generated yet" fits one line; a longer reason wraps, balanced, rather than lose its end */}
      <span className="line-clamp-2 min-w-0 text-balance leading-[14px]">{`${name} · ${COPY[reason]}`}</span>
    </div>
  );
}
