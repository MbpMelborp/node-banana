import { ALL_FORMATS, BlobSource, Input, UrlSource, VideoSampleSink } from "mediabunny";
import type { InputVideoTrack, VideoSample } from "mediabunny";
import type { StitchOverlay } from "@/types";
import { openClipReader, type ClipReader, type ClipReaderWindow } from "./clipReader";
import { probeClip } from "./clipProbe";
import type { StitchOptions } from "./engineTypes";
import { ensureOverlayFonts, overlayFontList } from "./fonts";
import { drawOverlays, overlayLayoutSize, type OverlayFontList } from "./overlayDraw";
import {
  chooseFrameSlot,
  EMPTY_FACTS,
  planFrameAt,
  type FrameClip,
  type FrameLayer,
  type FramePlan,
  type FrameSourceFacts,
} from "./framePlan";
import { overlayOpacitiesAt } from "./overlays";
import { domOpacities, LAYER_WARNING } from "./placement";
import type { SourceKey } from "./timeline";
import { pickFrame } from "./warpFrames";

/**
 * Frame to canvas, in the page: the frame planned for the playhead (framePlan.ts), decoded from the clips' files
 * with the engine's own readers, composited as Render's canvas path composites it, the overlays drawn over it as
 * the render draws them on that frame's slot, and encoded as PNG.
 */

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export type FrameCaptureFailure = "crossOrigin" | "unreadable" | "empty" | "timeout";

export class FrameCaptureError extends Error {
  constructor(
    readonly kind: FrameCaptureFailure,
    message: string,
    /** 1-based, as the rail's "Clip N". */
    readonly clipNumber?: number,
  ) {
    super(message);
    this.name = "FrameCaptureError";
  }
}

/** An opened source: its video track, the facts the encode reads from it, and how to let it go. */
export interface FrameSource {
  track: InputVideoTrack;
  facts: FrameSourceFacts;
  dispose(): void;
}

export interface FrameCaptureDeps {
  open(src: string, signal?: AbortSignal): Promise<FrameSource>;
  canvas(size: { width: number; height: number }): { ctx: Context2D; toBlob(): Promise<Blob> };
  reader(track: InputVideoTrack, range: { from: number; to: number }, window: ClipReaderWindow, inSec: number): ClipReader;
  sampleAt(track: InputVideoTrack, time: number): Promise<VideoSample | null>;
  /** The frame in effect at `time` (or the first after it) and the next, both before `end`; at most two, the caller closes them. */
  neighbours(track: InputVideoTrack, time: number, end: number): Promise<VideoSample[]>;
  /** Loads the overlays' fonts; the family lists they are drawn in. */
  fonts(overlays: readonly StitchOverlay[]): Promise<OverlayFontList>;
  drawOverlays: typeof drawOverlays;
}

export interface FrameCaptureJob {
  clips: FrameClip[];
  options: StitchOptions;
  t: number;
  /** shownAt(spans, t, stack) at the press: the clip ids the preview showed. */
  shown: ReadonlySet<string>;
  /** The raw src (the view's src), never the playable blob: copy. */
  srcOf(source: SourceKey): string | null;
  /** 1-based, as the rail's "Clip N". */
  clipNumberOf(clipId: string): number;
  size: { width: number; height: number };
  /** Drawn over the frame; absent or empty, none. */
  overlays?: readonly StitchOverlay[];
  signal?: AbortSignal;
}

export interface FrameCapture {
  blob: Blob;
  width: number;
  height: number;
  plan: FramePlan;
  /** Per layer drawn, bottom first: its clip, the source time of the frame drawn, its weight. */
  drawn: { clipId: string; sourceSec: number; weight: number }[];
}

