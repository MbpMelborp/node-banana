"use client";

import { Plus } from "lucide-react";
import { openLibraryPicker } from "../editorActions";
import { GEOMETRY } from "../editorStyles";
import { useLibraryAvailable } from "../library/useLibraryAvailable";
import { AudioTrackHeader } from "./AudioTrackHeader";

/**
 * The 132px column left of the lanes: a spacer beside the ruler, then the
 * Clips track (its dot, count and the + that adds from the library) and the
 * Audio track (its mute, and its dB labels while it is selected).
 */
export function TrackHeaders({
  clipCount,
  audioExpanded,
  audioMuted,
  canMuteAudio,
}: {
  clipCount: number;
  audioExpanded: boolean;
  audioMuted: boolean;
  canMuteAudio: boolean;
}) {
  const libraryOn = useLibraryAvailable();
  return (
    <div
      className="relative z-2 flex shrink-0 flex-col border-r border-chrome-border/50 bg-editor-chrome"
      style={{ width: GEOMETRY.trackHeader }}
    >
      <div className="shrink-0 border-b border-white/6" style={{ height: GEOMETRY.ruler }} />
      <div className="flex shrink-0 items-center gap-2 border-b border-white/6 px-3" style={{ height: GEOMETRY.clipRow }}>
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-handle-video" />
        <span className="text-xs text-neutral-300">Clips</span>
        <span className="ml-auto font-mono text-[11px] text-neutral-500" data-testid="stitch-clip-count">
          {clipCount}
        </span>
        <button
          type="button"
          aria-label="Add a clip from the library"
          title={libraryOn ? "Add from library" : "The asset library is off"}
          disabled={!libraryOn}
          onClick={openLibraryPicker}
          className="-mr-1 inline-flex h-5 w-5 items-center justify-center rounded-[5px] text-neutral-400 transition-colors hover:bg-white/6 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-neutral-400"
        >
          <Plus size={13} strokeWidth={2} />
        </button>
      </div>
      <AudioTrackHeader expanded={audioExpanded} muted={audioMuted} canMute={canMuteAudio} />
    </div>
  );
}
