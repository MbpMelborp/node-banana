import { useStitchEditorStore, type StitchEditorState } from "@/store/stitchEditorStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { fadeIn, fadeOut, flat, removePoint } from "@/lib/stitch/curve";
import { primeAssetInfo } from "@/lib/stitch/assetInfo";
import { stitchHasMusicEdge } from "@/lib/stitch/sources";
import {
  appendClips,
  clipAtTime,
  createClip,
  moveClip,
  removeClip,
  resetTrim,
  sequenceDuration,
  setEdgeAtPlayhead,
  splitClipAt,
  trimClip,
  updateClipAudio,
} from "@/lib/stitch/timeline";
import type { AssetView } from "@/lib/assets/types";
import type { StitchTimelineClip, VolumePoint } from "@/types";
import { commitStitchEdit } from "./commitStitchEdit";

/**
 * What the editor's keys, rail and transport do to its store. Each reads the
 * store at call time (draft, durations, playhead), so a key handler or a
 * button never acts on a stale render.
 */

const editor = () => useStitchEditorStore.getState();

/** One loop of the sequence, in seconds. */
function editorTotal(s: Pick<StitchEditorState, "draft" | "durations">): number {
  return s.draft ? sequenceDuration(s.draft.timeline, s.durations) : 0;
}

function selectedClipId(s: StitchEditorState): string | null {
  return s.selection?.kind === "clip" ? s.selection.clipId : null;
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

/** Whether S would split something now. */
export function canSplitAtPlayhead(s: StitchEditorState): boolean {
  return s.draft !== null && splitClipAt(s.draft.timeline, s.durations, s.playhead, () => "probe") !== null;
}

/** The rail's Split: S would split, and the clip it would cut is the one the rail shows. */
export function canSplitSelectedAtPlayhead(s: StitchEditorState): boolean {
  const clipId = selectedClipId(s);
  if (!s.draft || !clipId) return false;
  return clipAtTime(s.draft.timeline, s.durations, s.playhead)?.clip.id === clipId && canSplitAtPlayhead(s);
}

/** S: splits the clip under the playhead and selects its right piece. */
export function splitAtPlayhead(): void {
  const s = editor();
  if (!s.draft) return;
  const result = splitClipAt(s.draft.timeline, s.durations, s.playhead);
  if (!result) return;
  s.apply((d) => ({ ...d, timeline: result.timeline }));
  editor().select({ kind: "clip", clipId: result.rightId });
}

/** I / O: the selected clip's In or Out at the playhead, when the playhead is inside it. */
export function setEdgeAtPlayheadForSelection(edge: "in" | "out"): void {
  const s = editor();
  const clipId = selectedClipId(s);
  if (!s.draft || !clipId) return;
  const timeline = setEdgeAtPlayhead(s.draft.timeline, s.durations, clipId, edge, s.playhead);
  if (timeline) s.apply((d) => ({ ...d, timeline }));
}

/** ⌫: the selected clip, or the selected curve point. The neighbour takes the clip's selection. */
export function removeSelection(): void {
  const s = editor();
  if (!s.draft) return;
  if (s.selection?.kind === "audio") return removeSelectedPoint();
  const clipId = selectedClipId(s);
  if (!clipId) return;
  const index = s.draft.timeline.findIndex((c) => c.id === clipId);
  if (index === -1) return;
  const { timeline } = removeClip(s.draft.timeline, clipId);
  s.apply((d) => ({ ...d, timeline }));
  const neighbour = timeline[Math.min(index, timeline.length - 1)];
  editor().select(neighbour ? { kind: "clip", clipId: neighbour.id } : null);
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

/** ⌥M. */
export function toggleSelectedClipMute(): void {
  const s = editor();
  const clipId = selectedClipId(s);
  const clip = s.draft?.timeline.find((c) => c.id === clipId);
  if (!clip) return;
  s.apply((d) => ({ ...d, timeline: updateClipAudio(d.timeline, clip.id, { muted: !clip.muted }) }));
}

export function setClipMuted(clipId: string, muted: boolean): void {
  editor().apply((d) => ({ ...d, timeline: updateClipAudio(d.timeline, clipId, { muted }) }));
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

/** Clamped by trimClip; an unchanged value is no step. */
export function trimSelected(patch: { inSec?: number; outSec?: number | null }): void {
  const s = editor();
  const clipId = selectedClipId(s);
  if (!clipId) return;
  s.apply((d) => ({ ...d, timeline: trimClip(d.timeline, clipId, s.durations, patch) }));
}

export function resetSelectedTrim(): void {
  const s = editor();
  const clipId = selectedClipId(s);
  if (!clipId) return;
  s.apply((d) => ({ ...d, timeline: resetTrim(d.timeline, clipId) }));
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

export function moveClipTo(clipId: string, toIndex: number): void {
  const s = editor();
  const from = s.draft?.timeline.findIndex((c) => c.id === clipId) ?? -1;
  if (from === -1) return;
  s.apply((d) => ({ ...d, timeline: moveClip(d.timeline, from, toIndex) }));
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
  const start = editorTotal(s);
  const clips = views.map((view) => createClip({ kind: "asset", assetId: view.id }));
  s.apply((d) => ({ ...d, timeline: appendClips(d.timeline, clips) }));
  const after = editor();
  after.select({ kind: "clip", clipId: clips[0].id });
  after.setPlayhead(start);
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
  const clipId = selectedClipId(editor());
  const sourceNodeId = clipId ? clipSourceNodeId(clipId) : null;
  if (!sourceNodeId) return;
  if (commitStitchEdit() === "gone") return;
  useWorkflowStore.getState().setNavigationTarget(sourceNodeId);
}
