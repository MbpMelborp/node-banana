import { describe, it, expect, vi, beforeEach, beforeAll, afterEach, type Mock } from "vitest";
import { checkEncoderSupport, stitchVideosAsync } from "../useStitchVideos";
import type { ClipWarp, StitchAudioClip } from "@/types";
import { splitAudioClipAt } from "@/lib/stitch/audioClips";
import type { StitchAudioClipInput, StitchOverlayInput } from "@/lib/stitch/engineTypes";
import { createTextOverlay } from "@/lib/stitch/overlays";
import { buildEnvelope } from "@/lib/stitch/placement";
import { pictureSegments, unitSlots, visibilityRuns } from "@/lib/stitch/placedSchedule";
import { normalizeWarp, SOUND_MIN_SPEED, splitWarp, warpMap, type WarpMap } from "@/lib/stitch/warp";
import { warpSoundMargin } from "@/lib/stitch/warpAudio";
import { pickFrame, reverseChunkFrames, warpSlotTime } from "@/lib/stitch/warpFrames";

/** The mixer as it is, with its two format choices watched. */
const mix = vi.hoisted(() => ({ chooseMasterFormat: vi.fn(), chooseLayerMasterFormat: vi.fn() }));
vi.mock("@/lib/stitch/audioMix", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stitch/audioMix")>();
  mix.chooseMasterFormat.mockImplementation(actual.chooseMasterFormat);
  mix.chooseLayerMasterFormat.mockImplementation(actual.chooseLayerMasterFormat);
  return { ...actual, chooseMasterFormat: mix.chooseMasterFormat, chooseLayerMasterFormat: mix.chooseLayerMasterFormat };
});

// ---- AudioBuffer polyfill for jsdom ----
class MockAudioBuffer {
  readonly sampleRate: number;
  readonly length: number;
  readonly duration: number;
  readonly numberOfChannels: number;
  private channels: Float32Array[];

  constructor(options: { length: number; numberOfChannels: number; sampleRate: number }) {
    this.length = options.length;
    this.numberOfChannels = options.numberOfChannels;
    this.sampleRate = options.sampleRate;
    this.duration = options.length / options.sampleRate;
    this.channels = Array.from({ length: options.numberOfChannels }, () => new Float32Array(options.length));
  }
  getChannelData(channel: number): Float32Array { return this.channels[channel]; }
  copyFromChannel() {}
  copyToChannel() {}
}

beforeAll(() => {
  if (typeof globalThis.AudioBuffer === "undefined") {
    (globalThis as unknown as { AudioBuffer: unknown }).AudioBuffer = MockAudioBuffer;
  }
});

// Mock mediabunny with proper class constructors
const mockCanEncodeVideo = vi.fn();
const mockGetVideoTracks = vi.fn();
const mockGetAudioTracks = vi.fn();
const mockDispose = vi.fn();
const mockOutputStart = vi.fn().mockResolvedValue(undefined);
const mockOutputFinalize = vi.fn().mockResolvedValue(undefined);
const mockVideoSourceAdd = vi.fn().mockResolvedValue(undefined);
const mockVideoSourceClose = vi.fn().mockResolvedValue(undefined);
const mockAddVideoTrack = vi.fn();
const mockAddAudioTrack = vi.fn();
const mockAudioSourceAdd = vi.fn().mockResolvedValue(undefined);
const mockAudioSourceClose = vi.fn().mockResolvedValue(undefined);
const mockGetFirstEncodableAudioCodec = vi.fn();
const mockOutputCancel = vi.fn().mockResolvedValue(undefined);
/** The stacked engine's frame blending, mocked: jsdom has no VideoFrame or canvas. */
const mockEncodeDissolve = vi.fn().mockResolvedValue(undefined);
const mockEncodeDissolveFrames = vi.fn().mockResolvedValue(undefined);
const mockCreateFrameBlender = vi.fn(() => ({ blend: vi.fn() }));
const mockBufferTargetBuffer = new ArrayBuffer(100);

/** A clone a placed encode passed through: its source frame's time and where it was put. */
interface CloneRecord {
  sourceTimestamp: number;
  setTimestamp: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}
/**
 * Each `samples(start, end)` call, the setTimestamp spy of every frame it yielded, the clones made of them, every
 * frame's close spy, and whether the decoder was stopped (return() or its end).
 */
const sampleCalls: Array<{
  track: unknown;
  start: number;
  end: number;
  setTimestamp: ReturnType<typeof vi.fn>[];
  clones: CloneRecord[];
  closes: ReturnType<typeof vi.fn>[];
  stopped: boolean;
}> = [];
/** The frame timestamps a video track yields for samples(start, end); one frame at `start` by default. */
let frameTimestamps: (track: unknown, start: number, end: number) => number[] = (_track, start) => [start];
/** Each `buffers(start, end)` call on an audio track. */
const bufferCalls: Array<{ track: unknown; start: number; end: number }> = [];
/** Every VideoSample made from bytes (a retimed clip's kept frames), to check that each is closed. */
const byteSamples: Array<{ init: Record<string, unknown>; close: ReturnType<typeof vi.fn> }> = [];
/** Each packet lookup on a video track that lists its frames: the method and the track. */
const packetCalls: Array<{ method: string; track: unknown }> = [];

type Fn = (...args: unknown[]) => unknown;

vi.mock("mediabunny", () => {
  class BlobSourceMock {
    blob: Blob;
    constructor(blob: Blob) {
      this.blob = blob;
    }
  }
  class InputMock {
    getVideoTracks: Fn;
    getAudioTracks: Fn;
    computeDuration: Fn;
    dispose: Fn;
    constructor(options: { source: BlobSourceMock }) {
      const blob = options.source.blob;
      this.getVideoTracks = () => mockGetVideoTracks(blob);
      this.getAudioTracks = () => mockGetAudioTracks(blob);
      this.computeDuration = vi.fn().mockResolvedValue(1.0);
      this.dispose = (...args) => mockDispose(...args);
    }
  }
  class OutputMock {
    addVideoTrack: Fn = (...args) => mockAddVideoTrack(...args);
    addAudioTrack: Fn = (...args) => mockAddAudioTrack(...args);
    start: Fn = (...args) => mockOutputStart(...args);
    finalize: Fn = (...args) => mockOutputFinalize(...args);
    cancel: Fn = (...args) => mockOutputCancel(...args);
  }
  class VideoSampleSinkMock {
    samples: (start: number, end: number) => AsyncIterable<unknown>;
    constructor(track: unknown) {
      this.samples = vi.fn((start: number, end: number) => {
        const call = {
          track,
          start,
          end,
          setTimestamp: [] as ReturnType<typeof vi.fn>[],
          clones: [] as CloneRecord[],
          closes: [] as ReturnType<typeof vi.fn>[],
          stopped: false,
        };
        sampleCalls.push(call);
        const timestamps = frameTimestamps(track, start, end);
        return {
          [Symbol.asyncIterator]: async function* () {
            const { codedWidth, codedHeight, format, colorSpace, failAt } = track as {
              codedWidth?: number;
              codedHeight?: number;
              format?: string;
              colorSpace?: unknown;
              failAt?: number;
            };
            try {
              for (const timestamp of timestamps) {
                if (failAt !== undefined && timestamp >= failAt) throw new Error("decoder broke");
                const setTimestamp = vi.fn();
                call.setTimestamp.push(setTimestamp);
                const close = vi.fn();
                call.closes.push(close);
                const clone = () => {
                  const record = { sourceTimestamp: timestamp, setTimestamp: vi.fn(), close: vi.fn() };
                  call.clones.push(record);
                  return { timestamp, codedWidth, codedHeight, format, colorSpace, rotation: 0, setDuration: vi.fn(), ...record };
                };
                const size = (codedWidth ?? 0) * (codedHeight ?? 0);
                yield {
                  timestamp,
                  codedWidth,
                  codedHeight,
                  format,
                  colorSpace,
                  rotation: 0,
                  duration: 1 / 24,
                  allocationSize: () => size * 1.5,
                  // Not a spy: a spy per decoded frame makes every encode here a fifth slower, and nothing asserts on it
                  copyTo: async () => [
                    { offset: 0, stride: codedWidth },
                    { offset: size, stride: codedWidth },
                  ],
                  setTimestamp,
                  setDuration: vi.fn(),
                  close,
                  clone,
                };
              }
            } finally {
              call.stopped = true;
            }
          },
        };
      });
    }
  }
  /**
   * Yields one buffer from `start` to 0.1 s past `end` (a real decoder returns whole frames, so its last buffer
   * runs past the range asked for), every sample at the track's `level` (or, given a function, its level at that
   * sample's source time), in the track's decoded format (its container's unless `decoded` says otherwise); throws
   * when `fails`.
   */
  class AudioBufferSinkMock {
    buffers: (start: number, end: number) => AsyncIterable<unknown>;
    constructor(track: {
      sampleRate: number;
      numberOfChannels: number;
      level: number | ((t: number) => number);
      fails?: boolean;
      decoded?: { sampleRate: number; numberOfChannels: number };
    }) {
      this.buffers = (start: number, end: number) => {
        bufferCalls.push({ track, start, end });
        return {
          [Symbol.asyncIterator]: async function* () {
            if (track.fails) throw new Error("decode failed");
            const { sampleRate, numberOfChannels } = track.decoded ?? track;
            const timestamp = Math.max(0, start);
            const length = Math.round((end + 0.1 - timestamp) * sampleRate);
            const buffer = new MockAudioBuffer({ length, numberOfChannels, sampleRate });
            const { level } = track;
            for (let c = 0; c < numberOfChannels; c++) {
              const data = buffer.getChannelData(c);
              if (typeof level === "number") data.fill(level);
              else for (let j = 0; j < length; j++) data[j] = level(timestamp + j / sampleRate);
            }
            yield { buffer, timestamp, duration: length / sampleRate };
          },
        };
      };
    }
  }
  /**
   * The track's `lastPacket` for getPacket(Infinity), or none; at a time, the packet in effect among `packetTimes`.
   * A track that lists its `frames` (presentation times, decode order the same) and `keys` (frame indices) answers
   * the frame list's lookups from them.
   */
  class EncodedPacketSinkMock {
    getPacket: (timestamp: number) => Promise<unknown>;
    getKeyPacket: (timestamp: number) => Promise<unknown>;
    getFirstPacket: () => Promise<unknown>;
    getNextPacket: (packet: { sequenceNumber: number }) => Promise<unknown>;
    constructor(track: { lastPacket?: unknown; packetTimes?: number[]; frames?: number[]; keys?: number[] }) {
      const packet = (j: number) =>
        track.frames && j >= 0 && j < track.frames.length
          ? { timestamp: track.frames[j], duration: 1 / 24, type: (track.keys ?? [0]).includes(j) ? "key" : "delta", sequenceNumber: j }
          : null;
      const lastAtOrBefore = (timestamp: number, keysOnly: boolean) =>
        packet((track.frames ?? []).findLastIndex((t, j) => t <= timestamp && (!keysOnly || (track.keys ?? [0]).includes(j))));
      this.getPacket = async (timestamp: number) => {
        if (timestamp === Infinity) return track.lastPacket ?? null;
        if (track.frames) {
          packetCalls.push({ method: "getPacket", track });
          return lastAtOrBefore(timestamp, false);
        }
        const at = track.packetTimes?.filter((t) => t <= timestamp).pop();
        return at === undefined ? null : { timestamp: at, duration: 0 };
      };
      this.getKeyPacket = async (timestamp: number) => {
        packetCalls.push({ method: "getKeyPacket", track });
        return lastAtOrBefore(timestamp, true);
      };
      this.getFirstPacket = async () => packet(0);
      this.getNextPacket = async (previous) => packet(previous.sequenceNumber + 1);
    }
  }
  /** A frame made from bytes or a canvas: its init, with the spies the encode calls. */
  class VideoSampleMock {
    init: Record<string, unknown>;
    timestamp: number;
    sourceTimestamp: number;
    codedWidth: unknown;
    codedHeight: unknown;
    format: unknown;
    rotation: unknown;
    colorSpace: unknown;
    setTimestamp = vi.fn();
    setDuration = vi.fn();
    setRotation = vi.fn();
    close = vi.fn();
    constructor(_data: unknown, init: Record<string, unknown>) {
      this.init = init;
      this.timestamp = init.timestamp as number;
      this.sourceTimestamp = init.timestamp as number;
      this.codedWidth = init.codedWidth;
      this.codedHeight = init.codedHeight;
      this.format = init.format;
      this.rotation = init.rotation ?? 0;
      this.colorSpace = init.colorSpace;
      byteSamples.push(this);
    }
    clone() {
      return new VideoSampleMock(null, this.init);
    }
    allocationSize() {
      return (this.codedWidth as number) * (this.codedHeight as number) * 1.5;
    }
    async copyTo() {
      return [];
    }
  }
  class VideoSampleSourceMock {
    add: Fn = (...args) => mockVideoSourceAdd(...args);
    close: Fn = (...args) => mockVideoSourceClose(...args);
  }
  class AudioBufferSourceMock {
    add: Fn = (...args) => mockAudioSourceAdd(...args);
    close: Fn = (...args) => mockAudioSourceClose(...args);
  }
  class BufferTargetMock {
    get buffer() { return mockBufferTargetBuffer; }
  }
  class Mp4OutputFormatMock { constructor() {} }

  return {
    BlobSource: BlobSourceMock,
    Input: InputMock,
    Output: OutputMock,
    VideoSampleSink: VideoSampleSinkMock,
    VideoSampleSource: VideoSampleSourceMock,
    AudioBufferSink: AudioBufferSinkMock,
    EncodedPacketSink: EncodedPacketSinkMock,
    VideoSample: VideoSampleMock,
    AudioBufferSource: AudioBufferSourceMock,
    BufferTarget: BufferTargetMock,
    Mp4OutputFormat: Mp4OutputFormatMock,
    ALL_FORMATS: [],
    canEncodeVideo: (...args: unknown[]) => mockCanEncodeVideo(...args),
    getFirstEncodableAudioCodec: (...args: unknown[]) => mockGetFirstEncodableAudioCodec(...args),
  };
});

