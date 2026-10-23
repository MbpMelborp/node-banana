"use client";

import { useEffect, useMemo, useRef } from "react";
import { Crosshair, RotateCcw, Scissors, TimerReset, Trash } from "lucide-react";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { draftSpans } from "@/lib/stitch/draft";
import { clipName } from "@/lib/stitch/labels";
import type { OverlaySize } from "@/lib/stitch/overlayDraw";
import { draftOverlays } from "@/lib/stitch/overlays";
import { clipIdsOf } from "@/lib/stitch/selection";
import { rampModeOf } from "@/lib/stitch/rampModes";
import { canResetTrim, clipLength, clipSourceOut, sourceKey, type SourceDurations } from "@/lib/stitch/timeline";
import { activeWarp, isRetimed, trimField } from "@/lib/stitch/warp";
import type { StitchTimelineClip } from "@/types";
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
  setSelectedClipsMuted,
  splitAtPlayhead,
  splitBlockedReason,
  trimSelected,
} from "./editorActions";
import { AudioClipRail } from "./AudioClipRail";
import { ClipSpeed, ClipsSpeed } from "./ClipSpeedRail";
import { TextOverlayRail } from "./TextOverlayRail";
import {
  RailAction,
  RailActions,
  RailField,
  RailFields,
  RailNote,
  RailRow,
  RailSegments,
  RailSlider,
  RailSwitch,
  RailTitle,
  railDetail,
  START_KEYS,
} from "./railParts";
import { resetSelectedSpeed } from "./speedActions";
import { TimecodeField } from "./TimecodeField";
import type { AudioClipView, ClipMediaView } from "./useStitchEditorMedia";
import { EDITOR_PANEL_SELECTOR } from "./editorStyles";

