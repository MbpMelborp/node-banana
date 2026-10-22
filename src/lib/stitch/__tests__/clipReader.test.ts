import { describe, it, expect, vi } from "vitest";
import type { VideoSample } from "mediabunny";
import { ClipReader, encodePlacedLoop, type PlacedClipSource } from "../clipReader";
import type { FrameBlender } from "../crossfadeFrames";
import { buildEnvelope, warpedUnitEnds } from "../placement";
import { pictureSegments, unitSlots } from "../placedSchedule";
import { FrameSlotter } from "../sequencePlan";
import { warpMap } from "../warp";
import { pickFrame, warpSlotTime } from "../warpFrames";
import { WarpedClipReader } from "../warpReader";

interface Fake {
  name: string;
  timestamp: number;
  closed: boolean;
  close: () => void;
  clone: () => Fake;
  setTimestamp: ReturnType<typeof vi.fn>;
  setDuration: ReturnType<typeof vi.fn>;
  codedWidth: number;
  codedHeight: number;
  format: string;
  colorSpace: Record<string, unknown>;
}

/** Every fake made, to check that each is closed. */
const made: Fake[] = [];

function fake(name: string, timestamp: number): Fake {
  const f: Fake = {
    name,
    timestamp,
    closed: false,
    close: () => {
      f.closed = true;
    },
    clone: () => fake(`${name}'`, f.timestamp),
    setTimestamp: vi.fn((t: number) => {
      f.timestamp = t;
    }),
    setDuration: vi.fn(),
    codedWidth: 64,
    codedHeight: 36,
    format: "NV12",
    colorSpace: {},
  };
  made.push(f);
  return f;
}

/** A decoder over these frame times (in decode order); return() resolves a tick later and is recorded. */
function decoder(times: number[], opts: { failAt?: number } = {}) {
  const state = { returned: false, yielded: 0 };
  let i = 0;
  const iterator: AsyncIterator<VideoSample, void, unknown> = {
    next: async () => {
      if (opts.failAt === i) throw new Error("decoder broke");
      if (state.returned || i >= times.length) return { done: true, value: undefined };
      state.yielded++;
      const sample = fake(`f${i}`, times[i]);
      i++;
      return { done: false, value: sample as unknown as VideoSample };
    },
    return: async () => {
      await Promise.resolve();
      state.returned = true;
      return { done: true, value: undefined };
    },
  };
  return { iterator, state };
}

const asFake = (sample: VideoSample | null) => sample as unknown as Fake | null;

describe("ClipReader", () => {
  it("puts the frame held before In on the anchor only when no frame lands there", async () => {
    // origin 1.0: the frame at 0.98 is before it; the next lands on the anchor itself
    const onAnchor = new ClipReader(decoder([0.98, 1.0, 1.05]).iterator, { origin: 1, anchorSlot: 100, endSlot: 200 });
    expect(asFake(await onAnchor.frameOn(100))?.name).toBe("f1");
    // The next lands a slot later (1.02 → slot 101), so the held frame takes the anchor
    const later = new ClipReader(decoder([0.98, 1.02, 1.06]).iterator, { origin: 1, anchorSlot: 100, endSlot: 200 });
    expect(asFake(await later.frameOn(100))?.name).toBe("f0");
    expect(asFake(await later.frameOn(101))?.name).toBe("f1");
    // Nothing after In: the held frame alone
    const alone = new ClipReader(decoder([0.5]).iterator, { origin: 1, anchorSlot: 100, endSlot: 200 });
    expect(asFake(await alone.frameOn(150))?.name).toBe("f0");
  });

  it("keeps the first of two frames on one slot, and returns the earlier frame between two", async () => {
    const reader = new ClipReader(decoder([0, 0.004, 0.05, 0.1]).iterator, { origin: 0, anchorSlot: 0, endSlot: 100 });
    expect(asFake(await reader.frameOn(0))?.name).toBe("f0");
    // 0.05 lands on slot 3: slots 1 and 2 still show f0
    expect(asFake(await reader.frameOn(2))?.name).toBe("f0");
    expect(asFake(await reader.frameOn(4))?.name).toBe("f2");
    // f1 shared f0's slot and was dropped (and closed); f0 was passed and closed
    expect(made.find((f) => f.name === "f1" && f.timestamp === 0.004)?.closed).toBe(true);
  });

  it("names the next slot its frame changes on, then Infinity; nothing on or past the end slot counts", async () => {
    const reader = new ClipReader(decoder([0, 1 / 24, 2 / 24, 3 / 24]).iterator, { origin: 0, anchorSlot: 10, endSlot: 16 });
    await reader.frameOn(10);
    expect(await reader.nextChangeSlot()).toBe(13);
    await reader.frameOn(13);
    expect(await reader.nextChangeSlot()).toBe(15);
    await reader.frameOn(15);
    // 3/24 lands on 18, past the end
    expect(await reader.nextChangeSlot()).toBe(Infinity);
    expect(asFake(await reader.frameOn(30))?.name).toBe("f2");
    await reader.close();
  });

  it("passes frames through as clones at slot timestamps lasting one slot, each closed after it is written", async () => {
    const reader = new ClipReader(decoder([0, 1 / 24, 2 / 24, 3 / 24, 4 / 24]).iterator, { origin: 0, anchorSlot: 60, endSlot: 600 });
    const written: Array<{ slot: number; name: string; closedAtWrite: boolean; sample: Fake }> = [];
    await reader.passThrough(61, 68, async (sample, slot) => {
      const f = asFake(sample)!;
      written.push({ slot, name: f.name, closedAtWrite: f.closed, sample: f });
    });
    // The frame in effect on 61 (f0, from slot 60), then f1 (63), f2 (65), f3 (68 is past the range)
    expect(written.map((w) => [w.slot, w.name])).toEqual([
      [61, "f0'"],
      [63, "f1'"],
      [65, "f2'"],
    ]);
    for (const w of written) {
      expect(w.closedAtWrite).toBe(false);
      expect(w.sample.closed).toBe(true);
      expect(w.sample.setTimestamp).toHaveBeenCalledWith(w.slot / 60);
      expect(w.sample.setDuration).toHaveBeenCalledWith(1 / 60);
    }
    // The reader kept the original of the frame it passed last
    expect(asFake(await reader.frameOn(66))?.name).toBe("f2");
    await reader.close();
  });

  it("writes nothing for an empty range", async () => {
    const reader = new ClipReader(decoder([0, 0.5]).iterator, { origin: 0, anchorSlot: 0, endSlot: 100 });
    const write = vi.fn();
    await reader.passThrough(5, 5, write);
    await reader.passThrough(6, 5, write);
    expect(write).not.toHaveBeenCalled();
    await reader.close();
  });

  it("closes every frame it holds and awaits the decoder's return() on close", async () => {
    made.length = 0;
    const { iterator, state } = decoder([0.4, 0.98, 1.02, 1.5]);
    const reader = new ClipReader(iterator, { origin: 1, anchorSlot: 0, endSlot: 100 });
    await reader.frameOn(0);
    await reader.nextChangeSlot();
    await reader.close();
    expect(state.returned).toBe(true);
    expect(made.every((f) => f.closed)).toBe(true);
    // Closing twice is harmless
    await reader.close();
  });
});

