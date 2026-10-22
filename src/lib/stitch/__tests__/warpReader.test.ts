import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import type { VideoSample } from "mediabunny";
import type { ClipWarp, ClipWarpCurve } from "@/types";
import { normalizeWarp, warpMap, type WarpMap } from "../warp";
import { REVERSE_CACHE_BYTES, reverseChunkFrames, warpEvents, type WarpSlots } from "../warpFrames";
import {
  clipBlend,
  copyToBytes,
  frameTable,
  WarpedClipReader,
  type ClipFrames,
  type PacketIndex,
  type WarpBlend,
} from "../warpReader";

/** Every VideoSample the module constructs: its data and init. */
const constructed: Array<{ data: unknown; init: Record<string, unknown> }> = [];

vi.mock("mediabunny", () => {
  class VideoSampleMock {
    data: unknown;
    init: Record<string, unknown>;
    constructor(data: unknown, init: Record<string, unknown>) {
      this.data = data instanceof Uint8Array ? data.slice() : data;
      this.init = init;
      constructed.push(this);
    }
  }
  return { VideoSample: VideoSampleMock, VideoSampleSink: class {}, EncodedPacketSink: class {} };
});

const W = (speed: number, extra: Partial<ClipWarp> = {}): ClipWarp => ({
  speed,
  curve: null,
  reverse: false,
  blend: false,
  ...extra,
});

interface Fake {
  name: string;
  timestamp: number;
  rotation: number;
  duration: number;
  format: string;
  codedWidth: number;
  codedHeight: number;
  colorSpace: Record<string, unknown>;
  bytes: boolean;
  closed: boolean;
  close: () => void;
  clone: () => Fake;
  setTimestamp: ReturnType<typeof vi.fn>;
  setDuration: ReturnType<typeof vi.fn>;
  setRotation: ReturnType<typeof vi.fn>;
  allocationSize: () => number;
  copyTo: ReturnType<typeof vi.fn>;
}

/**
 * A source over these frame times: samples(from, to) decodes from the key at or before the frame in effect at `from`
 * and yields from that frame on, every frame before `to`. Counts decodes, the store's frames open at once (decoded
 * and byte copies; clones and blends apart), copies and stopped decoders.
 */
function source(times: number[], keys: number[], opts: { skip?: number; failAt?: number } = {}) {
  const ledger = { decoded: 0, copies: 0, peak: 0, calls: [] as Array<[number, number]>, decoders: 0, stopped: 0 };
  const store = new Set<Fake>();
  const others: Fake[] = [];
  const fake = (name: string, timestamp: number, held: boolean): Fake => {
    const f: Fake = {
      name,
      timestamp,
      rotation: 0,
      duration: 1 / 24,
      format: "NV12",
      codedWidth: 4,
      codedHeight: 2,
      colorSpace: {},
      bytes: false,
      closed: false,
      close: () => {
        f.closed = true;
        store.delete(f);
      },
      clone: () => fake(`${name}'`, f.timestamp, false),
      setTimestamp: vi.fn(),
      setDuration: vi.fn(),
      setRotation: vi.fn(),
      allocationSize: () => 12,
      copyTo: vi.fn(async () => []),
    };
    if (held) {
      store.add(f);
      ledger.peak = Math.max(ledger.peak, store.size);
    } else {
      others.push(f);
    }
    return f;
  };
  const samples = (from: number, to: number): AsyncIterable<VideoSample> => {
    ledger.calls.push([from, to]);
    ledger.decoders++;
    const inEffect = Math.max(0, times.reduce((found, t, i) => (t <= from ? i : found), -1));
    const key = Math.max(0, ...keys.filter((k) => k <= inEffect));
    async function* run() {
      try {
        for (let i = key; i < times.length && times[i] < to; i++) {
          if (opts.failAt === i) throw new Error("decoder broke");
          ledger.decoded++;
          if (i < inEffect || opts.skip === i) continue;
          yield fake(`f${i}`, times[i], true) as unknown as VideoSample;
        }
      } finally {
        ledger.stopped++;
      }
    }
    return run();
  };
  const toBytes = async (sample: VideoSample) => {
    ledger.copies++;
    const copy = fake((sample as unknown as Fake).name, sample.timestamp, true);
    copy.bytes = true;
    return copy as unknown as VideoSample;
  };
  const frames = (): ClipFrames => ({ times: Float64Array.from(times), keys: Int32Array.from(keys) });
  return { samples, toBytes, frames, ledger, store, others };
}