/** Whether src is an absolute http(s) URL on another origin than the page's. data:, blob: and relative URLs are not. */
export function isCrossOriginUrl(src: string, origin: string | undefined = globalThis.location?.origin): boolean {
  if (src.startsWith("data:") || src.startsWith("blob:")) return false;
  let url: URL;
  try {
    url = origin ? new URL(src, origin) : new URL(src);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return url.origin !== origin;
}

/**
 * The source as mediaInfo's probe opens it: data: and blob: are fetched whole, anything else is read by range
 * without retries. An abort disposes the input, which rejects its pending reads.
 */
export async function openFrameSource(src: string, signal?: AbortSignal): Promise<FrameSource> {
  signal?.throwIfAborted();
  const source =
    src.startsWith("data:") || src.startsWith("blob:")
      ? new BlobSource(await (await fetch(src, { signal })).blob())
      : new UrlSource(src, { getRetryDelay: () => null });
  const input = new Input({ source, formats: ALL_FORMATS });
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    input.dispose();
  };
  signal?.addEventListener("abort", dispose, { once: true });
  try {
    signal?.throwIfAborted();
    const probe = await probeClip(input);
    if (!probe) throw new Error("The file has no video track");
    return {
      track: probe.videoTrack,
      facts: { firstTimestamp: probe.firstTimestamp, frameRate: probe.frameRate },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  } finally {
    signal?.removeEventListener("abort", dispose);
  }
}

function defaultCanvas(size: { width: number; height: number }): { ctx: Context2D; toBlob(): Promise<Blob> } {
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No 2D canvas to draw the frame on");
    return {
      ctx,
      toBlob: () =>
        new Promise<Blob>((resolve, reject) =>
          canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The frame could not be encoded as PNG"))), "image/png"),
        ),
    };
  }
  const canvas = new OffscreenCanvas(size.width, size.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No 2D canvas to draw the frame on");
  return { ctx, toBlob: () => canvas.convertToBlob({ type: "image/png" }) };
}

const DEFAULT_DEPS: FrameCaptureDeps = {
  open: openFrameSource,
  canvas: defaultCanvas,
  reader: openClipReader,
  sampleAt: (track, time) => new VideoSampleSink(track).getSample(time),
  // One decode from the key before `time` to the frame after it
  neighbours: async (track, time, end) => {
    const iterator = new VideoSampleSink(track).samples(time, end)[Symbol.asyncIterator]();
    const out: VideoSample[] = [];
    try {
      while (out.length < 2) {
        const next = await iterator.next();
        if (next.done) break;
        out.push(next.value);
      }
    } catch (error) {
      // A frame decoded before the failure never reaches the capture, which closes the rest
      for (const sample of out) sample.close();
      throw error;
    } finally {
      try {
        await iterator.return?.(undefined);
      } catch (error) {
        console.warn("[VideoStitch] Failed to stop a clip decoder", error);
      }
    }
    return out;
  },
  fonts: async (overlays) => overlayFontList(await ensureOverlayFonts(overlays)),
  drawOverlays,
};

const isTimeout = (reason: unknown) =>
  typeof reason === "object" && reason !== null && (reason as { name?: unknown }).name === "TimeoutError";

const isSecurityError = (error: unknown) => error instanceof DOMException && error.name === "SecurityError";

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The frame under the playhead at job.size, as PNG. Opens only the sources the slot's layers read, each once (a held
 * read's only when the layer's own read gives no frame), and closes every reader and sample and disposes every source before it returns or throws. An abort whose reason is a
 * TimeoutError becomes a "timeout" naming the clip that was still being read; any other abort is an AbortError.
 */
