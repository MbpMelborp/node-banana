import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { draftSpans, type StitchDraft } from "@/lib/stitch/draft";
import { WAITING_FOR_CLIPS } from "@/lib/stitch/libraryInsert";
import { DEFAULT_SEQUENCE_LAYOUT } from "@/lib/stitch/stack";
import { clipSpans, createClip, splitClipAt, type SourceKey } from "@/lib/stitch/timeline";
import { normalizeWarp, withWarp } from "@/lib/stitch/warp";
import type { ClipWarp, ClipWarpCurve, StitchTimelineClip } from "@/types";
import {
  canSetSpeed,
  focusSpeedWell,
  moveClipSpeed,
  nudgeClipSpeed,
  resetSelectedSpeed,
  setClipBlend,
  setClipCurve,
  setClipReverse,
  setClipSpeed,
  setSelectedClipsReverse,
  setSelectedClipsSpeed,
  speedGestureKey,
  speedWaitsReason,
  toggleSelectedReverse,
} from "../speedActions";

const { show } = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock("@/components/Toast", () => ({ useToast: { getState: () => ({ show }) } }));

// The speed actions against the real editor store: one undo step per edit, the clamps, Stacked's pin and its wait.

const editor = () => useStitchEditorStore.getState();
const edgeClip = (id: string, edgeId: string, init: Partial<StitchTimelineClip> = {}) =>
  createClip({ kind: "edge", edgeId }, { id, ...init });
const W = (speed: number, extra: Partial<ClipWarp> = {}): ClipWarp => ({
  speed,
  curve: null,
  reverse: false,
  blend: false,
  ...extra,
});
const QUAD: ClipWarpCurve = { kind: "preset", name: "easeInQuad" };
const retimed = (clip: StitchTimelineClip, warp: ClipWarp) => withWarp(clip, normalizeWarp(warp));

// a 10 s, b 5 s, c a 0.3 s source, d 120 s, e 900 s
const DURATIONS = new Map<SourceKey, number>([
  ["edge:e1", 10],
  ["edge:e2", 5],
  ["edge:e3", 0.3],
  ["edge:e4", 120],
  ["edge:e5", 900],
]);
const STACKED = { mode: "stacked", overlapSec: 1, crossfade: true } as const;

function open(timeline: StitchTimelineClip[], { stacked = false }: { stacked?: boolean } = {}) {
  const draft: StitchDraft = {
    timeline,
    audioClips: [],
    legacyAudio: { curve: [], muted: false },
    loopCount: 1,
    sequenceLayout: stacked ? STACKED : DEFAULT_SEQUENCE_LAYOUT,
  };
  editor().close();
  editor().open({ nodeId: "n1", draft, canvasGeneration: 1 });
  editor().setDurations(DURATIONS);
}

const clip = (id: string) => editor().draft!.timeline.find((c) => c.id === id)!;
const steps = () => editor().past.length;
const select = (...clipIds: string[]) =>
  editor().select({ kind: "clip", clipId: clipIds[0], ...(clipIds.length > 1 ? { clipIds } : {}) });
const startOf = (id: string) => draftSpans(editor().draft!, editor().durations).find((s) => s.clip.id === id)!.start;

beforeEach(() => {
  show.mockClear();
  open([edgeClip("a", "e1"), edgeClip("b", "e2")]);
});
afterEach(() => {
  editor().close();
  vi.restoreAllMocks();
});

