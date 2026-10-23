"use client";

import { memo, useEffect, useRef, type CSSProperties } from "react";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { speedToSlider, sliderToSpeed } from "@/lib/stitch/speedScale";
import { formatSeconds } from "@/lib/stitch/timecode";
import { clipLength, clipSourceOut, clipSpeedLimits } from "@/lib/stitch/timeline";
import {
  bakeError,
  canBlend,
  dropsSound,
  formatSpeed,
  MAX_SPEED,
  MIN_SPEED,
  parseSpeed,
  SPEED_PRESETS,
} from "@/lib/stitch/warp";
import type { StitchTimelineClip } from "@/types";
import { EasePicker } from "./EasePicker";
import { RailLabel, RailNote, RailRow, RailSegments, RailSwitch } from "./railParts";
import {
  canSetSpeed,
  curveGestureKey,
  moveClipSpeed,
  nudgeClipSpeed,
  setClipBlend,
  setClipCurve,
  setClipReverse,
  setClipSpeed,
  setSelectedClipsReverse,
  setSelectedClipsSpeed,
  speedGestureKey,
  speedWaitsReason,
} from "./speedActions";
import { TimecodeField } from "./TimecodeField";

/** The Speed well: wide enough for formatSpeed's widest, a split piece's "< 0.001×", beside the well's own padding. */
const SPEED_WELL = "w-[76px] shrink-0";

/**
 * One clip's Speed, Ramp, Reverse and Blend frames in the rail, under its Volume. Speed is a log slider (0.1–10×), a
 * well that takes a typed speed and ↑/↓, and the presets; the clip's length on the timeline and why it can go no
 * slower or faster are notes under them, and so is a sound the render leaves out. `duration` is the source's (null
 * while unknown: then only Reverse acts), `fps` its rate (the bake budget of a switch to Points).
 */
export const ClipSpeed = memo(function ClipSpeed({
  clip,
  duration,
  fps,
}: {
  clip: StitchTimelineClip;
  duration: number | null;
  fps: number | null;
}) {
  const endGesture = useStitchEditorStore((s) => s.endGesture);
  const waiting = useStitchEditorStore(speedWaitsReason);
  // As In and Out: nothing to retime until the length is known. Reverse keeps the length and reads none, so it acts,
  // as the menu's and several clips' do
  const off = duration === null;
  const speedOff = off || waiting !== null;
  const warp = clip.warp;
  const speed = warp?.speed ?? 1;
  const range = clipSpeedLimits(clip, duration ?? undefined);
  const sourceLength = duration === null ? 0 : clipSourceOut(clip, duration) - clip.inSec;
  const length = duration === null ? null : clipLength(clip, duration);
  const pos = Math.round(speedToSlider(speed));
  // A drag keeps the Blend it started with across 1×, where the warp itself goes
  const carried = useRef<boolean | null>(null);
  const blend = () => (carried.current ??= warp?.blend ?? false);
  const release = () => {
    carried.current = null;
    endGesture();
  };
  // Selecting another clip remounts this section (it is keyed by clip), and a control removed mid-run is never blurred:
  // end this clip's run of ↑/↓ or arrow keys here, or the next run on it would join that undo step
  useEffect(
    () => () => {
      const s = useStitchEditorStore.getState();
      if (s.gestureKey === speedGestureKey([clip.id]) || s.gestureKey === curveGestureKey(clip.id)) s.endGesture();
    },
    [clip.id],
  );

  return (
    <>
      <div className="mt-5">
        <div className="flex h-8 items-center gap-3">
          <span className="w-[52px] shrink-0 text-[13px] text-neutral-300">Speed</span>
          {/* A drag, or a held arrow key, is one undo step */}
          <div
            className="flex min-w-0 flex-1"
            title={waiting ?? undefined}
            onPointerUp={release}
            onKeyUp={release}
            onBlur={release}
          >
            <input
              type="range"
              aria-label="Clip speed"
              aria-valuetext={formatSpeed(speed)}
              min={0}
              max={100}
              step={1}
              value={pos}
              disabled={speedOff}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (next === pos) return;
                moveClipSpeed(clip.id, sliderToSpeed(next), next > pos ? 1 : -1, {
                  gestureKey: speedGestureKey([clip.id]),
                  blend: blend(),
                });
              }}
              className="range-edit min-w-0 flex-1"
              style={{ "--p": `${pos}%` } as CSSProperties}
            />
          </div>
          {/* Leaving the well ends a run of ↑/↓ steps; outside the slider's key-up wrapper, which would end every step */}
          <div className={SPEED_WELL} title={waiting ?? undefined} onBlur={endGesture}>
            <TimecodeField
              label="Speed"
              value={speed}
              format={formatSpeed}
              parse={parseSpeed}
              disabled={speedOff}
              onCommit={(value) => setClipSpeed(clip.id, value)}
              onNudge={(dir, big) => nudgeClipSpeed(clip.id, dir, big)}
            />
          </div>
        </div>
        <RailSegments
          label="Speed presets"
          className="mt-2"
          segments={SPEED_PRESETS.map((value) => ({
            label: formatSpeed(value),
            pressed: speed === value,
            disabled: speedOff || value < range.min || value > range.max,
            title:
              waiting ??
              (value > range.max
                ? "It would last under 0.1 s"
                : value < range.min
                  ? "It would play for more than 10 minutes"
                  : undefined),
            onClick: () => setClipSpeed(clip.id, value),
          }))}
        />
        {/* Under a frame the rail's other note says the clip is left out */}
        {length !== null && length > 0 && speed !== 1 && (
          <RailNote>{`Lasts ${formatSeconds(length)} on the timeline.`}</RailNote>
        )}
        {dropsSound(warp) && <RailNote>No sound above 4× or below 0.25×.</RailNote>}
        {range.min > MIN_SPEED && speed <= range.min && (
          <RailNote>Can&apos;t be slower: it would play for more than 10 minutes.</RailNote>
        )}
        {range.max < MAX_SPEED && speed >= range.max && <RailNote>Can&apos;t be faster: it would last under 0.1 s.</RailNote>}
      </div>

      <div className="mt-5">
        <RailLabel>Ramp</RailLabel>
        <EasePicker
          curve={warp?.curve ?? null}
          window={warp?.window}
          disabled={off}
          gestureKey={curveGestureKey(clip.id)}
          maxError={bakeError(sourceLength, fps)}
          onChange={(curve, opts) =>
            setClipCurve(clip.id, curve, opts?.gestureKey ? { ...opts, blend: blend() } : undefined)
          }
          onGestureEnd={release}
        />
      </div>

      <div className="mt-5">
        <RailRow label="Reverse">
          <RailSwitch label="Reverse" checked={warp?.reverse ?? false} onChange={(on) => setClipReverse(clip.id, on)} />
        </RailRow>
        <RailRow label="Blend frames">
          <RailSwitch
            label="Blend frames"
            checked={warp?.blend ?? false}
            disabled={off || !canBlend(warp)}
            title={!off && !canBlend(warp) ? "Only in slow motion" : undefined}
            onChange={(on) => setClipBlend(clip.id, on)}
          />
        </RailRow>
      </div>
    </>
  );
});

