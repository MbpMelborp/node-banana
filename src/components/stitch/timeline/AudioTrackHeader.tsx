"use client";

import type { MouseEvent, UIEvent } from "react";
import { ChevronDown, ChevronUp, Plus, Spline, Volume1, VolumeX } from "lucide-react";
import { cn } from "@/components/nodes/ui/cn";
import { DB_GUIDES, dbToGain, gainToLevel } from "@/lib/stitch/curve";
import { EXPANDED_CURVE, levelToY } from "@/lib/stitch/curveGeometry";
import { hiddenAudioRows, type AudioSectionLayout } from "@/lib/stitch/audioLayout";
import { openLibraryPicker, toggleAudioRowExpanded, toggleMusicMute, toggleRowMute } from "../editorActions";
import { GEOMETRY } from "../editorStyles";
import { audioRowName } from "./AudioLane";

/** The dB labels' line height; each is centred on its level. */
const DB_LABEL_LINE = 12;
/** The header's control row: 20px high, its bottom GEOMETRY.audioControlsBottom above the row's. */
const CONTROLS_HEIGHT = 20;

const HEADER_BUTTON =
  "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] transition-colors hover:bg-white/6 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection disabled:opacity-40 disabled:hover:bg-transparent";

/** A press on a header button keeps focus where it is: the editor's keys go on working. */
const keepFocus = (event: MouseEvent) => event.preventDefault();

/** One audio row as its header shows it. */
export interface AudioHeaderRow {
  /** Every clip on it is muted. */
  muted: boolean;
  /** It holds a clip (a row a move emptied holds none until the rows close up). */
  hasClips: boolean;
}

/** The audio rows' headers, as the timeline lays them out. */
export interface AudioHeaderRows {
  layout: AudioSectionLayout;
  /** The rows' scroll, shared with the lanes. */
  scroll: number;
  expandedRow: number | null;
  rows: readonly AudioHeaderRow[];
  /** No audio clip at all: the one row is a placeholder, and only a legacy node's muted music can be unmuted there. */
  legacyMuted: boolean;
  libraryOn: boolean;
  /** The view was scrolled by the browser (focus moved into a hidden row): the scroll joins the shared translate. */
  onViewScroll: (event: UIEvent<HTMLDivElement>) => void;
}

/**
 * One audio row's header: its dot and name, the row's mute (every clip on
 * it; unmuted when all are muted) and the volume-line toggle, which makes
 * the row taller to edit its clips' curves (one row at a time). The control
 * row sits 22px above the row's bottom in both heights and the row grows
 * upward, so the toggle stays under the pointer; the dB labels stand above
 * it while the row is expanded.
 */
function AudioRowHeader({
  row,
  top,
  height,
  expanded,
  info,
  placeholder,
  legacyMuted,
}: {
  row: number;
  top: number;
  height: number;
  expanded: boolean;
  info: AudioHeaderRow | undefined;
  /** The row that says how to add audio: no clips anywhere. */
  placeholder: boolean;
  legacyMuted: boolean;
}) {
  const muted = placeholder ? legacyMuted : (info?.muted ?? false);
  const canMute = placeholder ? legacyMuted : (info?.hasClips ?? false);
  const muteLabel = muted ? `Unmute ${audioRowName(row)}` : `Mute ${audioRowName(row)}`;
  const toggleLabel = expanded ? "Hide volume curve" : "Show volume curve";
  const controlsTop = height - GEOMETRY.audioControlsBottom - CONTROLS_HEIGHT;
  return (
    <div
      data-audio-row-header={row}
      className="absolute inset-x-0 border-b border-white/6"
      style={{ top, height }}
    >
      <div
        className="absolute inset-x-0 flex items-center gap-2 pl-3 pr-2"
        style={{ bottom: GEOMETRY.audioControlsBottom, height: CONTROLS_HEIGHT }}
      >
        <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-handle-audio" />
        <span className="truncate text-xs text-neutral-300">{placeholder ? "Audio" : audioRowName(row)}</span>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {(canMute || !placeholder) && (
            <button
              type="button"
              aria-label={muteLabel}
              title={muteLabel}
              disabled={!canMute}
              onMouseDown={keepFocus}
              onClick={() => (placeholder ? toggleMusicMute() : toggleRowMute(row))}
              className={cn(HEADER_BUTTON, muted ? "text-neutral-100" : "text-neutral-400")}
            >
              {muted ? <VolumeX size={13} strokeWidth={1.75} /> : <Volume1 size={13} strokeWidth={1.75} />}
            </button>
          )}
          {!placeholder && (
            <button
              type="button"
              aria-label={toggleLabel}
              title={toggleLabel}
              aria-expanded={expanded}
              onMouseDown={keepFocus}
              onClick={() => toggleAudioRowExpanded(row)}
              className={cn(HEADER_BUTTON, expanded ? "bg-white/10 text-neutral-100" : "text-neutral-400")}
            >
              <Spline size={13} strokeWidth={1.75} />
            </button>
          )}
        </div>
      </div>
      {expanded &&
        DB_GUIDES.map((guide) => {
          const centre = GEOMETRY.audioBlockTop + levelToY(gainToLevel(dbToGain(guide.db)), EXPANDED_CURVE);
          // Only where it stands clear above the control row
          if (centre + DB_LABEL_LINE / 2 > controlsTop) return null;
          return (
            <span
              key={guide.label}
              aria-hidden="true"
              data-testid="stitch-db-label"
              className="absolute right-2.5 font-mono text-[9px] text-neutral-500"
              style={{ top: centre - DB_LABEL_LINE / 2, lineHeight: `${DB_LABEL_LINE}px` }}
            >
              {guide.label}
            </span>
          );
        })}
    </div>
  );
}