describe("setting a clip's speed", () => {
  it("stores the speed in one step, and nothing again for the same speed (A-1)", () => {
    setClipSpeed("a", 2);
    expect(clip("a").warp).toEqual({ speed: 2, curve: null, reverse: false, blend: false });
    expect(steps()).toBe(1);
    setClipSpeed("a", 2);
    expect(steps()).toBe(1);
  });

  it("removes the warp at 1× forward with no ramp (A-2)", () => {
    setClipSpeed("a", 2);
    setClipSpeed("a", 1);
    expect("warp" in clip("a")).toBe(false);
    expect(steps()).toBe(2);
  });

  it("clamps to the clip's limits and rounds to three figures (A-3)", () => {
    open([edgeClip("a", "e1"), edgeClip("c", "e3"), edgeClip("d", "e4")]);
    setClipSpeed("c", 10);
    expect(clip("c").warp?.speed).toBe(3);
    setClipSpeed("d", 0.1);
    expect(clip("d").warp?.speed).toBe(0.2);
    setClipSpeed("a", 1.234);
    expect(clip("a").warp?.speed).toBe(1.23);
  });

  it("makes a slider's ticks one step until the gesture ends (A-4)", () => {
    const gestureKey = speedGestureKey(["a"]);
    setClipSpeed("a", 2, { gestureKey });
    setClipSpeed("a", 4, { gestureKey });
    expect(steps()).toBe(1);
    editor().endGesture();
    setClipSpeed("a", 0.5, { gestureKey });
    expect(steps()).toBe(2);
    expect(clip("a").warp?.speed).toBe(0.5);
  });

  it("carries a drag's Blend across 1×, where the warp itself goes", () => {
    open([retimed(edgeClip("a", "e1"), W(0.5, { blend: true }))]);
    const gestureKey = speedGestureKey(["a"]);
    setClipSpeed("a", 1, { gestureKey, blend: true });
    expect("warp" in clip("a")).toBe(false);
    setClipSpeed("a", 0.5, { gestureKey, blend: true });
    expect(clip("a").warp).toEqual(W(0.5, { blend: true }));
    expect(steps()).toBe(1);
  });
});

describe("a clip's ramp, Reverse and Blend", () => {
  it("a new ramp keeps the speed, Reverse and Blend; none at 1× forward removes the warp (A-5)", () => {
    open([retimed(edgeClip("a", "e1"), W(2, { reverse: true, blend: true })), edgeClip("b", "e2")]);
    setClipCurve("a", QUAD);
    expect(clip("a").warp).toEqual(W(2, { curve: QUAD, reverse: true, blend: true }));
    setClipCurve("b", QUAD);
    setClipCurve("b", null);
    expect("warp" in clip("b")).toBe(false);
    expect(steps()).toBe(3);
  });

  it("a split piece's own preset again drops its window, in one step (A-6)", () => {
    open([retimed(edgeClip("a", "e1"), W(1.5, { curve: QUAD, window: [0.3, 1] }))]);
    setClipCurve("a", QUAD);
    expect(clip("a").warp).toEqual(W(1.5, { curve: QUAD }));
    expect("window" in clip("a").warp!).toBe(false);
    expect(steps()).toBe(1);
  });

  it("Reverse and Blend are one step each, and change no length", () => {
    setClipReverse("a", true);
    expect(clip("a").warp).toEqual(W(1, { reverse: true }));
    expect(startOf("b")).toBe(10);
    setClipBlend("a", true);
    // Blend alone at 1× changes nothing, so it is kept with the reverse
    expect(clip("a").warp).toEqual(W(1, { reverse: true, blend: true }));
    setClipReverse("a", false);
    expect("warp" in clip("a")).toBe(false);
    expect(steps()).toBe(3);
  });
});

