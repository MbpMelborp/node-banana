import { describe, it, expect } from "vitest";
import type { StitchTimelineClip } from "@/types";
import {
  END_EPSILON_SEC,
  MIN_CLIP_SEC,
  appendClips,
  clampTrim,
  clipAtTime,
  clipLength,
  clipSpans,
  createClip,
  edgeIdsInOrder,
  moveClip,
  neighbourTarget,
  removeClip,
  resetTrim,
  sequenceDuration,
  setEdgeAtPlayhead,
  snapTo,
  sourceKey,
  splitClipAt,
  trimClip,
  updateClipAudio,
  type SourceDurations,
  type SourceKey,
} from "../timeline";

const edgeClip = (id: string, edgeId: string, init: Partial<StitchTimelineClip> = {}) =>
  createClip({ kind: "edge", edgeId }, { id, ...init });
const assetClip = (id: string, assetId: string) => createClip({ kind: "asset", assetId }, { id });

function durations(entries: Record<string, number>): SourceDurations {
  return new Map(Object.entries(entries) as [SourceKey, number][]);
}

// Three clips of 5, 4 and 6 seconds: spans 0–5, 5–9, 9–15.
const three = () => [edgeClip("a", "e1"), edgeClip("b", "e2"), edgeClip("c", "e3")];
const threeDurations = durations({ "edge:e1": 5, "edge:e2": 4, "edge:e3": 6 });

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
});

describe("sequenceDuration and clipSpans", () => {
  it("sums the trimmed lengths", () => {
    const timeline = [edgeClip("a", "e1", { inSec: 1 }), edgeClip("b", "e2", { outSec: 2 }), edgeClip("c", "e3")];
    expect(sequenceDuration(timeline, threeDurations)).toBe(4 + 2 + 6);
  });

  it("keeps zero-length spans in place", () => {
    const spans = clipSpans([edgeClip("a", "e1"), edgeClip("x", "missing"), edgeClip("c", "e3")], threeDurations);
    expect(spans.map((s) => [s.start, s.end])).toEqual([[0, 5], [5, 5], [5, 11]]);
  });
});

describe("clipAtTime", () => {
  it("returns the next clip at a boundary", () => {
    expect(clipAtTime(three(), threeDurations, 5)?.clip.id).toBe("b");
  });

  it("skips zero-length spans", () => {
    const timeline = [edgeClip("a", "e1"), edgeClip("x", "missing"), edgeClip("c", "e3")];
    expect(clipAtTime(timeline, threeDurations, 5)?.clip.id).toBe("c");
  });

  it("gives the last clip at or past the end and the first before the start", () => {
    expect(clipAtTime(three(), threeDurations, 15)?.clip.id).toBe("c");
    expect(clipAtTime(three(), threeDurations, 99)?.clip.id).toBe("c");
    // An empty span at either end (a source not generated yet) is never the answer
    expect(clipAtTime([edgeClip("a", "e1"), edgeClip("x", "missing")], threeDurations, 99)?.clip.id).toBe("a");
    expect(clipAtTime([edgeClip("x", "missing"), edgeClip("c", "e3")], threeDurations, -1)?.clip.id).toBe("c");
    expect(clipAtTime(three(), threeDurations, -1)?.clip.id).toBe("a");
  });

  it("is null for an empty timeline or one with only empty clips", () => {
    expect(clipAtTime([], threeDurations, 0)).toBeNull();
    expect(clipAtTime([edgeClip("x", "missing")], threeDurations, 0)).toBeNull();
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
    const withIn = setEdgeAtPlayhead(timeline, threeDurations, "b", "in", 6);
    expect(withIn).not.toBe(timeline);
    expect(withIn![1]).toMatchObject({ inSec: 1, outSec: null });
    const withOut = setEdgeAtPlayhead(timeline, threeDurations, "b", "out", 7);
    expect(withOut![1]).toMatchObject({ inSec: 0, outSec: 2 });
  });

  it("is null when the playhead is outside the clip", () => {
    expect(setEdgeAtPlayhead(three(), threeDurations, "b", "in", 12)).toBeNull();
    expect(setEdgeAtPlayhead(three(), threeDurations, "missing", "in", 6)).toBeNull();
    expect(setEdgeAtPlayhead(three(), threeDurations, "b", "in", NaN)).toBeNull();
    expect(setEdgeAtPlayhead(three(), threeDurations, "b", "out", Infinity)).toBeNull();
  });

  it("is null for Out at the clip's start and In at its end", () => {
    expect(setEdgeAtPlayhead(three(), threeDurations, "b", "out", 5)).toBeNull();
    expect(setEdgeAtPlayhead(three(), threeDurations, "b", "in", 9)).toBeNull();
    // The near boundary still counts
    expect(setEdgeAtPlayhead(three(), threeDurations, "b", "out", 9)![1]).toMatchObject({ inSec: 0 });
    expect(setEdgeAtPlayhead(three(), threeDurations, "b", "in", 5)![1]).toMatchObject({ inSec: 0 });
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
    const spans = clipSpans(three(), threeDurations);
    expect(neighbourTarget(spans, "a", "out")).toEqual({ t: 5, kind: "edge", label: "Clip 2" });
    expect(neighbourTarget(spans, "c", "in")).toEqual({ t: 9, kind: "edge", label: "Clip 2" });
  });

  it("is null at the sequence's ends", () => {
    const spans = clipSpans(three(), threeDurations);
    expect(neighbourTarget(spans, "c", "out")).toBeNull();
    expect(neighbourTarget(spans, "a", "in")).toBeNull();
  });

  it("skips empty clips", () => {
    const spans = clipSpans([edgeClip("a", "e1"), edgeClip("x", "missing"), edgeClip("c", "e3")], threeDurations);
    expect(neighbourTarget(spans, "a", "out")).toEqual({ t: 5, kind: "edge", label: "Clip 3" });
    expect(neighbourTarget(spans, "c", "in")).toEqual({ t: 5, kind: "edge", label: "Clip 1" });
  });
});
