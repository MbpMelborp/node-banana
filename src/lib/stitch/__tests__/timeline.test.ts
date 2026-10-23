import { describe, it, expect } from "vitest";
import type { ClipWarp, StitchSequenceLayout, StitchTimelineClip } from "@/types";
import { sanitizeTimeline } from "../migrate";
import { resolveStarts } from "../placement";
import { FRAME_RATE, planSequence } from "../sequencePlan";
import { joinOverlaps } from "../stack";
import {
  END_EPSILON_SEC,
  MIN_CLIP_SEC,
  appendClips,
  canResetTrim,
  canSplitClipsAt,
  clampTrim,
  clearStarts,
  clipAtTime,
  clipLength,
  clipSourceOut,
  clipSpans,
  createClip,
  edgeAtPlayheadPatch,
  edgeIdsInOrder,
  inOverlap,
  isPlaced,
  isTrimmed,
  layersAt,
  layoutSpans,
  MAX_START_SEC,
  moveClip,
  moveClipsBlock,
  moveClipStart,
  neighbourTarget,
  originalEdgeTarget,
  pinStarts,
  placeClip,
  placeClips,
  placedLayersAt,
  placedSpans,
  reanchorTime,
  removeClip,
  removeClips,
  resetTrim,
  resetTrimInPlace,
  resetTrims,
  runEndIndex,
  sequenceDuration,
  setEdgeAtPlayhead,
  shiftRows,
  snapTo,
  sourceKey,
  sourceTimeAt,
  spanAtTime,
  spansAt,
  spansEnd,
  spansEnvelope,
  spanWarpMap,
  splitClipAt,
  splitClipsAt,
  speedLimits,
  splitRefusal,
  topSpanAt,
  trimClip,
  trimClipInPlace,
  updateClipAudio,
  updateClipsAudio,
  updateClipsWarp,
  type ClipSpan,
  type SourceDurations,
  type SourceKey,
} from "../timeline";
import { activeWarp, normalizeWarp, withWarp } from "../warp";

const edgeClip = (id: string, edgeId: string, init: Partial<StitchTimelineClip> = {}) =>
  createClip({ kind: "edge", edgeId }, { id, ...init });
const assetClip = (id: string, assetId: string) => createClip({ kind: "asset", assetId }, { id });

function durations(entries: Record<string, number>): SourceDurations {
  return new Map(Object.entries(entries) as [SourceKey, number][]);
}

// Three clips of 5, 4 and 6 seconds: spans 0–5, 5–9, 9–15.
const three = () => [edgeClip("a", "e1"), edgeClip("b", "e2"), edgeClip("c", "e3")];
const threeDurations = durations({ "edge:e1": 5, "edge:e2": 4, "edge:e3": 6 });

const W = (speed: number, extra: Partial<ClipWarp> = {}): ClipWarp => ({
  speed,
  curve: null,
  reverse: false,
  blend: false,
  ...extra,
});
/** Source progress = output progress², in closed form. */
const QUAD = { kind: "preset", name: "easeInQuad" } as const;
const OUT_QUAD = { kind: "preset", name: "easeOutQuad" } as const;
/** In memory only: a warp that changes nothing, which every path must read as none. It is never stored. */
const IDENTITY: ClipWarp = { speed: 1, curve: null, reverse: false, blend: true };
/** A retime as an edit writes it. */
const retimed = (clip: StitchTimelineClip, warp: ClipWarp) => withWarp(clip, normalizeWarp(warp));

// Seeded: the placement simulations' LCG.
function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

describe("sourceKey and createClip", () => {
  it("keys edge and asset sources apart", () => {
    expect(sourceKey({ kind: "edge", edgeId: "e1" })).toBe("edge:e1");
    expect(sourceKey({ kind: "asset", assetId: "x" })).toBe("asset:x");
  });

  it("defaults to the whole source, unmuted, at full volume, with a generated id", () => {
    const clip = createClip({ kind: "edge", edgeId: "e1" });
    expect(clip).toMatchObject({ inSec: 0, outSec: null, muted: false, volume: 1 });
    expect(clip.id).toMatch(/^clip_[0-9a-f]{8}$/);
  });

  it("keeps a warp as given, last, and adds no key without one", () => {
    const warp = { speed: 2, curve: null, reverse: true, blend: false };
    const clip = createClip({ kind: "edge", edgeId: "e1" }, { id: "a", startSec: 3, warp });
    expect(clip.warp).toBe(warp);
    expect(Object.keys(clip)).toEqual(["id", "source", "inSec", "outSec", "muted", "volume", "startSec", "warp"]);
    expect(Object.keys(createClip({ kind: "edge", edgeId: "e1" }, { id: "b" }))).toEqual([
      "id",
      "source",
      "inSec",
      "outSec",
      "muted",
      "volume",
    ]);
  });
});

describe("clipLength", () => {
  it("is 0 while the source duration is unknown", () => {
    expect(clipLength(edgeClip("a", "e1"), undefined)).toBe(0);
  });

  it("runs to the source's end when out is null", () => {
    expect(clipLength(edgeClip("a", "e1", { inSec: 1 }), 5)).toBe(4);
  });

  it("clamps an out past the source's end", () => {
    expect(clipLength(edgeClip("a", "e1", { inSec: 1, outSec: 9 }), 5)).toBe(4);
  });

  it("is 0 when in is past the source's end", () => {
    expect(clipLength(edgeClip("a", "e1", { inSec: 7 }), 5)).toBe(0);
  });

  it("is 0 under one output frame, as the encode drops such a clip, and keeps a clip of exactly one frame", () => {
    const shortened = edgeClip("a", "e1", { inSec: 4.99 });
    expect(clipLength(shortened, 5)).toBe(0);
    expect(planSequence([{ inSec: 4.99, outSec: null, sourceDuration: 5 }]).clips).toEqual([]);
    expect(clipLength(edgeClip("b", "e2"), 1 / 60)).toBe(1 / 60);
    expect(planSequence([{ inSec: 0, outSec: null, sourceDuration: 1 / 60 }]).clips).toHaveLength(1);
  });

  it("agrees with the encode under a warp: the same length, and a clip sped under one frame dropped by both", () => {
    const fast = retimed(edgeClip("a", "e1", { inSec: 4.98 }), W(2));
    expect(clipLength(fast, 5)).toBe(0);
    expect(planSequence([{ inSec: 4.98, outSec: null, sourceDuration: 5, warp: activeWarp(fast)! }]).clips).toEqual([]);
    for (const warp of [W(2), W(0.5, { curve: QUAD }), W(1.5, { reverse: true })]) {
      const clip = retimed(edgeClip("b", "e2", { inSec: 1, outSec: 3.5 }), warp);
      const [planned] = planSequence([{ inSec: 1, outSec: 3.5, sourceDuration: 5, warp: activeWarp(clip)! }]).clips;
      expect(planned.length).toBe(clipLength(clip, 5));
    }
  });
});

describe("sequenceDuration and clipSpans", () => {
  it("sums the trimmed lengths", () => {
    const timeline = [edgeClip("a", "e1", { inSec: 1 }), edgeClip("b", "e2", { outSec: 2 }), edgeClip("c", "e3")];
    expect(sequenceDuration(timeline, threeDurations, 0)).toBe(4 + 2 + 6);
  });

  it("keeps zero-length spans in place", () => {
    const spans = clipSpans([edgeClip("a", "e1"), edgeClip("x", "missing"), edgeClip("c", "e3")], threeDurations, 0);
    expect(spans.map((s) => [s.start, s.end])).toEqual([[0, 5], [5, 5], [5, 11]]);
  });
});

describe("spanAtTime", () => {
  it("reads precomputed spans the way clipAtTime reads a timeline", () => {
    const spans = clipSpans(three(), threeDurations, 0);
    for (const t of [-1, 0, 4.99, 5, 9.5, 15, 99]) {
      expect(spanAtTime(spans, t)?.clip.id).toBe(clipAtTime(three(), threeDurations, t, 0)?.clip.id);
    }
    expect(spanAtTime(clipSpans([edgeClip("x", "missing")], threeDurations, 0), 0)).toBeNull();
  });
});

describe("clipAtTime", () => {
  it("returns the next clip at a boundary", () => {
    expect(clipAtTime(three(), threeDurations, 5, 0)?.clip.id).toBe("b");
  });

  it("skips zero-length spans", () => {
    const timeline = [edgeClip("a", "e1"), edgeClip("x", "missing"), edgeClip("c", "e3")];
    expect(clipAtTime(timeline, threeDurations, 5, 0)?.clip.id).toBe("c");
  });

  it("gives the last clip at or past the end and the first before the start", () => {
    expect(clipAtTime(three(), threeDurations, 15, 0)?.clip.id).toBe("c");
    expect(clipAtTime(three(), threeDurations, 99, 0)?.clip.id).toBe("c");
    // An empty span at either end (a source not generated yet) is never the answer
    expect(clipAtTime([edgeClip("a", "e1"), edgeClip("x", "missing")], threeDurations, 99, 0)?.clip.id).toBe("a");
    expect(clipAtTime([edgeClip("x", "missing"), edgeClip("c", "e3")], threeDurations, -1, 0)?.clip.id).toBe("c");
    expect(clipAtTime(three(), threeDurations, -1, 0)?.clip.id).toBe("a");
  });

  it("is null for an empty timeline or one with only empty clips", () => {
    expect(clipAtTime([], threeDurations, 0, 0)).toBeNull();
    expect(clipAtTime([edgeClip("x", "missing")], threeDurations, 0, 0)).toBeNull();
  });
});

describe("clampTrim", () => {
  const clip = edgeClip("a", "e1");

  it("keeps In at least MIN before Out", () => {
    expect(clampTrim({ ...clip, outSec: 3 }, 5, { inSec: 4 })).toEqual({ inSec: 3 - MIN_CLIP_SEC, outSec: 3 });
  });

  it("keeps Out at least MIN after In and within the source", () => {
    expect(clampTrim({ ...clip, inSec: 2 }, 5, { outSec: 1 })).toEqual({ inSec: 2, outSec: 2 + MIN_CLIP_SEC });
    expect(clampTrim(clip, 5, { outSec: 7 })).toEqual({ inSec: 0, outSec: null });
  });

  it("stores an Out within EPS of the end as null", () => {
    expect(clampTrim(clip, 5, { outSec: 5 - END_EPSILON_SEC / 2 })).toEqual({ inSec: 0, outSec: null });
    expect(clampTrim(clip, 5, { outSec: 4.9 })).toEqual({ inSec: 0, outSec: 4.9 });
  });

  it("treats outSec null as the end and clamps a negative In", () => {
    expect(clampTrim({ ...clip, outSec: 3 }, 5, { outSec: null })).toEqual({ inSec: 0, outSec: null });
    expect(clampTrim(clip, 5, { inSec: -2 })).toEqual({ inSec: 0, outSec: null });
  });

  it("works without a known duration", () => {
    expect(clampTrim(clip, undefined, { inSec: 3 })).toEqual({ inSec: 3, outSec: null });
    expect(clampTrim({ ...clip, inSec: 2 }, undefined, { outSec: 1 })).toEqual({ inSec: 2, outSec: 2 + MIN_CLIP_SEC });
    expect(clampTrim({ ...clip, outSec: 2 }, undefined, { inSec: 5 })).toEqual({ inSec: 2 - MIN_CLIP_SEC, outSec: 2 });
  });

  it("gives the whole source when it is shorter than MIN", () => {
    expect(clampTrim({ ...clip, inSec: 0.02 }, MIN_CLIP_SEC / 2, { outSec: 0.03 })).toEqual({ inSec: 0, outSec: null });
  });
});

