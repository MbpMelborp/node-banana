import {
  selectedClipIds,
  selectIsMulti,
  useStitchEditorStore,
  type StitchEditorState,
} from "@/store/stitchEditorStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { fadeIn, fadeOut, flat, followEndFade, removePoint } from "@/lib/stitch/curve";
import { primeAssetInfo } from "@/lib/stitch/assetInfo";
import { stitchHasMusicEdge } from "@/lib/stitch/sources";
import { draftDuration, draftSpans, sameLayout } from "@/lib/stitch/draft";
import { clampOverlapSec, effectiveOverlapSec } from "@/lib/stitch/stack";
import { FRAME_RATE } from "@/lib/stitch/sequencePlan";
import { makeSelection } from "@/lib/stitch/selection";
import {
  appendClips,
  canSplitClipsAt,
  clearStarts,
  createClip,
  inOverlap,
  isPlaced,
  layoutSpans,
  moveClip,
  moveClipsBlock,
  moveClipStart,
  pinStarts,
  placeClips,
  reanchorTime,
  removeClip,
  removeClips,
  resetTrim,
  resetTrimInPlace,
  resetTrims,
  setEdgeAtPlayhead,
  shiftRows,
  sourceKey,
  sourceTimeAt,
  spansAt,
  spansEnd,
  splitClipAt,
  splitClipsAt,
  topSpanAt,
  trimClip,
  trimClipInPlace,
  updateClipAudio,
  updateClipsAudio,
  type ClipSpan,
  type SourceKey,
} from "@/lib/stitch/timeline";
import type { AssetView } from "@/lib/assets/types";
import type { StitchSequenceLayout, StitchTimelineClip, VolumePoint } from "@/types";
import { commitStitchEdit } from "./commitStitchEdit";
import { liveFitZoom } from "./liveFitZoom";

/**
 * What the editor's keys, rail and transport do to its store. Each reads the
 * store at call time (draft, durations, playhead), so a key handler or a
 * button never acts on a stale render.
 */

const editor = () => useStitchEditorStore.getState();

/** One loop of the sequence, in seconds. */
function editorTotal(s: Pick<StitchEditorState, "draft" | "durations">): number {
  return s.draft ? draftDuration(s.draft, s.durations) : 0;
}

/** The lead of a clip selection: the clip a single-clip action acts on. */
function selectedClipId(s: StitchEditorState): string | null {
  return s.selection?.kind === "clip" ? s.selection.clipId : null;
}

const stackedOf = (s: StitchEditorState) => s.draft?.sequenceLayout.mode === "stacked";
/**
 * The stored Overlap, not the effective one: it places a stack's unpinned clips whatever the layout shows now (a
 * pinning edit made in Track would otherwise pin them as butted).
 */
const overlapOf = (s: StitchEditorState) => s.draft?.sequenceLayout.overlapSec ?? 0;
/** Stacked with a stored start: edits there pin every clip first, so none they do not edit moves. */
const placedOf = (s: StitchEditorState) => stackedOf(s) && isPlaced(s.draft?.timeline ?? []);

/** The selected clip's span as the draft lays it out, or null (also with several selected). */
function selectedSpan(s: StitchEditorState): ClipSpan | null {
  const clipId = selectedClipId(s);
  if (!s.draft || !clipId || selectIsMulti(s)) return null;
  return draftSpans(s.draft, s.durations).find((span) => span.clip.id === clipId) ?? null;
}

/** The playhead as the lane draws it: a stored one past a sequence that got shorter sits at the end. */
export const drawnPlayhead = (s: StitchEditorState) => Math.min(s.playhead, editorTotal(s));

/** What Fit's px/s depends on in a timeline: the sequence's length and where each empty clip's slot starts. */
function fitInputs(spans: readonly ClipSpan[]): string {
  const slots = spans.filter((span) => span.length <= 0).map((span) => span.start);
  return [spansEnd(spans), ...slots.sort((a, b) => a - b)].join(",");
}

/**
 * Moves keep the zoom: in Fit, a move that would re-fit the lane (it changes the sequence's length, or moves an empty
 * clip's slot) first stores the px/s the lane drew it at, so the clip lands where it was drawn instead of the lane
 * re-fitting under it. Called before the apply, in the same handler. Nothing without a mounted timeline.
 */