/** A blend that records its frames and returns a closable result. */
function recordingBlend() {
  const calls: Array<{ a: string; b: string; alpha: number; timestamp: number }> = [];
  const results: Array<{ closed: boolean }> = [];
  const blend: WarpBlend = async (a, b, alpha, timestamp) => {
    calls.push({ a: (a as unknown as Fake).name, b: (b as unknown as Fake).name, alpha, timestamp });
    const result = {
      name: "blend",
      closed: false,
      close() {
        result.closed = true;
      },
      clone: () => ({ name: "blend'", close: vi.fn(), setTimestamp: vi.fn(), setDuration: vi.fn() }),
    };
    results.push(result);
    return result as unknown as VideoSample;
  };
  return { blend, calls, results };
}

const at = (fps: number, count: number) => Array.from({ length: count }, (_, j) => j / fps);

function reader(
  src: ReturnType<typeof source>,
  m: WarpMap,
  slots: WarpSlots,
  extra: { blend?: WarpBlend | null; signal?: AbortSignal } = {},
) {
  return new WarpedClipReader(m, slots, {
    frames: async () => src.frames(),
    samples: src.samples,
    toBytes: src.toBytes,
    frameBytes: 12,
    blend: extra.blend ?? null,
    signal: extra.signal,
  });
}

const nameOf = (sample: VideoSample | null) => (sample as unknown as Fake | null)?.name ?? null;