/** The real module (warpReader takes its packedSize) with its frame work mocked; a times side records its times. */
vi.mock("@/lib/stitch/crossfadeFrames", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stitch/crossfadeFrames")>()),
  encodeDissolve: (...args: unknown[]) => mockEncodeDissolve(...args),
  encodeDissolveFrames: (...args: unknown[]) => mockEncodeDissolveFrames(...args),
  createFrameBlender: (...args: unknown[]) => mockCreateFrameBlender(...(args as [])),
  timesSide: (track: unknown, times: number[]) => ({
    kind: "times",
    track,
    times,
    frameOn: vi.fn(async () => null),
    close: vi.fn(async () => {}),
  }),
}));

/** The overlay pass, mocked: jsdom has no canvas. Each test that renders overlays gives it a recording writer. */
const mockCreateOverlayWriter = vi.fn();
vi.mock("@/lib/stitch/overlayFrames", () => ({
  createOverlayWriter: (...args: unknown[]) => mockCreateOverlayWriter(...args),
}));

vi.mock("@/lib/video-encoding", () => ({
  createAvcEncodingConfig: vi.fn(() => ({})),
  AVC_LEVEL_4_0: "avc1.640028",
  AVC_LEVEL_5_1: "avc1.640033",
}));

describe("useStitchVideos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sampleCalls.length = 0;
    bufferCalls.length = 0;
    byteSamples.length = 0;
    packetCalls.length = 0;
    frameTimestamps = (_track, start) => [start];
    mockGetAudioTracks.mockResolvedValue([]);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  describe("checkEncoderSupport", () => {
    it("returns true when canEncodeVideo resolves true", async () => {
      mockCanEncodeVideo.mockResolvedValue(true);
      expect(await checkEncoderSupport()).toBe(true);
    });

    it("returns false when canEncodeVideo resolves false", async () => {
      mockCanEncodeVideo.mockResolvedValue(false);
      expect(await checkEncoderSupport()).toBe(false);
    });

    it("returns false when canEncodeVideo throws", async () => {
      mockCanEncodeVideo.mockRejectedValue(new Error("Not supported"));
      expect(await checkEncoderSupport()).toBe(false);
    });

    it("checks with correct parameters", async () => {
      mockCanEncodeVideo.mockResolvedValue(true);
      await checkEncoderSupport();
      expect(mockCanEncodeVideo).toHaveBeenCalledWith("avc", {
        width: 1920,
        height: 1080,
        bitrate: 8_000_000,
      });
    });
  });

  describe("stitchVideosAsync", () => {
    const createMockVideoTrack = (width = 1920, height = 1080, rotation = 0, duration = 1.0, firstTimestamp = 0) => ({
      displayWidth: width,
      displayHeight: height,
      codedWidth: width,
      codedHeight: height,
      rotation,
      computePacketStats: vi.fn().mockResolvedValue({ averageBitrate: 8_000_000 }),
      computeDuration: vi.fn().mockResolvedValue(duration),
      getFirstTimestamp: vi.fn().mockResolvedValue(firstTimestamp),
    });

    beforeEach(() => {
      mockCanEncodeVideo.mockResolvedValue(true);
      mockGetVideoTracks.mockResolvedValue([createMockVideoTrack()]);
    });

    it("throws when given empty array", async () => {
      await expect(stitchVideosAsync([])).rejects.toThrow("No videos to render");
    });

    it("reports progress updates", async () => {
      const onProgress = vi.fn();
      const blob = new Blob(["video1"], { type: "video/mp4" });
      await stitchVideosAsync([blob], null, onProgress);

      expect(onProgress).toHaveBeenCalled();
      const statuses = onProgress.mock.calls.map((c: Array<{ status: string }>) => c[0].status);
      expect(statuses).toContain("processing");
      expect(statuses).toContain("complete");
    });

    it("returns a video/mp4 Blob", async () => {
      const blob = new Blob(["video1"], { type: "video/mp4" });
      const result = await stitchVideosAsync([blob]);
      expect(result).toBeInstanceOf(Blob);
      expect(result.type).toBe("video/mp4");
    });

    it("processes multiple video blobs", async () => {
      const blob1 = new Blob(["video1"], { type: "video/mp4" });
      const blob2 = new Blob(["video2"], { type: "video/mp4" });
      const result = await stitchVideosAsync([blob1, blob2]);
      expect(result).toBeInstanceOf(Blob);
    });

    it("reports error status on failure", async () => {
      mockCanEncodeVideo.mockResolvedValue(false);
      const onProgress = vi.fn();
      const blob = new Blob(["video"], { type: "video/mp4" });

      await expect(stitchVideosAsync([blob], null, onProgress)).rejects.toThrow();

      const lastCall = onProgress.mock.calls[onProgress.mock.calls.length - 1];
      if (lastCall) {
        expect(lastCall[0].status).toBe("error");
      }
    });

    it("handles audio data when provided", async () => {
      mockGetFirstEncodableAudioCodec.mockResolvedValue("aac");

      const videoBlob = new Blob(["video"], { type: "video/mp4" });
      const audioBuffer = new MockAudioBuffer({ length: 44100, numberOfChannels: 1, sampleRate: 44100 });
      const audioData = { buffer: audioBuffer as unknown as AudioBuffer, duration: 1.0 };

      await stitchVideosAsync([videoBlob], audioData);

      expect(mockGetFirstEncodableAudioCodec).toHaveBeenCalled();
      expect(mockAddAudioTrack).toHaveBeenCalled();
    });

    it("continues without audio when no codec is supported", async () => {
      mockGetFirstEncodableAudioCodec.mockResolvedValue(null);

      const videoBlob = new Blob(["video"], { type: "video/mp4" });
      const audioBuffer = new MockAudioBuffer({ length: 44100, numberOfChannels: 1, sampleRate: 44100 });

      const result = await stitchVideosAsync([videoBlob], {
        buffer: audioBuffer as unknown as AudioBuffer,
        duration: 1.0,
      });

      expect(result).toBeInstanceOf(Blob);
      expect(mockAddAudioTrack).not.toHaveBeenCalled();
    });

    it("probes video metadata before encoding", async () => {
      const blob = new Blob(["video"], { type: "video/mp4" });
      await stitchVideosAsync([blob]);
      expect(mockGetVideoTracks).toHaveBeenCalled();
    });

    it("checks encoder support for target resolution", async () => {
      const blob = new Blob(["video"], { type: "video/mp4" });
      await stitchVideosAsync([blob]);
      expect(mockCanEncodeVideo).toHaveBeenCalled();
    });

    describe("the timeline", () => {
      const SR = 1000;
      /** Per blob: its video track (duration, first timestamp) and its sound (a constant level), or none. */
      const sources = new Map<Blob, { video: ReturnType<typeof createMockVideoTrack>; audio: unknown[] }>();

      function source(
        name: string,
        opts: {
          duration?: number;
          firstTimestamp?: number;
          /** The track's average packet rate; unknown by default. */
          frameRate?: number;
          /**
           * Lists the track's frames (j / fps) and key frames for a retimed clip's frame list, its frames 4 × 2 NV12
           * unless sized, so they are kept as bytes.
           */
          fps?: number;
          keys?: number[];
          width?: number;
          height?: number;
          /** The sound's level, or its level at a source time; null for no sound. */
          level?: number | ((t: number) => number) | null;
          sampleRate?: number;
          fails?: boolean;
          decoded?: { sampleRate: number; numberOfChannels: number };
        } = {},
      ): Blob {
        const blob = new Blob([name], { type: "video/mp4" });
        const level = opts.level === undefined ? 0.5 : opts.level;
        const video = createMockVideoTrack(opts.width ?? 1920, opts.height ?? 1080, 0, opts.duration ?? 1, opts.firstTimestamp ?? 0);
        if (opts.frameRate !== undefined) {
          video.computePacketStats.mockResolvedValue({ averageBitrate: 8_000_000, averagePacketRate: opts.frameRate });
        }
        if (opts.fps !== undefined) {
          const count = Math.round((opts.duration ?? 1) * opts.fps);
          Object.assign(video, {
            frames: Array.from({ length: count }, (_, j) => j / opts.fps!),
            keys: opts.keys ?? [0],
            format: "NV12",
            codedWidth: opts.width ?? 4,
            codedHeight: opts.height ?? 2,
          });
        }
        sources.set(blob, {
          video,
          audio:
            level === null
              ? []
              : [
                  {
                    sampleRate: opts.sampleRate ?? SR,
                    numberOfChannels: 1,
                    level,
                    fails: opts.fails,
                    decoded: opts.decoded,
                    canDecode: vi.fn().mockResolvedValue(true),
                  },
                ],
        });
        return blob;
      }

      /** Every buffer handed to the audio track. */
      const encodedBuffers = (): MockAudioBuffer[] => mockAudioSourceAdd.mock.calls.map((call: unknown[]) => call[0] as MockAudioBuffer);

      const clip = (
        blob: Blob,
        overrides: Partial<{ inSec: number; outSec: number | null; muted: boolean; volume: number; source: string; warp: ClipWarp }> = {},
      ) => ({
        blob,
        inSec: 0,
        outSec: null,
        muted: false,
        volume: 1,
        ...overrides,
      });

      /** Every sample handed to the audio track, in order, first channel. */
      const encodedSound = (): number[] =>
        mockAudioSourceAdd.mock.calls.flatMap((call: unknown[]) => [...(call[0] as MockAudioBuffer).getChannelData(0)]);

      const firstSetTimestamps = () => sampleCalls.map((call) => call.setTimestamp[0]?.mock.calls[0]?.[0]);

      beforeEach(() => {
        sources.clear();
        mockGetFirstEncodableAudioCodec.mockResolvedValue("aac");
        mockGetVideoTracks.mockImplementation(async (blob: Blob) => (sources.has(blob) ? [sources.get(blob)!.video] : []));
        mockGetAudioTracks.mockImplementation(async (blob: Blob) => sources.get(blob)?.audio ?? []);
        // 24 fps: the frame in effect at `start`, then every frame before `end`
        frameTimestamps = (_track, start, end) => {
          const out: number[] = [];
          for (let i = Math.floor(start * 24 + 1e-9); i / 24 < end; i++) out.push(i / 24);
          return out;
        };
      });

      it("decodes each clip from In to Out, or to its video's end", async () => {
        const a = source("a", { duration: 4 });
        await stitchVideosAsync([clip(a, { inSec: 0.5 }), clip(a, { inSec: 1, outSec: 2 })]);
        expect(sampleCalls.map(({ start, end }) => [start, end])).toEqual([
          [0.5, 4],
          [1, 2],
        ]);
      });

      it("starts the second clip where the first one's trimmed length ends", async () => {
        const a = source("a", { duration: 4 });
        const b = source("b", { duration: 3 });
        await stitchVideosAsync([clip(a, { inSec: 1, outSec: 3 }), clip(b)]);
        expect(firstSetTimestamps()).toEqual([0, 2]);
      });

      it("plays every clip again for each loop, a loop's length later", async () => {
        const a = source("a", { duration: 2 });
        const b = source("b", { duration: 1 });
        await stitchVideosAsync([clip(a), clip(b)], null, undefined, undefined, { loopCount: 2 });
        expect(sampleCalls).toHaveLength(4);
        expect(sampleCalls.map((call) => call.track)).toEqual([
          sources.get(a)!.video,
          sources.get(b)!.video,
          sources.get(a)!.video,
          sources.get(b)!.video,
        ]);
        expect(firstSetTimestamps()).toEqual([0, 2, 3, 5]);
      });

      it("probes a source once however many clips play it", async () => {
        const a = source("a", { duration: 4 });
        await stitchVideosAsync([clip(a, { outSec: 1 }), clip(a, { inSec: 1 })], null, undefined, undefined, { loopCount: 3 });
        expect(mockGetVideoTracks).toHaveBeenCalledTimes(1);
      });

      it("leaves a muted clip's sound out", async () => {
        const a = source("a", { level: 0.5 });
        const b = source("b", { level: 0.5 });
        await stitchVideosAsync([clip(a, { muted: true }), clip(b)]);
        const sound = encodedSound();
        expect(sound).toHaveLength(2 * SR);
        expect(sound.slice(0, SR).every((v) => v === 0)).toBe(true);
        expect(sound.slice(SR).every((v) => Math.abs(v - 0.5) < 1e-6)).toBe(true);
      });

      it("plays a clip's sound at its volume", async () => {
        const a = source("a", { level: 0.5 });
        await stitchVideosAsync([clip(a, { volume: 0.5 })]);
        expect(encodedSound().every((v) => Math.abs(v - 0.25) < 1e-6)).toBe(true);
      });

      it("shapes the music with its curve", async () => {
        const a = source("a", { duration: 1, level: null });
        const music = new MockAudioBuffer({ length: SR, numberOfChannels: 1, sampleRate: SR });
        music.getChannelData(0).fill(0.5);
        // Gain is read every 128 samples, so at 1 kHz the dip is wide
        const curve = [
          { t: 0.2, gain: 1 },
          { t: 0.3, gain: 0 },
          { t: 0.7, gain: 0 },
          { t: 0.8, gain: 1 },
        ];
        await stitchVideosAsync([clip(a)], { audio: { buffer: music as unknown as AudioBuffer, duration: 1 }, curve, muted: false });
        const sound = encodedSound();
        expect(sound[100]).toBeCloseTo(0.5, 6);
        expect(sound.slice(400, 630).every((v) => v === 0)).toBe(true);
        expect(sound[900]).toBeCloseTo(0.5, 6);
      });

      it("lets bare music replace the clips' sound, as before", async () => {
        const a = source("a", { level: 0.5 });
        const music = new MockAudioBuffer({ length: SR, numberOfChannels: 1, sampleRate: SR });
        music.getChannelData(0).fill(0.25);
        await stitchVideosAsync([a], { buffer: music as unknown as AudioBuffer, duration: 1 });
        expect(bufferCalls).toHaveLength(0);
        expect(encodedSound().every((v) => Math.abs(v - 0.25) < 1e-6)).toBe(true);
      });

      it("adds no audio track when nothing is audible", async () => {
        const a = source("a", { level: null });
        const b = source("b", { level: 0.5 });
        await stitchVideosAsync([clip(a), clip(b, { muted: true })]);
        expect(mockAddAudioTrack).not.toHaveBeenCalled();
      });

      it("reads a clip's sound from its video's first timestamp and puts its first frame on the join", async () => {
        const a = source("a", { duration: 1 });
        const b = source("b", { duration: 2, firstTimestamp: 0.04 });
        frameTimestamps = (track, start, end) => {
          const first = track === sources.get(b)!.video ? 0.04 : 0;
          const out: number[] = [];
          for (let ts = Math.max(first, start); ts < end; ts += 1 / 24) out.push(ts);
          return out;
        };
        await stitchVideosAsync([clip(a), clip(b)]);
        expect(bufferCalls.find((call) => call.track === sources.get(b)!.audio[0])?.start).toBe(0.04);
        expect(firstSetTimestamps()[1]).toBe(1);
      });

      it("keeps the first frame after In over the one before it when both land on the join", async () => {
        const a = source("a", { duration: 4, level: null });
        // In is 0.035: the frame at 0 is in effect there, and the one at 1/24 is 0.0067 s after it
        await stitchVideosAsync([clip(a, { inSec: 0.035, outSec: 1.035 })]);
        const [call] = sampleCalls;
        expect(call.setTimestamp[0]).not.toHaveBeenCalled();
        expect(call.setTimestamp[1].mock.calls[0]?.[0]).toBe(0);
        expect(call.setTimestamp[2].mock.calls[0]?.[0]).toBeCloseTo(3 / 60, 9);
        // 24 frames from 1/24 to 24/24, one second of output
        expect(call.setTimestamp.slice(1).every((spy) => spy.mock.calls.length === 1)).toBe(true);
      });

      it("puts the frame before In on the join when the next one lands later", async () => {
        const a = source("a", { duration: 4, level: null });
        // In is 0.02: the frame at 1/24 is 0.022 s after it, more than half a slot
        await stitchVideosAsync([clip(a, { inSec: 0.02, outSec: 1.02 })]);
        const [call] = sampleCalls;
        expect(call.setTimestamp[0].mock.calls[0]?.[0]).toBe(0);
        expect(call.setTimestamp[1].mock.calls[0]?.[0]).toBeCloseTo(1 / 60, 9);
      });

      it("keeps a clip silent past its Out when its video starts after In", async () => {
        const a = source("a", { duration: 2, firstTimestamp: 0.04, level: 0.5 });
        await stitchVideosAsync([clip(a, { outSec: 0.5 })]);
        // The sound is read from 0.04 for 0.5 s; source time 0.5 is 0.46 s in
        expect(bufferCalls[0]).toMatchObject({ start: 0.04, end: 0.5 });
        const sound = encodedSound();
        expect(sound).toHaveLength(SR / 2);
        expect(sound.slice(0, 460).every((v) => Math.abs(v - 0.5) < 1e-6)).toBe(true);
        expect(sound.slice(460).every((v) => v === 0)).toBe(true);
      });

      it("sends the mix one loop at a time", async () => {
        const a = source("a", { level: 0.5 });
        await stitchVideosAsync([clip(a)], null, undefined, undefined, { loopCount: 3 });
        expect(mockAudioSourceAdd).toHaveBeenCalledTimes(3);
      });

      it("stops when the signal is aborted", async () => {
        const a = source("a");
        const controller = new AbortController();
        controller.abort();
        await expect(stitchVideosAsync([clip(a), clip(a)], null, undefined, controller.signal)).rejects.toMatchObject({
          name: "AbortError",
        });
        expect(mockOutputStart).not.toHaveBeenCalled();
      });

      it("restarts the music's curve each loop", async () => {
        const a = source("a", { duration: 1, level: null });
        const music = new MockAudioBuffer({ length: 2 * SR, numberOfChannels: 1, sampleRate: SR });
        music.getChannelData(0).fill(0.5);
        const curve = [
          { t: 0.2, gain: 1 },
          { t: 0.3, gain: 0 },
          { t: 0.7, gain: 0 },
          { t: 0.8, gain: 1 },
        ];
        await stitchVideosAsync([clip(a)], { audio: { buffer: music as unknown as AudioBuffer, duration: 2 }, curve, muted: false }, undefined, undefined, {
          loopCount: 2,
        });
        const sound = encodedSound();
        expect(sound).toHaveLength(2 * SR);
        expect(sound[500]).toBe(0);
        expect(sound[1500]).toBe(0);
        expect(sound[1100]).toBeCloseTo(0.5, 6);
      });

      it("converts only the part of a long song the loops play, and plays it to the last sample", async () => {
        // Clip sound at 1 kHz makes the master 1 kHz: the 750 Hz music is resampled. A copy of the whole song
        // would be counted here
        const copied: number[] = [];
        class Watched extends Float32Array {
          slice(start?: number, end?: number) {
            const out = super.slice(start, end);
            copied.push(out.length);
            return out;
          }
        }
        const data = new Watched(60 * 750).fill(0.5);
        const music = { sampleRate: 750, numberOfChannels: 1, length: data.length, duration: 60, getChannelData: () => data };
        const a = source("a", { duration: 1, level: 0 });
        await stitchVideosAsync(
          [clip(a)],
          { audio: { buffer: music as unknown as AudioBuffer, duration: 60 }, curve: [], muted: false },
          undefined,
          undefined,
          { loopCount: 3 },
        );
        expect(Math.max(0, ...copied)).toBeLessThan(10 * 750);
        const sound = encodedSound();
        expect(sound).toHaveLength(3 * SR);
        expect(sound.every((v) => Math.abs(v - 0.5) < 1e-6)).toBe(true);
      });

      it("retries the codec at 48 kHz stereo when the master format has none", async () => {
        const a = source("a", { level: 0.5 });
        mockGetFirstEncodableAudioCodec.mockImplementation(async (_codecs: unknown, config: { sampleRate: number; numberOfChannels: number }) =>
          config.sampleRate === 48000 && config.numberOfChannels === 2 ? "aac" : null,
        );
        await stitchVideosAsync([clip(a)]);
        expect(mockAddAudioTrack).toHaveBeenCalled();
        const [buffer] = encodedBuffers();
        expect(buffer.sampleRate).toBe(48000);
        expect(buffer.numberOfChannels).toBe(2);
      });

      it("leaves a clip whose sound fails to decode silent in its own place", async () => {
        const a = source("a", { level: 0.5, fails: true });
        const b = source("b", { level: 0.5 });
        await expect(stitchVideosAsync([clip(a), clip(b)])).resolves.toBeInstanceOf(Blob);
        const sound = encodedSound();
        expect(sound).toHaveLength(2 * SR);
        expect(sound.slice(0, SR).every((v) => v === 0)).toBe(true);
        expect(sound.slice(SR).every((v) => Math.abs(v - 0.5) < 1e-6)).toBe(true);
      });

      it("adds no audio track when no clip's sound decodes", async () => {
        const a = source("a", { level: 0.5, fails: true });
        await stitchVideosAsync([clip(a)]);
        expect(mockAddAudioTrack).not.toHaveBeenCalled();
      });

      it("takes the master format from the decoded sound, not the container", async () => {
        // HE-AAC v2: the container reports its core rate, mono; it decodes at twice that, stereo
        const a = source("a", { level: 0.5, sampleRate: SR / 2, decoded: { sampleRate: SR, numberOfChannels: 2 } });
        await stitchVideosAsync([clip(a)]);
        const [buffer] = encodedBuffers();
        expect(buffer.sampleRate).toBe(SR);
        expect(buffer.numberOfChannels).toBe(2);
      });

      it("keeps a clip's sound at its own rate under lower-rate music", async () => {
        const a = source("a", { level: 0.5 });
        const music = new MockAudioBuffer({ length: SR / 2, numberOfChannels: 1, sampleRate: SR / 2 });
        await stitchVideosAsync([clip(a)], { audio: { buffer: music as unknown as AudioBuffer, duration: 1 }, curve: [], muted: false });
        expect(encodedBuffers()[0].sampleRate).toBe(SR);
      });

      it("plays a last frame stored without a duration", async () => {
        const a = source("a", { duration: 119 / 24 });
        sources.get(a)!.video.computePacketStats.mockResolvedValue({ averageBitrate: 8_000_000, averagePacketRate: 24 });
        Object.assign(sources.get(a)!.video, { lastPacket: { timestamp: 119 / 24, duration: 0 } });
        await stitchVideosAsync([clip(a)]);
        expect(sampleCalls[0].end).toBeCloseTo(5, 9);
        expect(sampleCalls[0].setTimestamp).toHaveLength(120);
        expect(sampleCalls[0].setTimestamp.every((spy) => spy.mock.calls.length === 1)).toBe(true);
      });

      it("fills each clip's share of the progress at 24 fps", async () => {
        const a = source("a", { duration: 1, level: null });
        const onProgress = vi.fn();
        await stitchVideosAsync([clip(a)], null, onProgress);
        const framed = onProgress.mock.calls
          .map((call: Array<{ message: string; progress: number }>) => call[0])
          .filter((p) => p.message.includes("frames..."));
        // Frames 10 and 20 of 24: about 40% and 80% of the clip (on the 60 fps grid)
        expect(framed).toHaveLength(2);
        expect(Math.abs(framed[0].progress - (12 + (9 / 24) * 85))).toBeLessThan(1);
        expect(Math.abs(framed[1].progress - (12 + (19 / 24) * 85))).toBeLessThan(1);
      });

      it("refuses a sequence in which every clip is empty", async () => {
        const a = source("a", { duration: 2 });
        await expect(stitchVideosAsync([clip(a, { inSec: 3 })])).rejects.toThrow("Nothing to render: every clip is empty");
      });

      describe("audio clips", () => {
        /** A decoded audio file, sample i of channel c = fill(i, c). */
        function decodedAudio(sampleRate: number, seconds: number, fill: (i: number, c: number) => number, channels = 1) {
          const buffer = new MockAudioBuffer({ length: Math.round(seconds * sampleRate), numberOfChannels: channels, sampleRate });
          for (let c = 0; c < channels; c++) {
            const data = buffer.getChannelData(c);
            for (let i = 0; i < data.length; i++) data[i] = fill(i, c);
          }
          return { buffer: buffer as unknown as AudioBuffer, duration: seconds };
        }
        const layer = (audio: ReturnType<typeof decodedAudio>, init: Partial<Omit<StitchAudioClipInput, "audio">> = {}): StitchAudioClipInput => ({
          audio,
          startSec: 0,
          inSec: 0,
          outSec: null,
          curve: [],
          ...init,
        });
        const silentVideo = (seconds: number) => clip(source("v", { duration: seconds, level: null }));

        it("leaves the mixer's calls as they were without audioClips", async () => {
          const a = source("a", { level: 0.5 });
          const music = decodedAudio(SR / 2, 1, () => 0.25);
          await stitchVideosAsync([clip(a)], { audio: music, curve: [], muted: false });
          expect(mix.chooseMasterFormat).toHaveBeenCalledTimes(1);
          expect(mix.chooseMasterFormat).toHaveBeenCalledWith({ sampleRate: SR / 2, channels: 1 }, [{ sampleRate: SR, channels: 1 }]);
          expect(mix.chooseLayerMasterFormat).not.toHaveBeenCalled();
        });

        it("ignores the music argument when audioClips are given, and chooses the format from the clips' sources", async () => {
          const music = decodedAudio(SR, 1, () => 0.25);
          const tone = decodedAudio(SR, 1, () => 0.5);
          await stitchVideosAsync([silentVideo(1)], { audio: music, curve: [], muted: false }, undefined, undefined, {
            audioClips: [layer(tone)],
          });
          expect(mix.chooseMasterFormat).not.toHaveBeenCalled();
          expect(mix.chooseLayerMasterFormat).toHaveBeenCalledWith([{ sampleRate: SR, channels: 1 }], []);
          expect(encodedSound().every((v) => Math.abs(v - 0.5) < 1e-6)).toBe(true);
        });

        it("gives an audio track when every video clip is muted and one audio clip plays", async () => {
          const a = source("a", { level: 0.5 });
          const tone = decodedAudio(SR, 0.5, () => 0.5);
          await stitchVideosAsync([clip(a, { muted: true })], null, undefined, undefined, { audioClips: [layer(tone, { startSec: 0.25 })] });
          expect(mockAddAudioTrack).toHaveBeenCalled();
          const sound = encodedSound();
          expect(sound).toHaveLength(SR);
          expect(sound.slice(0, 250).every((v) => v === 0)).toBe(true);
          expect(sound.slice(250, 750).every((v) => Math.abs(v - 0.5) < 1e-6)).toBe(true);
          expect(sound.slice(750).every((v) => v === 0)).toBe(true);
        });

        it("adds no audio track for a clip that starts after the loop ends", async () => {
          const tone = decodedAudio(SR, 1, () => 0.5);
          await stitchVideosAsync([silentVideo(1)], null, undefined, undefined, { audioClips: [layer(tone, { startSec: 1.5 })] });
          expect(mockAddAudioTrack).not.toHaveBeenCalled();
        });

        it("plays the same audio each loop, cut at the loop's end", async () => {
          const tone = decodedAudio(SR, 3, (i) => (i < 1000 ? 0.5 : 0.25));
          await stitchVideosAsync([silentVideo(1)], null, undefined, undefined, { loopCount: 2, audioClips: [layer(tone, { startSec: 0.5 })] });
          const sound = encodedSound();
          expect(sound).toHaveLength(2 * SR);
          for (const loop of [0, 1]) {
            const part = sound.slice(loop * SR, (loop + 1) * SR);
            expect(part.slice(0, 500).every((v) => v === 0)).toBe(true);
            expect(part.slice(500).every((v) => Math.abs(v - 0.5) < 1e-6)).toBe(true);
          }
        });

        it("never scales the decoded buffer that split pieces share", async () => {
          const tone = decodedAudio(SR, 1, () => 0.5);
          await stitchVideosAsync([silentVideo(1)], null, undefined, undefined, {
            audioClips: [layer(tone, { outSec: 0.4, curve: [{ t: 0, gain: 0 }] }), layer(tone, { startSec: 0.4, inSec: 0.4, curve: [{ t: 0, gain: 0 }] })],
          });
          expect(tone.buffer.getChannelData(0).every((v) => v === 0.5)).toBe(true);
        });

        it("says it is mixing the audio clips", async () => {
          const onProgress = vi.fn();
          const tone = decodedAudio(SR, 1, () => 0.5);
          await stitchVideosAsync([silentVideo(1)], null, onProgress, undefined, { audioClips: [layer(tone), layer(tone, { startSec: 0.5 })] });
          const messages = onProgress.mock.calls.map((call: Array<{ message: string }>) => call[0].message);
          expect(messages).toContain("Mixing 2 audio clips...");
        });

        it("clamps two clips that overlap, and passes the touching pieces of a split through", async () => {
          const loud = decodedAudio(SR, 1, () => 0.6);
          await stitchVideosAsync([silentVideo(1)], null, undefined, undefined, { audioClips: [layer(loud), layer(loud, { startSec: 0.5 })] });
          expect(encodedSound()[750]).toBe(1);
          mockAudioSourceAdd.mockClear();
          const over = decodedAudio(SR, 1, () => 1.2);
          await stitchVideosAsync([silentVideo(1)], null, undefined, undefined, {
            audioClips: [layer(over, { outSec: 0.5 }), layer(over, { startSec: 0.5, inSec: 0.5 })],
          });
          expect(encodedSound().every((v) => Math.abs(v - 1.2) < 1e-6)).toBe(true);
        });

        // P4: a split changes no sample, with a curve that is not flat, a cut off the 128-sample grid, any rates
        describe("a split changes no sample (P4)", () => {
          const curve = [
            { t: 0.5, gain: 0 },
            { t: 1.5, gain: 1 },
            { t: 2.2, gain: 1 },
            { t: 2.5, gain: 0.2 },
            { t: 2.8, gain: 1 },
          ];
          const whole: StitchAudioClip = {
            id: "a",
            source: { kind: "music" },
            row: 0,
            startSec: 2.0123,
            inSec: 0.5,
            outSec: null,
            muted: false,
            curve,
          };
          for (const [name, rate] of [["48 kHz", 48000], ["44.1 kHz into a 48 kHz master", 44100]] as const) {
            it(name, async () => {
              const song = decodedAudio(rate, 4, (i, c) => Math.sin(i * 0.037 + c) * 0.4, 2);
              const pieces = splitAudioClipAt([whole], new Map([["music", 4]]), "a", 3.77777, "b")!.clips.map((piece, row) => ({ ...piece, row }));
              expect(pieces).toHaveLength(2);
              expect(Math.round(pieces[1].inSec * 48000) % 128).not.toBe(0);
              const asInput = (c: StitchAudioClip) => layer(song, { startSec: c.startSec, inSec: c.inSec, outSec: c.outSec, curve: c.curve });
              // Clip sound at 48 kHz (silent) makes the master 48 kHz whatever the song's rate
              const video = () => clip(source("v", { duration: 6, level: 0, sampleRate: 48000 }));
              await stitchVideosAsync([video()], null, undefined, undefined, { audioClips: [asInput(whole)] });
              const one = encodedSound();
              const [buffer] = encodedBuffers();
              expect(buffer.sampleRate).toBe(48000);
              mockAudioSourceAdd.mockClear();
              await stitchVideosAsync([video()], null, undefined, undefined, { audioClips: pieces.map(asInput) });
              const two = encodedSound();
              expect(two).toHaveLength(one.length);
              expect(one.some((v) => v !== 0)).toBe(true);
              let differing = 0;
              for (let i = 0; i < one.length; i++) if (one[i] !== two[i]) differing++;
              expect(differing).toBe(0);
            });
          }
        });
      });

      describe("stacked", () => {
        interface DissolveCall {
          outgoing: unknown;
          incoming: unknown;
          timestamps: number[];
          outgoingTimes: number[];
          incomingTimes: number[];
          alphas: number[];
          frameDuration: number;
        }
        const dissolves = (): DissolveCall[] => mockEncodeDissolve.mock.calls.map((call: unknown[]) => call[0] as DissolveCall);
        const ranges = () => sampleCalls.map(({ start, end }) => [start, end]);
        /** Each solo run: its track and where its first frame landed. */
        const starts = () => sampleCalls.map((call) => call.setTimestamp[0]?.mock.calls[0]?.[0]);
        /** Every timestamp handed to the encoder, pass-through and blended, in order. */
        const encodedTimestamps = () =>
          mockVideoSourceAdd.mock.calls.map((call: unknown[]) => {
            const sample = call[0] as { timestamp: number; setTimestamp?: ReturnType<typeof vi.fn> };
            return sample.setTimestamp ? (sample.setTimestamp.mock.calls[0]?.[0] as number) : sample.timestamp;
          });
        const stacked = (overlapSec: number, crossfade = true, loopCount = 1) => ({ loopCount, overlapSec, crossfade });
        const near = (actual: number, expected: number) => expect(actual).toBeCloseTo(expected, 3);

        beforeEach(() => {
          // Hands each blended frame to the encoder, as the real one does
          mockEncodeDissolve.mockImplementation(
            async (job: DissolveCall, _blenderFor: unknown, add: (sample: unknown) => Promise<void>) => {
              for (const timestamp of job.timestamps) await add({ timestamp, codedWidth: 0, codedHeight: 0 });
            },
          );
        });

        it("Track: no dissolve, and one source's overs pass unclipped", async () => {
          const a = source("a", { duration: 1, level: 1.2 });
          await stitchVideosAsync([clip(a)], null, undefined, undefined, { loopCount: 1 });
          expect(mockEncodeDissolve).not.toHaveBeenCalled();
          expect(encodedSound()[500]).toBeCloseTo(1.2, 6);
        });

        it("runs a stack whose joins are all cuts exactly as Track", async () => {
          const record = async (options?: Parameters<typeof stitchVideosAsync>[4], sameSource = false) => {
            sampleCalls.length = 0;
            mockAudioSourceAdd.mockClear();
            sources.clear();
            const a = source("a", { duration: 5, level: 0.5 });
            const b = source("b", { duration: 5, level: 0.25 });
            await stitchVideosAsync(
              [clip(a, { source: "edge:x" }), clip(b, { source: sameSource ? "edge:x" : "edge:y" })],
              null,
              undefined,
              undefined,
              options,
            );
            return {
              calls: sampleCalls.map((call) => [call.start, call.end, call.setTimestamp.map((spy) => spy.mock.calls)]),
              sound: encodedSound(),
            };
          };
          const track = await record({ loopCount: 2 });
          // The same source on both sides, and an overlap shorter than one output frame
          for (const [options, sameSource] of [
            [stacked(1, true, 2), true],
            [stacked(0.01, true, 2), false],
          ] as const) {
            const result = await record(options, sameSource);
            expect(result.calls).toEqual(track.calls);
            expect(result.sound).toEqual(track.sound);
          }
          expect(mockEncodeDissolve).not.toHaveBeenCalled();
        });

        it("crossfade off: the later clip starts under the earlier one, heard but not seen", async () => {
          const a = source("a", { duration: 5, frameRate: 24, level: 0.7 });
          const b = source("b", { duration: 5, frameRate: 24, level: 0.6 });
          await stitchVideosAsync([clip(a, { source: "a" }), clip(b, { source: "b" })], null, undefined, undefined, stacked(1, false, 2));
          expect(mockEncodeDissolve).not.toHaveBeenCalled();
          expect(ranges()).toEqual([
            [0, 5],
            [1, 5],
            [0, 5],
            [1, 5],
          ]);
          expect(starts()).toEqual([0, 5, 9, 14]);
          const sound = encodedSound();
          expect(sound).toHaveLength(18 * SR);
          near(sound[Math.round(3.5 * SR)], 0.7);
          // Both at full volume through the overlap, summed and clamped
          expect(sound[Math.round(4.5 * SR)]).toBe(1);
          near(sound[Math.round(6 * SR)], 0.6);
          // B's sound starts at its sequence start, a second before its picture
          expect(sound[Math.round(4 * SR) - 1]).toBeCloseTo(0.7, 6);
          expect(sound[Math.round(4 * SR)]).toBe(1);
        });

        it("crossfade on, both at 24 fps: one dissolve at A's own frame times, and the solo windows around it", async () => {
          const a = source("a", { duration: 5, frameRate: 24, level: null });
          const b = source("b", { duration: 5, frameRate: 24, level: null });
          await stitchVideosAsync([clip(a, { source: "a" }), clip(b, { source: "b" })], null, undefined, undefined, stacked(1));
          expect(ranges()).toEqual([
            [0, 4],
            [1, 5],
          ]);
          expect(starts()).toEqual([0, 5]);
          const [d] = dissolves();
          expect(dissolves()).toHaveLength(1);
          expect(d.outgoing).toBe(sources.get(a)!.video);
          expect(d.incoming).toBe(sources.get(b)!.video);
          expect(d.timestamps).toHaveLength(24);
          // A's frames 96..119 land where the slotter would put them
          const expected = Array.from({ length: 24 }, (_, i) => Math.floor(((96 + i) / 24) * 60 + 0.5 + 1e-6) / 60);
          expect(d.timestamps).toEqual(expected);
          expect(d.timestamps[0]).toBe(4);
          expect(d.timestamps[23]).toBeCloseTo(298 / 60, 9);
          expect(d.outgoingTimes[0]).toBeCloseTo(4 + 1 / 48, 9);
          // B's frames 0..23 at their mid-frame times: frame 24 is the first its solo window shows
          d.incomingTimes.forEach((t, k) => expect(t).toBeCloseTo(k / 24 + 1 / 48, 9));
          expect(d.alphas[0]).toBeCloseTo(0.5 / 24, 9);
          expect(d.frameDuration).toBe(1 / 60);
        });

        it("crossfade on at mixed rates: every output slot of the overlap", async () => {
          const a = source("a", { duration: 5, frameRate: 24, level: null });
          const b = source("b", { duration: 5, frameRate: 30, level: null });
          await stitchVideosAsync([clip(a, { source: "a" }), clip(b, { source: "b" })], null, undefined, undefined, stacked(1));
          const [d] = dissolves();
          expect(d.timestamps).toHaveLength(60);
          expect(d.timestamps[0]).toBe(4);
          expect(d.timestamps[59]).toBeCloseTo(4 + 59 / 60, 9);
        });

        it("crossfade on, two one-frame stills (0.2 fps): every output slot, not a cut", async () => {
          const a = source("a", { duration: 5, frameRate: 0.2, level: null });
          const b = source("b", { duration: 5, frameRate: 0.2, level: null });
          await stitchVideosAsync([clip(a, { source: "a" }), clip(b, { source: "b" })], null, undefined, undefined, stacked(1));
          const [d] = dissolves();
          expect(d.timestamps).toHaveLength(60);
          expect(d.timestamps[0]).toBe(4);
        });

        it("crossfade on, last frames stored without a duration: the cadence is the real 24 fps", async () => {
          const a = source("a", { duration: 5, level: null });
          const b = source("b", { duration: 5, level: null });
          for (const blob of [a, b]) {
            // 120 frames whose packet span ends at the last frame's start
            sources.get(blob)!.video.computePacketStats.mockResolvedValue({ averageBitrate: 8_000_000, averagePacketRate: 120 / (119 / 24) });
            Object.assign(sources.get(blob)!.video, { lastPacket: { timestamp: 119 / 24, duration: 0 } });
          }
          await stitchVideosAsync([clip(a, { source: "a" }), clip(b, { source: "b" })], null, undefined, undefined, stacked(1));
          const [d] = dissolves();
          expect(d.timestamps).toHaveLength(24);
          d.incomingTimes.forEach((t, k) => expect(t).toBeCloseTo(k / 24 + 1 / 48, 9));
        });

        it("crossfades the sound with equal power across the overlap, and A is silent after its Out", async () => {
          const a = source("a", { duration: 5, level: 0.5 });
          const b = source("b", { duration: 5, level: 0.4 });
          await stitchVideosAsync([clip(a, { source: "a" }), clip(b, { source: "b" })], null, undefined, undefined, stacked(1));
          const sound = encodedSound();
          expect(sound).toHaveLength(9 * SR);
          const i = SR / 2;
          const x = (i + 0.5) / SR;
          near(sound[4 * SR + i], 0.5 * Math.cos((x * Math.PI) / 2) + 0.4 * Math.sin((x * Math.PI) / 2));
          near(sound[4 * SR - 1], 0.5);
          near(sound[5 * SR + 100], 0.4);
        });

        it("places and fades each sound by its own clip when a neighbour is muted, soundless or fails to decode", async () => {
          for (const quiet of ["muted", "soundless", "fails"] as const) {
            mockAudioSourceAdd.mockClear();
            sources.clear();
            // A is over full scale: with no second clip sounding in any overlap it passes unclamped, as in Track (S11)
            const a = source("a", { duration: 5, level: 1.2 });
            const b = source("b", { duration: 5, level: quiet === "soundless" ? null : 0.5, fails: quiet === "fails" });
            const c = source("c", { duration: 5, level: 0.4 });
            await stitchVideosAsync(
              [clip(a, { source: "a" }), clip(b, { source: "b", muted: quiet === "muted" }), clip(c, { source: "c" })],
              null,
              undefined,
              undefined,
              stacked(1),
            );
            const sound = encodedSound();
            expect(sound).toHaveLength(13 * SR);
            near(sound[2 * SR], 1.2);
            // A fades out over A→B although B is silent
            near(sound[4 * SR + SR / 2], 1.2 * Math.cos((((SR / 2 + 0.5) / SR) * Math.PI) / 2));
            expect(sound[5 * SR]).toBe(0);
            // C starts at its own sequence start (8 s) and fades in over B→C
            expect(sound[8 * SR - 1]).toBe(0);
            near(sound[8 * SR + SR / 2], 0.4 * Math.sin((((SR / 2 + 0.5) / SR) * Math.PI) / 2));
            near(sound[10 * SR], 0.4);
          }
        });

        it("clamps the loop when two sounding clips overlap, an over included", async () => {
          const a = source("a", { duration: 5, level: 1.2 });
          const b = source("b", { duration: 5, level: 0.5 });
          await stitchVideosAsync([clip(a, { source: "a" }), clip(b, { source: "b" })], null, undefined, undefined, stacked(1));
          const sound = encodedSound();
          // A plays alone at 2 s, but the loop has a dissolve where both sound, so the whole loop is clamped
          near(sound[2 * SR], 1);
          near(sound[6 * SR], 0.5);
        });

        it("fades the second clip in when the first has no sound", async () => {
          const a = source("a", { duration: 5, level: null });
          const b = source("b", { duration: 5, level: 0.5 });
          await stitchVideosAsync([clip(a, { source: "a" }), clip(b, { source: "b" })], null, undefined, undefined, stacked(1));
          const sound = encodedSound();
          expect(sound[4 * SR - 1]).toBe(0);
          near(sound[4 * SR + SR / 2], 0.5 * Math.sin((((SR / 2 + 0.5) / SR) * Math.PI) / 2));
          near(sound[6 * SR], 0.5);
        });

        it("reads an incoming clip that starts after In from its first timestamp", async () => {
          const a = source("a", { duration: 5, level: null });
          const b = source("b", { duration: 5, firstTimestamp: 0.04, level: null });
          await stitchVideosAsync([clip(a, { source: "a" }), clip(b, { source: "b" })], null, undefined, undefined, stacked(1));
          const [, soloB] = sampleCalls;
          expect(soloB.track).toBe(sources.get(b)!.video);
          expect(soloB.start).toBeCloseTo(1.04, 9);
          expect(soloB.end).toBe(5);
          const [d] = dissolves();
          expect(d.incomingTimes[0]).toBeGreaterThanOrEqual(0.04);
          // Mid-slot through B's own solo mapping, which starts from its first frame
          expect(d.incomingTimes[0]).toBeCloseTo(0.04 + 0.5 / 60, 6);
          // The frame at 1.0 is held back from before 1.04 and gives way to the one at 1 + 1/24, which takes the first solo slot
          expect(soloB.setTimestamp[0]).not.toHaveBeenCalled();
          expect(soloB.setTimestamp[1].mock.calls[0]?.[0]).toBe(5);
        });

        it("A | B1 B2 | C: a dissolve, a cut between the pieces, then a dissolve", async () => {
          const a = source("a", { duration: 5, level: null });
          const b = source("b", { duration: 10, level: null });
          const c = source("c", { duration: 5, level: null });
          await stitchVideosAsync(
            [
              clip(a, { source: "a" }),
              clip(b, { source: "b", outSec: 5 }),
              clip(b, { source: "b", inSec: 5 }),
              clip(c, { source: "c" }),
            ],
            null,
            undefined,
            undefined,
            stacked(1),
          );
          expect(dissolves().map((d) => [d.outgoing, d.incoming])).toEqual([
            [sources.get(a)!.video, sources.get(b)!.video],
            [sources.get(b)!.video, sources.get(c)!.video],
          ]);
          expect(ranges()).toEqual([
            [0, 4],
            [1, 5],
            [5, 9],
            [1, 5],
          ]);
          // B2's solo window follows B1's directly: B1 from 5, B2 from 9
          expect(starts()).toEqual([0, 5, 9, 14]);
        });

        it("skips a middle clip's empty solo window and claims both dissolves' slots with no repeats", async () => {
          const a = source("a", { duration: 2, level: null });
          const b = source("b", { duration: 2, level: null });
          const c = source("c", { duration: 2, level: null });
          await stitchVideosAsync(
            [clip(a, { source: "a" }), clip(b, { source: "b" }), clip(c, { source: "c" })],
            null,
            undefined,
            undefined,
            stacked(1),
          );
          expect(sampleCalls.some((call) => call.track === sources.get(b)!.video)).toBe(false);
          const [ab, bc] = dissolves();
          expect(dissolves()).toHaveLength(2);
          const slots = [...ab.timestamps, ...bc.timestamps].map((t) => Math.round(t * 60));
          expect(slots).toEqual(Array.from({ length: 120 }, (_, i) => 60 + i));
          const all = encodedTimestamps();
          expect(all.every((t, i) => i === 0 || t > all[i - 1])).toBe(true);
        });

        it("loops with a cut at the seam: slots keep rising, no dissolve back into the first clip, no fade-in", async () => {
          const a = source("a", { duration: 5, level: 0.5 });
          const b = source("b", { duration: 5, level: 0.4 });
          await stitchVideosAsync([clip(a, { source: "a" }), clip(b, { source: "b" })], null, undefined, undefined, stacked(1, true, 2));
          expect(dissolves()).toHaveLength(2);
          expect(dissolves().every((d) => d.outgoing === sources.get(a)!.video)).toBe(true);
          expect(dissolves()[1].timestamps[0]).toBe(13);
          expect(starts()).toEqual([0, 5, 9, 14]);
          const all = encodedTimestamps();
          expect(all.every((t, i) => i === 0 || t > all[i - 1])).toBe(true);
          const sound = encodedSound();
          expect(sound).toHaveLength(18 * SR);
          near(sound[0], 0.5);
          near(sound[9 * SR], 0.5);
          // B's tail before the seam is not faded out
          near(sound[9 * SR - 1], 0.4);
        });

        it("makes the blender at the size of the first frame the encoder took", async () => {
          const a = source("a", { duration: 5, width: 1280, height: 720, level: null });
          const b = source("b", { duration: 5, width: 1920, height: 1080, level: null });
          mockEncodeDissolve.mockImplementationOnce(async (_job: unknown, blenderFor: (first: unknown) => unknown) => {
            blenderFor({ codedWidth: 1920, codedHeight: 1080 });
          });
          await stitchVideosAsync([clip(a, { source: "a" }), clip(b, { source: "b" })], null, undefined, undefined, stacked(1));
          expect(mockCreateFrameBlender).toHaveBeenCalledTimes(1);
          expect(mockCreateFrameBlender).toHaveBeenCalledWith({ width: 1280, height: 720 });
        });

        it("stops on an abort inside a dissolve: the output is cancelled and the inputs released", async () => {
          const a = source("a", { duration: 5, level: null });
          const b = source("b", { duration: 5, level: null });
          mockEncodeDissolve.mockRejectedValueOnce(new DOMException("Aborted", "AbortError"));
          await expect(
            stitchVideosAsync([clip(a, { source: "a" }), clip(b, { source: "b" })], null, undefined, undefined, stacked(1)),
          ).rejects.toMatchObject({ name: "AbortError" });
          expect(mockOutputCancel).toHaveBeenCalledTimes(1);
          expect(mockDispose).toHaveBeenCalledTimes(2);
          expect(mockOutputFinalize).not.toHaveBeenCalled();
        });

        it("reports a dissolve that fails as the clip's failure", async () => {
          const a = source("a", { duration: 5, level: null });
          const b = source("b", { duration: 5, level: null });
          mockEncodeDissolve.mockRejectedValueOnce(new Error("decoder broke"));
          await expect(
            stitchVideosAsync([clip(a, { source: "a" }), clip(b, { source: "b" })], null, undefined, undefined, stacked(1)),
          ).rejects.toThrow("decoder broke");
          expect(mockOutputCancel).toHaveBeenCalledTimes(1);
        });
      });

      describe("placed", () => {
        interface Frame {
          timestamp: number;
          codedWidth?: number;
          setTimestamp?: ReturnType<typeof vi.fn>;
        }
        const composites: Array<{ timestamp: number; layers: Array<{ sample: Frame | null; weight: number }>; close: Mock }> = [];
        const blacks: Array<{ timestamp: number; close: Mock }> = [];
        /** Runs inside each composite, before it returns. */
        let duringComposite: (() => void) | null = null;
        const placedOptions = (overlapSec = 1, crossfade = true, loopCount = 1) => ({ loopCount, overlapSec, crossfade, placed: true });
        const stacked = (overlapSec: number, crossfade = true, loopCount = 1) => ({ loopCount, overlapSec, crossfade });
        const near = (actual: number, expected: number) => expect(actual).toBeCloseTo(expected, 3);
        const at = (blob: Blob, name: string, startSec: number | undefined, extra: Partial<{ inSec: number; outSec: number | null; volume: number }> = {}) => ({
          ...clip(blob, { source: name, ...extra }),
          ...(startSec === undefined ? {} : { startSec }),
        });
        /** Where each passed-through clone landed, in slots, per samples() call. */
        const landed = () => sampleCalls.map((call) => call.clones.map((c) => Math.round((c.setTimestamp.mock.calls[0]?.[0] as number) * 60)));
        const tracks = () => sampleCalls.map((call) => call.track);
        /** Every timestamp handed to the encoder, in order. */
        const encodedTimestamps = () =>
          mockVideoSourceAdd.mock.calls.map((call: unknown[]) => {
            const sample = call[0] as Frame;
            return sample.setTimestamp?.mock.calls.length ? (sample.setTimestamp.mock.calls[0][0] as number) : sample.timestamp;
          });
        const videoOf = (blob: Blob) => sources.get(blob)!.video;

        beforeEach(() => {
          composites.length = 0;
          blacks.length = 0;
          duringComposite = null;
          (mockCreateFrameBlender as unknown as Mock).mockImplementation(() => ({
            blend: vi.fn(),
            composite: vi.fn(async (layers: Array<{ sample: Frame | null; weight: number }>, timestamp: number) => {
              const out = { timestamp, layers, close: vi.fn() };
              composites.push(out);
              duringComposite?.();
              return out;
            }),
            black: vi.fn((timestamp: number) => {
              const out = { timestamp, close: vi.fn() };
              blacks.push(out);
              return out;
            }),
          }));
        });

        afterEach(() => {
          mockCreateFrameBlender.mockImplementation(() => ({ blend: vi.fn() }));
        });

        /** Two 5 s clips at 24 fps with sound, stitched with these starts and options; what reached the decoders and the encoder. */
        async function record(starts: [number | undefined, number | undefined] | null, options: Parameters<typeof stitchVideosAsync>[4]) {
          sampleCalls.length = 0;
          mockAudioSourceAdd.mockClear();
          mockEncodeDissolve.mockClear();
          composites.length = 0;
          sources.clear();
          const a = source("a", { duration: 5, frameRate: 24, level: 0.5 });
          const b = source("b", { duration: 5, frameRate: 24, level: 0.4 });
          await stitchVideosAsync([at(a, "a", starts?.[0]), at(b, "b", starts?.[1])], null, undefined, undefined, options);
          return {
            calls: sampleCalls.map((call) => [call.start, call.end, call.setTimestamp.map((spy) => spy.mock.calls)]),
            dissolves: mockEncodeDissolve.mock.calls.map((call: unknown[]) => {
              const { timestamps, outgoingTimes, incomingTimes, alphas } = call[0] as Record<string, unknown>;
              return { timestamps, outgoingTimes, incomingTimes, alphas };
            }),
            sound: encodedSound(),
            composites: composites.length,
          };
        }

        beforeEach(() => {
          // Hands each blended frame to the encoder, as the real one does
          mockEncodeDissolve.mockImplementation(
            async (job: { timestamps: number[] }, _blenderFor: unknown, add: (sample: unknown) => Promise<void>) => {
              for (const timestamp of job.timestamps) await add({ timestamp, codedWidth: 0, codedHeight: 0 });
            },
          );
        });

        it("runs a node without the placed flag exactly as before, whatever starts its clips carry", async () => {
          for (const options of [{ loopCount: 2 }, stacked(1), stacked(1, false)]) {
            const plain = await record(null, options);
            const withStarts = await record([3, 0], options);
            expect(withStarts).toEqual(plain);
            expect(withStarts.composites).toBe(0);
          }
          // A lined-up stack still dissolves through encodeDissolve, and a Track node never does
          expect((await record([3, 0], stacked(1))).dissolves).toHaveLength(1);
          expect((await record([3, 0], { loopCount: 1 })).dissolves).toHaveLength(0);
        });

        it("encodes starts equal to Track's on the Track branch, call for call", async () => {
          const track = await record(null, { loopCount: 2 });
          const placed = await record([0, 5], placedOptions(1, true, 2));
          expect(placed).toEqual(track);
          expect(placed.dissolves).toHaveLength(0);
          expect(placed.composites).toBe(0);
        });

        it("encodes starts equal to the lined-up layout on the commit-9 branch, and so a clip never placed", async () => {
          const linedUp = await record(null, stacked(1));
          expect(linedUp.dissolves).toHaveLength(1);
          expect(await record([0, 4], placedOptions(1))).toEqual(linedUp);
          // The only pinned clip was dropped before the engine: the rest resolve to the lined-up layout
          expect(await record([undefined, undefined], placedOptions(1))).toEqual(linedUp);
          expect(await record([0, undefined], placedOptions(1))).toEqual(linedUp);
          // Overlap 0 never takes the commit-9 branch
          const placed = await record([0, 4], placedOptions(0));
          expect(placed.dissolves).toHaveLength(0);
          expect(placed.composites).toBeGreaterThan(0);
        });

        it("takes the placed branch over the stack's overlap when the starts are the user's own", async () => {
          const placed = await record([0, 3], placedOptions(1));
          expect(placed.dissolves).toHaveLength(0);
          expect(placed.composites).toBeGreaterThan(0);
        });

        it("resolves an unpinned clip with the engine's own lengths", async () => {
          for (const duration of [3, 5]) {
            sampleCalls.length = 0;
            const a = source("a", { duration, frameRate: 24, level: null });
            const b = source("b", { duration: 5, frameRate: 24, level: null });
            await stitchVideosAsync([at(a, "a", 1), at(b, "b", undefined)], null, undefined, undefined, placedOptions(0));
            const bCall = sampleCalls.find((call) => call.track === videoOf(b))!;
            expect(Math.round((bCall.clones[0].setTimestamp.mock.calls[0][0] as number) * 60)).toBe((1 + duration) * 60);
          }
        });

        it("writes one black frame at a gap's first slot, each loop", async () => {
          const a = source("a", { duration: 5, frameRate: 24, level: null });
          const b = source("b", { duration: 5, frameRate: 24, level: null });
          await stitchVideosAsync([at(a, "a", 0), at(b, "b", 6)], null, undefined, undefined, placedOptions(1, true, 2));
          expect(blacks.map((f) => f.timestamp)).toEqual([5, 16]);
          expect(landed().map((slots) => slots[0])).toEqual([0, 360, 660, 1020]);
          blacks.forEach((f) => expect(f.close).toHaveBeenCalledTimes(1));
          const all = encodedTimestamps();
          expect(all.every((t, i) => i === 0 || t > all[i - 1])).toBe(true);
        });

        it("reads the first visible clip's frame before a leading gap, and makes the black in its format at its coded size", async () => {
          const a = source("a", { duration: 5, frameRate: 24, width: 1280, height: 720, level: null });
          const b = source("b", { duration: 5, frameRate: 24, width: 1920, height: 1080, level: null });
          const colorSpace = { primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false };
          Object.assign(videoOf(a), { format: "NV12", colorSpace });
          await stitchVideosAsync([at(a, "a", 1), at(b, "b", 6)], null, undefined, undefined, placedOptions(0));
          expect(mockCreateFrameBlender).toHaveBeenCalledTimes(1);
          expect(mockCreateFrameBlender).toHaveBeenCalledWith({ width: 1280, height: 720, format: "NV12", colorSpace });
          // The peek's reader is the one A then plays from: one decoder each
          expect(tracks()).toEqual([videoOf(a), videoOf(b)]);
          expect(mockVideoSourceAdd.mock.calls[0][0]).toBe(blacks[0]);
          expect(blacks[0].timestamp).toBe(0);
        });

        it("reads the bottom clip's frame first when the loop opens on a blend", async () => {
          // Row 9: B [0,3) in front of A [0,10), both from 0
          const a = source("a", { duration: 10, frameRate: 24, width: 1280, height: 720, level: null });
          const b = source("b", { duration: 3, frameRate: 24, width: 1920, height: 1080, level: null });
          await stitchVideosAsync([at(b, "b", 0), at(a, "a", 0)], null, undefined, undefined, placedOptions(0));
          expect(tracks()[0]).toBe(videoOf(a));
          expect(mockCreateFrameBlender).toHaveBeenCalledWith(expect.objectContaining({ width: 1280, height: 720 }));
          expect(composites[0].timestamp).toBe(0);
          expect(composites[0].layers.map((l) => l.sample?.codedWidth)).toEqual([1280, 1920]);
        });

        it("opens one decoder per visibility run per loop: a clip hidden in the middle is read twice, from where it shows again", async () => {
          // F [2,8) over L [0,10): F is opaque over [4,6), where L is hidden
          const f = source("f", { duration: 6, frameRate: 24, level: null });
          const l = source("l", { duration: 10, frameRate: 24, level: null });
          Object.assign(videoOf(l), { packetTimes: Array.from({ length: 240 }, (_, j) => j / 24) });
          await stitchVideosAsync([at(f, "f", 2), at(l, "l", 0)], null, undefined, undefined, placedOptions(1, true, 2));
          expect(tracks()).toEqual([videoOf(l), videoOf(f), videoOf(l), videoOf(l), videoOf(f), videoOf(l)]);
          const ranges = sampleCalls.map(({ start, end }) => [start, end]);
          expect(ranges[0]).toEqual([0, 240.5 / 60]);
          expect(ranges[1]).toEqual([0, 6]);
          // From a slot before the slot of the frame in effect at 6 s (143, on slot 358): it counts that slot as Track does
          near(ranges[2][0], 356.5 / 60);
          expect(ranges[2][1]).toBe(10);
          expect(ranges.slice(3)).toEqual(ranges.slice(0, 3));
          // L shows again at 6 s with the frame of that time, under F's fade-out
          const again = composites.find((f) => Math.abs(f.timestamp - 6) < 1e-9)!;
          expect(again.layers[0].sample?.timestamp).toBeCloseTo(6, 9);
          const all = encodedTimestamps();
          expect(all.every((t, i) => i === 0 || t > all[i - 1])).toBe(true);
          expect(sampleCalls.every((call) => call.stopped)).toBe(true);
        });

        it("reads a front clip inside a lower one with one decoder each (row 6), and never reads or hears a clip wholly hidden (row 6b)", async () => {
          let a = source("a", { duration: 10, frameRate: 24, level: 0.5 });
          let b = source("b", { duration: 2, frameRate: 24, level: 0.4 });
          await stitchVideosAsync([at(b, "b", 3), at(a, "a", 0)], null, undefined, undefined, placedOptions(0));
          expect(tracks()).toEqual([videoOf(a), videoOf(b)]);

          sampleCalls.length = 0;
          mockAudioSourceAdd.mockClear();
          a = source("a", { duration: 10, frameRate: 24, level: 0.5 });
          b = source("b", { duration: 2, frameRate: 24, level: 0.4 });
          await stitchVideosAsync([at(a, "a", 0), at(b, "b", 3)], null, undefined, undefined, placedOptions(0));
          expect(tracks()).toEqual([videoOf(a)]);
          const sound = encodedSound();
          near(sound[4 * SR], 0.5);
          near(sound[3 * SR + 1], 0.5);
        });

        it("places each sound at its own start and crossfades it with the picture, or plays both in full with Crossfade off", async () => {
          for (const crossfade of [true, false]) {
            mockAudioSourceAdd.mockClear();
            const a = source("a", { duration: 5, level: 0.5 });
            const b = source("b", { duration: 5, level: 0.4 });
            // A [0,5) in front fades out over B [4,9)
            await stitchVideosAsync([at(a, "a", 0), at(b, "b", 4)], null, undefined, undefined, placedOptions(0, crossfade));
            const sound = encodedSound();
            expect(sound).toHaveLength(9 * SR);
            near(sound[4 * SR - 1], 0.5);
            const i = SR / 2;
            const x = (i + 0.5) / SR;
            near(sound[4 * SR + i], crossfade ? 0.5 * Math.cos((x * Math.PI) / 2) + 0.4 * Math.sin((x * Math.PI) / 2) : 0.9);
            near(sound[6 * SR], 0.4);
          }
        });

        it("clamps the loop only when two sounding clips overlap by a slot or more", async () => {
          for (const [bStart, expected] of [
            [5.5, 1.2],
            [5.5 - 1 / 60, 1],
          ] as const) {
            mockAudioSourceAdd.mockClear();
            const a = source("a", { duration: 5, level: 1.2 });
            const b = source("b", { duration: 5, level: 0.3 });
            await stitchVideosAsync([at(a, "a", 0.5), at(b, "b", bStart)], null, undefined, undefined, placedOptions(0));
            near(encodedSound()[2 * SR], expected);
          }
        });

        it("stops on an abort inside a composite: every decoder stopped, every frame closed, the output cancelled", async () => {
          const controller = new AbortController();
          duringComposite = () => controller.abort();
          const a = source("a", { duration: 5, frameRate: 24, level: null });
          const b = source("b", { duration: 5, frameRate: 24, level: null });
          await expect(
            stitchVideosAsync([at(a, "a", 0), at(b, "b", 4)], null, undefined, controller.signal, placedOptions(0)),
          ).rejects.toMatchObject({ name: "AbortError" });
          expect(composites).toHaveLength(1);
          expect(composites[0].close).toHaveBeenCalledTimes(1);
          expect(sampleCalls).toHaveLength(2);
          expect(sampleCalls.every((call) => call.stopped)).toBe(true);
          for (const call of sampleCalls) {
            call.closes.forEach((close) => expect(close).toHaveBeenCalled());
            call.clones.forEach((clone) => expect(clone.close).toHaveBeenCalledTimes(1));
          }
          expect(mockOutputCancel).toHaveBeenCalledTimes(1);
          expect(mockDispose).toHaveBeenCalledTimes(2);
        });

        it("names the clips at once when a decoder fails in a blend of three, and the error itself otherwise", async () => {
          const three = async (failAt: number) => {
            sources.clear();
            const a = source("a", { duration: 5, frameRate: 24, level: null });
            const b = source("b", { duration: 4, frameRate: 24, level: null });
            const c = source("c", { duration: 3.5, frameRate: 24, level: null });
            Object.assign(videoOf(a), { failAt });
            // C over B over A: all three blend over [1.5, 2)
            return stitchVideosAsync([at(c, "c", 1.5), at(b, "b", 1), at(a, "a", 0)], null, undefined, undefined, placedOptions(0));
          };
          await expect(three(1.7)).rejects.toThrow("Could not decode 3 clips at once at 0:02. Move some apart or turn Crossfade off.");
          await expect(three(0.5)).rejects.toThrow("decoder broke");
          expect(mockOutputCancel).toHaveBeenCalledTimes(2);
        });

        it("warns once when more than four clips blend at once", async () => {
          const warn = vi.mocked(console.warn);
          const a = source("a", { duration: 5, frameRate: 24, level: null });
          const b = source("b", { duration: 5, frameRate: 24, level: null });
          const c = source("c", { duration: 6, frameRate: 24, level: null });
          // placed-five: five visible over [4,5)
          await stitchVideosAsync(
            [at(c, "c", 4), at(b, "b", 3.5), at(a, "a", 3), at(b, "b", 2.5), at(a, "a", 0)],
            null,
            undefined,
            undefined,
            placedOptions(1),
          );
          const warnings = warn.mock.calls.filter((call) => String(call[0]).includes("blend at once"));
          expect(warnings).toEqual([["[VideoStitch] 5 clips blend at once; this takes about 250 MB at 1080p"]]);
          expect(composites.some((f) => f.layers.length === 5)).toBe(true);
        });
      });

      describe("warps", () => {
        const W = (speed: number, extra: Partial<ClipWarp> = {}): ClipWarp => ({ speed, curve: null, reverse: false, blend: false, ...extra });
        const ramp = (speed: number, name = "easeInOutCubic") => normalizeWarp(W(speed, { curve: { kind: "preset", name } }))!;
        const stacked = (overlapSec: number, crossfade = true, loopCount = 1) => ({ loopCount, overlapSec, crossfade });
        const placedOptions = (overlapSec = 1, crossfade = true, loopCount = 1) => ({ loopCount, overlapSec, crossfade, placed: true });
        /** A source whose 24 fps frames are listed, without sound unless given a level. */
        const listed = (name: string, duration: number, level: number | ((t: number) => number) | null = null) =>
          source(name, { duration, fps: 24, level });
        const videoOf = (blob: Blob) => sources.get(blob)!.video;
        const at24 = (count: number) => Array.from({ length: count }, (_, j) => j / 24);
        /** Every frame the encoder took: the slot it went in at, its duration, the source time it came from. */
        const written = () =>
          mockVideoSourceAdd.mock.calls.map((call: unknown[]) => {
            const sample = call[0] as { timestamp: number; sourceTimestamp?: number; setTimestamp?: Mock; setDuration?: Mock };
            const at = (sample.setTimestamp?.mock.calls.at(-1)?.[0] as number | undefined) ?? sample.timestamp;
            return {
              slot: Math.round(at * 60),
              duration: sample.setDuration?.mock.calls.at(-1)?.[0] as number | undefined,
              from: sample.sourceTimestamp ?? sample.timestamp,
            };
          });
        /** A clip's frame changes over its slots [0, end) anchored at 0, brute force: the slot and the frame's time. */
        const changes = (times: number[], map: WarpMap, end: number) => {
          const out: Array<{ slot: number; from: number }> = [];
          for (let n = 0; n < end; n++) {
            const from = times[pickFrame(times, warpSlotTime(map, n, 0), false).a];
            if (out.at(-1)?.from !== from) out.push({ slot: n, from });
          }
          return out;
        };
        /** The frame shown on each slot of [0, end): the last one written on it or before. */
        const perSlot = (out: ReturnType<typeof written>, end: number) =>
          Array.from({ length: end }, (_, n) => out.filter((w) => w.slot <= n).at(-1)?.from ?? null);
        const blends: Array<{ a: number; b: number; alpha: number; timestamp: number; result: { setRotation: Mock } }> = [];
        const composites: Array<{ slot: number; layers: Array<{ timestamp: number } | null> }> = [];

        beforeEach(() => {
          blends.length = 0;
          composites.length = 0;
          mockEncodeDissolve.mockImplementation(
            async (job: { timestamps: number[] }, _blenderFor: unknown, add: (sample: unknown) => Promise<void>) => {
              for (const timestamp of job.timestamps) await add({ timestamp, codedWidth: 0, codedHeight: 0 });
            },
          );
          (mockCreateFrameBlender as unknown as Mock).mockImplementation(() => ({
            blend: vi.fn(async (a: { timestamp: number }, b: { timestamp: number }, alpha: number, timestamp: number) => {
              const result = {
                timestamp,
                setRotation: vi.fn(),
                close: vi.fn(),
                clone: () => ({ timestamp, sourceTimestamp: -1, setTimestamp: vi.fn(), setDuration: vi.fn(), close: vi.fn() }),
              };
              blends.push({ a: a.timestamp, b: b.timestamp, alpha, timestamp, result });
              return result;
            }),
            composite: vi.fn(async (layers: Array<{ sample: { timestamp: number } | null }>, timestamp: number) => {
              composites.push({ slot: Math.round(timestamp * 60), layers: layers.map((layer) => layer.sample) });
              return { timestamp, close: vi.fn() };
            }),
            black: vi.fn((timestamp: number) => ({ timestamp, close: vi.fn() })),
          }));
        });

        afterEach(() => {
          mockCreateFrameBlender.mockImplementation(() => ({ blend: vi.fn() }));
          mockVideoSourceAdd.mockResolvedValue(undefined);
        });

        it("Track: writes a 2× clip's frame changes on their slots, decoding it once, and the next clip from where it ends", async () => {
          const a = listed("a", 4);
          const b = source("b", { duration: 2, level: null });
          await stitchVideosAsync([clip(a, { warp: W(2) }), clip(b)]);
          const out = written();
          expect(out.filter((w) => w.slot < 120).map(({ slot, from }) => ({ slot, from }))).toEqual(
            changes(at24(96), warpMap({ inSec: 0, outSec: 4 }, W(2)), 120),
          );
          expect(out.find((w) => w.slot >= 120)?.slot).toBe(120);
          expect(sampleCalls.filter((call) => call.track === videoOf(a)).map(({ start, end }) => [start, end])).toEqual([[0, 4]]);
        });

        it("Track: holds a 0.5× clip's frames for their slots, its last until the next clip starts", async () => {
          const a = listed("a", 2);
          const b = source("b", { duration: 1, level: null });
          await stitchVideosAsync([clip(a, { warp: W(0.5) }), clip(b)]);
          const out = written();
          const own = out.filter((w) => w.slot < 240);
          expect(own.slice(0, 5).map((w) => w.slot)).toEqual([0, 3, 8, 13, 18]);
          own.forEach((w, i) => expect(w.duration).toBeCloseTo(((own[i + 1]?.slot ?? 240) - w.slot) / 60, 12));
          expect(out[own.length].slot).toBe(240);
          expect(new Set(out.map((w) => w.slot)).size).toBe(out.length);
        });

        it("Track: blends a slow clip's frames between them, at its own size and rotation, without the stack's blender", async () => {
          const a = listed("a", 2);
          await stitchVideosAsync([clip(a, { warp: W(0.5, { blend: true }) })]);
          expect(mockCreateFrameBlender).toHaveBeenCalledTimes(1);
          expect(mockCreateFrameBlender).toHaveBeenCalledWith({ width: 4, height: 2 });
          // Frames every 5 slots; past the last one (47, slot 235) it holds
          const between = Array.from({ length: 235 }, (_, n) => n).filter((n) => n % 5 !== 0);
          expect(blends.map((blend) => Math.round(blend.timestamp * 60))).toEqual(between);
          blends.forEach((blend, i) => {
            expect(blend.alpha).toBeCloseTo((between[i] % 5) / 5, 9);
            expect([blend.a, blend.b]).toEqual([Math.floor(between[i] / 5) / 24, (Math.floor(between[i] / 5) + 1) / 24]);
            expect(blend.result.setRotation).toHaveBeenCalledWith(0);
          });
          expect(written().filter((w) => w.from === -1)).toHaveLength(between.length);
        });

        it("Track: writes a reversed clip from its last frame before Out down to In's, closing every frame it kept", async () => {
          const a = listed("a", 2);
          await stitchVideosAsync([clip(a, { inSec: 0.5, outSec: 1.5, warp: W(1, { reverse: true }) })]);
          const out = written();
          expect(out).toHaveLength(24);
          expect(out[0].from).toBeCloseTo(35 / 24, 12);
          out.forEach((w, i) => i > 0 && expect(w.from).toBeCloseTo(out[i - 1].from - 1 / 24, 12));
          expect(out.at(-1)!.from).toBe(0.5);
          expect(byteSamples.length).toBeGreaterThan(24);
          expect(byteSamples.every((sample) => sample.close.mock.calls.length > 0)).toBe(true);
        });

        it("Track: spaces a ramp's frames by its momentary speed, and starts the next clip at its warped length", async () => {
          const a = listed("a", 4);
          const b = source("b", { duration: 1, level: null });
          const warp = ramp(1);
          await stitchVideosAsync([clip(a, { warp }), clip(b)]);
          const map = warpMap({ inSec: 0, outSec: 4 }, warp);
          const own = written().filter((w) => w.slot < 240);
          const gaps = own.slice(1).map((w, i) => ({ gap: w.slot - own[i].slot, mid: (w.slot + own[i].slot) / 120 }));
          for (const { gap, mid } of gaps) {
            const speed = map.speedAt(mid);
            if (speed >= 0.75) expect(Math.abs(gap - 60 / (24 * speed))).toBeLessThanOrEqual(1);
          }
          const middle = gaps.filter(({ mid }) => Math.abs(mid - 2) < 0.5).map(({ gap }) => gap);
          expect(Math.max(...middle)).toBeLessThan(Math.min(gaps[0].gap, gaps.at(-1)!.gap));
          expect(written().find((w) => w.slot >= 240)?.slot).toBe(240);
        });

        it("Track: a ramp split on a slot shows the same frame on every slot as the whole", async () => {
          const warp = ramp(1, "easeInOutSine");
          const a = listed("a", 4);
          await stitchVideosAsync([clip(a, { warp })]);
          const whole = perSlot(written(), 240);
          mockVideoSourceAdd.mockClear();
          const { first, second } = splitWarp({ inSec: 0, outSec: 4 }, warp, 1.5)!;
          await stitchVideosAsync([
            clip(a, { source: "a", outSec: first.range.outSec, warp: first.warp }),
            clip(a, { source: "a", inSec: second.range.inSec, warp: second.warp }),
          ]);
          expect(perSlot(written(), 240)).toEqual(whole);
        });

        it("Track: a slow clip split on a slot shows the same frame on every slot as the whole, both ways", async () => {
          // At 0.5× each source frame holds 5 slots: these cuts fall where the whole already shows the frame past them
          const a = listed("a", 4);
          for (const reverse of [false, true]) {
            const warp = W(0.5, { reverse });
            mockVideoSourceAdd.mockClear();
            await stitchVideosAsync([clip(a, { source: "a", warp })]);
            const whole = perSlot(written(), 480);
            for (const k of [29, 40, 84, 95]) {
              mockVideoSourceAdd.mockClear();
              const { first, second } = splitWarp({ inSec: 0, outSec: 4 }, warp, k / 60)!;
              await stitchVideosAsync([
                clip(a, { source: "a", inSec: first.range.inSec, outSec: first.range.outSec, warp: first.warp }),
                clip(a, { source: "a", inSec: second.range.inSec, outSec: second.range.outSec, warp: second.warp }),
              ]);
              expect(perSlot(written(), 480), `${reverse ? "reversed, " : ""}split on slot ${k}`).toEqual(whole);
            }
          }
        });

        it("Track: sizes a reversed clip's first chunk for frames kept on the canvas, the next by the copies it kept", async () => {
          // 1080p NV12, one GOP: 24 frames at 4 bytes a pixel, then 64 at the copies' 1.5
          const a = source("a", { duration: 10, fps: 24, width: 1920, height: 1080, level: null });
          await stitchVideosAsync([clip(a, { warp: W(1, { reverse: true }) })]);
          const first = reverseChunkFrames(1920 * 1080 * 4);
          const starts = sampleCalls.filter((call) => call.track === videoOf(a)).map((call) => Math.round(call.start * 24));
          expect(starts.slice(0, 2)).toEqual([240 - first, 240 - first - reverseChunkFrames(1920 * 1080 * 1.5)]);
        });

        it("decodes a retimed clip's sound around its range and plays it for its warped length; a constant speed outside 0.25–4× is silent", async () => {
          const a = listed("a", 6, 0.5);
          const b = source("b", { duration: 1, level: 0.25 });
          await stitchVideosAsync([clip(a, { inSec: 1.5, warp: W(2) }), clip(b)]);
          const margin = warpSoundMargin(SR);
          expect(margin).toBeCloseTo(1.028, 12);
          const call = bufferCalls.find((c) => c.track === sources.get(a)!.audio[0])!;
          expect(call.start).toBeCloseTo(1.5 - margin, 12);
          expect(call.end).toBeCloseTo(6 + margin, 12);
          const sound = encodedSound();
          // 4.5 s at 2×, then b at its start
          expect(sound).toHaveLength(3250);
          expect(Math.max(...sound.slice(0, 2250).map((x) => Math.abs(x - 0.5)))).toBeLessThanOrEqual(1e-6);
          expect(sound[2250]).toBeCloseTo(0.25, 6);

          for (const [warp, sounds] of [
            [W(5), false],
            [W(4), true],
            [ramp(5), true],
          ] as const) {
            bufferCalls.length = 0;
            sources.clear();
            const c = listed("c", 8, 0.5);
            await stitchVideosAsync([clip(c, { warp })]);
            expect(bufferCalls.some((buffers) => buffers.track === sources.get(c)!.audio[0])).toBe(sounds);
          }
        });

        it("reads a retimed clip's sound through its warp map, and remixes it to the master's channels", async () => {
          // Source sound 0.1 · t: at 2× from In 1.5, output sample i is source second 1.5 + 2i / SR
          const a = listed("a", 6, (t) => 0.1 * t);
          await stitchVideosAsync([clip(a, { inSec: 1.5, warp: W(2) })]);
          const sound = encodedSound();
          expect(sound).toHaveLength(2250);
          expect(Math.max(...sound.map((x, i) => Math.abs(x - 0.1 * (1.5 + (2 * i) / SR))))).toBeLessThan(1e-4);

          // A mono retimed clip beside a stereo one sounds in both channels
          mockAudioSourceAdd.mockClear();
          const mono = listed("m", 6, 0.5);
          const stereo = source("s", { duration: 1, level: 0.25, decoded: { sampleRate: SR, numberOfChannels: 2 } });
          await stitchVideosAsync([clip(mono, { inSec: 1.5, warp: W(2) }), clip(stereo)]);
          const right = mockAudioSourceAdd.mock.calls.flatMap((call: unknown[]) => [...(call[0] as MockAudioBuffer).getChannelData(1)]);
          expect(right).toHaveLength(3250);
          expect(Math.max(...right.slice(0, 2250).map((x) => Math.abs(x - 0.5)))).toBeLessThanOrEqual(1e-6);
        });

        it("plays a reversed clip's sound backwards, a ramp's along its curve, and an Expo ramp's start at the fade's gain", async () => {
          const level = (t: number) => 0.1 * t;
          const soundOf = async (inSec: number, outSec: number, warp: ClipWarp) => {
            mockAudioSourceAdd.mockClear();
            sources.clear();
            await stitchVideosAsync([clip(listed("a", 6, level), { inSec, outSec, warp })]);
            return { sound: encodedSound(), map: warpMap({ inSec, outSec }, warp) };
          };

          const back = await soundOf(1.5, 6, W(2, { reverse: true }));
          expect(back.sound).toHaveLength(2250);
          expect(back.sound[0]).toBeCloseTo(0.6, 3);
          expect(Math.max(...back.sound.map((x, i) => Math.abs(x - level(back.map.sourceTimeAt(i / SR)))))).toBeLessThan(1e-4);

          // Where it plays from half speed up (below a quarter it fades out)
          const glide = await soundOf(1, 5, ramp(1));
          const full = glide.sound.flatMap((x, i) => (glide.map.speedAt(i / SR) >= 0.5 ? [x - level(glide.map.sourceTimeAt(i / SR))] : []));
          expect(full.length).toBeGreaterThan(glide.sound.length / 2);
          expect(Math.max(...full.map(Math.abs))).toBeLessThan(1e-3);

          // The curve jumps at its start: a skip, not a millisecond at full level
          const expo = await soundOf(1, 5, ramp(1, "easeInExpo"));
          const gain = (o: number) => Math.min(1, expo.map.speedAt(o) / SOUND_MIN_SPEED);
          expo.sound.slice(0, 5).forEach((x, i) => expect(Math.abs(x - gain(i / SR) * level(expo.map.sourceTimeAt(i / SR)))).toBeLessThan(0.02));
        });

        it("lined up: dissolves out of a retimed clip through its own reader on every slot, its solo frames and the dissolve tiling", async () => {
          const outgoing: Array<number | null> = [];
          // Whether A's decoders were all stopped and their frames closed when the first frame after the dissolve came
          let dissolved = false;
          let closedBeforeB: boolean | null = null;
          mockEncodeDissolveFrames.mockImplementation(
            async (
              job: {
                outgoing: { frameOn: (slot: number) => Promise<{ timestamp: number } | null>; close: () => Promise<void> };
                incoming: { frameOn: (slot: number) => Promise<unknown>; close: () => Promise<void> };
                slots: number[];
                timestamps: number[];
              },
              _blenderFor: unknown,
              add: (sample: unknown) => Promise<void>,
            ) => {
              for (let i = 0; i < job.timestamps.length; i++) {
                outgoing.push((await job.outgoing.frameOn(job.slots[i]))?.timestamp ?? null);
                await job.incoming.frameOn(job.slots[i]);
                await add({ timestamp: job.timestamps[i], codedWidth: 0, codedHeight: 0 });
              }
              await job.outgoing.close();
              await job.incoming.close();
              dissolved = true;
            },
          );
          // Both files 24 fps, so only the retimed side keeps the dissolve off a shared cadence
          const a = source("a", { duration: 8, fps: 24, frameRate: 24, level: null });
          const b = source("b", { duration: 5, frameRate: 24, level: null });
          mockVideoSourceAdd.mockImplementation(async () => {
            if (!dissolved || closedBeforeB !== null) return;
            closedBeforeB = sampleCalls
              .filter((call) => call.track === videoOf(a))
              .every((call) => call.stopped && call.closes.every((close) => close.mock.calls.length > 0));
          });
          await stitchVideosAsync([clip(a, { source: "a", warp: W(2) }), clip(b, { source: "b" })], null, undefined, undefined, stacked(1));
          expect(mockEncodeDissolve).not.toHaveBeenCalled();
          expect(mockEncodeDissolveFrames).toHaveBeenCalledTimes(1);
          const [job] = mockEncodeDissolveFrames.mock.calls[0] as [{ slots: number[]; incoming: { kind: string; times: number[] } }];
          const overlap = Array.from({ length: 60 }, (_, i) => 180 + i);
          expect(job.slots).toEqual(overlap);
          const times = at24(192);
          const map = warpMap({ inSec: 0, outSec: 8 }, W(2));
          expect(outgoing).toEqual(overlap.map((n) => times[pickFrame(times, warpSlotTime(map, n, 0), false).a]));
          // B looks its frames up by its own solo mapping (from 1 s, its solo window starting on slot 240)
          expect(job.incoming.kind).toBe("times");
          job.incoming.times.forEach((t, i) => expect(t).toBeCloseTo(Math.max(0, 1 + (180 + i - 240 + 0.5 - 1e-6) / 60), 12));
          const out = written();
          out.forEach((w, i) => i > 0 && expect(w.slot).toBeGreaterThan(out[i - 1].slot));
          const solo = out.filter((w) => w.slot < 180);
          expect(solo.at(-1)!.slot + solo.at(-1)!.duration! * 60).toBeCloseTo(180, 9);
          expect(out.filter((w) => w.slot >= 180 && w.slot < 240).map((w) => w.slot)).toEqual(overlap);
          expect(out.find((w) => w.slot >= 240)?.slot).toBe(240);
          // A's reader is stopped once its dissolve out is written, before B's solo, every frame it decoded closed
          const decodes = sampleCalls.filter((call) => call.track === videoOf(a));
          expect(decodes.length).toBeGreaterThan(0);
          expect(closedBeforeB).toBe(true);
        });

        it("lined up: dissolves into a retimed clip through its own reader, anchored at its own start", async () => {
          const incoming: Array<number | null> = [];
          mockEncodeDissolveFrames.mockImplementation(
            async (
              job: {
                outgoing: { frameOn: (slot: number) => Promise<unknown>; close: () => Promise<void> };
                incoming: { frameOn: (slot: number) => Promise<{ timestamp: number } | null>; close: () => Promise<void> };
                slots: number[];
                timestamps: number[];
              },
              _blenderFor: unknown,
              add: (sample: unknown) => Promise<void>,
            ) => {
              for (let i = 0; i < job.timestamps.length; i++) {
                await job.outgoing.frameOn(job.slots[i]);
                incoming.push((await job.incoming.frameOn(job.slots[i]))?.timestamp ?? null);
                await add({ timestamp: job.timestamps[i], codedWidth: 0, codedHeight: 0 });
              }
              await job.outgoing.close();
              await job.incoming.close();
            },
          );
          // A (5 s) then B at 2× (8 s of source in 4 s), overlapping by 1 s: the dissolve is slots 240–299, B starts on 240
          const a = source("a", { duration: 5, frameRate: 24, level: null });
          const b = listed("b", 8);
          await stitchVideosAsync([clip(a, { source: "a" }), clip(b, { source: "b", warp: W(2) })], null, undefined, undefined, stacked(1));
          const times = at24(192);
          const map = warpMap({ inSec: 0, outSec: 8 }, W(2));
          const frameAt = (n: number) => times[pickFrame(times, warpSlotTime(map, n, 240), false).a];
          expect(incoming).toEqual(Array.from({ length: 60 }, (_, i) => frameAt(240 + i)));
          // B's solo frames go on along the same map, from the same anchor
          const solo = written().filter((w) => w.slot >= 300);
          expect(solo.length).toBeGreaterThan(0);
          for (const w of solo) expect(w.from).toBe(frameAt(w.slot));
        });

        it("placed: opens a retimed clip's reader per visibility run, from the run's first slot, and blends its schedule's frames", async () => {
          const f = source("f", { duration: 6, frameRate: 24, level: null });
          const l = listed("l", 20);
          await stitchVideosAsync(
            [
              { ...clip(f, { source: "f" }), startSec: 2 },
              { ...clip(l, { source: "l", warp: W(2) }), startSec: 0 },
            ],
            null,
            undefined,
            undefined,
            placedOptions(1),
          );
          // l (10 s at 2×) under f [2, 8): hidden in the middle, so read twice
          const env = buildEnvelope(
            [
              { start: 2, length: 6, row: 0, source: "f", inSec: 0 },
              { start: 0, length: 10, row: 1, source: "l", inSec: 0, sourceEnds: [0, 20] },
            ],
            true,
          );
          const runs = visibilityRuns(pictureSegments(env), 2, 0)[1];
          expect(runs).toHaveLength(2);
          const times = at24(480);
          const map = warpMap({ inSec: 0, outSec: 20 }, W(2));
          const anchor = unitSlots(env, 1, 0).anchor;
          const frameAt = (n: number) => times[pickFrame(times, warpSlotTime(map, n, anchor), false).a];
          expect(sampleCalls.filter((call) => call.track === videoOf(l)).map((call) => call.start)).toEqual(runs.map((run) => frameAt(run.n0)));
          // l is the bottom layer of every blend
          expect(composites.length).toBeGreaterThan(30);
          for (const { slot, layers } of composites) expect(layers[0]?.timestamp).toBe(frameAt(slot));
        });

        it("plays a retimed clip again each loop, reading its frame list once", async () => {
          const a = listed("a", 4);
          const b = source("b", { duration: 2, level: null });
          await stitchVideosAsync([clip(a, { warp: W(2) }), clip(b)], null, undefined, undefined, { loopCount: 2 });
          const out = written();
          const first = out.filter((w) => w.slot < 120);
          const second = out.filter((w) => w.slot >= 240 && w.slot < 360);
          expect(second.map((w) => [w.slot, w.from])).toEqual(first.map((w) => [w.slot + 240, w.from]));
          expect(packetCalls.filter((call) => call.method === "getKeyPacket" && call.track === videoOf(a))).toHaveLength(1);
        });

        it("renders as before without warps: no warp, warp undefined and an identity warp reach the engine as none, giving the same decodes, frames, dissolves and sound", async () => {
          for (const options of [{ loopCount: 2 }, stacked(1, true, 2), placedOptions(0, true, 2)]) {
            const run = async (extra: { warp?: ClipWarp }) => {
              sampleCalls.length = 0;
              bufferCalls.length = 0;
              mockVideoSourceAdd.mockClear();
              mockAudioSourceAdd.mockClear();
              mockEncodeDissolve.mockClear();
              sources.clear();
              const a = source("a", { duration: 3, frameRate: 24, level: 0.5 });
              const b = source("b", { duration: 3, frameRate: 24, level: 0.5 });
              await stitchVideosAsync(
                [
                  { ...clip(a, { source: "a", ...extra }), startSec: 0 },
                  // Placed: b over the last second of a, a blend
                  { ...clip(b, { source: "b", ...extra }), startSec: 2 },
                ],
                null,
                undefined,
                undefined,
                options,
              );
              return {
                decodes: sampleCalls.map(({ start, end, setTimestamp }) => [start, end, setTimestamp.map((spy) => spy.mock.calls)]),
                frames: mockVideoSourceAdd.mock.calls.map((call: unknown[]) => {
                  const sample = call[0] as { timestamp: number; setTimestamp?: Mock };
                  return sample.setTimestamp?.mock.calls ?? sample.timestamp;
                }),
                dissolves: mockEncodeDissolve.mock.calls.map((call: unknown[]) => {
                  const { timestamps, outgoingTimes, incomingTimes, alphas, frameDuration } = call[0] as Record<string, unknown>;
                  return { timestamps, outgoingTimes, incomingTimes, alphas, frameDuration };
                }),
                buffers: bufferCalls.map(({ start, end }) => [start, end]),
                sound: encodedSound(),
              };
            };
            const plain = await run({});
            expect(plain.frames.length).toBeGreaterThan(0);
            expect(await run({ warp: undefined })).toEqual(plain);
            expect(await run({ warp: { speed: 1, curve: null, reverse: false, blend: true } })).toEqual(plain);
          }
          expect(mockEncodeDissolveFrames).not.toHaveBeenCalled();
        });
      });

      describe("overlays", () => {
        interface Writer {
          job: { add: (sample: unknown) => Promise<void> } & Record<string, unknown>;
          written: unknown[];
          write: Mock;
          flush: Mock;
          close: Mock;
        }
        /** Each overlay writer made: its job, every frame written through it (handed on as it is), its flush and close. */
        const writers: Writer[] = [];
        const overlay = (init: Parameters<typeof createTextOverlay>[0] = {}): StitchOverlayInput => ({
          ...createTextOverlay({ id: "o", startSec: 1, endSec: 3, ...init }),
          fontList: '"Space Grotesk", sans-serif',
        });
        const placedOptions = (overlapSec = 1, crossfade = true, loopCount = 1) => ({ loopCount, overlapSec, crossfade, placed: true });
        const stacked = (overlapSec: number, crossfade = true, loopCount = 1) => ({ loopCount, overlapSec, crossfade });
        const at = (blob: Blob, name: string, startSec: number) => ({ ...clip(blob, { source: name }), startSec });
        const videoOf = (blob: Blob) => sources.get(blob)!.video;
        /** Every frame the encoder took, in order: the time it went in at, the source time it came from, its layers. */
        const encoded = () =>
          mockVideoSourceAdd.mock.calls.map((call: unknown[]) => {
            const sample = call[0] as { timestamp: number; setTimestamp?: Mock; layers?: unknown[] };
            return {
              at: sample.setTimestamp?.mock.calls[0]?.[0] ?? sample.timestamp,
              from: sample.timestamp,
              layers: sample.layers?.length ?? null,
            };
          });

        beforeEach(() => {
          writers.length = 0;
          mockCreateOverlayWriter.mockImplementation((job: Writer["job"]) => {
            const writer: Writer = {
              job,
              written: [],
              write: vi.fn(async (sample: unknown) => {
                writer.written.push(sample);
                await job.add(sample);
              }),
              flush: vi.fn(async () => undefined),
              close: vi.fn(),
            };
            writers.push(writer);
            return writer;
          });
          mockEncodeDissolve.mockImplementation(
            async (job: { timestamps: number[] }, _blenderFor: unknown, add: (sample: unknown) => Promise<void>) => {
              for (const timestamp of job.timestamps) await add({ timestamp, codedWidth: 0, codedHeight: 0 });
            },
          );
          (mockCreateFrameBlender as unknown as Mock).mockImplementation(() => ({
            blend: vi.fn(),
            composite: vi.fn(async (layers: unknown[], timestamp: number) => ({ timestamp, layers, close: vi.fn() })),
            black: vi.fn((timestamp: number) => ({ timestamp, kind: "black", close: vi.fn() })),
          }));
        });

        afterEach(() => {
          mockCreateFrameBlender.mockImplementation(() => ({ blend: vi.fn() }));
        });

        it("renders as before without overlays: the same frames to the encoder in the same order, and no overlay pass", async () => {
          for (const options of [{ loopCount: 2 }, stacked(1, true, 2), placedOptions(0, true, 2)]) {
            const run = async (extra: Record<string, unknown>) => {
              mockVideoSourceAdd.mockClear();
              sampleCalls.length = 0;
              sources.clear();
              const a = source("a", { duration: 3, frameRate: 24, level: null });
              const b = source("b", { duration: 3, frameRate: 24, level: null });
              await stitchVideosAsync([at(a, "a", 0), at(b, "b", 4)], null, undefined, undefined, { ...options, ...extra });
              return encoded();
            };
            const plain = await run({});
            expect(plain.length).toBeGreaterThan(0);
            expect(await run({ overlays: [] })).toEqual(plain);
            // A layer with no wash and no text draws nothing
            expect(await run({ overlays: [overlay({ text: "", wash: { opacity: 0 } })] })).toEqual(plain);
          }
          expect(mockCreateOverlayWriter).not.toHaveBeenCalled();
        });

        it("hands a Track sequence's own decoded frames to the encoder without overlays: nothing cloned, nothing added", async () => {
          const a = source("a", { duration: 2, frameRate: 24, level: null });
          const b = source("b", { duration: 2, frameRate: 24, level: null });
          await stitchVideosAsync([clip(a), clip(b)], null, undefined, undefined, { loopCount: 2 });
          const decoded = sampleCalls.flatMap((call) => call.setTimestamp);
          expect(mockVideoSourceAdd.mock.calls.map((call: unknown[]) => (call[0] as { setTimestamp: Mock }).setTimestamp)).toEqual(decoded);
          expect(sampleCalls.every((call) => call.clones.length === 0)).toBe(true);
        });

        it("sends every frame of a Track sequence through the overlay writer, and flushes it before the encoder closes", async () => {
          const a = source("a", { duration: 2, frameRate: 24, width: 1280, height: 720, level: null });
          const b = source("b", { duration: 2, frameRate: 24, width: 1280, height: 720, level: null });
          const overlays = [overlay()];
          await stitchVideosAsync([clip(a), clip(b)], null, undefined, undefined, { loopCount: 2, overlays });
          expect(writers).toHaveLength(1);
          const [writer] = writers;
          expect(writer.job).toMatchObject({ overlays, loopLength: 4, loopCount: 2, layout: { width: 1280, height: 720 }, rotation: 0 });
          expect(writer.written).toHaveLength(sampleCalls.reduce((n, call) => n + call.setTimestamp.length, 0));
          expect(writer.written).toEqual(mockVideoSourceAdd.mock.calls.map((call: unknown[]) => call[0]));
          expect(writer.flush).toHaveBeenCalledTimes(1);
          expect(writer.flush.mock.invocationCallOrder[0]).toBeGreaterThan(writer.write.mock.invocationCallOrder.at(-1)!);
          expect(writer.flush.mock.invocationCallOrder[0]).toBeLessThan(mockVideoSourceClose.mock.invocationCallOrder[0]);
          expect(writer.close).toHaveBeenCalledTimes(1);
        });

        it("lays the overlays out in a rotated file's display size, to be turned into its coded pixels", async () => {
          const a = source("a", { duration: 2, frameRate: 24, width: 1280, height: 720, level: null });
          Object.assign(videoOf(a), { rotation: 90 });
          await stitchVideosAsync([clip(a)], null, undefined, undefined, { overlays: [overlay()] });
          expect(writers[0].job).toMatchObject({ layout: { width: 720, height: 1280 }, rotation: 90 });
        });

        it("sends a lined-up stack's solo frames and its dissolve's through the writer", async () => {
          const a = source("a", { duration: 5, frameRate: 24, level: null });
          const b = source("b", { duration: 5, frameRate: 24, level: null });
          await stitchVideosAsync([clip(a, { source: "a" }), clip(b, { source: "b" })], null, undefined, undefined, { ...stacked(1), overlays: [overlay()] });
          expect(mockEncodeDissolve).toHaveBeenCalledTimes(1);
          const sent = mockVideoSourceAdd.mock.calls.map((call: unknown[]) => call[0]);
          expect(sent.some((sample) => (sample as { codedWidth?: number }).codedWidth === 0)).toBe(true);
          expect(writers[0].written).toEqual(sent);
          expect(writers[0].flush.mock.invocationCallOrder[0]).toBeLessThan(mockVideoSourceClose.mock.invocationCallOrder[0]);
        });

        it("sends a placed stack's black, solo and blended frames through the writer", async () => {
          const a = source("a", { duration: 3, frameRate: 24, level: null });
          const b = source("b", { duration: 3, frameRate: 24, level: null });
          const c = source("c", { duration: 1, frameRate: 24, level: null });
          // B blends over A on [2, 3); black on [5, 6)
          await stitchVideosAsync([at(a, "a", 0), at(b, "b", 2), at(c, "c", 6)], null, undefined, undefined, {
            ...placedOptions(0),
            overlays: [overlay()],
          });
          const sent = mockVideoSourceAdd.mock.calls.map((call: unknown[]) => call[0] as { kind?: string; layers?: unknown[] });
          expect(sent.some((sample) => sample.kind === "black")).toBe(true);
          expect(sent.some((sample) => sample.layers?.length === 2)).toBe(true);
          expect(writers[0].written).toEqual(sent);
          expect(writers[0].job).toMatchObject({ loopLength: 7, loopCount: 1 });
          expect(writers[0].flush.mock.invocationCallOrder[0]).toBeLessThan(mockVideoSourceClose.mock.invocationCallOrder[0]);
          expect(writers[0].close).toHaveBeenCalledTimes(1);
        });

        it("closes the writer, without flushing it, when the encode stops or fails", async () => {
          const controller = new AbortController();
          const a = source("a", { duration: 2, frameRate: 24, level: null });
          mockCreateOverlayWriter.mockImplementationOnce((job: Writer["job"]) => {
            const writer: Writer = {
              job,
              written: [],
              write: vi.fn(async () => controller.abort()),
              flush: vi.fn(async () => undefined),
              close: vi.fn(),
            };
            writers.push(writer);
            return writer;
          });
          await expect(
            stitchVideosAsync([clip(a)], null, undefined, controller.signal, { overlays: [overlay()] }),
          ).rejects.toMatchObject({ name: "AbortError" });
          expect(writers[0].flush).not.toHaveBeenCalled();
          expect(writers[0].close).toHaveBeenCalledTimes(1);

          const b = source("b", { duration: 2, frameRate: 24, level: null });
          Object.assign(videoOf(b), { failAt: 1 });
          await expect(stitchVideosAsync([clip(b)], null, undefined, undefined, { overlays: [overlay()] })).rejects.toThrow("decoder broke");
          expect(writers[1].flush).not.toHaveBeenCalled();
          expect(writers[1].close).toHaveBeenCalledTimes(1);
          expect(mockOutputCancel).toHaveBeenCalledTimes(2);
        });
      });
    });
  });
});
