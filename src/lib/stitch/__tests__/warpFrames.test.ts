import { describe, it, expect } from "vitest";
import type { ClipWarp, ClipWarpCurve } from "@/types";
import { planPicture, type PictureClip } from "../picturePlan";
import { secToSlot } from "../sequencePlan";
import { normalizeWarp, splitWarp, warpMap, type WarpMap } from "../warp";
import {
  blendsOnSlot,
  eventAt,
  frameIndexAt,
  joinOuts,
  OUT_EPS,
  pickFrame,
  reverseChunk,
  reverseChunkFrames,
  warpEvents,
  warpSlotTime,
  type FramePick,
  type WarpEvents,
} from "../warpFrames";

const W = (speed: number, extra: Partial<ClipWarp> = {}): ClipWarp => ({
  speed,
  curve: null,
  reverse: false,
  blend: false,
  ...extra,
});
const EASE_IN_OUT: ClipWarpCurve = { kind: "preset", name: "easeInOutCubic" };
/** Stands still from 0.4 to 0.6 of the clip. */
const FLAT: ClipWarpCurve = {
  kind: "points",
  points: [
    [0, 0],
    [0.4, 0.5],
    [0.6, 0.5],
    [1, 1],
  ],
};

const map = (inSec: number, outSec: number, warp: ClipWarp): WarpMap => warpMap({ inSec, outSec }, warp);

/** A fps source's frames a clip of [inSec, outSec) lists: the one in effect at In, then every one before Out. */
function framesIn(fps: number, inSec: number, outSec: number): number[] {
  const all = Array.from({ length: Math.ceil(outSec * fps) + 1 }, (_, j) => j / fps);
  return all.filter((t, j) => (all[j + 1] === undefined || all[j + 1] > inSec) && t < outSec);
}

/** Every slot's pick, brute force. */
function picks(times: number[], m: WarpMap, from: number, end: number, anchor = from): FramePick[] {
  const out: FramePick[] = [];
  for (let n = from; n < end; n++) out.push(pickFrame(times, warpSlotTime(m, n, anchor), blendsOnSlot(m, n, anchor)));
  return out;
}

const sameFrames = (x: FramePick, y: FramePick) => x.a === y.a && x.b === y.b && Math.abs(x.alpha - y.alpha) <= 1e-9;

/** The events of an event list, as picks. */
const eventPicks = (events: WarpEvents) =>
  Array.from({ length: events.count }, (_, e) => ({ slot: events.slots[e], a: events.a[e], b: events.b[e], alpha: events.alpha[e] }));

// Seeded: the placement simulations' LCG.
function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

describe("pickFrame", () => {
  const times = [0, 0.25, 0.5];

  it("takes the nearer frame, the earlier on a tie or within TIE_EPS of one, and the ends outside the list", () => {
    expect(pickFrame(times, 0.125, false)).toEqual({ a: 0, b: -1, alpha: 0 });
    expect(pickFrame(times, 0.125 + 5e-7, false).a).toBe(0);
    expect(pickFrame(times, 0.125 + 2e-6, false).a).toBe(1);
    expect(pickFrame(times, -1, false).a).toBe(0);
    expect(pickFrame(times, 5, false).a).toBe(2);
  });

  it("blends the frame at or before t with the next, or gives one frame within TIE_EPS of it", () => {
    expect(pickFrame(times, 0.3125, true)).toEqual({ a: 1, b: 2, alpha: 0.25 });
    expect(pickFrame(times, 0.25 + 5e-7, true)).toEqual({ a: 1, b: -1, alpha: 0 });
    expect(pickFrame(times, 0.5 - 5e-7, true)).toEqual({ a: 2, b: -1, alpha: 0 });
  });
});

