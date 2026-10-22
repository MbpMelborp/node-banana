import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { VideoSample } from "mediabunny";
import type { StitchTextOverlay } from "@/types";
import { rgbaToYuv } from "../crossfadeFrames";
import type { StitchOverlayInput } from "../engineTypes";
import type { OverlayRotation, OverlaySize } from "../overlayDraw";
import { blendOverlayPlanes, createOverlayWriter, forcedOverlaySlots, overlaySlotTime } from "../overlayFrames";
import { createTextOverlay } from "../overlays";

/** Every VideoSample the module constructs: its data (copied, as mediabunny copies a buffer it is given) and init. */
const constructed: Array<{ data: unknown; init: Record<string, unknown>; timestamp: number; close: Mock }> = [];

vi.mock("mediabunny", () => {
  class VideoSampleMock {
    data: unknown;
    init: Record<string, unknown>;
    timestamp: number;
    close = vi.fn();
    constructor(data: unknown, init: Record<string, unknown>) {
      this.data = data instanceof Uint8Array ? data.slice() : data;
      this.init = init;
      this.timestamp = init.timestamp as number;
      constructed.push(this);
    }
  }
  return { VideoSample: VideoSampleMock, VideoSampleSink: class {} };
});

const BT709: VideoColorSpaceInit = { primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false };

type Layout = { offset: number; stride: number }[];

/** Tightly packed planes, as copyTo lays them out by default. */
function tight(format: string | null, width: number, height: number): Layout {
  const luma = width * height;
  const hw = Math.ceil(width / 2);
  const hh = Math.ceil(height / 2);
  switch (format) {
    case "I420":
      return [{ offset: 0, stride: width }, { offset: luma, stride: hw }, { offset: luma + hw * hh, stride: hw }];
    case "I420A":
      return [...tight("I420", width, height), { offset: luma + 2 * hw * hh, stride: width }];
    case "NV12":
      return [{ offset: 0, stride: width }, { offset: luma, stride: 2 * hw }];
    default:
      return [{ offset: 0, stride: 4 * width }];
  }
}

function packed(format: string | null, width: number, height: number): number {
  const luma = width * height;
  const chroma = 2 * Math.ceil(width / 2) * Math.ceil(height / 2);
  return format === "I420" || format === "NV12" ? luma + chroma : format === "I420A" ? 2 * luma + chroma : 4 * luma;
}

interface FakeFrame {
  name: string;
  format: string | null;
  codedWidth: number;
  codedHeight: number;
  timestamp: number;
  duration: number;
  colorSpace: VideoColorSpaceInit;
  close: Mock;
  clone: Mock;
  setTimestamp: Mock;
  setDuration: Mock;
  drawWithFit: Mock;
  allocationSize(): number;
  copyTo: Mock;
}

/** Every frame made here, clones included. */
const frames: FakeFrame[] = [];

/** A decoded frame on output slot `slot`, every byte `value`: I420 BT.709 at 4 × 2 unless told otherwise. */
function frame(
  name: string,
  slot: number,
  opts: {
    format?: string | null;
    width?: number;
    height?: number;
    colorSpace?: VideoColorSpaceInit;
    value?: number;
    copyFails?: boolean;
  } = {},
): FakeFrame {
  const format = opts.format === undefined ? "I420" : opts.format;
  const width = opts.width ?? 4;
  const height = opts.height ?? 2;
  const f: FakeFrame = {
    name,
    format,
    codedWidth: width,
    codedHeight: height,
    timestamp: slot / 60,
    duration: 1 / 60,
    colorSpace: opts.colorSpace ?? BT709,
    close: vi.fn(),
    clone: vi.fn(() => {
      const copy = frame(`${name}'`, 0, opts);
      copy.timestamp = f.timestamp;
      return copy;
    }),
    setTimestamp: vi.fn((t: number) => {
      f.timestamp = t;
    }),
    setDuration: vi.fn((d: number) => {
      f.duration = d;
    }),
    drawWithFit: vi.fn(),
    allocationSize: () => packed(format, width, height),
    copyTo: vi.fn(async (buffer: Uint8Array) => {
      if (opts.copyFails) throw new Error("copyTo failed");
      buffer.fill(opts.value ?? 100);
      return tight(format, width, height);
    }),
  };
  frames.push(f);
  return f;
}

