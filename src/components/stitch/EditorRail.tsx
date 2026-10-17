"use client";

import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { Crosshair, RotateCcw, Scissors, Trash } from "lucide-react";
import { cn } from "@/components/nodes/ui/cn";
import { Segmented, Slider, Switch } from "@/components/ui/Controls";
import { DialogPaneRule, DialogSectionHeader } from "@/components/ui/Dialog";
import { MenuShortcut } from "@/components/ui/Menu";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { draftSpans } from "@/lib/stitch/draft";
import { clipName } from "@/lib/stitch/labels";
import { clipLength, isTrimmed } from "@/lib/stitch/timeline";
import { formatSeconds } from "@/lib/stitch/timecode";
import {
  canRevealSource,
  canSplitSelectedAtPlayhead,
  nudgeStartWell,
  removeSelection,
  resetSelectedTrim,
  revealSelectedSource,
  setClipMuted,
  setClipStart,
  setClipVolume,
  setLoopCount,
  splitAtPlayhead,
  splitBlockedReason,
  trimSelected,
} from "./editorActions";
import { AudioTrackRail } from "./AudioTrackRail";
import { KeyHints, RailRow } from "./railParts";
import { RAIL_BUTTON } from "./editorStyles";
import { TimecodeField } from "./TimecodeField";
import type { ClipMediaView, MusicView } from "./useStitchEditorMedia";

const LOOP_OPTIONS = [
  { value: "1", label: "1×" },
  { value: "2", label: "2×" },
  { value: "3", label: "3×" },
] as const;

const TRIM_HINTS = [
  { key: "I", text: "In at the playhead" },
  { key: "O", text: "Out at the playhead" },
  { key: "⇧", text: "Hold to trim without snapping" },
] as const;

/** Stacked places clips in time and in rows too. */
const STACKED_HINTS = [
  { key: "I", text: "In at the playhead" },
  { key: "O", text: "Out at the playhead" },
  { key: "[", text: "Start at the playhead" },
  { key: "]", text: "End at the playhead" },
  { key: "⌥", text: "With ← → nudge a frame, with ↑ ↓ change row" },
  { key: "⇧", text: "Hold to move or trim without snapping" },
] as const;

function RailButton({
  icon,
  label,
  shortcut,
  danger,
  disabled,
  title,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(RAIL_BUTTON, danger && "text-red-400")}
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      {icon}
      <span className="flex-1">{label}</span>
      {shortcut && <MenuShortcut>{shortcut}</MenuShortcut>}
    </button>
  );
}

/**
 * The 280px rail beside the stage: the selected clip's name and source,
 * in Stacked where it starts on the timeline, its trim as In and Out
 * wells, its own sound, the clip actions with the trim keys, and the loop
 * count in the footer. With the audio track selected it shows the track
 * instead (AudioTrackRail).
 */