export function keepZoom(s: StitchEditorState, timeline: readonly StitchTimelineClip[]): void {
  if (s.pxPerSec !== null || !s.draft) return;
  const pxPerSec = liveFitZoom.get();
  if (pxPerSec === null) return;
  const layout = s.draft.sequenceLayout;
  if (fitInputs(layoutSpans(timeline, s.durations, layout)) === fitInputs(draftSpans(s.draft, s.durations))) return;
  s.setZoom(pxPerSec);
}

export function togglePlay(): void {
  const s = editor();
  if (s.playing) s.setPlaying(false);
  else if (editorTotal(s) > 0) s.setPlaying(true);
}

export function play(): void {
  const s = editor();
  if (!s.playing && editorTotal(s) > 0) s.setPlaying(true);
}

export function pause(): void {
  editor().setPlaying(false);
}

/** J: one second back from the playhead as drawn (the store keeps one a shortened sequence no longer reaches). */
export function stepBack(): void {
  const s = editor();
  s.setPlayhead(Math.max(0, Math.min(s.playhead, editorTotal(s)) - 1));
}

export function goToStart(): void {
  editor().setPlayhead(0);
}

export function goToEnd(): void {
  const s = editor();
  s.setPlaying(false);
  s.setPlayhead(editorTotal(s));
}

/**
 * The split S makes now: the selected clip when the playhead is inside it, else the clip in front under it (the
 * earlier one in Track and a lined-up stack, the top row in a placed one).
 */
function splitOptions(s: StitchEditorState, layout: StitchSequenceLayout) {
  return { overlapSec: effectiveOverlapSec(layout), preferClipId: selectedClipId(s), layout };
}

/** S with several selected: whether some selected clip is under the playhead with room to split (no timeline copied). */
function canSplitGroup(s: StitchEditorState): boolean {
  if (!s.draft) return false;
  return canSplitClipsAt(draftSpans(s.draft, s.durations), s.playhead, new Set(selectedClipIds(s)), placedOf(s));
}

/** Some selected clip plays at the playhead, whether or not it is far enough from its ends to split. */
function selectedUnderPlayhead(s: StitchEditorState): boolean {
  if (!s.draft) return false;
  const ids = new Set(selectedClipIds(s));
  return spansAt(draftSpans(s.draft, s.durations), s.playhead).some((span) => ids.has(span.clip.id));
}

/** Whether S would split something now. */
export function canSplitAtPlayhead(s: StitchEditorState): boolean {
  if (!s.draft) return false;
  if (selectIsMulti(s)) return canSplitGroup(s);
  const opts = splitOptions(s, s.draft.sequenceLayout);
  return splitClipAt(s.draft.timeline, s.durations, s.playhead, () => "probe", opts) !== null;
}

/** The rail's Split: S would split, and the clip it would cut is the one the rail shows. */
export function canSplitSelectedAtPlayhead(s: StitchEditorState): boolean {
  const clipId = selectedClipId(s);
  if (!s.draft || !clipId) return false;
  if (selectIsMulti(s)) return canSplitGroup(s);
  return topSpanAt(draftSpans(s.draft, s.durations), s.playhead, clipId)?.clip.id === clipId && canSplitAtPlayhead(s);
}

/**
 * Why Split is off, when the reason is not obvious: two clips play under the playhead in a lined-up stack, whose
 * split would re-sequence it. A placed stack splits there too (the pieces stay one run, so nothing changes).
 */
export function splitBlockedReason(s: StitchEditorState): string | null {
  if (!s.draft) return null;
  const overlap =
    stackedOf(s) && !placedOf(s) && inOverlap(draftSpans(s.draft, s.durations), s.playhead)
      ? "Move the playhead out of the overlap to split"
      : null;
  if (selectIsMulti(s)) return overlap ?? (selectedUnderPlayhead(s) ? null : "No selected clip is under the playhead");
  return overlap;
}

/**
 * S: splits the clip under the playhead and selects its right piece. With several selected, every selected clip under
 * it splits and the right pieces become the selection. A placed stack is pinned first, in the same step.
 */