describe("warpSlotTime", () => {
  // In 2, Out 6 at 2×: 2 s of output on slots 30–149
  it("reads a slot's start forward and its end reversed, and keeps Out exclusive", () => {
    const forward = map(2, 6, W(2));
    expect(warpSlotTime(forward, 30, 30)).toBe(2);
    expect(warpSlotTime(forward, 60, 30)).toBe(3);
    expect(warpSlotTime(forward, 149, 30)).toBeCloseTo(2 + 238 / 60, 12);
    expect(warpSlotTime(forward, 150, 30)).toBe(6 - OUT_EPS);

    const reversed = map(2, 6, W(2, { reverse: true }));
    expect(warpSlotTime(reversed, 30, 30)).toBeCloseTo(6 - 2 / 60, 12);
    expect(warpSlotTime(reversed, 89, 30)).toBe(4);
    // In's frame on the last slot
    expect(warpSlotTime(reversed, 149, 30)).toBe(2);
    expect(warpSlotTime(reversed, 150, 30)).toBe(2);
  });

  it("shows a reversed clip as the mirror of its forward clip, Blend frames on and off", () => {
    let differ = 0;
    for (const fps of [24, 25, 30, 50, 60]) {
      for (const speed of [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4]) {
        for (const blend of [false, true]) {
          // 2 s of output: slot-aligned
          const times = framesIn(fps, 0.5, 0.5 + 2 * speed);
          const forward = picks(times, map(0.5, 0.5 + 2 * speed, W(speed, { blend })), 0, 120);
          const reversed = picks(times, map(0.5, 0.5 + 2 * speed, W(speed, { blend, reverse: true })), 0, 120);
          reversed.forEach((pick, n) => {
            if (!sameFrames(pick, forward[119 - n])) differ++;
          });
        }
      }
    }
    expect(differ).toBe(0);
  });

  it("shows every frame of a 60 fps source once, falling by one, when reversed at 1×", () => {
    for (const [inSec, outSec] of [
      [0, 1],
      [0.25, 1.75],
      [1 / 60, 59 / 60],
    ]) {
      const times = framesIn(60, inSec, outSec);
      const shown = picks(times, map(inSec, outSec, W(1, { reverse: true })), 0, Math.round((outSec - inSec) * 60)).map((p) => p.a);
      expect(shown).toHaveLength(times.length);
      expect(shown).toEqual(times.map((_, j) => times.length - 1 - j));
    }
  });
});

describe("blendsOnSlot", () => {
  it("blends only with Blend frames on and below 1× where the slot reads", () => {
    expect(blendsOnSlot(map(0, 2, W(0.5, { blend: true })), 10, 0)).toBe(true);
    expect(blendsOnSlot(map(0, 2, W(2, { blend: true })), 10, 0)).toBe(false);
    expect(blendsOnSlot(map(0, 2, W(0.5)), 10, 0)).toBe(false);
    // easeInOutCubic at 1× on average: slope 0 at both ends, 3 in the middle (4 s, slots 0–239)
    const ramp = map(0, 4, normalizeWarp(W(1, { curve: EASE_IN_OUT, blend: true }))!);
    expect(blendsOnSlot(ramp, 0, 0)).toBe(true);
    expect(blendsOnSlot(ramp, 120, 0)).toBe(false);
    expect(blendsOnSlot(ramp, 239, 0)).toBe(true);
  });
});