export function EditorRail({
  media,
  music,
  total,
}: {
  media: ReadonlyMap<string, ClipMediaView>;
  music: MusicView | null;
  /** One loop of the sequence, seconds. */
  total: number;
}) {
  const draft = useStitchEditorStore((s) => s.draft);
  const durations = useStitchEditorStore((s) => s.durations);
  const empty = !draft || draft.timeline.length === 0;
  const selection = useStitchEditorStore((s) => s.selection);
  const canSplit = useStitchEditorStore(canSplitSelectedAtPlayhead);
  const splitBlocked = useStitchEditorStore(splitBlockedReason);
  const stacked = useStitchEditorStore((s) => s.draft?.sequenceLayout.mode === "stacked");
  const endGesture = useStitchEditorStore((s) => s.endGesture);
  const railRef = useRef<HTMLElement>(null);

  const clipId = selection?.kind === "clip" ? selection.clipId : null;
  const index = draft && clipId ? draft.timeline.findIndex((c) => c.id === clipId) : -1;
  const clip = index >= 0 ? draft!.timeline[index] : null;
  const view = clip ? media.get(clip.id) : undefined;
  const duration = view?.duration ?? null;
  const hasClip = clip !== null;
  // A timeline time, beside the source times In and Out: where the trimmed clip starts (an empty clip's slot too)
  const start = useMemo(() => {
    if (!stacked || !draft || !clipId) return null;
    return draftSpans(draft, durations).find((span) => span.clip.id === clipId)?.start ?? null;
  }, [stacked, draft, durations, clipId]);
  // The lane's rule (Timeline): the track shows only with music under a sequence with some length
  const audio = selection?.kind === "audio" && music !== null && total > 0;

  // A swap of the rail's body (the last clip removed, the track for a clip or back, Overlap and Crossfade coming or going
  // with the layout) unmounts a focused control: focus the dialog, not <body>, so Tab stays inside
  useEffect(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) {
      railRef.current?.closest<HTMLElement>('[role="dialog"]')?.focus({ preventScroll: true });
    }
  }, [hasClip, audio, stacked]);

  return (
    <aside
      ref={railRef}
      aria-label={audio ? "Audio track" : "Clip"}
      className="w-[280px] shrink-0 flex flex-col border-l border-chrome-border/50 bg-editor-chrome"
    >
      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
        {audio ? (
          <AudioTrackRail music={music} total={total} />
        ) : !clip ? (
          // An empty editor has nothing to select; the stage says why
          draft && draft.timeline.length > 0 && (
            <p className="px-5 pt-4 text-xs text-neutral-500">Select a clip to trim it.</p>
          )
        ) : (
          <>
            <div className="flex items-start justify-between gap-2 px-5 pt-4">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[13px] leading-4 font-semibold text-neutral-100">{clipName(index)}</span>
                <span className="truncate text-[11px] leading-[13px] text-neutral-500">{view?.railSubtitle ?? ""}</span>
              </div>
              <span className="pt-0.5 font-mono text-[11px] text-neutral-500">{`${index + 1} / ${draft!.timeline.length}`}</span>
            </div>

            <DialogPaneRule className="mx-5 mt-3.5 mb-2.5" />

            {start !== null && (
              // Leaving the well ends a run of ↑/↓ steps: the next one is a new undo step
              <div className="mb-2 px-5" onBlur={endGesture}>
                <RailRow label="Start">
                  <TimecodeField
                    label="Start on the timeline"
                    value={start}
                    onCommit={(sec) => setClipStart(clip.id, sec)}
                    onNudge={nudgeStartWell}
                  />
                </RailRow>
              </div>
            )}

            <section className="flex flex-col gap-0.5 px-5">
              <DialogSectionHeader className="mb-1 leading-[13px]">Trim</DialogSectionHeader>
              <RailRow label="In">
                <TimecodeField
                  label="In"
                  value={clip.inSec}
                  disabled={duration === null}
                  onCommit={(inSec) => trimSelected({ inSec })}
                />
              </RailRow>
              <RailRow label="Out">
                <TimecodeField
                  label="Out"
                  value={duration !== null ? Math.min(clip.outSec ?? duration, duration) : (clip.outSec ?? 0)}
                  disabled={duration === null}
                  onCommit={(outSec) => trimSelected({ outSec })}
                />
              </RailRow>
              <RailRow label="Length">
                <span className="w-[88px] pr-2 text-right font-mono text-xs tabular-nums text-neutral-400">
                  {duration === null ? "–" : formatSeconds(clipLength(clip, duration))}
                </span>
              </RailRow>
              {duration !== null && clip.inSec >= duration && (
                <p className="text-[11px] text-neutral-500">The trim starts past the end of this video.</p>
              )}
              {duration !== null && duration > 0 && clip.inSec < duration && clipLength(clip, duration) === 0 && (
                <p className="text-[11px] text-neutral-500">The trim is shorter than a frame, so this clip is left out.</p>
              )}
            </section>

            <DialogPaneRule className="mx-5 mt-3 mb-2.5" />

            <section className="flex flex-col gap-0.5 px-5">
              <DialogSectionHeader className="mb-1 leading-[13px]">Audio</DialogSectionHeader>
              <RailRow label="Clip audio">
                <Switch label="Clip audio" checked={!clip.muted} onChange={(on) => setClipMuted(clip.id, !on)} />
              </RailRow>
              <div className="h-7 flex items-center gap-3">
                <span className="w-[52px] shrink-0 text-xs text-neutral-400">Volume</span>
                <div
                  className="min-w-0 flex-1"
                  onPointerUp={endGesture}
                  onKeyUp={endGesture}
                  onBlur={endGesture}
                >
                  <Slider
                    label="Clip volume"
                    min={0}
                    max={100}
                    value={Math.round(clip.volume * 100)}
                    readout={`${Math.round(clip.volume * 100)}%`}
                    disabled={clip.muted}
                    onChange={(pct) => setClipVolume(clip.id, pct / 100)}
                  />
                </div>
              </div>
            </section>

            <DialogPaneRule className="mx-5 mt-3 mb-2.5" />

            <div className="flex flex-col gap-1.5 px-5">
              <RailButton
                icon={<Scissors size={14} strokeWidth={1.75} />}
                label="Split at playhead"
                shortcut="S"
                disabled={!canSplit}
                title={canSplit ? undefined : (splitBlocked ?? undefined)}
                onClick={splitAtPlayhead}
              />
              <RailButton
                icon={<RotateCcw size={14} strokeWidth={1.75} />}
                label="Reset trim"
                disabled={!isTrimmed(clip)}
                onClick={resetSelectedTrim}
              />
              <RailButton
                icon={<Crosshair size={14} strokeWidth={1.75} />}
                label="Reveal source node"
                disabled={!canRevealSource(clip, view)}
                onClick={revealSelectedSource}
              />
              <RailButton
                icon={<Trash size={14} strokeWidth={1.75} />}
                label="Remove from stitch"
                shortcut="⌫"
                danger
                onClick={removeSelection}
              />
              <KeyHints hints={stacked ? STACKED_HINTS : TRIM_HINTS} />
            </div>
          </>
        )}
      </div>

      {/* Inert with nothing to loop, like the transport beside it */}
      <div
        className={cn(
          "h-11 shrink-0 flex items-center justify-between px-5 border-t border-chrome-border/50",
          empty && "opacity-50 pointer-events-none",
        )}
        inert={empty}
      >
        <span className="text-xs text-neutral-400">Loop sequence</span>
        <Segmented
          size="sm"
          label="Loop"
          options={[...LOOP_OPTIONS]}
          value={String(draft?.loopCount ?? 1)}
          onChange={(value) => setLoopCount(Number(value) as 1 | 2 | 3)}
          className="bg-editor-well"
        />
      </div>
    </aside>
  );
}
