import { describe, it, expect } from "vitest";
import type { StitchTimelineClip, VideoStitchNodeData } from "@/types";
import { createDefaultNodeData } from "@/store/utils/nodeDefaults";
import { draftPatch, readStitchDraft, sameDraft, type StitchDraft } from "../draft";
import { createClip } from "../timeline";

const edgeClip = (id: string, edgeId: string, init: Partial<StitchTimelineClip> = {}) =>
  createClip({ kind: "edge", edgeId }, { id, ...init });

const nodeData = (overrides: Partial<VideoStitchNodeData> = {}): VideoStitchNodeData => ({
  ...(createDefaultNodeData("videoStitch") as VideoStitchNodeData),
  ...overrides,
});

describe("readStitchDraft", () => {
  it("reads a legacy node without music as unmuted clips, a flat curve and loop 1", () => {
    const draft = readStitchDraft(nodeData({ clipOrder: ["e2", "e1"] }), { liveEdgeIds: ["e1", "e2"], hasMusic: false });
    expect(draft).toEqual({
      timeline: [edgeClip("clip:e2", "e2"), edgeClip("clip:e1", "e1")],
      audioCurve: [],
      audioMuted: false,
      loopCount: 1,
    });
  });

  it("reads a legacy node with music as muted clips", () => {
    const draft = readStitchDraft(nodeData({ clipOrder: ["e1"], loopCount: 3 }), { liveEdgeIds: ["e1"], hasMusic: true });
    expect(draft.timeline.map((c) => c.muted)).toEqual([true]);
    expect(draft.loopCount).toBe(3);
  });

  it("reads a timeline node's own sequence, curve and mute", () => {
    const timeline = [edgeClip("a", "e1", { inSec: 1, outSec: 3 })];
    const draft = readStitchDraft(
      nodeData({
        clipOrder: ["e1"],
        timeline,
        audioCurve: [{ t: 2, gain: 0.5 }, { t: 0, gain: 1 }],
        audioMuted: true,
        loopCount: 2,
      }),
      { liveEdgeIds: ["e1"], hasMusic: true },
    );
    expect(draft).toEqual({
      timeline,
      audioCurve: [{ t: 0, gain: 1 }, { t: 2, gain: 0.5 }],
      audioMuted: true,
      loopCount: 2,
    });
  });

  it("falls back to loop 1 for a bad loop count", () => {
    const data = { ...nodeData(), loopCount: 7 } as unknown as VideoStitchNodeData;
    expect(readStitchDraft(data, { liveEdgeIds: [], hasMusic: false }).loopCount).toBe(1);
  });

  describe("a video connected to a timeline node", () => {
    it("follows the clips when every one is muted under music", () => {
      const data = nodeData({ timeline: [edgeClip("a", "e1", { muted: true })] });
      const draft = readStitchDraft(data, { liveEdgeIds: ["e1", "e2"], hasMusic: true });
      expect(draft.timeline[1]).toMatchObject({ id: "clip:e2", muted: true });
    });

    it("comes in unmuted when one clip has its sound", () => {
      const data = nodeData({ timeline: [edgeClip("a", "e1", { muted: true }), edgeClip("b", "e3")] });
      const draft = readStitchDraft(data, { liveEdgeIds: ["e1", "e3", "e2"], hasMusic: true });
      expect(draft.timeline[2]).toMatchObject({ id: "clip:e2", muted: false });
    });

    it("ignores the clips of a vanished edge when deciding", () => {
      const data = nodeData({ timeline: [edgeClip("a", "e1", { muted: true }), edgeClip("b", "e2")] });
      const draft = readStitchDraft(data, { liveEdgeIds: ["e1", "e3"], hasMusic: true });
      expect(draft.timeline.map((c) => [c.id, c.muted])).toEqual([
        ["a", true],
        ["clip:e3", true],
      ]);
    });

    it("comes in unmuted without music", () => {
      const data = nodeData({ timeline: [edgeClip("a", "e1", { muted: true })] });
      const draft = readStitchDraft(data, { liveEdgeIds: ["e1", "e2"], hasMusic: false });
      expect(draft.timeline[1].muted).toBe(false);
    });

    it("comes in unmuted into an emptied timeline", () => {
      const draft = readStitchDraft(nodeData({ timeline: [] }), { liveEdgeIds: ["e1"], hasMusic: true });
      expect(draft.timeline).toEqual([edgeClip("clip:e1", "e1")]);
    });
  });
});

describe("sameDraft", () => {
  const base: StitchDraft = {
    timeline: [edgeClip("a", "e1")],
    audioCurve: [{ t: 0, gain: 1 }],
    audioMuted: false,
    loopCount: 1,
  };

  it("compares by value", () => {
    expect(sameDraft(base, { ...base, timeline: [edgeClip("a", "e1")], audioCurve: [{ t: 0, gain: 1 }] })).toBe(true);
  });

  it("sees each kind of change", () => {
    expect(sameDraft(base, { ...base, loopCount: 2 })).toBe(false);
    expect(sameDraft(base, { ...base, audioMuted: true })).toBe(false);
    expect(sameDraft(base, { ...base, audioCurve: [] })).toBe(false);
    expect(sameDraft(base, { ...base, timeline: [edgeClip("a", "e1", { outSec: 2 })] })).toBe(false);
    expect(sameDraft(base, { ...base, timeline: [edgeClip("a", "e1", { inSec: 1 })] })).toBe(false);
    expect(sameDraft(base, { ...base, timeline: [edgeClip("a", "e1", { muted: true })] })).toBe(false);
    expect(sameDraft(base, { ...base, timeline: [edgeClip("a", "e1", { volume: 0.5 })] })).toBe(false);
    expect(sameDraft(base, { ...base, timeline: [edgeClip("b", "e1")] })).toBe(false);
    expect(sameDraft(base, { ...base, timeline: [edgeClip("a", "e2")] })).toBe(false);
    expect(sameDraft(base, { ...base, timeline: [createClip({ kind: "asset", assetId: "e1" }, { id: "a" })] })).toBe(false);
    expect(sameDraft(base, { ...base, timeline: [] })).toBe(false);
  });
});

describe("draftPatch", () => {
  it("writes the draft with clipOrder in sync", () => {
    const timeline = [
      edgeClip("b", "e2"),
      createClip({ kind: "asset", assetId: "x" }, { id: "x" }),
      edgeClip("a", "e1"),
      edgeClip("b2", "e2"),
    ];
    expect(draftPatch({ timeline, audioCurve: [], audioMuted: true, loopCount: 2 })).toEqual({
      timeline,
      audioCurve: [],
      audioMuted: true,
      loopCount: 2,
      clipOrder: ["e2", "e1"],
    });
  });
});
