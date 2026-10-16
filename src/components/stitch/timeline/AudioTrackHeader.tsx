"use client";

import { Volume1, VolumeX } from "lucide-react";
import { cn } from "@/components/nodes/ui/cn";
import { DB_GUIDES, dbToGain, gainToLevel } from "@/lib/stitch/curve";
import { EXPANDED_CURVE, levelToY } from "@/lib/stitch/curveGeometry";
import { toggleMusicMute } from "../editorActions";
import { GEOMETRY } from "../editorStyles";

/** The dB labels' line height; each is centred on its level. */
const DB_LABEL_LINE = 12;

/**
 * The Audio track's header: its dot and name and the track's mute (also M).
 * While the track is selected the row is taller and top-aligned, the mute
 * sits right after the name, and the dB labels stand at the right beside
 * the lane's guides (not while muted: the lane draws no curve or guides
 * then). The name row is one element in both sizes, so the mute button is
 * not remounted, and keeps the keyboard focus, when the row grows or
 * shrinks.
 */
export function AudioTrackHeader({
  expanded,
  muted,
  canMute,
}: {
  expanded: boolean;
  muted: boolean;
  /** Music is connected (or the track is muted and can be unmuted). */
  canMute: boolean;
}) {
  const label = muted ? "Unmute audio track" : "Mute audio track";
  return (
    <div
      className="relative shrink-0 border-b border-white/6 pl-3 pr-2"
      style={{ height: expanded ? GEOMETRY.audioRowExpanded : GEOMETRY.audioRow }}
    >
      <div className={cn("flex items-center gap-2", expanded ? "pt-2.5" : "h-full")}>
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-handle-audio" />
        <span className="text-xs text-neutral-300">Audio</span>
        {canMute && (
          <button
            type="button"
            aria-label={label}
            title={label}
            onMouseDown={(event) => event.preventDefault()}
            onClick={toggleMusicMute}
            className={cn(
              "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] transition-colors hover:bg-white/6 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection",
              muted ? "text-neutral-100" : "text-neutral-400",
              !expanded && "ml-auto",
            )}
          >
            {muted ? <VolumeX size={13} strokeWidth={1.75} /> : <Volume1 size={13} strokeWidth={1.75} />}
          </button>
        )}
      </div>
      {expanded &&
        !muted &&
        DB_GUIDES.map((guide) => (
          <span
            key={guide.label}
            aria-hidden="true"
            data-testid="stitch-db-label"
            className="absolute right-2.5 font-mono text-[9px] text-neutral-500"
            style={{
              top: GEOMETRY.audioBlockTop + levelToY(gainToLevel(dbToGain(guide.db)), EXPANDED_CURVE) - DB_LABEL_LINE / 2,
              lineHeight: `${DB_LABEL_LINE}px`,
            }}
          >
            {guide.label}
          </span>
        ))}
    </div>
  );
}
