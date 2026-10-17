import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  STITCH_HISTORY_LIMIT,
  selectCanRedo,
  selectCanUndo,
  selectIsDirty,
  useStitchEditorStore,
} from "@/store/stitchEditorStore";
import { draftSpans, type StitchDraft } from "@/lib/stitch/draft";
import { envelopeAt } from "@/lib/stitch/placement";
import {
  createClip,
  placeClip,
  removeClip,
  spansEnvelope,
  updateClipAudio,
  type SourceKey,
} from "@/lib/stitch/timeline";
import { addPoint, fadeOut, flat } from "@/lib/stitch/curve";
import { DEFAULT_SEQUENCE_LAYOUT as TRACK_LAYOUT } from "@/lib/stitch/stack";
import {
  addAssetClips,
  canEndAtPlayhead,
  canLineUp,
  canMoveRow,
  canSplitAtPlayhead,
  endSelectedAtPlayhead,
  lineUpClips,
  moveClipBody,
  moveSelectedRow,
  nudgeSelectedClip,
  nudgeStartWell,
  removeSelection,
  resetSelectedTrim,
  setClipStart,
  setCrossfade,
  setEdgeAtPlayheadForSelection,
  setOverlapSec,
  setSequenceMode,
  splitAtPlayhead,
  splitBlockedReason,
  startSelectedAtPlayhead,
  trimSelected,
} from "@/components/stitch/editorActions";
import { liveFitZoom } from "@/components/stitch/liveFitZoom";
import type { AssetView } from "@/lib/assets/types";
import type { StitchTimelineClip } from "@/types";

vi.mock("@/components/Toast", () => ({ useToast: { getState: () => ({ show: vi.fn() }) } }));

const clipA = createClip({ kind: "edge", edgeId: "e1" }, { id: "a" });
const clipB = createClip({ kind: "asset", assetId: "x" }, { id: "b", inSec: 1 });

function makeDraft(overrides: Partial<StitchDraft> = {}): StitchDraft {
  return {
    timeline: [clipA, clipB],
    audioCurve: [],
    audioMuted: false,
    loopCount: 1,
    sequenceLayout: TRACK_LAYOUT,
    ...overrides,
  };
}

const store = () => useStitchEditorStore.getState();
const openOn = (draft: StitchDraft = makeDraft()) => store().open({ nodeId: "s1", draft, canvasGeneration: 3 });
const mute = (clipId: string) => (d: StitchDraft) => ({ ...d, timeline: updateClipAudio(d.timeline, clipId, { muted: true }) });
const setLoop = (loopCount: 1 | 2 | 3) => (d: StitchDraft) => ({ ...d, loopCount });