describe("warpEvents and eventAt", () => {
  const times = framesIn(24, 0, 4);

  it("lists exactly the slots on which the brute-force pick changes, at 2×", () => {
    const m = map(0, 4, W(2));
    const events = warpEvents(times, m, { anchorSlot: 0, fromSlot: 0, endSlot: 120 });
    const all = picks(times, m, 0, 120);
    const changes = all.flatMap((pick, n) => (n === 0 || !sameFrames(pick, all[n - 1]) ? [{ slot: n, ...pick }] : []));
    expect(eventPicks(events)).toEqual(changes);
    expect(eventAt(events, 0)).toBe(0);
    expect(eventAt(events, -1)).toBe(-1);
    expect(eventAt(events, 1000)).toBe(events.count - 1);
  });

  it("changes frame every 5 slots at 0.5×, from the first midpoint", () => {
    const events = warpEvents(times, map(0, 2, W(0.5)), { anchorSlot: 0, fromSlot: 0, endSlot: 240 });
    const slots = Array.from(events.slots.subarray(0, events.count));
    expect(slots.slice(0, 5)).toEqual([0, 3, 8, 13, 18]);
    slots.forEach((slot, e) => e > 1 && expect(slot - slots[e - 1]).toBe(5));
  });

  it("blends on every slot between frames at 0.5× with Blend frames, alphas k/5", () => {
    const events = warpEvents(times, map(0, 2, W(0.5, { blend: true })), { anchorSlot: 0, fromSlot: 0, endSlot: 240 });
    expect(events.count).toBe(240);
    for (let n = 0; n < 240; n++) {
      if (n % 5 === 0) {
        expect([events.a[n], events.b[n]]).toEqual([n / 5, -1]);
      } else {
        expect([events.a[n], events.b[n]]).toEqual([Math.floor(n / 5), Math.floor(n / 5) + 1]);
        expect(events.alpha[n]).toBeCloseTo((n % 5) / 5, 9);
      }
    }
  });

  it("writes nothing while a points curve stands still, and nothing at all for no frames", () => {
    const m = map(0, 4, normalizeWarp(W(1, { curve: FLAT }))!);
    const events = warpEvents(times, m, { anchorSlot: 0, fromSlot: 0, endSlot: 240 });
    const slots = Array.from(events.slots.subarray(0, events.count));
    // The flat covers output 1.6–2.4 s: slots 97–143 read one source time
    expect(slots.filter((slot) => slot > 97 && slot < 144)).toEqual([]);
    expect(warpEvents([], m, { anchorSlot: 0, fromSlot: 0, endSlot: 240 }).count).toBe(0);
  });

  it("writes nothing while a hold between two frames blends them, though the hold's time wobbles by an ulp", () => {
    // Held at 0.4321 of 4 s (1.7284 s), between frames 41 and 42: the curve's sum there is not exactly 0.4321
    for (const y of [0.4321, 0.2468, 0.61]) {
      const hold: ClipWarpCurve = { kind: "points", points: [[0, 0], [0.3, y], [0.7, y], [1, 1]] };
      const m = map(0, 4, normalizeWarp(W(1, { curve: hold, blend: true }))!);
      const events = warpEvents(times, m, { anchorSlot: 0, fromSlot: 0, endSlot: 240 });
      // The hold is output 1.2–2.8 s: slots 72–168
      const inside = Array.from(events.slots.subarray(0, events.count)).filter((slot) => slot > 72 && slot < 168);
      expect(inside, `held at ${y}`).toEqual([]);
    }
  });

  it("keeps the pick monotone but for one step into or out of a blend, over random warps and frame lists", () => {
    const rnd = lcg(31);
    const curves = (): ClipWarpCurve | null => {
      const kind = Math.floor(rnd() * 4);
      if (kind === 0) return null;
      if (kind === 1) return { kind: "preset", name: ["easeInOutCubic", "easeInQuad", "easeOutExpo", "easeInOutSine"][Math.floor(rnd() * 4)] };
      if (kind === 2) return { kind: "bezier", handles: [rnd(), rnd(), rnd(), rnd()] };
      const x = 0.2 + rnd() * 0.6;
      return { kind: "points", points: [[0, 0], [x, rnd()], [1, 1]] };
    };
    let cases = 0;
    while (cases < 200) {
      const fps = [24, 25, 30, 60][Math.floor(rnd() * 4)];
      const speed = Math.exp(Math.log(0.1) + rnd() * Math.log(100));
      const a = rnd() * 0.5;
      const warp = normalizeWarp({
        speed,
        curve: curves(),
        ...(rnd() < 0.5 ? { window: [a, a + 0.2 + rnd() * (0.8 - a)] as [number, number] } : {}),
        reverse: rnd() < 0.5,
        blend: rnd() < 0.5,
      });
      if (!warp) continue;
      // A frame list jittered by ±30 % of a frame, the clip inside it
      const all = Array.from({ length: 4 * fps }, (_, j) => (j + (j > 0 ? (rnd() - 0.5) * 0.6 : 0)) / fps);
      const inSec = rnd() * 0.5;
      const outSec = Math.min(3.9, inSec + Math.min(0.3 + rnd() * 3, 4 * speed));
      const times = all.filter((t, j) => (all[j + 1] === undefined || all[j + 1] > inSec) && t < outSec);
      const m = map(inSec, outSec, warp);
      const anchor = Math.floor(rnd() * 30);
      const end = anchor + Math.round(m.length * 60);
      const events = warpEvents(times, m, { anchorSlot: anchor, fromSlot: anchor, endSlot: end });
      const all_ = picks(times, m, anchor, end);
      const changes = all_.flatMap((pick, i) => (i === 0 || !sameFrames(pick, all_[i - 1]) ? [{ slot: anchor + i, ...pick }] : []));
      expect(eventPicks(events)).toEqual(changes);
      const wrong: string[] = [];
      for (let e = 0; e < events.count; e++) {
        const step = e > 0 ? events.a[e] - events.a[e - 1] : 0;
        if (!warp.reverse && step < 0 && (step !== -1 || events.b[e] !== events.a[e] + 1)) wrong.push(`falls by ${-step} on ${events.slots[e]}`);
        if (warp.reverse && step > 1) wrong.push(`rises by ${step} on ${events.slots[e]}`);
        if (events.a[e] < 0 || Math.max(events.a[e], events.b[e]) >= times.length) wrong.push(`frame out of range on ${events.slots[e]}`);
      }
      expect(wrong, `case ${cases}`).toEqual([]);
      cases++;
    }
  });
});

