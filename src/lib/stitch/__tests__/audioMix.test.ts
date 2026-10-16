import { describe, it, expect } from "vitest";
import {
  applyCrossfades,
  applyCurveGain,
  chooseMasterFormat,
  clampSamples,
  mixInto,
  mixLoop,
  pcmFromAudioBuffer,
  pcmHead,
  remix,
  resampleLinear,
  sliceChunksToRange,
  toMasterFormat,
  type LoopMix,
  type Pcm,
  type PcmChunk,
} from "../audioMix";
import { crossfadeGain } from "../stack";

const SR = 1000;

function filled(length: number, value: number | ((i: number) => number)): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = typeof value === "number" ? value : value(i);
  return out;
}

function chunk(timestamp: number, samples: Float32Array, sampleRate = SR): PcmChunk {
  return { sampleRate, channels: [samples], timestamp };
}

describe("pcmFromAudioBuffer", () => {
  it("copies the channels", () => {
    const left = filled(4, 0.5);
    const right = filled(4, -0.5);
    const buffer = { sampleRate: SR, numberOfChannels: 2, length: 4, getChannelData: (c: number) => [left, right][c] };
    const pcm = pcmFromAudioBuffer(buffer, 1.5);
    expect(pcm.timestamp).toBe(1.5);
    expect(pcm.channels[0]).toEqual(left);
    expect(pcm.channels[0]).not.toBe(left);
    expect(pcmFromAudioBuffer(buffer).timestamp).toBe(0);
  });
});

describe("pcmHead", () => {
  it("gives the first frames of each channel as views on the buffer, never more than it holds", () => {
    const left = filled(10, (i) => i);
    const right = filled(10, (i) => -i);
    const buffer = { sampleRate: SR, numberOfChannels: 2, length: 10, getChannelData: (c: number) => [left, right][c] };
    const head = pcmHead(buffer, 3.2);
    expect(head.sampleRate).toBe(SR);
    expect(head.channels.map((c) => Array.from(c))).toEqual([
      [0, 1, 2, 3],
      [-0, -1, -2, -3],
    ]);
    // A view, not a copy
    expect(head.channels[0].buffer).toBe(left.buffer);
    expect(pcmHead(buffer, 50).channels[0]).toHaveLength(10);
    expect(pcmHead(buffer, -1).channels[0]).toHaveLength(0);
  });
});

describe("sliceChunksToRange", () => {
  it("is null for no chunks", () => {
    expect(sliceChunksToRange([], 0, 1)).toBeNull();
  });

  it("gives exactly round((to − from) · sr) samples", () => {
    const pcm = sliceChunksToRange([chunk(0, filled(5000, 1))], 0.2, 1.4565);
    expect(pcm?.channels[0].length).toBe(Math.round(1.2565 * SR));
  });

  it("skips the head before `from` by the chunk's timestamp and cuts the tail", () => {
    // The first chunk is the one in effect at 0.5: it starts at 0.4
    const pcm = sliceChunksToRange(
      [chunk(0.4, filled(200, (i) => i)), chunk(0.6, filled(200, (i) => 200 + i))],
      0.5,
      0.7,
    )!;
    expect(pcm.channels[0].length).toBe(200);
    expect(pcm.channels[0][0]).toBe(100);
    expect(pcm.channels[0][199]).toBe(299);
  });

  it("zero-fills a gap between chunks", () => {
    const pcm = sliceChunksToRange([chunk(0, filled(100, 1)), chunk(0.2, filled(100, 1))], 0, 0.3)!;
    expect(pcm.channels[0][50]).toBe(1);
    expect(pcm.channels[0][150]).toBe(0);
    expect(pcm.channels[0][250]).toBe(1);
  });

  it("puts sound that starts with the video's origin at index 0", () => {
    const pcm = sliceChunksToRange([chunk(0.04, filled(100, (i) => i + 1))], 0.04, 0.1)!;
    expect(pcm.channels[0][0]).toBe(1);
  });

  it("skips round(0.04 · sr) samples of sound that starts before the video's origin", () => {
    const pcm = sliceChunksToRange([chunk(0, filled(100, (i) => i))], 0.04, 0.1)!;
    expect(pcm.channels[0][0]).toBe(40);
  });

  it("leaves no seams between chunks when `from` falls on a half sample", () => {
    // 44.1 kHz from 25/24 s is 45937.5 samples in; AAC-like 1024-sample chunks on whole samples
    const rate = 44100;
    const chunks: PcmChunk[] = [];
    for (let k = 0; k < 300; k++) chunks.push(chunk((k * 1024) / rate, filled(1024, 1), rate));
    const pcm = sliceChunksToRange(chunks, 25 / 24, 25 / 24 + 5)!;
    expect(pcm.channels[0].length).toBe(Math.round(5 * rate));
    expect(pcm.channels[0].every((v) => v === 1)).toBe(true);
  });

  it("converts a chunk in another format to the first one's", () => {
    const pcm = sliceChunksToRange(
      [chunk(0, filled(100, 1)), { sampleRate: 2 * SR, channels: [filled(200, 0.5), filled(200, 0.5)], timestamp: 0.1 }],
      0,
      0.2,
    )!;
    expect(pcm.channels).toHaveLength(1);
    expect(pcm.channels[0][150]).toBeCloseTo(0.5, 6);
  });
});