describe("stitchEditorStore", () => {
  beforeEach(() => {
    store().close();
    store().setSnap(true);
    store().setSoundOn(true);
  });

  it("seeds the initial draft, the draft and the first clip's selection on open", () => {
    const draft = makeDraft();
    openOn(draft);
    const s = store();
    expect(s.isOpen).toBe(true);
    expect(s.nodeId).toBe("s1");
    expect(s.canvasGeneration).toBe(3);
    expect(s.initial).toBe(draft);
    expect(s.draft).toBe(draft);
    expect(s.selection).toEqual({ kind: "clip", clipId: "a" });
    expect(s.past).toEqual([]);
    expect(s.future).toEqual([]);
    expect(s.playhead).toBe(0);
    expect(s.pxPerSec).toBeNull();
    expect(s.discardOpen).toBe(false);
    expect(s.pickerOpen).toBe(false);
  });

  it("selects nothing when the sequence is empty", () => {
    openOn(makeDraft({ timeline: [] }));
    expect(store().selection).toBeNull();
  });

  it("pushes a step for a change and none for a no-op or an equal copy", () => {
    openOn();
    store().apply(mute("a"));
    expect(store().past).toHaveLength(1);
    expect(store().draft!.timeline[0].muted).toBe(true);

    store().apply((d) => d);
    store().apply((d) => ({ ...d, timeline: [...d.timeline] }));
    store().apply(setLoop(1));
    expect(store().past).toHaveLength(1);
  });

  it("forgets a selected point when another gesture changes the curve", () => {
    openOn(makeDraft({ audioCurve: [{ t: 0, gain: 1 }, { t: 4, gain: 0.5 }] }));
    store().select({ kind: "audio", point: 1 });
    store().apply(setLoop(2));
    expect(store().selection).toEqual({ kind: "audio", point: 1 });
    store().apply((d) => ({ ...d, audioCurve: addPoint(d.audioCurve, 2, 0.2).curve }));
    expect(store().selection).toEqual({ kind: "audio", point: null });
  });

  it("forgets a selected point on undo and on redo", () => {
    openOn(makeDraft({ audioCurve: [{ t: 0, gain: 1 }] }));
    store().apply((d) => ({ ...d, audioCurve: flat() }));
    store().select({ kind: "audio", point: 0 });
    store().undo();
    expect(store().selection).toEqual({ kind: "audio", point: null });
    store().select({ kind: "audio", point: 0 });
    store().redo();
    expect(store().selection).toEqual({ kind: "audio", point: null });
  });

  it("coalesces a gesture into one step, and endGesture starts a new one", () => {
    openOn();
    const volume = (v: number) => (d: StitchDraft) => ({ ...d, timeline: updateClipAudio(d.timeline, "a", { volume: v }) });
    store().apply(volume(0.9), { gestureKey: "volume:a" });
    store().apply(volume(0.8), { gestureKey: "volume:a" });
    store().apply(volume(0.7), { gestureKey: "volume:a" });
    expect(store().past).toHaveLength(1);
    expect(store().draft!.timeline[0].volume).toBe(0.7);

    store().endGesture();
    store().apply(volume(0.6), { gestureKey: "volume:a" });
    expect(store().past).toHaveLength(2);

    store().undo();
    expect(store().draft!.timeline[0].volume).toBe(0.7);
    store().undo();
    expect(store().draft!.timeline[0].volume).toBe(1);
  });

  it("starts a new step after an undo in the middle of a gesture, so the next tick can be undone", () => {
    openOn();
    const volume = (v: number) => (d: StitchDraft) => ({ ...d, timeline: updateClipAudio(d.timeline, "a", { volume: v }) });
    store().apply(volume(0.9), { gestureKey: "volume:a" });
    store().apply(volume(0.8), { gestureKey: "volume:a" });
    // ⌘Z while the slider is still held, then its next tick
    store().undo();
    store().apply(volume(0.7), { gestureKey: "volume:a" });
    expect(store().past).toHaveLength(1);
    store().undo();
    expect(store().draft!.timeline[0].volume).toBe(1);
  });

  it("round-trips undo and redo, and a new change clears what could be redone", () => {
    const draft = makeDraft();
    openOn(draft);
    store().apply(mute("a"));
    const muted = store().draft;
    store().apply(setLoop(3));

    store().undo();
    expect(store().draft).toBe(muted);
    store().undo();
    expect(store().draft).toBe(draft);
    expect(selectCanUndo(store())).toBe(false);
    expect(selectCanRedo(store())).toBe(true);

    store().redo();
    expect(store().draft).toBe(muted);
    store().apply(mute("b"));
    expect(selectCanRedo(store())).toBe(false);
    expect(store().future).toEqual([]);
  });

  it("keeps at most STITCH_HISTORY_LIMIT steps", () => {
    openOn();
    for (let i = 0; i < STITCH_HISTORY_LIMIT + 20; i++) {
      store().apply((d) => ({ ...d, audioCurve: [{ t: i + 1, gain: 1 }] }));
    }
    expect(store().past).toHaveLength(STITCH_HISTORY_LIMIT);
    // The oldest steps are the ones dropped
    expect(store().past[0].audioCurve[0].t).toBe(20);
    expect(store().past.at(-1)!.audioCurve[0].t).toBe(STITCH_HISTORY_LIMIT + 19);
    store().undo();
    expect(store().draft!.audioCurve[0].t).toBe(STITCH_HISTORY_LIMIT + 19);
    // Redo at the cap keeps the newest steps too
    store().redo();
    expect(store().draft!.audioCurve[0].t).toBe(STITCH_HISTORY_LIMIT + 20);
    expect(store().past).toHaveLength(STITCH_HISTORY_LIMIT);
    expect(store().past[0].audioCurve[0].t).toBe(20);
  });

  it("is not dirty once undone back to the draft it opened with", () => {
    openOn();
    expect(selectIsDirty(store())).toBe(false);
    store().apply(mute("a"));
    expect(selectIsDirty(store())).toBe(true);
    store().undo();
    expect(selectIsDirty(store())).toBe(false);
  });

  it("drops a clip selection whose clip an undo or redo takes away", () => {
    openOn(makeDraft({ timeline: [clipA] }));
    store().apply((d) => ({ ...d, timeline: [...d.timeline, clipB] }));
    store().select({ kind: "clip", clipId: "b" });
    store().undo();
    expect(store().selection).toBeNull();

    store().redo();
    store().select({ kind: "clip", clipId: "b" });
    store().apply((d) => ({ ...d, timeline: removeClip(d.timeline, "a").timeline }));
    store().select({ kind: "clip", clipId: "b" });
    store().undo();
    expect(store().selection).toEqual({ kind: "clip", clipId: "b" });
    store().select({ kind: "clip", clipId: "a" });
    store().redo();
    expect(store().selection).toBeNull();
  });

  it("resets on close but keeps snap and sound", () => {
    openOn();
    store().apply(mute("a"));
    store().setSnap(false);
    store().setSoundOn(false);
    store().setPlayhead(4);
    store().setZoom(120);
    store().setDiscardOpen(true);
    store().close();
    const s = store();
    expect(s.isOpen).toBe(false);
    expect(s.nodeId).toBeNull();
    expect(s.draft).toBeNull();
    expect(s.initial).toBeNull();
    expect(s.past).toEqual([]);
    expect(s.playhead).toBe(0);
    expect(s.pxPerSec).toBeNull();
    expect(s.discardOpen).toBe(false);
    expect(s.snap).toBe(false);
    expect(s.soundOn).toBe(false);
  });

  it("clamps the playhead at 0", () => {
    openOn();
    store().setPlayhead(-2);
    expect(store().playhead).toBe(0);
  });
});