describe("joinOuts", () => {
  const clip = (inSec: number, outSec: number, warp?: ClipWarp, source = "a", startSec?: number): PictureClip => ({
    inSec,
    outSec,
    sourceDuration: 6,
    source,
    ...(warp ? { warp } : {}),
    ...(startSec !== undefined ? { startSec } : {}),
  });
  const slow = W(0.5);
  const back = W(0.5, { reverse: true });

  it("names the other piece's Out at a split's join: the piece after it forward, the piece before it reversed", () => {
    expect(joinOuts(planPicture([clip(0, 2, slow), clip(2, 5, slow)], undefined))).toEqual([5, null]);
    expect(joinOuts(planPicture([clip(2, 5, back), clip(0, 2, back)], undefined))).toEqual([null, 5]);
    // Lined up: a split's pieces are one run, never overlapped
    expect(joinOuts(planPicture([clip(0, 2, slow), clip(2, 5, slow), clip(0, 3, undefined, "b")], { overlapSec: 1 }))).toEqual([
      5,
      null,
      null,
    ]);
  });

  it("names the last Out of the pieces that run on from the join, through a piece that holds no frame of its own", () => {
    expect(joinOuts(planPicture([clip(0, 2, slow), clip(2, 2.01, slow), clip(2.01, 5, slow)], undefined))).toEqual([5, 5, null]);
    expect(joinOuts(planPicture([clip(2.01, 5, back), clip(2, 2.01, back), clip(0, 2, back)], undefined))).toEqual([null, 5, 5]);
    // The run stops where the source does not run on
    expect(joinOuts(planPicture([clip(0, 2, slow), clip(2, 3, slow), clip(3.5, 5, slow)], undefined))).toEqual([3, null, null]);
  });

  it("names none where the frames do not run on: another source, a gap in the source, a piece unwarped or the other way, one clip", () => {
    for (const clips of [
      [clip(0, 2, slow), clip(2, 5, slow, "b")],
      [clip(0, 2, slow), clip(2.5, 5, slow)],
      [clip(0, 2, slow), clip(2, 5)],
      [clip(0, 2, slow), clip(2, 5, back)],
      [clip(2, 5, back), clip(0, 2, slow)],
    ]) {
      expect(joinOuts(planPicture(clips, undefined))).toEqual([null, null]);
    }
    expect(joinOuts(planPicture([clip(0.5, 2, slow)], undefined))).toEqual([null]);
  });

  it("in a placed stack, only between pieces of one run", () => {
    const placed = { overlapSec: 1, crossfade: true, placed: true };
    // b over the join's row order makes the layout placed; the pieces still continue each other
    const run = planPicture([clip(0, 2, slow, "a", 0), clip(2, 5, slow, "a", 4), clip(0, 3, undefined, "b", 1)], placed);
    expect(run.route.kind).toBe("placed");
    expect(joinOuts(run)).toEqual([5, null, null]);
    // A second between them: two runs
    const apart = planPicture([clip(0, 2, slow, "a", 0), clip(2, 5, slow, "a", 5), clip(0, 3, undefined, "b", 1)], placed);
    expect(apart.env!.runOf[0]).not.toBe(apart.env!.runOf[1]);
    expect(joinOuts(apart)).toEqual([null, null, null]);
  });
});