describe("resampleLinear", () => {
  it("returns the same pcm at the same rate", () => {
    const pcm: Pcm = { sampleRate: SR, channels: [filled(10, 1)] };
    expect(resampleLinear(pcm, SR)).toBe(pcm);
  });

  it("scales the length", () => {
    const pcm: Pcm = { sampleRate: 44100, channels: [filled(44100, 0.25)] };
    const out = resampleLinear(pcm, 48000);
    expect(out.sampleRate).toBe(48000);
    expect(out.channels[0].length).toBe(48000);
    expect(resampleLinear({ sampleRate: 48000, channels: [filled(480, 0)] }, 44100).channels[0].length).toBe(441);
  });

  it("keeps a constant signal constant", () => {
    const out = resampleLinear({ sampleRate: 44100, channels: [filled(1000, 0.25)] }, 48000);
    expect(out.channels[0].every((v) => Math.abs(v - 0.25) < 1e-6)).toBe(true);
  });
});

describe("remix", () => {
  it("duplicates mono into stereo", () => {
    const out = remix({ sampleRate: SR, channels: [filled(3, 0.5)] }, 2);
    expect(out.channels).toHaveLength(2);
    expect(out.channels[1]).toEqual(filled(3, 0.5));
  });

  it("averages stereo into mono", () => {
    const out = remix({ sampleRate: SR, channels: [filled(3, 1), filled(3, 0)] }, 1);
    expect(out.channels).toEqual([filled(3, 0.5)]);
  });

  it("keeps the first two of three channels", () => {
    const out = remix({ sampleRate: SR, channels: [filled(2, 1), filled(2, 2), filled(2, 3)] }, 2);
    expect(out.channels).toEqual([filled(2, 1), filled(2, 2)]);
  });

  it("downmixes 5.1 to stereo, keeping the centre and dropping the LFE", () => {
    // L, R, C, LFE, SL, SR
    const out = remix(
      { sampleRate: SR, channels: [filled(2, 0.1), filled(2, 0.2), filled(2, 0.4), filled(2, 1), filled(2, 0.3), filled(2, 0.05)] },
      2,
    );
    expect(out.channels).toHaveLength(2);
    expect(out.channels[0][0]).toBeCloseTo(0.1 + Math.SQRT1_2 * (0.4 + 0.3), 6);
    expect(out.channels[1][0]).toBeCloseTo(0.2 + Math.SQRT1_2 * (0.4 + 0.05), 6);
  });

  it("downmixes quad to stereo", () => {
    const out = remix({ sampleRate: SR, channels: [filled(2, 0.2), filled(2, 0.4), filled(2, 0.6), filled(2, 0.8)] }, 2);
    expect(out.channels[0][0]).toBeCloseTo(0.4, 6);
    expect(out.channels[1][0]).toBeCloseTo(0.6, 6);
  });

  it("toMasterFormat remixes and resamples", () => {
    const out = toMasterFormat({ sampleRate: 500, channels: [filled(50, 0.5)] }, { sampleRate: SR, channels: 2 });
    expect(out.sampleRate).toBe(SR);
    expect(out.channels).toHaveLength(2);
    expect(out.channels[0].length).toBe(100);
  });
});