describe("stitchEditorStore: the sequence layout", () => {
  // a: 5 s; b: 6 s from 1 s, so 5 s. Track 0–5, 5–10; Stacked at 1.0 s 0–5, 4–9
  const DURATIONS = new Map<SourceKey, number>([
    ["edge:e1", 5],
    ["asset:x", 6],
  ]);
  const layout = () => store().draft!.sequenceLayout;

  beforeEach(() => {
    store().close();
    openOn();
    store().setDurations(DURATIONS);
  });

  it("makes each setter one undo step", () => {
    setSequenceMode("stacked");
    expect(store().past).toHaveLength(1);
    setOverlapSec(2);
    expect(store().past).toHaveLength(2);
    setCrossfade(false);
    expect(store().past).toHaveLength(3);
    expect(layout()).toEqual({ mode: "stacked", overlapSec: 2, crossfade: false });
    store().undo();
    expect(layout()).toEqual({ mode: "stacked", overlapSec: 2, crossfade: true });
    store().undo();
    store().undo();
    expect(layout()).toEqual(TRACK_LAYOUT);
  });

  it("takes no step for an overlap that is already stored, rounded or clamped", () => {
    setOverlapSec(1);
    setOverlapSec(1.04);
    expect(store().past).toHaveLength(0);
    setOverlapSec(12);
    expect(layout().overlapSec).toBe(10);
    setOverlapSec(11);
    expect(store().past).toHaveLength(1);
  });

  it("keeps the overlap and the crossfade when switching back to Track", () => {
    setSequenceMode("stacked");
    setOverlapSec(2.5);
    setCrossfade(false);
    setSequenceMode("track");
    expect(layout()).toEqual({ mode: "track", overlapSec: 2.5, crossfade: false });
  });

  it("moves a fade out with the end in the same step, and undo puts both back", () => {
    store().apply((d) => ({ ...d, audioCurve: fadeOut(d.audioCurve, 10) }));
    const steps = store().past.length;
    setSequenceMode("stacked");
    expect(store().past).toHaveLength(steps + 1);
    expect(store().draft!.audioCurve).toEqual([
      { t: 8, gain: 1 },
      { t: 9, gain: 0 },
    ]);
    store().undo();
    expect(layout().mode).toBe("track");
    expect(store().draft!.audioCurve).toEqual([
      { t: 9, gain: 1 },
      { t: 10, gain: 0 },
    ]);
  });

  it("keeps the playhead on the same frame of the same clip", () => {
    // 2 s into b
    store().setPlayhead(7);
    setSequenceMode("stacked");
    expect(store().playhead).toBe(6);
    setOverlapSec(2);
    expect(store().playhead).toBe(5);
    setSequenceMode("track");
    expect(store().playhead).toBe(7);
    // Undo leaves it where it is
    store().undo();
    expect(store().playhead).toBe(7);
  });

  it("makes a run of Overlap nudges one step, until the gesture ends", () => {
    setSequenceMode("stacked");
    const steps = store().past.length;
    setOverlapSec(1.1, { gesture: true });
    setOverlapSec(1.2, { gesture: true });
    setOverlapSec(1.3, { gesture: true });
    expect(store().past).toHaveLength(steps + 1);
    expect(layout().overlapSec).toBe(1.3);
    store().endGesture();
    setOverlapSec(1.4, { gesture: true });
    expect(store().past).toHaveLength(steps + 2);
    store().undo();
    store().undo();
    expect(layout().overlapSec).toBe(1);
  });
});

