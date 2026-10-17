"use client";

import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import { Plus, VolumeX } from "lucide-react";
import { cn } from "@/components/nodes/ui/cn";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { clipName } from "@/lib/stitch/labels";
import { formatSeconds } from "@/lib/stitch/timecode";
import type { ClipSpan } from "@/lib/stitch/timeline";
import { canLineUp, lineUpClips, openLibraryPicker } from "../editorActions";
import { GEOMETRY, TEXT_GHOST } from "../editorStyles";
import { useLibraryAvailable } from "../library/useLibraryAvailable";
import type { ClipMediaView } from "../useStitchEditorMedia";
import { AudioTrackHeader } from "./AudioTrackHeader";
import { keepFocus } from "./ClipBox";
import { openClipMenu } from "./ClipsLane";
import { emptyCopy } from "./EmptyClipSlot";

/** Stacked's rows, for one header per clip. */
export interface StackedHeaderRows {
  spans: readonly ClipSpan[];
  media: ReadonlyMap<string, ClipMediaView>;
  /** Every clip drawn selected: its header is tinted. */
  selectedIds: ReadonlySet<string>;
  /** The rows' inner block: the timeline writes its translateY as the lanes scroll, with no render. */
  rowsRef: RefObject<HTMLDivElement | null>;
  /** The insertion line while a clip is dragged (by its header or its box), in rows px; null when it would not move. */
  insertionY: number | null;
  /** The lanes' horizontal scrollbar, px (0 without one): the audio header stays level with its row. */
  hBar: number;
  /**
   * A press on a header is a press on its clip: a click selects it (⌘ and ⇧ as on its box), a drag moves it up or down,
   * with the rest of the selection when it is one of several.
   */
  onRowPointerDown: (event: ReactPointerEvent<HTMLElement>, clipId: string, index: number) => void;
}

/** The 20px + that opens the library picker: in the Clips header in Track, in the corner in Stacked. */
function AddButton({ libraryOn, className }: { libraryOn: boolean; className?: string }) {
  return (
    <button
      type="button"
      aria-label="Add a clip from the library"
      title={libraryOn ? "Add from library" : "The asset library is off"}
      disabled={!libraryOn}
      onClick={openLibraryPicker}
      className={cn(
        "-mr-1 inline-flex h-5 w-5 items-center justify-center rounded-[5px] text-neutral-400 transition-colors hover:bg-white/6 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-neutral-400",
        className,
      )}
    >
      <Plus size={13} strokeWidth={2} />
    </button>
  );
}

/** Stacked's corner: Line up puts every clip back where Overlap lays it out, once some clip has been placed by hand. */
function LineUpButton() {
  const enabled = useStitchEditorStore(canLineUp);
  const overlapSec = useStitchEditorStore((s) => s.draft?.sequenceLayout.overlapSec ?? 0);
  const title = !enabled
    ? "The clips are lined up"
    : overlapSec > 0
      ? `Line up: each clip starts ${formatSeconds(overlapSec, 1)} before the one above ends`
      : "Line up: each clip starts where the one above ends";
  return (
    <button
      type="button"
      title={title}
      disabled={!enabled}
      onClick={(event) => {
        // It is disabled once the clips are lined up: focus on it goes to the panel, never <body>
        const button = event.currentTarget;
        lineUpClips();
        if (document.activeElement === button) button.closest<HTMLElement>('[role="dialog"]')?.focus({ preventScroll: true });
      }}
      className={cn(TEXT_GHOST, "-ml-1.5 h-5 px-1.5 text-[11px]")}
    >
      Line up
    </button>
  );
}

/**
 * The 132px column left of the lanes. In Track: an empty corner beside the
 * ruler, the Clips track (its dot, count and the + that adds from the
 * library), then the Audio track (its mute, and its dB labels while it is
 * selected). In Stacked the + moves to the corner and each clip has a 52px
 * header naming it and its source; the headers scroll with the rows and are
 * handles to drag a clip up or down (outside the listbox, as an option holds
 * no controls). A right press on one opens its clip's menu. Line up sits in
 * Stacked's corner, left of the +. Track | Stacked is in the transport
 * (LayoutToggle).
 */
