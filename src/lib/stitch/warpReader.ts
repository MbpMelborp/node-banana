import { EncodedPacketSink, VideoSample, VideoSampleSink } from "mediabunny";
import type { EncodedPacket, InputVideoTrack } from "mediabunny";
import type { SlotReader } from "./clipReader";
import { packedSize, type BlenderRef, type FrameBlender } from "./crossfadeFrames";
import { FRAME_RATE } from "./sequencePlan";
import type { WarpMap } from "./warp";
import {
  eventAt,
  frameIndexAt,
  reverseChunk,
  reverseChunkFrames,
  warpEvents,
  type ReverseChunk,
  type WarpEvents,
  type WarpSlots,
} from "./warpFrames";

/**
 * A warped clip's frames for the encoder: its frame list read once from the packets, then, per stretch it plays, a
 * reader that answers "the frame on slot n" as ClipReader does, decoding forward through the source, or in chunks kept
 * in memory when the clip plays backwards. Runs in the page (mediabunny).
 */

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface ClipFrames {
  /**
   * Presentation times of the clip's frames: the frame in effect at In (or the first, when In comes before it), then
   * every frame before Out, and at a split's join (warpFrames' joinOuts) the first frame at or after Out. Rising,
   * distinct.
   */
  times: Float64Array;
  /** Indices into times of the frames the container marks as key frames (planning only; mediabunny verifies on decode). */
  keys: Int32Array;
  /** Set when the list reaches past Out: where a decode of the listed frames ends (exclusive), past the last of them. */
  end?: number;
}

/** What frameTable reads of a packet. */
export type PacketMeta = Pick<EncodedPacket, "timestamp" | "type">;

/** The parts of an EncodedPacketSink frameTable reads, metadata only (injectable for tests). */
export interface PacketIndex<P extends PacketMeta = PacketMeta> {
  /** The last packet in presentation order starting at or before sec. */
  inEffect(sec: number): Promise<PacketMeta | null>;
  /** The last key packet starting at or before sec. */
  keyAtOrBefore(sec: number): Promise<P | null>;
  first(): Promise<P | null>;
  /** The next packet in decode order. */
  next(packet: P): Promise<P | null>;
}

/**
 * H.264 and HEVC reorder at most this many frames: a frame comes after at most 16 later-shown ones in decode order, so
 * once 17 packets at or past Out are read, none after them is before Out. A count, not a time: at 2 fps three
 * B-frames reorder over a second and a half.
 */
const REORDER_FRAMES = 16;
/**
 * The listing also reads at least this far past Out, whatever the count: a margin for a stream that reorders deeper
 * than the standard allows.
 */
const REORDER_SLACK_SEC = 1;
const ABORT_CHECK_PACKETS = 256;

const throwIfAborted = (signal: AbortSignal | undefined) => {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
};

/**
 * The clip's frame list from packet metadata, decoding nothing: from the key packet before the frame in effect at In,
 * in decode order, every frame in [that frame, Out); with joinOut (a split's join, warpFrames' joinOuts) also the first
 * frame in [Out, joinOut). It stops at the first packet past the first key frame at or after Out (whose leading
 * B-frames may still be the clip's), or at the first packet REORDER_SLACK_SEC past Out once more than REORDER_FRAMES
 * packets at or past Out are read.
 */
export async function frameTable<P extends PacketMeta>(
  index: PacketIndex<P>,
  inSec: number,
  outSec: number,
  signal?: AbortSignal,
  joinOut: number | null = null,
): Promise<ClipFrames> {
  const atIn = await index.inEffect(inSec);
  const lo = atIn ? atIn.timestamp : -Infinity;
  let packet = (atIn ? await index.keyAtOrBefore(atIn.timestamp) : null) ?? (await index.first());
  const found: number[] = [];
  const keyTimes = new Set<number>();
  let pastKey: number | null = null;
  let pastOut = 0;
  // The two earliest frames at or past Out: a join lists the first, and its decode ends between them
  let next = Infinity;
  let second = Infinity;
  for (let read = 0; packet; read++) {
    if (read % ABORT_CHECK_PACKETS === 0) throwIfAborted(signal);
    const ts = packet.timestamp;
    if ((pastKey !== null && ts > pastKey) || (pastOut > REORDER_FRAMES && ts >= outSec + REORDER_SLACK_SEC)) break;
    if (ts >= outSec) {
      pastOut++;
      if (ts < next) {
        second = next;
        next = ts;
      } else if (ts > next && ts < second) {
        second = ts;
      }
    } else if (ts >= lo) {
      found.push(ts);
    }
    if (ts >= lo && packet.type === "key") keyTimes.add(ts);
    if (pastKey === null && packet.type === "key" && ts >= outSec) pastKey = ts;
    packet = await index.next(packet);
  }
  const joins = joinOut !== null && next < joinOut;
  if (joins) found.push(next);
  found.sort((a, b) => a - b);
  const times = found.filter((ts, i) => i === 0 || ts !== found[i - 1]);
  const keys: number[] = [];
  times.forEach((ts, i) => {
    if (keyTimes.has(ts)) keys.push(i);
  });
  return {
    times: Float64Array.from(times),
    keys: Int32Array.from(keys),
    ...(joins ? { end: second < Infinity ? (next + second) / 2 : joinOut } : {}),
  };
}

