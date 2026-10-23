import { describe, expect, it } from "vitest";
import type { ClipWarp, StitchSequenceLayout, StitchTimelineClip } from "@/types";
import type { StitchOptions } from "../engineTypes";
import { frameClips, frameOptions } from "../framePlan";
import { pictureSegments } from "../placedSchedule";
import { planPicture, type PictureClip } from "../picturePlan";
import { layoutSpans, sourceKey, spansEnvelope, splitClipAt, type SourceKey } from "../timeline";
import { normalizeWarp, withWarp } from "../warp";

const clip = (sourceDuration: number, init: Partial<PictureClip> = {}): PictureClip => ({
  inSec: 0,
  outSec: null,
  sourceDuration,
  firstTimestamp: 0,
  ...init,
});

const stacked: StitchOptions = { overlapSec: 1, crossfade: true };
const placed: StitchOptions = { overlapSec: 1, crossfade: true, placed: true };

describe("planPicture", () => {
  it("plans Track: clips butted, no stack, no envelope; a clip without video is dropped", () => {
    const p = planPicture([clip(5, { source: "a" }), clip(0, { source: "x" }), clip(3, { source: "b", inSec: 1 })], {});
    expect(p.route).toEqual({ kind: "track" });
    expect(p.sp).toBeNull();
    expect(p.env).toBeNull();
    expect(p.planned.map((u) => [u.index, u.seqStart, u.length])).toEqual([
      [0, 0, 5],
      [2, 5, 2],
    ]);
    expect(p.sources).toEqual(["a", "b"]);
    expect(p.loopLength).toBe(7);
  });

  it("plans a lined-up stack when a join overlaps, and a split as Track", () => {
    const derived = planPicture([clip(5, { source: "a" }), clip(5, { source: "b" })], stacked);
    expect(derived.route).toEqual({ kind: "derived" });
    expect(derived.sp?.dissolves).toHaveLength(1);
    expect(derived.loopLength).toBe(9);

    const split = planPicture([clip(5, { source: "a", outSec: 2.5 }), clip(5, { source: "a", inSec: 2.5 })], stacked);
    expect(split.sp).toBeNull();
    expect(split.route).toEqual({ kind: "track" });
    expect(split.loopLength).toBe(5);
  });

  it("routes a placed stack: anywhere is placed, Track's starts are Track, the stack's are derived", () => {
    const anywhere = planPicture([clip(5, { source: "a", startSec: 0 }), clip(5, { source: "b", startSec: 6 })], placed);
    expect(anywhere.route).toEqual({ kind: "placed", starts: [0, 6] });
    expect(anywhere.env?.units.map((u) => u.row)).toEqual([0, 1]);
    expect(anywhere.loopLength).toBe(11);

    expect(planPicture([clip(5, { source: "a", startSec: 0 }), clip(5, { source: "b", startSec: 5 })], placed).route).toEqual({
      kind: "track",
    });
    const lined = planPicture([clip(5, { source: "a", startSec: 0 }), clip(5, { source: "b", startSec: 4 })], placed);
    expect(lined.route).toEqual({ kind: "derived" });
    expect(lined.sp?.dissolves).toEqual([{ outgoing: 0, incoming: 1, fromSec: 4, toSec: 5 }]);
  });

  it("keys a legacy node's clips by position", () => {
    expect(planPicture([clip(5), clip(0), clip(5)], {}).sources).toEqual(["#0", "#2"]);
  });

  // The harness fixtures' clips, with the numbers stitchVideosAsync's own planning gave them before the move
  const A = "edge:A";
  const B = "edge:B";
  const pinned: Array<{
    name: string;
    clips: PictureClip[];
    options: StitchOptions;
    route: unknown;
    starts: number[];
    loopLength: number;
    sources: string[];
    dissolves: unknown;
    segments: unknown;
  }> = [
    {
      name: "two-clips",
      clips: [clip(5), clip(5)],
      options: {},
      route: { kind: "track" },
      starts: [0, 5],
      loopLength: 10,
      sources: ["#0", "#1"],
      dissolves: null,
      segments: null,
    },
    {
      name: "stacked-two",
      clips: [clip(5, { source: A }), clip(5, { source: B })],
      options: stacked,
      route: { kind: "derived" },
      starts: [0, 5],
      loopLength: 9,
      sources: [A, B],
      dissolves: [{ outgoing: 0, incoming: 1, fromSec: 4, toSec: 5 }],
      segments: null,
    },
    {
      name: "stacked-allcut",
      clips: [clip(5, { source: A, outSec: 2.5 }), clip(5, { source: A, inSec: 2.5 })],
      options: stacked,
      route: { kind: "track" },
      starts: [0, 2.5],
      loopLength: 5,
      sources: [A, A],
      dissolves: null,
      segments: null,
    },
    {
      name: "stacked-two-cut",
      clips: [clip(5, { source: A }), clip(5, { source: B })],
      options: { overlapSec: 1, crossfade: false },
      route: { kind: "derived" },
      starts: [0, 5],
      loopLength: 9,
      sources: [A, B],
      dissolves: [],
      segments: null,
    },
    {
      name: "placed-board",
      clips: [
        clip(5, { source: A, startSec: 0 }),
        clip(5, { source: B, inSec: 0.8, startSec: 6 }),
        clip(6, { source: "edge:C", startSec: 9.2 }),
        clip(5, { source: "edge:D", outSec: 3.2, startSec: 11 }),
      ],
      options: placed,
      route: { kind: "placed", starts: [0, 6, 9.2, 11] },
      starts: [0, 5, 9.2, 15.2],
      loopLength: 15.2,
      sources: [A, B, "edge:C", "edge:D"],
      dissolves: null,
      segments: [
        { kind: "solo", unit: 0, fromSec: 0, toSec: 5 },
        { kind: "black", fromSec: 5, toSec: 6 },
        { kind: "solo", unit: 1, fromSec: 6, toSec: 9.2 },
        { kind: "blend", units: [2, 1], fromSec: 9.2, toSec: 10.2 },
        { kind: "solo", unit: 2, fromSec: 10.2, toSec: 15.2 },
      ],
    },
    {
      name: "placed-equal-track",
      clips: [clip(5, { source: A, startSec: 0 }), clip(5, { source: B, startSec: 5 })],
      options: placed,
      route: { kind: "track" },
      starts: [0, 5],
      loopLength: 10,
      sources: [A, B],
      dissolves: null,
      segments: null,
    },
    {
      name: "placed-equal-derived",
      clips: [clip(5, { source: A, startSec: 0 }), clip(5, { source: B, startSec: 4 })],
      options: placed,
      route: { kind: "derived" },
      starts: [0, 5],
      loopLength: 9,
      sources: [A, B],
      dissolves: [{ outgoing: 0, incoming: 1, fromSec: 4, toSec: 5 }],
      segments: null,
    },
    {
      name: "placed-unpinned",
      clips: [clip(5, { source: A, startSec: 1 }), clip(5, { source: B })],
      options: placed,
      route: { kind: "placed", starts: [1, 5] },
      starts: [0, 5],
      loopLength: 10,
      sources: [A, B],
      dissolves: null,
      segments: [
        { kind: "black", fromSec: 0, toSec: 1 },
        { kind: "solo", unit: 0, fromSec: 1, toSec: 5 },
        { kind: "blend", units: [1, 0], fromSec: 5, toSec: 6 },
        { kind: "solo", unit: 1, fromSec: 6, toSec: 10 },
      ],
    },
    {
      name: "placed-unpinned-derived",
      clips: [clip(5, { source: A, startSec: 0 }), clip(5, { source: B })],
      options: placed,
      route: { kind: "derived" },
      starts: [0, 5],
      loopLength: 9,
      sources: [A, B],
      dissolves: [{ outgoing: 0, incoming: 1, fromSec: 4, toSec: 5 }],
      segments: null,
    },
    {
      name: "node-board-legacy",
      clips: [clip(5), clip(5), clip(6), clip(5)],
      options: {},
      route: { kind: "track" },
      starts: [0, 5, 10, 16],
      loopLength: 21,
      sources: ["#0", "#1", "#2", "#3"],
      dissolves: null,
      segments: null,
    },
  ];

  describe("retimed clips", () => {
    const W = (speed: number, extra: Partial<ClipWarp> = {}): ClipWarp => ({ speed, curve: null, reverse: false, blend: false, ...extra });
    const STACKED: StitchSequenceLayout = { mode: "stacked", overlapSec: 1, crossfade: true };
    const edgeClip = (id: string, extra: Partial<StitchTimelineClip> = {}): StitchTimelineClip => ({
      id,
      source: { kind: "edge", edgeId: id },
      inSec: 0,
      outSec: null,
      muted: false,
      volume: 1,
      ...extra,
    });
    const retimed = (clip: StitchTimelineClip, warp: ClipWarp) => withWarp(clip, normalizeWarp(warp));

    it("overlaps a lined-up stack by the warped lengths", () => {
      const p = planPicture([clip(4, { source: "a", warp: W(2) }), clip(2, { source: "b", warp: W(0.5) })], stacked);
      expect(p.planned.map((u) => u.length)).toEqual([2, 4]);
      expect(p.sp?.dissolves).toEqual([{ outgoing: 0, incoming: 1, fromSec: 1, toSec: 2 }]);
      expect(p.loopLength).toBe(5);
    });

    it("builds the editor's envelope: a retimed unit's sourceEnds, and a split ramp as one run", () => {
      const ramp = W(0.5, { curve: { kind: "preset", name: "easeInOutCubic" } });
      const lengths: Record<string, number> = { a: 6, b: 4, c: 5 };
      const durations = (timeline: StitchTimelineClip[]) =>
        new Map<SourceKey, number>(timeline.map((c) => [sourceKey(c.source), lengths[c.source.kind === "edge" ? c.source.edgeId : ""]]));
      const base = [
        retimed(edgeClip("a", { inSec: 1, startSec: 0 }), ramp),
        retimed(edgeClip("b", { startSec: 8.5 }), W(2, { reverse: true })),
        edgeClip("c", { startSec: 12 }),
      ];
      // The ramp split at 3 s of its 10: its pieces butt on the timeline and continue in the source
      let id = 0;
      const split = splitClipAt(base, durations(base), 3, () => `piece${id++}`, { layout: STACKED })!.timeline;
      expect(split).toHaveLength(4);
      for (const timeline of [base, split]) {
        const d = durations(timeline);
        const spans = layoutSpans(timeline, d, STACKED);
        const editor = spansEnvelope(spans, true);
        const clips = frameClips(timeline, d, () => "src", true);
        const p = planPicture(clips.map((c) => ({ ...c, sourceDuration: c.duration })), frameOptions(STACKED, timeline));
        expect(p.route.kind).toBe("placed");
        const units = (env: typeof editor) => env.units.map(({ start, length, source, inSec, sourceEnds }) => ({ start, length, source, inSec, sourceEnds }));
        expect(units(p.env!)).toEqual(units(editor));
        expect(p.env!.runOf).toEqual(editor.runOf);
      }
      const p = planPicture(
        frameClips(split, durations(split), () => "src", true).map((c) => ({ ...c, sourceDuration: c.duration })),
        frameOptions(STACKED, split),
      );
      expect(p.env!.units[0].sourceEnds).toEqual([1, expect.any(Number)]);
      expect(p.env!.units[2].sourceEnds).toEqual([4, 0]);
      expect("sourceEnds" in p.env!.units[3]).toBe(false);
      expect(p.env!.runOf[0]).toBe(p.env!.runOf[1]);
    });
  });

  it.each(pinned)("plans $name as Render did before the move", ({ clips, options, ...expected }) => {
    const p = planPicture(clips, options);
    expect(p.route).toEqual(expected.route);
    expect(p.planned.map((u) => u.seqStart)).toEqual(expected.starts);
    expect(p.loopLength).toBeCloseTo(expected.loopLength, 12);
    expect(p.sources).toEqual(expected.sources);
    expect(p.sp?.dissolves ?? null).toEqual(expected.dissolves);
    expect(p.env ? pictureSegments(p.env) : null).toEqual(expected.segments);
  });
});
