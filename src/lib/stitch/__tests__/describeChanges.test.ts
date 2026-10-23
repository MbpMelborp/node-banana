import { describe, expect, it } from "vitest";
import type { ClipWarp, StitchTimelineClip } from "@/types";
import { describeDraftChanges, type ClipOrigin, type StitchDraft } from "../draft";
import { createAudioClip, legacyMusicClip } from "../audioClips";
import { createTextOverlay, splitOverlayAt } from "../overlays";
import { DEFAULT_SEQUENCE_LAYOUT } from "../stack";
import {
  createClip,
  moveClipStart,
  pinStarts,
  resetTrimInPlace,
  splitClipAt,
  trimClipInPlace,
  type SourceKey,
} from "../timeline";
import { normalizeWarp, splitWarp, warpMap, withWarp } from "../warp";

const clip = (id: string, edgeId: string, init: Partial<StitchTimelineClip> = {}) =>
  createClip({ kind: "edge", edgeId }, { id, ...init });

const draft = (timeline: StitchTimelineClip[], rest: Partial<StitchDraft> = {}): StitchDraft => ({
  timeline,
  audioClips: [],
  legacyAudio: { curve: [], muted: false },
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
const W = (speed: number, curve: ClipWarp["curve"] = null, extra: Partial<ClipWarp> = {}): ClipWarp => ({
  speed,
  curve,
  reverse: false,
  blend: false,
  ...extra,
});
/** A retime as an edit writes it. */
const retime = (c: StitchTimelineClip, warp: ClipWarp) => withWarp(c, normalizeWarp(warp));

describe("describeDraftChanges", () => {
  it("reads the board's sentence", () => {
    const edited = draft([clip("b", "e2", { inSec: 1 }), clip("a", "e1", { outSec: 3 }), clip("c", "e3")], {
      legacyAudio: { curve: [{ t: 2, gain: 0.25 }], muted: false },
    });
    expect(describeDraftChanges(base, edited)).toBe(`Two trims, a new order and the volume curve${LOST}`);
  });

  it("uses the singular with its article", () => {
    const edited = draft([clip("a", "e1", { inSec: 1, muted: true, volume: 0.5 }), clip("b", "e2"), clip("c", "e3")], {
      legacyAudio: { curve: [], muted: true },
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

  it("counts a head trim beside a new clip of its source as a trim and a split, with no warp", () => {
    // The pieces reach from the old In to the new one, as a reversed split leaves them, but nothing is reversed
    const edited = draft([clip("a", "e1", { inSec: 2 }), clip("b", "e2"), clip("c", "e3"), clip("x", "e1", { outSec: 2 })]);
    expect(describeDraftChanges(base, edited)).toBe(`A trim and a split${LOST}`);
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

  describe("placed clips (Stacked)", () => {
    const STACKED = { mode: "stacked" as const, overlapSec: 1, crossfade: true };
    // Lined up at Overlap 1: a 0–5, b 4–8, c 7–10
    const lined = draft(base.timeline, { sequenceLayout: STACKED });
    const edit = (timeline: StitchTimelineClip[]) => draft(timeline, { sequenceLayout: STACKED });

    it("names a moved clip, and two", () => {
      const once = moveClipStart(lined.timeline, durations, "b", 6, 1);
      expect(describeDraftChanges(lined, edit(once), durations)).toBe(`A moved clip${LOST}`);
      const twice = moveClipStart(once, durations, "c", 0, 1);
      expect(describeDraftChanges(lined, edit(twice), durations)).toBe(`Two moved clips${LOST}`);
    });

    it("does not count pinning alone, or an In trim that keeps the frames in place, as a move", () => {
      expect(describeDraftChanges(lined, edit(pinStarts(lined.timeline, durations, 1)), durations)).toBe(
        "Your changes will be lost. The node keeps what it had.",
      );
      const trimmed = trimClipInPlace(lined.timeline, "b", durations, { inSec: 1 }, 1);
      expect(trimmed.find((c) => c.id === "b")!.startSec).toBe(5);
      expect(describeDraftChanges(lined, edit(trimmed), durations)).toBe(`A trim${LOST}`);
    });

    /** b at 2×, as an edit writes it. */
    const fastB = (timeline: StitchTimelineClip[], reverse = false) =>
      timeline.map((c) => (c.id === "b" ? retime(c, W(2, null, { reverse })) : c));

    it("does not count an in-place head trim of a retimed clip as a move", () => {
      const fast = edit(fastB(lined.timeline));
      const head = trimClipInPlace(fast.timeline, "b", durations, { inSec: 1 }, 1);
      expect(describeDraftChanges(fast, edit(head), durations)).toBe(`A trim${LOST}`);
      // Reversed, the head is the Out
      const reversed = edit(fastB(lined.timeline, true));
      const out = trimClipInPlace(reversed.timeline, "b", durations, { outSec: 3 }, 1);
      expect(out.find((c) => c.id === "b")!.startSec).toBe(4.5);
      expect(describeDraftChanges(reversed, edit(out), durations)).toBe(`A trim${LOST}`);
    });

    it("does not count a speed change on a placed clip as a move", () => {
      const initial = edit(pinStarts(lined.timeline.map((c) => (c.id === "b" ? { ...c, inSec: 1 } : c)), durations, 1));
      const fast = edit(fastB(initial.timeline));
      expect(describeDraftChanges(initial, fast, durations)).not.toContain("moved");
      expect(describeDraftChanges(initial, fast, durations)).toBe(`A speed change${LOST}`);
    });

    // Pinned where the lined-up stack put them, so a shorter b moves nothing after it
    const pinned = edit(pinStarts(lined.timeline, durations, 1));

    it("counts a retimed clip whose start moved as moved", () => {
      for (const reverse of [false, true]) {
        const moved = moveClipStart(fastB(pinned.timeline, reverse), durations, "b", 6, 1);
        expect(describeDraftChanges(pinned, edit(moved), durations)).toBe(`A moved clip and a speed change${LOST}`);
      }
    });

    it("does not count a head trim in place after a retime as a move", () => {
      // The start moves by the head's change over the new speed: read through it, the frames did not move
      const head = trimClipInPlace(fastB(pinned.timeline), "b", durations, { inSec: 1 }, 1);
      expect(head.find((c) => c.id === "b")!.startSec).toBe(4.5);
      expect(describeDraftChanges(pinned, edit(head), durations)).toBe(`A trim and a speed change${LOST}`);
      const out = trimClipInPlace(fastB(pinned.timeline, true), "b", durations, { outSec: 3 }, 1);
      expect(out.find((c) => c.id === "b")!.startSec).toBe(4.5);
      expect(describeDraftChanges(pinned, edit(out), durations)).toBe(`A trim and a speed change${LOST}`);
    });

    it("does not count a head trim in place before a retime as a move", () => {
      // The start moved by the head's change at 1×: read through the speed it had, the frames did not move
      const trimmed = trimClipInPlace(pinned.timeline, "b", durations, { inSec: 1 }, 1);
      expect(trimmed.find((c) => c.id === "b")!.startSec).toBe(5);
      for (const reverse of [false, true]) {
        expect(describeDraftChanges(pinned, edit(fastB(trimmed, reverse)), durations)).toBe(
          `A trim and a speed change${LOST}`,
        );
      }
      const reversedOnly = trimmed.map((c) => (c.id === "b" ? retime(c, W(1, null, { reverse: true })) : c));
      expect(describeDraftChanges(pinned, edit(reversedOnly), durations)).toBe(`A trim and a speed change${LOST}`);
    });

    it("does not count a tail trim in place, then a speed change, as a move", () => {
      // The start never changes; only the reading through the new warp's head (an Out, reversed) would say it did
      const tail = trimClipInPlace(pinned.timeline, "b", durations, { outSec: 3 }, 1);
      expect(describeDraftChanges(pinned, edit(fastB(tail, true)), durations)).toBe(`A trim and a speed change${LOST}`);
      const reversed = edit(pinned.timeline.map((c) => (c.id === "b" ? retime(c, W(1, null, { reverse: true })) : c)));
      const reversedTail = trimClipInPlace(reversed.timeline, "b", durations, { inSec: 1 }, 1);
      const forward = reversedTail.map((c) => (c.id === "b" ? withWarp(c, undefined) : c));
      expect(forward.find((c) => c.id === "b")!.startSec).toBe(4);
      expect(describeDraftChanges(reversed, edit(forward), durations)).toBe(`A trim and a speed change${LOST}`);
    });

    it("does not count a head trim in place of a ramp's split piece as a move", () => {
      const ramp = edit(
        pinned.timeline.map((c) => (c.id === "b" ? retime(c, W(1, { kind: "preset", name: "easeInQuad" })) : c)),
      );
      const split = splitClipAt(ramp.timeline, durations, 7, () => "b2", { layout: STACKED })!.timeline;
      const head = trimClipInPlace(split, "b", durations, { inSec: 0.25 }, 1);
      expect(head.find((c) => c.id === "b")!.startSec).toBeGreaterThan(4);
      expect(describeDraftChanges(ramp, edit(head), durations)).toBe(`A trim and a split${LOST}`);
      // The other order: the trim at the ramp's speed, then Split gives the piece its window's
      const trimmed = trimClipInPlace(ramp.timeline, "b", durations, { inSec: 0.25 }, 1);
      const later = splitClipAt(trimmed, durations, 7, () => "b2", { layout: STACKED })!.timeline;
      expect(later.find((c) => c.id === "b")!.warp!.speed).not.toBe(1);
      expect(describeDraftChanges(ramp, edit(later), durations)).toBe(`A trim and a split${LOST}`);
    });

    it("counts a Reset trim clamped at 0:00 as a trim and a move", () => {
      const initial = edit([clip("a", "e1", { startSec: 0.5, inSec: 0.8 }), clip("b", "e2", { startSec: 6 })]);
      const reset = resetTrimInPlace(initial.timeline, "a", durations, 1);
      expect(reset[0]).toMatchObject({ startSec: 0, inSec: 0, outSec: null });
      expect(describeDraftChanges(initial, edit(reset), durations)).toBe(`A trim and a moved clip${LOST}`);
    });

    it("names lining up the clips, right after a new order", () => {
      const placed = edit(moveClipStart(lined.timeline, durations, "b", 6, 1));
      expect(describeDraftChanges(placed, lined, durations)).toBe(`Lining up the clips${LOST}`);
      const reordered = edit([lined.timeline[1], lined.timeline[0], clip("c", "e3", { inSec: 1 })]);
      expect(describeDraftChanges(placed, reordered, durations)).toBe(`A trim, a new order and lining up the clips${LOST}`);
    });
  });

  it("falls back when no change can be named", () => {
    expect(describeDraftChanges(base, base)).toBe("Your changes will be lost. The node keeps what it had.");
  });

  describe("pasted, duplicated and cut clips", () => {
    const origins = (entries: Record<string, ClipOrigin>) => new Map(Object.entries(entries));

    it("calls a pasted copy of a clip already in the sequence a pasted clip, not a split", () => {
      const edited = draft([...base.timeline, clip("p1", "e1", { inSec: 1 })]);
      expect(describeDraftChanges(base, edited)).toBe(`A split${LOST}`);
      expect(describeDraftChanges(base, edited, durations, origins({ p1: "pasted" }))).toBe(`A pasted clip${LOST}`);
    });

    it("counts duplicated clips", () => {
      const edited = draft([...base.timeline, clip("d1", "e2"), clip("d2", "e3")]);
      expect(describeDraftChanges(base, edited, durations, origins({ d1: "duplicated", d2: "duplicated" }))).toBe(
        `Two duplicated clips${LOST}`,
      );
    });

    it("calls a removed clip tagged cut a cut clip", () => {
      const edited = draft(base.timeline.slice(1));
      expect(describeDraftChanges(base, edited, durations, origins({ a: "cut" }))).toBe(`A cut clip${LOST}`);
    });

    it("names a cut and a paste together, each after its own kind", () => {
      const edited = draft([clip("b", "e2"), clip("c", "e3"), clip("x", "e9"), clip("p1", "e1"), clip("p2", "e1")]);
      expect(describeDraftChanges(base, edited, durations, origins({ a: "cut", p1: "pasted", p2: "pasted" }))).toBe(
        `An added clip, two pasted clips and a cut clip${LOST}`,
      );
    });

    it("leaves a tag alone where it does not apply: a pasted clip that is gone, a cut clip that is back", () => {
      const tags = origins({ a: "cut", gone: "pasted" });
      expect(describeDraftChanges(base, base, durations, tags)).toBe("Your changes will be lost. The node keeps what it had.");
    });

    it("says exactly what it said before with no tags", () => {
      const fixtures: Array<[StitchDraft, StitchDraft]> = [
        [base, draft([clip("b", "e2", { inSec: 1 }), clip("a", "e1", { outSec: 3 }), clip("c", "e3")])],
        [base, draft(splitClipAt(base.timeline, durations, 2, () => "a2")!.timeline)],
        [base, draft([clip("a", "e1", { outSec: 2 }), clip("a2", "e1", { inSec: 2 }), clip("x", "e9")])],
        [base, draft([], { loopCount: 3, legacyAudio: { curve: [], muted: true } })],
        [base, base],
      ];
      for (const [initial, edited] of fixtures) {
        expect(describeDraftChanges(initial, edited, durations, new Map())).toBe(describeDraftChanges(initial, edited, durations));
      }
    });
  });

  describe("speed changes", () => {
    const SINE: ClipWarp["curve"] = { kind: "preset", name: "easeInOutSine" };
    const warped = (id: string, edgeId: string, warp: ClipWarp, init: Partial<StitchTimelineClip> = {}) =>
      withWarp(clip(id, edgeId, init), warp);

    /** Split a forward warped clip at an output offset as Split does: the earlier piece keeps the id, a null Out stays. */
    function splitByWarp(c: StitchTimelineClip, d: number, offset: number, rightId: string): StitchTimelineClip[] {
      const split = splitWarp({ inSec: c.inSec, outSec: c.outSec ?? d }, c.warp!, offset)!;
      return [
        withWarp({ ...c, outSec: split.at }, split.first.warp),
        withWarp({ ...c, id: rightId, inSec: split.at, outSec: c.outSec }, split.second.warp),
      ];
    }

    it("counts a changed speed, reverse, ramp or blend, after a clip volume", () => {
      const slow = draft([warped("a", "e1", W(0.5)), clip("b", "e2"), clip("c", "e3")]);
      const one = draft([warped("a", "e1", W(0.75)), clip("b", "e2"), clip("c", "e3")]);
      expect(describeDraftChanges(slow, one)).toBe(`A speed change${LOST}`);
      const two = draft([clip("a", "e1"), warped("b", "e2", W(2)), clip("c", "e3")]);
      expect(describeDraftChanges(slow, two)).toBe(`Two speed changes${LOST}`);
      for (const changed of [W(0.5, null, { reverse: true }), W(0.5, SINE), W(0.5, null, { blend: true })]) {
        const edited = draft([warped("a", "e1", changed), clip("b", "e2"), clip("c", "e3")]);
        expect(describeDraftChanges(slow, edited)).toBe(`A speed change${LOST}`);
      }
      const both = draft([warped("a", "e1", W(0.75), { volume: 0.5 }), clip("b", "e2"), clip("c", "e3")]);
      expect(describeDraftChanges(slow, both)).toBe(`A clip volume and a speed change${LOST}`);
      // Blend alone at 1× is no warp, held on the clip or not
      const plain = draft([clip("a", "e1")]);
      const blendOnly = draft([clip("a", "e1", { warp: W(1, null, { blend: true }) })]);
      expect("warp" in blendOnly.timeline[0]).toBe(true);
      expect(describeDraftChanges(plain, blendOnly)).toBe("Your changes will be lost. The node keeps what it had.");
      expect(describeDraftChanges(blendOnly, plain)).toBe("Your changes will be lost. The node keeps what it had.");
    });

    it("counts a split of a warped clip as a split, not a trim or a speed change", () => {
      const ramp = draft([warped("a", "e1", W(0.8, SINE)), clip("b", "e2"), clip("c", "e3")]);
      const [a] = ramp.timeline;
      const once = [...splitByWarp(a, 5, 2, "a2"), ...ramp.timeline.slice(1)];
      expect(describeDraftChanges(ramp, draft(once))).toBe(`A split${LOST}`);
      const twice = [...splitByWarp(once[0], 5, 1, "a3"), ...once.slice(1)];
      expect(describeDraftChanges(ramp, draft(twice))).toBe(`Two splits${LOST}`);
      const constant = draft([warped("a", "e1", W(2))]);
      const constantSplit = draft(splitByWarp(constant.timeline[0], 5, 1, "a2"));
      expect(describeDraftChanges(constant, constantSplit)).toBe(`A split${LOST}`);
      // A piece cut near a ramp's slow end averages about 3e-7×; splitting it again is still a split
      const root = splitWarp({ inSec: 0, outSec: 60 }, W(0.1, { kind: "preset", name: "easeInQuint" }), 25)!.first;
      const piece = draft([warped("a", "e1", root.warp, { outSec: root.range.outSec })]);
      const pieceLength = warpMap(root.range, root.warp).length;
      expect(describeDraftChanges(piece, draft(splitByWarp(piece.timeline[0], 60, pieceLength * 0.8, "a2")))).toBe(
        `A split${LOST}`,
      );
    });

    it("counts a speed change on a piece after the split", () => {
      const ramp = draft([warped("a", "e1", W(0.8, SINE)), clip("b", "e2"), clip("c", "e3")]);
      const [left, right] = splitByWarp(ramp.timeline[0], 5, 2, "a2");
      const faster = { ...left, warp: { ...left.warp!, speed: left.warp!.speed * 1.5 } };
      const edited = [faster, right, ...ramp.timeline.slice(1)];
      expect(describeDraftChanges(ramp, draft(edited))).toBe(`A split and a speed change${LOST}`);
    });

    // Through the timeline's own Split: the pieces a reversed split makes
    const splitOf = (initial: StitchDraft, t: number) =>
      draft(splitClipAt(initial.timeline, durations, t, () => "a2")!.timeline);

    it("calls a reversed clip's split a split", () => {
      const reversed = draft([warped("a", "e1", W(1, null, { reverse: true })), clip("b", "e2"), clip("c", "e3")]);
      const split = splitOf(reversed, 2);
      expect(split.timeline[0]).toMatchObject({ id: "a", inSec: 3, outSec: null });
      expect(describeDraftChanges(reversed, split)).toBe(`A split${LOST}`);
    });

    it("calls reverse, then split, a split and a speed change", () => {
      const reversed = draft(base.timeline.map((c) => (c.id === "a" ? retime(c, W(1, null, { reverse: true })) : c)));
      expect(describeDraftChanges(base, splitOf(reversed, 2))).toBe(`A split and a speed change${LOST}`);
    });

    it("calls split, then reverse, a split and a speed change", () => {
      const initial = draft([warped("a", "e1", W(2)), clip("b", "e2"), clip("c", "e3")]);
      const split = splitOf(initial, 1);
      const [left] = split.timeline;
      const reversed = [retime(left, { ...left.warp!, reverse: true }), ...split.timeline.slice(1)];
      expect(describeDraftChanges(initial, draft(reversed))).toBe(`A split and a speed change${LOST}`);
    });

    it("calls a split whose reversed piece is the only warp left a split", () => {
      // Reversed, then split, then the left piece played forward again: its In moved, its reversed piece holds the rest
      const reversed = draft(base.timeline.map((c) => (c.id === "a" ? retime(c, W(1, null, { reverse: true })) : c)));
      const split = splitOf(reversed, 2);
      const forward = split.timeline.map((c) => (c.id === "a" ? retime(c, W(1)) : c));
      expect(forward[0]).not.toHaveProperty("warp");
      expect(describeDraftChanges(base, draft(forward))).toBe(`A split${LOST}`);
    });

    it("calls a reversed split a split whichever pieces are played forward again", () => {
      const reversed = draft(base.timeline.map((c) => (c.id === "a" ? retime(c, W(1, null, { reverse: true })) : c)));
      const split = splitOf(reversed, 2);
      // Both: no warp is left, but the clip had one
      const both = split.timeline.map((c) => (c.id === "a" || c.id === "a2" ? retime(c, W(1)) : c));
      expect(describeDraftChanges(reversed, draft(both))).toBe(`A split and a speed change${LOST}`);
      // The new piece only: the clip had none, but has one
      const right = split.timeline.map((c) => (c.id === "a2" ? retime(c, W(1)) : c));
      expect(describeDraftChanges(base, draft(right))).toBe(`A split and a speed change${LOST}`);
    });

    it("reads a head trim beside a new clip of its source as a trim, whatever another source's pieces carry", () => {
      const edited = draft([
        clip("a", "e1", { inSec: 2 }),
        clip("b", "e2"),
        clip("c", "e3"),
        clip("x", "e1", { outSec: 2 }),
        warped("y", "e2", W(2), { inSec: 2 }),
      ]);
      expect(describeDraftChanges(base, edited)).toBe(`A trim and two splits${LOST}`);
    });

    it("calls a ramp's split a split, not a speed change, forward or reversed", () => {
      for (const reverse of [false, true]) {
        const quad = W(1, { kind: "preset", name: "easeInQuad" }, { reverse });
        const ramp = draft([warped("a", "e1", quad), clip("b", "e2")]);
        expect(describeDraftChanges(ramp, splitOf(ramp, 2))).toBe(`A split${LOST}`);
      }
    });

    it("counts a speed change made on a piece after Split", () => {
      for (const curve of [null, { kind: "preset", name: "easeInQuad" } as const]) {
        const initial = draft([warped("a", "e1", W(2, curve)), clip("b", "e2")]);
        const split = splitOf(initial, 1);
        const left = split.timeline[0];
        const faster = retime(left, { ...left.warp!, speed: curve ? left.warp!.speed * 1.5 : 3 });
        expect(describeDraftChanges(initial, draft([faster, ...split.timeline.slice(1)]))).toBe(
          `A split and a speed change${LOST}`,
        );
      }
    });
  });

  describe("audio clips", () => {
    const withMusic = draft(base.timeline, { audioClips: [legacyMusicClip([], false)] });
    const tone = createAudioClip({ kind: "asset", assetId: "atone00000001" }, { id: "t1", row: 1, startSec: 2 });

    it("names a music clip's curve and mute as audio-clip changes", () => {
      const edited = draft(base.timeline, { audioClips: [legacyMusicClip([{ t: 1, gain: 0.5 }], true)] });
      expect(describeDraftChanges(withMusic, edited)).toBe(`A muted audio clip and the volume curve${LOST}`);
    });

    it("names an added and a pasted audio clip after the video's parts, before the loop count", () => {
      const pasted = { ...tone, id: "p1", row: 2 };
      const edited = draft([clip("a", "e1", { inSec: 1 }), clip("b", "e2"), clip("c", "e3")], {
        audioClips: [legacyMusicClip([], false), tone, pasted],
        loopCount: 2,
      });
      expect(describeDraftChanges(withMusic, edited, durations, new Map([["p1", "pasted" as const]]))).toBe(
        `A trim, an added audio clip, a pasted audio clip and the loop count${LOST}`,
      );
    });
  });

  describe("text layers", () => {
    const title = createTextOverlay({ id: "o1", startSec: 1, endSec: 5 });
    const withTitle = draft(base.timeline, { overlays: [title] });

    it("names text layer changes after the audio's parts, before the loop count", () => {
      const edited = draft(base.timeline, {
        audioClips: [createAudioClip({ kind: "asset", assetId: "atone00000001" }, { id: "t1" })],
        overlays: [{ ...title, text: "Other" }, createTextOverlay({ id: "o2", row: 1 })],
        loopCount: 2,
      });
      expect(describeDraftChanges(withTitle, edited, durations)).toBe(
        `An added audio clip, an added text layer, an edited text layer and the loop count${LOST}`,
      );
    });

    it("names a split, a cut and a pasted text layer by the session's tags", () => {
      const split = splitOverlayAt([title], "o1", 3, "o1b")!.overlays;
      expect(describeDraftChanges(withTitle, draft(base.timeline, { overlays: split }))).toBe(`A text layer split${LOST}`);
      const tags = new Map<string, ClipOrigin>([
        ["o1", "cut"],
        ["p1", "pasted"],
      ]);
      const pasted = draft(base.timeline, { overlays: [createTextOverlay({ id: "p1", startSec: 6 })] });
      expect(describeDraftChanges(withTitle, pasted, durations, tags)).toBe(`A pasted text layer and a cut text layer${LOST}`);
    });

    it("finds no change between no overlays and an empty list", () => {
      expect(describeDraftChanges(base, draft(base.timeline, { overlays: [] }))).toBe(
        "Your changes will be lost. The node keeps what it had.",
      );
    });
  });
});