const solid =
  (pixel: number[]) =>
  (width: number, height: number): Uint8ClampedArray => {
    const data = new Uint8ClampedArray(4 * width * height);
    for (let i = 0; i < width * height; i++) data.set(pixel, 4 * i);
    return data;
  };

/** The overlay canvas (read back as `rgba` gives) and the frame canvas, told apart by willReadFrequently. */
function fakeContexts(rgba: (width: number, height: number) => Uint8ClampedArray) {
  const overlay = {
    canvas: { id: "overlay" },
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    getImageData: vi.fn((_x: number, _y: number, width: number, height: number) => ({ data: rgba(width, height) })),
  };
  const frameCanvas = {
    canvas: { id: "frame" },
    globalAlpha: 1,
    fillStyle: "" as unknown,
    fillRect: vi.fn(),
    drawImage: vi.fn(),
    getImageData: vi.fn((_x: number, _y: number, width: number, height: number) => ({ data: solid([255, 255, 255, 255])(width, height) })),
  };
  const context2d = vi.fn((_size: unknown, settings: CanvasRenderingContext2DSettings) => (settings.willReadFrequently ? overlay : frameCanvas));
  return { overlay, frame: frameCanvas, context2d };
}

const text = (init: Partial<StitchTextOverlay>): StitchOverlayInput => ({ ...createTextOverlay({ id: "o", ...init }), fontList: "sans-serif" });

const asSample = (f: FakeFrame) => f as unknown as VideoSample;
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

function writer(
  overlays: StitchOverlayInput[],
  opts: {
    loopLength?: number;
    loopCount?: number;
    layout?: OverlaySize;
    rotation?: OverlayRotation;
    signal?: AbortSignal;
    rgba?: (w: number, h: number) => Uint8ClampedArray;
  } = {},
) {
  /** What the encoder took: each sample and the slot it was on when it took it. */
  const added: Array<{ sample: unknown; slot: number }> = [];
  const add = vi.fn(async (sample: VideoSample) => {
    added.push({ sample, slot: Math.round(sample.timestamp * 60) });
  });
  const draw = vi.fn(() => true);
  const contexts = fakeContexts(opts.rgba ?? solid([0, 0, 0, 128]));
  const w = createOverlayWriter(
    {
      overlays,
      loopLength: opts.loopLength ?? 4,
      loopCount: opts.loopCount ?? 1,
      layout: opts.layout ?? { width: 4, height: 2 },
      rotation: opts.rotation ?? 0,
      add,
      signal: opts.signal,
    },
    { context2d: contexts.context2d as never, draw: draw as never, isFirefox: false },
  );
  /** Hands each frame in, closing it afterwards as the engine does. */
  const feed = async (...list: FakeFrame[]) => {
    for (const f of list) {
      try {
        await w.write(asSample(f));
      } finally {
        f.close();
      }
    }
  };
  const drawnAt = () => draw.mock.calls.map((call) => (call as unknown[])[2] as number);
  return { w, add, added, draw, drawnAt, feed, ...contexts };
}

/** Every frame and every sample made here closed exactly once. */
const allClosedOnce = () =>
  frames.every((f) => f.close.mock.calls.length === 1) && constructed.every((s) => s.close.mock.calls.length === 1);

beforeEach(() => {
  constructed.length = 0;
  frames.length = 0;
});

describe("overlaySlotTime", () => {
  it("is the slot's time less its loop's start", () => {
    expect(overlaySlotTime(90, 4, 2)).toBe(1.5);
    expect(overlaySlotTime(270, 4, 2)).toBeCloseTo(0.5, 12);
    expect(overlaySlotTime(270, 4, 1)).toBe(4.5);
  });

  it("gives a later loop's first slot 0 when the loop starts a hair after it, not the loop before's end", () => {
    // 1.005 s rounds to slot 60, which is 1 s
    expect(overlaySlotTime(60, 1.005, 2)).toBe(0);
    expect(overlaySlotTime(59, 1.005, 2)).toBe(59 / 60);
    expect(overlaySlotTime(61, 1.005, 2)).toBeCloseTo(61 / 60 - 1.005, 12);
  });
});

