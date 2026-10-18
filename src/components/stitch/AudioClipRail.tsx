"use client";

import { RotateCcw, Scissors, Trash, TriangleRight, Volume1, VolumeX } from "lucide-react";
import { Switch } from "@/components/ui/Controls";
import { DialogButton, DialogPaneRule, DialogSectionHeader } from "@/components/ui/Dialog";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { audioClipLength } from "@/lib/stitch/audioClips";
import { formatSeconds } from "@/lib/stitch/timecode";
import type { StitchAudioClip } from "@/types";
import {
  applyAudioFadeIn,
  applyAudioFadeOut,
  canFadeOutAudio,
  canSplitAudioAtPlayhead,
  flattenAudioCurve,
  nudgeAudioStartWell,
  removeAudioClipsById,
  resetSelectedAudioTrim,
  setAudioClipStart,
  setSelectedAudioMuted,
  splitSelectedAudioAtPlayhead,
  trimSelectedAudio,
} from "./editorActions";
import { KeyHints, RailButton, RailRow } from "./railParts";
import { TimecodeField } from "./TimecodeField";
import { audioRowName } from "./timeline/AudioLane";
import type { AudioClipView } from "./useStitchEditorMedia";

const HINTS = [
  { key: "[", text: "Start at the playhead" },
  { key: "]", text: "End at the playhead" },
  { key: "⌥", text: "With ← → nudge a frame, with ↑ ↓ change row; drag the line to move it" },
  { key: "⇧", text: "Hold to move or trim without snapping" },
] as const;

const MULTI_HINTS = [
  { key: "⌘", text: "With C copy, X cut, V paste, D duplicate" },
  { key: "⌥", text: "With ← → nudge a frame, with ↑ ↓ change row" },
  { key: "⇧", text: "Click a clip to select a range" },
] as const;

/** The Volume board's quick buttons: outline, compact, in the regular weight; 8px sides so the three share one row of the rail. */
const QUICK_BUTTON = "px-2 font-normal gap-1.5 focus-visible:ring-offset-editor-chrome";

/** The rail's ⌫ for audio clips: they go, and none of them stays tagged "cut". */
function removeClips(ids: readonly string[]): void {
  useStitchEditorStore.getState().untagCut(removeAudioClipsById(ids));
}

/**
 * The rail while audio clips are selected. One clip: its name and source,
 * its row, where it starts on the timeline, its trim as In and Out wells
 * (off until the file's length is read), its sound, the curve's quick
 * buttons (a fade in, a fade out over the part that is heard, back to flat),
 * then the clip actions with their keys. Several: how many, and what applies
 * to all of them.
 */