export function splitAtPlayhead(): void {
  const s = editor();
  if (!s.draft) return;
  const timeline = placedOf(s) ? pinStarts(s.draft.timeline, s.durations, overlapOf(s)) : s.draft.timeline;
  if (selectIsMulti(s)) {
    const split = splitClipsAt(timeline, s.durations, s.playhead, selectedClipIds(s), { layout: s.draft.sequenceLayout });
    if (!split) return;
    s.apply((d) => ({ ...d, timeline: split.timeline }));
    const order = split.timeline.map((c) => c.id);
    editor().select(makeSelection(order, split.rightIds, split.rightIds[0]));
    return;
  }
  const result = splitClipAt(timeline, s.durations, s.playhead, undefined, splitOptions(s, s.draft.sequenceLayout));
  if (!result) return;
  s.apply((d) => ({ ...d, timeline: result.timeline }));
  editor().select({ kind: "clip", clipId: result.rightId });
}

/**
 * I / O: the selected clip's In or Out at the playhead, when the playhead is inside it. In Stacked the frames stay
 * where they are (trimClipInPlace), so I starts the clip at the playhead.
 */
export function setEdgeAtPlayheadForSelection(edge: "in" | "out"): void {
  const s = editor();
  const clipId = selectedClipId(s);
  if (!s.draft || !clipId || selectIsMulti(s)) return;
  if (!stackedOf(s)) {
    const overlap = effectiveOverlapSec(s.draft.sequenceLayout);
    const timeline = setEdgeAtPlayhead(s.draft.timeline, s.durations, clipId, edge, s.playhead, overlap);
    if (timeline) s.apply((d) => ({ ...d, timeline }));
    return;
  }
  const span = selectedSpan(s);
  const t = s.playhead;
  if (!span || span.length === 0 || !Number.isFinite(t) || t < span.start || t > span.end) return;
  if (edge === "out" ? t <= span.start : t >= span.end) return;
  const at = sourceTimeAt(span, t);
  const timeline = trimClipInPlace(
    s.draft.timeline,
    clipId,
    s.durations,
    edge === "in" ? { inSec: at } : { outSec: at },
    overlapOf(s),
  );
  s.apply((d) => ({ ...d, timeline }));
}

/**
 * Removes the listed clips in one step (⌫ and ⌘X with several selected): a lined-up stack closes up, a placed one is
 * pinned first, so nothing else moves. The clip now at the first removed index takes the selection. Returns the ids
 * removed.
 */
export function removeClipsById(ids: readonly string[]): string[] {
  const s = editor();
  if (!s.draft) return [];
  const wanted = new Set(ids);
  const index = s.draft.timeline.findIndex((c) => wanted.has(c.id));
  if (index === -1) return [];
  const removed = s.draft.timeline.filter((c) => wanted.has(c.id)).map((c) => c.id);
  const from = placedOf(s) ? pinStarts(s.draft.timeline, s.durations, overlapOf(s)) : s.draft.timeline;
  const { timeline } = removeClips(from, wanted);
  s.apply((d) => ({ ...d, timeline }));
  const neighbour = timeline[Math.min(index, timeline.length - 1)];
  editor().select(neighbour ? { kind: "clip", clipId: neighbour.id } : null);
  return removed;
}

/**
 * ⌫: the selected clip, or the selected curve point. The neighbour takes the clip's selection. A lined-up stack
 * closes up; a placed one is pinned first, so nothing else moves. With several selected, all of them.
 */
export function removeSelection(): void {
  const s = editor();
  if (!s.draft) return;
  if (s.selection?.kind === "audio") return removeSelectedPoint();
  if (selectIsMulti(s)) {
    editor().untagCut(removeClipsById(selectedClipIds(s)));
    return;
  }
  const clipId = selectedClipId(s);
  if (!clipId) return;
  const index = s.draft.timeline.findIndex((c) => c.id === clipId);
  if (index === -1) return;
  const from = placedOf(s) ? pinStarts(s.draft.timeline, s.durations, overlapOf(s)) : s.draft.timeline;
  const { timeline } = removeClip(from, clipId);
  s.apply((d) => ({ ...d, timeline }));
  const after = editor();
  after.untagCut([clipId]);
  const neighbour = timeline[Math.min(index, timeline.length - 1)];
  after.select(neighbour ? { kind: "clip", clipId: neighbour.id } : null);
}