/** "Clip 1 and Clip 3", "Clip 1, Clip 3 and Clip 4", past three "Clip 1, Clip 2 and 3 more". */
function clipNamesLine(indices: readonly number[]): string {
  const names = indices.map(clipName);
  if (names.length > 3) return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
  if (names.length < 2) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The 280px rail beside the stage, on the pane with a hairline at its left
 * edge. It keeps its column whatever is selected, so the video never changes
 * size on a click. One clip: "Clip 2 of 4", its source and length; its In and
 * Out side by side (in Stacked Start first: where it starts on the timeline);
 * its own Sound and Volume; its Speed, Ramp, Reverse and Blend frames
 * (ClipSpeed); then, at the foot, Split at playhead, Reset trim (only while
 * there is a trim to reset), Reset speed (only while retimed), Reveal source
 * node (the dialog's) and Remove clip.
 * With audio clips selected it shows them instead (AudioClipRail), with text
 * layers those (TextOverlayRail), and with several video clips what applies
 * to all of them (MultiClipRail). The keys are in the fields' and the
 * actions' hover labels. Frame to canvas is in the control row under the
 * video; Loop is in the header's ⋯ menu.
 */
export function EditorRail({
  media,
  audio,
  frameSize,
}: {
  media: ReadonlyMap<string, ClipMediaView>;
  /** Each audio clip's view. */
  audio: ReadonlyMap<string, AudioClipView>;
  /** The output's size, which a text layer's fit is measured in; null while no clip has one. */
  frameSize: OverlaySize | null;
}) {
  const draft = useStitchEditorStore((s) => s.draft);
  const durations = useStitchEditorStore((s) => s.durations);
  const selection = useStitchEditorStore((s) => s.selection);
  const selectedIndices = useMemo(() => {
    if (selection?.kind !== "clip" || !draft) return [];
    const ids = new Set(clipIdsOf(selection, draft.timeline.map((c) => c.id)));
    return draft.timeline.flatMap((c, i) => (ids.has(c.id) ? [i] : []));
  }, [selection, draft]);
  const multi = selectedIndices.length > 1;
  const canSplit = useStitchEditorStore(canSplitSelectedAtPlayhead);
  const splitBlocked = useStitchEditorStore(splitBlockedReason);
  const stacked = useStitchEditorStore((s) => s.draft?.sequenceLayout.mode === "stacked");
  const endGesture = useStitchEditorStore((s) => s.endGesture);
  // An edit project's clips come from the library: there is no source node to reveal
  const inEdit = useStitchEditorStore((s) => s.editId !== null);
  const railRef = useRef<HTMLElement>(null);

  const clipId = selection?.kind === "clip" ? selection.clipId : null;
  const index = draft && clipId ? draft.timeline.findIndex((c) => c.id === clipId) : -1;
  const clip = index >= 0 ? draft!.timeline[index] : null;
  const view = clip ? media.get(clip.id) : undefined;
  const duration = view?.duration ?? null;
  const hasClip = clip !== null;
  // The picker's body (the preset grid, the bezier editor, the drawn curve) swaps with the ramp's kind, an undo too
  const rampMode = clip ? rampModeOf(clip.warp?.curve ?? null, clip.warp?.window) : null;
  // I sets the clip's head on the timeline and O its tail: a reversed clip's head is its Out
  const [inKey, outKey] = clip && trimField(clip, "in") === "outSec" ? ["O", "I"] : ["I", "O"];
  // A timeline time, beside the source times In and Out: where the trimmed clip starts (an empty clip's slot too)
  const start = useMemo(() => {
    if (!stacked || !draft || !clipId) return null;
    return draftSpans(draft, durations).find((span) => span.clip.id === clipId)?.start ?? null;
  }, [stacked, draft, durations, clipId]);
  const selectedAudio = useMemo(() => {
    if (selection?.kind !== "audio" || !draft) return [];
    const ids = new Set(clipIdsOf(selection, draft.audioClips.map((c) => c.id)));
    // The lead first: the single-clip rail is the lead's
    return draft.audioClips.filter((c) => ids.has(c.id));
  }, [selection, draft]);
  const audioSelected = selectedAudio.length > 0;
  const selectedOverlays = useMemo(() => {
    if (selection?.kind !== "overlay" || !draft) return [];
    const overlays = draftOverlays(draft);
    const ids = new Set(clipIdsOf(selection, overlays.map((o) => o.id)));
    return overlays.filter((o) => ids.has(o.id));
  }, [selection, draft]);
  const overlaySelected = selectedOverlays.length > 0;
  const overlayMulti = selectedOverlays.length > 1;

  // A swap of the rail's body (the last clip removed, the track for a clip or back, one text layer for several, Start or
  // Crossfade coming or going with the layout, the ramp picker's body with its kind, the Speed section, keyed by clip,
  // with another clip) unmounts a focused control: focus the dialog, not <body>, so Tab stays inside
  useEffect(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) {
      railRef.current?.closest<HTMLElement>(EDITOR_PANEL_SELECTOR)?.focus({ preventScroll: true });
    }
  }, [hasClip, clipId, audioSelected, overlaySelected, overlayMulti, stacked, multi, rampMode]);

  return (
    <aside
      ref={railRef}
      aria-label={audioSelected ? "Audio clip" : overlaySelected ? "Text" : "Clip"}
      className="w-[280px] shrink-0 overflow-y-auto border-l border-edit-line"
    >
      <div className="flex min-h-full flex-col p-5">
        {audioSelected ? (
          <AudioClipRail clips={selectedAudio} views={audio} />
        ) : overlaySelected ? (
          <TextOverlayRail overlays={selectedOverlays} frameSize={frameSize} />
        ) : multi && draft ? (
          <MultiClipRail
            timeline={draft.timeline}
            indices={selectedIndices}
            durations={durations}
            canSplit={canSplit}
            splitBlocked={splitBlocked}
          />
        ) : !clip ? (
          // An empty editor has nothing to select; the stage says why
          draft &&
          (draft.timeline.length > 0 || draftOverlays(draft).length > 0) && (
            <p className="text-[13px] leading-5 text-ink-3">
              {draft.timeline.length > 0 ? "Select a clip to edit it." : "Select a text layer to edit it."}
            </p>
          )
        ) : (
          <>
            <RailTitle
              title={`${clipName(index)} of ${draft!.timeline.length}`}
              lines={[
                railDetail(
                  view?.railSource,
                  duration,
                  // The source range, as In and Out read: a retimed clip's length on the timeline is the Speed note's
                  duration === null
                    ? null
                    : activeWarp(clip)
                      ? clipSourceOut(clip, duration) - clip.inSec
                      : clipLength(clip, duration),
                  inEdit,
                ),
              ]}
            />

            <RailFields>
              {start !== null && (
                // Leaving the well ends a run of ↑/↓ steps: the next one is a new undo step
                <RailField label="Start" hint="Start or end at the playhead" shortcut={START_KEYS} onBlur={endGesture}>
                  <TimecodeField
                    label="Start on the timeline"
                    value={start}
                    onCommit={(sec) => setClipStart(clip.id, sec)}
                    onNudge={nudgeStartWell}
                  />
                </RailField>
              )}
              <RailField label="In" hint="In at the playhead" shortcut={inKey}>
                <TimecodeField
                  label="In"
                  value={clip.inSec}
                  disabled={duration === null}
                  onCommit={(inSec) => trimSelected({ inSec })}
                />
              </RailField>
              <RailField label="Out" hint="Out at the playhead" shortcut={outKey} last>
                <TimecodeField
                  label="Out"
                  value={duration !== null ? Math.min(clip.outSec ?? duration, duration) : (clip.outSec ?? 0)}
                  disabled={duration === null}
                  onCommit={(outSec) => trimSelected({ outSec })}
                />
              </RailField>
            </RailFields>
            {duration !== null && clip.inSec >= duration && <RailNote>The trim starts past the end of this video.</RailNote>}
            {duration !== null && duration > 0 && clip.inSec < duration && clipLength(clip, duration) === 0 && (
              <RailNote>The trim is shorter than a frame, so this clip is left out.</RailNote>
            )}

            <div className="mt-7">
              <RailRow label="Sound">
                <RailSwitch label="Sound" checked={!clip.muted} onChange={(on) => setClipMuted(clip.id, !on)} />
              </RailRow>
              <div onPointerUp={endGesture} onKeyUp={endGesture} onBlur={endGesture}>
                <RailSlider
                  label="Volume"
                  ariaLabel="Clip volume"
                  value={Math.round(clip.volume * 100)}
                  disabled={clip.muted}
                  onChange={(pct) => setClipVolume(clip.id, pct / 100)}
                />
              </div>
            </div>

            <ClipSpeed key={clip.id} clip={clip} duration={duration} fps={view?.fps ?? null} />

            <RailActions>
              <RailAction
                icon={<Scissors size={16} strokeWidth={1.5} />}
                label="Split at playhead"
                shortcut="S"
                disabled={!canSplit}
                title={canSplit ? undefined : (splitBlocked ?? undefined)}
                onClick={splitAtPlayhead}
              />
              {canResetTrim(clip, durations.get(sourceKey(clip.source))) && (
                <RailAction
                  icon={<RotateCcw size={16} strokeWidth={1.5} />}
                  label="Reset trim"
                  vanishes
                  onClick={resetSelectedTrim}
                />
              )}
              {isRetimed(clip.warp) && (
                <RailAction
                  icon={<TimerReset size={16} strokeWidth={1.5} />}
                  label="Reset speed"
                  vanishes
                  onClick={resetSelectedSpeed}
                />
              )}
              {!inEdit && (
                <RailAction
                  icon={<Crosshair size={16} strokeWidth={1.5} />}
                  label="Reveal source node"
                  disabled={!canRevealSource(clip, view)}
                  onClick={revealSelectedSource}
                />
              )}
              <RailAction
                icon={<Trash size={16} strokeWidth={1.5} />}
                label="Remove clip"
                shortcut="⌫"
                keyshortcuts="Backspace"
                onClick={removeSelection}
              />
            </RailActions>
          </>
        )}
      </div>
    </aside>
  );
}

