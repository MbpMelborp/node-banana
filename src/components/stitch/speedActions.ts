import { useToast } from "@/components/Toast";
import { selectedClipIds, useStitchEditorStore, type StitchEditorState } from "@/store/stitchEditorStore";
import { removeRemapPoint } from "@/lib/easing";
import { pinWaitsForLoading } from "@/lib/stitch/libraryInsert";
import { nudgeSpeed } from "@/lib/stitch/speedScale";
import { clipSpeedLimits, pinStarts, sourceKey, updateClipsWarp, type WarpPatch } from "@/lib/stitch/timeline";
import { editablePoints } from "@/lib/stitch/warp";
import type { ClipWarpCurve } from "@/types";
import { EDITOR_PANEL_SELECTOR } from "./editorStyles";

/**
 * What the rail's Speed section and the clip menu do to a clip's warp: its speed, ramp, Reverse and Blend frames.
 * Every writer goes through updateClipsWarp, so a warp that changes nothing is removed and an equal value makes no
 * undo step.
 */

const editor = () => useStitchEditorStore.getState();
const clipOf = (id: string) => editor().draft?.timeline.find((c) => c.id === id);

/** A slider drag, or a run of ↑/↓ in the well: one undo step until endGesture. */
export const speedGestureKey = (ids: readonly string[]) => `speed:${ids.join(",")}`;
/** A bezier handle's drag or run of arrow keys. */
export const curveGestureKey = (clipId: string) => `curve:${clipId}`;
export const roundSpeed = (speed: number) => (Number.isFinite(speed) ? Number(speed.toPrecision(3)) : speed);

/** Why a speed change must wait: it would pin a Stacked timeline whose clips are still loading (as Paste waits). */
export function speedWaitsReason(s: StitchEditorState): string | null {
  return s.draft?.sequenceLayout.mode === "stacked" ? pinWaitsForLoading(s.draft, s.clipsLoading) : null;
}

/** Whether the rail's Speed and the menu's Speed… act on these clips: every length known, and no wait. */
export function canSetSpeed(s: StitchEditorState, ids: readonly string[]): boolean {
  const draft = s.draft;
  if (!draft || ids.length === 0 || speedWaitsReason(s) !== null) return false;
  return ids.every((id) => {
    const clip = draft.timeline.find((c) => c.id === id);
    return !!clip && s.durations.has(sourceKey(clip.source));
  });
}

/**
 * One recipe for every warp edit. A speed change is a length change at the clip's tail: in Stacked every start is
 * pinned first, as a trim pins them, so the clip keeps its start and no other clip moves; it waits while a pin would
 * read lengths still loading. Reverse, Blend and a ramp keep the length and never pin.
 */
function retime(ids: readonly string[], patch: WarpPatch, opts?: { gestureKey?: string }): void {
  const s = editor();
  const draft = s.draft;
  if (!draft || ids.length === 0) return;
  const set = new Set(ids);
  const next = updateClipsWarp(draft.timeline, set, s.durations, patch);
  if (next === draft.timeline) return;
  const pins =
    draft.sequenceLayout.mode === "stacked" &&
    next.some((c, i) => set.has(c.id) && (c.warp?.speed ?? 1) !== (draft.timeline[i].warp?.speed ?? 1));
  const wait = pins ? speedWaitsReason(s) : null;
  if (wait) {
    useToast.getState().show(wait, "info");
    return;
  }
  s.apply((d) => {
    const base = pins ? pinStarts(d.timeline, s.durations, d.sequenceLayout.overlapSec) : d.timeline;
    const after = updateClipsWarp(base, set, s.durations, patch);
    return after === d.timeline ? d : { ...d, timeline: after };
  }, opts);
}

type WarpOpts = {
  gestureKey?: string;
  /** A drag's Blend, carried across 1×, where the warp itself goes. */
  blend?: boolean;
};
const withBlend = (patch: WarpPatch, opts?: WarpOpts): WarpPatch =>
  opts?.blend === undefined ? patch : { ...patch, blend: opts.blend };

export function setClipSpeed(clipId: string, speed: number, opts?: WarpOpts): void {
  retime([clipId], withBlend({ speed: roundSpeed(speed) }, opts), opts);
}

export function setSelectedClipsSpeed(speed: number): void {
  retime(selectedClipIds(editor()), { speed: roundSpeed(speed) });
}

