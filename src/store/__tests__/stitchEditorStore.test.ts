import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  STITCH_HISTORY_LIMIT,
  selectCanRedo,
  selectCanUndo,
  selectIsDirty,
  useStitchEditorStore,
} from "@/store/stitchEditorStore";
import type { StitchDraft } from "@/lib/stitch/draft";
import { createClip, removeClip, updateClipAudio, type SourceKey } from "@/lib/stitch/timeline";
import { addPoint, fadeOut, flat } from "@/lib/stitch/curve";
import { DEFAULT_SEQUENCE_LAYOUT as TRACK_LAYOUT } from "@/lib/stitch/stack";
import { setCrossfade, setOverlapSec, setSequenceMode } from "@/components/stitch/editorActions";

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