describe("timeline operations", () => {
  it("trimClip clamps and returns the same reference when nothing changes", () => {
    const timeline = three();
    const trimmed = trimClip(timeline, "b", threeDurations, { inSec: 1 });
    expect(trimmed).not.toBe(timeline);
    expect(trimmed[1]).toMatchObject({ inSec: 1, outSec: null });
    expect(trimClip(timeline, "b", threeDurations, { inSec: 0 })).toBe(timeline);
    expect(trimClip(timeline, "nope", threeDurations, { inSec: 1 })).toBe(timeline);
  });

  it("resetTrim clears In and Out", () => {
    const timeline = [edgeClip("a", "e1", { inSec: 1, outSec: 3 })];
    expect(resetTrim(timeline, "a")[0]).toMatchObject({ inSec: 0, outSec: null });
    const untouched = three();
    expect(resetTrim(untouched, "a")).toBe(untouched);
  });

  it("updateClipAudio sets mute and clamps volume", () => {
    const timeline = three();
    expect(updateClipAudio(timeline, "a", { muted: true, volume: 3 })[0]).toMatchObject({ muted: true, volume: 1 });
    expect(updateClipAudio(timeline, "a", { volume: -1 })[0].volume).toBe(0);
    expect(updateClipAudio(timeline, "a", { muted: false, volume: 1 })).toBe(timeline);
  });

  it("moveClip puts the clip at its final index", () => {
    const timeline = three();
    expect(moveClip(timeline, 0, 2).map((c) => c.id)).toEqual(["b", "c", "a"]);
    expect(moveClip(timeline, 2, 0).map((c) => c.id)).toEqual(["c", "a", "b"]);
    expect(moveClip(timeline, 1, 1)).toBe(timeline);
    expect(moveClip(timeline, 5, 0)).toBe(timeline);
    // Pointer maths on a zero-width lane gives NaN; nothing moves.
    expect(moveClip(timeline, 1, NaN)).toBe(timeline);
    expect(moveClip(timeline, NaN, 0)).toBe(timeline);
    expect(moveClip(timeline, 0, Infinity)).toBe(timeline);
  });

  it("removeClip reports an orphaned edge only when no piece of it is left", () => {
    const timeline = [edgeClip("a", "e1"), edgeClip("a2", "e1"), edgeClip("b", "e2"), assetClip("x", "asset1")];
    const first = removeClip(timeline, "a");
    expect(first.timeline.map((c) => c.id)).toEqual(["a2", "b", "x"]);
    expect(first.orphanedEdgeId).toBeNull();
    expect(removeClip(first.timeline, "a2").orphanedEdgeId).toBe("e1");
    expect(removeClip(timeline, "x").orphanedEdgeId).toBeNull();
    expect(removeClip(timeline, "nope").timeline).toBe(timeline);
  });

  it("appendClips adds at the end", () => {
    const timeline = three();
    expect(appendClips(timeline, [assetClip("x", "asset1")]).map((c) => c.id)).toEqual(["a", "b", "c", "x"]);
    expect(appendClips(timeline, [])).toBe(timeline);
  });

  it("edgeIdsInOrder lists each edge once, by first appearance", () => {
    const timeline = [edgeClip("b", "e2"), assetClip("x", "asset1"), edgeClip("a", "e1"), edgeClip("b2", "e2")];
    expect(edgeIdsInOrder(timeline)).toEqual(["e2", "e1"]);
  });
});

describe("splitClipAt", () => {
  it("cuts the clip under t into two pieces", () => {
    const timeline = [edgeClip("a", "e1"), edgeClip("b", "e2", { inSec: 0.5, outSec: 3.5, muted: true, volume: 0.4 })];
    const result = splitClipAt(timeline, threeDurations, 6, () => "new");
    expect(result).not.toBeNull();
    expect(result!.leftId).toBe("b");
    expect(result!.rightId).toBe("new");
    expect(result!.timeline.map((c) => c.id)).toEqual(["a", "b", "new"]);
    expect(result!.timeline[1]).toMatchObject({ inSec: 0.5, outSec: 1.5, muted: true, volume: 0.4 });
    expect(result!.timeline[2]).toMatchObject({ inSec: 1.5, outSec: 3.5, muted: true, volume: 0.4 });
  });

  it("keeps null as the right piece's Out", () => {
    const result = splitClipAt(three(), threeDurations, 2, () => "new");
    expect(result!.timeline[1]).toMatchObject({ id: "new", inSec: 2, outSec: null });
  });

  it("refuses within MIN of an edge and in an empty timeline", () => {
    expect(splitClipAt(three(), threeDurations, 5 + MIN_CLIP_SEC / 2)).toBeNull();
    expect(splitClipAt(three(), threeDurations, 5 - MIN_CLIP_SEC / 2)).toBeNull();
    expect(splitClipAt([edgeClip("x", "missing")], threeDurations, 0)).toBeNull();
  });

  it("refuses a time that is not finite", () => {
    expect(splitClipAt(three(), threeDurations, NaN)).toBeNull();
    expect(splitClipAt(three(), threeDurations, Infinity)).toBeNull();
  });
});

describe("setEdgeAtPlayhead", () => {
  it("sets In or Out to the source time under the playhead", () => {
    const timeline = three();
    const withIn = setEdgeAtPlayhead(timeline, threeDurations, "b", "in", 6, 0);
    expect(withIn).not.toBe(timeline);
    expect(withIn![1]).toMatchObject({ inSec: 1, outSec: null });
    const withOut = setEdgeAtPlayhead(timeline, threeDurations, "b", "out", 7, 0);
    expect(withOut![1]).toMatchObject({ inSec: 0, outSec: 2 });
  });

  it("is null when the playhead is outside the clip", () => {
    expect(setEdgeAtPlayhead(three(), threeDurations, "b", "in", 12, 0)).toBeNull();
    expect(setEdgeAtPlayhead(three(), threeDurations, "missing", "in", 6, 0)).toBeNull();
    expect(setEdgeAtPlayhead(three(), threeDurations, "b", "in", NaN, 0)).toBeNull();
    expect(setEdgeAtPlayhead(three(), threeDurations, "b", "out", Infinity, 0)).toBeNull();
  });

  it("is null for Out at the clip's start and In at its end", () => {
    expect(setEdgeAtPlayhead(three(), threeDurations, "b", "out", 5, 0)).toBeNull();
    expect(setEdgeAtPlayhead(three(), threeDurations, "b", "in", 9, 0)).toBeNull();
    // The near boundary still counts
    expect(setEdgeAtPlayhead(three(), threeDurations, "b", "out", 9, 0)![1]).toMatchObject({ inSec: 0 });
    expect(setEdgeAtPlayhead(three(), threeDurations, "b", "in", 5, 0)![1]).toMatchObject({ inSec: 0 });
  });
});

describe("snapTo", () => {
  const playhead = { t: 4, kind: "playhead" as const, label: "the playhead" };
  const edge = { t: 5, kind: "edge" as const, label: "Clip 2" };

  it("snaps inside the threshold, inclusively", () => {
    expect(snapTo(4.1, [playhead], 0.1)).toEqual({ value: 4, target: playhead });
    // Exactly at the threshold (0.5 is exact in floating point)
    expect(snapTo(4.5, [playhead], 0.5)).toEqual({ value: 4, target: playhead });
  });

  it("leaves the value alone outside it", () => {
    expect(snapTo(4.3, [playhead], 0.1)).toEqual({ value: 4.3, target: null });
  });

  it("picks the nearest of two", () => {
    expect(snapTo(4.8, [playhead, edge], 1).target).toBe(edge);
  });

  it("gives a tie to the playhead", () => {
    expect(snapTo(4.5, [edge, playhead], 1).target).toBe(playhead);
  });
});

describe("neighbourTarget", () => {
  it("gives the next clip's start for an Out and the previous clip's end for an In", () => {
    const spans = clipSpans(three(), threeDurations, 0);
    expect(neighbourTarget(spans, "a", "out")).toEqual({ t: 5, kind: "edge", label: "Clip 2" });
    expect(neighbourTarget(spans, "c", "in")).toEqual({ t: 9, kind: "edge", label: "Clip 2" });
  });

  it("is null at the sequence's ends", () => {
    const spans = clipSpans(three(), threeDurations, 0);
    expect(neighbourTarget(spans, "c", "out")).toBeNull();
    expect(neighbourTarget(spans, "a", "in")).toBeNull();
  });

  it("skips empty clips", () => {
    const spans = clipSpans([edgeClip("a", "e1"), edgeClip("x", "missing"), edgeClip("c", "e3")], threeDurations, 0);
    expect(neighbourTarget(spans, "a", "out")).toEqual({ t: 5, kind: "edge", label: "Clip 3" });
    expect(neighbourTarget(spans, "c", "in")).toEqual({ t: 5, kind: "edge", label: "Clip 1" });
  });
});

describe("Stacked: overlapped spans", () => {
  // Clips of 5, 5 and 6 s at a 1 s overlap: 0–5, 4–9, 8–14
  const stackDurations = durations({ "edge:e1": 5, "edge:e2": 5, "edge:e3": 6 });
  const stacked = () => clipSpans(three(), stackDurations, 1);
  const butted = () => clipSpans(three(), stackDurations, 0);
  const ids = (spans: readonly ClipSpan[]) => spans.map((s) => s.clip.id);

  it("starts each clip the overlap before the previous one ends", () => {
    const spans = stacked();
    expect(spans.map((s) => [s.start, s.end])).toEqual([
      [0, 5],
      [4, 9],
      [8, 14],
    ]);
    expect(spans.map((s) => [s.overlapIn, s.overlapOut])).toEqual([
      [0, 1],
      [1, 1],
      [1, 0],
    ]);
    expect(sequenceDuration(three(), stackDurations, 1)).toBe(14);
    expect(sequenceDuration([], stackDurations, 1)).toBe(0);
  });

  it("overlaps the clips either side of an empty one", () => {
    const timeline = [edgeClip("a", "e1"), edgeClip("x", "missing"), edgeClip("b", "e2")];
    const spans = clipSpans(timeline, stackDurations, 1);
    expect(spans.map((s) => [s.start, s.end, s.overlapIn, s.overlapOut])).toEqual([
      [0, 5, 0, 1],
      [5, 5, 0, 0],
      [4, 9, 1, 0],
    ]);
  });

  it("gives today's spans with no overlap, and for a call without one", () => {
    const twoArgs = clipSpans as unknown as (t: StitchTimelineClip[], d: SourceDurations) => ClipSpan[];
    expect(twoArgs(three(), threeDurations)).toEqual(clipSpans(three(), threeDurations, 0));
    expect(butted().map((s) => [s.start, s.end, s.overlapIn, s.overlapOut])).toEqual([
      [0, 5, 0, 0],
      [5, 10, 0, 0],
      [10, 16, 0, 0],
    ]);
  });

  it("finds the clips at an instant, earlier first, and the one the editor means", () => {
    const spans = stacked();
    expect(ids(spansAt(spans, 4.5))).toEqual(["a", "b"]);
    expect(ids(spansAt(spans, 3))).toEqual(["a"]);
    expect(spansAt(spans, 14)).toEqual([]);
    expect(topSpanAt(spans, 4.5)?.clip.id).toBe("a");
    expect(topSpanAt(spans, 4.5, "b")?.clip.id).toBe("b");
    expect(topSpanAt(spans, 4.5, "c")?.clip.id).toBe("a");
    expect(topSpanAt(spans, 6, "a")?.clip.id).toBe("b");
    expect(topSpanAt(spans, 99)?.clip.id).toBe("c");
    expect(inOverlap(spans, 4.5)).toBe(true);
    expect(inOverlap(spans, 6)).toBe(false);
    expect(clipAtTime(three(), stackDurations, 4.5, 1, "b")?.clip.id).toBe("b");
    expect(clipAtTime(three(), stackDurations, 4.5, 1)?.clip.id).toBe("a");
  });

  it("layers the preview", () => {
    const one = layersAt(butted(), 6, true);
    expect(one.map((l) => [l.span.clip.id, l.opacity, l.gain])).toEqual([["b", 1, 1]]);

    const p = 0.25;
    const fade = layersAt(stacked(), 4 + p, true);
    expect(fade.map((l) => l.span.clip.id)).toEqual(["a", "b"]);
    expect(fade[0].opacity).toBe(1);
    expect(fade[0].gain).toBeCloseTo(Math.cos((p * Math.PI) / 2), 12);
    expect(fade[1].opacity).toBeCloseTo(p, 12);
    expect(fade[1].gain).toBeCloseTo(Math.sin((p * Math.PI) / 2), 12);

    const cut = layersAt(stacked(), 4 + p, false);
    expect(cut.map((l) => [l.span.clip.id, l.opacity, l.gain])).toEqual([
      ["a", 1, 1],
      ["b", 0, 1],
    ]);

    expect(layersAt(clipSpans([edgeClip("x", "missing")], stackDurations, 1), 0, true)).toEqual([]);
  });

  it("re-anchors a time on the same clip and frame", () => {
    expect(reanchorTime(butted(), stacked(), 6)).toBe(5);
    expect(reanchorTime(stacked(), butted(), 5)).toBe(6);
    expect(reanchorTime(butted(), stacked(), 16)).toBe(14);
    expect(reanchorTime(butted(), stacked(), 99)).toBe(14);
    expect(reanchorTime(stacked(), butted(), 4.5)).toBe(4.5);
    expect(reanchorTime(stacked(), butted(), 4.5, "b")).toBe(5.5);
  });

  it("splits only outside an overlap, and moves nothing", () => {
    const opts = { overlapSec: 1 };
    expect(splitClipAt(three(), stackDurations, 4.5, () => "new", opts)).toBeNull();
    expect(splitClipAt(three(), stackDurations, 4.5, () => "new", { ...opts, preferClipId: "b" })).toBeNull();
    expect(splitClipAt(three(), stackDurations, 5 + MIN_CLIP_SEC / 2, () => "new", opts)).toBeNull();
    expect(splitClipAt(three(), stackDurations, 8 - MIN_CLIP_SEC / 2, () => "new", opts)).toBeNull();

    const result = splitClipAt(three(), stackDurations, 6, () => "new", { ...opts, preferClipId: "a" });
    expect(result!.leftId).toBe("b");
    expect(result!.timeline[1]).toMatchObject({ id: "b", inSec: 0, outSec: 2 });
    expect(result!.timeline[2]).toMatchObject({ id: "new", inSec: 2, outSec: null });
    const after = clipSpans(result!.timeline, stackDurations, 1);
    expect(after.map((s) => s.start)).toEqual([0, 4, 6, 8]);
    expect(sequenceDuration(result!.timeline, stackDurations, 1)).toBe(14);
  });

  it("sets an edge at a playhead inside the clip's overlapped span", () => {
    expect(setEdgeAtPlayhead(three(), stackDurations, "b", "in", 4.5, 0)).toBeNull();
    expect(setEdgeAtPlayhead(three(), stackDurations, "b", "in", 4.5, 1)![1]).toMatchObject({ inSec: 0.5 });
  });

  it("offers the dragged edge's own start as a snap target", () => {
    const b = stacked()[1];
    expect(originalEdgeTarget(b, "out")).toEqual({ t: 9, kind: "edge", label: "the original length" });
    expect(originalEdgeTarget(b, "in")).toEqual({ t: 4, kind: "edge", label: "the original length" });
  });
});

