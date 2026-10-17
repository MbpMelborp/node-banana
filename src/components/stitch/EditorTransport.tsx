"use client";

import type { CSSProperties, MouseEvent } from "react";
import { Blend, Magnet, Pause, Play, SkipBack, SkipForward, Volume2, VolumeX, ZoomIn, ZoomOut } from "lucide-react";
import { cn } from "@/components/nodes/ui/cn";
import { MenuDivider } from "@/components/ui/Menu";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { MAX_PX_PER_SEC, MIN_PX_PER_SEC } from "@/lib/stitch/timeAxis";
import { formatTimecode } from "@/lib/stitch/timecode";
import { goToEnd, goToStart, setCrossfade, togglePlay } from "./editorActions";
import { isTypingTarget } from "./editorKeys";
import { ICON_BUTTON, TEXT_GHOST, TOGGLE_ON } from "./editorStyles";
import { LayoutToggle } from "./LayoutToggle";
import type { TimelineZoom } from "./timeline/useTimelineZoom";

/**
 * A click must not take focus from the panel, or Space would press the button instead of playing. A timecode
 * well being edited is settled first (its blur commits), with focus handed to the panel, so the next Space plays
 * rather than typing into it.
 */
const keepFocus = (event: MouseEvent<HTMLElement>) => {
  if (isTypingTarget(document.activeElement)) {
    const panel = event.currentTarget.closest<HTMLElement>('[role="dialog"]');
    if (panel) panel.focus();
    else (document.activeElement as HTMLElement).blur();
  }
  event.preventDefault();
};

/**
 * The 44px transport under the stage: start, play, end, the timecode, then
 * Snap, preview Sound, Crossfade (Stacked only), the timeline's zoom (out,
 * the slider, in, Fit) and Track | Stacked. Inert while the editor has no
 * clips.
 */
export function EditorTransport({
  total,
  empty,
  zoom,
}: {
  total: number;
  empty: boolean;
  zoom: Pick<TimelineZoom, "slider" | "setSlider" | "zoomIn" | "zoomOut" | "fit" | "pxPerSec">;
}) {
  const playing = useStitchEditorStore((s) => s.playing);
  const playhead = useStitchEditorStore((s) => s.playhead);
  const snap = useStitchEditorStore((s) => s.snap);
  const soundOn = useStitchEditorStore((s) => s.soundOn);
  const setSnap = useStitchEditorStore((s) => s.setSnap);
  const setSoundOn = useStitchEditorStore((s) => s.setSoundOn);
  const stacked = useStitchEditorStore((s) => s.draft?.sequenceLayout.mode === "stacked");
  const crossfade = useStitchEditorStore((s) => s.draft?.sequenceLayout.crossfade ?? false);

  return (
    <div
      className={cn(
        "h-11 shrink-0 flex items-center gap-1 px-3 border-t border-chrome-border/50 bg-editor-chrome",
        empty && "opacity-50 pointer-events-none",
      )}
      inert={empty}
    >
      <button type="button" aria-label="Go to start" className={ICON_BUTTON} onMouseDown={keepFocus} onClick={goToStart}>
        <SkipBack size={14} strokeWidth={2} fill="currentColor" />
      </button>
      <button
        type="button"
        aria-label={playing ? "Pause" : "Play"}
        className="h-7 w-7 inline-flex items-center justify-center rounded-md bg-neutral-200 text-neutral-900 transition-colors hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection"
        onMouseDown={keepFocus}
        onClick={togglePlay}
      >
        {playing ? (
          <Pause size={14} strokeWidth={0} fill="currentColor" />
        ) : (
          <Play size={14} strokeWidth={0} fill="currentColor" />
        )}
      </button>
      <button type="button" aria-label="Go to end" className={ICON_BUTTON} onMouseDown={keepFocus} onClick={goToEnd}>
        <SkipForward size={14} strokeWidth={2} fill="currentColor" />
      </button>
      <span className="ml-2.5 font-mono tabular-nums text-[13px] text-neutral-100" data-testid="stitch-playhead">
        {formatTimecode(Math.min(playhead, total))}
      </span>
      <span className="font-mono tabular-nums text-xs text-neutral-500">{`/ ${formatTimecode(total)}`}</span>

      <div className="flex-1" />

      <button
        type="button"
        aria-pressed={snap}
        className={cn(TEXT_GHOST, snap && TOGGLE_ON)}
        onMouseDown={keepFocus}
        onClick={() => setSnap(!snap)}
      >
        <Magnet size={14} strokeWidth={1.75} />
        Snap
      </button>
      <button
        type="button"
        aria-label="Sound"
        aria-pressed={soundOn}
        className={cn(ICON_BUTTON, soundOn && "text-neutral-100")}
        onMouseDown={keepFocus}
        onClick={() => setSoundOn(!soundOn)}
      >
        {soundOn ? <Volume2 size={16} strokeWidth={1.75} /> : <VolumeX size={16} strokeWidth={1.75} />}
      </button>
      {/* The row's right end is fixed, so showing this moves Snap and Sound left, never the zoom or the toggle */}
      {stacked && (
        <button
          type="button"
          aria-pressed={crossfade}
          className={cn(TEXT_GHOST, crossfade && TOGGLE_ON)}
          onMouseDown={keepFocus}
          onClick={() => setCrossfade(!crossfade)}
        >
          <Blend size={14} strokeWidth={1.75} />
          Crossfade
        </button>
      )}
      <MenuDivider variant="bar" className="mx-2" aria-hidden="true" />
      {/* -mx-[7px]: each takes its 14px icon's room in the row, as drawn, and keeps the 28px hit area */}
      <button
        type="button"
        aria-label="Zoom out"
        className={cn(ICON_BUTTON, "-mx-[7px]")}
        disabled={zoom.pxPerSec <= MIN_PX_PER_SEC}
        onMouseDown={keepFocus}
        onClick={zoom.zoomOut}
      >
        <ZoomOut size={14} strokeWidth={1.75} className="text-neutral-500" />
      </button>
      <input
        type="range"
        aria-label="Timeline zoom"
        className="range-ink mx-1.5 w-24"
        min={0}
        max={100}
        step={0.5}
        value={zoom.slider}
        onChange={(event) => zoom.setSlider(Number(event.target.value))}
        style={{ "--p": `${zoom.slider}%` } as CSSProperties}
      />
      <button
        type="button"
        aria-label="Zoom in"
        className={cn(ICON_BUTTON, "-mx-[7px]")}
        disabled={zoom.pxPerSec >= MAX_PX_PER_SEC}
        onMouseDown={keepFocus}
        onClick={zoom.zoomIn}
      >
        <ZoomIn size={14} strokeWidth={1.75} className="text-neutral-500" />
      </button>
      <button type="button" className={cn(TEXT_GHOST, "ml-1")} onMouseDown={keepFocus} onClick={zoom.fit}>
        Fit
      </button>
      <MenuDivider variant="bar" className="mx-2" aria-hidden="true" />
      <LayoutToggle />
    </div>
  );
}