describe("encodePlacedLoop", () => {
  const at24 = (count: number) => Array.from({ length: count }, (_, j) => j / 24);

  /** C [1.5, 5) over B [1, 5) over A [0, 5): all three blend over [1.5, 2), where B and C are still fading in. */
  function threeLayers(fail: { unit: number; at?: number } | null, abortAfter?: { signal: AbortController; writes: number }) {
    made.length = 0;
    const env = buildEnvelope(
      [
        { start: 1.5, length: 3.5, row: 0, source: "c", inSec: 0 },
        { start: 1, length: 4, row: 1, source: "b", inSec: 0 },
        { start: 0, length: 5, row: 2, source: "a", inSec: 0 },
      ],
      true,
    );
    const decoders: Array<ReturnType<typeof decoder>["state"]> = [];
    const opened: Array<{ unit: number; run: { n0: number; n1: number } }> = [];
    const sources: PlacedClipSource[] = [0, 1, 2].map((unit) => ({
      inSec: 0,
      outSec: 5,
      origin: 0,
      frameRate: 24,
      open: (_range, window, run) => {
        opened.push({ unit, run });
        const d = decoder(at24(120), fail && fail.unit === unit ? { failAt: fail.at ?? 30 } : {});
        decoders.push(d.state);
        return new ClipReader(d.iterator, window);
      },
    }));
    let writes = 0;
    const blender: FrameBlender = {
      blend: vi.fn(),
      composite: vi.fn(async (_layers, timestamp) => fake("composite", timestamp) as unknown as VideoSample),
      black: vi.fn((timestamp) => fake("black", timestamp) as unknown as VideoSample),
    };
    const slotter = new FrameSlotter(60);
    const run = () =>
      encodePlacedLoop({
        env,
        segments: pictureSegments(env),
        loop: 0,
        sources,
        state: { ref: null, blender: null },
        fallbackRef: { width: 64, height: 36 },
        makeBlender: () => blender,
        claim: (slot) => slotter.claim(slot),
        add: async () => {
          writes++;
          if (abortAfter && writes === abortAfter.writes) abortAfter.signal.abort();
        },
        failure: (unit, error) => new Error(`unit ${unit}: ${error instanceof Error ? error.message : String(error)}`),
        signal: abortAfter?.signal.signal,
      });
    return { run, decoders, blender, env, opened };
  }

  it("opens each reader with its visibility run", async () => {
    const { run, opened } = threeLayers(null);
    await run();
    // C on [1.5, 5)
    expect(opened.find((o) => o.unit === 0)?.run).toEqual({ n0: 90, n1: 300 });
  });

  it("takes a retimed clip's frames from its warp schedule in every blend it shows in, writing rising slots", async () => {
    made.length = 0;
    // B at 2× (8 s of source in 4 s) under C and over A, as threeLayers lays them out
    const env = buildEnvelope(
      [
        { start: 1.5, length: 3.5, row: 0, source: "c", inSec: 0 },
        { start: 1, length: 4, row: 1, source: "b", inSec: 0, sourceEnds: warpedUnitEnds(0, 8, false) },
        { start: 0, length: 5, row: 2, source: "a", inSec: 0 },
      ],
      true,
    );
    const bTimes = at24(192);
    const map = warpMap({ inSec: 0, outSec: 8 }, { speed: 2, curve: null, reverse: false, blend: false });
    const decoders: Array<ReturnType<typeof decoder>["state"]> = [];
    // Frames named by their index in the source, from the one in effect at `from`
    const samplesOf = (times: number[]) => (from: number, to: number) => {
      const state = { returned: false, yielded: 0 };
      decoders.push(state);
      async function* run() {
        try {
          for (let j = Math.max(0, times.findLastIndex((t) => t <= from)); j < times.length && times[j] < to; j++) {
            yield fake(`b${j}`, times[j]) as unknown as VideoSample;
          }
        } finally {
          state.returned = true;
        }
      }
      return run();
    };
    const sources: PlacedClipSource[] = [0, 1, 2].map((unit) => ({
      inSec: 0,
      outSec: unit === 1 ? 8 : 5,
      origin: 0,
      frameRate: 24,
      open: (range, window, run) => {
        if (unit !== 1) {
          const d = decoder(at24(120));
          decoders.push(d.state);
          return new ClipReader(d.iterator, window);
        }
        return new WarpedClipReader(map, { anchorSlot: window.anchorSlot, fromSlot: run.n0, endSlot: window.endSlot }, {
          frames: async () => ({ times: Float64Array.from(bTimes), keys: Int32Array.from([0]) }),
          samples: samplesOf(bTimes),
          frameBytes: 64 * 36 * 1.5,
          blend: null,
        });
      },
    }));
    const shownB: Array<{ slot: number; name: string }> = [];
    const blender: FrameBlender = {
      blend: vi.fn(),
      composite: vi.fn<FrameBlender["composite"]>(async (layers, timestamp) => {
        const b = layers.map((layer) => asFake(layer.sample)?.name ?? "").find((name) => name.startsWith("b"));
        if (b) shownB.push({ slot: Math.round(timestamp * 60), name: b });
        return fake("composite", timestamp) as unknown as VideoSample;
      }),
      black: vi.fn((timestamp) => fake("black", timestamp) as unknown as VideoSample),
    };
    const slotter = new FrameSlotter(60);
    const written: number[] = [];
    await encodePlacedLoop({
      env,
      segments: pictureSegments(env),
      loop: 0,
      sources,
      state: { ref: null, blender: null },
      fallbackRef: { width: 64, height: 36 },
      makeBlender: () => blender,
      claim: (slot) => slotter.claim(slot),
      add: async (sample) => {
        written.push(Math.round(asFake(sample)!.timestamp * 60));
      },
      failure: (_unit, error) => (error instanceof Error ? error : new Error(String(error))),
    });
    written.forEach((slot, i) => i > 0 && expect(slot).toBeGreaterThan(written[i - 1]));
    // B blends over A, under C, then fades out under C: [A, B], [A, B, C], [B, C]
    const anchor = unitSlots(env, 1, 0).anchor;
    expect(shownB.length).toBeGreaterThan(60);
    for (const { slot, name } of shownB) expect(name).toBe(`b${pickFrame(bTimes, warpSlotTime(map, slot, anchor), false).a}`);
    expect(made.every((f) => f.closed)).toBe(true);
    expect(decoders.every((d) => d.returned)).toBe(true);
  });

  it("blends three layers, then closes every frame and returns every decoder", async () => {
    const { run, decoders, blender } = threeLayers(null);
    await run();
    expect(blender.composite).toHaveBeenCalled();
    expect(decoders.length).toBeGreaterThanOrEqual(3);
    expect(decoders.every((d) => d.returned)).toBe(true);
    expect(made.every((f) => f.closed)).toBe(true);
  });

  it("stops on an abort inside a composite: every frame closed, every decoder returned", async () => {
    const controller = new AbortController();
    const { run, decoders } = threeLayers(null, { signal: controller, writes: 50 });
    await expect(run()).rejects.toMatchObject({ name: "AbortError" });
    expect(decoders.length).toBe(3);
    expect(decoders.every((d) => d.returned)).toBe(true);
    expect(made.every((f) => f.closed)).toBe(true);
  });

  it("names the clips at once when a decoder fails in a blend of three, and the clip otherwise", async () => {
    // A (unit 2) fails reading its frame 42 (1.75 s), inside the three-layer blend
    await expect(threeLayers({ unit: 2, at: 42 }).run()).rejects.toThrow(
      "Could not decode 3 clips at once at 0:02. Move some apart or turn Crossfade off.",
    );
    // Its 10th frame (0.4 s) is in its own solo stretch
    await expect(threeLayers({ unit: 2, at: 10 }).run()).rejects.toThrow("unit 2: decoder broke");
  });
});
