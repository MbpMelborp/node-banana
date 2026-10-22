import { VideoSample } from "mediabunny";
import type { VideoSamplePixelFormat } from "mediabunny";
import type { StitchOverlayFont } from "@/types";
import { lumaCoefficients, madeFormat, packedSize, rgbaToYuv, type BlenderRef } from "./crossfadeFrames";
import type { StitchOverlayInput } from "./engineTypes";
import { familyList } from "./fonts";
import { drawOverlays, type OverlayFontList, type OverlayLayoutCache, type OverlayRotation, type OverlaySize } from "./overlayDraw";
import { overlayOpacityAt } from "./overlays";
import { FRAME_RATE, secToSlot } from "./sequencePlan";

/**
 * The overlays burned into a render, between the engine and the encoder: every frame the engine encodes passes
 * through write, in slot order. A frame under a visible overlay is handed on with the overlay over it, any other
 * untouched. Where the overlays' picture changes from one slot to the next (every slot of a fade, the slot of a cut
 * in or out) and the engine writes no frame (a gap's one black frame, a clip held under 60 fps, a cadence slower than
 * the grid), the slot is filled with the last frame and the overlays as they are there, so a fade steps on every slot.
 *
 * The overlays of one state (each layer's opacity) are drawn once by drawOverlays, on a transparent canvas at the
 * encoder's box, laid out in the file's display space and turned into its coded pixels. An 8-bit 4:2:0 frame at the
 * box takes them in its own planes and Y'CbCr: a linear blend in Y'CbCr equals the preview's in R'G'B', and what the
 * overlays leave clear keeps its exact bytes. Any other frame is drawn on a canvas as mediabunny would have fitted it,
 * with the overlays over it.
 */

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface OverlayWriterJob {
  overlays: readonly StitchOverlayInput[];
  /** One loop, seconds: the overlays repeat each loop, and what lies past its end is not shown. */
  loopLength: number;
  loopCount: number;
  /** The file's display size: what the overlays are laid out in. */
  layout: OverlaySize;
  /** The file's rotation, which the overlays are turned back by into the frames' coded pixels. */
  rotation: OverlayRotation;
  /** The encoder's add. */
  add(sample: VideoSample): Promise<void>;
  signal?: AbortSignal;
}

export interface OverlayWriterDeps {
  /** A 2D context at this size: a document canvas, else an OffscreenCanvas. */
  context2d?: (size: OverlaySize, settings: CanvasRenderingContext2DSettings) => Context2D;
  draw?: typeof drawOverlays;
  isFirefox?: boolean;
}

export interface OverlayWriter {
  /** Hands the encoder the filled slots before `sample`'s, then `sample` with the overlays at its slot. The caller closes `sample`. */
  write(sample: VideoSample): Promise<void>;
  /** The filled slots after the last frame, to the encode's end. */
  flush(): Promise<void>;
  /** Lets go of the frame held for the slots to fill. */
  close(): void;
}

/** 8-bit 4:2:0 formats the overlays are blended into in their planes. */
type PlaneFormat = "I420" | "I420A" | "NV12";

const PLANE_FORMATS: ReadonlySet<VideoSamplePixelFormat> = new Set<PlaneFormat>(["I420", "I420A", "NV12"]);

const toByte = (value: number) => (value <= 0 ? 0 : value >= 255 ? 255 : Math.round(value));

const detectFirefox = () => typeof navigator !== "undefined" && navigator.userAgent.includes("Firefox");

function defaultContext2d(size: OverlaySize, settings: CanvasRenderingContext2DSettings): Context2D {
  let context: Context2D | null;
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    context = canvas.getContext("2d", settings);
  } else {
    context = new OffscreenCanvas(size.width, size.height).getContext("2d", settings);
  }
  if (!context) throw new Error("No 2D canvas to draw the overlays on");
  return context;
}

/**
 * Sequence seconds of output slot `slot`: its time less its loop's start, its loop being the last to start at or
 * before it. A loop starts on the slot its start rounds to, which can be a hair before it: 0 there.
 */
export function overlaySlotTime(slot: number, loopLength: number, loopCount: number): number {
  let loop = 0;
  while (loop + 1 < loopCount && secToSlot((loop + 1) * loopLength) <= slot) loop++;
  return Math.max(0, slot / FRAME_RATE - loop * loopLength);
}

function opacitiesAt(overlays: readonly StitchOverlayInput[], slot: number, loopLength: number, loopCount: number): number[] {
  const t = overlaySlotTime(slot, loopLength, loopCount);
  return overlays.map((o) => overlayOpacityAt(o, t));
}

/**
 * The output slots whose overlays differ from the slot before's (each layer's opacity; slot 0's against none), in
 * order: every slot of a fade, the first slot at or after a cut in or out, and a loop's first slot when it opens on
 * other overlays than the loop before ends on.
 */