describe("Stacked: placed clips", () => {
  // A 5 s, B 5 s, C 6 s; lined up at Overlap 1: 0–5, 4–9, 8–14
  const d = durations({ "edge:e1": 5, "edge:e2": 5, "edge:e3": 6 });
  const STACKED = { mode: "stacked" as const, overlapSec: 1, crossfade: true };
  const TRACK = { ...STACKED, mode: "track" as const };
  const lined = () => [edgeClip("a", "e1"), edgeClip("b", "e2"), edgeClip("c", "e3")];
  const starts = (spans: readonly ClipSpan[]) => spans.map((s) => s.start);

  it("lays out Track, lined-up and placed stacks", () => {
    const placed = [edgeClip("a", "e1", { startSec: 2 }), edgeClip("b", "e2"), edgeClip("c", "e3", { startSec: 0 })];
    expect(starts(layoutSpans(placed, d, TRACK))).toEqual([0, 5, 10]);
    expect(layoutSpans(lined(), d, STACKED)).toEqual(clipSpans(lined(), d, 1));
    const spans = layoutSpans(placed, d, STACKED);
    expect(spans).toEqual(placedSpans(placed, d, 1));
    expect(starts(spans)).toEqual([2, 6, 0]);
    expect(spans.every((s) => s.overlapIn === 0 && s.overlapOut === 0)).toBe(true);
    expect(isPlaced(placed)).toBe(true);
    expect(isPlaced(lined())).toBe(false);
  });

  it("measures the loop to the latest end of a clip with frames", () => {
    const timeline = [edgeClip("a", "e1", { startSec: 0 }), edgeClip("x", "missing", { startSec: 20 })];
    const spans = layoutSpans(timeline, d, STACKED);
    expect(spansEnd(spans)).toBe(5);
    expect(topSpanAt(spans, 7)?.clip.id).toBe("a");
    expect(spansEnd([])).toBe(0);
    expect(sequenceDuration(lined(), d, 1)).toBe(14);
    // Out of order in rows: the latest end, not the last span's
    expect(spansEnd(placedSpans([edgeClip("a", "e1", { startSec: 9 }), edgeClip("b", "e2", { startSec: 0 })], d, 1))).toBe(14);
  });

  it("finds no clip in a gap, and the clip that ends last past the end", () => {
    const timeline = [edgeClip("a", "e1", { startSec: 2 }), edgeClip("b", "e2", { startSec: 8 })];
    const spans = layoutSpans(timeline, d, STACKED);
    expect(topSpanAt(spans, 7.5)).toBeNull();
    expect(topSpanAt(spans, 1)).toBeNull();
    expect(topSpanAt(spans, 13)?.clip.id).toBe("b");
    expect(topSpanAt(spans, 20)?.clip.id).toBe("b");
    expect(topSpanAt(spans, -1)?.clip.id).toBe("a");
    // The top row is in front where two play
    const over = layoutSpans([edgeClip("a", "e1", { startSec: 6 }), edgeClip("b", "e2", { startSec: 4 })], d, STACKED);
    expect(topSpanAt(over, 7)?.clip.id).toBe("a");
    expect(topSpanAt(over, 7, "b")?.clip.id).toBe("b");
    // Rows out of time order: the latest-ending span past the end
    const late = layoutSpans([edgeClip("a", "e1", { startSec: 2 }), edgeClip("x", "missing", { startSec: 30 }), edgeClip("b", "e2", { startSec: 0 })], d, STACKED);
    expect(topSpanAt(late, 7)?.clip.id).toBe("a");
  });

  it("re-anchors a time in a gap where it is, clamped to the new end", () => {
    const before = layoutSpans([edgeClip("a", "e1", { startSec: 0 }), edgeClip("b", "e2", { startSec: 8 })], d, STACKED);
    const after = layoutSpans([edgeClip("a", "e1", { startSec: 0 }), edgeClip("b", "e2", { startSec: 1 })], d, STACKED);
    expect(reanchorTime(before, before, 6.5)).toBe(6.5);
    expect(reanchorTime(before, after, 6.5)).toBe(6);
    expect(reanchorTime(before, after, 9)).toBe(2);
  });

  it("builds one envelope per spans array and flag", () => {
    const timeline = [edgeClip("a", "e1", { startSec: 0, inSec: 1 }), edgeClip("x", "missing"), edgeClip("b", "e2", { startSec: 4 })];
    const spans = layoutSpans(timeline, durations({ "edge:e1": 6, "edge:e2": 5 }), STACKED);
    const env = spansEnvelope(spans, true);
    expect(env.units).toEqual([
      { start: 0, length: 5, row: 0, source: "edge:e1", inSec: 1 },
      { start: 4, length: 5, row: 2, source: "edge:e2", inSec: 0 },
    ]);
    expect(spansEnvelope(spans, true)).toBe(env);
    expect(spansEnvelope(spans, false)).not.toBe(env);
    expect(spansEnvelope(spans, false).crossfade).toBe(false);
    expect(spansEnvelope([...spans], true)).not.toBe(env);
  });

  it("pins every start as drawn", () => {
    const pinned = pinStarts(lined(), d, 1);
    expect(pinned.map((c) => c.startSec)).toEqual([0, 4, 8]);
    expect(pinStarts(pinned, d, 1)).toBe(pinned);
    const mixed = [edgeClip("a", "e1", { startSec: 3 }), edgeClip("b", "e2"), edgeClip("c", "e3", { startSec: 0 })];
    const resolved = pinStarts(mixed, d, 1);
    expect(resolved.map((c) => c.startSec)).toEqual([3, 7, 0]);
    expect(resolved[0]).toBe(mixed[0]);
  });

  it("clears every start", () => {
    const pinned = pinStarts(lined(), d, 1);
    const cleared = clearStarts(pinned);
    expect(cleared.some((c) => "startSec" in c)).toBe(false);
    expect(cleared).toEqual(lined());
    const none = lined();
    expect(clearStarts(none)).toBe(none);
  });

  it("moves one clip's start, pinning the rest", () => {
    const timeline = lined();
    const moved = moveClipStart(timeline, d, "b", 6.5, 1);
    expect(moved.map((c) => c.startSec)).toEqual([0, 6.5, 8]);
    expect(moveClipStart(timeline, d, "b", -2, 1)[1].startSec).toBe(0);
    expect(moveClipStart(timeline, d, "b", 900, 1)[1].startSec).toBe(MAX_START_SEC);
    expect(moveClipStart(timeline, d, "b", 4, 1)).toBe(timeline);
    expect(moveClipStart(moved, d, "b", 6.5, 1)).toBe(moved);
    expect(moveClipStart(timeline, d, "missing", 3, 1)).toBe(timeline);
    expect(moveClipStart(timeline, d, "b", Number.NaN, 1)).toBe(timeline);
  });

  it("places a clip in time and row in one result", () => {
    const timeline = lined();
    const placed = placeClip(timeline, d, "c", 2, 0, 1);
    expect(placed.map((c) => [c.id, c.startSec])).toEqual([
      ["c", 2],
      ["a", 0],
      ["b", 4],
    ]);
    // A row change alone pins and keeps every start: a lined-up stack does not re-sequence
    const rowOnly = placeClip(timeline, d, "a", 0, 2, 1);
    expect(rowOnly.map((c) => [c.id, c.startSec])).toEqual([
      ["b", 4],
      ["c", 8],
      ["a", 0],
    ]);
    expect(placeClip(timeline, d, "c", 8, 2, 1)).toBe(timeline);
    expect(placeClip(timeline, d, "c", 8, 9, 1)).toBe(timeline);
    expect(placeClip(timeline, d, "missing", 8, 0, 1)).toBe(timeline);
  });

  it("trims with the frames fixed in time", () => {
    const timeline = lined();
    const later = trimClipInPlace(timeline, "b", d, { inSec: 1 }, 1);
    expect(later[1]).toMatchObject({ inSec: 1, startSec: 5 });
    expect(later[0].startSec).toBe(0);
    expect(later[2].startSec).toBe(8);
    const out = trimClipInPlace(timeline, "b", d, { outSec: 3 }, 1);
    expect(out[1]).toMatchObject({ outSec: 3, startSec: 4 });
    // The In stops where the clip would start before 0:00
    const atZero = [edgeClip("a", "e1", { startSec: 0.5, inSec: 2 })];
    expect(trimClipInPlace(atZero, "a", d, { inSec: 0 }, 1)[0]).toMatchObject({ inSec: 1.5, startSec: 0 });
    expect(trimClipInPlace(timeline, "b", d, { inSec: 0 }, 1)).toBe(timeline);
    expect(trimClipInPlace(timeline, "missing", d, { inSec: 1 }, 1)).toBe(timeline);
  });

  it("resets a trim, moving the start back by the In, clamped at 0:00", () => {
    const timeline = [edgeClip("a", "e1", { startSec: 3, inSec: 1, outSec: 4 }), edgeClip("b", "e2", { startSec: 0.5, inSec: 0.8 })];
    const reset = resetTrimInPlace(timeline, "a", d, 1);
    expect(reset[0]).toMatchObject({ startSec: 2, inSec: 0, outSec: null });
    expect(resetTrimInPlace(timeline, "b", d, 1)[1]).toMatchObject({ startSec: 0, inSec: 0, outSec: null });
    expect(resetTrimInPlace(reset, "a", d, 1)).toBe(reset);
  });

  it("splits a placed clip anywhere but a gap, the right piece in the next row at the playhead", () => {
    const timeline = [edgeClip("a", "e1", { startSec: 0 }), edgeClip("b", "e2", { startSec: 4 }), edgeClip("c", "e3", { startSec: 12 })];
    const result = splitClipAt(timeline, d, 4.5, () => "new", { layout: STACKED });
    expect(result!.timeline.map((c) => [c.id, c.startSec, c.inSec, c.outSec])).toEqual([
      ["a", 0, 0, 4.5],
      ["new", 4.5, 4.5, null],
      ["b", 4, 0, null],
      ["c", 12, 0, null],
    ]);
    expect(splitClipAt(timeline, d, 4.5, () => "new", { layout: STACKED, preferClipId: "b" })!.timeline[2]).toMatchObject({
      id: "new",
      startSec: 4.5,
      inSec: 0.5,
    });
    expect(splitClipAt(timeline, d, 10, () => "new", { layout: STACKED })).toBeNull();
    expect(splitClipAt(timeline, d, MIN_CLIP_SEC / 2, () => "new", { layout: STACKED })).toBeNull();
    expect(splitClipAt(timeline, d, 9 - MIN_CLIP_SEC / 2, () => "new", { layout: STACKED, preferClipId: "b" })).toBeNull();
    // Lined up keeps commit 9's refusal inside an overlap
    expect(splitClipAt(lined(), d, 4.5, () => "new", { layout: STACKED })).toBeNull();
  });

  it("splits a placed clip in Track where its frames were", () => {
    const timeline = [edgeClip("a", "e1", { startSec: 7, inSec: 0.5 }), edgeClip("b", "e2")];
    const result = splitClipAt(timeline, d, 2, () => "new", { layout: TRACK });
    expect(result!.timeline[1]).toMatchObject({ id: "new", inSec: 2.5, startSec: 9 });
    expect(result!.timeline[0]).toMatchObject({ id: "a", startSec: 7, outSec: 2.5 });
  });

  it("layers the placed preview", () => {
    const timeline = [edgeClip("a", "e1", { startSec: 0 }), edgeClip("b", "e2", { startSec: 4 }), edgeClip("c", "e3", { startSec: 10 })];
    const spans = layoutSpans(timeline, d, STACKED);
    // In row order, the stage's DOM order: a (row 0, in front, fading out) holds 0.75 of the picture, b 0.25
    const fade = placedLayersAt(spans, 4.25, true);
    expect(fade.map((l) => l.span.clip.id)).toEqual(["a", "b"]);
    expect(fade[0].opacity).toBe(1);
    expect(fade[1].opacity).toBeCloseTo(0.25, 9);
    expect(fade[0].gain).toBeCloseTo(Math.cos((0.25 * Math.PI) / 2), 9);
    expect(placedLayersAt(spans, 9.5, true)).toEqual([]);
    const end = placedLayersAt(spans, 99, true);
    expect(end.map((l) => [l.span.clip.id, l.opacity, l.gain])).toEqual([["c", 1, 1]]);
    expect(placedLayersAt(spans, 4.25, false).map((l) => [l.span.clip.id, l.opacity, l.gain])).toEqual([
      ["a", 1, 1],
      ["b", 0, 1],
    ]);
  });

  it("holds the frame across a placed gap under a slot, as the encode does", () => {
    const timeline = [edgeClip("a", "e1", { startSec: 0 }), edgeClip("b", "e2", { startSec: 5.01 })];
    const spans = layoutSpans(timeline, d, STACKED);
    expect(placedLayersAt(spans, 5.005, true).map((l) => [l.span.clip.id, l.opacity])).toEqual([["a", 1]]);
    expect(placedLayersAt(spans, 5.005, false).map((l) => [l.span.clip.id, l.opacity])).toEqual([["a", 1]]);
    // A gap of a slot or more is black
    const wide = layoutSpans([edgeClip("a", "e1", { startSec: 0 }), edgeClip("b", "e2", { startSec: 5.02 })], d, STACKED);
    expect(placedLayersAt(wide, 5.01, true)).toEqual([]);
  });

  it("keeps a start through createClip", () => {
    expect(edgeClip("a", "e1", { startSec: 3 }).startSec).toBe(3);
    expect("startSec" in edgeClip("a", "e1")).toBe(false);
  });
});

