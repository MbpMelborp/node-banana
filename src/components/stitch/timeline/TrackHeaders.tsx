"use client";

import { GEOMETRY } from "../editorStyles";

/**
 * The 132px column left of the lanes: a spacer beside the ruler, then the
 * Clips track (its dot and count) and the Audio track's name (its controls
 * come with the audio lane).
 */
export function TrackHeaders({ clipCount }: { clipCount: number }) {
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
      </div>
      <div className="flex shrink-0 items-center gap-2 border-b border-white/6 pl-3 pr-2" style={{ height: GEOMETRY.audioRow }}>
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-handle-audio" />
        <span className="text-xs text-neutral-300">Audio</span>
      </div>
    </div>
  );
}
