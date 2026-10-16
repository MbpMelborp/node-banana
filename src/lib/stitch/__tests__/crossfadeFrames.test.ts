import { describe, it, expect, vi, beforeEach } from "vitest";
import type { InputVideoTrack, VideoSample } from "mediabunny";
import { blendBytes, createFrameBlender, encodeDissolve, type FrameBlender } from "../crossfadeFrames";

/** Every VideoSample the module constructs: its data (copied, as mediabunny copies a buffer it is given) and init. */
const constructed: Array<{ data: unknown; input: unknown; init: Record<string, unknown>; close: ReturnType<typeof vi.fn> }> = [];

vi.mock("mediabunny", () => {
  class VideoSampleMock {
    data: unknown;
    /** What the module passed in, before the copy. */
    input: unknown;
    init: Record<string, unknown>;
    timestamp: number;
    close = vi.fn();
    constructor(data: unknown, init: Record<string, unknown>) {
      this.data = data instanceof Uint8Array ? data.slice() : data;
      this.input = data;
      this.init = init;
      this.timestamp = init.timestamp as number;
      constructed.push(this);
    }
  }
  /** The track decides what samplesAtTimestamps yields. */
  class VideoSampleSinkMock {
    samplesAtTimestamps: (times: number[]) => unknown;
    constructor(track: { iterate: (times: number[]) => unknown }) {
      this.samplesAtTimestamps = (times) => track.iterate(times);
    }
  }
  return { VideoSample: VideoSampleMock, VideoSampleSink: VideoSampleSinkMock };
});

interface FakeSample {
  format: string | null;
  codedWidth: number;
  codedHeight: number;
  colorSpace: { matrix: string };
  timestamp: number;
  close: ReturnType<typeof vi.fn>;
  clone: ReturnType<typeof vi.fn>;
  setTimestamp: ReturnType<typeof vi.fn>;
  setDuration: ReturnType<typeof vi.fn>;
  drawWithFit: ReturnType<typeof vi.fn>;
  allocationSize: () => number;
  copyTo: ReturnType<typeof vi.fn>;
}

/** A decoded frame whose every byte is `value`, NV12 at 4 × 2 unless told otherwise. */
function frame(
  value: number,
  opts: { format?: string | null; width?: number; height?: number; timestamp?: number; copyFails?: boolean } = {},
): FakeSample {
  const width = opts.width ?? 4;
  const height = opts.height ?? 2;
  const size = width * height + 2 * Math.ceil(width / 2) * Math.ceil(height / 2);
  const sample: FakeSample = {
    format: opts.format === undefined ? "NV12" : opts.format,
    codedWidth: width,
    codedHeight: height,
    colorSpace: { matrix: `bt709-${value}` },
    timestamp: opts.timestamp ?? 0,
    close: vi.fn(),
    clone: vi.fn(),
    setTimestamp: vi.fn(),
    setDuration: vi.fn(),
    drawWithFit: vi.fn(),
    allocationSize: () => size,
    copyTo: vi.fn(async (buffer: Uint8Array) => {
      if (opts.copyFails) throw new Error("copyTo failed");
      buffer.fill(value);
      return [
        { offset: 0, stride: width },
        { offset: width * height, stride: 2 * Math.ceil(width / 2) },
      ];
    }),
  };
  sample.clone.mockImplementation(() => ({ ...frame(value, opts), cloneOf: sample }));
  return sample;
}

const asSample = (s: FakeSample | null) => s as unknown as VideoSample | null;

/** A canvas context that records what is drawn at which globalAlpha. */
function fakeContext() {
  const log: string[] = [];
  const ctx = {
    canvas: { id: "canvas" },
    _alpha: 1,
    get globalAlpha() {
      return this._alpha;
    },
    set globalAlpha(value: number) {
      this._alpha = value;
      log.push(`alpha ${value}`);
    },
    fillStyle: "",
    fillRect: vi.fn(() => log.push(`fill ${ctx.fillStyle}`)),
  };
  return { ctx, log };
}

describe("blendBytes", () => {
  it("gives a at 0 and b at 1", () => {
    const a = new Uint8Array([0, 100, 255]);
    const b = new Uint8Array([255, 50, 0]);
    const out = new Uint8Array(3);
    blendBytes(a, b, 0, out);
    expect([...out]).toEqual([0, 100, 255]);
    blendBytes(a, b, 1, out);
    expect([...out]).toEqual([255, 50, 0]);
  });

  it("rounds the midpoint half up", () => {
    const out = new Uint8Array(2);
    blendBytes(new Uint8Array([0, 10]), new Uint8Array([1, 13]), 0.5, out);
    // 0.5 → 1, 11.5 → 12
    expect([...out]).toEqual([1, 12]);
  });

  it("clamps alpha", () => {
    const out = new Uint8Array(1);
    blendBytes(new Uint8Array([10]), new Uint8Array([20]), 2, out);
    expect(out[0]).toBe(20);
    blendBytes(new Uint8Array([10]), new Uint8Array([20]), -1, out);
    expect(out[0]).toBe(10);
    blendBytes(new Uint8Array([10]), new Uint8Array([20]), Number.NaN, out);
    expect(out[0]).toBe(10);
  });
});

