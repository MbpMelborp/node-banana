import { VideoSample, VideoSampleSink } from "mediabunny";
import type { InputVideoTrack, VideoSamplePixelFormat } from "mediabunny";

/**
 * The picture side of a stacked crossfade: two decoded frames blended into
 * one, and a dissolve's frames read from both clips in step and handed to the
 * encoder. Runs in the page (mediabunny, canvas, pixel buffers); the timing
 * comes from dissolveFrames in stack.ts.
 *
 * Frames that share a size and an 8-bit format are blended byte by byte in
 * their own planes: a linear blend in Y'CbCr equals one in R'G'B', so the
 * blended frames keep the colour of the frames passed straight through on
 * either side. A canvas is used only when that cannot be done.
 */

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const clamp01 = (value: number) => (Number.isNaN(value) ? 0 : Math.min(Math.max(value, 0), 1));

/** Pure: out[i] = round(a[i] + (b[i] − a[i])·alpha) for three buffers of one length. */
export function blendBytes(a: Uint8Array, b: Uint8Array, alpha: number, out: Uint8Array): void {
  const t = clamp01(alpha);
  const n = Math.min(a.length, b.length, out.length);
  // Every value is in [0, 255], so adding a half and truncating rounds
  for (let i = 0; i < n; i++) out[i] = (a[i] + (b[i] - a[i]) * t + 0.5) | 0;
}

/** 8-bit pixel formats a byte-wise blend is exact for (planar, semi-planar and packed alike). */
export const BYTE_BLEND_FORMATS: ReadonlySet<string> = new Set([
  "I420",
  "I420A",
  "I422",
  "I444",
  "NV12",
  "RGBA",
  "RGBX",
  "BGRA",
  "BGRX",
]);

/** Bytes of a tightly packed frame, so a frame whose visible area differs from its coded size never takes the bytes path. */
function packedSize(format: VideoSamplePixelFormat, width: number, height: number): number {
  const luma = width * height;
  const halfW = Math.ceil(width / 2);
  const halfH = Math.ceil(height / 2);
  switch (format) {
    case "I420":
    case "NV12":
      return luma + 2 * halfW * halfH;
    case "I420A":
      return 2 * luma + 2 * halfW * halfH;
    case "I422":
      return luma + 2 * halfW * height;
    case "I444":
      return 3 * luma;
    default:
      return 4 * luma;
  }
}

const samePlaneLayout = (a: PlaneLayout[], b: PlaneLayout[]) =>
  a.length === b.length && a.every((plane, i) => plane.offset === b[i].offset && plane.stride === b[i].stride);

export interface FrameBlender {
  /** a at 1 − alpha under b at alpha; a missing side: the other alone. Rotation 0. The caller closes the result. */
  blend(a: VideoSample | null, b: VideoSample | null, alpha: number, timestamp: number, duration: number): Promise<VideoSample>;
}

export interface FrameBlenderDeps {
  /** Makes the fallback canvas's context at the reference size; a document canvas, else an OffscreenCanvas. */
  context2d?: (size: { width: number; height: number }, options: { alpha: boolean }) => Context2D;
  isFirefox?: boolean;
}

function defaultContext2d(size: { width: number; height: number }, options: { alpha: boolean }): Context2D {
  let context: Context2D | null;
  if (typeof document !== "undefined") {
    const canvas: HTMLCanvasElement = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    context = canvas.getContext("2d", { alpha: options.alpha });
  } else {
    context = new OffscreenCanvas(size.width, size.height).getContext("2d", options);
  }
  if (!context) throw new Error("No 2D canvas to blend the crossfade on");
  return context;
}

const detectFirefox = () => typeof navigator !== "undefined" && navigator.userAgent.includes("Firefox");

/**
 * Bytes path when both are non-null, share a format in BYTE_BLEND_FORMATS, have coded size === ref, and equal allocationSize():
 *   copyTo into two reused read buffers, blendBytes into a reused output buffer, then a new VideoSample of those bytes with a's
 *   colour space and rotation 0 (the sample copies the bytes it is given, so it owns its own and the buffer can be reused).
 * Otherwise (mixed sizes, a null or 10-bit format, a single side at another size, or copyTo throwing — after which the blender
 * stays on the canvas): one canvas at ref size, black fill, a drawn to cover at globalAlpha 1, b at alpha over it, rotation 0.
 * Its context is opaque except on Firefox, as mediabunny keeps its own (VideoFrame glitches with opaque canvases there).
 * A single side at ref size passes as a clone with the new timestamp.
 */