describe("WarpedClipReader, forward", () => {
  it("shows the schedule's frame on every slot, decoding once from the first pick to Out", async () => {
    // The clip's frames are [0.5, 4) of a 24 fps source; it starts on slot 10
    const times = at(24, 96);
    const src = source(times, [0]);
    const m = warpMap({ inSec: 0.5, outSec: 4 }, W(2));
    const slots = { anchorSlot: 10, fromSlot: 10, endSlot: 115 };
    const events = warpEvents(times, m, slots);
    const r = reader(src, m, slots);
    let e = 0;
    for (let n = 10; n < 115; n++) {
      while (e + 1 < events.count && events.slots[e + 1] <= n) e++;
      expect(nameOf(await r.frameOn(n))).toBe(`f${events.a[e]}`);
    }
    expect(src.ledger.calls).toEqual([[0.5, 4]]);
    await r.close();
    expect(src.store.size).toBe(0);
    expect(src.ledger.stopped).toBe(1);
  });

  it("passes each change through once, lasting until the next change or the pass's end", async () => {
    const times = at(24, 96);
    const src = source(times, [0]);
    const m = warpMap({ inSec: 0, outSec: 4 }, W(2));
    const slots = { anchorSlot: 0, fromSlot: 0, endSlot: 120 };
    const events = warpEvents(times, m, slots);
    const r = reader(src, m, slots);
    const written: Array<{ slot: number; name: string; closedAtWrite: boolean; sample: Fake }> = [];
    await r.passThrough(0, 100, async (sample, slot) => {
      const f = sample as unknown as Fake;
      written.push({ slot, name: f.name, closedAtWrite: f.closed, sample: f });
    });
    const changes = Array.from(events.slots.subarray(0, events.count)).filter((slot) => slot < 100);
    expect(written.map((w) => w.slot)).toEqual(changes);
    written.forEach((w, i) => {
      const until = written[i + 1]?.slot ?? 100;
      expect(w.closedAtWrite).toBe(false);
      expect(w.sample.closed).toBe(true);
      expect(w.sample.setTimestamp).toHaveBeenCalledWith(w.slot / 60);
      expect(w.sample.setDuration).toHaveBeenCalledWith((until - w.slot) / 60);
      if (i > 0) expect(w.name).not.toBe(written[i - 1].name);
    });
    await r.close();
    expect(src.store.size).toBe(0);
  });

  it("holds at most two frames in fast motion, three while a blending ramp copies one, every frame right", async () => {
    const expoIn: ClipWarpCurve = { kind: "preset", name: "easeInExpo" };
    for (const [warp, most] of [
      [W(10), 2],
      [normalizeWarp(W(10, { curve: expoIn, blend: true }))!, 3],
    ] as const) {
      const times = at(60, 600);
      const keys = times.map((_, j) => j).filter((j) => j % 30 === 0);
      const src = source(times, keys);
      const m = warpMap({ inSec: 0, outSec: 10 }, warp);
      const slots = { anchorSlot: 0, fromSlot: 0, endSlot: 60 };
      const events = warpEvents(times, m, slots);
      const { blend } = recordingBlend();
      const r = reader(src, m, slots, { blend });
      for (let e = 0; e < events.count; e++) {
        const sample = await r.frameOn(events.slots[e]);
        if (events.b[e] < 0) expect(nameOf(sample)).toBe(`f${events.a[e]}`);
      }
      expect(src.ledger.peak).toBeLessThanOrEqual(most);
      await r.close();
      expect(src.store.size).toBe(0);
    }
  });

  it("gives every event's frames over random blending ramps, holding at most three", async () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const names = ["easeInOutCubic", "easeInOutSine", "easeInQuint", "easeOutCirc", "easeInExpo"];
    for (let c = 0; c < 60; c++) {
      const fps = [24, 25, 30, 50, 60][Math.floor(rnd() * 5)];
      const len = 1 + rnd() * 3;
      const speed = Math.exp(Math.log(0.1) + rnd() * Math.log(100));
      if (len / speed > 20) continue;
      const times = at(fps, Math.floor(len * fps));
      const keys = times.map((_, j) => j).filter((j) => j % [1, 12, 48][Math.floor(rnd() * 3)] === 0);
      const src = source(times, keys);
      const curve: ClipWarpCurve = { kind: "preset", name: names[Math.floor(rnd() * names.length)] };
      const m = warpMap({ inSec: 0, outSec: len }, normalizeWarp(W(speed, { curve, blend: true }))!);
      const slots = { anchorSlot: 0, fromSlot: 0, endSlot: Math.round(m.length * 60) };
      const events = warpEvents(times, m, slots);
      const { blend, calls } = recordingBlend();
      const r = reader(src, m, slots, { blend });
      const wrong: number[] = [];
      for (let e = 0; e < events.count; e++) {
        const sample = await r.frameOn(events.slots[e]);
        const shown = events.b[e] < 0 ? nameOf(sample) : `${calls.at(-1)?.a}+${calls.at(-1)?.b}`;
        if (shown !== (events.b[e] < 0 ? `f${events.a[e]}` : `f${events.a[e]}+f${events.b[e]}`)) wrong.push(events.slots[e]);
      }
      expect(wrong, `case ${c}`).toEqual([]);
      expect(src.ledger.peak).toBeLessThanOrEqual(3);
      await r.close();
      expect(src.store.size).toBe(0);
    }
  });

  it("blends the frame before with the next where a slowing ramp's pick falls into a blend", async () => {
    // easeInOutCubic at 0.5× on average over 3.3 s of a 24 fps source: 1.5× at its middle
    const times = at(24, 80);
    const src = source(times, [0]);
    const m = warpMap({ inSec: 0, outSec: 3.3 }, normalizeWarp(W(0.5, { curve: { kind: "preset", name: "easeInOutCubic" }, blend: true }))!);
    const slots = { anchorSlot: 0, fromSlot: 0, endSlot: Math.round(m.length * 60) };
    const events = warpEvents(times, m, slots);
    const { blend, calls } = recordingBlend();
    const r = reader(src, m, slots, { blend });
    let falls = 0;
    for (let e = 0; e < events.count; e++) {
      await r.frameOn(events.slots[e]);
      if (e > 0 && events.a[e] < events.a[e - 1]) {
        falls++;
        expect(calls.at(-1)).toMatchObject({ a: `f${events.a[e]}`, b: `f${events.a[e] + 1}` });
      }
    }
    expect(falls).toBeGreaterThan(0);
    await r.close();
  });

  it("blends each slow-motion event once, copying each source frame once and closing the blend it replaces", async () => {
    const times = at(24, 24);
    const src = source(times, [0]);
    const m = warpMap({ inSec: 0, outSec: 1 }, W(0.5, { blend: true }));
    const slots = { anchorSlot: 0, fromSlot: 0, endSlot: 120 };
    const events = warpEvents(times, m, slots);
    const { blend, calls, results } = recordingBlend();
    const r = reader(src, m, slots, { blend });
    expect(nameOf(await r.firstFrame())).toBe("f0");
    for (let n = 0; n < 120; n++) await r.frameOn(n);
    const blended = Array.from({ length: events.count }, (_, e) => e).filter((e) => events.b[e] >= 0);
    expect(calls.map((c) => [c.a, c.b, c.alpha, c.timestamp])).toEqual(
      blended.map((e) => [`f${events.a[e]}`, `f${events.b[e]}`, events.alpha[e], events.slots[e] / 60]),
    );
    expect(src.ledger.copies).toBe(24);
    expect(results.slice(0, -1).every((result) => result.closed)).toBe(true);
    // A source frame, never the blend shown
    expect(nameOf(await r.firstFrame())).toMatch(/^f\d+$/);
    await r.close();
    expect(results.every((result) => result.closed)).toBe(true);
    expect(src.store.size).toBe(0);
  });

  it("names its first change before any frame, and Infinity after the last", async () => {
    const src = source(at(24, 24), [0]);
    const m = warpMap({ inSec: 0, outSec: 1 }, W(2));
    const r = reader(src, m, { anchorSlot: 5, fromSlot: 5, endSlot: 35 });
    expect(await r.nextChangeSlot()).toBe(5);
    await r.frameOn(34);
    expect(await r.nextChangeSlot()).toBe(Infinity);
    await r.close();
  });

  it("decodes on to the frame a split's join lists past Out, and shows it where the whole clip would, both ways", async () => {
    // [0, 1.5) at 0.5× joined at 1.5 s: the list ends with frame 36 (1.5 s), its decode just past it
    const times = at(24, 96);
    const joined = { times: Float64Array.from(times.slice(0, 37)), keys: Int32Array.from([0]), end: 36.5 / 24 };
    for (const reverse of [false, true]) {
      const src = source(times, [0]);
      const m = warpMap({ inSec: 0, outSec: 1.5 }, W(0.5, { reverse }));
      const r = new WarpedClipReader(m, { anchorSlot: 0, fromSlot: 0, endSlot: 180 }, {
        frames: async () => joined,
        samples: src.samples,
        toBytes: src.toBytes,
        frameBytes: 12,
        blend: null,
      });
      // Within half a frame of the join (35.5/24 s of source on): slots 178–179 forward, 0–1 reversed
      expect(nameOf(await r.frameOn(reverse ? 0 : 179))).toBe("f36");
      expect(src.ledger.calls.at(-1)![1]).toBe(36.5 / 24);
      await r.close();
      expect(src.store.size).toBe(0);
    }
  });

  it("gives the frame before one the decoder skipped", async () => {
    const src = source(at(24, 24), [0], { skip: 6 });
    const m = warpMap({ inSec: 0, outSec: 1 }, W(0.5));
    const r = reader(src, m, { anchorSlot: 0, fromSlot: 0, endSlot: 120 });
    // Frame 6 shows on slots 28–32
    for (let n = 0; n < 30; n++) await r.frameOn(n);
    expect(nameOf(await r.frameOn(30))).toBe("f5");
    expect(nameOf(await r.frameOn(35))).toBe("f7");
    await r.close();
  });
});

