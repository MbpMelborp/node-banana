import { describe, it, expect } from "vitest";
import type { ClipWarp, ClipWarpCurve } from "@/types";
import type { Pcm } from "../audioMix";
import { normalizeWarp, splitWarp, warpMap, type WarpMap } from "../warp";
import { sincKernel, warpResample, warpSoundMargin } from "../warpAudio";

const SR = 16000;

const W = (speed: number, extra: Partial<ClipWarp> = {}): ClipWarp => ({
  speed,
  curve: null,
  reverse: false,
  blend: false,
  ...extra,
});
const EASE_IN_OUT: ClipWarpCurve = { kind: "preset", name: "easeInOutCubic" };

const tone = (hz: number, amplitude = 0.5) => (t: number) => amplitude * Math.sin(2 * Math.PI * hz * t);

/** The source's sound over [from, to) at sr, as the engine decodes it: index 0 is source sample round(from · sr). */
function decoded(fill: (t: number) => number, from: number, to: number, sr: number): { pcm: Pcm; firstSample: number } {
  const firstSample = Math.round(from * sr);
  const channel = new Float32Array(Math.round((to - from) * sr));
  for (let j = 0; j < channel.length; j++) channel[j] = fill((firstSample + j) / sr);
  return { pcm: { sampleRate: sr, channels: [channel] }, firstSample };
}

/** A clip's sound through its warp map, decoded with the margin either side as the engine decodes it. */
async function render(fill: (t: number) => number, m: WarpMap, sr = SR, outRate = sr) {
  const margin = warpSoundMargin(sr);
  const { inSec, outSec } = m.range;
  const { pcm, firstSample } = decoded(fill, Math.max(0, inSec - margin), outSec + margin, sr);
  const out = await warpResample({
    pcm,
    firstSample,
    sourceAt: m.sourceTimeAt,
    speedAt: m.speedAt,
    length: m.length,
    sampleRate: outRate,
  });
  return out.channels[0];
}