/**
 * ⌫ on the audio track: the selected curve point, if one is (the store forgets it when the curve changes). Not
 * while the track is muted: the lane draws no curve then.
 */
export function removeSelectedPoint(): void {
  const s = editor();
  const point = s.selection?.kind === "audio" ? s.selection.point : null;
  if (point === null || s.draft?.audioMuted) return;
  s.apply((d) => ({ ...d, audioCurve: removePoint(d.audioCurve, point) }));
}

/** One curve gesture's result (a point added, moved or removed, the line moved), as one undo step. */
export function setCurve(curve: VolumePoint[]): void {
  editor().apply((d) => ({ ...d, audioCurve: curve }));
}

/** The quick buttons place a fade over one loop of the sequence as it is now. */
export function applyFadeIn(): void {
  const s = editor();
  const total = editorTotal(s);
  s.apply((d) => ({ ...d, audioCurve: fadeIn(d.audioCurve, total) }));
}

export function applyFadeOut(): void {
  const s = editor();
  const total = editorTotal(s);
  s.apply((d) => ({ ...d, audioCurve: fadeOut(d.audioCurve, total) }));
}

/** Flat: back to 0 dB all through. */
export function flattenCurve(): void {
  editor().apply((d) => ({ ...d, audioCurve: flat() }));
}

/** ⌥M. With several selected: all muted, or all unmuted when every one already is muted. */
export function toggleSelectedClipMute(): void {
  const s = editor();
  if (selectIsMulti(s)) {
    const ids = new Set(selectedClipIds(s));
    const muted = !(s.draft?.timeline.filter((c) => ids.has(c.id)).every((c) => c.muted) ?? false);
    s.apply((d) => ({ ...d, timeline: updateClipsAudio(d.timeline, ids, { muted }) }));
    return;
  }
  const clipId = selectedClipId(s);
  const clip = s.draft?.timeline.find((c) => c.id === clipId);
  if (!clip) return;
  s.apply((d) => ({ ...d, timeline: updateClipAudio(d.timeline, clip.id, { muted: !clip.muted }) }));
}

export function setClipMuted(clipId: string, muted: boolean): void {
  editor().apply((d) => ({ ...d, timeline: updateClipAudio(d.timeline, clipId, { muted }) }));
}

/** The rail's Clip audio On or Off with several selected: every selected clip, one step (none when all already are). */
export function setSelectedClipsMuted(muted: boolean): void {
  const s = editor();
  const ids = new Set(selectedClipIds(s));
  if (ids.size === 0) return;
  s.apply((d) => ({ ...d, timeline: updateClipsAudio(d.timeline, ids, { muted }) }));
}

/**
 * M. Nothing without music connected, since nothing in the editor would show it and a later connection would be
 * left out silently; a muted node can still be unmuted.
 */
export function toggleMusicMute(): void {
  const s = editor();
  if (!s.draft || !s.nodeId) return;
  if (!s.draft.audioMuted) {
    const wf = useWorkflowStore.getState();
    if (!stitchHasMusicEdge(s.nodeId, wf.edges, wf.dimmedNodeIds, wf.nodes)) return;
  }
  s.apply((d) => ({ ...d, audioMuted: !d.audioMuted }));
  // A muted track draws no curve, so no point of it stays selected
  const after = editor();
  if (after.draft?.audioMuted && after.selection?.kind === "audio" && after.selection.point !== null) {
    after.select({ kind: "audio", point: null });
  }
}

/**
 * Clamped by trimClip; an unchanged value is no step. In Stacked the frames stay where they are: an In change moves
 * the start by as much, never before 0:00 (trimClipInPlace, which pins).
 */
