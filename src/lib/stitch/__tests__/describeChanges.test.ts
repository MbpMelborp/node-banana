import { describe, expect, it } from "vitest";
import type { StitchTimelineClip } from "@/types";
import { describeDraftChanges, type StitchDraft } from "../draft";
import { DEFAULT_SEQUENCE_LAYOUT } from "../stack";
import { createClip, splitClipAt, type SourceKey } from "../timeline";

const clip = (id: string, edgeId: string, init: Partial<StitchTimelineClip> = {}) =>
  createClip({ kind: "edge", edgeId }, { id, ...init });

const draft = (timeline: StitchTimelineClip[], rest: Partial<StitchDraft> = {}): StitchDraft => ({
  timeline,
  audioCurve: [],
  audioMuted: false,
  loopCount: 1,
  sequenceLayout: DEFAULT_SEQUENCE_LAYOUT,
  ...rest,
});

const base = draft([clip("a", "e1"), clip("b", "e2"), clip("c", "e3")]);
const LOST = " will be lost. The node keeps what it had.";
const durations = new Map<SourceKey, number>([
  ["edge:e1", 5],
  ["edge:e2", 4],
  ["edge:e3", 3],
]);

describe("describeDraftChanges", () => {
  it("reads the board's sentence", () => {
    const edited = draft([clip("b", "e2", { inSec: 1 }), clip("a", "e1", { outSec: 3 }), clip("c", "e3")], {
      audioCurve: [{ t: 2, gain: 0.25 }],
    });
    expect(describeDraftChanges(base, edited)).toBe(`Two trims, a new order and the volume curve${LOST}`);
  });

  it("uses the singular with its article", () => {
    const edited = draft([clip("a", "e1", { inSec: 1, muted: true, volume: 0.5 }), clip("b", "e2"), clip("c", "e3")], {
      audioMuted: true,
      loopCount: 2,
    });
    expect(describeDraftChanges(base, edited)).toBe(
      `A trim, a muted clip, a clip volume, the music mute and the loop count${LOST}`,
    );
  });

  it("tells splits from added clips, and counts removals and unmutes", () => {
    const initial = draft([clip("a", "e1", { muted: true }), clip("b", "e2"), clip("c", "e3")]);
    // A real split's shape: the left piece keeps its id and ends at the cut, the right piece starts there
    const edited = draft([
      clip("a", "e1", { outSec: 2 }),
      clip("a2", "e1", { inSec: 2 }),
      clip("x", "e9"),
      createClip({ kind: "asset", assetId: "lib1" }, { id: "y" }),
    ]);
    expect(describeDraftChanges(initial, edited)).toBe(
      `A split, an unmuted clip, two added clips and two removed clips${LOST}`,
    );
  });

  it("counts a split as a split, not also as a trim of its left piece", () => {
    const once = splitClipAt(base.timeline, durations, 2, () => "a2")!;
    expect(describeDraftChanges(base, draft(once.timeline))).toBe(`A split${LOST}`);
    // The left piece split again: two splits, still no trim
    const twice = splitClipAt(once.timeline, durations, 1, () => "a3")!;
    expect(describeDraftChanges(base, draft(twice.timeline))).toBe(`Two splits${LOST}`);
    // A split inside a trimmed clip leaves its In alone; the Out it had (not to the end) is still reached
    const trimmed = draft([clip("a", "e1", { outSec: 4 }), clip("b", "e2"), clip("c", "e3")]);
    const inner = splitClipAt(trimmed.timeline, durations, 2, () => "a2")!;
    expect(describeDraftChanges(trimmed, draft(inner.timeline))).toBe(`A split${LOST}`);
  });

  it("still counts a trim made after a split", () => {
    const split = splitClipAt(base.timeline, durations, 2, () => "a2")!.timeline;
    const edited = split.map((c) => (c.id === "a" ? { ...c, inSec: 0.5 } : c));
    expect(describeDraftChanges(base, draft(edited))).toBe(`A trim and a split${LOST}`);
  });

  it("writes counts of ten and more as digits", () => {
    const many = Array.from({ length: 10 }, (_, i) => clip(`c${i}`, `e${i}`));
    expect(describeDraftChanges(draft(many), draft([]))).toBe(`10 removed clips${LOST}`);
  });

  it("names a layout change and which way it went, after the loop count", () => {
    const stacked = { mode: "stacked" as const, overlapSec: 2, crossfade: true };
    expect(describeDraftChanges(base, draft(base.timeline, { sequenceLayout: stacked }))).toBe(
      `The switch to Stacked and the overlap${LOST}`,
    );
    expect(
      describeDraftChanges(
        draft(base.timeline, { sequenceLayout: stacked }),
        draft(base.timeline, { sequenceLayout: { ...stacked, crossfade: false } }),
      ),
    ).toBe(`Turning the crossfade off${LOST}`);
    expect(
      describeDraftChanges(
        draft(base.timeline, { sequenceLayout: { ...stacked, crossfade: false } }),
        draft(base.timeline, { sequenceLayout: { ...stacked, mode: "track" } }),
      ),
    ).toBe(`The switch to Track and turning the crossfade on${LOST}`);
    expect(describeDraftChanges(base, draft(base.timeline, { loopCount: 2, sequenceLayout: stacked }))).toBe(
      `The loop count, the switch to Stacked and the overlap${LOST}`,
    );
  });

  it("falls back when no change can be named", () => {
    expect(describeDraftChanges(base, base)).toBe("Your changes will be lost. The node keeps what it had.");
  });
});