export function AudioClipRail({
  clips,
  views,
}: {
  /** The selected audio clips, in audio order (the lead first when it is one). */
  clips: readonly StitchAudioClip[];
  views: ReadonlyMap<string, AudioClipView>;
}) {
  const canSplit = useStitchEditorStore(canSplitAudioAtPlayhead);
  const canFadeOut = useStitchEditorStore(canFadeOutAudio);
  const endGesture = useStitchEditorStore((s) => s.endGesture);

  if (clips.length > 1) {
    const allMuted = clips.every((c) => c.muted);
    return (
      <>
        <div className="flex min-w-0 flex-col gap-0.5 px-5 pt-4">
          <span className="text-[13px] leading-4 font-semibold text-neutral-100">{`${clips.length} audio clips`}</span>
          <span className="truncate text-[11px] leading-[13px] text-neutral-500">
            {clips.map((c) => views.get(c.id)?.fileName ?? "Audio").join(", ")}
          </span>
        </div>

        <DialogPaneRule className="mx-5 mt-3.5 mb-2.5" />

        <div className="flex flex-col gap-1.5 px-5">
          <RailButton
            icon={allMuted ? <Volume1 size={14} strokeWidth={1.75} /> : <VolumeX size={14} strokeWidth={1.75} />}
            label={allMuted ? "Unmute all" : "Mute all"}
            shortcut="M"
            onClick={() => setSelectedAudioMuted(!allMuted)}
          />
          <RailButton
            icon={<Scissors size={14} strokeWidth={1.75} />}
            label="Split at playhead"
            shortcut="S"
            disabled={!canSplit}
            onClick={splitSelectedAudioAtPlayhead}
          />
          <RailButton
            icon={<Trash size={14} strokeWidth={1.75} />}
            label={`Remove ${clips.length} clips`}
            shortcut="⌫"
            danger
            onClick={() => removeClips(clips.map((c) => c.id))}
          />
          <KeyHints hints={MULTI_HINTS} />
        </div>
      </>
    );
  }

  const clip = clips[0];
  if (!clip) return null;
  const view = views.get(clip.id);
  const duration = view?.duration ?? null;
  const trimmed = clip.inSec > 0 || clip.outSec !== null;
  const waitsForLength = clip.outSec === null && duration === null;

  return (
    <>
      <div className="flex items-start justify-between gap-2 px-5 pt-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-[13px] leading-4 font-semibold text-neutral-100">{view?.fileName ?? "Audio"}</span>
          <span className="truncate text-[11px] leading-[13px] text-neutral-500">{view?.railSubtitle ?? ""}</span>
        </div>
        <span className="shrink-0 pt-0.5 font-mono text-[11px] text-neutral-500">{audioRowName(clip.row)}</span>
      </div>

      <DialogPaneRule className="mx-5 mt-3.5 mb-2.5" />

      {/* Leaving the well ends a run of ↑/↓ steps: the next one is a new undo step */}
      <div className="mb-2 px-5" onBlur={endGesture}>
        <RailRow label="Start">
          <TimecodeField
            label="Start on the timeline"
            value={clip.startSec}
            onCommit={(sec) => setAudioClipStart(clip.id, sec)}
            onNudge={nudgeAudioStartWell}
          />
        </RailRow>
      </div>

      <section className="flex flex-col gap-0.5 px-5">
        <DialogSectionHeader className="mb-1 leading-[13px]">Trim</DialogSectionHeader>
        <RailRow label="In">
          <TimecodeField
            label="In"
            value={clip.inSec}
            disabled={duration === null}
            onCommit={(inSec) => trimSelectedAudio({ inSec })}
          />
        </RailRow>
        <RailRow label="Out">
          <TimecodeField
            label="Out"
            value={duration !== null ? Math.min(clip.outSec ?? duration, duration) : (clip.outSec ?? 0)}
            disabled={duration === null}
            onCommit={(outSec) => trimSelectedAudio({ outSec })}
          />
        </RailRow>
        <RailRow label="Length">
          <span className="w-[88px] pr-2 text-right font-mono text-xs tabular-nums text-neutral-400">
            {duration === null ? "–" : formatSeconds(audioClipLength(clip, duration))}
          </span>
        </RailRow>
      </section>

      <DialogPaneRule className="mx-5 mt-3 mb-2.5" />

      <section className="flex flex-col gap-0.5 px-5">
        <DialogSectionHeader className="mb-1 leading-[13px]">Audio</DialogSectionHeader>
        <RailRow label="Sound">
          <Switch label="Sound" checked={!clip.muted} onChange={(on) => setSelectedAudioMuted(!on)} />
        </RailRow>
      </section>

      <DialogPaneRule className="mx-5 mt-3 mb-2.5" />

      <section className="flex flex-col gap-0.5 px-5">
        <DialogSectionHeader className="mb-1.5 leading-[13px]">Volume curve</DialogSectionHeader>
        <div className="flex flex-wrap gap-1.5">
          <DialogButton variant="outline" compact className={QUICK_BUTTON} disabled={clip.muted} onClick={applyAudioFadeIn}>
            <TriangleRight size={12} strokeWidth={2} />
            Fade in
          </DialogButton>
          <DialogButton
            variant="outline"
            compact
            className={QUICK_BUTTON}
            disabled={clip.muted || !canFadeOut}
            title={!clip.muted && waitsForLength ? "Reading the audio's length…" : undefined}
            onClick={applyAudioFadeOut}
          >
            <TriangleRight size={12} strokeWidth={2} className="-scale-x-100" />
            Fade out
          </DialogButton>
          <DialogButton
            variant="outline"
            compact
            className={QUICK_BUTTON}
            disabled={clip.muted || clip.curve.length === 0}
            onClick={flattenAudioCurve}
          >
            <RotateCcw size={12} strokeWidth={2} />
            Flat
          </DialogButton>
        </div>
      </section>

      <DialogPaneRule className="mx-5 mt-3 mb-2.5" />

      <div className="flex flex-col gap-1.5 px-5">
        <RailButton
          icon={<Scissors size={14} strokeWidth={1.75} />}
          label="Split at playhead"
          shortcut="S"
          disabled={!canSplit}
          onClick={splitSelectedAudioAtPlayhead}
        />
        <RailButton
          icon={<RotateCcw size={14} strokeWidth={1.75} />}
          label="Reset trim"
          disabled={!trimmed || duration === null}
          onClick={resetSelectedAudioTrim}
        />
        <RailButton
          icon={<Trash size={14} strokeWidth={1.75} />}
          label="Remove clip"
          shortcut="⌫"
          danger
          onClick={() => removeClips([clip.id])}
        />
        <KeyHints hints={HINTS} />
      </div>
    </>
  );
}