export function trimSelected(patch: { inSec?: number; outSec?: number | null }): void {
  const s = editor();
  const clipId = selectedClipId(s);
  if (!clipId || selectIsMulti(s)) return;
  const stacked = stackedOf(s);
  const overlapSec = overlapOf(s);
  s.apply((d) => ({
    ...d,
    timeline: stacked
      ? trimClipInPlace(d.timeline, clipId, s.durations, patch, overlapSec)
      : trimClip(d.timeline, clipId, s.durations, patch),
  }));
}

/**
 * In Stacked the start moves back by the old In, clamped at 0:00 (resetTrimInPlace, which pins). With several
 * selected, every trimmed one, in one step.
 */
export function resetSelectedTrim(): void {
  const s = editor();
  if (selectIsMulti(s)) {
    const ids = new Set(selectedClipIds(s));
    s.apply((d) => ({ ...d, timeline: resetTrims(d.timeline, s.durations, ids, d.sequenceLayout) }));
    return;
  }
  const clipId = selectedClipId(s);
  if (!clipId) return;
  const stacked = stackedOf(s);
  const overlapSec = overlapOf(s);
  s.apply((d) => ({
    ...d,
    timeline: stacked ? resetTrimInPlace(d.timeline, clipId, s.durations, overlapSec) : resetTrim(d.timeline, clipId),
  }));
}

/** Per slider tick: the ticks of one drag (or one run of arrow keys) are one undo step until endGesture. */
export function setClipVolume(clipId: string, volume: number): void {
  editor().apply((d) => ({ ...d, timeline: updateClipAudio(d.timeline, clipId, { volume }) }), {
    gestureKey: `volume:${clipId}`,
  });
}

export function setLoopCount(n: 1 | 2 | 3): void {
  editor().apply((d) => ({ ...d, loopCount: n }));
}

/**
 * A new layout, as one undo step (or one gesture's): a fade out ending on the old end follows the new end
 * (followEndFade), and the playhead stays on the same frame of the same clip (reanchorTime). Pausing is the
 * modal's: it pauses on any change of the Track/Stacked flag, undo and redo included.
 */
function applyLayout(layout: StitchSequenceLayout, opts?: { gestureKey?: string; timeline?: StitchTimelineClip[] }): void {
  const s = editor();
  if (!s.draft || sameLayout(s.draft.sequenceLayout, layout)) return;
  const timeline = opts?.timeline ?? s.draft.timeline;
  const before = draftSpans(s.draft, s.durations);
  const after = draftSpans({ timeline, sequenceLayout: layout }, s.durations);
  const oldTotal = draftDuration(s.draft, s.durations);
  const newTotal = spansEnd(after);
  s.apply(
    (d) => ({ ...d, timeline, sequenceLayout: layout, audioCurve: followEndFade(d.audioCurve, oldTotal, newTotal) }),
    opts?.gestureKey !== undefined ? { gestureKey: opts.gestureKey } : undefined,
  );
  editor().setPlayhead(reanchorTime(before, after, s.playhead, selectedClipId(s)));
}

/** Track | Stacked. The overlap and the crossfade are kept either way. */
export function setSequenceMode(mode: StitchSequenceLayout["mode"]): void {
  const layout = editor().draft?.sequenceLayout;
  if (layout) applyLayout({ ...layout, mode });
}

/**
 * Clamped to 0–10 s in 0.1 s steps; an unchanged value is no step. opts.gesture coalesces ↑/↓ nudges until endGesture.
 * A lined-up stack moves with it. A placed one is first pinned at the old Overlap, in the same step, so it moves
 * nothing: Overlap then only says where new clips go and how Line up spaces the clips.
 */
export function setOverlapSec(seconds: number, opts?: { gesture?: boolean }): void {
  const s = editor();
  const layout = s.draft?.sequenceLayout;
  if (!s.draft || !layout) return;
  const timeline = placedOf(s) ? pinStarts(s.draft.timeline, s.durations, layout.overlapSec) : undefined;
  applyLayout(
    { ...layout, overlapSec: clampOverlapSec(seconds) },
    { ...(opts?.gesture ? { gestureKey: "overlap" } : {}), ...(timeline ? { timeline } : {}) },
  );
}

export function setCrossfade(on: boolean): void {
  const layout = editor().draft?.sequenceLayout;
  if (layout) applyLayout({ ...layout, crossfade: on });
}