describe("chooseMasterFormat", () => {
  it("takes the music's rate when the music is the only source", () => {
    expect(chooseMasterFormat({ sampleRate: 24000, channels: 1 }, [])).toEqual({ sampleRate: 24000, channels: 1 });
  });

  it("takes the highest rate when clip sound plays under the music", () => {
    expect(chooseMasterFormat({ sampleRate: 44100, channels: 1 }, [{ sampleRate: 48000, channels: 2 }])).toEqual({
      sampleRate: 48000,
      channels: 2,
    });
    // A 24 kHz voice-over does not drag a 48 kHz clip down
    expect(chooseMasterFormat({ sampleRate: 24000, channels: 1 }, [{ sampleRate: 48000, channels: 1 }])?.sampleRate).toBe(48000);
    expect(chooseMasterFormat({ sampleRate: 48000, channels: 2 }, [{ sampleRate: 22050, channels: 1 }])?.sampleRate).toBe(48000);
  });

  it("takes the highest clip rate without music", () => {
    expect(chooseMasterFormat(null, [{ sampleRate: 48000, channels: 1 }, { sampleRate: 44100, channels: 1 }])).toEqual({
      sampleRate: 48000,
      channels: 1,
    });
  });

  it("caps the channels at 2", () => {
    expect(chooseMasterFormat(null, [{ sampleRate: 48000, channels: 6 }])?.channels).toBe(2);
  });

  it("is null with nothing to hear", () => {
    expect(chooseMasterFormat(null, [])).toBeNull();
  });
});

describe("mixInto", () => {
  it("adds at an offset with a gain, ignoring what falls outside", () => {
    const target = [filled(5, 1)];
    mixInto(target, [filled(4, 1)], 3, 0.5);
    expect([...target[0]]).toEqual([1, 1, 1, 1.5, 1.5]);
    mixInto(target, [filled(4, 1)], -3, 1);
    expect(target[0][0]).toBe(2);
    expect(target[0][1]).toBe(1);
  });
});

describe("applyCurveGain", () => {
  it("changes nothing for an empty curve", () => {
    const channels = [filled(SR, 1)];
    applyCurveGain(channels, SR, []);
    expect(channels[0].every((v) => v === 1)).toBe(true);
  });

  it("zeroes the samples around a dip to 0", () => {
    const channels = [filled(2 * SR, 1)];
    applyCurveGain(channels, SR, [
      { t: 0.5, gain: 1 },
      { t: 1, gain: 0 },
      { t: 1.5, gain: 1 },
    ]);
    expect(channels[0][0]).toBe(1);
    expect(Math.abs(channels[0][SR])).toBeLessThan(0.01);
    expect(channels[0][Math.round(0.75 * SR)]).toBeGreaterThan(0);
    expect(channels[0][Math.round(0.75 * SR)]).toBeLessThan(1);
    expect(channels[0][2 * SR - 1]).toBe(1);
  });

  it("ramps straight inside a block", () => {
    const channels = [filled(8, 1)];
    applyCurveGain(channels, SR, [{ t: 0, gain: 1 }, { t: 0.008, gain: 0 }], 0, 8);
    // gain at 0 is 1, at 8 samples 0: each sample steps down by 1/8
    expect(channels[0][4]).toBeCloseTo(0.5, 6);
  });

  it("reads the curve from startSec", () => {
    const channels = [filled(10, 1)];
    applyCurveGain(channels, SR, [{ t: 5, gain: 1 }, { t: 5.001, gain: 0 }], 6);
    expect(channels[0].every((v) => v === 0)).toBe(true);
  });
});