export function TrackHeaders({
  clipCount,
  audioExpanded,
  audioMuted,
  canMuteAudio,
  stackedRows = null,
}: {
  clipCount: number;
  audioExpanded: boolean;
  audioMuted: boolean;
  canMuteAudio: boolean;
  /** Stacked's rows; null in Track. */
  stackedRows?: StackedHeaderRows | null;
}) {
  const libraryOn = useLibraryAvailable();
  return (
    <div
      className="relative z-2 flex shrink-0 flex-col border-r border-chrome-border/50 bg-editor-chrome"
      style={{ width: GEOMETRY.trackHeader }}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-white/6 px-3" style={{ height: GEOMETRY.ruler }}>
        {stackedRows && (
          <>
            <LineUpButton />
            <AddButton libraryOn={libraryOn} className="ml-auto" />
          </>
        )}
      </div>
      {stackedRows ? (
        <StackedRows rows={stackedRows} />
      ) : (
        <div className="flex shrink-0 items-center gap-2 border-b border-white/6 px-3" style={{ height: GEOMETRY.clipRow }}>
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-handle-video" />
          <span className="text-xs text-neutral-300">Clips</span>
          <span className="ml-auto font-mono text-[11px] text-neutral-500" data-testid="stitch-clip-count">
            {clipCount}
          </span>
          <AddButton libraryOn={libraryOn} />
        </div>
      )}
      <AudioTrackHeader expanded={audioExpanded} muted={audioMuted} canMute={canMuteAudio} />
      {stackedRows && <div aria-hidden="true" className="shrink-0" style={{ height: stackedRows.hBar }} />}
    </div>
  );
}

function StackedRows({ rows }: { rows: StackedHeaderRows }) {
  const { spans, media, selectedIds, rowsRef, insertionY, onRowPointerDown } = rows;
  return (
    <div className="relative min-h-0 flex-1 overflow-hidden">
      <div
        ref={rowsRef}
        data-testid="stitch-row-headers"
        className="absolute inset-x-0 top-0"
        style={{ height: Math.max(1, spans.length) * GEOMETRY.stackRow }}
      >
        {spans.map((span, i) => {
          const view = media.get(span.clip.id);
          const selected = selectedIds.has(span.clip.id);
          const empty = span.length <= 0;
          return (
            <div
              key={span.clip.id}
              aria-hidden="true"
              data-row-header={span.clip.id}
              onPointerDown={(event) => onRowPointerDown(event, span.clip.id, i)}
              onMouseDown={keepFocus}
              onContextMenu={(event) => openClipMenu(event, span.clip.id)}
              className={cn(
                "absolute inset-x-0 flex cursor-grab items-center gap-2 border-b border-white/4 px-3 select-none",
                selected && "bg-white/4",
              )}
              style={{ top: i * GEOMETRY.stackRow, height: GEOMETRY.stackRow }}
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <span className={cn("truncate text-xs", selected ? "text-neutral-100" : "text-neutral-300")}>
                  {clipName(span.index)}
                </span>
                <span className={cn("truncate text-[11px]", empty ? "text-neutral-600" : "text-neutral-500")}>
                  {empty ? emptyCopy(span, view) : (view?.sourceLabel ?? "")}
                </span>
              </div>
              {span.clip.muted && <VolumeX size={11} strokeWidth={2} className="shrink-0 text-neutral-500" />}
            </div>
          );
        })}
        {insertionY !== null && (
          <div
            aria-hidden="true"
            data-testid="stitch-header-insertion"
            className="pointer-events-none absolute inset-x-0 z-1 h-[3px] rounded-[2px] bg-selection"
            style={{ top: insertionY - 1.5 }}
          />
        )}
      </div>
    </div>
  );
}