describe("forcedOverlaySlots", () => {
  it("is every slot of each fade and the slot that ends it, none on the plateau", () => {
    expect(forcedOverlaySlots([text({ startSec: 1, endSec: 3 })], 4, 1)).toEqual([...range(61, 90), ...range(151, 180)]);
  });

  it("is one slot for a cut in and one for a cut out, in every loop, and a loop's first slot when it opens on a layer", () => {
    expect(forcedOverlaySlots([text({ startSec: 0, endSec: 0.5, fadeInSec: 0, fadeOutSec: 0 })], 1.005, 2)).toEqual([0, 30, 60, 91]);
  });

  it("stops at the loop's end: what lies past it is cut", () => {
    const long = text({ startSec: 3, endSec: 10, fadeInSec: 0 });
    expect(forcedOverlaySlots([long], 4, 2)).toEqual([180, 240, 420]);
    expect(forcedOverlaySlots([text({ startSec: 4.5, endSec: 6 })], 4, 2)).toEqual([]);
  });
});

describe("createOverlayWriter", () => {
  it("hands a frame no layer shows on untouched, draws nothing and holds nothing once no forced slot is to come", async () => {
    const t = writer([text({ startSec: 1, endSec: 2 })], { loopLength: 3 });
    const late = frame("late", 150);
    await t.feed(late);
    expect(t.added).toEqual([{ sample: late, slot: 150 }]);
    expect(late.clone).not.toHaveBeenCalled();
    expect(t.context2d).not.toHaveBeenCalled();
    expect(t.draw).not.toHaveBeenCalled();
  });

  it("fills every slot of a fade over a gap's one black frame, the last with the black alone, then takes the next frame", async () => {
    const t = writer([text({ startSec: 1.5, endSec: 2.5 })]);
    const [a, black, c] = [frame("a", 0), frame("black", 60), frame("c", 180)];
    await t.feed(a, black, c);
    await t.w.flush();
    expect(t.added.map((x) => x.slot)).toEqual([0, 60, ...range(91, 150), 180]);
    expect(t.added[0].sample).toBe(a);
    expect(t.added[1].sample).toBe(black);
    expect(t.added.at(-1)!.sample).toBe(c);
    // The fade's slots are the black frame with the layer over it; where it has ended, the black frame retimed
    expect(constructed.map((s) => Math.round(s.timestamp * 60))).toEqual(range(91, 149));
    const ended = t.added.at(-2)!.sample as FakeFrame;
    expect(ended.name).toMatch(/^black'+$/);
    expect(ended.setTimestamp).toHaveBeenCalledWith(150 / 60);
    expect(t.drawnAt()).toEqual(range(91, 149).map((slot) => slot / 60));
    expect(allClosedOnce()).toBe(true);
  });

  it("writes one frame on every slot through each fade over a clip held at 6 fps, and none extra on the plateau", async () => {
    const t = writer([text({ startSec: 1, endSec: 3 })]);
    const held = range(0, 23).map((k) => frame(`f${k}`, 10 * k));
    await t.feed(...held);
    await t.w.flush();
    const slots = t.added.map((x) => x.slot);
    expect(slots).toEqual([...new Set([...range(0, 23).map((k) => 10 * k), ...range(61, 90), ...range(151, 180)])].sort((x, y) => x - y));
    // The plateau keeps the clip's own cadence, each of its frames under the layer
    expect(slots.filter((slot) => slot > 90 && slot < 151)).toEqual([100, 110, 120, 130, 140, 150]);
    expect(constructed.map((s) => Math.round(s.timestamp * 60)).filter((slot) => slot > 90 && slot < 151)).toEqual([100, 110, 120, 130, 140, 150]);
    // One picture per state: each fade slot's, and the plateau's once (at slot 90, where it is reached)
    expect(t.drawnAt()).toEqual([...range(61, 90), ...range(151, 179)].map((slot) => slot / 60));
    expect(t.overlay.getImageData).toHaveBeenCalledTimes(59);
    expect(allClosedOnce()).toBe(true);
  });

  it("flushes the forced slots after the last frame, up to the encode's last slot", async () => {
    const t = writer([text({ startSec: 3, endSec: 4, fadeInSec: 0, fadeOutSec: 0.5 })]);
    const still = frame("still", 0);
    await t.feed(still);
    expect(t.added.map((x) => x.slot)).toEqual([0]);
    await t.w.flush();
    expect(t.added.map((x) => x.slot)).toEqual([0, 180, ...range(211, 239)]);
    expect(constructed).toHaveLength(30);
    expect(still.clone).toHaveBeenCalledTimes(1);
    expect(allClosedOnce()).toBe(true);
  });

  it("draws a later loop's first slot at 0 when the loop starts a hair after it", async () => {
    const t = writer([text({ startSec: 0, endSec: 0.5, fadeInSec: 0, fadeOutSec: 0.5 })], { loopLength: 1.005, loopCount: 2 });
    await t.feed(frame("a", 0), frame("b", 60));
    expect(t.added.map((x) => x.slot)).toEqual([...range(0, 30), 60]);
    expect(t.drawnAt().at(-1)).toBe(0);
    await t.w.flush();
    expect(t.added.map((x) => x.slot)).toEqual([...range(0, 30), ...range(60, 91)]);
    expect(t.drawnAt().at(-1)).toBeCloseTo(90 / 60 - 1.005, 12);
    expect(allClosedOnce()).toBe(true);
  });

  it("blends a frame at the box into its own planes and colour space; what the layer leaves clear keeps its bytes", async () => {
    // Pixel (0, 0) white and opaque, the rest clear
    const rgba = (width: number, height: number) => {
      const data = new Uint8ClampedArray(4 * width * height);
      data.set([255, 255, 255, 255], 0);
      return data;
    };
    const t = writer([text({ startSec: 0, endSec: 4, fadeInSec: 0, fadeOutSec: 0 })], { rgba });
    const a = frame("a", 0);
    await t.feed(a);
    expect(constructed).toHaveLength(1);
    expect(constructed[0].init).toEqual({
      format: "I420",
      codedWidth: 4,
      codedHeight: 2,
      timestamp: 0,
      duration: 1 / 60,
      colorSpace: BT709,
      layout: tight("I420", 4, 2),
      rotation: 0,
    });
    // BT.709 limited white: Y 235; its block's chroma a quarter of the way from 100 to 128
    expect([...(constructed[0].data as Uint8Array)]).toEqual([235, 100, 100, 100, 100, 100, 100, 100, 107, 100, 107, 100]);
    expect(t.added[0].sample).toBe(constructed[0]);
    expect(t.draw).toHaveBeenCalledWith(
      t.overlay,
      { layout: { width: 4, height: 2 }, canvas: { width: 4, height: 2 }, rotation: 0 },
      0,
      expect.any(Array),
      expect.any(Function),
      expect.any(WeakMap),
    );
    expect(t.overlay.setTransform.mock.invocationCallOrder[0]).toBeLessThan(t.draw.mock.invocationCallOrder[0]);
    expect(t.overlay.clearRect).toHaveBeenCalledWith(0, 0, 4, 2);
  });

  it("blends a later frame in its own format and colour space, not the first frame's", async () => {
    const rgba = solid([250, 40, 90, 200]);
    const t = writer([text({ startSec: 0, endSec: 4, fadeInSec: 0, fadeOutSec: 0 })], { rgba });
    const full601: VideoColorSpaceInit = { matrix: "bt470bg", fullRange: true };
    await t.feed(frame("a", 0), frame("hw", 3, { format: "NV12", colorSpace: full601, value: 60 }));
    const expected = new Uint8Array(packed("NV12", 4, 2)).fill(60);
    blendOverlayPlanes(expected, tight("NV12", 4, 2), "NV12", 4, 2, rgba(4, 2), [0.299, 0.114], true);
    expect(constructed[0].init).toMatchObject({ format: "I420", colorSpace: BT709 });
    expect(constructed[1].init).toEqual({
      format: "NV12",
      codedWidth: 4,
      codedHeight: 2,
      timestamp: 3 / 60,
      duration: 1 / 60,
      colorSpace: full601,
      layout: tight("NV12", 4, 2),
      rotation: 0,
    });
    expect([...(constructed[1].data as Uint8Array)]).toEqual([...expected]);
    expect(t.added[1].sample).toBe(constructed[1]);
  });

  it("lays the layer out in the file's display size and turns it by the file's rotation onto the first frame's coded box", async () => {
    // A portrait file: 4 × 2 coded frames shown turned 90°, then a clip of 6 × 4 frames the encoder fits into the box
    const t = writer([text({ startSec: 0, endSec: 4, fadeInSec: 0, fadeOutSec: 0.5 })], { layout: { width: 2, height: 4 }, rotation: 90 });
    await t.feed(frame("a", 0), frame("big", 220, { width: 6, height: 4 }));
    expect(t.drawnAt()).toEqual([0, ...range(211, 220)].map((slot) => slot / 60));
    expect(t.draw.mock.calls.map((call) => (call as unknown[])[1])).toEqual(
      Array(11).fill({ layout: { width: 2, height: 4 }, canvas: { width: 4, height: 2 }, rotation: 90 }),
    );
    expect(t.context2d.mock.calls).toEqual([
      [{ width: 4, height: 2 }, { alpha: true, willReadFrequently: true }],
      [{ width: 4, height: 2 }, { alpha: false }],
    ]);
    expect(t.overlay.clearRect).toHaveBeenLastCalledWith(0, 0, 4, 2);
  });

  it("draws the font lists the inputs carry", async () => {
    const o = { ...text({ startSec: 0, endSec: 4, font: { family: "Georgia" } }), fontList: '"Georgia", "Space Grotesk", sans-serif' };
    const t = writer([o]);
    await t.feed(frame("a", 1));
    const fontList = (t.draw.mock.calls[0] as unknown[])[4] as (font: unknown) => string;
    expect(fontList(o.font)).toBe('"Georgia", "Space Grotesk", sans-serif');
  });

  it("draws a frame not at the box as the encoder would fit it, upright, then the layer; at the box, unrotated", async () => {
    const t = writer([text({ startSec: 0, endSec: 4, fadeInSec: 0, fadeOutSec: 0 })]);
    const [a, big, rgb] = [frame("a", 0), frame("big", 3, { width: 6, height: 4 }), frame("rgb", 6, { format: "RGBX" })];
    await t.feed(a, big, rgb);
    expect(big.drawWithFit).toHaveBeenCalledWith(t.frame, { fit: "cover" });
    expect(rgb.drawWithFit).toHaveBeenCalledWith(t.frame, { fit: "cover", rotation: 0 });
    expect(t.frame.drawImage).toHaveBeenCalledWith(t.overlay.canvas, 0, 0);
    expect(t.frame.drawImage).toHaveBeenCalledTimes(2);
    expect(big.drawWithFit.mock.invocationCallOrder[0]).toBeLessThan(t.frame.drawImage.mock.invocationCallOrder[0]);
    // After the first frame, as mediabunny's own resize and the blender hand them on
    expect(constructed.slice(1).map((s) => [s.data, s.init])).toEqual([
      [t.frame.canvas, { timestamp: 3 / 60, duration: 1 / 60, rotation: 0 }],
      [t.frame.canvas, { timestamp: 6 / 60, duration: 1 / 60, rotation: 0 }],
    ]);
    expect(t.frame.getImageData).not.toHaveBeenCalled();
  });

  it("never hands the encoder a canvas frame first: a first frame it cannot blend in its planes is read back in the box's Y'CbCr", async () => {
    const t = writer([text({ startSec: 0, endSec: 4, fadeInSec: 0, fadeOutSec: 0 })]);
    await t.feed(frame("deep", 0, { format: "I420P10" }), frame("deep2", 3, { format: "I420P10" }));
    expect(t.frame.getImageData).toHaveBeenCalledTimes(1);
    expect(constructed[0].init).toEqual({
      format: "I420",
      codedWidth: 4,
      codedHeight: 2,
      colorSpace: BT709,
      layout: tight("I420", 4, 2),
      timestamp: 0,
      duration: 1 / 60,
      rotation: 0,
    });
    // The canvas read back white: Y 235, chroma 128
    expect([...(constructed[0].data as Uint8Array)]).toEqual([...Array(8).fill(235), 128, 128, 128, 128]);
    expect(constructed[1].data).toBe(t.frame.canvas);
  });

  it("draws on the canvas from the first failed copy on", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const t = writer([text({ startSec: 0, endSec: 4, fadeInSec: 0, fadeOutSec: 0 })]);
    const [a, b] = [frame("a", 0, { copyFails: true }), frame("b", 3)];
    await t.feed(a, b);
    expect(b.copyTo).not.toHaveBeenCalled();
    expect(b.drawWithFit).toHaveBeenCalledWith(t.frame, { fit: "cover", rotation: 0 });
    expect(constructed[0].init.format).toBe("I420");
    expect(constructed[1].data).toBe(t.frame.canvas);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("keeps one clone of the last frame while a forced slot is to come, and lets it go on close after an abort mid-fill", async () => {
    const controller = new AbortController();
    const t = writer([text({ startSec: 1, endSec: 3 })], { signal: controller.signal });
    const [a, b] = [frame("a", 0), frame("b", 30)];
    await t.feed(a, b);
    expect(a.clone).toHaveBeenCalledTimes(1);
    expect(frames.find((f) => f.name === "a'")!.close).toHaveBeenCalledTimes(1);
    controller.abort();
    await expect(t.feed(frame("c", 120))).rejects.toMatchObject({ name: "AbortError" });
    expect(t.added.map((x) => x.slot)).toEqual([0, 30]);
    t.w.close();
    t.w.close();
    expect(allClosedOnce()).toBe(true);
  });
});

describe("blendOverlayPlanes", () => {
  /** The R'G'B' blend, per pixel, converted by the matrix and range; chroma the mean over the pixels a sample covers. */
  function reference(
    base: Uint8Array,
    format: "I420" | "NV12",
    width: number,
    height: number,
    rgba: Uint8ClampedArray,
    [kr, kb]: [number, number],
    full: boolean,
  ): number[] {
    const kg = 1 - kr - kb;
    const out = [...base];
    const hw = Math.ceil(width / 2);
    const hh = Math.ceil(height / 2);
    const pixel = (x: number, y: number) => {
      const i = 4 * (y * width + x);
      const [r, g, b] = [rgba[i] / 255, rgba[i + 1] / 255, rgba[i + 2] / 255];
      const l = kr * r + kg * g + kb * b;
      const scale = full ? 255 : 224;
      return {
        alpha: rgba[i + 3] / 255,
        y: (full ? 0 : 16) + (full ? 255 : 219) * l,
        cb: 128 + (scale * (b - l)) / (2 * (1 - kb)),
        cr: 128 + (scale * (r - l)) / (2 * (1 - kr)),
      };
    };
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = pixel(x, y);
        out[y * width + x] = Math.round(p.alpha * p.y + (1 - p.alpha) * base[y * width + x]);
      }
    }
    for (let cy = 0; cy < hh; cy++) {
      for (let cx = 0; cx < hw; cx++) {
        const covered = [];
        for (let y = 2 * cy; y < Math.min(height, 2 * cy + 2); y++) for (let x = 2 * cx; x < Math.min(width, 2 * cx + 2); x++) covered.push(pixel(x, y));
        const n = covered.length;
        const a = covered.reduce((sum, p) => sum + p.alpha, 0) / n;
        const cb = covered.reduce((sum, p) => sum + p.alpha * p.cb, 0) / n;
        const cr = covered.reduce((sum, p) => sum + p.alpha * p.cr, 0) / n;
        const [cbAt, crAt] =
          format === "NV12"
            ? [width * height + cy * 2 * hw + 2 * cx, width * height + cy * 2 * hw + 2 * cx + 1]
            : [width * height + cy * hw + cx, width * height + hw * hh + cy * hw + cx];
        out[cbAt] = Math.round(cb + (1 - a) * base[cbAt]);
        out[crAt] = Math.round(cr + (1 - a) * base[crAt]);
      }
    }
    return out;
  }

  /** A 5 × 3 picture: a black wash at half, white and coloured text at full and partial cover, clear pixels. */
  function picture(width: number, height: number): Uint8ClampedArray {
    const pixels = [
      [0, 0, 0, 128],
      [255, 255, 255, 255],
      [250, 40, 90, 200],
      [0, 0, 0, 0],
      [30, 200, 120, 64],
      [12, 34, 240, 255],
      [255, 255, 255, 17],
    ];
    const data = new Uint8ClampedArray(4 * width * height);
    for (let i = 0; i < width * height; i++) data.set(pixels[(i * 3) % pixels.length], 4 * i);
    return data;
  }

  const planes = (size: number) => Uint8Array.from({ length: size }, (_, i) => 20 + ((i * 37) % 210));

  it.each([
    ["I420", "limited BT.709", [0.2126, 0.0722], false],
    ["NV12", "limited BT.709", [0.2126, 0.0722], false],
    ["I420", "full-range BT.601", [0.299, 0.114], true],
    ["NV12", "full-range BT.601", [0.299, 0.114], true],
  ] as const)("blends %s at an odd size in %s as the R'G'B' blend converted", (format, _space, coefficients, full) => {
    const [width, height] = [5, 3];
    const base = planes(packed(format, width, height));
    const rgba = picture(width, height);
    const out = base.slice();
    blendOverlayPlanes(out, tight(format, width, height), format, width, height, rgba, [...coefficients], full);
    expect([...out]).toEqual(reference(base, format, width, height, rgba, [...coefficients], full));
  });

  it("gives rgbaToYuv's own bytes under an opaque picture, and leaves every byte under a clear one", () => {
    const [width, height] = [5, 3];
    for (const format of ["I420", "NV12"] as const) {
      for (const colorSpace of [BT709, { matrix: "bt470bg", fullRange: true } as VideoColorSpaceInit]) {
        const opaque = picture(width, height);
        for (let i = 3; i < opaque.length; i += 4) opaque[i] = 255;
        const coefficients: [number, number] = colorSpace.matrix === "bt709" ? [0.2126, 0.0722] : [0.299, 0.114];
        const out = planes(packed(format, width, height));
        blendOverlayPlanes(out, tight(format, width, height), format, width, height, opaque, coefficients, colorSpace.fullRange === true);
        expect([...out]).toEqual([...rgbaToYuv(opaque, width, height, format, colorSpace)!.data]);

        const base = planes(packed(format, width, height));
        const kept = base.slice();
        blendOverlayPlanes(kept, tight(format, width, height), format, width, height, new Uint8ClampedArray(4 * width * height), coefficients, false);
        expect(kept).toEqual(base);
      }
    }
  });

  it("follows the layout it is given: padded rows, the planes where it says, and I420A's alpha plane untouched", () => {
    const [width, height] = [3, 2];
    // Luma rows 4 apart, Cb and Cr rows 3 apart, alpha after them, every pad byte 7
    const layout = [
      { offset: 0, stride: 4 },
      { offset: 8, stride: 3 },
      { offset: 11, stride: 3 },
      { offset: 14, stride: 4 },
    ];
    const buffer = new Uint8Array(22).fill(7);
    for (const at of [0, 1, 2, 4, 5, 6]) buffer[at] = 100;
    for (const at of [8, 9, 11, 12]) buffer[at] = 100;
    for (const at of [14, 15, 16, 18, 19, 20]) buffer[at] = 255;
    const white = solid([255, 255, 255, 255])(width, height);
    blendOverlayPlanes(buffer, layout, "I420A", width, height, white, [0.2126, 0.0722], false);
    expect([...buffer]).toEqual([235, 235, 235, 7, 235, 235, 235, 7, 128, 128, 7, 128, 128, 7, 255, 255, 255, 7, 255, 255, 255, 7]);
  });
});