describe("a split", () => {
  /** A piece's frames as frameTable lists them: framesIn, and at a join the first frame at or after Out before joinOut. */
  function pieceFrames(fps: number, duration: number, inSec: number, outSec: number, joinOut: number | null): number[] {
    const all = Array.from({ length: Math.round(duration * fps) }, (_, j) => j / fps);
    const times = all.filter((t, j) => (all[j + 1] === undefined || all[j + 1] > inSec) && t < outSec);
    const past = all.find((t) => t >= outSec);
    return joinOut !== null && past !== undefined && past < joinOut ? [...times, past] : times;
  }
  /** What each slot of [from, to) shows, by source time: one frame, or two and the blend's alpha. */
  function shown(times: number[], m: WarpMap, anchor: number, from: number, to: number): string[] {
    const out: string[] = [];
    for (let n = from; n < to; n++) {
      const pick = pickFrame(times, warpSlotTime(m, n, anchor), blendsOnSlot(m, n, anchor));
      out.push(pick.b < 0 ? `${times[pick.a]}` : `${times[pick.a]}~${times[pick.b]}@${pick.alpha.toFixed(6)}`);
    }
    return out;
  }

  it("shows on every slot what the whole clip shows, a split on a slot, at constant speeds and on ramps, both ways", () => {
    const rnd = lcg(5);
    const fps = 24;
    const duration = 1.5;
    const range = { inSec: 0, outSec: duration };
    const wrong: string[] = [];
    for (const base of [W(0.5), W(0.1), W(2), W(1, { curve: { kind: "preset", name: "easeInOutSine" } }), W(2, { curve: { kind: "preset", name: "easeInCubic" } })]) {
      for (const reverse of [false, true]) {
        for (const blend of [false, true]) {
          const warp = normalizeWarp({ ...base, reverse, blend })!;
          const whole = warpMap(range, warp);
          const total = Math.round(whole.length * 60);
          const all = shown(pieceFrames(fps, duration, 0, duration, null), whole, 0, 0, total);
          for (let cut = 0; cut < 10; cut++) {
            const k = 1 + Math.floor(rnd() * (total - 2));
            const pieces = splitWarp(range, warp, k / 60);
            if (!pieces) continue;
            const clips = [pieces.first, pieces.second].map(({ range: r, warp: w }) => ({ ...r, sourceDuration: duration, source: "a", warp: w }));
            const p = planPicture(clips, undefined);
            const joins = joinOuts(p);
            const at = p.planned.map((piece) => secToSlot(piece.seqStart));
            expect(at).toEqual([0, k]);
            const joined = p.planned.flatMap((piece, i) => {
              const m = warpMap({ inSec: piece.inSec, outSec: piece.outSec }, piece.warp!);
              const times = pieceFrames(fps, duration, piece.inSec, piece.outSec, joins[i]);
              return shown(times, m, at[i], at[i], i === 0 ? k : total);
            });
            joined.forEach((s, n) => {
              if (s !== all[n]) wrong.push(`${JSON.stringify(base)} reverse ${reverse} blend ${blend} cut ${k}: slot ${n} ${s}, whole ${all[n]}`);
            });
          }
        }
      }
    }
    expect(wrong.slice(0, 5)).toEqual([]);
  });

  it("shows on every slot what the whole clip shows when split twice, the middle piece holding no frame of its own", () => {
    const rnd = lcg(9);
    const fps = 24;
    const duration = 1.5;
    const range = { inSec: 0, outSec: duration };
    const all = Array.from({ length: Math.round(duration * fps) }, (_, j) => j / fps);
    const wrong: string[] = [];
    let frameless = 0;
    for (const base of [W(0.1), W(0.2, { curve: { kind: "preset", name: "easeInCubic" } })]) {
      for (const reverse of [false, true]) {
        for (const blend of [false, true]) {
          const warp = normalizeWarp({ ...base, reverse, blend })!;
          const whole = warpMap(range, warp);
          const total = Math.round(whole.length * 60);
          const shownWhole = shown(pieceFrames(fps, duration, 0, duration, null), whole, 0, 0, total);
          for (let cut = 0; cut < 12; cut++) {
            // The middle piece: a few slots, under a source frame's interval at these speeds
            const k1 = 1 + Math.floor(rnd() * (total - 40));
            const k2 = k1 + 1 + Math.floor(rnd() * 20);
            const once = splitWarp(range, warp, k1 / 60);
            const twice = once && splitWarp(once.second.range, once.second.warp, (k2 - k1) / 60);
            if (!once || !twice) continue;
            const pieces = [once.first, twice.first, twice.second];
            if (!all.some((t) => t >= twice.first.range.inSec && t < twice.first.range.outSec)) frameless++;
            const p = planPicture(
              pieces.map(({ range: r, warp: w }) => ({ ...r, sourceDuration: duration, source: "a", warp: w })),
              undefined,
            );
            const joins = joinOuts(p);
            const at = p.planned.map((piece) => secToSlot(piece.seqStart));
            expect(at).toEqual([0, k1, k2]);
            const joined = p.planned.flatMap((piece, i) => {
              const m = warpMap({ inSec: piece.inSec, outSec: piece.outSec }, piece.warp!);
              const times = pieceFrames(fps, duration, piece.inSec, piece.outSec, joins[i]);
              return shown(times, m, at[i], at[i], i < 2 ? at[i + 1] : total);
            });
            joined.forEach((s, n) => {
              if (s !== shownWhole[n]) wrong.push(`${JSON.stringify(base)} reverse ${reverse} blend ${blend} cuts ${k1}, ${k2}: slot ${n} ${s}, whole ${shownWhole[n]}`);
            });
          }
        }
      }
    }
    expect(frameless).toBeGreaterThan(10);
    expect(wrong.slice(0, 5)).toEqual([]);
  });
});