describe("group operations", () => {
  const ids = (timeline: readonly StitchTimelineClip[]) => timeline.map((c) => c.id);
  const set = (...clipIds: string[]) => new Set(clipIds);
  const five = () => ["a", "b", "c", "d", "e"].map((id) => edgeClip(id, `e-${id}`));

  const STACKED = { mode: "stacked" as const, overlapSec: 1, crossfade: true };
  const TRACK = { ...STACKED, mode: "track" as const };
  // Clip 1 A [0,5), Clip 2 B [6,10.2), Clip 3 C [9.2,15.2), Clip 4 D [11,14.2)
  const board = () => [
    edgeClip("c1", "a", { startSec: 0 }),
    edgeClip("c2", "b", { startSec: 6, inSec: 0.8 }),
    edgeClip("c3", "c", { startSec: 9.2 }),
    edgeClip("c4", "d", { startSec: 11, outSec: 3.2 }),
  ];
  const boardDurations = durations({ "edge:a": 5, "edge:b": 5, "edge:c": 6, "edge:d": 5 });
  const startsOf = (timeline: StitchTimelineClip[]) =>
    Object.fromEntries(layoutSpans(timeline, boardDurations, STACKED).map((span) => [span.clip.id, span.start]));

  it("removeClips removes every listed clip and reports edges no clip references any more", () => {
    const timeline = [edgeClip("a", "e1"), edgeClip("b", "e2"), edgeClip("a2", "e1"), assetClip("x", "asset1")];
    const first = removeClips(timeline, set("a", "b", "x"));
    expect(ids(first.timeline)).toEqual(["a2"]);
    expect(first.orphanedEdgeIds).toEqual(["e2"]);
    expect(removeClips(timeline, set("a", "a2")).orphanedEdgeIds).toEqual(["e1"]);
    const none = removeClips(timeline, set("nope"));
    expect(none.timeline).toBe(timeline);
    expect(none.orphanedEdgeIds).toEqual([]);
  });

  it("updateClipsAudio changes every listed clip, and nothing else", () => {
    const timeline = three();
    const muted = updateClipsAudio(timeline, set("a", "c"), { muted: true });
    expect(muted.map((c) => c.muted)).toEqual([true, false, true]);
    expect(muted[1]).toBe(timeline[1]);
    expect(updateClipsAudio(timeline, set("a", "b"), { volume: 3 }).map((c) => c.volume)).toEqual([1, 1, 1]);
    expect(updateClipsAudio(timeline, set("a", "b"), { muted: false })).toBe(timeline);
  });

  it("moveClipsBlock equals moveClip for one clip", () => {
    const timeline = five();
    for (let from = 0; from < 5; from++) {
      for (let to = -1; to <= 5; to++) {
        expect(ids(moveClipsBlock(timeline, set(timeline[from].id), to))).toEqual(ids(moveClip(timeline, from, to)));
      }
    }
  });

  it("moveClipsBlock moves a non-contiguous selection as one run, in its order", () => {
    const timeline = five().slice(0, 4);
    expect(ids(moveClipsBlock(timeline, set("c", "a"), 0))).toEqual(["a", "c", "b", "d"]);
    expect(ids(moveClipsBlock(timeline, set("a", "c"), 1))).toEqual(["b", "a", "c", "d"]);
    expect(ids(moveClipsBlock(timeline, set("a", "c"), 2))).toEqual(["b", "d", "a", "c"]);
    expect(ids(moveClipsBlock(timeline, set("a", "c"), 9))).toEqual(["b", "d", "a", "c"]);
    expect(moveClipsBlock(timeline, set("a", "b"), 0)).toBe(timeline);
    expect(moveClipsBlock(timeline, set("a", "c"), NaN)).toBe(timeline);
    expect(moveClipsBlock(timeline, set("nope"), 1)).toBe(timeline);
  });

  it("shiftRows keeps the spacing, stops at both ends and keeps the others' order", () => {
    const timeline = five();
    expect(ids(shiftRows(timeline, set("a", "c"), 1))).toEqual(["b", "a", "d", "c", "e"]);
    expect(ids(shiftRows(timeline, set("a", "c"), 5))).toEqual(["b", "d", "a", "e", "c"]);
    expect(ids(shiftRows(timeline, set("b", "e"), -1))).toEqual(["b", "a", "c", "e", "d"]);
    expect(shiftRows(timeline, set("a", "c"), -1)).toBe(timeline);
    expect(shiftRows(timeline, set("c", "e"), 2)).toBe(timeline);
    expect(shiftRows(timeline, set("a", "c"), 0)).toBe(timeline);
    expect(shiftRows(timeline, set("a", "c"), NaN)).toBe(timeline);
  });

  it("placeClips moves the group by one time and one row delta, keeping its offsets", () => {
    const moved = placeClips(board(), boardDurations, set("c2", "c3"), 2, 1, 1);
    expect(ids(moved)).toEqual(["c1", "c4", "c2", "c3"]);
    const starts = startsOf(moved);
    expect(starts.c1).toBe(0);
    expect(starts.c4).toBe(11);
    expect(starts.c2).toBeCloseTo(8, 9);
    expect(starts.c3).toBeCloseTo(11.2, 9);
  });

  it("placeClips stops the group at 0:00 and 10:00 as a whole", () => {
    const early = startsOf(placeClips(board(), boardDurations, set("c2", "c3"), -100, 0, 1));
    expect(early.c2).toBe(0);
    expect(early.c3).toBeCloseTo(3.2, 9);
    const late = startsOf(placeClips(board(), boardDurations, set("c2", "c3"), 1000, 0, 1));
    expect(late.c3).toBe(MAX_START_SEC);
    expect(late.c2).toBeCloseTo(MAX_START_SEC - 3.2, 9);
  });

  it("placeClips pins a lined-up stack, so the clips it does not move keep their starts", () => {
    const lined = [edgeClip("a", "a"), edgeClip("b", "b"), edgeClip("c", "c")];
    const before = startsOf(lined);
    const moved = placeClips(lined, boardDurations, set("b"), 1, 0, 1);
    expect(moved.every((c) => c.startSec !== undefined)).toBe(true);
    const after = startsOf(moved);
    expect(after.a).toBe(before.a);
    expect(after.c).toBe(before.c);
    expect(after.b).toBeCloseTo(before.b + 1, 9);
  });

  it("placeClips returns the same array, unpinned, when neither time nor row changes", () => {
    const lined = [edgeClip("a", "a"), edgeClip("b", "b")];
    expect(placeClips(lined, boardDurations, set("a", "b"), 0, 0, 1)).toBe(lined);
    expect(placeClips(lined, boardDurations, set("a", "b"), 0, 1, 1)).toBe(lined);
    expect(placeClips(lined, boardDurations, set("a"), -3, 0, 1)).toBe(lined);
    expect(placeClips(lined, boardDurations, set("nope"), 2, 1, 1)).toBe(lined);
    // A row change alone still pins
    const rows = placeClips([...lined, edgeClip("c", "c")], boardDurations, set("a"), 0, 1, 1);
    expect(ids(rows)).toEqual(["b", "a", "c"]);
    expect(rows.every((c) => c.startSec !== undefined)).toBe(true);
  });

  it("splitClipsAt splits every selected clip under the playhead in a placed stack", () => {
    let n = 0;
    const result = splitClipsAt(board(), boardDurations, 10, ["c3", "c2"], { layout: STACKED, makeId: () => `r${++n}` });
    expect(result).not.toBeNull();
    expect(result!.rightIds).toEqual(["r1", "r2"]);
    expect(ids(result!.timeline)).toEqual(["c1", "c2", "r1", "c3", "r2", "c4"]);
  });

  it("splitClipsAt never cuts an unselected clip in front", () => {
    const result = splitClipsAt(board(), boardDurations, 10, ["c3", "c4"], { layout: STACKED, makeId: () => "r" });
    expect(ids(result!.timeline)).toEqual(["c1", "c2", "c3", "r", "c4"]);
    expect(result!.rightIds).toEqual(["r"]);
    expect(splitClipsAt(board(), boardDurations, 10, ["c1", "c4"], { layout: STACKED })).toBeNull();
  });

  it("splitClipsAt refuses inside a lined-up overlap", () => {
    // Lined up at Overlap 1: a 0–5, b 4–9, c 8–14
    const lined = [edgeClip("a", "a"), edgeClip("b", "b"), edgeClip("c", "c")];
    expect(splitClipsAt(lined, boardDurations, 4.5, ["a", "b"], { layout: STACKED })).toBeNull();
    const outside = splitClipsAt(lined, boardDurations, 6, ["a", "b", "c"], { layout: STACKED, makeId: () => "r" });
    expect(outside!.rightIds).toEqual(["r"]);
    expect(ids(outside!.timeline)).toEqual(["a", "b", "r", "c"]);
  });

  it("canSplitClipsAt agrees with splitClipsAt", () => {
    const cases: Array<{ name: string; timeline: StitchTimelineClip[]; layout: typeof STACKED | typeof TRACK }> = [
      { name: "track", timeline: board().map((c) => ({ ...c, startSec: undefined })), layout: TRACK },
      { name: "lined up", timeline: [edgeClip("c1", "a"), edgeClip("c2", "b"), edgeClip("c3", "c")], layout: STACKED },
      { name: "placed", timeline: board(), layout: STACKED },
      {
        // c2 eases in from a standstill at 6 (its speed refuses a cut until about 6.5); c3 runs backwards at 2×
        name: "placed, retimed",
        timeline: board().map((c) => {
          if (c.id === "c2") return retimed(c, W(0.25, { curve: QUAD }));
          return c.id === "c3" ? retimed(c, W(2, { reverse: true })) : c;
        }),
        layout: STACKED,
      },
    ];
    const selections = [["c1"], ["c2"], ["c1", "c3"], ["c2", "c3"], ["c3", "c4"], ["c1", "c2", "c3", "c4"]];
    const times = [
      -1, 0, 0.05, 0.1, 2.5, 4, 4.5, 4.95, 5, 5.05, 6, 6.05, 6.12, 6.2, 7, 8.5, 9.2, 9.25, 9.3, 10, 10.15, 11, 12, 14.2,
      15.15, 15.2, 20,
    ];
    for (const { name, timeline, layout } of cases) {
      const spans = layoutSpans(timeline, boardDurations, layout);
      const placed = layout.mode === "stacked" && isPlaced(timeline);
      for (const selection of selections) {
        for (const t of [...times, NaN, Infinity]) {
          const can = canSplitClipsAt(spans, t, new Set(selection), placed);
          const did = splitClipsAt(timeline, boardDurations, t, selection, { layout }) !== null;
          expect({ name, selection, t, can }).toEqual({ name, selection, t, can: did });
        }
      }
    }
  });

  it("resetTrims resets every selected trimmed clip, in place in Stacked", () => {
    const track = [edgeClip("a", "e1", { inSec: 1 }), edgeClip("b", "e2", { outSec: 2 }), edgeClip("c", "e3", { inSec: 2 })];
    const reset = resetTrims(track, threeDurations, set("a", "b"), TRACK);
    expect(reset.map((c) => [c.inSec, c.outSec])).toEqual([
      [0, null],
      [0, null],
      [2, null],
    ]);
    const untouched = three();
    expect(resetTrims(untouched, threeDurations, set("a", "b"), TRACK)).toBe(untouched);
    const stacked = resetTrims(board(), boardDurations, set("c2", "c4"), STACKED);
    const starts = startsOf(stacked);
    expect(starts.c2).toBeCloseTo(5.2, 9);
    expect(starts.c4).toBe(11);
    expect(starts.c3).toBe(9.2);
    expect(stacked.find((c) => c.id === "c4")).toMatchObject({ inSec: 0, outSec: null });
    const untrimmed = board().filter((c) => c.id === "c1" || c.id === "c3");
    expect(resetTrims(untrimmed, boardDurations, set("c1", "c3"), STACKED)).toBe(untrimmed);
  });

  it("runEndIndex finds the last row of a split's run", () => {
    const d = durations({ "edge:e1": 5, "edge:e2": 5 });
    const split = [
      edgeClip("a1", "e1", { startSec: 0, outSec: 3 }),
      edgeClip("a2", "e1", { startSec: 3, inSec: 3 }),
      edgeClip("b", "e2", { startSec: 1.5 }),
    ];
    const spans = layoutSpans(split, d, STACKED);
    expect(runEndIndex(spans, 0)).toBe(1);
    expect(runEndIndex(spans, 1)).toBe(1);
    expect(runEndIndex(spans, 2)).toBe(2);
    expect(runEndIndex(spans, -1)).toBe(-1);
    expect(runEndIndex(spans, 3)).toBe(3);
    // An empty clip's row is its own; one between the pieces does not end the run
    const gapped = [split[0], edgeClip("x", "missing", { startSec: 2 }), split[1], split[2]];
    const gappedSpans = layoutSpans(gapped, d, STACKED);
    expect(runEndIndex(gappedSpans, 1)).toBe(1);
    expect(runEndIndex(gappedSpans, 0)).toBe(2);
  });
});

