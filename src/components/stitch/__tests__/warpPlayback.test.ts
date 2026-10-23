import { describe, it, expect } from "vitest";
import type { ClipWarp, ClipWarpCurve } from "@/types";
import { warpMap, type WarpMap } from "@/lib/stitch/warp";
import {
  MAX_PLAYBACK_RATE,
  MIN_PLAYBACK_RATE,
  MIN_START_RATE,
  atEnd,
  baseRate,
  driftScale,
  driven,
  endPoint,
  playableRate,
  reversed,
  shownPoint,
  silenced,
  soundShare,
  startRate,
  writeRate,
} from "../warpPlayback";

// The preview's playing rules for a retimed clip, on maps from warp.ts and stand-in elements.

const W = (speed: number, curve: ClipWarpCurve | null = null, extra: Partial<ClipWarp> = {}): ClipWarp => ({
  speed,
  curve,
  reverse: false,
  blend: false,
  ...extra,
});
const SINE: ClipWarpCurve = { kind: "preset", name: "easeInOutSine" };
const QUAD: ClipWarpCurve = { kind: "preset", name: "easeInQuad" };

/** A map over [0, len] of source. */
const mapOf = (warp: ClipWarp, len = 10) => warpMap({ inSec: 0, outSec: len }, warp);

/** An element whose playbackRate setter is Chromium's: 0 or 1/16-16, anything else throws and the rate is kept. */
function chromiumRate(initial = 1) {
  let rate = initial;
  let sets = 0;
  return {
    get playbackRate() {
      return rate;
    },
    set playbackRate(value: number) {
      sets++;
      if (!Number.isFinite(value)) throw new TypeError("The provided double value is non-finite.");
      if (!(value === 0 || (value >= 0.0625 && value <= 16))) throw new DOMException("Not supported", "NotSupportedError");
      rate = value;
    },
    get sets() {
      return sets;
    },
  };
}

const asMedia = (value: object) => value as unknown as HTMLMediaElement;

describe("playableRate", () => {
  it("clamps into 1/16-16, and writes nothing at or below 0 (never standing an element still) or for NaN", () => {
    expect(playableRate(0)).toBeNull();
    expect(playableRate(-1)).toBeNull();
    expect(playableRate(-Infinity)).toBeNull();
    expect(playableRate(0.01)).toBe(0.0625);
    expect(playableRate(0.0625)).toBe(0.0625);
    expect(playableRate(3)).toBe(3);
    expect(playableRate(16)).toBe(16);
    expect(playableRate(17)).toBe(16);
    expect(playableRate(Infinity)).toBe(16);
    expect(playableRate(Number.NaN)).toBeNull();
  });
});

describe("writeRate", () => {
  it("never throws, and leaves the element at a rate Chromium plays, never 0", () => {
    const cases: Array<[number, number]> = [
      [-5, 2],
      [Number.NaN, 2],
      [0, 2],
      [Infinity, 16],
      [17, 16],
      [0.01, 0.0625],
      [0.0625, 0.0625],
      [3, 3],
      [16, 16],
    ];
    for (const [value, rate] of cases) {
      const el = chromiumRate(2);
      expect(() => writeRate(asMedia(el), value)).not.toThrow();
      expect(el.playbackRate).toBe(rate);
    }
  });

  it("does not write the rate the element already has", () => {
    const el = chromiumRate(2);
    writeRate(asMedia(el), 2);
    expect(el.sets).toBe(0);
    writeRate(asMedia(el), 2.5);
    expect(el.sets).toBe(1);
    expect(el.playbackRate).toBe(2.5);
  });

  it("keeps the rate it had when the browser refuses every write, without throwing", () => {
    const el = {
      get playbackRate() {
        return 1;
      },
      set playbackRate(_value: number) {
        throw new DOMException("Not supported", "NotSupportedError");
      },
    };
    expect(() => writeRate(asMedia(el), 2)).not.toThrow();
    expect(el.playbackRate).toBe(1);
  });
});

describe("driftScale and startRate", () => {
  it("weigh a drift by the rate, never by less than a quarter", () => {
    expect(driftScale(0)).toBe(0.25);
    expect(driftScale(0.1)).toBe(0.25);
    expect(driftScale(2)).toBe(2);
  });

  it("start an element within what it plays", () => {
    expect(startRate(0)).toBe(MIN_PLAYBACK_RATE);
    expect(startRate(30)).toBe(MAX_PLAYBACK_RATE);
    expect(startRate(2)).toBe(2);
  });
});