describe("several clips", () => {
  it("Reset speed sets 1× with no ramp and keeps Reverse; a long source's least speed is 1 (A-7)", () => {
    open([retimed(edgeClip("a", "e1"), W(2, { curve: QUAD, reverse: true })), edgeClip("e", "e5")]);
    select("a");
    resetSelectedSpeed();
    expect(clip("a").warp).toEqual(W(1, { reverse: true }));
    select("e");
    setClipSpeed("e", 0.5);
    expect("warp" in clip("e")).toBe(false);
    setClipSpeed("e", 2);
    resetSelectedSpeed();
    expect("warp" in clip("e")).toBe(false);
  });

  it("Reset speed and 1× reach 1× on a clip holding under 0.1 s of source, and never slow one (A-7)", () => {
    // Each holds 0.05 s: t slowed to 0.5×, its least length at that speed, and s unwarped
    open([retimed(edgeClip("t", "e1", { outSec: 0.05 }), W(0.5)), edgeClip("s", "e1", { inSec: 9.95 })]);
    select("t");
    resetSelectedSpeed();
    expect("warp" in clip("t")).toBe(false);
    expect(steps()).toBe(1);
    setClipSpeed("t", 0.5);
    select("t", "s");
    setSelectedClipsSpeed(1);
    expect(["t", "s"].map((id) => "warp" in clip(id))).toEqual([false, false]);
    setClipSpeed("t", 0.5);
    resetSelectedSpeed();
    expect(["t", "s"].map((id) => "warp" in clip(id))).toEqual([false, false]);
  });

  it("acts on every selected clip in one step, each within its own limits (A-8)", () => {
    open([edgeClip("a", "e1"), edgeClip("c", "e3"), edgeClip("d", "e4")]);
    select("a", "c", "d");
    setSelectedClipsSpeed(5);
    expect(["a", "c", "d"].map((id) => clip(id).warp?.speed)).toEqual([5, 3, 5]);
    expect(steps()).toBe(1);
    setSelectedClipsReverse(true);
    expect(["a", "c", "d"].every((id) => clip(id).warp?.reverse)).toBe(true);
    expect(steps()).toBe(2);
    // The menu's toggle: all reversed, so all forward
    toggleSelectedReverse();
    expect(["a", "c", "d"].some((id) => clip(id).warp?.reverse)).toBe(false);
    expect(steps()).toBe(3);
    toggleSelectedReverse();
    expect(["a", "c", "d"].every((id) => clip(id).warp?.reverse)).toBe(true);
    resetSelectedSpeed();
    expect(["a", "c", "d"].map((id) => clip(id).warp)).toEqual([W(1, { reverse: true }), W(1, { reverse: true }), W(1, { reverse: true })]);
  });
});

describe("Stacked", () => {
  it("a speed change pins every clip first, so nothing else moves; Track ripples (A-9)", () => {
    open([edgeClip("a", "e1"), edgeClip("b", "e2")], { stacked: true });
    expect(startOf("b")).toBe(9);
    setClipSpeed("a", 2);
    expect(editor().draft!.timeline.map((c) => c.startSec)).toEqual([0, 9]);
    expect(startOf("a")).toBe(0);
    expect(startOf("b")).toBe(9);
    expect(steps()).toBe(1);

    open([edgeClip("a", "e1"), edgeClip("b", "e2")]);
    expect(startOf("b")).toBe(10);
    setClipSpeed("a", 2);
    expect(editor().draft!.timeline.some((c) => c.startSec !== undefined)).toBe(false);
    expect(startOf("b")).toBe(5);
  });

  it("Reverse and a ramp in a lined-up stack pin nothing", () => {
    open([edgeClip("a", "e1"), edgeClip("b", "e2")], { stacked: true });
    setClipReverse("a", true);
    setClipCurve("a", QUAD);
    expect(editor().draft!.timeline.some((c) => c.startSec !== undefined)).toBe(false);
    expect(steps()).toBe(2);
  });

  it("waits while a pin would read lengths still loading, as Paste does", () => {
    open([edgeClip("a", "e1"), edgeClip("b", "e2")], { stacked: true });
    editor().setClipsLoading(new Set<SourceKey>(["edge:e2"]));
    expect(speedWaitsReason(editor())).toBe(WAITING_FOR_CLIPS);
    setClipSpeed("a", 2);
    expect(steps()).toBe(0);
    expect(show).toHaveBeenCalledWith(WAITING_FOR_CLIPS, "info");
    setClipReverse("a", true);
    expect(clip("a").warp?.reverse).toBe(true);
    // A placed stack pins nothing more, so it never waits
    open([edgeClip("a", "e1", { startSec: 0 }), edgeClip("b", "e2", { startSec: 4 })], { stacked: true });
    editor().setClipsLoading(new Set<SourceKey>(["edge:e2"]));
    expect(speedWaitsReason(editor())).toBeNull();
    setClipSpeed("a", 2);
    expect(clip("a").warp?.speed).toBe(2);
  });

  it("canSetSpeed: every length known and no wait", () => {
    open([edgeClip("a", "e1"), edgeClip("u", "e9")], { stacked: true });
    expect(canSetSpeed(editor(), ["a"])).toBe(true);
    expect(canSetSpeed(editor(), ["u"])).toBe(false);
    expect(canSetSpeed(editor(), ["a", "u"])).toBe(false);
    expect(canSetSpeed(editor(), [])).toBe(false);
    editor().setClipsLoading(new Set<SourceKey>(["edge:e1"]));
    expect(canSetSpeed(editor(), ["a"])).toBe(false);
  });
});

