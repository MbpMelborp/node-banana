"use client";

import type { MouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { Volume1, VolumeX } from "lucide-react";
import { cn } from "@/components/nodes/ui/cn";
import { clipName } from "@/lib/stitch/labels";
import { formatSeconds } from "@/lib/stitch/timecode";
import type { ClipSpan } from "@/lib/stitch/timeline";
import { setClipMuted } from "../editorActions";
import { GEOMETRY, LABEL_BAR, LIFTED_CLIP } from "../editorStyles";
import type { ClipMediaView } from "../useStitchEditorMedia";
import { Filmstrip } from "./Filmstrip";

/** At rest; "dimmed" while another clip is being dragged to a new place; "lifted" while this one is. */
export type ClipBoxMode = "rest" | "dimmed" | "lifted";

const stopPress = (event: ReactPointerEvent) => event.stopPropagation();
/** Each handle takes at most this share of a narrow clip, so its middle third stays a body to press and drag. */
const HANDLE_SHARE = 1 / 3;
/** A handle narrower than this shows no grip. */
const MIN_GRIP_HANDLE_PX = 4;
/** The handles' width on a clip drawn this wide: the boards' 10px, narrower on a clip too short for two. */
const handleWidthFor = (width: number) => Math.min(GEOMETRY.handle, width * HANDLE_SHARE);
/** A mouse press takes no focus: a focused clip or button would be unmounted by its own action and drop focus out of the editor. */
export const keepFocus = (event: MouseEvent) => event.preventDefault();

function Handle({
  side,
  width,
  selected,
  active,
  onPointerDown,
}: {
  side: "in" | "out";
  width: number;
  selected: boolean;
  active: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
}) {
  return (
    <div
      role="presentation"
      data-trim-handle={side}
      onPointerDown={onPointerDown}
      className={cn(
        "absolute inset-y-0 z-1 flex items-center justify-center cursor-ew-resize",
        side === "in" ? "left-0" : "right-0",
        active ? "bg-neutral-200" : selected ? "bg-selection" : "bg-white/18 opacity-0 group-hover:opacity-100",
      )}
      style={{ width }}
    >
      {/* The grip, where the handle has room for it */}
      {width >= MIN_GRIP_HANDLE_PX && (
        <span
          aria-hidden="true"
          className={cn("h-3.5 w-0.5 rounded-[1px]", active ? "bg-neutral-900" : selected ? "bg-white/85" : "bg-white/80")}
        />
      )}
    </div>
  );
}

/**
 * One clip on the lane (design-spec §6.4, States): its frames, the label
 * bar with name, source and trimmed length, trim handles when hovered or
 * selected, and its sound: the badge on a muted clip (on hover, the button
 * that unmutes it) or, on hover, the button that mutes it. Those two are
 * pointer shortcuts, hidden from the accessibility tree and the tab order:
 * an option holds no controls, and ⌥M and the clip menu do the same.
 */
export function ClipBox({
  span,
  view,
  x,
  width,
  selected,
  focusable,
  mode,
  trimEdge,
  inSec,
  lengthSec,
  pxPerSec,
  viewLeft,
  viewRight,
  onBodyPointerDown,
  onHandlePointerDown,
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
  /** The edge being dragged on this clip, if any. */
  trimEdge: "in" | "out" | null;
  /** Live while trimming: the In and the length the drag gives. */
  inSec: number;
  lengthSec: number;
  pxPerSec: number;
  viewLeft: number;
  viewRight: number;
  onBodyPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onHandlePointerDown: (event: ReactPointerEvent<HTMLElement>, edge: "in" | "out") => void;
  onContextMenu: (event: MouseEvent<HTMLElement>) => void;
}) {
  const { clip } = span;
  const name = clipName(span.index);
  const atRest = mode === "rest";
  const showHandles = atRest;
  const handleWidth = handleWidthFor(width);
  // The label bar and badges make room for handles while they show
  const inset = selected || trimEdge ? "left-2.5 right-2.5" : "left-0 right-0 group-hover:left-2.5 group-hover:right-2.5";
  const badgeLeft = selected || trimEdge ? "left-4" : "left-1.5 group-hover:left-4";

  return (
    <div
      data-clip-id={clip.id}
      aria-label={name}
      aria-selected={selected}
      role="option"
      tabIndex={focusable ? 0 : -1}
      onPointerDown={onBodyPointerDown}
      onMouseDown={keepFocus}
      onContextMenu={onContextMenu}
      className={cn(
        "group absolute overflow-hidden rounded-media bg-editor-chrome select-none outline-none focus-visible:ring-2 focus-visible:ring-selection",
        mode === "lifted"
          ? cn(LIFTED_CLIP, "ring-1 ring-white/20")
          : mode === "dimmed"
            ? "opacity-40 ring-1 ring-white/10"
            : selected || trimEdge
              ? "ring-2 ring-selection"
              : "ring-1 ring-white/10 hover:ring-white/24",
        trimEdge === "in" && "z-1",
      )}
      style={{ left: x, top: GEOMETRY.clipTop, width, height: GEOMETRY.clipHeight }}
    >
      <Filmstrip
        frames={view?.frames ?? []}
        duration={view?.duration ?? null}
        inSec={inSec}
        pxPerSec={pxPerSec}
        width={width}
        boxX={x}
        viewLeft={viewLeft}
        viewRight={viewRight}
      />

      {mode !== "dimmed" && (
        <div
          className={cn(
            "pointer-events-none absolute bottom-0 flex items-center gap-1.5 px-2 text-[11px] leading-none",
            LABEL_BAR,
            mode === "lifted" ? "left-0 right-0" : inset,
          )}
          style={{ height: GEOMETRY.labelBar }}
        >
          <span className="shrink-0 font-medium text-neutral-100">{name}</span>
          {mode === "rest" && (
            <>
              <span className="truncate text-neutral-400">{view?.sourceLabel ?? ""}</span>
              <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-neutral-300">
                {formatSeconds(lengthSec, trimEdge ? 2 : 1)}
              </span>
            </>
          )}
        </div>
      )}

      {atRest && clip.muted && (
        <button
          type="button"
          aria-label="Unmute clip audio"
          aria-hidden="true"
          tabIndex={-1}
          title="Clip audio muted"
          onPointerDown={stopPress}
          onMouseDown={keepFocus}
          onClick={() => setClipMuted(clip.id, false)}
          className={cn(
            "absolute top-1.5 z-2 inline-flex h-[18px] w-[18px] items-center justify-center rounded-[5px] bg-black/60 text-neutral-300 hover:text-neutral-100",
            badgeLeft,
          )}
        >
          <VolumeX size={11} strokeWidth={2} />
        </button>
      )}
      {atRest && !clip.muted && !trimEdge && (
        <button
          type="button"
          aria-label="Mute clip audio"
          aria-hidden="true"
          tabIndex={-1}
          onPointerDown={stopPress}
          onMouseDown={keepFocus}
          onClick={() => setClipMuted(clip.id, true)}
          className="absolute right-4 top-1.5 z-2 inline-flex h-[18px] w-[18px] items-center justify-center rounded-[5px] bg-black/60 text-neutral-100 opacity-0 group-hover:opacity-100"
        >
          <Volume1 size={11} strokeWidth={2} />
        </button>
      )}

      {showHandles && (
        <>
          <Handle
            side="in"
            width={handleWidth}
            selected={selected || trimEdge !== null}
            active={trimEdge === "in"}
            onPointerDown={(event) => onHandlePointerDown(event, "in")}
          />
          <Handle
            side="out"
            width={handleWidth}
            selected={selected || trimEdge !== null}
            active={trimEdge === "out"}
            onPointerDown={(event) => onHandlePointerDown(event, "out")}
          />
        </>
      )}
    </div>
  );
}