describe("baseRate", () => {
  it("is a constant warp's speed exactly", () => {
    const map = mapOf(W(2), 20);
    for (let k = 0; k < 50; k++) expect(baseRate(map, (k / 49) * map.length)).toBe(2);
  });

  it("is a ramp's mean over the next frame, the last frame's near the end", () => {
    const map = mapOf(W(1, SINE));
    const frame = 1 / 60;
    for (let k = 0; k < 50; k++) {
      const o = (k / 49) * (map.length - frame);
      const secant = (map.sourceTimeAt(o + frame) - map.sourceTimeAt(o)) * 60;
      expect(Math.abs(baseRate(map, o) - secant)).toBeLessThanOrEqual(1e-9 * Math.max(1, secant));
    }
    const last = (map.sourceTimeAt(map.length) - map.sourceTimeAt(map.length - frame)) * 60;
    expect(baseRate(map, map.length - 0.001)).toBeCloseTo(last, 9);
  });

  it("is a ramp's average speed when it is shorter than a frame, and never negative reversed", () => {
    const short = warpMap({ inSec: 0, outSec: 0.01 }, W(1, SINE));
    expect(baseRate(short, 0)).toBeCloseTo(1, 9);
    const back = mapOf(W(1, SINE, { reverse: true }));
    for (let k = 0; k <= 20; k++) expect(baseRate(back, (k / 20) * back.length)).toBeGreaterThanOrEqual(0);
  });
});

describe("driven", () => {
  it("drives a reversed clip by seeks at any speed", () => {
    expect(driven(mapOf(W(1, null, { reverse: true })), 2, false)).toBe(true);
    expect(driven(mapOf(W(4, SINE, { reverse: true })), 1, true)).toBe(true);
  });

  it("plays a constant speed an element plays, and drives one slower", () => {
    expect(driven(mapOf(W(2)), 1, false)).toBe(false);
    expect(driven(mapOf(W(0.1)), 1, false)).toBe(false);
    expect(driven(mapOf(W(0.0625)), 1, false)).toBe(false);
    expect(driven(mapOf(W(0.05)), 1, false)).toBe(true);
    expect(driven(mapOf(W(0.05)), 1, true)).toBe(true);
  });

  it("starts a ramp only from a quarter speed up, and plays it on down to 1/16", () => {
    // easeInQuad over 10 s at 1×: its rate is about offset / 5
    const map = mapOf(W(1, QUAD));
    const at = (rate: number) => rate * 5;
    expect(driven(map, 0, false)).toBe(true);
    expect(driven(map, at(0.2), false)).toBe(true);
    expect(baseRate(map, at(0.3))).toBeGreaterThan(MIN_START_RATE);
    expect(driven(map, at(0.3), false)).toBe(false);
    // Already playing, it goes on below a quarter
    expect(driven(map, at(0.1), true)).toBe(false);
    expect(driven(map, at(0.05), true)).toBe(true);
  });
});

describe("soundShare", () => {
  it("fades a clip's own sound below a quarter speed, as the render does", () => {
    expect(soundShare(0)).toBe(0);
    expect(soundShare(0.125)).toBe(0.5);
    expect(soundShare(0.25)).toBe(1);
    expect(soundShare(2)).toBe(1);
  });
});

describe("reversed and silenced", () => {
  const cases: Array<[string, ClipWarp, boolean, boolean]> = [
    ["reversed 1×", W(1, null, { reverse: true }), true, true],
    ["constant 5×", W(5), false, true],
    ["constant 0.2×", W(0.2), false, true],
    ["constant 2×", W(2), false, false],
    ["constant 0.25×", W(0.25), false, false],
    ["constant 4×", W(4), false, false],
    ["easeInOutSine at 5× (a ramp keeps its sound)", W(5, SINE), false, false],
  ];
  it.each(cases)("%s", (_name, warp, isReversed, isSilenced) => {
    const map = mapOf(warp);
    expect(reversed(map)).toBe(isReversed);
    expect(silenced(map)).toBe(isSilenced);
  });
});

describe("endPoint, shownPoint and atEnd", () => {
  const map: WarpMap = warpMap({ inSec: 1, outSec: 4 }, W(2));
  const element = (duration: number, currentTime = 0, ended = false) => asMedia({ duration, currentTime, ended });

  it("keep an element a millisecond short of its Out and of its file's end", () => {
    expect(endPoint(element(10), map)).toBeCloseTo(3.999, 12);
    expect(endPoint(element(3.5), map)).toBeCloseTo(3.499, 12);
    expect(endPoint(element(Number.NaN), map)).toBeCloseTo(3.999, 12);
    expect(shownPoint(element(10), map, 5)).toBeCloseTo(3.999, 12);
    expect(shownPoint(element(10), map, 2)).toBe(2);
    expect(shownPoint(element(10), map, -1)).toBe(0);
  });

  it("say an element is at its end within that millisecond, or when its file ended", () => {
    expect(atEnd(element(10, 3.998), map)).toBe(true);
    expect(atEnd(element(10, 3.997), map)).toBe(false);
    expect(atEnd(element(10, 2, true), map)).toBe(true);
  });
});