export function createFrameBlender(ref: { width: number; height: number }, deps: FrameBlenderDeps = {}): FrameBlender {
  const isFirefox = deps.isFirefox ?? detectFirefox();
  let bytesFailed = false;
  let readA: Uint8Array | null = null;
  let readB: Uint8Array | null = null;
  let blendOut: Uint8Array | null = null;
  let context: Context2D | null = null;

  const atRef = (sample: VideoSample) => sample.codedWidth === ref.width && sample.codedHeight === ref.height;

  const bytesPlan = (a: VideoSample, b: VideoSample): { format: VideoSamplePixelFormat; size: number } | null => {
    const format = a.format;
    if (bytesFailed || format === null || format !== b.format || !BYTE_BLEND_FORMATS.has(format)) return null;
    if (!atRef(a) || !atRef(b)) return null;
    const size = a.allocationSize();
    if (b.allocationSize() !== size || size !== packedSize(format, ref.width, ref.height)) return null;
    return { format, size };
  };

  const blendInBytes = async (
    a: VideoSample,
    b: VideoSample,
    { format, size }: { format: VideoSamplePixelFormat; size: number },
    alpha: number,
    timestamp: number,
    duration: number,
  ): Promise<VideoSample | null> => {
    if (readA?.length !== size) readA = new Uint8Array(size);
    if (readB?.length !== size) readB = new Uint8Array(size);
    const layoutA = await a.copyTo(readA);
    const layoutB = await b.copyTo(readB);
    if (!samePlaneLayout(layoutA, layoutB)) return null;
    if (blendOut?.length !== size) blendOut = new Uint8Array(size);
    blendBytes(readA, readB, alpha, blendOut);
    return new VideoSample(blendOut, {
      format,
      codedWidth: ref.width,
      codedHeight: ref.height,
      timestamp,
      duration,
      colorSpace: a.colorSpace,
      layout: layoutA,
      rotation: 0,
    });
  };

  const blendOnCanvas = (a: VideoSample | null, b: VideoSample | null, alpha: number, timestamp: number, duration: number) => {
    context ??= (deps.context2d ?? defaultContext2d)(ref, { alpha: isFirefox });
    context.globalAlpha = 1;
    context.fillStyle = "black";
    context.fillRect(0, 0, ref.width, ref.height);
    if (a) a.drawWithFit(context, { fit: "cover", rotation: 0 });
    if (b) {
      context.globalAlpha = a ? clamp01(alpha) : 1;
      b.drawWithFit(context, { fit: "cover", rotation: 0 });
      context.globalAlpha = 1;
    }
    return new VideoSample(context.canvas, { timestamp, duration, rotation: 0 });
  };

  return {
    async blend(a, b, alpha, timestamp, duration) {
      if (a && b) {
        const plan = bytesPlan(a, b);
        if (plan) {
          try {
            const blended = await blendInBytes(a, b, plan, alpha, timestamp, duration);
            if (blended) return blended;
          } catch (error) {
            console.warn("[VideoStitch] Blending frame bytes failed; blending on a canvas from here on", error);
            bytesFailed = true;
          }
        }
      }
      const single = a && !b ? a : !a && b ? b : null;
      if (single && atRef(single)) {
        const copy = single.clone();
        copy.setTimestamp(timestamp);
        copy.setDuration(duration);
        return copy;
      }
      return blendOnCanvas(a, b, alpha, timestamp, duration);
    },
  };
}

export interface DissolveJob {
  outgoing: InputVideoTrack;
  incoming: InputVideoTrack;
  /** Output timestamps (slot / 60), already claimed from the FrameSlotter, ascending. */
  timestamps: number[];
  outgoingTimes: number[];
  incomingTimes: number[];
  alphas: number[];
  /** Each composite's duration: 1/60, as pass-through frames get. */
  frameDuration: number;
  signal?: AbortSignal;
}

async function closeIterator(iterator: AsyncGenerator<VideoSample | null, void, unknown>): Promise<void> {
  try {
    await iterator.return(undefined);
  } catch (error) {
    console.warn("[VideoStitch] Failed to stop a crossfade decoder", error);
  }
}

/**
 * Both sides through new VideoSampleSink(track).samplesAtTimestamps(times), advanced in lockstep (one next() each per frame).
 * blenderFor gets the first outgoing sample (null if none) and returns the encode's blender (created then if needed). Per frame:
 * hold the latest non-null sample of each side (closing the one it replaces), blend, await add(result), close the result. Abort is
 * checked per frame. finally: close both held samples and await return() on both iterators, which closes what they still queue.
 * (return() does not wait for the decoder to close, so a third decoder can briefly overlap the next solo pass.)
 */
export async function encodeDissolve(
  job: DissolveJob,
  blenderFor: (firstOutgoing: VideoSample | null) => FrameBlender,
  add: (sample: VideoSample) => Promise<void>,
): Promise<void> {
  const count = job.timestamps.length;
  if (count === 0) return;
  const outgoing = new VideoSampleSink(job.outgoing).samplesAtTimestamps(job.outgoingTimes);
  const incoming = new VideoSampleSink(job.incoming).samplesAtTimestamps(job.incomingTimes);
  let heldA: VideoSample | null = null;
  let heldB: VideoSample | null = null;
  let blender: FrameBlender | null = null;
  try {
    for (let i = 0; i < count; i++) {
      if (job.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      // Each result is held before the next await, so an error on the other side cannot leak it
      const nextA = await outgoing.next();
      if (!nextA.done && nextA.value) {
        heldA?.close();
        heldA = nextA.value;
      }
      const nextB = await incoming.next();
      if (!nextB.done && nextB.value) {
        heldB?.close();
        heldB = nextB.value;
      }
      blender ??= blenderFor(heldA);
      const blended = await blender.blend(heldA, heldB, job.alphas[i], job.timestamps[i], job.frameDuration);
      try {
        await add(blended);
      } finally {
        blended.close();
      }
    }
  } finally {
    heldA?.close();
    heldB?.close();
    await Promise.all([closeIterator(outgoing), closeIterator(incoming)]);
  }
}