/** frameTable over the track's own packets. */
export function clipFrames(
  track: InputVideoTrack,
  inSec: number,
  outSec: number,
  signal?: AbortSignal,
  joinOut: number | null = null,
): Promise<ClipFrames> {
  const sink = new EncodedPacketSink(track);
  const meta = { metadataOnly: true };
  return frameTable<EncodedPacket>(
    {
      inEffect: (sec) => sink.getPacket(sec, meta),
      keyAtOrBefore: (sec) => sink.getKeyPacket(sec, meta),
      first: () => sink.getFirstPacket(meta),
      next: (packet) => sink.getNextPacket(packet, meta),
    },
    inSec,
    outSec,
    signal,
    joinOut,
  );
}

/** The buffer and canvas copyToBytes reuses: the sample it makes copies them, so one of each serves every frame. */
export interface BytesScratch {
  buffer: Uint8Array | null;
  ctx: Context2D | null;
}

/**
 * An OffscreenCanvas first, unlike the blender's and the overlay writer's canvases: this one is only ever a snapshot's
 * source, never shown or read back, and OffscreenCanvas 2D exists wherever WebCodecs does.
 */
function scratchContext(scratch: BytesScratch, width: number, height: number): Context2D {
  if (!scratch.ctx) {
    let context: Context2D | null = null;
    if (typeof OffscreenCanvas !== "undefined") {
      context = new OffscreenCanvas(width, height).getContext("2d");
    } else if (typeof document !== "undefined") {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      context = canvas.getContext("2d");
    }
    if (!context) throw new Error("No 2D canvas to keep a retimed clip's frames on");
    scratch.ctx = context;
  }
  const { canvas } = scratch.ctx;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return scratch.ctx;
}

/**
 * A copy of a decoded frame that owns its own memory, so the decoder's frame can go back at once: its bytes when they
 * are the frame, else the frame drawn once on a canvas at its display size. Same timestamp, duration and rotation.
 */
export async function copyToBytes(
  sample: VideoSample,
  scratch: BytesScratch = { buffer: null, ctx: null },
): Promise<VideoSample> {
  const format = sample.format;
  if (format !== null) {
    try {
      const size = sample.allocationSize();
      // Only when the bytes are the frame: a non-square-pixel frame copies its visible rect, narrower than codedWidth
      if (size === packedSize(format, sample.codedWidth, sample.codedHeight)) {
        if (scratch.buffer?.length !== size) scratch.buffer = new Uint8Array(size);
        const layout = await sample.copyTo(scratch.buffer);
        return new VideoSample(scratch.buffer, {
          format,
          codedWidth: sample.codedWidth,
          codedHeight: sample.codedHeight,
          timestamp: sample.timestamp,
          duration: sample.duration,
          colorSpace: sample.colorSpace,
          layout,
          rotation: sample.rotation,
        });
      }
    } catch {
      // The canvas below
    }
  }
  // A VideoFrame of a canvas is a snapshot, so one canvas serves every frame
  const ctx = scratchContext(scratch, sample.codedWidth, sample.codedHeight);
  sample.drawWithFit(ctx, { fit: "fill", rotation: 0 });
  return new VideoSample(ctx.canvas, { timestamp: sample.timestamp, duration: sample.duration, rotation: sample.rotation });
}

/** Blends two frames of the clip on a slot. The caller closes the result. */
export type WarpBlend = (a: VideoSample, b: VideoSample, alpha: number, timestamp: number, duration: number) => Promise<VideoSample>;

/**
 * Blends a retimed clip's two frames as a frame of the clip: at its own size, with its own rotation, so mediabunny fits
 * it into the file as it fits the clip's other frames. Its blender comes from makeBlender at its first blended frame,
 * at that frame's coded size (the engine shares one per size).
 */