/**
 * The rail with several clips selected: how many and which, their sound as one control (neither On nor Off pressed
 * while some are muted and some not), their Speed and Reverse (ClipsSpeed), and the actions that apply to all of
 * them. Trims, Start, Volume, Ramp and Blend frames are one clip's, so they are not here.
 */
function MultiClipRail({
  timeline,
  indices,
  durations,
  canSplit,
  splitBlocked,
}: {
  timeline: readonly StitchTimelineClip[];
  /** The selected clips' timeline indices, in order. */
  indices: readonly number[];
  durations: SourceDurations;
  canSplit: boolean;
  splitBlocked: string | null;
}) {
  const clips = indices.map((i) => timeline[i]);
  const allOff = clips.every((c) => c.muted);
  const allOn = clips.every((c) => !c.muted);
  const sound = allOn ? "on" : allOff ? "off" : "mixed";
  return (
    <>
      <RailTitle title={`${clips.length} clips`} lines={[clipNamesLine(indices)]} />

      <div className="mt-7">
        <RailRow label="Sound">
          <div className="flex items-center gap-2">
            {sound === "mixed" && <span className="text-xs text-ink-3">Mixed</span>}
            <RailSegments
              label="Sound"
              className="w-[104px]"
              segments={[
                { label: "On", pressed: sound === "on", onClick: () => setSelectedClipsMuted(false) },
                { label: "Off", pressed: sound === "off", onClick: () => setSelectedClipsMuted(true) },
              ]}
            />
          </div>
        </RailRow>
      </div>

      <ClipsSpeed clips={clips} />

      <RailActions>
        <RailAction
          icon={<Scissors size={16} strokeWidth={1.5} />}
          label="Split at playhead"
          shortcut="S"
          disabled={!canSplit}
          title={canSplit ? undefined : (splitBlocked ?? undefined)}
          onClick={splitAtPlayhead}
        />
        {clips.some((c) => canResetTrim(c, durations.get(sourceKey(c.source)))) && (
          <RailAction
            icon={<RotateCcw size={16} strokeWidth={1.5} />}
            label="Reset trim"
            vanishes
            onClick={resetSelectedTrim}
          />
        )}
        {clips.some((c) => isRetimed(c.warp)) && (
          <RailAction
            icon={<TimerReset size={16} strokeWidth={1.5} />}
            label="Reset speed"
            vanishes
            onClick={resetSelectedSpeed}
          />
        )}
        <RailAction
          icon={<Trash size={16} strokeWidth={1.5} />}
          label={`Remove ${clips.length} clips`}
          shortcut="⌫"
          keyshortcuts="Backspace"
          onClick={removeSelection}
        />
      </RailActions>
    </>
  );
}