describe("stitchEditorStore: placing clips in Stacked", () => {
  // a: 5 s; b: 6 s from 1 s, so 5 s; c: 4 s. Lined up at 1.0 s: a 0–5, b 4–9, c 8–12
  const DURATIONS = new Map<SourceKey, number>([
    ["edge:e1", 5],
    ["asset:x", 6],
    ["edge:e2", 4],
  ]);
  const STACKED = { mode: "stacked", overlapSec: 1, crossfade: true } as const;
  const clipC = createClip({ kind: "edge", edgeId: "e2" }, { id: "c" });

  const spans = () => draftSpans(store().draft!, store().durations);
  const starts = () => spans().map((span) => span.start);
  const ids = () => store().draft!.timeline.map((clip) => clip.id);
  const stored = () => Object.fromEntries(store().draft!.timeline.map((clip) => [clip.id, clip.startSec]));
  const steps = () => store().past.length;
  const selectClip = (clipId: string) => store().select({ kind: "clip", clipId });
  const openStack = (timeline: StitchTimelineClip[] = [clipA, clipB, clipC], layout: StitchDraft["sequenceLayout"] = STACKED) => {
    store().close();
    openOn(makeDraft({ timeline, sequenceLayout: layout }));
    store().setDurations(DURATIONS);
  };
  /** Each clip's share of the picture at t, the pieces of a split counted as the clip they came from. */
  const weightsById = (t: number, pieceOf: Record<string, string> = {}) => {
    const all = spans();
    const env = spansEnvelope(all, store().draft!.sequenceLayout.crossfade);
    const out: Record<string, number> = {};
    for (const layer of envelopeAt(env, t)) {
      const id = all[env.units[layer.unit].row].clip.id;
      const key = pieceOf[id] ?? id;
      out[key] = (out[key] ?? 0) + layer.weight;
    }
    return out;
  };

  beforeEach(() => {
    openStack();
    liveFitZoom.set(null);
  });

  it("sets a start in one step that pins every clip, and takes no step for an unchanged start", () => {
    setClipStart("b", 4);
    expect(steps()).toBe(0);
    expect(stored()).toEqual({ a: undefined, b: undefined, c: undefined });

    setClipStart("b", 6);
    expect(steps()).toBe(1);
    expect(stored()).toEqual({ a: 0, b: 6, c: 8 });
    expect(starts()).toEqual([0, 6, 8]);
    setClipStart("b", 6);
    setClipStart("a", 0);
    expect(steps()).toBe(1);

    setClipStart("b", 700);
    expect(stored().b).toBe(600);
    setClipStart("b", -3);
    expect(stored().b).toBe(0);
    store().undo();
    store().undo();
    store().undo();
    expect(stored()).toEqual({ a: undefined, b: undefined, c: undefined });
  });

  it("does nothing to a start in Track", () => {
    openStack(undefined, TRACK_LAYOUT);
    selectClip("b");
    setClipStart("b", 6);
    nudgeSelectedClip(1, false, false);
    startSelectedAtPlayhead();
    moveSelectedRow(-1);
    expect(steps()).toBe(0);
    expect(nudgeStartWell(1, false)).toBeNull();
  });

  it("nudges a frame per press, each press one step, a held key's repeats joining it", () => {
    selectClip("b");
    nudgeSelectedClip(1, false, false);
    nudgeSelectedClip(1, false, false);
    nudgeSelectedClip(1, false, false);
    expect(steps()).toBe(3);
    expect(spans()[1].start).toBeCloseTo(4 + 3 / 60, 9);

    nudgeSelectedClip(1, false, false);
    nudgeSelectedClip(1, false, true);
    nudgeSelectedClip(1, false, true);
    expect(steps()).toBe(4);
    expect(spans()[1].start).toBeCloseTo(4 + 6 / 60, 9);

    nudgeSelectedClip(-1, true, false);
    expect(steps()).toBe(5);
    expect(spans()[1].start).toBeCloseTo(4 - 4 / 60, 9);
    expect(stored().a).toBe(0);
    expect(stored().c).toBe(8);
  });

  it("steps the Start well by 0.1 s, one undo step until it is left, and ⇧ by 1 s", () => {
    selectClip("b");
    expect(nudgeStartWell(1, false)).toBeCloseTo(4.1, 9);
    expect(nudgeStartWell(1, false)).toBeCloseTo(4.2, 9);
    expect(nudgeStartWell(1, false)).toBeCloseTo(4.3, 9);
    expect(steps()).toBe(1);
    store().endGesture();
    expect(nudgeStartWell(1, true)).toBeCloseTo(5.3, 9);
    expect(steps()).toBe(2);
    // At 0:00 nothing moves
    setClipStart("b", 0);
    store().endGesture();
    expect(nudgeStartWell(-1, false)).toBeNull();
  });

  it("moves a row with ⌥↑: a placed stack keeps every start, a lined-up one re-sequences", () => {
    selectClip("c");
    expect(canMoveRow(store(), 1)).toBe(false);
    expect(canMoveRow(store(), -1)).toBe(true);
    moveSelectedRow(-1);
    expect(ids()).toEqual(["a", "c", "b"]);
    expect(stored()).toEqual({ a: undefined, b: undefined, c: undefined });
    // c 4–8, then b 7–12
    expect(starts()).toEqual([0, 4, 7]);

    openStack();
    setClipStart("c", 10);
    selectClip("c");
    moveSelectedRow(-1);
    expect(steps()).toBe(2);
    expect(ids()).toEqual(["a", "c", "b"]);
    expect(starts()).toEqual([0, 10, 4]);
    selectClip("a");
    expect(canMoveRow(store(), -1)).toBe(false);
  });

  it("applies a body drag as one step: the new start and row together, every clip pinned, nothing re-sequenced", () => {
    const drawn = placeClip(store().draft!.timeline, DURATIONS, "c", 3, 0, 1);
    moveClipBody("c", drawn);
    expect(steps()).toBe(1);
    expect(ids()).toEqual(["c", "a", "b"]);
    expect(stored()).toEqual({ c: 3, a: 0, b: 4 });
    expect(store().draft!.timeline).toBe(drawn);
    store().undo();
    expect(ids()).toEqual(["a", "b", "c"]);
    expect(stored()).toEqual({ a: undefined, b: undefined, c: undefined });
    // A drag back to where it began writes nothing
    moveClipBody("c", store().draft!.timeline);
    expect(steps()).toBe(0);
  });

  it("puts the start or the end at the playhead with [ and ]", () => {
    selectClip("b");
    store().setPlayhead(2);
    startSelectedAtPlayhead();
    expect(spans()[1].start).toBe(2);
    store().setPlayhead(10);
    endSelectedAtPlayhead();
    expect(spans()[1].start).toBe(5);
    expect(steps()).toBe(2);
    // b lasts 5 s: it cannot end at 3 s
    store().setPlayhead(3);
    expect(canEndAtPlayhead(store())).toBe(false);
    endSelectedAtPlayhead();
    expect(steps()).toBe(2);
  });

  it("lines up the clips in one step: starts dropped, an end fade moved, the playhead on the same frame", () => {
    expect(canLineUp(store())).toBe(false);
    setClipStart("c", 9);
    expect(canLineUp(store())).toBe(true);
    store().apply((d) => ({ ...d, audioCurve: fadeOut(d.audioCurve, 13) }));
    selectClip("c");
    store().setPlayhead(10);
    const before = steps();

    lineUpClips();
    expect(steps()).toBe(before + 1);
    expect(stored()).toEqual({ a: undefined, b: undefined, c: undefined });
    expect(starts()).toEqual([0, 4, 8]);
    expect(store().draft!.audioCurve.at(-1)).toEqual({ t: 12, gain: 0 });
    expect(store().playhead).toBe(9);

    store().undo();
    expect(stored()).toEqual({ a: 0, b: 4, c: 9 });
  });

  it("trims in place in Stacked: every trim pins, the frames stay where they were", () => {
    selectClip("b");
    trimSelected({ inSec: 2 });
    expect(steps()).toBe(1);
    // b's frames stay put: In +1 s, start +1 s; c does not ripple to 7
    expect(stored()).toEqual({ a: 0, b: 5, c: 8 });
    trimSelected({ outSec: 5 });
    expect(spans()[1]).toMatchObject({ start: 5, end: 8 });

    store().setPlayhead(6);
    setEdgeAtPlayheadForSelection("in");
    expect(store().draft!.timeline[1]).toMatchObject({ inSec: 3, startSec: 6 });
    store().setPlayhead(7);
    setEdgeAtPlayheadForSelection("out");
    expect(store().draft!.timeline[1]).toMatchObject({ inSec: 3, outSec: 4, startSec: 6 });
    expect(stored().c).toBe(8);
  });

  it("resets a trim in place, the start back by the old In and never before 0:00", () => {
    selectClip("b");
    resetSelectedTrim();
    expect(store().draft!.timeline[1]).toMatchObject({ inSec: 0, outSec: null, startSec: 3 });
    trimSelected({ inSec: 2 });
    setClipStart("b", 1);
    resetSelectedTrim();
    expect(store().draft!.timeline[1]).toMatchObject({ inSec: 0, startSec: 0 });
  });

  it("removes a clip from a placed stack without moving the others; a lined-up one closes up", () => {
    selectClip("a");
    removeSelection();
    expect(starts()).toEqual([0, 4]);

    openStack();
    setClipStart("c", 10);
    selectClip("a");
    removeSelection();
    expect(ids()).toEqual(["b", "c"]);
    expect(starts()).toEqual([4, 10]);
  });

  it("refuses a split inside a lined-up overlap, with commit 9's reason", () => {
    store().setPlayhead(4.5);
    expect(splitBlockedReason(store())).toBe("Move the playhead out of the overlap to split");
    expect(canSplitAtPlayhead(store())).toBe(false);
    splitAtPlayhead();
    expect(steps()).toBe(0);
  });

  it.each([true, false])("splits a placed clip inside an overlap and changes no weight (Crossfade %s)", (crossfade) => {
    setCrossfade(crossfade);
    setClipStart("c", 7);
    selectClip("b");
    store().setPlayhead(8);
    expect(splitBlockedReason(store())).toBeNull();
    expect(canSplitAtPlayhead(store())).toBe(true);
    const instants = Array.from({ length: 50 }, (_, i) => (i * 11) / 50 + 0.013);
    const before = instants.map((t) => weightsById(t));
    const stepsBefore = steps();

    splitAtPlayhead();
    expect(steps()).toBe(stepsBefore + 1);
    const timeline = store().draft!.timeline;
    expect(timeline).toHaveLength(4);
    const right = timeline[2];
    expect(right.startSec).toBe(8);
    expect(store().selection).toEqual({ kind: "clip", clipId: right.id });
    const after = instants.map((t) => weightsById(t, { [right.id]: "b" }));
    after.forEach((weights, i) => {
      for (const id of new Set([...Object.keys(weights), ...Object.keys(before[i])])) {
        expect(weights[id] ?? 0).toBeCloseTo(before[i][id] ?? 0, 9);
      }
    });
  });

  it("adds library clips to a placed stack unpinned, Overlap before the latest end, with the playhead there", () => {
    setClipStart("c", 10);
    addAssetClips([{ id: "n1", durationSec: 3 }] as AssetView[]);
    const added = store().draft!.timeline[3];
    expect(added.startSec).toBeUndefined();
    // c ends at 14
    expect(store().playhead).toBe(13);
  });

  it("changes Overlap in a placed stack without moving any clip, in one step", () => {
    setClipStart("c", 10);
    addAssetClips([{ id: "n1", durationSec: 3 }, { id: "n2", durationSec: 2 }] as AssetView[]);
    store().setDurations(
      new Map<SourceKey, number>([...DURATIONS, ["asset:n1", 3], ["asset:n2", 2]]),
    );
    const was = starts();
    expect(was).toEqual([0, 4, 10, 13, 15]);
    const before = steps();
    setOverlapSec(2);
    expect(steps()).toBe(before + 1);
    expect(starts()).toEqual(was);
    expect(store().draft!.sequenceLayout.overlapSec).toBe(2);
    expect(Object.values(stored())).toEqual([0, 4, 10, 13, 15]);
    store().undo();
    expect(store().draft!.timeline[3].startSec).toBeUndefined();
  });

  it("leaves a stored start alone in Track trims and through layout switches", () => {
    const placedB = { ...clipB, startSec: 6 };
    openStack([clipA, placedB, clipC], TRACK_LAYOUT);
    selectClip("b");
    trimSelected({ inSec: 2 });
    expect(store().draft!.timeline[1]).toMatchObject({ inSec: 2, startSec: 6 });
    setSequenceMode("stacked");
    expect(stored()).toEqual({ a: undefined, b: 6, c: undefined });
    setCrossfade(false);
    setSequenceMode("track");
    expect(stored()).toEqual({ a: undefined, b: 6, c: undefined });
  });

  it("keeps the zoom in Fit when a move lengthens the sequence, and not otherwise", () => {
    liveFitZoom.set(40);
    setClipStart("b", 5);
    expect(store().pxPerSec).toBeNull();
    setClipStart("c", 10);
    expect(store().pxPerSec).toBe(40);

    store().setZoom(null);
    const drawn = placeClip(store().draft!.timeline, DURATIONS, "c", 12, 2, 1);
    moveClipBody("c", drawn);
    expect(store().pxPerSec).toBe(40);

    // A chosen zoom stays as it is
    store().setZoom(80);
    setClipStart("c", 20);
    expect(store().pxPerSec).toBe(80);
  });
});