describe("an edit without warps", () => {
  // 705eed7e's span maths: the reference for "an edit without warps gives identical spans". A deliberate change to
  // these functions updates this copy in the same commit.
  type RefSpan = Omit<ClipSpan, "sourceOut">;
  const refClamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
  function refClipLength(clip: StitchTimelineClip, sourceDuration: number | undefined): number {
    if (sourceDuration === undefined || !Number.isFinite(sourceDuration)) return 0;
    const end = Math.min(clip.outSec ?? sourceDuration, sourceDuration);
    const length = Math.max(0, end - Math.min(clip.inSec, sourceDuration));
    return length < 1 / FRAME_RATE ? 0 : length;
  }
  function refClipSpans(timeline: readonly StitchTimelineClip[], d: SourceDurations, overlapSec: number): RefSpan[] {
    const lengths = timeline.map((clip) => refClipLength(clip, d.get(sourceKey(clip.source))));
    const overlaps = joinOverlaps(
      timeline.map((clip, i) => ({ length: lengths[i], source: sourceKey(clip.source) })),
      overlapSec,
    );
    let cursor = 0;
    const spans = timeline.map((clip, index): RefSpan => {
      const length = lengths[index];
      if (!(length > 0)) return { clip, index, start: cursor, end: cursor, length, overlapIn: 0, overlapOut: 0 };
      const start = cursor - overlaps[index];
      cursor = start + length;
      return { clip, index, start, end: cursor, length, overlapIn: overlaps[index], overlapOut: 0 };
    });
    let next: RefSpan | null = null;
    for (let i = spans.length - 1; i >= 0; i--) {
      if (!(spans[i].length > 0)) continue;
      if (next) spans[i].overlapOut = next.overlapIn;
      next = spans[i];
    }
    return spans;
  }
  function refPlacedSpans(timeline: readonly StitchTimelineClip[], d: SourceDurations, overlapSec: number): RefSpan[] {
    const lengths = timeline.map((clip) => refClipLength(clip, d.get(sourceKey(clip.source))));
    const starts = resolveStarts(
      timeline.map((clip, i) => ({ start: clip.startSec, length: lengths[i], source: sourceKey(clip.source) })),
      overlapSec,
    );
    return timeline.map((clip, index): RefSpan => {
      const length = lengths[index] > 0 ? lengths[index] : 0;
      const start = starts[index];
      return { clip, index, start, end: start + length, length, overlapIn: 0, overlapOut: 0 };
    });
  }
  function refLayoutSpans(timeline: readonly StitchTimelineClip[], d: SourceDurations, layout: StitchSequenceLayout) {
    if (layout.mode !== "stacked") return refClipSpans(timeline, d, 0);
    return isPlaced(timeline)
      ? refPlacedSpans(timeline, d, layout.overlapSec)
      : refClipSpans(timeline, d, layout.overlapSec);
  }
  const refSourceTimeAt = (span: RefSpan, t: number) => span.clip.inSec + refClamp(t - span.start, 0, span.length);

  const SOURCES = ["e1", "e2", "e3", "e4", "missing"];
  const FIELDS = ["index", "start", "end", "length", "overlapIn", "overlapOut"] as const;

  /** A random edit: sources of odd lengths (a frame, under MIN), trims past the ends, and all three layouts. */
  function randomEdit(rnd: () => number) {
    const lengths = [5, 4, 6, 1 / 60, 0.05];
    const entries: Record<string, number> = {};
    for (const source of SOURCES.slice(0, 4)) {
      const k = Math.floor(rnd() * 6);
      entries[`edge:${source}`] = k < 5 ? lengths[k] : rnd() * 12;
    }
    const mode = rnd() < 1 / 3 ? "track" : "stacked";
    const placed = mode === "stacked" && rnd() < 0.5;
    const timeline = Array.from({ length: 1 + Math.floor(rnd() * 6) }, (_, i) =>
      edgeClip(`c${i}`, SOURCES[Math.floor(rnd() * SOURCES.length)], {
        inSec: rnd() < 0.5 ? 0 : Math.round(rnd() * 60) / 10,
        outSec: rnd() < 0.5 ? null : Math.round(rnd() * 80) / 10,
        ...(placed && rnd() < 0.6 ? { startSec: Math.round(rnd() * 120) / 10 } : {}),
      }),
    );
    const layout: StitchSequenceLayout = {
      mode,
      overlapSec: Math.round(rnd() * 30) / 10,
      crossfade: rnd() < 0.5,
    };
    return { timeline, d: durations(entries), layout };
  }

  /** Instants to read the source at: before, on and either side of every edge, a few inside, past the end, NaN. */
  function instants(spans: readonly { start: number; end: number }[], rnd: () => number): number[] {
    const total = spans.reduce((end, s) => Math.max(end, s.end), 0);
    const times = [-1, 0, total + 1, NaN];
    for (const s of spans) times.push(s.start - 1e-7, s.start, s.start + 1e-7, s.end - 1e-7, s.end, s.end + 1e-7);
    for (let k = 0; k < 4; k++) times.push(rnd() * total);
    return times;
  }

  const withIdentity = (timeline: readonly StitchTimelineClip[]) =>
    timeline.map((clip) => ({ ...clip, warp: IDENTITY }));
  /** The same clips, field for field, the identity warp aside (the loops are long: no deep equality in them). */
  const sameClips = (a: readonly StitchTimelineClip[], b: readonly StitchTimelineClip[]) =>
    a.length === b.length &&
    a.every((clip, i) => {
      const other = b[i];
      return (
        clip.id === other.id &&
        sourceKey(clip.source) === sourceKey(other.source) &&
        Object.is(clip.inSec, other.inSec) &&
        Object.is(clip.outSec, other.outSec) &&
        clip.muted === other.muted &&
        clip.volume === other.volume &&
        Object.is(clip.startSec, other.startSec) &&
        ("startSec" in clip) === ("startSec" in other)
      );
    });

  it("gives 705eed7e's spans and source times on 2,000 random edits", () => {
    const rnd = lcg(2026);
    const misses: string[] = [];
    for (let n = 0; n < 2000; n++) {
      const { timeline, d, layout } = randomEdit(rnd);
      for (const lay of [layout, { ...layout, mode: "track" as const }]) {
        const got = layoutSpans(timeline, d, lay);
        const want = refLayoutSpans(timeline, d, lay);
        if (got.length !== want.length) misses.push(`${n} ${lay.mode}: ${got.length} spans`);
        const times = instants(want, rnd);
        got.forEach((span, i) => {
          const w = want[i];
          if (span.clip !== w.clip) misses.push(`${n} ${lay.mode} span ${i}: clip`);
          for (const field of FIELDS) {
            if (!Object.is(span[field], w[field])) misses.push(`${n} ${lay.mode} span ${i}: ${field}`);
          }
          const sd = d.get(sourceKey(span.clip.source));
          const { inSec, outSec } = span.clip;
          const out = sd === undefined ? inSec : Math.max(inSec, Math.min(outSec ?? sd, sd));
          if (!Object.is(span.sourceOut, out)) misses.push(`${n} ${lay.mode} span ${i}: sourceOut`);
          for (const t of times) {
            if (!Object.is(sourceTimeAt(span, t), refSourceTimeAt(w, t))) misses.push(`${n} span ${i}: source at ${t}`);
          }
        });
      }
    }
    expect(misses.slice(0, 10)).toEqual([]);
  });

  it("reads a warp that changes nothing as none, in every span, trim, split and edge", () => {
    const rnd = lcg(7);
    const misses: string[] = [];
    // The label's parts are joined only for a miss: the loops are long
    const same = (a: unknown, b: unknown, ...what: unknown[]) => {
      if (!Object.is(a, b)) misses.push(`${what.join(" ")}: ${String(a)} ≠ ${String(b)}`);
    };
    // An op on the plain timeline and on its identity copy: the same clips, and the same array back when unchanged
    const sameResult = (
      n: number,
      what: string,
      input: StitchTimelineClip[],
      plain: StitchTimelineClip[] | null,
      identityInput: StitchTimelineClip[],
      result: StitchTimelineClip[] | null,
    ) => {
      same(result === identityInput, plain === input, n, what, "unchanged");
      if ((result === null) !== (plain === null)) misses.push(`${n} ${what}: null`);
      else if (result && plain && !sameClips(result, plain)) misses.push(`${n} ${what}: clips`);
    };
    const patchOf = (): { inSec?: number; outSec?: number | null } => {
      const value = () => Math.round((rnd() * 13 - 1) * 100) / 100;
      const k = Math.floor(rnd() * 4);
      if (k === 0) return { inSec: value() };
      if (k === 1) return { outSec: value() };
      return k === 2 ? { outSec: null } : { inSec: value(), outSec: value() };
    };
    for (let n = 0; n < 2000; n++) {
      const { timeline, d, layout } = randomEdit(rnd);
      const ident = withIdentity(timeline);
      for (const clip of timeline) {
        const sd = d.get(sourceKey(clip.source));
        same(clipLength({ ...clip, warp: IDENTITY }, sd), clipLength(clip, sd), n, "length");
      }
      const spans = layoutSpans(timeline, d, layout);
      const identSpans = layoutSpans(ident, d, layout);
      const placed = layout.mode === "stacked" && isPlaced(timeline);
      const times = instants(spans, rnd);
      spans.forEach((span, i) => {
        for (const field of [...FIELDS, "sourceOut"] as const) {
          same(identSpans[i][field], span[field], n, "span", i, field);
        }
        for (const t of times) same(sourceTimeAt(identSpans[i], t), sourceTimeAt(span, t), n, "span", i, "at", t);
        const t = span.start + rnd() * (span.length + 0.2) - 0.1;
        same(splitRefusal(identSpans[i], t, placed), splitRefusal(span, t, placed), n, "refusal", i);
      });
      const env = spansEnvelope(spans, layout.crossfade);
      const identEnv = spansEnvelope(identSpans, layout.crossfade);
      same(JSON.stringify(identEnv.units), JSON.stringify(env.units), n, "units");
      same(identEnv.units.some((unit) => "sourceEnds" in unit), false, n, "sourceEnds");
      same(identEnv.runOf.join(), env.runOf.join(), n, "runs");

      const total = spansEnd(spans);
      const t = rnd() * (total + 1) - 0.5;
      const ids = new Set(timeline.filter(() => rnd() < 0.5).map((c) => c.id));
      same(canSplitClipsAt(identSpans, t, ids, placed), canSplitClipsAt(spans, t, ids, placed), n, "canSplit");
      const prefer = timeline[Math.floor(rnd() * timeline.length)].id;
      const split = splitClipAt(timeline, d, t, () => "new", { layout, preferClipId: prefer });
      const identSplit = splitClipAt(ident, d, t, () => "new", { layout, preferClipId: prefer });
      if ((split === null) !== (identSplit === null)) misses.push(`${n} split: null`);
      else if (split && identSplit && !sameClips(identSplit.timeline, split.timeline)) misses.push(`${n} split: clips`);

      const overlap = layout.mode === "stacked" ? layout.overlapSec : 0;
      const edgeClipId = timeline[Math.floor(rnd() * timeline.length)].id;
      const edge = rnd() < 0.5 ? "in" : "out";
      const edgeAt = rnd() * (total + 1) - 0.5;
      sameResult(
        n,
        "edge",
        timeline,
        setEdgeAtPlayhead(timeline, d, edgeClipId, edge, edgeAt, overlap),
        ident,
        setEdgeAtPlayhead(ident, d, edgeClipId, edge, edgeAt, overlap),
      );
      timeline.forEach((clip, i) => {
        const sd = d.get(sourceKey(clip.source));
        for (let k = 0; k < 4; k++) {
          const patch = patchOf();
          const trimmed = clampTrim(clip, sd, patch);
          const identTrimmed = clampTrim(ident[i], sd, patch);
          same(identTrimmed.inSec, trimmed.inSec, n, "clamp in");
          same(identTrimmed.outSec, trimmed.outSec, n, "clamp out");
          sameResult(n, "trim", timeline, trimClip(timeline, clip.id, d, patch), ident, trimClip(ident, clip.id, d, patch));
          sameResult(
            n,
            "in place",
            timeline,
            trimClipInPlace(timeline, clip.id, d, patch, overlap),
            ident,
            trimClipInPlace(ident, clip.id, d, patch, overlap),
          );
        }
        sameResult(n, "reset", timeline, resetTrim(timeline, clip.id, d), ident, resetTrim(ident, clip.id, d));
        sameResult(
          n,
          "reset in place",
          timeline,
          resetTrimInPlace(timeline, clip.id, d, overlap),
          ident,
          resetTrimInPlace(ident, clip.id, d, overlap),
        );
        same(canResetTrim(clip, sd), isTrimmed(clip), n, "can reset");
        same(canResetTrim(ident[i], sd), isTrimmed(clip), n, "can reset identity");
      });
    }
    expect(misses.slice(0, 10)).toEqual([]);
  });
});