/**
 * A row move without time (the row header drag, ⌥↑ ⌥↓, the menu's row items): Track and a lined-up stack re-sequence
 * from the new order; a placed stack is pinned first, so every clip keeps its start.
 */
export function moveClipTo(clipId: string, toIndex: number): void {
  const s = editor();
  const from = s.draft?.timeline.findIndex((c) => c.id === clipId) ?? -1;
  if (!s.draft || from === -1) return;
  const timeline = placedOf(s) ? pinStarts(s.draft.timeline, s.durations, overlapOf(s)) : s.draft.timeline;
  const moved = moveClip(timeline, from, toIndex);
  // Pinning alone is no row move
  if (moved === timeline) return;
  s.apply((d) => ({ ...d, timeline: moved }));
}

/**
 * Several clips' rows by rowDelta, keeping their spacing (the Stacked header group drag, ⌥↑ ⌥↓): a placed stack is
 * pinned first, so every clip keeps its start. One step; none when the group is already at that edge.
 */
export function moveClipRows(ids: readonly string[], rowDelta: number): void {
  const s = editor();
  if (!s.draft) return;
  const timeline = placedOf(s) ? pinStarts(s.draft.timeline, s.durations, overlapOf(s)) : s.draft.timeline;
  const moved = shiftRows(timeline, new Set(ids), rowDelta);
  if (moved === timeline) return;
  s.apply((d) => ({ ...d, timeline: moved }));
}

/** The Track block drag's release: the listed clips as one run before the toIndex-th other clip, in their order. */
export function moveClipsTo(ids: readonly string[], toIndex: number): void {
  const s = editor();
  if (!s.draft) return;
  const timeline = placedOf(s) ? pinStarts(s.draft.timeline, s.durations, overlapOf(s)) : s.draft.timeline;
  const moved = moveClipsBlock(timeline, new Set(ids), toIndex);
  if (moved === timeline) return;
  s.apply((d) => ({ ...d, timeline: moved }));
}

/** ⌥↑ / ⌥↓ and the menu: whether the selected clip, or every selected one, has a row to go to (Stacked). */
export function canMoveRow(s: StitchEditorState, dir: 1 | -1): boolean {
  const clipId = selectedClipId(s);
  if (!s.draft || !clipId || !stackedOf(s)) return false;
  if (selectIsMulti(s)) {
    const ids = new Set(selectedClipIds(s));
    const indices = s.draft.timeline.flatMap((c, i) => (ids.has(c.id) ? [i] : []));
    return indices[0] + dir >= 0 && indices[indices.length - 1] + dir < s.draft.timeline.length;
  }
  const index = s.draft.timeline.findIndex((c) => c.id === clipId);
  return index !== -1 && index + dir >= 0 && index + dir < s.draft.timeline.length;
}

/** ⌥↑ / ⌥↓: the selected clip, or every selected one, one row up or down (Stacked; nothing in Track). */
export function moveSelectedRow(dir: 1 | -1): void {
  const s = editor();
  const clipId = selectedClipId(s);
  if (!s.draft || !clipId || !canMoveRow(s, dir)) return;
  if (selectIsMulti(s)) return moveClipRows(selectedClipIds(s), dir);
  moveClipTo(clipId, s.draft.timeline.findIndex((c) => c.id === clipId) + dir);
}

// Placing clips in time (Stacked). Every one pins the stack and keeps the zoom; Track has no start to set.

/**
 * The clip starts at `sec` (clamped to 0–10 min): the typed Start, the nudges, [ and ]. One undo step, or one per
 * gesture with opts.gestureKey; an unchanged start is no step. Nothing in Track.
 */
export function setClipStart(clipId: string, sec: number, opts?: { gestureKey?: string }): void {
  const s = editor();
  if (!s.draft || !stackedOf(s) || !Number.isFinite(sec) || selectIsMulti(s)) return;
  const timeline = moveClipStart(s.draft.timeline, s.durations, clipId, sec, overlapOf(s));
  if (timeline === s.draft.timeline) return;
  keepZoom(s, timeline);
  s.apply((d) => ({ ...d, timeline }), opts);
}