export function clipBlend(makeBlender: (ref: BlenderRef) => FrameBlender): WarpBlend {
  let blender: FrameBlender | null = null;
  return async (a, b, alpha, timestamp, duration) => {
    blender ??= makeBlender({ width: a.codedWidth, height: a.codedHeight });
    const blended = await blender.blend(a, b, alpha, timestamp, duration);
    blended.setRotation(a.rotation);
    return blended;
  };
}

export interface WarpedReaderDeps {
  frames: () => Promise<ClipFrames>;
  /** VideoSampleSink(track).samples. */
  samples: (from: number, to: number) => AsyncIterable<VideoSample>;
  /** Keeps a decoded frame as a copy of its own (reversed and blended clips); default copyToBytes. */
  toBytes?: (sample: VideoSample) => Promise<VideoSample>;
  /**
   * What one kept copy takes until one is measured, which sizes a reversed clip's first chunk: the probe's width ×
   * height × 4 (a canvas copy is 4 bytes a pixel, a byte copy no more). A copy can be wider than the probe (a frame
   * with non-square pixels a decoder gives at its display width): the store then cuts its chunk. Later chunks use the
   * copies' own size.
   */
  frameBytes: number;
  /** Null when the clip does not blend; the engine passes clipBlend over its blenders shared by frame size. */
  blend: WarpBlend | null;
  signal?: AbortSignal;
}

interface StoreDeps {
  samples: WarpedReaderDeps["samples"];
  toBytes: (sample: VideoSample) => Promise<VideoSample>;
  frameBytes: number;
  signal?: AbortSignal;
}

/** The decoded frames a reader shows. Frames are dropped or replaced only inside prepare. */
interface FrameStore {
  /** Makes event e's frames available. */
  prepare(events: WarpEvents, e: number): Promise<void>;
  get(index: number): VideoSample | null;
  close(): Promise<void>;
}

/**
 * One forward decode from the first pick to Out. It holds at most two frames, three while one is copied: a forward pick
 * falls by one only where a slot switches from the nearer frame into a blend, so a blending clip keeps the frame below
 * a single pick. Fast motion decodes the frames it skips and closes each at once. Only a frame a blend reads is copied
 * to bytes, once.
 */
class ForwardStore implements FrameStore {
  private readonly queue: Array<{ index: number; sample: VideoSample; copied: boolean }> = [];
  private iterator: AsyncIterator<VideoSample, void, unknown> | null = null;
  private done = false;

  constructor(
    private readonly frames: ClipFrames,
    private readonly map: WarpMap,
    private readonly deps: StoreDeps,
  ) {}

  private dropBelow(low: number): void {
    while (this.queue.length >= 2 && this.queue[1].index <= low) this.queue.shift()!.sample.close();
  }

  /** The last entry with index <= i, else the first. */
  private entry(index: number) {
    let found = this.queue[0];
    for (const entry of this.queue) if (entry.index <= index) found = entry;
    return found;
  }

  async prepare(events: WarpEvents, e: number): Promise<void> {
    const need = events.a[e];
    const blends = events.b[e] >= 0;
    const high = blends ? events.b[e] : need;
    // After a blend the next pick is at least its lower frame
    const low = this.map.warp.blend && !blends ? Math.max(0, need - 1) : need;
    const end = this.frames.end ?? this.map.range.outSec;
    this.iterator ??= this.deps.samples(this.frames.times[low], end)[Symbol.asyncIterator]();
    this.dropBelow(low);
    while (!this.done && (this.queue.length === 0 || this.queue[this.queue.length - 1].index < high)) {
      throwIfAborted(this.deps.signal);
      const next = await this.iterator.next();
      if (next.done) {
        this.done = true;
        break;
      }
      const index = frameIndexAt(this.frames.times, next.value.timestamp);
      const last = this.queue[this.queue.length - 1];
      // A repeat replaces the one before
      if (last && last.index >= index) this.queue.pop()!.sample.close();
      this.queue.push({ index, sample: next.value, copied: false });
      this.dropBelow(low);
    }
    if (!blends) return;
    // The blender reads both frames on every slot between them: from bytes that is a copy, not a read-back
    for (const index of [need, high]) {
      const entry = this.entry(index);
      if (!entry || entry.copied) continue;
      const copy = await this.deps.toBytes(entry.sample);
      entry.sample.close();
      entry.sample = copy;
      entry.copied = true;
    }
  }