/**
 * Several clips' Speed (the well and the presets, "Mixed" while they differ) and Reverse (On or Off, "Mixed"); each
 * clip keeps to its own limits. Speed is off while any selected clip's length is unknown, whose limits it needs;
 * Reverse reads none. Ramp and Blend frames are one clip's.
 */
export function ClipsSpeed({ clips }: { clips: readonly StitchTimelineClip[] }) {
  const ids = clips.map((c) => c.id);
  const on = useStitchEditorStore((s) => canSetSpeed(s, ids));
  const waiting = useStitchEditorStore(speedWaitsReason);
  const speeds = clips.map((c) => c.warp?.speed ?? 1);
  const same = speeds.every((v) => v === speeds[0]);
  const reverse = clips.every((c) => c.warp?.reverse)
    ? "on"
    : clips.every((c) => !c.warp?.reverse)
      ? "off"
      : "mixed";
  return (
    <div className="mt-5">
      <RailRow label="Speed">
        <div className="flex items-center gap-2">
          {!same && <span className="text-xs text-ink-3">Mixed</span>}
          <div className={SPEED_WELL} title={waiting ?? undefined}>
            <TimecodeField
              label="Speed"
              value={speeds[0]}
              format={same ? formatSpeed : () => "–"}
              parse={parseSpeed}
              disabled={!on}
              onCommit={(value) => setSelectedClipsSpeed(value)}
            />
          </div>
        </div>
      </RailRow>
      <RailSegments
        label="Speed presets"
        className="mt-2"
        segments={SPEED_PRESETS.map((value) => ({
          label: formatSpeed(value),
          pressed: speeds.every((s) => s === value),
          disabled: !on,
          title: waiting ?? undefined,
          onClick: () => setSelectedClipsSpeed(value),
        }))}
      />
      <div className="mt-2">
        <RailRow label="Reverse">
          <div className="flex items-center gap-2">
            {reverse === "mixed" && <span className="text-xs text-ink-3">Mixed</span>}
            <RailSegments
              label="Reverse"
              className="w-[104px]"
              segments={[
                { label: "On", pressed: reverse === "on", onClick: () => setSelectedClipsReverse(true) },
                { label: "Off", pressed: reverse === "off", onClick: () => setSelectedClipsReverse(false) },
              ]}
            />
          </div>
        </RailRow>
      </div>
    </div>
  );
}