export function forcedOverlaySlots(overlays: readonly StitchOverlayInput[], loopLength: number, loopCount: number): number[] {
  const forced: number[] = [];
  const total = secToSlot(loopCount * loopLength);
  let previous = overlays.map(() => 0);
  for (let slot = 0; slot < total; slot++) {
    const state = opacitiesAt(overlays, slot, loopLength, loopCount);
    if (state.some((opacity, i) => opacity !== previous[i])) forced.push(slot);
    previous = state;
  }
  return forced;
}

/**
 * Pure: an overlay picture (unpremultiplied RGBA, width × height) blended in place over a frame's 4:2:0 planes laid out
 * as `layout`, in the frame's Y'CbCr by its matrix (kr, kb) and range, with rgbaToYuv's coefficients and rounding:
 * Y' = ov·α + Y'·(1 − α) per pixel; each chroma sample from the mean α over the pixels it covers (fewer at an odd
 * edge) and the overlay's colour there weighted by α. Bytes the overlay leaves clear are not touched, nor is I420A's
 * alpha plane.
 */
export function blendOverlayPlanes(
  planes: Uint8Array,
  layout: readonly PlaneLayout[],
  format: PlaneFormat,
  width: number,
  height: number,
  rgba: ArrayLike<number>,
  [kr, kb]: [number, number],
  fullRange: boolean,
): void {
  const kg = 1 - kr - kb;
  const yScale = fullRange ? 255 : 219;
  const yOffset = fullRange ? 0 : 16;
  const cScale = fullRange ? 255 : 224;
  const [luma, first, second] = layout;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = 4 * (y * width + x);
      if (rgba[i + 3] === 0) continue;
      const alpha = rgba[i + 3] / 255;
      const at = luma.offset + y * luma.stride + x;
      const ov = yOffset + (yScale * (kr * rgba[i] + kg * rgba[i + 1] + kb * rgba[i + 2])) / 255;
      planes[at] = toByte(ov * alpha + planes[at] * (1 - alpha));
    }
  }
  for (let cy = 0; cy * 2 < height; cy++) {
    for (let cx = 0; cx * 2 < width; cx++) {
      let n = 0;
      let sa = 0;
      let sr = 0;
      let sg = 0;
      let sb = 0;
      for (let y = 2 * cy; y < Math.min(height, 2 * cy + 2); y++) {
        for (let x = 2 * cx; x < Math.min(width, 2 * cx + 2); x++) {
          const i = 4 * (y * width + x);
          const a = rgba[i + 3];
          n++;
          sa += a;
          sr += a * rgba[i];
          sg += a * rgba[i + 1];
          sb += a * rgba[i + 2];
        }
      }
      if (sa === 0) continue;
      const r = sr / (255 * sa);
      const g = sg / (255 * sa);
      const b = sb / (255 * sa);
      const l = kr * r + kg * g + kb * b;
      const cb = 128 + (cScale * (b - l)) / (2 * (1 - kb));
      const cr = 128 + (cScale * (r - l)) / (2 * (1 - kr));
      const cover = sa / (255 * n);
      const cbAt = first.offset + cy * first.stride + (format === "NV12" ? 2 * cx : cx);
      const crAt = format === "NV12" ? cbAt + 1 : second.offset + cy * second.stride + cx;
      planes[cbAt] = toByte(cb * cover + planes[cbAt] * (1 - cover));
      planes[crAt] = toByte(cr * cover + planes[crAt] * (1 - cover));
    }
  }
}

const slotOf = (sample: VideoSample) => Math.round(sample.timestamp * FRAME_RATE);

/**
 * The encoder's add, with the overlays. The box and the colour tags a frame made here must keep are the first frame's
 * (mediabunny fits every later frame into its size). A frame is kept (a clone) only while a slot to fill is still to
 * come; the first frame a canvas makes is read back into the box's own Y'CbCr, so it cannot tag the file sRGB.
 */