  get(index: number): VideoSample | null {
    return this.queue.length > 0 ? this.entry(index).sample : null;
  }

  async close(): Promise<void> {
    for (const entry of this.queue.splice(0)) entry.sample.close();
    try {
      await this.iterator?.return?.(undefined);
    } catch (error) {
      console.warn("[VideoStitch] Failed to stop a clip decoder", error);
    }
  }
}

const bytesOf = (sample: VideoSample) => {
  try {
    return sample.allocationSize();
  } catch {
    return sample.codedWidth * sample.codedHeight * 4;
  }
};

/**
 * A reversed clip's frames: per chunk of events, the frames they show decoded forward once from the chunk's lowest and
 * kept as byte copies (a decoder's own frames would stall its output pool), at most reverseChunkFrames of them for the
 * largest copy measured (the deps' bound until one is). A copy larger than its chunk was planned for cuts the chunk to
 * fewer events, whose frames the same decode still reaches. A GOP longer than a chunk decodes its head again for each
 * chunk.
 */
class ReverseStore implements FrameStore {
  private readonly cache = new Map<number, VideoSample>();
  private chunk: ReverseChunk | null = null;
  /** The deps' bound until a copy is measured, then the largest copy measured. */
  private frameBytes: number;
  private measured = false;

  constructor(
    private readonly frames: ClipFrames,
    private readonly map: WarpMap,
    private readonly deps: StoreDeps,
  ) {
    this.frameBytes = deps.frameBytes;
  }

  private clear(): void {
    for (const sample of this.cache.values()) sample.close();
    this.cache.clear();
    this.chunk = null;
  }

  async prepare(events: WarpEvents, e: number): Promise<void> {
    if (this.chunk && this.chunk.first <= e && e < this.chunk.end) return;
    this.clear();
    const { times, keys } = this.frames;
    let fits = reverseChunkFrames(this.frameBytes);
    let chunk = reverseChunk(events, e, fits, keys);
    // To the middle of the gap after the chunk's highest frame, so the decoder stops on it
    const last = this.frames.end ?? this.map.range.outSec;
    const end = chunk.hi + 1 < times.length ? (times[chunk.hi] + times[chunk.hi + 1]) / 2 : last;
    let want = new Set(chunk.need);
    const iterator = this.deps.samples(times[chunk.lo], end)[Symbol.asyncIterator]();
    try {
      for (;;) {
        throwIfAborted(this.deps.signal);
        const next = await iterator.next();
        if (next.done) break;
        try {
          const index = frameIndexAt(times, next.value.timestamp);
          if (want.has(index) && !this.cache.has(index)) {
            const kept = await this.deps.toBytes(next.value);
            this.cache.set(index, kept);
            const bytes = bytesOf(kept);
            this.frameBytes = this.measured ? Math.max(this.frameBytes, bytes) : bytes;
            this.measured = true;
            // Larger than the chunk was planned for (a decoder may give a non-square-pixel frame at its display width,
            // and its canvas copy takes that width): fewer events from the same first one need a subset of its frames
            if (reverseChunkFrames(this.frameBytes) < fits) {
              fits = reverseChunkFrames(this.frameBytes);
              chunk = reverseChunk(events, e, fits, keys);
              want = new Set(chunk.need);
              for (const [i, sample] of this.cache) {
                if (want.has(i)) continue;
                sample.close();
                this.cache.delete(i);
              }
            }
          }
          if (index >= chunk.hi) break;
        } finally {
          next.value.close();
        }
      }
    } finally {
      try {
        await iterator.return?.(undefined);
      } catch (error) {
        console.warn("[VideoStitch] Failed to stop a clip decoder", error);
      }
    }
    this.chunk = chunk;
  }

  get(index: number): VideoSample | null {
    const exact = this.cache.get(index);
    if (exact) return exact;
    // A frame the decoder skipped: the kept frame nearest it
    const { times } = this.frames;
    let nearest: VideoSample | null = null;
    let gap = Infinity;
    for (const [i, sample] of this.cache) {
      const d = Math.abs(times[i] - times[index]);
      if (d < gap) {
        nearest = sample;
        gap = d;
      }
    }
    return nearest;
  }

  async close(): Promise<void> {
    this.clear();
  }
}

/**
 * A retimed clip's reader for the slots [fromSlot, endSlot) of one stretch: the frame on each slot is warpEvents', each
 * change on its own slot. Past endSlot it holds its last frame. A frame it returns stays valid until its next frameOn,
 * firstFrame or close. The reader owns a blended frame; source frames belong to its store.
 */