describe("clampSamples", () => {
  it("clips to ±1 and silences NaN", () => {
    const channels = [Float32Array.from([2, -3, 0.5, Number.NaN])];
    clampSamples(channels);
    expect([...channels[0]]).toEqual([1, -1, 0.5, 0]);
  });
});

describe("mixLoop", () => {
  const format = { sampleRate: SR, channels: 1 as const };

  it("lays clips out at their sequence starts with their gains", () => {
    const mix: LoopMix = {
      format,
      loopLength: 1,
      clips: [
        { pcm: { sampleRate: SR, channels: [filled(500, 0.4)] }, seqStart: 0, gain: 1 },
        { pcm: { sampleRate: SR, channels: [filled(500, 0.4)] }, seqStart: 0.5, gain: 0.5 },
      ],
      music: null,
    };
    const [out] = mixLoop(mix, 0);
    expect(out.length).toBe(SR);
    expect(out[100]).toBeCloseTo(0.4, 6);
    expect(out[700]).toBeCloseTo(0.2, 6);
  });

  it("leaves silence where a muted clip would be (it is not listed)", () => {
    const [out] = mixLoop({ format, loopLength: 1, clips: [], music: null }, 0);
    expect(out.every((v) => v === 0)).toBe(true);
  });

  it("reads loop 1's music from loopSamples on", () => {
    const music = { pcm: { sampleRate: SR, channels: [filled(2 * SR, (i) => (i < SR ? 0.1 : 0.2))] }, curve: [] };
    expect(mixLoop({ format, loopLength: 1, clips: [], music }, 0)[0][10]).toBeCloseTo(0.1, 6);
    expect(mixLoop({ format, loopLength: 1, clips: [], music }, 1)[0][10]).toBeCloseTo(0.2, 6);
  });

  it("gives silence after music shorter than the loop", () => {
    const music = { pcm: { sampleRate: SR, channels: [filled(SR / 2, 0.3)] }, curve: [] };
    const [out] = mixLoop({ format, loopLength: 1, clips: [], music }, 0);
    expect(out[100]).toBeCloseTo(0.3, 6);
    expect(out[800]).toBe(0);
    expect(mixLoop({ format, loopLength: 1, clips: [], music }, 1)[0].every((v) => v === 0)).toBe(true);
  });

  it("applies the curve to the music only, again each loop", () => {
    const music = { pcm: { sampleRate: SR, channels: [filled(2 * SR, 0.5)] }, curve: [{ t: 0, gain: 0 }] };
    const clip = { pcm: { sampleRate: SR, channels: [filled(SR, 0.25)] }, seqStart: 0, gain: 1 };
    for (const loop of [0, 1]) {
      const [out] = mixLoop({ format, loopLength: 1, clips: [clip], music }, loop);
      expect(out[500]).toBeCloseTo(0.25, 6);
    }
  });

  it("restarts the curve each loop while the music runs on", () => {
    // A fade from full to nothing over the one-second loop
    const music = { pcm: { sampleRate: SR, channels: [filled(2 * SR, 0.5)] }, curve: [{ t: 0, gain: 1 }, { t: 1, gain: 0 }] };
    for (const loop of [0, 1]) {
      const [out] = mixLoop({ format, loopLength: 1, clips: [], music }, loop);
      // Near full at the loop's start (the gain ramps inside each block), near nothing at its end
      expect(out[10]).toBeCloseTo(0.5, 1);
      expect(out[990]).toBeLessThan(0.01);
    }
  });

  it("passes one source's overs through unclipped, and silences NaN", () => {
    const loud = filled(SR, 1.2);
    loud[3] = Number.NaN;
    const [clipsOnly] = mixLoop({ format, loopLength: 1, clips: [{ pcm: { sampleRate: SR, channels: [loud] }, seqStart: 0, gain: 1 }], music: null }, 0);
    expect(clipsOnly[10]).toBeCloseTo(1.2, 6);
    expect(clipsOnly[3]).toBe(0);
    const [musicOnly] = mixLoop({ format, loopLength: 1, clips: [], music: { pcm: { sampleRate: SR, channels: [filled(SR, 1.2)] }, curve: [] } }, 0);
    expect(musicOnly[10]).toBeCloseTo(1.2, 6);
  });

  it("clamps the sum", () => {
    const music = { pcm: { sampleRate: SR, channels: [filled(SR, 0.9)] }, curve: [] };
    const clip = { pcm: { sampleRate: SR, channels: [filled(SR, 0.9)] }, seqStart: 0, gain: 1 };
    const [out] = mixLoop({ format, loopLength: 1, clips: [clip], music }, 0);
    expect(out[10]).toBe(1);
  });
});