describe("nudgeClipSpeed and moveClipSpeed", () => {
  it("steps the slider's scale, a run one undo step, and returns the speed stored", () => {
    expect(nudgeClipSpeed("a", 1, false)).toBe(1.05);
    expect(nudgeClipSpeed("a", 1, false)).toBe(1.1);
    expect(steps()).toBe(1);
    editor().endGesture();
    expect(nudgeClipSpeed("a", -1, false)).toBe(1.05);
    expect(steps()).toBe(2);
  });

  it("returns null and makes no step at a limit", () => {
    open([edgeClip("c", "e3")]);
    setClipSpeed("c", 3);
    expect(nudgeClipSpeed("c", 1, false)).toBeNull();
    expect(steps()).toBe(1);
    expect(nudgeClipSpeed("x", 1, false)).toBeNull();
  });

  it("never steps a stored piece's speed against its key", () => {
    open([retimed(edgeClip("a", "e1"), W(0.04, { curve: QUAD, window: [0, 0.2] }))]);
    expect(nudgeClipSpeed("a", -1, false)).toBeNull();
    expect(clip("a").warp?.speed).toBe(0.04);
    expect(steps()).toBe(0);
    expect(nudgeClipSpeed("a", 1, false)).toBe(0.105);
  });

  it("never steps a piece just over its own rounded limit back across it, nor moves the slider so", () => {
    // The right piece of a 1.7× ease-in cut 0.10001 s before its end: 5.0138× over 0.5014 s of source, whose most is
    // 5.01×, so ↑ would clamp it down
    const ramp = retimed(edgeClip("a", "e1"), W(1.7, { curve: { kind: "preset", name: "easeInCubic" } }));
    const end = clipSpans([ramp], DURATIONS, 0)[0].end;
    open(splitClipAt([ramp], DURATIONS, end - 0.10001, () => "b")!.timeline);
    const from = clip("b").warp!.speed;
    expect(from).toBeGreaterThan(5.01);
    expect(nudgeClipSpeed("b", 1, false)).toBeNull();
    expect(moveClipSpeed("b", 10, 1)).toBeNull();
    expect(clip("b").warp?.speed).toBe(from);
    expect(steps()).toBe(0);
    expect(nudgeClipSpeed("b", -1, false)).toBeLessThan(from);
    expect(steps()).toBe(1);
  });
});

describe("focusSpeedWell", () => {
  it("focuses the well of the focused panel's rail one frame later", async () => {
    const panel = document.createElement("div");
    panel.setAttribute("data-stitch-editor", "");
    panel.tabIndex = -1;
    panel.innerHTML = '<aside aria-label="Clip"><input type="text" aria-label="Speed" /></aside>';
    document.body.append(panel);
    try {
      panel.focus();
      focusSpeedWell();
      const well = panel.querySelector("input")!;
      expect(document.activeElement).toBe(panel);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(document.activeElement).toBe(well);
    } finally {
      panel.remove();
    }
  });
});
