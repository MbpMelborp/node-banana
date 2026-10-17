import { describe, it, expect } from "vitest";
import type { StitchTimelineClip, VideoStitchNodeData } from "@/types";
import { createDefaultNodeData } from "@/store/utils/nodeDefaults";
import {
  draftDuration,
  draftPatch,
  draftSpans,
  readSequenceLayout,
  readStitchDraft,
  sameDraft,
  sameLayout,
  type StitchDraft,
} from "../draft";
import { DEFAULT_SEQUENCE_LAYOUT } from "../stack";
import { createClip, type SourceKey } from "../timeline";

const TRACK_LAYOUT = DEFAULT_SEQUENCE_LAYOUT;
const STACKED = { mode: "stacked", overlapSec: 1, crossfade: true } as const;

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
      sequenceLayout: TRACK_LAYOUT,
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
      sequenceLayout: TRACK_LAYOUT,
    });
  });

  it("keeps the clips' starts", () => {
    const timeline = [edgeClip("a", "e1", { startSec: 2.5 }), edgeClip("b", "e2")];
    const draft = readStitchDraft(nodeData({ clipOrder: ["e1", "e2"], timeline }), { liveEdgeIds: ["e1", "e2"], hasMusic: false });
    expect(draft.timeline.map((c) => c.startSec)).toEqual([2.5, undefined]);
    expect("startSec" in draft.timeline[1]).toBe(false);
  });

  it("reads a timeline node's layout, and a legacy node's as Track with its values kept", () => {
    const timeline = [edgeClip("a", "e1")];
    const stacked = { mode: "stacked", overlapSec: 2, crossfade: false } as const;
    const ctx = { liveEdgeIds: ["e1"], hasMusic: false };
    expect(readStitchDraft(nodeData({ timeline, sequenceLayout: stacked }), ctx).sequenceLayout).toEqual(stacked);
    expect(readStitchDraft(nodeData({ clipOrder: ["e1"], sequenceLayout: stacked }), ctx).sequenceLayout).toEqual({
      ...stacked,
      mode: "track",
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

describe("readSequenceLayout", () => {
  it("reads absent and junk as Track, 1.0 s, crossfade on", () => {
    for (const raw of [undefined, null, 3, "stacked", [], true]) {
      expect(readSequenceLayout(raw, false)).toEqual({ mode: "track", overlapSec: 1, crossfade: true });
    }
  });

  it("reads stacked only from the exact string", () => {
    expect(readSequenceLayout({ mode: "stacked" }, false).mode).toBe("stacked");
    expect(readSequenceLayout({ mode: "STACKED" }, false).mode).toBe("track");
    expect(readSequenceLayout({ mode: "layers" }, false).mode).toBe("track");
  });

  it("clamps and rounds the overlap, and falls back to 1.0 s when it is not a number", () => {
    expect(readSequenceLayout({ overlapSec: 1.04 }, false).overlapSec).toBe(1);
    expect(readSequenceLayout({ overlapSec: 0.25 }, false).overlapSec).toBe(0.3);
    expect(readSequenceLayout({ overlapSec: 12 }, false).overlapSec).toBe(10);
    expect(readSequenceLayout({ overlapSec: -1 }, false).overlapSec).toBe(0);
    expect(readSequenceLayout({ overlapSec: Number.NaN }, false).overlapSec).toBe(1);
    expect(readSequenceLayout({ overlapSec: "2" }, false).overlapSec).toBe(1);
  });

  it("keeps the crossfade on unless it is exactly false", () => {
    expect(readSequenceLayout({ crossfade: false }, false).crossfade).toBe(false);
    expect(readSequenceLayout({ crossfade: 0 }, false).crossfade).toBe(true);
    expect(readSequenceLayout({ crossfade: true }, false).crossfade).toBe(true);
    expect(readSequenceLayout({}, false).crossfade).toBe(true);
  });

  it("forces a legacy node to Track and keeps its values", () => {
    expect(readSequenceLayout({ mode: "stacked", overlapSec: 2, crossfade: false }, true)).toEqual({
      mode: "track",
      overlapSec: 2,
      crossfade: false,
    });
  });

  it("never hands out the shared default", () => {
    const read = readSequenceLayout(undefined, false);
    expect(read).not.toBe(DEFAULT_SEQUENCE_LAYOUT);
  });
});

describe("sameLayout", () => {
  it("compares the three fields", () => {
    expect(sameLayout(STACKED, { ...STACKED })).toBe(true);
    expect(sameLayout(STACKED, { ...STACKED, mode: "track" })).toBe(false);
    expect(sameLayout(STACKED, { ...STACKED, overlapSec: 1.1 })).toBe(false);
    expect(sameLayout(STACKED, { ...STACKED, crossfade: false })).toBe(false);
  });
});

describe("draftSpans and draftDuration", () => {
  const durations = new Map<SourceKey, number>([
    ["edge:e1", 5],
    ["edge:e2", 5],
    ["edge:e3", 6],
  ]);
  const timeline = [edgeClip("a", "e1"), edgeClip("b", "e2"), edgeClip("c", "e3")];

  it("butts the clips in Track, whatever overlap is kept", () => {
    const d = { timeline, sequenceLayout: { ...STACKED, mode: "track" as const } };
    expect(draftSpans(d, durations).map((s) => s.start)).toEqual([0, 5, 10]);
    expect(draftDuration(d, durations)).toBe(16);
  });

  it("overlaps them in Stacked", () => {
    const d = { timeline, sequenceLayout: STACKED };
    expect(draftSpans(d, durations).map((s) => s.start)).toEqual([0, 4, 8]);
    expect(draftDuration(d, durations)).toBe(14);
  });

  it("places them where they were put once one has a start, and ignores the starts in Track", () => {
    const placed = [edgeClip("a", "e1", { startSec: 3 }), edgeClip("b", "e2", { startSec: 0 }), edgeClip("c", "e3")];
    const d = { timeline: placed, sequenceLayout: STACKED };
    // c is unpinned: Overlap before the latest end above it (a's, at 8)
    expect(draftSpans(d, durations).map((s) => s.start)).toEqual([3, 0, 7]);
    expect(draftSpans(d, durations).every((s) => s.overlapIn === 0 && s.overlapOut === 0)).toBe(true);
    expect(draftDuration(d, durations)).toBe(13);
    expect(draftSpans({ ...d, sequenceLayout: { ...STACKED, mode: "track" } }, durations).map((s) => s.start)).toEqual([
      0, 5, 10,
    ]);
  });

  it("does not lengthen the loop for an empty clip placed past the end", () => {
    const d = { timeline: [edgeClip("a", "e1", { startSec: 0 }), edgeClip("x", "e9", { startSec: 20 })], sequenceLayout: STACKED };
    expect(draftSpans(d, durations)[1].start).toBe(20);
    expect(draftDuration(d, durations)).toBe(5);
  });
});

describe("sameDraft", () => {
  const base: StitchDraft = {
    timeline: [edgeClip("a", "e1")],
    audioCurve: [{ t: 0, gain: 1 }],
    audioMuted: false,
    loopCount: 1,
    sequenceLayout: TRACK_LAYOUT,
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
    expect(sameDraft(base, { ...base, timeline: [edgeClip("a", "e1", { startSec: 0 })] })).toBe(false);
    expect(
      sameDraft(
        { ...base, timeline: [edgeClip("a", "e1", { startSec: 2 })] },
        { ...base, timeline: [edgeClip("a", "e1", { startSec: 2.5 })] },
      ),
    ).toBe(false);
    expect(
      sameDraft(
        { ...base, timeline: [edgeClip("a", "e1", { startSec: 2 })] },
        { ...base, timeline: [edgeClip("a", "e1", { startSec: 2 })] },
      ),
    ).toBe(true);
    expect(sameDraft(base, { ...base, timeline: [edgeClip("b", "e1")] })).toBe(false);
    expect(sameDraft(base, { ...base, timeline: [edgeClip("a", "e2")] })).toBe(false);
    expect(sameDraft(base, { ...base, timeline: [createClip({ kind: "asset", assetId: "e1" }, { id: "a" })] })).toBe(false);
    expect(sameDraft(base, { ...base, timeline: [] })).toBe(false);
    expect(sameDraft(base, { ...base, sequenceLayout: { ...TRACK_LAYOUT, mode: "stacked" } })).toBe(false);
    expect(sameDraft(base, { ...base, sequenceLayout: { ...TRACK_LAYOUT, overlapSec: 2 } })).toBe(false);
    expect(sameDraft(base, { ...base, sequenceLayout: { ...TRACK_LAYOUT, crossfade: false } })).toBe(false);
    expect(sameDraft(base, { ...base, sequenceLayout: { ...TRACK_LAYOUT } })).toBe(true);
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
    expect(
      draftPatch({ timeline, audioCurve: [], audioMuted: true, loopCount: 2, sequenceLayout: TRACK_LAYOUT }),
    ).toEqual({
      timeline,
      audioCurve: [],
      audioMuted: true,
      loopCount: 2,
      sequenceLayout: TRACK_LAYOUT,
      clipOrder: ["e2", "e1"],
    });
  });

  it("round-trips the layout through readStitchDraft, as a copy", () => {
    const d: StitchDraft = {
      timeline: [edgeClip("a", "e1")],
      audioCurve: [],
      audioMuted: false,
      loopCount: 1,
      sequenceLayout: { mode: "stacked", overlapSec: 2.5, crossfade: false },
    };
    const patch = draftPatch(d);
    expect(patch.sequenceLayout).not.toBe(d.sequenceLayout);
    const back = readStitchDraft({ ...nodeData(), ...patch }, { liveEdgeIds: ["e1"], hasMusic: false });
    expect(sameDraft(back, d)).toBe(true);
  });
});