export class WarpedClipReader implements SlotReader {
  private readonly fps: number;
  private events: WarpEvents | null = null;
  private store: FrameStore | null = null;
  /** The event shown. */
  private e = -1;
  private shown: VideoSample | null = null;
  private shownIsBlend = false;
  private closed = false;

  constructor(
    private readonly map: WarpMap,
    private readonly slots: WarpSlots,
    private readonly deps: WarpedReaderDeps,
  ) {
    this.fps = slots.fps ?? FRAME_RATE;
  }

  private async ready(): Promise<{ events: WarpEvents; store: FrameStore }> {
    if (this.closed) throw new Error("The clip reader is closed");
    if (!this.events || !this.store) {
      const frames = await this.deps.frames();
      this.events = warpEvents(frames.times, this.map, this.slots);
      const scratch: BytesScratch = { buffer: null, ctx: null };
      const deps: StoreDeps = {
        samples: this.deps.samples,
        toBytes: this.deps.toBytes ?? ((sample) => copyToBytes(sample, scratch)),
        frameBytes: this.deps.frameBytes,
        signal: this.deps.signal,
      };
      this.store = this.map.warp.reverse ? new ReverseStore(frames, this.map, deps) : new ForwardStore(frames, this.map, deps);
    }
    return { events: this.events, store: this.store };
  }

  private dropShown(): void {
    if (this.shownIsBlend) this.shown?.close();
    this.shown = null;
    this.shownIsBlend = false;
  }

  private async show(events: WarpEvents, store: FrameStore, e: number): Promise<VideoSample | null> {
    if (e === this.e && this.shown) return this.shown;
    await store.prepare(events, e);
    this.dropShown();
    this.e = e;
    const a = store.get(events.a[e]);
    // The decoder gave none: the frame written before holds
    if (!a) return null;
    if (events.b[e] < 0 || !this.deps.blend) {
      this.shown = a;
      return a;
    }
    const b = store.get(events.b[e]) ?? a;
    this.shown = await this.deps.blend(a, b, events.alpha[e], events.slots[e] / this.fps, 1 / this.fps);
    this.shownIsBlend = true;
    return this.shown;
  }

  async frameOn(n: number): Promise<VideoSample | null> {
    const { events, store } = await this.ready();
    const e = eventAt(events, n);
    return e < 0 ? null : this.show(events, store, e);
  }

  async nextChangeSlot(): Promise<number> {
    const { events } = await this.ready();
    const next = this.e + 1;
    return next < events.count ? events.slots[next] : Infinity;
  }

  /** A source frame, never a blend: the one shown, or the first before anything is. */
  async firstFrame(): Promise<VideoSample | null> {
    const { events, store } = await this.ready();
    if (events.count === 0) return null;
    const e = Math.max(0, this.e);
    await store.prepare(events, e);
    return store.get(events.a[e]);
  }

  /**
   * Writes [n0, n1) through: the frame on n0, then each change, each as a clone at slot / fps lasting until the next
   * change or n1, closed after write. No slot is written twice and no frame repeated: a hold is the frame's duration.
   */
  async passThrough(n0: number, n1: number, write: (sample: VideoSample, slot: number) => Promise<void>): Promise<void> {
    if (!(n0 < n1)) return;
    let slot = n0;
    let sample = await this.frameOn(n0);
    for (;;) {
      const next = await this.nextChangeSlot();
      if (sample) {
        const copy = sample.clone();
        try {
          copy.setTimestamp(slot / this.fps);
          // The muxer replaces a duration by the gap to the next frame: this one counts only for the file's last frame
          copy.setDuration((Math.min(next, n1) - slot) / this.fps);
          await write(copy, slot);
        } finally {
          copy.close();
        }
      }
      if (next >= n1) return;
      slot = next;
      sample = await this.frameOn(next);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.dropShown();
    await this.store?.close();
  }
}

/** A reader over the track's own decoder: one VideoSampleSink per reader. */
export function openWarpedReader(
  track: InputVideoTrack,
  map: WarpMap,
  slots: WarpSlots,
  opts: Pick<WarpedReaderDeps, "frames" | "frameBytes" | "blend" | "signal">,
): WarpedClipReader {
  const sink = new VideoSampleSink(track);
  return new WarpedClipReader(map, slots, { ...opts, samples: (from, to) => sink.samples(from, to) });
}