/**
 * A body drag's release: applies exactly the timeline the drag drew (placeClip: the clip's new start and row, every
 * clip pinned), as one undo step. Never re-sequences, in a lined-up stack too.
 */
export function moveClipBody(clipId: string, timeline: StitchTimelineClip[]): void {
  const s = editor();
  if (!s.draft || !stackedOf(s) || timeline === s.draft.timeline) return;
  if (!timeline.some((c) => c.id === clipId)) return;
  keepZoom(s, timeline);
  s.apply((d) => ({ ...d, timeline }));
}

/**
 * A group body drag's release: the timeline it drew (placeClips: every selected clip moved by one time and one row
 * delta, every clip pinned), as one undo step.
 */
export function moveClipsBody(ids: readonly string[], timeline: StitchTimelineClip[]): void {
  const s = editor();
  if (!s.draft || !stackedOf(s) || timeline === s.draft.timeline) return;
  if (!ids.every((id) => timeline.some((c) => c.id === id))) return;
  keepZoom(s, timeline);
  s.apply((d) => ({ ...d, timeline }));
}

/** One output frame: the encoder's grid. */
const NUDGE_SEC = 1 / FRAME_RATE;
const BIG_NUDGE_FRAMES = 10;
const START_STEP_SEC = 0.1;
const BIG_START_STEP_SEC = 1;

/**
 * ⌥← / ⌥→: one output frame (⇧: ten). A held key's repeats join its first press's undo step. With several selected,
 * all of them, their spacing kept and the group stopped at 0:00 and 10:00.
 */
export function nudgeSelectedClip(dir: 1 | -1, big: boolean, repeat: boolean): void {
  const s = editor();
  if (selectIsMulti(s)) {
    if (!s.draft || !stackedOf(s)) return;
    if (!repeat) s.endGesture();
    const ids = selectedClipIds(s);
    const step = (big ? BIG_NUDGE_FRAMES : 1) * NUDGE_SEC;
    const timeline = placeClips(s.draft.timeline, s.durations, new Set(ids), dir * step, 0, overlapOf(s));
    if (timeline === s.draft.timeline) return;
    keepZoom(s, timeline);
    s.apply((d) => ({ ...d, timeline }), { gestureKey: `nudge:${ids.join(",")}` });
    return;
  }
  const span = stackedOf(s) ? selectedSpan(s) : null;
  if (!span) return;
  // A new press is a new undo step, even right after the last one
  if (!repeat) s.endGesture();
  const step = (big ? BIG_NUDGE_FRAMES : 1) * NUDGE_SEC;
  setClipStart(span.clip.id, span.start + dir * step, { gestureKey: `nudge:${span.clip.id}` });
}

/**
 * ↑ / ↓ in the Start well: 0.1 s (⇧: 1 s), one undo step until the well is left (its blur ends the gesture). Returns
 * the start now stored, or null when nothing changed.
 */
export function nudgeStartWell(dir: 1 | -1, big: boolean): number | null {
  const s = editor();
  const span = stackedOf(s) ? selectedSpan(s) : null;
  if (!span) return null;
  const before = s.draft?.timeline;
  setClipStart(span.clip.id, span.start + dir * (big ? BIG_START_STEP_SEC : START_STEP_SEC), {
    gestureKey: `start:${span.clip.id}`,
  });
  const after = editor();
  if (after.draft?.timeline === before) return null;
  return selectedSpan(after)?.start ?? null;
}

/** [ and the menu: the selected clip can start at the playhead (Stacked). */
export function canStartAtPlayhead(s: StitchEditorState): boolean {
  return stackedOf(s) && selectedSpan(s) !== null;
}

/** ] and the menu: the selected clip can end at the playhead, which needs as much time before it as the clip lasts. */
export function canEndAtPlayhead(s: StitchEditorState): boolean {
  const span = stackedOf(s) ? selectedSpan(s) : null;
  return span !== null && drawnPlayhead(s) - span.length >= -1e-9;
}

/** [: the selected clip starts at the playhead. */
export function startSelectedAtPlayhead(): void {
  const s = editor();
  const span = canStartAtPlayhead(s) ? selectedSpan(s) : null;
  if (span) setClipStart(span.clip.id, drawnPlayhead(s));
}