describe("reverseChunk", () => {
  /** Events of a reversed 1× clip over n frames at 60 fps: one frame per slot, falling. */
  const reversedEvents = (n: number) => {
    const times = Array.from({ length: n }, (_, j) => j / 60);
    return warpEvents(times, map(0, n / 60, W(1, { reverse: true })), { anchorSlot: 0, fromSlot: 0, endSlot: n });
  };
  /** Every chunk from the first event on, and the frames decoding them costs (from the key at or before each's lowest). */
  function chunks(events: WarpEvents, maxFrames: number, keys: number[]) {
    const out = [];
    let decoded = 0;
    for (let e = 0; e < events.count; ) {
      const chunk = reverseChunk(events, e, maxFrames, keys);
      const key = Math.max(...keys.filter((k) => k <= chunk.lo));
      decoded += chunk.hi - key + 1;
      out.push(chunk);
      e = chunk.end;
    }
    return { out, decoded };
  }
  const every50 = [0, 50, 100, 150, 200, 250];

  it("starts each chunk at a key frame when a whole GOP fits, so every frame is decoded once", () => {
    const events = reversedEvents(300);
    const { out, decoded } = chunks(events, 96, every50);
    expect(out.every((chunk) => chunk.need.length <= 96 && every50.includes(chunk.lo))).toBe(true);
    expect(out.map((chunk) => [chunk.first, chunk.end])).toEqual(Array.from({ length: 6 }, (_, i) => [50 * i, 50 * i + 50]));
    expect(decoded).toBe(300);
  });

  it("decodes a GOP's head again for each chunk when the GOP is longer than a chunk", () => {
    expect(chunks(reversedEvents(300), 15, every50)).toMatchObject({ decoded: 660 });
    expect(chunks(reversedEvents(300), 15, every50).out).toHaveLength(24);
    const oneGop = chunks(reversedEvents(169), 96, [0]);
    expect(oneGop.out).toHaveLength(2);
    expect(oneGop.decoded).toBe(242);
    expect(Array.from(oneGop.out[0].need)).toEqual(Array.from({ length: 96 }, (_, j) => 73 + j));
  });

  it("keeps a blend's pair within a chunk, and at least two frames whatever their size", () => {
    expect(reverseChunkFrames(1)).toBe(96);
    expect(reverseChunkFrames(4096 * 2160 * 1.5)).toBe(15);
    expect(reverseChunkFrames(1e12)).toBe(2);
    const times = Array.from({ length: 24 }, (_, j) => j / 24);
    const events = warpEvents(times, map(0, 23 / 24, W(0.5, { reverse: true, blend: true })), { anchorSlot: 0, fromSlot: 0, endSlot: 230 });
    for (let e = 0; e < events.count; ) {
      const chunk = reverseChunk(events, e, 2, []);
      expect(chunk.end).toBeGreaterThan(e);
      for (let i = chunk.first; i < chunk.end; i++) {
        expect(Array.from(chunk.need)).toContain(events.a[i]);
        if (events.b[i] >= 0) expect(Array.from(chunk.need)).toContain(events.b[i]);
      }
      e = chunk.end;
    }
  });
});

describe("frameIndexAt", () => {
  it("names the listed frame a decoded timestamp is, within MATCH_EPS", () => {
    const times = [0, 1 / 24, 2 / 24];
    expect(frameIndexAt(times, 1 / 24 + 5e-7)).toBe(1);
    expect(frameIndexAt(times, 1 / 24 - 5e-7)).toBe(1);
    expect(frameIndexAt(times, -1)).toBe(0);
    expect(frameIndexAt(times, 9)).toBe(2);
  });
});
