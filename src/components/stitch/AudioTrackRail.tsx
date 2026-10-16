"use client";

import { RotateCcw, TriangleRight } from "lucide-react";
import { Switch } from "@/components/ui/Controls";
import { DialogButton, DialogPaneRule, DialogSectionHeader } from "@/components/ui/Dialog";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { formatTimecode } from "@/lib/stitch/timecode";
import { applyFadeIn, applyFadeOut, flattenCurve, toggleMusicMute } from "./editorActions";
import { KeyHints, RailRow } from "./railParts";
import type { MusicView } from "./useStitchEditorMedia";

const CURVE_HINTS = [
  { key: "⌥", text: "Drag the whole line" },
  { key: "M", text: "Mute the track" },
] as const;

/** The Volume board's quick buttons: outline, compact, in the regular weight; 8px sides so the three share one row of the rail. */
const QUICK_BUTTON = "px-2 font-normal gap-1.5 focus-visible:ring-offset-editor-chrome";

/**
 * The rail while the audio track is selected: the music's name and length,
 * the track's sound, and the curve's quick buttons (a fade in, a fade out,
 * back to flat) with the curve's keys. The board draws the buttons under
 * the lane; the editor's timeline has no room for a row there, so they
 * live here.
 */
export function AudioTrackRail({ music, total }: { music: MusicView; total: number }) {
  const muted = useStitchEditorStore((s) => s.draft?.audioMuted ?? false);
  const flat = useStitchEditorStore((s) => (s.draft?.audioCurve.length ?? 0) === 0);
  // A muted track draws no curve (the rail shows only under a sequence with some length: EditorRail)
  const noCurve = muted;

  return (
    <>
      <div className="flex min-w-0 flex-col gap-0.5 px-5 pt-4">
        <span className="truncate text-[13px] leading-4 font-semibold text-neutral-100">{music.fileName}</span>
        <span className="truncate text-[11px] leading-[13px] text-neutral-500">
          {music.sourceLabel} · <span className="font-mono tabular-nums">{formatTimecode(total)}</span>
        </span>
      </div>

      <DialogPaneRule className="mx-5 mt-3.5 mb-2.5" />

      <section className="flex flex-col gap-0.5 px-5">
        <DialogSectionHeader className="mb-1 leading-[13px]">Audio</DialogSectionHeader>
        <RailRow label="Track sound">
          <Switch label="Track sound" checked={!muted} onChange={toggleMusicMute} />
        </RailRow>
      </section>

      <DialogPaneRule className="mx-5 mt-3 mb-2.5" />

      <section className="flex flex-col gap-0.5 px-5">
        <DialogSectionHeader className="mb-1.5 leading-[13px]">Volume curve</DialogSectionHeader>
        <div className="flex flex-wrap gap-1.5">
          <DialogButton variant="outline" compact className={QUICK_BUTTON} disabled={noCurve} onClick={applyFadeIn}>
            <TriangleRight size={12} strokeWidth={2} />
            Fade in
          </DialogButton>
          <DialogButton variant="outline" compact className={QUICK_BUTTON} disabled={noCurve} onClick={applyFadeOut}>
            <TriangleRight size={12} strokeWidth={2} className="-scale-x-100" />
            Fade out
          </DialogButton>
          <DialogButton variant="outline" compact className={QUICK_BUTTON} disabled={noCurve || flat} onClick={flattenCurve}>
            <RotateCcw size={12} strokeWidth={2} />
            Flat
          </DialogButton>
        </div>
        <KeyHints hints={CURVE_HINTS} />
      </section>
    </>
  );
}
