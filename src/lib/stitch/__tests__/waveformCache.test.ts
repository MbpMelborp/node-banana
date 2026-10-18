import { afterEach, describe, expect, it, vi } from "vitest";

const prepareAudioAsync = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/useAudioMixing", () => ({ prepareAudioAsync }));
import {
  __resetWaveformForTests,
  __setWaveformDecoderForTests,
  getWaveform,
  requestWaveform,
  subscribeWaveform,
  type WaveformDecoder,
  WAVEFORM_LRU_LIMIT,
} from "../waveformCache";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

it("keeps 16 sources, so a node's audio clips do not decode in a loop as rows scroll", () => {
  expect(WAVEFORM_LRU_LIMIT).toBe(16);
});

afterEach(() => {
  __resetWaveformForTests();
  vi.unstubAllGlobals();
  prepareAudioAsync.mockReset();
});

/** A decoded two-channel buffer, as prepareAudioAsync gives it. */
const decoded = (channels: number[][], duration: number) =>
  ({
    buffer: {
      numberOfChannels: channels.length,
      getChannelData: (c: number) => new Float32Array(channels[c]),
    },
    duration,
  });

describe("waveformCache", () => {
  it("decodes a key once and keeps its peaks, not its samples", async () => {
    const decode = vi.fn<WaveformDecoder>(async () => ({
      channels: [new Float32Array([0.5, -1, 0.25, 0])],
      duration: 2,
    }));
    __setWaveformDecoderForTests(decode);
    const listener = vi.fn();
    const unsubscribe = subscribeWaveform(listener);
    requestWaveform("k", "blob:m");
    expect(getWaveform("k")).toEqual({ status: "loading", duration: null, peaks: null });
    requestWaveform("k", "blob:m");
    await flush();
    expect(decode).toHaveBeenCalledTimes(1);
    const waveform = getWaveform("k")!;
    expect(waveform.status).toBe("ready");
    expect(waveform.duration).toBe(2);
    expect(Array.from(waveform.peaks!)).toEqual([0.5, 1, 0.25, 0]);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("marks a source that does not decode, or decodes to nothing, as an error", async () => {
    __setWaveformDecoderForTests(async (src) => {
      if (src === "bad") throw new Error("nope");
      return { channels: [], duration: 0 };
    });
    requestWaveform("a", "bad");
    requestWaveform("b", "empty");
    await flush();
    expect(getWaveform("a")?.status).toBe("error");
    expect(getWaveform("b")?.status).toBe("error");
  });

  it("keeps the eight keys used last, and a decode that finishes after its key went writes nothing", async () => {
    let finish: (() => void) | null = null;
    __setWaveformDecoderForTests(
      (src) =>
        new Promise((resolve) => {
          const done = () => resolve({ channels: [new Float32Array([0.1])], duration: 1 });
          if (src === "slow") finish = done;
          else done();
        }),
    );
    requestWaveform("slow", "slow");
    for (let i = 0; i < WAVEFORM_LRU_LIMIT; i++) requestWaveform(`k${i}`, `src${i}`);
    expect(getWaveform("slow")).toBeUndefined();
    expect(getWaveform("k0")).toBeDefined();
    await flush();
    const listener = vi.fn();
    const unsubscribe = subscribeWaveform(listener);
    finish!();
    await flush();
    expect(getWaveform("slow")).toBeUndefined();
    // Nobody is told about a decode nobody shows
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
    // Asking again counts as a use: k0 outlives k1
    requestWaveform("k0", "src0");
    requestWaveform(`k${WAVEFORM_LRU_LIMIT}`, `src${WAVEFORM_LRU_LIMIT}`);
    expect(getWaveform("k0")).toBeDefined();
    expect(getWaveform("k1")).toBeUndefined();
  });

  it("decodes as the stitch does: the data: URL's type on an untyped response, from the start, every channel", async () => {
    const fetchMock = vi.fn(async () => ({ blob: async () => new Blob([new Uint8Array([1, 2, 3])]) }));
    vi.stubGlobal("fetch", fetchMock);
    prepareAudioAsync.mockResolvedValue(decoded([[0.25, 0, 0.1], [0, -0.75, 0.5]], 3));
    const src = "data:audio/wav;base64,AAAA";
    requestWaveform("w", src);
    await vi.waitFor(() => expect(getWaveform("w")?.status).toBe("ready"));
    expect(fetchMock).toHaveBeenCalledWith(src);
    expect(prepareAudioAsync).toHaveBeenCalledTimes(1);
    const [blob, videoDuration] = prepareAudioAsync.mock.calls[0];
    expect((blob as Blob).type).toBe("audio/wav");
    expect(videoDuration).toBe(0);
    // The peak of each sample is the louder of the two channels
    expect(Array.from(getWaveform("w")!.peaks!)).toEqual([0.25, 0.75, 0.5]);
    expect(getWaveform("w")!.duration).toBe(3);
  });

  it("falls back to MP3 for an untyped response that is not a data: URL, and to an error when nothing decodes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ blob: async () => new Blob([new Uint8Array([1])]) })));
    prepareAudioAsync.mockResolvedValue(null);
    requestWaveform("m", "blob:music");
    await vi.waitFor(() => expect(getWaveform("m")?.status).toBe("error"));
    expect((prepareAudioAsync.mock.calls[0][0] as Blob).type).toBe("audio/mpeg");
  });
});