describe("createFrameBlender", () => {
  const ref = { width: 4, height: 2 };

  beforeEach(() => {
    constructed.length = 0;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("blends two NV12 frames at the reference size in their bytes, in one reused buffer each sample copies", async () => {
    const { ctx } = fakeContext();
    const context2d = vi.fn(() => ctx as unknown as CanvasRenderingContext2D);
    const blender = createFrameBlender(ref, { context2d });
    const a = frame(100);
    const b = frame(200);
    await blender.blend(asSample(a), asSample(b), 0.25, 4, 1 / 60);
    await blender.blend(asSample(a), asSample(b), 0.75, 4 + 1 / 60, 1 / 60);

    expect(a.copyTo).toHaveBeenCalledTimes(2);
    expect(b.copyTo).toHaveBeenCalledTimes(2);
    expect(context2d).not.toHaveBeenCalled();
    const [first, second] = constructed;
    expect(first.data).toBeInstanceOf(Uint8Array);
    expect([...(first.data as Uint8Array)].every((v) => v === 125)).toBe(true);
    expect([...(second.data as Uint8Array)].every((v) => v === 175)).toBe(true);
    // One output buffer serves every blend: the sample owns its copy
    expect(second.input).toBe(first.input);
    expect(second.data).not.toBe(first.data);
    expect(first.init).toEqual({
      format: "NV12",
      codedWidth: 4,
      codedHeight: 2,
      timestamp: 4,
      duration: 1 / 60,
      colorSpace: a.colorSpace,
      layout: [
        { offset: 0, stride: 4 },
        { offset: 8, stride: 4 },
      ],
      rotation: 0,
    });
  });

  it("blends on a canvas when the sizes differ: black, a to cover at 1, b at alpha, then back to 1", async () => {
    const { ctx, log } = fakeContext();
    const context2d = vi.fn(() => ctx as unknown as CanvasRenderingContext2D);
    const blender = createFrameBlender(ref, { context2d, isFirefox: false });
    const a = frame(100);
    const b = frame(200, { width: 8, height: 4 });
    await blender.blend(asSample(a), asSample(b), 0.4, 5, 1 / 60);

    expect(a.copyTo).not.toHaveBeenCalled();
    expect(context2d).toHaveBeenCalledWith(ref, { alpha: false });
    expect(log).toEqual(["alpha 1", "fill black", "alpha 0.4", "alpha 1"]);
    expect(a.drawWithFit).toHaveBeenCalledWith(ctx, { fit: "cover", rotation: 0 });
    expect(b.drawWithFit).toHaveBeenCalledWith(ctx, { fit: "cover", rotation: 0 });
    expect(a.drawWithFit.mock.invocationCallOrder[0]).toBeLessThan(b.drawWithFit.mock.invocationCallOrder[0]);
    expect(constructed[0]).toMatchObject({ data: ctx.canvas, init: { timestamp: 5, duration: 1 / 60, rotation: 0 } });
  });

  it("blends on a canvas when a frame has no known format, and keeps an alpha context on Firefox", async () => {
    const { ctx } = fakeContext();
    const context2d = vi.fn(() => ctx as unknown as CanvasRenderingContext2D);
    const blender = createFrameBlender(ref, { context2d, isFirefox: true });
    const a = frame(100, { format: null });
    const b = frame(200, { format: null });
    await blender.blend(asSample(a), asSample(b), 0.5, 0, 1 / 60);
    expect(context2d).toHaveBeenCalledWith(ref, { alpha: true });
    expect(a.drawWithFit).toHaveBeenCalled();
    expect(b.drawWithFit).toHaveBeenCalled();
  });

  it("stays on the canvas once copyTo has thrown", async () => {
    const { ctx } = fakeContext();
    const context2d = vi.fn(() => ctx as unknown as CanvasRenderingContext2D);
    const blender = createFrameBlender(ref, { context2d });
    await blender.blend(asSample(frame(100, { copyFails: true })), asSample(frame(200)), 0.5, 0, 1 / 60);
    expect(constructed[0].data).toBe(ctx.canvas);
    const a = frame(100);
    const b = frame(200);
    await blender.blend(asSample(a), asSample(b), 0.5, 1 / 60, 1 / 60);
    expect(a.copyTo).not.toHaveBeenCalled();
    expect(constructed[1].data).toBe(ctx.canvas);
    // One canvas for the whole encode
    expect(context2d).toHaveBeenCalledTimes(1);
  });

  it("passes a single side at the reference size as a clone with the new timestamp", async () => {
    const context2d = vi.fn();
    const blender = createFrameBlender(ref, { context2d });
    const b = frame(200);
    const result = (await blender.blend(null, asSample(b), 0.3, 7, 1 / 60)) as unknown as FakeSample;
    expect(b.clone).toHaveBeenCalledTimes(1);
    expect(result.setTimestamp).toHaveBeenCalledWith(7);
    expect(result.setDuration).toHaveBeenCalledWith(1 / 60);
    expect(context2d).not.toHaveBeenCalled();
    expect(constructed).toHaveLength(0);
  });

  it("draws a single side at another size alone, at full opacity", async () => {
    const { ctx, log } = fakeContext();
    const blender = createFrameBlender(ref, { context2d: () => ctx as unknown as CanvasRenderingContext2D });
    const a = frame(100, { width: 8, height: 4 });
    await blender.blend(asSample(a), null, 0.3, 0, 1 / 60);
    expect(a.drawWithFit).toHaveBeenCalledWith(ctx, { fit: "cover", rotation: 0 });
    expect(log).toEqual(["alpha 1", "fill black"]);
  });
});

/** An iterator that yields the given items in order, recording next() and an awaited return(). */
function iteratorOf(items: Array<FakeSample | null>, opts: { throwAt?: number } = {}) {
  let i = 0;
  const state = { returned: false, returnSettled: false, nextCalls: 0 };
  const iterator = {
    next: vi.fn(async () => {
      state.nextCalls++;
      if (opts.throwAt === i) throw new Error("decode failed");
      if (i >= items.length) return { done: true, value: undefined };
      return { done: false, value: items[i++] };
    }),
    return: vi.fn(async () => {
      state.returned = true;
      await Promise.resolve();
      state.returnSettled = true;
      return { done: true, value: undefined };
    }),
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  return { iterator, state };
}

const trackOf = (iterator: unknown, timesSeen: number[][]) =>
  ({
    iterate: (times: number[]) => {
      timesSeen.push([...times]);
      return iterator;
    },
  }) as unknown as InputVideoTrack;

describe("encodeDissolve", () => {
  beforeEach(() => {
    constructed.length = 0;
  });

  /** A blender that records its calls and returns a closable result. */
  function recordingBlender() {
    const calls: Array<{ a: FakeSample | null; b: FakeSample | null; alpha: number; timestamp: number; duration: number }> = [];
    const results: Array<{ timestamp: number; close: ReturnType<typeof vi.fn> }> = [];
    const blender: FrameBlender = {
      blend: vi.fn(async (a, b, alpha, timestamp, duration) => {
        calls.push({ a: a as unknown as FakeSample | null, b: b as unknown as FakeSample | null, alpha, timestamp, duration });
        const result = { timestamp, close: vi.fn() };
        results.push(result);
        return result as unknown as VideoSample;
      }),
    };
    return { blender, calls, results };
  }

  it("blends in order with the given alphas, holding a side's previous frame over a null, and closes everything", async () => {
    const a = [frame(10), frame(11), null];
    const b = [null, frame(20), frame(21)];
    const out = iteratorOf(a);
    const inc = iteratorOf(b);
    const times: number[][] = [];
    const { blender, calls, results } = recordingBlender();
    const blenderFor = vi.fn(() => blender);
    const added: number[] = [];
    await encodeDissolve(
      {
        outgoing: trackOf(out.iterator, times),
        incoming: trackOf(inc.iterator, times),
        timestamps: [4, 4 + 1 / 60, 4 + 2 / 60],
        outgoingTimes: [4.01, 4.02, 4.03],
        incomingTimes: [0, 0.01, 0.02],
        alphas: [0.1, 0.5, 0.9],
        frameDuration: 1 / 60,
      },
      blenderFor,
      async (sample) => {
        added.push(sample.timestamp);
      },
    );

    expect(times).toEqual([
      [4.01, 4.02, 4.03],
      [0, 0.01, 0.02],
    ]);
    expect(blenderFor).toHaveBeenCalledTimes(1);
    expect(blenderFor).toHaveBeenCalledWith(a[0]);
    expect(calls.map((c) => [c.a, c.b, c.alpha, c.timestamp, c.duration])).toEqual([
      [a[0], null, 0.1, 4, 1 / 60],
      [a[1], b[1], 0.5, 4 + 1 / 60, 1 / 60],
      [a[1], b[2], 0.9, 4 + 2 / 60, 1 / 60],
    ]);
    expect(added).toEqual([4, 4 + 1 / 60, 4 + 2 / 60]);
    for (const result of results) expect(result.close).toHaveBeenCalledTimes(1);
    for (const sample of [...a, ...b]) if (sample) expect(sample.close).toHaveBeenCalledTimes(1);
    expect(out.state.returnSettled).toBe(true);
    expect(inc.state.returnSettled).toBe(true);
    // Lockstep: one next() each per frame
    expect(out.state.nextCalls).toBe(3);
    expect(inc.state.nextCalls).toBe(3);
  });

  it("gives the blender null when the outgoing side has no first frame", async () => {
    const out = iteratorOf([null, frame(1)]);
    const inc = iteratorOf([frame(2), frame(3)]);
    const { blender } = recordingBlender();
    const blenderFor = vi.fn(() => blender);
    await encodeDissolve(
      {
        outgoing: trackOf(out.iterator, []),
        incoming: trackOf(inc.iterator, []),
        timestamps: [0, 1 / 60],
        outgoingTimes: [0, 0],
        incomingTimes: [0, 0],
        alphas: [0.25, 0.75],
        frameDuration: 1 / 60,
      },
      blenderFor,
      async () => {},
    );
    expect(blenderFor).toHaveBeenCalledWith(null);
  });

  it("stops on abort: both iterators' return() awaited and the held samples closed", async () => {
    const controller = new AbortController();
    const a = [frame(10), frame(11), frame(12)];
    const b = [frame(20), frame(21), frame(22)];
    const out = iteratorOf(a);
    const inc = iteratorOf(b);
    const { blender, results } = recordingBlender();
    const added = vi.fn(async () => {
      controller.abort();
    });
    await expect(
      encodeDissolve(
        {
          outgoing: trackOf(out.iterator, []),
          incoming: trackOf(inc.iterator, []),
          timestamps: [0, 1, 2],
          outgoingTimes: [0, 1, 2],
          incomingTimes: [0, 1, 2],
          alphas: [0.2, 0.5, 0.8],
          frameDuration: 1 / 60,
          signal: controller.signal,
        },
        () => blender,
        added,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(added).toHaveBeenCalledTimes(1);
    expect(results[0].close).toHaveBeenCalledTimes(1);
    expect(a[0].close).toHaveBeenCalledTimes(1);
    expect(b[0].close).toHaveBeenCalledTimes(1);
    expect(a[1].close).not.toHaveBeenCalled();
    expect(out.iterator.return).toHaveBeenCalledTimes(1);
    expect(inc.iterator.return).toHaveBeenCalledTimes(1);
    expect(out.state.returnSettled).toBe(true);
    expect(inc.state.returnSettled).toBe(true);
  });

  it("closes the outgoing frame when the incoming decoder throws", async () => {
    const a = [frame(10)];
    const out = iteratorOf(a);
    const inc = iteratorOf([frame(20)], { throwAt: 0 });
    const { blender } = recordingBlender();
    await expect(
      encodeDissolve(
        {
          outgoing: trackOf(out.iterator, []),
          incoming: trackOf(inc.iterator, []),
          timestamps: [0],
          outgoingTimes: [0],
          incomingTimes: [0],
          alphas: [0.5],
          frameDuration: 1 / 60,
        },
        () => blender,
        async () => {},
      ),
    ).rejects.toThrow("decode failed");
    expect(a[0].close).toHaveBeenCalledTimes(1);
    expect(out.state.returnSettled).toBe(true);
    expect(inc.state.returnSettled).toBe(true);
  });

  it("closes a result the encoder refused", async () => {
    const out = iteratorOf([frame(10)]);
    const inc = iteratorOf([frame(20)]);
    const { blender, results } = recordingBlender();
    await expect(
      encodeDissolve(
        {
          outgoing: trackOf(out.iterator, []),
          incoming: trackOf(inc.iterator, []),
          timestamps: [0],
          outgoingTimes: [0],
          incomingTimes: [0],
          alphas: [0.5],
          frameDuration: 1 / 60,
        },
        () => blender,
        async () => {
          throw new Error("encoder failed");
        },
      ),
    ).rejects.toThrow("encoder failed");
    expect(results[0].close).toHaveBeenCalledTimes(1);
  });

  it("opens nothing for an empty dissolve", async () => {
    const iterate = vi.fn();
    const track = { iterate } as unknown as InputVideoTrack;
    await encodeDissolve(
      { outgoing: track, incoming: track, timestamps: [], outgoingTimes: [], incomingTimes: [], alphas: [], frameDuration: 1 / 60 },
      () => recordingBlender().blender,
      async () => {},
    );
    expect(iterate).not.toHaveBeenCalled();
  });
});