describe("WarpedClipReader, reversed", () => {
  it("decodes a one-GOP source in two chunks, copying each frame once, and shows every slot's frame", async () => {
    const times = at(24, 169);
    const src = source(times, [0]);
    const m = warpMap({ inSec: 0, outSec: 169 / 24 }, W(1, { reverse: true }));
    const slots = { anchorSlot: 0, fromSlot: 0, endSlot: Math.round(m.length * 60) };
    const events = warpEvents(times, m, slots);
    const r = reader(src, m, slots);
    let e = 0;
    for (let n = 0; n < slots.endSlot; n++) {
      while (e + 1 < events.count && events.slots[e + 1] <= n) e++;
      expect(nameOf(await r.frameOn(n))).toBe(`f${events.a[e]}`);
    }
    expect(src.ledger.calls).toHaveLength(2);
    expect(src.ledger.decoded).toBe(242);
    expect(src.ledger.copies).toBe(169);
    await r.close();
    expect(src.store.size).toBe(0);
    expect(src.ledger.stopped).toBe(2);
  });

  it("decodes each frame once when chunks can start at key frames", async () => {
    const times = at(24, 300);
    const src = source(times, [0, 50, 100, 150, 200, 250]);
    const m = warpMap({ inSec: 0, outSec: 300 / 24 }, W(1, { reverse: true }));
    const slots = { anchorSlot: 0, fromSlot: 0, endSlot: Math.round(m.length * 60) };
    const r = reader(src, m, slots);
    await r.passThrough(0, slots.endSlot, async () => {});
    expect(src.ledger.decoded).toBe(300);
    await r.close();
    expect(src.store.size).toBe(0);
  });

  it("gives the nearest kept frame for one the decoder skipped", async () => {
    const times = at(24, 24);
    const src = source(times, [0], { skip: 10 });
    const m = warpMap({ inSec: 0, outSec: 1 }, W(0.5, { reverse: true }));
    const slots = { anchorSlot: 0, fromSlot: 0, endSlot: 120 };
    const events = warpEvents(times, m, slots);
    const r = reader(src, m, slots);
    const e = Array.from(events.a.subarray(0, events.count)).indexOf(10);
    expect(nameOf(await r.frameOn(events.slots[e]))).toMatch(/^f(9|11)$/);
    await r.close();
  });

  it("stops on an abort inside a chunk, and closes the decoded frame and the decoder", async () => {
    const times = at(24, 48);
    const src = source(times, [0]);
    const controller = new AbortController();
    const toBytes = src.toBytes;
    let copies = 0;
    const m = warpMap({ inSec: 0, outSec: 2 }, W(1, { reverse: true }));
    const r = new WarpedClipReader(m, { anchorSlot: 0, fromSlot: 0, endSlot: 120 }, {
      frames: async () => src.frames(),
      samples: src.samples,
      toBytes: async (sample) => {
        if (++copies === 10) controller.abort();
        return toBytes(sample);
      },
      frameBytes: 12,
      blend: null,
      signal: controller.signal,
    });
    await expect(r.frameOn(0)).rejects.toMatchObject({ name: "AbortError" });
    expect(src.ledger.stopped).toBe(1);
    await r.close();
    expect(src.store.size).toBe(0);
  });

  it("rejects when the decoder fails, and still closes everything", async () => {
    const src = source(at(24, 48), [0], { failAt: 30 });
    const m = warpMap({ inSec: 0, outSec: 2 }, W(1, { reverse: true }));
    const r = reader(src, m, { anchorSlot: 0, fromSlot: 0, endSlot: 120 });
    await expect(r.frameOn(0)).rejects.toThrow("decoder broke");
    await r.close();
    expect(src.store.size).toBe(0);
    expect(src.ledger.stopped).toBe(1);
  });

  describe("memory", () => {
    const pixels = 1920 * 1080;
    /**
     * A reversed one-GOP clip of 240 frames whose kept copies take `bytesOf(k)` for the k-th copy, its first chunk sized
     * for `bound` (the engine's: a 1080p canvas copy's 4 bytes a pixel).
     */
    async function reversed(bytesOf: (k: number) => number, bound = pixels * 4) {
      const times = at(24, 240);
      const src = source(times, [0]);
      let live = 0;
      let peak = 0;
      let copies = 0;
      const r = new WarpedClipReader(warpMap({ inSec: 0, outSec: 10 }, W(1, { reverse: true })), { anchorSlot: 0, fromSlot: 0, endSlot: 600 }, {
        frames: async () => src.frames(),
        samples: src.samples,
        toBytes: async (sample) => {
          const copy = (await src.toBytes(sample)) as unknown as Fake;
          const bytes = bytesOf(copies++);
          const close = copy.close;
          copy.allocationSize = () => bytes;
          copy.close = () => {
            if (!copy.closed) live -= bytes;
            close();
          };
          live += bytes;
          peak = Math.max(peak, live);
          return copy as unknown as VideoSample;
        },
        frameBytes: bound,
        blend: null,
      });
      await r.passThrough(0, 600, async () => {});
      await r.close();
      expect(src.store.size).toBe(0);
      // Each chunk's decode starts at its lowest frame
      return { peak, lows: src.ledger.calls.map(([from]) => Math.round(from * 24)) };
    }

    it("keeps its copies within REVERSE_CACHE_BYTES from the first chunk, when they are drawn on the canvas", async () => {
      const { peak, lows } = await reversed(() => pixels * 4);
      expect(peak).toBeLessThanOrEqual(REVERSE_CACHE_BYTES);
      expect(lows.slice(0, 2)).toEqual([240 - reverseChunkFrames(pixels * 4), 240 - 2 * reverseChunkFrames(pixels * 4)]);
    });

    it("sizes the chunks after the first by the copies it measured: the first copy's bytes, then any larger", async () => {
      // 1.5 bytes a pixel (NV12) until the 60th copy, frame 188 of the second chunk (152–215); 4 from then on, which
      // cuts that chunk to its top 24 frames (192–215)
      const first = reverseChunkFrames(pixels * 4);
      const small = reverseChunkFrames(pixels * 1.5);
      const { peak, lows } = await reversed((k) => (k < 60 ? pixels * 1.5 : pixels * 4));
      expect(peak).toBeLessThanOrEqual(REVERSE_CACHE_BYTES);
      expect(lows.slice(0, 3)).toEqual([240 - first, 240 - first - small, 240 - 3 * first]);
    });

    it("cuts its first chunk once a copy is wider than the bound: a non-square-pixel frame drawn at its display width", async () => {
      // An HDV-like 1440×1080 file (4:3 pixels) whose decoder gives 1920-wide frames: bound 32 frames, copies fit 24
      const bound = 1440 * 1080 * 4;
      const { peak, lows } = await reversed(() => pixels * 4, bound);
      expect(peak).toBeLessThanOrEqual(REVERSE_CACHE_BYTES);
      const fits = reverseChunkFrames(pixels * 4);
      // The first decode starts at the bound's chunk, and each chunk after holds `fits` frames
      expect(lows.slice(0, 3)).toEqual([240 - reverseChunkFrames(bound), 240 - 2 * fits, 240 - 3 * fits]);
    });
  });
});