describe("retimed clips", () => {
  const d = threeDurations;
  const three2x = () => three().map((c) => (c.id === "b" ? retimed(c, W(2)) : c));
  /** The source shown at t, and which source: the picture a split must not change. */
  const picture = (timeline: StitchTimelineClip[], t: number, layout?: StitchSequenceLayout) => {
    const spans = layout ? layoutSpans(timeline, d, layout) : clipSpans(timeline, d, 0);
    const span = spanAtTime(spans, t)!;
    return { source: sourceKey(span.clip.source), at: sourceTimeAt(span, t) };
  };
  const samePicture = (a: StitchTimelineClip[], b: StitchTimelineClip[], total: number, count: number, digits = 9) => {
    for (let i = 0; i < count; i++) {
      const t = ((i + 0.5) * total) / count;
      const want = picture(a, t);
      const got = picture(b, t);
      expect(got.source).toBe(want.source);
      expect(got.at).toBeCloseTo(want.at, digits);
    }
  };

  it("lasts its source range over its average speed", () => {
    const clip = edgeClip("a", "e1");
    expect(clipLength(retimed(clip, W(2)), 5)).toBe(2.5);
    expect(clipLength(retimed(clip, W(0.5)), 5)).toBe(10);
    // A ramp keeps its average, and reverse its length
    expect(clipLength(retimed(clip, W(1, { curve: QUAD })), 5)).toBe(5);
    expect(clipLength(retimed(clip, W(1, { reverse: true })), 5)).toBe(5);
    expect(clipLength(retimed(edgeClip("a", "e1", { inSec: 1, outSec: 3 }), W(4)), 5)).toBe(0.5);
    // 0.01 s of output is under a frame, as the encode drops it
    expect(clipLength(retimed(edgeClip("a", "e1", { inSec: 4.9 }), W(10)), 5)).toBe(0);
    expect(clipLength(edgeClip("a", "e1", { inSec: 4.9 }), 5)).toBeCloseTo(0.1);
    expect(clipLength({ ...clip, warp: IDENTITY }, 5)).toBe(5);
  });

  it("carries the resolved Out on every span", () => {
    const timeline = [
      edgeClip("a", "e1", { inSec: 1 }),
      edgeClip("b", "e2", { outSec: 9 }),
      edgeClip("x", "missing", { inSec: 2 }),
    ];
    expect(clipSpans(timeline, d, 0).map((s) => s.sourceOut)).toEqual([5, 4, 2]);
    expect(clipSourceOut(edgeClip("a", "e1", { inSec: 7 }), 5)).toBe(7);
    expect(clipSpans(three2x(), d, 0).map((s) => [s.start, s.end])).toEqual([
      [0, 5],
      [5, 7],
      [7, 13],
    ]);
    expect(sequenceDuration(three2x(), d, 0)).toBe(13);
  });

  it("reads the source through the warp, one compiled map per span", () => {
    expect(sourceTimeAt(clipSpans(three2x(), d, 0)[1], 6)).toBeCloseTo(2, 12);
    const reversed = clipSpans(three().map((c) => (c.id === "b" ? retimed(c, W(1, { reverse: true })) : c)), d, 0);
    expect([5, 6, 9, 99, -1].map((t) => sourceTimeAt(reversed[1], t))).toEqual([4, 3, 0, 0, 4]);
    const ramp = clipSpans(three().map((c) => (c.id === "c" ? retimed(c, W(1, { curve: QUAD })) : c)), d, 0)[2];
    expect(sourceTimeAt(ramp, 12)).toBe(1.5);
    for (const t of [8, 9, 10.3, 14.99, 15, 20]) {
      const offset = Math.min(Math.max(t - ramp.start, 0), ramp.length);
      expect(sourceTimeAt(ramp, t)).toBe(spanWarpMap(ramp)!.sourceTimeAt(offset));
    }
    expect(spanWarpMap(ramp)).toBe(spanWarpMap(ramp));
    // A clip with no length answers its In, reversed or not, and has no map
    const empty = clipSpans([retimed(edgeClip("x", "missing", { inSec: 2 }), W(2, { reverse: true }))], d, 0)[0];
    expect(sourceTimeAt(empty, 0)).toBe(2);
    expect(spanWarpMap(empty)).toBeNull();
    expect(spanWarpMap(clipSpans(three(), d, 0)[0])).toBeNull();
  });

  it("re-anchors a time on a retimed clip at the same offset", () => {
    const before = clipSpans(three2x(), d, 0);
    const after = clipSpans(three2x(), d, 1);
    expect(reanchorTime(before, after, 6.5)).toBe(after[1].start + (6.5 - before[1].start));
  });

  it("bounds a trim in output time", () => {
    const clip = edgeClip("a", "e1");
    // The least is MIN_CLIP_SEC of output: 1 s of source at 10×, 0.01 s at 0.1×
    expect(clampTrim(retimed(clip, W(10)), 5, { inSec: 4.9 })).toEqual({ inSec: 4, outSec: null });
    expect(clampTrim(retimed(clip, W(0.1)), 5, { outSec: 0.005 }).outSec).toBeCloseTo(0.01, 12);
    // The end snap is END_EPSILON_SEC of output too: at 0.1× an Out 0.004 s of source from the end is kept
    const slow = retimed(edgeClip("a", "e1", { inSec: 9 }), W(0.1));
    expect(clampTrim(slow, 10, { outSec: 9.996 }).outSec).toBe(9.996);
    expect(clampTrim(slow, 10, { outSec: 9.9997 }).outSec).toBeNull();
    expect(clampTrim(edgeClip("a", "e1", { inSec: 9 }), 10, { outSec: 9.996 }).outSec).toBeNull();
  });

  it("gives way only at the edge a trim moves on a clip already under the shortest length", () => {
    const short = [retimed(edgeClip("a", "e1", { inSec: 2, outSec: 2.4 }), W(10))];
    for (const patch of [{ inSec: 2 }, { inSec: 2.1 }, { outSec: 2.3 }]) {
      expect(clampTrim(short[0], 5, patch)).toEqual({ inSec: 2, outSec: 2.4 });
      expect(trimClip(short, "a", durations({ "edge:e1": 5 }), patch)).toBe(short);
    }
    expect(clampTrim(short[0], 5, { outSec: 3 })).toEqual({ inSec: 2, outSec: 3 });
    // On a source shorter than the shortest length, no reset to the whole source either
    const tiny = retimed(edgeClip("a", "e1", { inSec: 0.2, outSec: 0.6 }), W(10));
    expect(clampTrim(tiny, 0.8, { outSec: 0.5 })).toEqual({ inSec: 0.2, outSec: 0.6 });
  });

  it("never trims a clip slower than 1× past 600 s of output, and lets one already longer only shrink", () => {
    const slow = retimed(edgeClip("a", "e1", { inSec: 10, outSec: 16 }), W(0.1));
    expect(clampTrim(slow, 900, { outSec: null })).toEqual({ inSec: 10, outSec: 70 });
    expect(clampTrim(slow, 900, { inSec: 0 })).toEqual({ inSec: 0, outSec: 16 });
    const long = retimed(edgeClip("a", "e1", { inSec: 10, outSec: 110 }), W(0.1));
    expect(clampTrim(long, 900, { inSec: 0 })).toEqual({ inSec: 10, outSec: 110 });
    expect(clampTrim(long, 900, { outSec: 50 })).toEqual({ inSec: 10, outSec: 50 });
    // Without a known duration a numeric Out is capped the same way
    expect(clampTrim(slow, undefined, { outSec: 200 })).toEqual({ inSec: 10, outSec: 70 });
    expect(clampTrim(retimed(edgeClip("a", "e1", { outSec: 200 }), W(0.1)), undefined, { inSec: 0 })).toEqual({
      inSec: 0,
      outSec: 200,
    });
    // and an In move on a clip at its cap stops there
    const capped = retimed(edgeClip("a", "e1", { inSec: 100, outSec: 160 }), W(0.1));
    expect(clampTrim(capped, undefined, { inSec: 0 })).toEqual({ inSec: 100, outSec: 160 });
  });

  it("resets a slow clip's trim to 600 s of output, keeping the frame it starts on", () => {
    const long = durations({ "edge:e1": 600 });
    const forward = [retimed(edgeClip("a", "e1", { inSec: 100, outSec: 106 }), W(0.1))];
    expect(resetTrim(forward, "a", long)[0]).toMatchObject({ inSec: 100, outSec: 160 });
    const late = [retimed(edgeClip("a", "e1", { inSec: 590, outSec: 596 }), W(0.1))];
    expect(resetTrim(late, "a", long)[0]).toMatchObject({ inSec: 540, outSec: null });
    // An Out the cap reaches within the end snap (0.0005 s of source at 0.1×) is to the end
    const nearEnd = [retimed(edgeClip("a", "e1", { inSec: 539.9997, outSec: 545.9997 }), W(0.1))];
    expect(resetTrim(nearEnd, "a", long)[0]).toMatchObject({ inSec: 539.9997, outSec: null });
    // Reversed, the tail is the In: it grows first, then the Out (the head) when the In reaches the source's start
    const reversed = [retimed(edgeClip("a", "e1", { inSec: 100, outSec: 106 }), W(0.1, { reverse: true }))];
    expect(resetTrim(reversed, "a", long)[0]).toMatchObject({ inSec: 46, outSec: 106 });
    const early = [retimed(edgeClip("a", "e1", { inSec: 2, outSec: 6 }), W(0.1, { reverse: true }))];
    expect(resetTrim(early, "a", long)[0]).toMatchObject({ inSec: 0, outSec: 60 });
    // and its Out, kept or reached by the cap, is to the end within the snap
    const lateReversed = [retimed(edgeClip("a", "e1", { inSec: 590, outSec: 599.999 }), W(0.5, { reverse: true }))];
    const lateReset = resetTrim(lateReversed, "a", long)[0];
    expect(lateReset.inSec).toBeCloseTo(299.999, 9);
    expect(lateReset.outSec).toBeNull();
    expect(resetTrim(early, "a", durations({ "edge:e1": 60.0003 }))[0]).toMatchObject({ inSec: 0, outSec: null });
    // In Stacked its start moves back by what its head (the Out) gains over the speed: (60 − 6) / 0.1
    const earlyPlaced = resetTrimInPlace([{ ...early[0], startSec: 545 }], "a", long, 1)[0];
    expect(earlyPlaced).toMatchObject({ inSec: 0, outSec: 60 });
    expect(earlyPlaced.startSec).toBeCloseTo(5, 9);
    // At its cap already: nothing to reset
    const capped = [retimed(edgeClip("a", "e1", { inSec: 100, outSec: 160 }), W(0.1))];
    expect(resetTrim(capped, "a", long)).toBe(capped);
    // At 1× and faster, the whole source as before, with the durations or without
    for (const known of [long, undefined]) {
      expect(resetTrim([retimed(edgeClip("a", "e1", { inSec: 100 }), W(2))], "a", known)[0]).toMatchObject({
        inSec: 0,
        outSec: null,
      });
    }
    // In Stacked the start stays: the head (the In) did not move
    const placed = [{ ...forward[0], startSec: 3 }];
    expect(resetTrimInPlace(placed, "a", long, 1)[0]).toMatchObject({ inSec: 100, outSec: 160, startSec: 3 });
    const tracks = { mode: "track" as const, overlapSec: 1, crossfade: true };
    expect(resetTrims(forward, long, new Set(["a"]), tracks)[0]).toMatchObject({ inSec: 100, outSec: 160 });
  });

  it("offers Reset trim on a slow clip only while it would change something", () => {
    const long = durations({ "edge:e1": 600 });
    const forward = [retimed(edgeClip("a", "e1", { inSec: 100, outSec: 106 }), W(0.1))];
    expect(canResetTrim(forward[0], 600)).toBe(true);
    const once = resetTrim(forward, "a", long);
    expect(isTrimmed(once[0])).toBe(true);
    expect(canResetTrim(once[0], 600)).toBe(false);
    expect(resetTrim(once, "a", long)).toBe(once);
    // One that already plays more than the cap may only shrink: nothing to reset
    expect(canResetTrim(retimed(edgeClip("a", "e1", { inSec: 10, outSec: 110 }), W(0.1)), 900)).toBe(false);
    // Without the duration there is nothing to give back yet; at 1× and faster, and unwarped, it is isTrimmed
    expect(canResetTrim(forward[0], undefined)).toBe(false);
    for (const known of [600, undefined]) {
      expect(canResetTrim(retimed(edgeClip("a", "e1", { inSec: 100 }), W(2)), known)).toBe(true);
      expect(canResetTrim(edgeClip("a", "e1", { inSec: 1 }), known)).toBe(true);
    }
    expect(canResetTrim(edgeClip("a", "e1"), 5)).toBe(false);
    expect(canResetTrim(retimed(edgeClip("a", "e1"), W(0.1)), 5)).toBe(false);
  });

  it("leaves a slow clip's trim alone while its source length is unknown", () => {
    // Reset then would give it the whole source, ten times 600 s of output once a 600 s source is read
    const unknown = durations({});
    const stacked = { mode: "stacked" as const, overlapSec: 1, crossfade: true };
    const tracks = { ...stacked, mode: "track" as const };
    for (const reverse of [false, true]) {
      const slow = [retimed(edgeClip("a", "e1", { inSec: 100, outSec: 106 }), W(0.1, { reverse }))];
      expect(canResetTrim(slow[0], undefined)).toBe(false);
      expect(resetTrim(slow, "a", unknown)).toBe(slow);
      expect(resetTrimInPlace(slow, "a", unknown, 1)).toBe(slow);
      for (const layout of [stacked, tracks]) expect(resetTrims(slow, unknown, new Set(["a"]), layout)).toBe(slow);
      // Read, it gets its 600 s of output
      const reset = resetTrim(slow, "a", durations({ "edge:e1": 600 }))[0];
      expect(clipLength(reset, 600)).toBeCloseTo(600, 9);
    }
  });

  it("leaves a clip already past the cap exactly as it is", () => {
    // Its edges are kept, never rebuilt from the cap an ulp away (400.4 − (400.4 − 0.1) is not 0.1)
    const over = [retimed(edgeClip("a", "e1", { inSec: 0.1 }), W(0.25, { reverse: true }))];
    const short = durations({ "edge:e1": 400.4 });
    expect(canResetTrim(over[0], 400.4)).toBe(false);
    expect(resetTrim(over, "a", short)).toBe(over);
    expect(resetTrimInPlace([{ ...over[0], startSec: 3 }], "a", short, 1)[0]).toMatchObject({ inSec: 0.1, startSec: 3 });
    const late = [retimed(edgeClip("a", "e1", { inSec: 412.35 }), W(0.394, { reverse: true }))];
    const lateSource = durations({ "edge:e1": 1702.031 });
    expect(canResetTrim(late[0], 1702.031)).toBe(false);
    expect(resetTrim(late, "a", lateSource)).toBe(late);
    // A trim that would lengthen it changes nothing, at either edge, in Track and in place
    const long = [retimed(edgeClip("a", "e1", { inSec: 415.45, outSec: 1028.11 }), W(0.539))];
    const longSource = durations({ "edge:e1": 2474.508 });
    for (const patch of [{ inSec: 410.45 }, { outSec: 1033.11 }]) {
      expect(trimClip(long, "a", longSource, patch)).toBe(long);
      expect(trimClipInPlace(long, "a", longSource, patch, 1)).toBe(long);
      expect(trimClip(long, "a", durations({}), patch)).toBe(long);
    }
    // and one that shortens it still does
    expect(trimClip(long, "a", longSource, { inSec: 420 })[0]).toMatchObject({ inSec: 420, outSec: 1028.11 });
  });

  it("splits a constant warp where the picture is, keeping the speed", () => {
    const result = splitClipAt(three2x(), d, 6, () => "new")!;
    expect(result.timeline.map((c) => c.id)).toEqual(["a", "b", "new", "c"]);
    expect(result.timeline[1]).toMatchObject({ id: "b", inSec: 0, warp: W(2) });
    expect(result.timeline[1].outSec).toBeCloseTo(2);
    expect(result.timeline[2]).toMatchObject({ id: "new", outSec: null, warp: W(2) });
    expect(result.timeline[2].inSec).toBeCloseTo(2);
    const spans = clipSpans(result.timeline, d, 0);
    [[0, 5], [5, 6], [6, 7], [7, 13]].forEach(([start, end], i) => {
      expect(spans[i].start).toBeCloseTo(start, 9);
      expect(spans[i].end).toBeCloseTo(end, 9);
    });
    samePicture(three2x(), result.timeline, 13, 40);
  });

  it("splits a reversed clip with the id on the piece that plays first, which keeps the Out", () => {
    const timeline = three().map((c) => (c.id === "b" ? retimed(c, W(1, { reverse: true })) : c));
    const result = splitClipAt(timeline, d, 6, () => "new")!;
    expect(result.timeline[1]).toMatchObject({ id: "b", inSec: 3, outSec: null, warp: { reverse: true } });
    expect(result.timeline[2]).toMatchObject({ id: "new", inSec: 0, outSec: 3, warp: { reverse: true } });
    const spans = clipSpans(result.timeline, d, 0);
    expect([spans[1].start, spans[1].end, spans[2].start, spans[2].end]).toEqual([5, 6, 6, 9]);
    samePicture(timeline, result.timeline, 15, 40);
  });

  it.each([false, true])("splits a ramp into two windows of it, keeping the picture (reverse %s)", (reverse) => {
    const timeline = three().map((c) => (c.id === "c" ? retimed(c, W(1, { curve: QUAD, reverse })) : c));
    const once = splitClipAt(timeline, d, 12, () => "c2")!;
    const [left, right] = once.timeline.slice(2);
    expect(left).toMatchObject({ id: "c", warp: { window: [0, 0.5] } });
    expect(right).toMatchObject({ id: "c2", warp: { window: [0.5, 1] } });
    expect(left.warp!.speed).toBeCloseTo(0.5, 12);
    expect(right.warp!.speed).toBeCloseTo(1.5, 12);
    expect(reverse ? [left.inSec, left.outSec, right.inSec] : [left.inSec, right.inSec, right.outSec]).toEqual([
      reverse ? 4.5 : 0,
      reverse ? null : 1.5,
      reverse ? 0 : null,
    ]);
    expect(reverse ? right.outSec : left.outSec).toBe(reverse ? 4.5 : 1.5);
    const spans = clipSpans(once.timeline, d, 0);
    expect(spans[2].start).toBe(9);
    expect(spans[2].end).toBeCloseTo(12, 9);
    expect(spans[3].end).toBeCloseTo(15, 9);
    samePicture(timeline, once.timeline, 15, 200);
    const twice = splitClipAt(once.timeline, d, 13.5, () => "c3", { preferClipId: "c2" })!;
    expect(twice.timeline.map((c) => c.id)).toEqual(["a", "b", "c", "c2", "c3"]);
    samePicture(timeline, twice.timeline, 15, 200);
  });

  it("refuses a cut where the speed is too slow, and says why", () => {
    // 5 s of source eased in at 0.25×: 20 s, standing almost still at its start
    const ramp = [retimed(edgeClip("a", "e1"), W(0.25, { curve: QUAD }))];
    expect(splitClipAt(ramp, d, 0.15)).toBeNull();
    expect(splitClipAt(ramp, d, 2)).not.toBeNull();
    const span = clipSpans(ramp, d, 0)[0];
    expect(splitRefusal(span, 0.15, false)).toBe("warp");
    expect(splitRefusal(span, 0.05, false)).toBe("edge");
    expect(splitRefusal(span, 2, false)).toBeNull();
    // Near an ease-out's slow end the right piece would hold under END_EPSILON_SEC of source
    const ease = [retimed(edgeClip("a", "e1"), W(1, { curve: OUT_QUAD }))];
    expect(splitClipAt(ease, d, 4.88)).toBeNull();
    expect(splitRefusal(clipSpans(ease, d, 0)[0], 4.88, false)).toBe("warp");
    expect(splitClipAt(ease, d, 4.8)).not.toBeNull();
    // At 10× b lasts 0.4 s: each piece needs MIN_CLIP_SEC of output
    const fast = three().map((c) => (c.id === "b" ? retimed(c, W(10)) : c));
    expect(splitClipAt(fast, d, 5.05)).toBeNull();
    expect(splitClipAt(fast, d, 5.2)).not.toBeNull();
  });

  it.each([W(0.5), W(0.5, { curve: QUAD, reverse: true })])("splits a placed retimed clip into one run", (warp) => {
    const STACKED = { mode: "stacked" as const, overlapSec: 1, crossfade: true };
    const timeline = [retimed(edgeClip("a", "e1", { startSec: 2 }), warp)];
    const result = splitClipAt(timeline, d, 7, () => "new", { layout: STACKED })!;
    expect(result.timeline.map((c) => c.startSec)).toEqual([2, 7]);
    const spans = layoutSpans(result.timeline, d, STACKED);
    expect(spans[0].start).toBe(2);
    expect(spans[0].end).toBeCloseTo(7, 9);
    expect(spans[1].end).toBeCloseTo(12, 9);
    expect(runEndIndex(spans, 0)).toBe(1);
  });

  it("moves an edge to the playhead as a drag snapped there would", () => {
    const reversed = three().map((c) => (c.id === "b" ? retimed(c, W(1, { reverse: true })) : c));
    expect(setEdgeAtPlayhead(reversed, d, "b", "in", 6, 0)![1]).toMatchObject({ inSec: 0, outSec: 3 });
    expect(setEdgeAtPlayhead(reversed, d, "b", "out", 8, 0)![1]).toMatchObject({ inSec: 1, outSec: null });
    const fast = setEdgeAtPlayhead(three2x(), d, "b", "in", 6, 0)!;
    expect(fast[1]).toMatchObject({ inSec: 2 });
    const fastSpan = clipSpans(fast, d, 0)[1];
    expect([fastSpan.start, fastSpan.end]).toEqual([5, 6]);
    // On a ramp the edge lands on the playhead (the frame under 12 was 1.5) and the far edge stays
    for (const reverse of [false, true]) {
      const ramp = three().map((c) => (c.id === "c" ? retimed(c, W(1, { curve: QUAD, reverse })) : c));
      const out = setEdgeAtPlayhead(ramp, d, "c", "out", 12, 0)!;
      expect(out[2]).toMatchObject(reverse ? { inSec: 3, outSec: null } : { inSec: 0, outSec: 3 });
      expect(clipSpans(out, d, 0)[2].end).toBe(12);
      const head = setEdgeAtPlayhead(ramp, d, "c", "in", 12, 0)!;
      expect(head[2]).toMatchObject(reverse ? { inSec: 0, outSec: 3 } : { inSec: 3, outSec: null });
      expect(clipSpans(head, d, 0)[2].end).toBe(12);
    }
    const plain = clipSpans(three(), d, 0)[1];
    const patch = edgeAtPlayheadPatch(plain, "in", 6.3);
    expect(patch).toEqual({ inSec: sourceTimeAt(plain, 6.3) });
  });

  describe("in Stacked", () => {
    const placedD = durations({ "edge:e1": 5, "edge:e2": 5, "edge:e3": 6 });
    const STACKED = { mode: "stacked" as const, overlapSec: 1, crossfade: true };
    const board = (b: StitchTimelineClip) => [
      edgeClip("a", "e1", { startSec: 0 }),
      b,
      edgeClip("c", "e3", { startSec: 12 }),
    ];
    const REVERSED_2X = W(2, { reverse: true });
    const spanOf = (timeline: StitchTimelineClip[], id: string) =>
      layoutSpans(timeline, placedD, STACKED).find((s) => s.clip.id === id)!;

    it("moves the start by the head's change over the speed, and keeps the tail", () => {
      // b at 2× from In 1: 4–6
      const timeline = board(retimed(edgeClip("b", "e2", { startSec: 4, inSec: 1 }), W(2)));
      const head = trimClipInPlace(timeline, "b", placedD, { inSec: 2 }, 1);
      expect(head[1].startSec).toBeCloseTo(4.5);
      expect(spanOf(head, "b").end).toBeCloseTo(6);
      const tail = trimClipInPlace(timeline, "b", placedD, { outSec: 4 }, 1);
      expect(tail[1].startSec).toBe(4);
      expect(spanOf(tail, "b").end).toBeCloseTo(5.5);
      expect(trimClipInPlace(timeline, "b", placedD, { inSec: 1 }, 1)).toBe(timeline);
      // The head stops where the clip would start before 0:00
      const early = board(retimed(edgeClip("b", "e2", { startSec: 0.5, inSec: 2 }), W(2)));
      expect(trimClipInPlace(early, "b", placedD, { inSec: 0 }, 1)[1]).toMatchObject({ inSec: 1, startSec: 0 });
    });

    it("moves a reversed clip's start by its Out's change, its head", () => {
      // b reversed at 2×, 1–4.5: 4–5.75
      const timeline = board(retimed(edgeClip("b", "e2", { startSec: 4, inSec: 1, outSec: 4.5 }), REVERSED_2X));
      const head = trimClipInPlace(timeline, "b", placedD, { outSec: 3.5 }, 1);
      expect(head[1].startSec).toBeCloseTo(4.5);
      expect(spanOf(head, "b").end).toBeCloseTo(5.75);
      const tail = trimClipInPlace(timeline, "b", placedD, { inSec: 2 }, 1);
      expect(tail[1].startSec).toBe(4);
      expect(spanOf(tail, "b").end).toBeCloseTo(5.25);
      const early = board(retimed(edgeClip("b", "e2", { startSec: 0.5, inSec: 1, outSec: 3 }), REVERSED_2X));
      expect(trimClipInPlace(early, "b", placedD, { outSec: null }, 1)[1]).toMatchObject({ outSec: 4, startSec: 0 });
    });

    it.each([false, true])("starts a ramp at the playhead with I, then changes nothing (reverse %s)", (reverse) => {
      const timeline = board(retimed(edgeClip("b", "e2", { startSec: 4 }), W(1, { curve: QUAD, reverse })));
      const span = spanOf(timeline, "b");
      expect([span.start, span.end]).toEqual([4, 9]);
      const once = trimClipInPlace(timeline, "b", placedD, edgeAtPlayheadPatch(span, "in", 6), 1);
      const after = spanOf(once, "b");
      expect([after.start, after.end]).toEqual([6, 9]);
      expect(trimClipInPlace(once, "b", placedD, edgeAtPlayheadPatch(after, "in", 6), 1)).toBe(once);
    });

    it("resets a retimed trim, the start back by what the head gains over the speed", () => {
      const forward = [retimed(edgeClip("a", "e1", { startSec: 3, inSec: 1, outSec: 4 }), W(2))];
      const reset = resetTrimInPlace(forward, "a", placedD, 1);
      expect(reset[0]).toMatchObject({ startSec: 2.5, inSec: 0, outSec: null });
      expect(reset[0].warp).toEqual(W(2));
      // Reversed, the head is the Out: it gains (5 − 4) / 2, where the In's 0.5 / 2 would give 2.75
      const reversed = [retimed(edgeClip("a", "e1", { startSec: 3, inSec: 0.5, outSec: 4 }), W(2, { reverse: true }))];
      expect(resetTrimInPlace(reversed, "a", placedD, 1)[0].startSec).toBe(2.5);
      const early = [retimed(edgeClip("a", "e1", { startSec: 0.2, inSec: 1 }), W(2))];
      expect(resetTrimInPlace(early, "a", placedD, 1)[0].startSec).toBe(0);
    });

    it("gives a retimed clip's unit its source ends, and an unwarped one none", () => {
      const timeline = [
        retimed(edgeClip("a", "e1", { startSec: 0, inSec: 1 }), W(2)),
        retimed(edgeClip("b", "e2", { startSec: 1, inSec: 1 }), W(2, { reverse: true })),
        edgeClip("c", "e3", { startSec: 2 }),
      ];
      const units = spansEnvelope(layoutSpans(timeline, placedD, STACKED), true).units;
      expect(units[0]).toMatchObject({ sourceEnds: [1, 5] });
      expect(units[1]).toMatchObject({ sourceEnds: [5, 1] });
      expect("sourceEnds" in units[2]).toBe(false);
    });
  });

  it("keeps every warp canonical through 200 runs of random edits", () => {
    // Key order aside (sanitizeTimeline writes its own): the loop is long, so no deep equality in it
    const sorted = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(sorted)
        : value && typeof value === "object"
          ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, sorted((value as Record<string, unknown>)[k])]))
          : value;
    const misses: string[] = [];
    const rnd = lcg(31);
    const warps: ClipWarp[] = [
      W(2),
      W(0.5),
      W(3, { reverse: true }),
      W(0.25, { curve: QUAD }),
      W(1, { curve: OUT_QUAD, reverse: true }),
      W(1.5, { curve: { kind: "bezier", handles: [0.42, 0, 0.58, 1] } }),
      W(0.8, { curve: { kind: "points", points: [[0, 0], [0.3, 0.1], [0.7, 0.9], [1, 1]] }, blend: true }),
      W(0.6, { curve: QUAD, window: [0.2, 0.7] }),
    ];
    const long = durations({ "edge:e1": 5, "edge:e2": 4, "edge:e3": 6, "edge:e4": 9 });
    for (let run = 0; run < 200; run++) {
      const layout: StitchSequenceLayout = { mode: rnd() < 0.5 ? "track" : "stacked", overlapSec: 1, crossfade: true };
      let timeline = Array.from({ length: 2 + Math.floor(rnd() * 3) }, (_, i) => {
        const inSec = rnd() < 0.5 ? 0 : Math.round(rnd() * 20) / 10;
        const clip = edgeClip(`c${i}`, `e${1 + Math.floor(rnd() * 4)}`, { inSec });
        return rnd() < 0.8 ? retimed(clip, warps[Math.floor(rnd() * warps.length)]) : clip;
      });
      let made = 0;
      for (let op = 0; op < 20; op++) {
        const clip = timeline[Math.floor(rnd() * timeline.length)];
        const total = spansEnd(layoutSpans(timeline, long, layout));
        const t = rnd() * total;
        const value = Math.round(rnd() * 90) / 10;
        const patch = rnd() < 0.5 ? { inSec: value } : { outSec: value };
        const k = Math.floor(rnd() * 6);
        const makeId = () => `n${run}-${made++}`;
        const split = () => splitClipAt(timeline, long, t, makeId, { layout, preferClipId: clip.id })?.timeline;
        if (k === 0) timeline = split() ?? timeline;
        else if (k === 1) timeline = trimClip(timeline, clip.id, long, patch);
        else if (k === 2) timeline = trimClipInPlace(timeline, clip.id, long, patch, 1);
        else if (k === 3) timeline = resetTrim(timeline, clip.id, long);
        else if (k === 4) timeline = resetTrimInPlace(timeline, clip.id, long, 1);
        else timeline = setEdgeAtPlayhead(timeline, long, clip.id, rnd() < 0.5 ? "in" : "out", t, 0) ?? timeline;
        const saved = JSON.stringify(sorted(timeline));
        const loaded = JSON.stringify(sorted(sanitizeTimeline(JSON.parse(saved))));
        if (loaded !== saved) misses.push(`run ${run} op ${op}: ${saved}`);
      }
    }
    expect(misses.slice(0, 3)).toEqual([]);
  });
});

