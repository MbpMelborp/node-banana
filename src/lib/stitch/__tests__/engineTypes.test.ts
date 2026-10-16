import { describe, it, expect } from "vitest";
import {
  isMusicInput,
  normalizeLoopCount,
  normalizeStack,
  normalizeStitchArgs,
  type StitchAudioData,
  type StitchClipInput,
} from "../engineTypes";

const audio = { buffer: { sampleRate: 48000 } as unknown as AudioBuffer, duration: 2 } satisfies StitchAudioData;
const a = new Blob(["a"], { type: "video/mp4" });
const b = new Blob(["b"], { type: "video/mp4" });

describe("normalizeStitchArgs", () => {
  it("mutes bare Blobs under bare music: the old engine let the music replace their sound", () => {
    const { clips, music } = normalizeStitchArgs([a, b], audio);
    expect(clips).toEqual([
      { blob: a, inSec: 0, outSec: null, muted: true, volume: 1 },
      { blob: b, inSec: 0, outSec: null, muted: true, volume: 1 },
    ]);
    expect(music).toEqual({ audio, curve: [], muted: false });
  });

  it("keeps bare Blobs' sound without music", () => {
    for (const none of [null, undefined]) {
      const { clips, music } = normalizeStitchArgs([a], none);
      expect(clips[0].muted).toBe(false);
      expect(music).toBeNull();
    }
  });

  it("passes explicit inputs and music through", () => {
    const clip = { blob: a, inSec: 0.8, outSec: 5, muted: false, volume: 0.5 };
    const input = { audio, curve: [{ t: 1, gain: 0 }], muted: true };
    const { clips, music } = normalizeStitchArgs([clip], input);
    expect(clips).toEqual([clip]);
    expect(music).toBe(input);
  });

  it("does not mute explicit clips under bare music", () => {
    const { clips } = normalizeStitchArgs([{ blob: a, inSec: 0, outSec: null, muted: false, volume: 1 }], audio);
    expect(clips[0].muted).toBe(false);
  });

  it("makes In, Out and volume usable", () => {
    const { clips } = normalizeStitchArgs([{ blob: a, inSec: Number.NaN, outSec: Infinity, muted: false, volume: 3 }], null);
    expect(clips[0]).toMatchObject({ inSec: 0, outSec: null, volume: 1 });
    expect(normalizeStitchArgs([{ blob: a, inSec: -2, outSec: null, muted: false, volume: -1 }], null).clips[0]).toMatchObject({
      inSec: 0,
      volume: 0,
    });
  });

  it("keeps a clip's source key when it is a non-empty string, and drops anything else", () => {
    const base = { blob: a, inSec: 0, outSec: null, muted: false, volume: 1 };
    const read = (source: unknown) =>
      normalizeStitchArgs([{ ...base, source } as unknown as StitchClipInput], null).clips[0];
    expect(read("edge:e1").source).toBe("edge:e1");
    for (const junk of ["", 7, null, {}]) expect(read(junk)).not.toHaveProperty("source");
    expect(normalizeStitchArgs([a], null).clips[0]).not.toHaveProperty("source");
  });

  it("tells music from a bare buffer", () => {
    expect(isMusicInput(audio)).toBe(false);
    expect(isMusicInput({ audio, curve: [], muted: false })).toBe(true);
  });
});

describe("normalizeLoopCount", () => {
  it("is a whole number, at least 1", () => {
    expect(normalizeLoopCount(undefined)).toBe(1);
    expect(normalizeLoopCount({})).toBe(1);
    expect(normalizeLoopCount({ loopCount: 3 })).toBe(3);
    expect(normalizeLoopCount({ loopCount: 2.7 })).toBe(2);
    expect(normalizeLoopCount({ loopCount: 0 })).toBe(1);
    expect(normalizeLoopCount({ loopCount: Number.NaN })).toBe(1);
  });
});

describe("normalizeStack", () => {
  it("is null without a positive, finite overlap: the clips butt", () => {
    expect(normalizeStack(undefined)).toBeNull();
    expect(normalizeStack({ loopCount: 2 })).toBeNull();
    expect(normalizeStack({ overlapSec: 0 })).toBeNull();
    expect(normalizeStack({ overlapSec: -1 })).toBeNull();
    expect(normalizeStack({ overlapSec: Number.NaN })).toBeNull();
    expect(normalizeStack({ overlapSec: Infinity })).toBeNull();
  });

  it("caps the overlap at 10 s and crossfades unless told not to", () => {
    expect(normalizeStack({ overlapSec: 12 })).toEqual({ overlapSec: 10, crossfade: true });
    expect(normalizeStack({ overlapSec: 1 })).toEqual({ overlapSec: 1, crossfade: true });
    expect(normalizeStack({ overlapSec: 1, crossfade: false })).toEqual({ overlapSec: 1, crossfade: false });
  });
});