export async function captureSequenceFrame(job: FrameCaptureJob, deps: Partial<FrameCaptureDeps> = {}): Promise<FrameCapture> {
  const d: FrameCaptureDeps = { ...DEFAULT_DEPS, ...deps };
  const { signal } = job;
  const slot = chooseFrameSlot(job.clips, job.options, job.t, job.shown);
  const plan0 = planFrameAt(job.clips, job.options, slot, EMPTY_FACTS);
  if (plan0.show.kind !== "layers") throw new FrameCaptureError("empty", "Nothing plays at the playhead");
  const layers0 = plan0.show.layers;

  const opened = new Map<SourceKey, FrameSource>();
  const readers: ClipReader[] = [];
  const samples: VideoSample[] = [];
  let disposed = false;
  const disposeSources = () => {
    if (disposed) return;
    disposed = true;
    for (const source of opened.values()) source.dispose();
  };
  /** The layer whose source or frame is being read: a timeout names its clip. */
  let current: Pick<FrameLayer, "clipId" | "source"> | null = layers0[0];
  const clipNumber = (layer: Pick<FrameLayer, "clipId"> | null) => (layer ? job.clipNumberOf(layer.clipId) : undefined);
  const failureOf = (layer: Pick<FrameLayer, "clipId" | "source">, error: unknown) => {
    const src = job.srcOf(layer.source);
    const kind = src !== null && isCrossOriginUrl(src) ? "crossOrigin" : "unreadable";
    return new FrameCaptureError(kind, messageOf(error), clipNumber(layer));
  };

  // A read the abort stops: a hung fetch or decode never settles, so the capture does not wait on it
  let stopped: Promise<never> | null = null;
  let onAbort: (() => void) | null = null;
  if (signal) {
    stopped = new Promise<never>((_, reject) => {
      onAbort = () => {
        disposeSources();
        reject(signal.reason);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    stopped.catch(() => undefined);
  }
  const untilStopped = <T>(promise: Promise<T>): Promise<T> => (stopped ? Promise.race([promise, stopped]) : promise);

  /** Opens a source once; a failure names `layer`, the clip that reads it. */
  const openSource = async (key: SourceKey, layer: Pick<FrameLayer, "clipId" | "source">): Promise<FrameSource> => {
    const known = opened.get(key);
    if (known) return known;
    const src = job.srcOf(key);
    if (!src) throw new FrameCaptureError("unreadable", "The clip has no video", clipNumber(layer));
    const pending = d.open(src, signal);
    // Opened after an abort or a failure: let it go at once
    pending.then(
      (source) => {
        if (disposed) source.dispose();
      },
      () => undefined,
    );
    let source: FrameSource;
    try {
      source = await untilStopped(pending);
    } catch (error) {
      if (signal?.aborted || error instanceof FrameCaptureError) throw error;
      throw failureOf(layer, error);
    }
    opened.set(key, source);
    return source;
  };
  const openedFacts = () => new Map<SourceKey, FrameSourceFacts>([...opened].map(([key, source]) => [key, source.facts]));

  try {
    try {
      await Promise.all(
        plan0.sources.map(async (key) => {
          await openSource(key, layers0.find((l) => l.source === key) ?? layers0[0]);
          if (current?.source === key) current = layers0.find((l) => !opened.has(l.source)) ?? layers0[0];
        }),
      );
    } catch (error) {
      if (!signal?.aborted) throw error;
      // Name the first layer whose source had not opened
      current = layers0.find((l) => !opened.has(l.source)) ?? current;
      throw signal.reason;
    }

    let plan = planFrameAt(job.clips, job.options, slot, openedFacts());
    if (plan.show.kind !== "layers") throw new FrameCaptureError("empty", "Nothing plays at the playhead");
    const layers = plan.show.layers;
    if (layers.length > LAYER_WARNING) {
      console.warn(`[VideoStitch] ${layers.length} clips blend at once; this takes about ${layers.length * 50} MB at 1080p`);
    }

    const sourceFor = (layer: Pick<FrameLayer, "clipId" | "source">): FrameSource => {
      const source = opened.get(layer.source);
      if (!source) throw new FrameCaptureError("unreadable", "The clip's video was not opened", clipNumber(layer));
      return source;
    };
    /**
     * The layer's frames, each with its share of the layer (one at 1, or none; a retimed clip blending on its slot gives
     * two), and its reader when it reads by slot (the reader keeps its frames; a time or warp read's are ours).
     */
    const readLayer = async (
      layer: Omit<FrameLayer, "held" | "weight">,
    ): Promise<{ frames: Array<{ sample: VideoSample; share: number }>; reader: ClipReader | null }> => {
      const { read } = layer;
      const { track } = sourceFor(layer);
      if (read.by === "time") {
        const sample = await untilStopped(d.sampleAt(track, read.time));
        if (sample) samples.push(sample);
        return { frames: sample ? [{ sample, share: 1 }] : [], reader: null };
      }
      if (read.by === "warp") {
        const got = await untilStopped(d.neighbours(track, read.time, read.until));
        // Closed in finally, picked or not
        samples.push(...got);
        if (got.length === 0) return { frames: [], reader: null };
        // Over the two neighbours it picks what it picks over the clip's whole frame list, as Render does
        const pick = pickFrame(got.map((sample) => sample.timestamp), read.time, read.blend);
        return {
          frames:
            pick.b < 0
              ? [{ sample: got[pick.a], share: 1 }]
              : [
                  { sample: got[pick.a], share: 1 - pick.alpha },
                  { sample: got[pick.b], share: pick.alpha },
                ],
          reader: null,
        };
      }
      const reader = d.reader(track, read.range, read.window, read.inSec);
      readers.push(reader);
      const sample = await untilStopped(reader.frameOn(read.slot));
      return { frames: sample ? [{ sample, share: 1 }] : [], reader };
    };
    /**
     * The held read, its source opened only now that it is needed, and planned again with that source's facts
     * (its window starts at its own first timestamp).
     */
    const heldRead = async (k: number, held: Omit<FrameLayer, "held" | "weight">) => {
      if (opened.has(held.source)) return held;
      await openSource(held.source, held);
      plan = planFrameAt(job.clips, job.options, slot, openedFacts());
      const again = plan.show.kind === "layers" ? plan.show.layers[k] : undefined;
      return again?.unit === layers[k].unit && again.held ? again.held : held;
    };

    /**
     * Per frame drawn: the frame, the clip it came from (the held clip's when the layer's own read gave none) and its
     * weight, the layer's times the frame's share of it.
     */
    const read: Array<{ from: Pick<FrameLayer, "clipId" | "source">; sample: VideoSample; weight: number }> = [];
    for (const [k, layer] of layers.entries()) {
      if (signal?.aborted) throw signal.reason;
      current = layer;
      let from: Pick<FrameLayer, "clipId" | "source"> = layer;
      let frames: Array<{ sample: VideoSample; share: number }>;
      try {
        const own = await readLayer(layer);
        frames = own.frames;
        if (frames.length === 0 && layer.held) {
          current = layer.held;
          const held = await heldRead(k, layer.held);
          const got = (await readLayer(held)).frames;
          if (got.length > 0) {
            frames = got;
            from = held;
          }
          current = layer;
        }
        // Nothing on or before the slot: the clip's first frame
        if (frames.length === 0 && own.reader) {
          const first = await untilStopped(own.reader.firstFrame());
          if (first) frames = [{ sample: first, share: 1 }];
        }
      } catch (error) {
        if (signal?.aborted || error instanceof FrameCaptureError) throw error;
        throw failureOf(current ?? layer, error);
      }
      for (const { sample, share } of frames) read.push({ from, sample, weight: layer.weight * share });
    }
    if (signal?.aborted) throw signal.reason;
    if (read.length === 0) throw new FrameCaptureError("unreadable", "No frame could be read at the playhead", clipNumber(layers0[0]));
    current = null;

    // Render's composite: the layers present, their weights divided by their sum (a zero sum gives the bottom 1); a
    // blended retimed layer is its two frames, the lower opaque and the upper at its share, as Render's blend makes it
    const raw = read.map(({ weight }) => (Number.isFinite(weight) && weight > 0 ? weight : 0));
    const sum = raw.reduce((total, w) => total + w, 0);
    const weights = sum > 0 ? raw.map((w) => w / sum) : raw.map((_, k) => (k === 0 ? 1 : 0));
    const opacities = domOpacities(weights);

    const { width, height } = job.size;
    const overlays = job.overlays ?? [];
    const fontList = overlays.length > 0 ? await untilStopped(d.fonts(overlays)) : null;
    let blob: Blob;
    try {
      const { ctx, toBlob } = d.canvas({ width, height });
      ctx.globalAlpha = 1;
      ctx.fillStyle = "black";
      ctx.fillRect(0, 0, width, height);
      read.forEach(({ sample }, k) => {
        ctx.globalAlpha = k === 0 ? 1 : opacities[k];
        // Upright by the sample's own rotation
        sample.drawWithFit(ctx, { fit: "cover" });
      });
      ctx.globalAlpha = 1;
      if (fontList) {
        const target = { layout: overlayLayoutSize(width, height), canvas: { width, height }, rotation: 0 as const };
        d.drawOverlays(ctx, target, overlayOpacitiesAt(overlays, plan.slot), overlays, fontList);
      }
      blob = await untilStopped(toBlob());
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (isSecurityError(error)) {
        const blocked = read.find(({ from }) => {
          const src = job.srcOf(from.source);
          return src !== null && isCrossOriginUrl(src);
        });
        throw new FrameCaptureError("crossOrigin", messageOf(error), clipNumber(blocked?.from ?? read[0].from));
      }
      throw new FrameCaptureError("unreadable", messageOf(error), clipNumber(read[0].from));
    }

    return {
      blob,
      width,
      height,
      plan,
      drawn: read.map(({ from, sample }, k) => ({ clipId: from.clipId, sourceSec: sample.timestamp, weight: weights[k] })),
    };
  } catch (error) {
    // Once aborted, a read the abort broke fails with its own error: the abort is what happened
    if (signal?.aborted) {
      if (isTimeout(signal.reason)) {
        throw new FrameCaptureError("timeout", "Reading the clip took too long", clipNumber(current ?? layers0[0]));
      }
      throw new DOMException("Aborted", "AbortError");
    }
    throw error;
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    for (const sample of samples) sample.close();
    await Promise.all(readers.map((reader) => reader.close()));
    disposeSources();
  }
}