describe("applyCrossfades", () => {
  it("fades in, fades out, and silences what follows the fade out", () => {
    const channel = filled(100, 1);
    applyCrossfades([channel], { inLength: 10, outStart: 60, outLength: 20 });
    expect(channel[0]).toBeCloseTo(crossfadeGain(0.5 / 10, "in"), 6);
    expect(channel[9]).toBeCloseTo(crossfadeGain(9.5 / 10, "in"), 6);
    expect(channel[10]).toBe(1);
    expect(channel[59]).toBe(1);
    expect(channel[60]).toBeCloseTo(crossfadeGain(0.5 / 20, "out"), 6);
    expect(channel[79]).toBeCloseTo(crossfadeGain(19.5 / 20, "out"), 6);
    expect(channel.slice(80).every((v) => v === 0)).toBe(true);
  });

  it("changes nothing at zero lengths", () => {
    const channel = filled(50, 0.5);
    applyCrossfades([channel], { inLength: 0, outStart: 0, outLength: 0 });
    expect(channel.every((v) => v === 0.5)).toBe(true);
  });

  it("fades every channel", () => {
    const channels = [filled(20, 1), filled(20, -1)];
    applyCrossfades(channels, { inLength: 4, outStart: 10, outLength: 4 });
    expect(channels[1][0]).toBeCloseTo(-channels[0][0], 6);
    expect(channels[1][19]).toBe(0);
  });

  it("keeps a constant A fading out and a constant B fading in at constant power", () => {
    // A at 0 for 100 samples, B from 70: a 30-sample overlap
    const a = filled(100, 1);
    const b = filled(100, 1);
    applyCrossfades([a], { inLength: 0, outStart: 70, outLength: 30 });
    applyCrossfades([b], { inLength: 30, outStart: 0, outLength: 0 });
    for (let i = 0; i < 30; i++) expect(a[70 + i] ** 2 + b[i] ** 2).toBeCloseTo(1, 6);
  });
});

describe("mixLoop with overlapping clips", () => {
  const format = { sampleRate: SR, channels: 1 } as const;

  it("clamps when the engine says the clips overlap", () => {
    const a = { pcm: { sampleRate: SR, channels: [filled(600, 0.8)] }, seqStart: 0, gain: 1 };
    const b = { pcm: { sampleRate: SR, channels: [filled(600, 0.8)] }, seqStart: 0.4, gain: 1 };
    const [out] = mixLoop({ format, loopLength: 1, clips: [a, b], music: null, clipsOverlap: true }, 0);
    expect(out[100]).toBeCloseTo(0.8, 6);
    expect(out[500]).toBe(1);
  });

  it("lets one source's overs pass without the flag", () => {
    const loud = { pcm: { sampleRate: SR, channels: [filled(SR, 1.2)] }, seqStart: 0, gain: 1 };
    const [out] = mixLoop({ format, loopLength: 1, clips: [loud], music: null }, 0);
    expect(out[10]).toBeCloseTo(1.2, 6);
    const [flagged] = mixLoop({ format, loopLength: 1, clips: [loud], music: null, clipsOverlap: false }, 0);
    expect(flagged[10]).toBeCloseTo(1.2, 6);
  });
});