/**
 * The audio rows' headers, level with the audio section in the lanes: a view
 * as tall as the section's, the headers scrolled with the rows by the same
 * translate, and under them the strip's header with "+ Add audio" (off while
 * the asset library is).
 */
export function AudioHeaders({ audio }: { audio: AudioHeaderRows }) {
  const { layout, scroll, expandedRow, rows, legacyMuted, libraryOn, onViewScroll } = audio;
  const placeholder = rows.length === 0;
  // Rows past the view show no edge of their own: the strip counts them
  const hidden = hiddenAudioRows(scroll, layout);
  const hiddenTitle = [
    hidden.above > 0 ? `${hidden.above} audio row${hidden.above === 1 ? "" : "s"} above` : "",
    hidden.below > 0 ? `${hidden.below} audio row${hidden.below === 1 ? "" : "s"} below` : "",
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <div data-audio-section="" className="relative shrink-0" style={{ height: layout.sectionHeight }}>
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 z-1 h-px bg-white/6" />
      <div className="relative overflow-hidden" style={{ height: layout.viewHeight }} onScroll={onViewScroll}>
        <div
          data-testid="stitch-audio-headers"
          className="absolute inset-x-0 top-0"
          style={{ height: layout.rowsHeight, transform: `translateY(${-scroll}px)` }}
        >
          {layout.rowTops.map((top, row) => (
            <AudioRowHeader
              key={row}
              row={row}
              top={top}
              height={layout.rowHeights[row]}
              expanded={row === expandedRow}
              info={rows[row]}
              placeholder={placeholder}
              legacyMuted={legacyMuted}
            />
          ))}
        </div>
      </div>
      <div className="flex items-center px-2" style={{ height: GEOMETRY.audioStrip }}>
        <button
          type="button"
          title={libraryOn ? "Add audio from the library" : "The asset library is off"}
          disabled={!libraryOn}
          onClick={() => openLibraryPicker("audio")}
          className="inline-flex h-5 items-center gap-1 rounded-[5px] px-1 text-[11px] text-neutral-400 transition-colors hover:bg-white/6 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-neutral-400"
        >
          <Plus size={12} strokeWidth={2} />
          Add audio
        </button>
        {hiddenTitle && (
          <span
            data-testid="stitch-audio-hidden-rows"
            title={`${hiddenTitle}: scroll over the rows`}
            className="ml-auto flex shrink-0 items-center gap-1 font-mono text-[10px] tabular-nums text-neutral-500"
          >
            <span className="sr-only">{hiddenTitle}</span>
            {hidden.above > 0 && (
              <span aria-hidden="true" className="flex items-center">
                <ChevronUp size={12} strokeWidth={2} />
                {hidden.above}
              </span>
            )}
            {hidden.below > 0 && (
              <span aria-hidden="true" className="flex items-center">
                <ChevronDown size={12} strokeWidth={2} />
                {hidden.below}
              </span>
            )}
          </span>
        )}
      </div>
    </div>
  );
}