export function createOverlayWriter(job: OverlayWriterJob, deps: OverlayWriterDeps = {}): OverlayWriter {
  const { overlays, loopLength, loopCount, signal } = job;
  const context2d = deps.context2d ?? defaultContext2d;
  const draw = deps.draw ?? drawOverlays;
  const isFirefox = deps.isFirefox ?? detectFirefox();
  const forced = forcedOverlaySlots(overlays, loopLength, loopCount);
  const lists = new Map<StitchOverlayFont, string>(overlays.map((o) => [o.font, o.fontList]));
  const fontList: OverlayFontList = (font) => lists.get(font) ?? familyList(font);
  const layouts: OverlayLayoutCache = new WeakMap();

  let ref: BlenderRef | null = null;
  let base: VideoSample | null = null;
  /** forced[next] is the first forced slot not yet passed. */
  let next = 0;
  let started = false;
  let planesFailed = false;
  let overlayContext: Context2D | null = null;
  let frameContext: Context2D | null = null;
  /** The state the overlay canvas holds, and its pixels once read. */
  let pictureKey: string | null = null;
  let pictureRgba: Uint8ClampedArray | null = null;
  let planeBuffer: Uint8Array | null = null;

  /** The overlay canvas holding the overlays at `slot`; null when none shows there. */
  const pictureAt = (slot: number): Context2D | null => {
    const opacities = opacitiesAt(overlays, slot, loopLength, loopCount);
    if (!opacities.some((opacity) => opacity > 0)) return null;
    const box = { width: ref!.width, height: ref!.height };
    const ctx = (overlayContext ??= context2d(box, { alpha: true, willReadFrequently: true }));
    const key = opacities.join(",");
    if (key !== pictureKey) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, box.width, box.height);
      draw(ctx, { layout: job.layout, canvas: box, rotation: job.rotation }, overlaySlotTime(slot, loopLength, loopCount), overlays, fontList, layouts);
      pictureKey = key;
      pictureRgba = null;
    }
    return ctx;
  };

  const inPlanes = async (frame: VideoSample, picture: Context2D, timestamp: number, duration: number) => {
    const { width, height } = ref!;
    const format = frame.format;
    if (planesFailed || format === null || !PLANE_FORMATS.has(format)) return null;
    if (frame.codedWidth !== width || frame.codedHeight !== height) return null;
    const coefficients = lumaCoefficients(frame.colorSpace.matrix);
    const size = packedSize(format, width, height);
    if (!coefficients || frame.allocationSize() !== size) return null;
    if (planeBuffer?.length !== size) planeBuffer = new Uint8Array(size);
    const layout = await frame.copyTo(planeBuffer);
    pictureRgba ??= picture.getImageData(0, 0, width, height).data;
    const fullRange = frame.colorSpace.fullRange === true;
    blendOverlayPlanes(planeBuffer, layout, format as PlaneFormat, width, height, pictureRgba, coefficients, fullRange);
    return new VideoSample(planeBuffer, {
      format,
      codedWidth: width,
      codedHeight: height,
      timestamp,
      duration,
      colorSpace: frame.colorSpace,
      layout,
      rotation: 0,
    });
  };

  const onCanvas = (frame: VideoSample, picture: Context2D, timestamp: number, duration: number) => {
    const box = ref!;
    const ctx = (frameContext ??= context2d({ width: box.width, height: box.height }, { alpha: isFirefox }));
    ctx.globalAlpha = 1;
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, box.width, box.height);
    // As the encoder would have taken it: a frame at the box as it is, any other fitted to cover the box, upright
    const atBox = frame.codedWidth === box.width && frame.codedHeight === box.height;
    frame.drawWithFit(ctx, atBox ? { fit: "cover", rotation: 0 } : { fit: "cover" });
    ctx.drawImage(picture.canvas, 0, 0);
    const format = started ? null : madeFormat(box);
    if (format) {
      const pixels = ctx.getImageData(0, 0, box.width, box.height).data;
      const yuv = rgbaToYuv(pixels, box.width, box.height, format, box.colorSpace);
      if (yuv) {
        return new VideoSample(yuv.data, {
          format,
          codedWidth: box.width,
          codedHeight: box.height,
          colorSpace: box.colorSpace,
          layout: yuv.layout,
          timestamp,
          duration,
          rotation: 0,
        });
      }
    }
    return new VideoSample(ctx.canvas, { timestamp, duration, rotation: 0 });
  };

  /** `frame` with the overlays at `slot` over it, as a new sample; null when none shows there. */
  const composite = async (frame: VideoSample, slot: number, timestamp: number, duration: number) => {
    const picture = pictureAt(slot);
    if (!picture) return null;
    try {
      const blended = await inPlanes(frame, picture, timestamp, duration);
      if (blended) return blended;
    } catch (error) {
      console.warn("[VideoStitch] Blending the overlays into the frame's planes failed; drawing them on a canvas from here on", error);
      planesFailed = true;
    }
    return onCanvas(frame, picture, timestamp, duration);
  };

  const hand = async (sample: VideoSample) => {
    try {
      await job.add(sample);
    } finally {
      sample.close();
    }
    started = true;
  };

  /** The forced slots before `end`: the held frame with the overlays there. Before the first frame there is none to hold. */
  const fillBefore = async (end: number) => {
    for (; next < forced.length && forced[next] < end; next++) {
      if (!base) continue;
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const slot = forced[next];
      const timestamp = slot / FRAME_RATE;
      const duration = 1 / FRAME_RATE;
      let filled = await composite(base, slot, timestamp, duration);
      if (!filled) {
        filled = base.clone();
        filled.setTimestamp(timestamp);
        filled.setDuration(duration);
      }
      await hand(filled);
    }
  };

  return {
    async write(sample) {
      ref ??= { width: sample.codedWidth, height: sample.codedHeight, format: sample.format, colorSpace: sample.colorSpace };
      const slot = slotOf(sample);
      await fillBefore(slot);
      const drawn = await composite(sample, slot, sample.timestamp, sample.duration);
      if (drawn) {
        await hand(drawn);
      } else {
        await job.add(sample);
        started = true;
      }
      while (next < forced.length && forced[next] <= slot) next++;
      base?.close();
      base = next < forced.length ? sample.clone() : null;
    },

    async flush() {
      await fillBefore(secToSlot(loopCount * loopLength));
      base?.close();
      base = null;
    },

    close() {
      base?.close();
      base = null;
    },
  };
}