describe("copyToBytes", () => {
  beforeEach(() => {
    constructed.length = 0;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const decoded = (size: number) =>
    ({
      format: "NV12",
      codedWidth: 1920,
      codedHeight: 1080,
      timestamp: 2,
      duration: 1 / 24,
      rotation: 90,
      colorSpace: { matrix: "bt709" },
      allocationSize: () => size,
      copyTo: vi.fn(async (buffer: Uint8Array) => {
        buffer.fill(7);
        return [{ offset: 0, stride: 1920 }];
      }),
      drawWithFit: vi.fn(),
    }) as unknown as VideoSample;

  it("keeps the frame's own bytes, format, size, layout, colour space and rotation", async () => {
    await copyToBytes(decoded(1920 * 1080 * 1.5));
    const [made] = constructed;
    expect((made.data as Uint8Array).length).toBe(1920 * 1080 * 1.5);
    expect((made.data as Uint8Array)[0]).toBe(7);
    expect(made.init).toEqual({
      format: "NV12",
      codedWidth: 1920,
      codedHeight: 1080,
      timestamp: 2,
      duration: 1 / 24,
      colorSpace: { matrix: "bt709" },
      layout: [{ offset: 0, stride: 1920 }],
      rotation: 90,
    });
  });

  it("draws a frame whose bytes are not the frame (non-square pixels) once on a canvas, keeping its rotation", async () => {
    class FakeOffscreen {
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext() {
        return { canvas: this };
      }
    }
    vi.stubGlobal("OffscreenCanvas", FakeOffscreen);
    // A 1440-wide copy of a frame mediabunny calls 1920 wide
    const frame = decoded(1440 * 1080 * 1.5);
    await copyToBytes(frame);
    const [made] = constructed;
    expect(made.data).toBeInstanceOf(FakeOffscreen);
    expect(made.data).toMatchObject({ width: 1920, height: 1080 });
    expect(made.init).toEqual({ timestamp: 2, duration: 1 / 24, rotation: 90 });
    expect(frame.drawWithFit).toHaveBeenCalledWith(expect.objectContaining({ canvas: made.data }), { fit: "fill", rotation: 0 });
  });

  it("resizes its one canvas for a frame of another size", async () => {
    class FakeOffscreen {
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext() {
        return { canvas: this };
      }
    }
    vi.stubGlobal("OffscreenCanvas", FakeOffscreen);
    const scratch = { buffer: null, ctx: null };
    const small = { ...decoded(0), codedWidth: 1280, codedHeight: 720 } as unknown as VideoSample;
    await copyToBytes(decoded(1440 * 1080 * 1.5), scratch);
    await copyToBytes(small, scratch);
    expect(constructed[1].data).toBe(constructed[0].data);
    expect(constructed[1].data).toMatchObject({ width: 1280, height: 720 });
  });
});

describe("clipBlend", () => {
  it("makes one blender at the clip's own size and gives each blend the frame's rotation", async () => {
    const results = [{ setRotation: vi.fn() }, { setRotation: vi.fn() }];
    const blender = { blend: vi.fn(async () => results.shift()), composite: vi.fn(), black: vi.fn() };
    const makeBlender = vi.fn(() => blender as never);
    const blend = clipBlend(makeBlender);
    const a = { codedWidth: 720, codedHeight: 1280, rotation: 90 } as unknown as VideoSample;
    const first = await blend(a, a, 0.5, 1, 1 / 60);
    const second = await blend(a, a, 0.25, 2, 1 / 60);
    expect(makeBlender).toHaveBeenCalledTimes(1);
    expect(makeBlender).toHaveBeenCalledWith({ width: 720, height: 1280 });
    expect((first as unknown as { setRotation: ReturnType<typeof vi.fn> }).setRotation).toHaveBeenCalledWith(90);
    expect((second as unknown as { setRotation: ReturnType<typeof vi.fn> }).setRotation).toHaveBeenCalledWith(90);
  });
});

describe("frameTable", () => {
  /** Packets in decode order: [name, frame number], times in frames / 24; I is a key. */
  function index(order: Array<[string, number]>) {
    const packets = order.map(([name, frame], i) => ({
      name,
      timestamp: frame / 24,
      type: (name[0] === "I" ? "key" : "delta") as "key" | "delta",
      i,
    }));
    const read: string[] = [];
    const seen = <T extends { name: string } | null>(packet: T) => {
      if (packet) read.push(packet.name);
      return packet;
    };
    const byTime = [...packets].sort((x, y) => x.timestamp - y.timestamp);
    const idx: PacketIndex<(typeof packets)[number]> = {
      inEffect: async (sec) => byTime.filter((p) => p.timestamp <= sec).pop() ?? null,
      keyAtOrBefore: async (sec) => seen(byTime.filter((p) => p.type === "key" && p.timestamp <= sec).pop() ?? null),
      first: async () => seen(packets[0]),
      next: async (packet) => seen(packets[packet.i + 1] ?? null),
    };
    return { idx, read };
  }
  const gop: Array<[string, number]> = [
    ["I0", 0],
    ["P3", 3],
    ["B1", 1],
    ["B2", 2],
    ["P6", 6],
    ["B4", 4],
    ["B5", 5],
    ["I9", 9],
    ["B7", 7],
    ["B8", 8],
    ["P12", 12],
  ];

  it("lists the frame in effect at In and every frame before Out, a B-frame decoded after the next key included", async () => {
    const { idx, read } = index(gop);
    const frames = await frameTable(idx, 2.4 / 24, 8 / 24);
    expect(Array.from(frames.times)).toEqual([2, 3, 4, 5, 6, 7].map((j) => j / 24));
    expect(Array.from(frames.keys)).toEqual([]);
    expect(read.at(-1)).toBe("P12");
  });

  it("starts from the first frame when In comes before it, and marks the key frames inside", async () => {
    const late = gop.map(([name, frame]): [string, number] => [name, frame + 1]);
    const frames = await frameTable(index(late).idx, 0, 11 / 24);
    expect(Array.from(frames.times)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((j) => j / 24));
    expect(Array.from(frames.keys)).toEqual([0, 9]);
  });

  it("stops at the first packet past the key after Out, or once 17 packets past Out and a second past it are read", async () => {
    const tail = (from: number, to: number): Array<[string, number]> =>
      Array.from({ length: to - from + 1 }, (_, j) => [`P${from + j}`, from + j]);
    const more = index([...gop, ["B10", 10], ["B11", 11], ["P15", 15], ["B13", 13], ["B14", 14], ...tail(16, 75)]);
    await frameTable(more.idx, 2.4 / 24, 8 / 24);
    expect(more.read.at(-1)).toBe("P12");

    // No key after Out: 24 fps reads to Out + 1 s (P32); a frame a second reads 17 packets past Out (P3–P19)
    const keyless = index([["I0", 0], ...tail(1, 80)]);
    await frameTable(keyless.idx, 2.4 / 24, 8 / 24);
    expect(keyless.read.at(-1)).toBe("P32");
    const seconds: Array<[string, number]> = [["I0", 0], ...tail(1, 40)];
    const slow = index(seconds.map(([name, frame]): [string, number] => [name, frame * 24]));
    await frameTable(slow.idx, 0, 2.5);
    expect(slow.read.at(-1)).toBe("P20");
  });

  it("lists every frame before Out of a low frame rate file whose B-frames reorder over more than a second", async () => {
    const order = (fps: number, frames: number[]) => frames.map((f, i): [string, number] => [`${i === 0 ? "I" : "B"}${f}`, (f / fps) * 24]);
    // A frame a second, three B-frames (x264's default): I0 P4 B2 b1 b3 P8 …
    const oneFps = await frameTable(index(order(1, [0, 4, 2, 1, 3, 8, 6, 5, 7])).idx, 0, 2.5);
    expect(Array.from(oneFps.times)).toEqual([0, 1, 2]);
    // Two a second, a B-pyramid: frame 9 (4.5 s) comes after frames 12 and 10
    const twoFps = await frameTable(index(order(2, [0, 4, 2, 1, 3, 8, 6, 5, 7, 12, 10, 9, 11])).idx, 3, 4.75);
    expect(Array.from(twoFps.times)).toEqual([3, 3.5, 4, 4.5]);
  });

  it("at a split's join also lists the first frame at or after Out, before the next piece's Out, its decode ending past it", async () => {
    const joined = await frameTable(index(gop).idx, 2.4 / 24, 8 / 24, undefined, 12 / 24);
    expect(Array.from(joined.times)).toEqual([2, 3, 4, 5, 6, 7, 8].map((j) => j / 24));
    // Between B8 and I9
    expect(joined.end).toBe((8 / 24 + 9 / 24) / 2);
    // Not when that frame is the next piece's Out or later, and never without a join
    const past = await frameTable(index(gop).idx, 2.4 / 24, 8 / 24, undefined, 8 / 24);
    expect(Array.from(past.times)).toEqual([2, 3, 4, 5, 6, 7].map((j) => j / 24));
    expect(past.end).toBeUndefined();
    expect((await frameTable(index(gop).idx, 2.4 / 24, 8 / 24)).end).toBeUndefined();
  });

  it("rejects once aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(frameTable(index(gop).idx, 0, 1, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