/** A new ramp (null: constant speed); a split piece's window always goes. */
export function setClipCurve(clipId: string, curve: ClipWarpCurve | null, opts?: WarpOpts): void {
  retime([clipId], withBlend({ curve }, opts), opts);
}

export function setClipReverse(clipId: string, reverse: boolean): void {
  retime([clipId], { reverse });
}

export function setSelectedClipsReverse(reverse: boolean): void {
  retime(selectedClipIds(editor()), { reverse });
}

/** The menu's Reverse: every selected clip reversed, or all forward when every one already is. */
export function toggleSelectedReverse(): void {
  const s = editor();
  const ids = selectedClipIds(s);
  const all = ids.length > 0 && ids.every((id) => clipOf(id)?.warp?.reverse === true);
  retime(ids, { reverse: !all });
}

export function setClipBlend(clipId: string, blend: boolean): void {
  retime([clipId], { blend });
}

/** Speed 1 and no ramp on every selected clip; Reverse stays. */
export function resetSelectedSpeed(): void {
  retime(selectedClipIds(editor()), { speed: 1, curve: null });
}

/**
 * A move of the slider, or ↑/↓ in the well, towards `speed` (dir 1: faster). The speed now stored, or null when nothing
 * changed. A move never goes against its direction: from a split piece's 0.04×, ↓ would otherwise clamp up to 0.1×, and
 * from a piece just over its own rounded limit (5.0138× where the most is 5.01×) ↑ or the slider moved right would
 * clamp down to it.
 */
export function moveClipSpeed(clipId: string, speed: number, dir: 1 | -1, opts?: WarpOpts): number | null {
  const before = clipOf(clipId);
  if (!before) return null;
  const from = before.warp?.speed ?? 1;
  // Where the move lands once setClipSpeed has rounded and clamped it
  const { min, max } = clipSpeedLimits(before, editor().durations.get(sourceKey(before.source)));
  const to = Math.min(Math.max(roundSpeed(speed), min), max);
  if (dir > 0 ? !(to > from) : !(to < from)) return null;
  setClipSpeed(clipId, to, opts);
  const after = clipOf(clipId);
  return after && after !== before ? (after.warp?.speed ?? 1) : null;
}

/** ↑/↓ in the Speed well: one step under speedGestureKey, so a run is one undo step until the well is left. */
export function nudgeClipSpeed(clipId: string, dir: 1 | -1, big: boolean): number | null {
  const from = clipOf(clipId)?.warp?.speed ?? 1;
  return moveClipSpeed(clipId, nudgeSpeed(from, dir, big), dir, { gestureKey: speedGestureKey([clipId]) });
}

/** Whether this clip's speed curve is open: Stacked, its own row; Track, the clips row (it names any clip there). */
export function isClipCurveExpanded(s: StitchEditorState, clipId: string): boolean {
  const id = s.videoExpandedClip;
  if (id === null || !s.draft) return false;
  return s.draft.sequenceLayout.mode === "stacked" ? id === clipId : s.draft.timeline.some((c) => c.id === id);
}

/** The rail's and the menu's Show / Hide speed curve. Not an undo step; one video row open at a time. */
export function toggleClipCurveExpanded(clipId: string): void {
  const s = editor();
  s.setVideoExpandedClip(isClipCurveExpanded(s, clipId) ? null : clipId);
}

/**
 * One knot off a clip's drawn speed curve (a double-click); the ends stay. Nothing on a curve that is not points over
 * the whole clip. A straight line left is no ramp: at 1× forward the warp goes.
 */
export function removeClipWarpPoint(clipId: string, index: number): void {
  const knots = editablePoints(clipOf(clipId)?.warp);
  if (!knots) return;
  const points = removeRemapPoint(knots, index);
  if (points === knots) return;
  setClipCurve(clipId, { kind: "points", points: points.map(([x, y]): [number, number] => [x, y]) });
}

/**
 * The menu's Speed…: one frame later, the rail's Speed well. By then the menu has closed, handed focus to its panel and
 * the rail shows the clip it selected, so the well is the one in the panel that has focus.
 */
export function focusSpeedWell(): void {
  requestAnimationFrame(() =>
    document.activeElement
      ?.closest<HTMLElement>(EDITOR_PANEL_SELECTOR)
      ?.querySelector<HTMLInputElement>('aside[aria-label="Clip"] input[aria-label="Speed"]:not(:disabled)')
      ?.focus(),
  );
}
