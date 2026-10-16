import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { checkEncoderSupport, stitchVideosAsync } from "../useStitchVideos";

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
const mockBufferTargetBuffer = new ArrayBuffer(100);

/** Each `samples(start, end)` call, and the setTimestamp spy of every frame it yielded. */
const sampleCalls: Array<{ track: unknown; start: number; end: number; setTimestamp: ReturnType<typeof vi.fn>[] }> = [];
/** The frame timestamps a video track yields for samples(start, end); one frame at `start` by default. */
let frameTimestamps: (track: unknown, start: number, end: number) => number[] = (_track, start) => [start];
/** Each `buffers(start, end)` call on an audio track. */
const bufferCalls: Array<{ track: unknown; start: number; end: number }> = [];

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
    cancel: Fn = vi.fn().mockResolvedValue(undefined);
  }
  class VideoSampleSinkMock {
    samples: (start: number, end: number) => AsyncIterable<unknown>;
    constructor(track: unknown) {
      this.samples = vi.fn((start: number, end: number) => {
        const call = { track, start, end, setTimestamp: [] as ReturnType<typeof vi.fn>[] };
        sampleCalls.push(call);
        const timestamps = frameTimestamps(track, start, end);
        return {
          [Symbol.asyncIterator]: async function* () {
            for (const timestamp of timestamps) {
              const setTimestamp = vi.fn();
              call.setTimestamp.push(setTimestamp);
              yield { timestamp, setTimestamp, setDuration: vi.fn(), close: vi.fn() };
            }
          },
        };
      });
    }
  }
  /**
   * Yields one buffer from `start` to 0.1 s past `end` (a real decoder returns whole frames, so its last buffer
   * runs past the range asked for), every sample at the track's `level`, in the track's decoded format (its
   * container's unless `decoded` says otherwise); throws when `fails`.
   */
  class AudioBufferSinkMock {
    buffers: (start: number, end: number) => AsyncIterable<unknown>;
    constructor(track: {
      sampleRate: number;
      numberOfChannels: number;
      level: number;
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
            for (let c = 0; c < numberOfChannels; c++) buffer.getChannelData(c).fill(track.level);
            yield { buffer, timestamp, duration: length / sampleRate };
          },
        };
      };
    }
  }
  /** The track's `lastPacket`, or none. */
  class EncodedPacketSinkMock {
    getPacket: (timestamp: number) => Promise<unknown>;
    constructor(track: { lastPacket?: unknown }) {
      this.getPacket = async () => track.lastPacket ?? null;
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
    AudioBufferSource: AudioBufferSourceMock,
    BufferTarget: BufferTargetMock,
    Mp4OutputFormat: Mp4OutputFormatMock,
    ALL_FORMATS: [],
    canEncodeVideo: (...args: unknown[]) => mockCanEncodeVideo(...args),
    getFirstEncodableAudioCodec: (...args: unknown[]) => mockGetFirstEncodableAudioCodec(...args),
  };
});

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
      await expect(stitchVideosAsync([])).rejects.toThrow("No videos to stitch");
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
          level?: number | null;
          sampleRate?: number;
          fails?: boolean;
          decoded?: { sampleRate: number; numberOfChannels: number };
        } = {},
      ): Blob {
        const blob = new Blob([name], { type: "video/mp4" });
        const level = opts.level === undefined ? 0.5 : opts.level;
        sources.set(blob, {
          video: createMockVideoTrack(1920, 1080, 0, opts.duration ?? 1, opts.firstTimestamp ?? 0),
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

      const clip = (blob: Blob, overrides: Partial<{ inSec: number; outSec: number | null; muted: boolean; volume: number }> = {}) => ({
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
        await expect(stitchVideosAsync([clip(a, { inSec: 3 })])).rejects.toThrow("Nothing to stitch: every clip is empty");
      });
    });
  });
});