describe("speedLimits", () => {
  it("offers 0.1–10×, never past 10 minutes or under 0.1 s, rounded inward to three figures", () => {
    expect(speedLimits(0.3)).toEqual({ min: 0.1, max: 3 });
    expect(speedLimits(0.37).max).toBe(3.7);
    expect(speedLimits(0.6).max).toBe(6);
    expect(speedLimits(0.15).max).toBe(1.5);
    expect(speedLimits(10)).toEqual({ min: 0.1, max: 10 });
    expect(speedLimits(74).min).toBe(0.124);
    expect(speedLimits(100.3).min).toBe(0.168);
    expect(speedLimits(120).min).toBe(0.2);
    // Never forced above 1×: a long source plays at its own speed
    expect(speedLimits(900)).toEqual({ min: 1, max: 10 });
    // Nor below it: under 0.1 s of source plays under 0.1 s at 1×, as it does unwarped
    expect(speedLimits(0.05)).toEqual({ min: 0.1, max: 1 });
    expect(speedLimits(0.0999)).toEqual({ min: 0.1, max: 1 });
    for (const unknown of [undefined, 0, -1, Number.NaN]) expect(speedLimits(unknown)).toEqual({ min: 0.1, max: 10 });
  });

  it("keeps every clip it allows within its bounds, as three-figure values", () => {
    const rnd = lcg(7);
    for (let i = 0; i < 2000; i++) {
      const len = 10 ** (rnd() * 5 - 1.5);
      const { min, max } = speedLimits(len);
      for (const bound of [min, max]) expect(bound).toBe(Number(bound.toPrecision(3)));
      expect(min).toBeLessThanOrEqual(1);
      expect(max).toBeGreaterThanOrEqual(1);
      if (max > 1) expect(len / max).toBeGreaterThanOrEqual(MIN_CLIP_SEC - 1e-12);
      if (min < 1) expect(len / min).toBeLessThanOrEqual(MAX_START_SEC + 1e-9);
    }
  });
});