/** The amplitude of `hz` in a signal holding whole cycles of it. */
function goertzel(y: Float32Array, hz: number, sr: number): number {
  const w = (2 * Math.PI * hz) / sr;
  const coefficient = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (const x of y) {
    const s0 = x + coefficient * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return (2 * Math.sqrt(s1 * s1 + s2 * s2 - coefficient * s1 * s2)) / y.length;
}

const rms = (y: ArrayLike<number>) => Math.sqrt(Array.from(y).reduce((sum, x) => sum + x * x, 0) / y.length);
/** The largest |y[i] − want(i)|. */
const worst = (y: ArrayLike<number>, want: (i: number) => number) => {
  let most = 0;
  for (let i = 0; i < y.length; i++) most = Math.max(most, Math.abs(y[i] - want(i)));
  return most;
};

describe("warpResample", () => {
  it("gives exactly round(length · sampleRate) samples, in new arrays", async () => {
    for (const samples of [1000.4, 1000.5, 999.6]) {
      const { pcm, firstSample } = decoded(() => 0.5, 0, 1, SR);
      const out = await warpResample({ pcm, firstSample, sourceAt: (o) => o, speedAt: () => 1, length: samples / SR, sampleRate: SR });
      expect(out.channels[0]).toHaveLength(Math.round(samples));
      expect(out.channels[0]).not.toBe(pcm.channels[0]);
      expect(out.sampleRate).toBe(SR);
    }
  });

  it("keeps a level through slow motion, and a 1 kHz tone through 1× at its own rate", async () => {
    const dc = await render(() => 0.5, warpMap({ inSec: 1, outSec: 1.5 }, W(0.5)));
    expect(worst(dc, () => 0.5)).toBeLessThanOrEqual(1e-6);

    const fill = tone(1000);
    const y = await render(fill, warpMap({ inSec: 1, outSec: 1.25 }, W(1)), 48000);
    expect(worst(y, (i) => fill(1 + i / 48000))).toBeLessThanOrEqual(1e-5);
  });

  it("plays a tone an octave up at 2×, its edges as the source sounds there", async () => {
    const fill = tone(440);
    const y = await render(fill, warpMap({ inSec: 1, outSec: 2 }, W(2)));
    expect(y).toHaveLength(8000);
    expect(goertzel(y, 880, SR)).toBeGreaterThanOrEqual(0.49);
    expect(goertzel(y, 440, SR)).toBeLessThanOrEqual(1e-3);
    // The kernel reads the margin's real sound past In and Out, not silence
    const want = (i: number) => fill(1 + (2 * i) / SR);
    expect(worst(y.subarray(0, 64), want)).toBeLessThanOrEqual(1e-4);
    expect(worst(y.subarray(y.length - 64), (i) => want(y.length - 64 + i))).toBeLessThanOrEqual(1e-4);
  });

  it("filters what fast motion would fold back, and keeps what it would not", async () => {
    const above = await render(tone(15000), warpMap({ inSec: 1, outSec: 1.5 }, W(2)), 48000);
    expect(rms(above)).toBeLessThan(1e-4 * (0.5 / Math.SQRT2));
    const below = await render(tone(10000), warpMap({ inSec: 1, outSec: 1.5 }, W(2)), 48000);
    const db = 20 * Math.log10(rms(below) / (0.5 / Math.SQRT2));
    expect(Math.abs(db)).toBeLessThanOrEqual(0.5);
  });

  it("converts the rate in the same step: a 32 kHz source into a 48 kHz master at 2×", async () => {
    const m = warpMap({ inSec: 1, outSec: 1.5 }, W(2));
    const up = await render(tone(3000), m, 32000, 48000);
    expect(up).toHaveLength(12000);
    expect(goertzel(up, 6000, 48000)).toBeCloseTo(0.5, 2);
    const folded = await render(tone(14000), m, 32000, 48000);
    expect(Math.max(...Array.from(folded, Math.abs))).toBeLessThan(1e-4);
    // Between the band of 1/speed (7.5 kHz of source) and the master's (11.3 kHz): kept, as the master can hold it
    const kept = await render(tone(9000), m, 32000, 48000);
    expect(goertzel(kept, 18000, 48000)).toBeCloseTo(0.5, 2);
  });

  it("plays backwards when reversed", async () => {
    const fill = tone(300);
    const y = await render(fill, warpMap({ inSec: 1, outSec: 1.5 }, W(1, { reverse: true })));
    expect(worst(y, (i) => fill(1.5 - i / SR))).toBeLessThanOrEqual(1e-5);

    // A chirp rising from 200 to 1000 Hz falls when reversed: fewer zero crossings in its second half
    const chirp = (t: number) => 0.5 * Math.sin(2 * Math.PI * (200 * (t - 1) + 400 * (t - 1) ** 2));
    const back = await render(chirp, warpMap({ inSec: 1, outSec: 2 }, W(1, { reverse: true })));
    const crossings = (from: number, to: number) => {
      let count = 0;
      for (let i = from + 1; i < to; i++) if (Math.sign(back[i]) !== Math.sign(back[i - 1])) count++;
      return count;
    };
    expect(crossings(0, SR / 2)).toBeGreaterThan(1.5 * crossings(SR / 2, SR));
  });

  it("glides through a ramp with no step larger than the tone's own at its fastest, its faded ends included", async () => {
    // easeInOutCubic at 1× on average peaks at 3×
    const m = warpMap({ inSec: 1, outSec: 2 }, normalizeWarp(W(1, { curve: EASE_IN_OUT }))!);
    const y = await render(tone(440), m);
    const bound = ((2 * Math.PI * 440 * 3) / SR) * 0.5 * 1.05;
    // Each sample's step from the one before
    expect(Math.max(...y.subarray(1).map((x, i) => Math.abs(x - y[i])))).toBeLessThanOrEqual(bound);
  });

  it("joins a split ramp's two pieces as the unsplit clip sounds", async () => {
    const warp = normalizeWarp(W(1, { curve: { kind: "preset", name: "easeInCubic" } }))!;
    const fill = tone(523);
    const whole = await render(fill, warpMap({ inSec: 2, outSec: 5 }, warp));
    // 1.25 s of output is a whole number of samples
    const pieces = splitWarp({ inSec: 2, outSec: 5 }, warp, 1.25)!;
    const first = await render(fill, warpMap(pieces.first.range, pieces.first.warp));
    const second = await render(fill, warpMap(pieces.second.range, pieces.second.warp));
    expect(first.length + second.length).toBe(whole.length);
    const joined = [...first, ...second];
    expect(worst(joined, (i) => whole[i])).toBeLessThanOrEqual(1e-3);
  });

  it("rejects once aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { pcm, firstSample } = decoded(() => 0.5, 0, 1, SR);
    await expect(
      warpResample({ pcm, firstSample, sourceAt: (o) => o, speedAt: () => 1, length: 1, sampleRate: SR, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("is silent while the picture holds, and finite through an exponential ramp", async () => {
    const flat: ClipWarpCurve = {
      kind: "points",
      points: [
        [0, 0],
        [0.4, 0.5],
        [0.6, 0.5],
        [1, 1],
      ],
    };
    // 1 s of output: the flat is [0.4, 0.6) s
    const held = await render(tone(440), warpMap({ inSec: 1, outSec: 2 }, normalizeWarp(W(1, { curve: flat }))!));
    expect(worst(held.subarray(Math.round(0.402 * SR), Math.round(0.598 * SR)), () => 0)).toBe(0);

    const expo = normalizeWarp(W(10, { curve: { kind: "preset", name: "easeInExpo" } }))!;
    const fast = await render(tone(440), warpMap({ inSec: 1, outSec: 6 }, expo));
    expect(fast.every(Number.isFinite)).toBe(true);
  });

  it("keeps an Expo ramp's jump at either end as quiet as the slow speed beside it: no burst, no click", async () => {
    // A level through 2 s at 1× on average, In past the margin: the ends' first and last millisecond against 20 ms a
    // millisecond in, where the speed (about 0.007×) has barely moved
    const ms = SR / 1000;
    for (const [name, start, end] of [
      ["easeInExpo", true, false],
      ["easeOutExpo", false, true],
      ["easeInOutExpo", true, true],
      ["easeInExpoOutCubic", true, false],
    ] as const) {
      const m = warpMap({ inSec: 2, outSec: 4 }, normalizeWarp(W(1, { curve: { kind: "preset", name } }))!);
      const y = await render(() => 0.5, m);
      const peak = (from: number, to: number) => Math.max(...Array.from(y.subarray(from, to), Math.abs));
      if (start) expect(peak(0, ms), name).toBeLessThanOrEqual(1.1 * peak(2 * ms, 22 * ms));
      if (end) expect(peak(y.length - ms, y.length), name).toBeLessThanOrEqual(1.1 * peak(y.length - 22 * ms, y.length - 2 * ms));
    }
  });

  it("fades out below a quarter speed, and keeps the level from a quarter speed up", async () => {
    const m = warpMap({ inSec: 1, outSec: 3 }, normalizeWarp(W(1, { curve: EASE_IN_OUT }))!);
    const y = await render(() => 0.5, m);
    // At both ends the speed is about 0
    expect(Math.abs(y[0])).toBeLessThan(1e-5);
    expect(Math.abs(y[y.length - 1])).toBeLessThan(1e-5);
    // The speed is 12 p² at the start: 0.125× at p = 0.10206
    expect(y[Math.round(0.10206 * 2 * SR)]).toBeCloseTo(0.25, 3);
    expect(worst(y, (i) => (m.speedAt(i / SR) >= 0.26 ? 0.5 : y[i]))).toBeLessThanOrEqual(1e-6);
  });

  it("reads silence before the file's start and past its end: a band-limited step at each, within a millisecond", async () => {
    // A 1 s file at a 0.5 level, all of it at 2×: nothing is decoded before In 0 or past Out, the file's end
    const { pcm, firstSample } = decoded(() => 0.5, 0, 1, SR);
    const m = warpMap({ inSec: 0, outSec: 1 }, W(2));
    const out = await warpResample({ pcm, firstSample, sourceAt: m.sourceTimeAt, speedAt: m.speedAt, length: m.length, sampleRate: SR });
    const y = out.channels[0];
    const ms = SR / 1000;
    // The first sample's kernel reads the file from its centre on: its weight before 0 still counts, so not the level
    expect(y[0]).toBeGreaterThan(0.3);
    expect(y[0]).toBeLessThan(0.4);
    // The kernel is wholly inside the file from about a millisecond in
    expect(worst(y.subarray(2 * ms, y.length - 2 * ms), () => 0.5)).toBeLessThanOrEqual(1e-6);
    // Either edge rings as a band-limited step does, below its 9 %; the last sample reads 2 source samples before the end
    for (const edge of [y.subarray(0, 2 * ms), y.subarray(y.length - 2 * ms)]) {
      expect(Math.max(...edge)).toBeGreaterThan(0.5);
      expect(Math.max(...edge)).toBeLessThan(0.5 * 1.09);
    }
  });
});

describe("sincKernel", () => {
  it("is 1 at its centre, crosses zero at every whole sample, and ends at its 16th", () => {
    expect(sincKernel(0)).toBe(1);
    for (let k = 1; k < 16; k++) expect(Math.abs(sincKernel(k))).toBeLessThan(1e-6);
    expect(sincKernel(16)).toBe(0);
    expect(sincKernel(40)).toBe(0);
  });
});