/** ]: the selected clip ends at the playhead; nothing when it would have to start before 0:00. */
export function endSelectedAtPlayhead(): void {
  const s = editor();
  const span = canEndAtPlayhead(s) ? selectedSpan(s) : null;
  if (span) setClipStart(span.clip.id, Math.max(0, drawnPlayhead(s) - span.length));
}

/** Line up is offered once some clip has been placed. */
export function canLineUp(s: StitchEditorState): boolean {
  return placedOf(s);
}

/**
 * Line up: every placement dropped, so the clips start Overlap before the one above ends, as one undo step. A fade
 * out ending on the old end follows the new end, and the playhead stays on the same frame of the same clip.
 */
export function lineUpClips(): void {
  const s = editor();
  if (!s.draft || !canLineUp(s)) return;
  const timeline = clearStarts(s.draft.timeline);
  const before = draftSpans(s.draft, s.durations);
  const after = draftSpans({ timeline, sequenceLayout: s.draft.sequenceLayout }, s.durations);
  const oldTotal = spansEnd(before);
  const newTotal = spansEnd(after);
  s.apply((d) => ({ ...d, timeline, audioCurve: followEndFade(d.audioCurve, oldTotal, newTotal) }));
  editor().setPlayhead(reanchorTime(before, after, s.playhead, selectedClipId(s)));
}

/** The Clips track's +, the slot after the last clip and the empty lane: the library picker, over a paused preview. */
export function openLibraryPicker(): void {
  const s = editor();
  if (!s.draft) return;
  s.setPlaying(false);
  s.openMenu(null);
  s.setPickerOpen(true);
}

/**
 * The picker's Add: one clip per picked video, in the order they were picked, after the last clip, as one undo
 * step. The first of them is selected with the playhead at its start, and the picker closes. The records go to
 * the asset cache so the clips are labelled at once; the clips themselves hold only the ids.
 */
export function addAssetClips(views: readonly AssetView[]): void {
  const s = editor();
  if (!s.draft || views.length === 0) return;
  primeAssetInfo(views);
  const clips = views.map((view) => createClip({ kind: "asset", assetId: view.id }));
  s.apply((d) => ({ ...d, timeline: appendClips(d.timeline, clips) }));
  const after = editor();
  // In Stacked the first new clip starts under the last one: place it with the records' lengths, which the
  // editor has not measured yet
  const provisional = new Map<SourceKey, number>(after.durations);
  for (const view of views) {
    const key = sourceKey({ kind: "asset", assetId: view.id });
    if (!provisional.has(key) && typeof view.durationSec === "number") provisional.set(key, view.durationSec);
  }
  const first = after.draft ? draftSpans(after.draft, provisional).find((span) => span.clip.id === clips[0].id) : undefined;
  after.select({ kind: "clip", clipId: clips[0].id });
  after.setPlayhead(first?.start ?? editorTotal(s));
  after.setPickerOpen(false);
}

/** The node an edge clip comes from, or null (an asset clip, or an edge that is gone). */
function clipSourceNodeId(clipId: string): string | null {
  const clip = editor().draft?.timeline.find((c) => c.id === clipId);
  if (clip?.source.kind !== "edge") return null;
  const edgeId = clip.source.edgeId;
  return useWorkflowStore.getState().edges.find((e) => e.id === edgeId)?.source ?? null;
}

/** Whether Reveal source node has a node to go to: an edge clip whose source node the editor knows. */
export function canRevealSource(
  clip: Pick<StitchTimelineClip, "source">,
  view: { sourceNodeId?: string | null } | undefined,
): boolean {
  return clip.source.kind === "edge" && Boolean(view?.sourceNodeId);
}

/** Reveal source node: Done, then the canvas centres on the node (it leaves the editor, so the edits are kept). */
export function revealSelectedSource(): void {
  if (selectIsMulti(editor())) return;
  const clipId = selectedClipId(editor());
  const sourceNodeId = clipId ? clipSourceNodeId(clipId) : null;
  if (!sourceNodeId) return;
  if (commitStitchEdit() === "gone") return;
  useWorkflowStore.getState().setNavigationTarget(sourceNodeId);
}