describe("updateClipsWarp", () => {
  const d = durations({ "edge:e1": 10, "edge:e2": 120, "edge:e3": 0.3 });
  const timeline = () => [edgeClip("a", "e1"), edgeClip("b", "e2"), edgeClip("c", "e3")];
  const only = (id: string) => new Set([id]);

  it("writes the patched fields through normalizeWarp, the same array for an equal patch", () => {
    const base = timeline();
    const once = updateClipsWarp(base, only("a"), d, { speed: 2 });
    expect(once[0].warp).toEqual({ speed: 2, curve: null, reverse: false, blend: false });
    expect(Object.keys(once[0])).toEqual([...Object.keys(base[0]), "warp"]);
    expect(once[1]).toBe(base[1]);
    expect(updateClipsWarp(once, only("a"), d, { speed: 2 })).toBe(once);
    expect(updateClipsWarp(once, only("a"), d, { reverse: false })).toBe(once);
    // An unknown clip, or no field at all, changes nothing
    expect(updateClipsWarp(once, only("x"), d, { speed: 3 })).toBe(once);
    expect(updateClipsWarp(once, only("a"), d, {})).toBe(once);
  });

  it("removes the key when the patch makes the identity", () => {
    const fast = updateClipsWarp(timeline(), only("a"), d, { speed: 2, blend: true });
    const back = updateClipsWarp(fast, only("a"), d, { speed: 1 });
    expect("warp" in back[0]).toBe(false);
    // A ramp taken away at 1× forward goes too
    const ramp = updateClipsWarp(timeline(), only("a"), d, { curve: QUAD });
    expect("warp" in updateClipsWarp(ramp, only("a"), d, { curve: null })[0]).toBe(false);
    // Not a number keeps the speed
    expect(updateClipsWarp(fast, only("a"), d, { speed: Number.NaN })).toBe(fast);
  });

  it("clamps a patched speed to each clip's own limits, and keeps a stored one outside them", () => {
    const all = new Set(["a", "b", "c"]);
    const slow = updateClipsWarp(timeline(), all, d, { speed: 0.1 });
    expect(slow.map((c) => c.warp?.speed)).toEqual([0.1, 0.2, 0.1]);
    const fast = updateClipsWarp(timeline(), all, d, { speed: 10 });
    expect(fast.map((c) => c.warp?.speed)).toEqual([10, 10, 3]);
    // Unknown length: the rail's range
    expect(updateClipsWarp([edgeClip("u", "e9")], only("u"), d, { speed: 50 })[0].warp?.speed).toBe(10);
    const piece = retimed(edgeClip("p", "e1"), W(0.04, { curve: QUAD, window: [0, 0.3] }));
    const reversed = updateClipsWarp([piece], only("p"), d, { reverse: true })[0];
    expect(reversed.warp).toEqual({ speed: 0.04, curve: QUAD, window: [0, 0.3], reverse: true, blend: false });
  });

  it("always reaches 1×, and never slows a clip holding under 0.1 s of source", () => {
    // 0.05 s of source: unwarped at 1×, and slowed to 0.5×, its least length at that speed
    const short = edgeClip("s", "e1", { inSec: 9.95 });
    const slow = retimed(edgeClip("t", "e1", { outSec: 0.05 }), W(0.5));
    const group = [short, slow, edgeClip("a", "e1")];
    const ids = new Set(["s", "t", "a"]);
    const reset = updateClipsWarp(group, ids, d, { speed: 1, curve: null });
    expect(reset[0]).toBe(short);
    expect("warp" in reset[1]).toBe(false);
    const fast = updateClipsWarp(group, ids, d, { speed: 2 });
    expect(fast[0]).toBe(short);
    expect(fast.map((c) => c.warp?.speed)).toEqual([undefined, undefined, 2]);
  });

  it("drops a split piece's window with a new curve, and keeps it with a new speed", () => {
    const piece = retimed(edgeClip("p", "e1"), W(1.5, { curve: QUAD, window: [0.2, 0.7] }));
    expect(updateClipsWarp([piece], only("p"), d, { curve: QUAD })[0].warp).toEqual(W(1.5, { curve: QUAD }));
    expect(updateClipsWarp([piece], only("p"), d, { speed: 2 })[0].warp).toEqual(W(2, { curve: QUAD, window: [0.2, 0.7] }));
  });
});
