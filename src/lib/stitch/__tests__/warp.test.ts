import { describe, it, expect, vi } from "vitest";
import type { ClipWarp, ClipWarpCurve } from "@/types";
import {
  LINEAR_CURVE,
  MAX_SLOPE,
  MIN_POINT_GAP,
  bezierCurve,
  getAllEasingNames,
  normalizePoints,
  pointsCurve,
  presetCurve,
  windowCurve,
} from "@/lib/easing";
import {
  IDENTITY_WARP,
  MAX_STORED_SPEED,
  MIN_STORED_SPEED,
  SPEED_PRESETS,
  activeWarp,
  bakeError,
  canBlend,
  canSplitWarp,
  cloneWarp,
  dropsSound,
  formatSpeed,
  isPieceOfWarp,
  isRetimed,
  isWarped,
  maxSourceLength,
  minSourceLength,
  normalizeWarp,
  parseSpeed,
  pointsOfWarp,
  sameWarp,
  sanitizeWarp,
  splitWarp,
  trimField,
  warpCurve,
  warpMap,
  warpRateLabel,
  warpedLength,
  withWarp,
  type SourceRange,
} from "../warp";

const W = (speed: number, curve: ClipWarpCurve | null = null, extra: Partial<ClipWarp> = {}): ClipWarp => ({
  speed,
  curve,
  reverse: false,
  blend: false,
  ...extra,
});

const QUAD: ClipWarpCurve = { kind: "preset", name: "easeInQuad" };
const SINE: ClipWarpCurve = { kind: "preset", name: "easeInOutSine" };
const BEZIER: ClipWarpCurve = { kind: "bezier", handles: [0.42, 0, 0.58, 1] };
const RAMP_POINTS: ClipWarpCurve = {
  kind: "points",
  points: [
    [0, 0],
    [0.3, 0.1],
    [0.7, 0.8],
    [1, 1],
  ],
};
const FREEZE: ClipWarpCurve = {
  kind: "points",
  points: [
    [0, 0],
    [0.3, 0.5],
    [0.6, 0.5],
    [1, 1],
  ],
};
const RANGE: SourceRange = { inSec: 2, outSec: 12 };

function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

const PRESETS = getAllEasingNames().filter((name) => name !== "linear");

/** A canonical ramp of the given kind (or a random one). */
function randomCurve(
  random: () => number,
  kind = ["preset", "bezier", "points"][Math.floor(random() * 3)],
): ClipWarpCurve {
  if (kind === "preset") return { kind: "preset", name: PRESETS[Math.floor(random() * PRESETS.length)] };
  if (kind === "bezier") {
    const edge = () => (random() < 0.25 ? (random() < 0.5 ? 0 : 1) : random());
    return { kind: "bezier", handles: [edge(), edge(), edge(), edge()] };
  }
  const raw = Array.from({ length: 1 + Math.floor(random() * 5) }, () => [random(), random()]);
  // A flat run now and then: a freeze
  if (raw.length > 1 && random() < 0.3) raw[1][1] = raw[0][1];
  return { kind: "points", points: normalizePoints(raw)! };
}

/** A random active canonical warp: speed 0.1–10× on a log scale, a ramp or none, reversed or not, a window or none. */
function randomWarp(random: () => number, opts: { curve?: boolean; window?: boolean } = {}): ClipWarp {
  const speed = 10 ** (random() * 2 - 1);
  const curve = opts.curve ?? random() < 0.75 ? randomCurve(random) : null;
  let window: [number, number] | undefined;
  if (curve && (opts.window ?? random() < 0.5)) {
    const a = random() * 0.6;
    window = [a, a + 0.05 + random() * (1 - a - 0.05)];
  }
  const reverse = random() < 0.5;
  const warp = normalizeWarp({ speed, curve, ...(window ? { window } : {}), reverse, blend: random() < 0.5 });
  return warp ?? W(2);
}

/** Every object inside a value, itself included. */
function objectsIn(value: unknown, into = new Set<object>()): Set<object> {
  if (value && typeof value === "object") {
    into.add(value);
    for (const child of Object.values(value)) objectsIn(child, into);
  }
  return into;
}

describe("warpedLength", () => {
  it("is the source length without a warp, divided by the speed with one", () => {
    const len = 10 / 3;
    expect(warpedLength(len, undefined)).toBe(len);
    expect(warpedLength(len, null)).toBe(len);
    expect(warpedLength(len, { speed: 1, curve: null, reverse: false, blend: true })).toBe(len);
    expect(warpedLength(8, W(2))).toBe(4);
    expect(warpedLength(8, W(0.5, QUAD))).toBe(16);
  });

  it("is the map's length, bit for bit", () => {
    const random = lcg(1);
    for (let k = 0; k < 100; k++) {
      const range = { inSec: random() * 20, outSec: 20 + random() * 40 };
      const warp = randomWarp(random);
      expect(warpMap(range, warp).length).toBe(warpedLength(range.outSec - range.inSec, warp));
    }
  });
});

describe("warpMap", () => {
  it("is analytic at a constant speed", () => {
    const random = lcg(2);
    for (const reverse of [false, true]) {
      for (let k = 0; k < 50; k++) {
        const speed = 10 ** (random() * 2 - 1);
        const map = warpMap(RANGE, W(speed, null, { reverse }));
        const o = random() * map.length;
        expect(map.sourceTimeAt(o)).toBe(reverse ? RANGE.outSec - o * speed : RANGE.inSec + o * speed);
        const s = RANGE.inSec + random() * 10;
        expect(map.offsetAt(s)).toBe((reverse ? RANGE.outSec - s : s - RANGE.inSec) / speed);
        expect(Math.abs(map.sourceTimeAt(map.offsetAt(s)) - s)).toBeLessThanOrEqual(1e-12 * 10);
        expect(map.speedAt(o)).toBe(speed);
      }
    }
  });

  it("gives the range's ends exactly at 0 and at its length, and stays inside it", () => {
    const random = lcg(3);
    for (const curve of [null, QUAD, BEZIER, RAMP_POINTS]) {
      for (const window of [undefined, [0.2, 0.9] as [number, number]]) {
        for (const reverse of [false, true]) {
          if (!curve && window) continue;
          const range = { inSec: 1 / 3, outSec: 7 + 1 / 7 };
          const map = warpMap(range, normalizeWarp(W(0.37, curve, { reverse, ...(window ? { window } : {}) }))!);
          const [first, last] = reverse ? [range.outSec, range.inSec] : [range.inSec, range.outSec];
          expect(map.sourceTimeAt(0)).toBe(first);
          expect(map.sourceTimeAt(map.length)).toBe(last);
          expect(map.sourceTimeAt(-5)).toBe(first);
          expect(map.sourceTimeAt(map.length * 3)).toBe(last);
          expect(map.sourceTimeAt(Number.NaN)).toBe(first);
          for (let i = 0; i < 200; i++) {
            const s = map.sourceTimeAt(random() * map.length);
            expect(s).toBeGreaterThanOrEqual(range.inSec);
            expect(s).toBeLessThanOrEqual(range.outSec);
          }
        }
      }
    }
  });

  it("plays the curve forward and mirrors it reversed", () => {
    expect(warpMap({ inSec: 1, outSec: 11 }, W(2)).sourceTimeAt(2.5)).toBe(6);
    const quad = warpMap(RANGE, W(1, QUAD));
    expect(quad.sourceTimeAt(quad.length / 2)).toBeCloseTo(RANGE.inSec + 0.25 * 10, 12);
    const random = lcg(4);
    for (let k = 0; k < 50; k++) {
      const forward = randomWarp(random, { curve: true });
      const fwd = warpMap(RANGE, { ...forward, reverse: false });
      const rev = warpMap(RANGE, { ...forward, reverse: true });
      const o = random() * fwd.length;
      expect(rev.sourceTimeAt(o)).toBeCloseTo(RANGE.inSec + RANGE.outSec - fwd.sourceTimeAt(o), 12);
    }
  });

  it("finds the earliest offset that shows a source time", () => {
    const random = lcg(5);
    for (let k = 0; k < 300; k++) {
      const map = warpMap(RANGE, randomWarp(random));
      for (let j = 0; j < 50; j++) {
        const s = map.sourceTimeAt(random() * map.length);
        expect(Math.abs(map.sourceTimeAt(map.offsetAt(s)) - s)).toBeLessThanOrEqual(1e-9);
      }
    }
    const freeze = warpMap(RANGE, W(1, FREEZE));
    // The curve arrives at the freeze with zero slope, so the floats just before it already read its value
    expect(freeze.offsetAt(RANGE.inSec + 0.5 * 10)).toBeCloseTo(0.3 * freeze.length, 7);
    expect(freeze.sourceTimeAt(freeze.offsetAt(RANGE.inSec + 0.5 * 10))).toBe(RANGE.inSec + 0.5 * 10);
    expect(freeze.offsetAt(-3)).toBe(0);
    expect(freeze.offsetAt(40)).toBe(freeze.length);
    const reversed = warpMap(RANGE, W(0.5, QUAD, { reverse: true }));
    expect(reversed.offsetAt(40)).toBe(0);
    expect(reversed.offsetAt(-3)).toBe(reversed.length);
    // A constant warp's inverse is its own expression, clamped the same way
    for (const reverse of [false, true]) {
      const constant = warpMap(RANGE, W(2, null, { reverse }));
      expect(constant.offsetAt(-3)).toBe(reverse ? constant.length : 0);
      expect(constant.offsetAt(40)).toBe(reverse ? 0 : constant.length);
    }
  });

  it("gives the momentary speed", () => {
    expect(warpMap(RANGE, W(3)).speedAt(1.5)).toBe(3);
    const quad = warpMap(RANGE, W(2, QUAD));
    for (const p of [0.1, 0.4, 0.8]) expect(Math.abs(quad.speedAt(p * quad.length) - 2 * 2 * p)).toBeLessThan(1e-3);
    for (const curve of [BEZIER, RAMP_POINTS]) {
      const map = warpMap(RANGE, W(0.7, curve));
      for (const p of [0.13, 0.47, 0.81]) {
        const o = p * map.length;
        const h = 1e-6;
        const difference = (map.sourceTimeAt(o + h) - map.sourceTimeAt(o - h)) / (2 * h);
        expect(Math.abs(map.speedAt(o) - difference)).toBeLessThanOrEqual(1e-4 * difference);
      }
    }
    const windowed = warpMap(RANGE, W(1.5, SINE, { window: [0.2, 0.7] }));
    const sine = presetCurve("easeInOutSine")!;
    for (const p of [0.25, 0.5, 0.75]) {
      const expected = (sine.slope(0.2 + p * 0.5) * 0.5) / (sine.ease(0.7) - sine.ease(0.2)) * 1.5;
      expect(windowed.speedAt(p * windowed.length)).toBeCloseTo(expected, 9);
    }
    // A handle on its end point: the clip leaves In (or, reversed, reaches it) at 2 / 0.58×, not standing still
    for (const [handles, reverse] of [
      [[0, 0, 0.58, 1], false],
      [[0.42, 0, 1, 1], true],
    ] as const) {
      const map = warpMap(RANGE, W(2, { kind: "bezier", handles: [...handles] }, { reverse }));
      const o = reverse ? map.length : 0;
      const h = 1e-6;
      const difference = Math.abs(map.sourceTimeAt(reverse ? o - h : h) - map.sourceTimeAt(o)) / h;
      expect(map.speedAt(o)).toBeCloseTo(2 / 0.58, 9);
      expect(Math.abs(map.speedAt(o) - difference)).toBeLessThanOrEqual(1e-3 * difference);
    }
    for (const name of PRESETS) {
      const map = warpMap(RANGE, W(2, { kind: "preset", name }));
      for (const p of [0, 0.5, 1]) {
        const speed = map.speedAt(p * map.length);
        expect(Number.isFinite(speed), `${name} at ${p}`).toBe(true);
        expect(speed).toBeLessThanOrEqual(MAX_SLOPE * 2);
      }
    }
  });

  it("plays warpCurve, through closures on a frozen map", () => {
    expect(warpCurve(null)).toBe(LINEAR_CURVE);
    expect(warpCurve(QUAD).ease(0.3)).toBe(presetCurve("easeInQuad")!.ease(0.3));
    expect(warpCurve(BEZIER).ease(0.3)).toBe(bezierCurve([0.42, 0, 0.58, 1]).ease(0.3));
    const windowed = warpCurve(SINE, [0.2, 0.7]);
    expect(windowed.ease(0.4)).toBe(windowCurve(presetCurve("easeInOutSine")!, 0.2, 0.7)!.ease(0.4));
    const random = lcg(6);
    for (let k = 0; k < 50; k++) {
      const warp = randomWarp(random, { curve: true });
      const map = warpMap(RANGE, { ...warp, reverse: false });
      const at = map.sourceTimeAt;
      const o = random() * map.length;
      const played = warpCurve(warp.curve, warp.window).ease(o / map.length);
      expect(map.sourceTimeAt(o)).toBeCloseTo(RANGE.inSec + played * 10, 12);
      expect(at(o)).toBe(map.sourceTimeAt(o));
    }
    expect(Object.isFrozen(warpMap(RANGE, W(2)))).toBe(true);
    expect(Object.isFrozen(warpMap(RANGE, W(2, QUAD)))).toBe(true);
  });

  it("never runs time back within a clip", () => {
    const random = lcg(7);
    for (let k = 0; k < 300; k++) {
      const curve = randomCurve(random, ["preset", "bezier", "points"][k % 3]);
      let window: [number, number] | undefined;
      if (random() < 0.5) {
        const a = random() * 0.8;
        const b = a + 0.01 + random() * (1 - a - 0.01);
        const base = warpCurve(curve);
        // The bezier solver is exact to 1e-10 in x, which a window magnifies by 1 / its width: one 3e-7 wide (40 nested
        // splits) steps back by about 2e-4 of its piece, far below a frame
        if (base.ease(b) - base.ease(a) >= 1e-3) window = [a, b];
      }
      const reverse = random() < 0.5;
      const warp = normalizeWarp(W(0.1 + random() * 9.9, curve, { reverse, ...(window ? { window } : {}) }));
      if (!warp) continue;
      const map = warpMap(RANGE, warp);
      let previous = map.sourceTimeAt(0);
      for (let i = 1; i <= 10_000; i++) {
        const s = map.sourceTimeAt((i / 10_000) * map.length);
        const step = reverse ? previous - s : s - previous;
        if (step < -1e-12 * 10) throw new Error(`curve ${k} runs back by ${-step} at ${i}`);
        previous = s;
      }
    }
  });
});

describe("splitWarp", () => {
  /** Both pieces of a split of `whole` at o, checked against it at random offsets; the pieces. */
  function checkSplit(
    random: () => number,
    whole: { range: SourceRange; warp: ClipWarp },
    o: number,
    against = whole,
    from = 0,
  ) {
    const split = splitWarp(whole.range, whole.warp, o);
    expect(split !== null).toBe(canSplitWarp(whole.range, whole.warp, o));
    if (!split) return null;
    const map = warpMap(against.range, against.warp);
    const first = warpMap(split.first.range, split.first.warp);
    const second = warpMap(split.second.range, split.second.warp);
    const length = warpMap(whole.range, whole.warp).length;
    expect(Math.abs(first.length - o)).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(second.length - (length - o))).toBeLessThanOrEqual(1e-9);
    for (let i = 0; i < 5; i++) {
      const x = random() * first.length;
      expect(Math.abs(first.sourceTimeAt(x) - map.sourceTimeAt(from + x))).toBeLessThanOrEqual(1e-9);
      const y = random() * second.length;
      expect(Math.abs(second.sourceTimeAt(y) - map.sourceTimeAt(from + o + y))).toBeLessThanOrEqual(1e-9);
    }
    for (const piece of [split.first, split.second]) {
      expect(piece.warp.reverse).toBe(whole.warp.reverse);
      expect(piece.warp.blend).toBe(whole.warp.blend);
      expect(piece.warp.curve).toEqual(whole.warp.curve);
      if (whole.warp.curve === null) {
        expect(piece.warp.speed).toBe(whole.warp.speed);
        expect("window" in piece.warp).toBe(false);
      }
      expect(piece.warp.window).not.toEqual([0, 1]);
      expect(sanitizeWarp(JSON.parse(JSON.stringify(piece.warp)))).toEqual(piece.warp);
    }
    return split;
  }

  it.each([
    ["constant", null],
    ["preset", SINE],
    ["bezier", BEZIER],
    ["points", RAMP_POINTS],
  ] as const)("keeps the picture of a %s ramp, windowed or not, forward and reversed, split twice", (_, curve) => {
    const random = lcg(8);
    for (const reverse of [false, true]) {
      for (const windowed of [false, true]) {
        let whole = { range: { inSec: 3, outSec: 17 }, warp: W(0.8, curve, { reverse, blend: true }) };
        if (windowed && curve) {
          const first = splitWarp(whole.range, whole.warp, warpMap(whole.range, whole.warp).length * 0.35)!;
          whole = first.second;
        }
        const length = warpMap(whole.range, whole.warp).length;
        for (let k = 0; k < 200; k++) {
          const o = (0.01 + 0.98 * random()) * length;
          // No freeze in these ramps: every cut splits
          const split = checkSplit(random, whole, o)!;
          expect(split).not.toBeNull();
          const again = split.second;
          const againLength = warpMap(again.range, again.warp).length;
          expect(checkSplit(random, again, (0.01 + 0.98 * random()) * againLength, whole, o)).not.toBeNull();
        }
      }
    }
  });

  it("refuses a cut at an end, in a flat end, past the stored speeds, or leaving a piece inside a freeze", () => {
    const map = warpMap(RANGE, W(1, SINE));
    expect(splitWarp(RANGE, W(1, SINE), 0)).toBeNull();
    expect(splitWarp(RANGE, W(1, SINE), map.length)).toBeNull();
    // The flat end holds Out from 0.5·L on: a cut in it leaves the second piece no source
    const flatEnd: ClipWarpCurve = { kind: "points", points: [[0, 0], [0.5, 1], [1, 1]] };
    expect(splitWarp(RANGE, W(1, flatEnd), warpMap(RANGE, W(1, flatEnd)).length * 0.75)).toBeNull();
    const steep: ClipWarpCurve = { kind: "points", points: [[0, 0], [0.5, 0.98], [1, 1]] };
    const huge = { inSec: 0, outSec: 1e9 };
    expect(splitWarp(huge, W(MAX_STORED_SPEED, steep), 0.1)).toBeNull();
    // Each rule on its own: a piece with 1e-6 s of source or less (a constant warp; a ramp's slow end), and a piece
    // inside a freeze though it holds more, first or second (easeInSine over an hour rises 7.7e-10 in its first
    // 0.09 s, and easeOutSine as much in its last)
    const tenSeconds = { inSec: 0, outSec: 10 };
    expect(splitWarp(RANGE, W(2), 1e-7)).toBeNull();
    expect(splitWarp(tenSeconds, W(1, SINE), 10 * (1 - 1.42e-4))).toBeNull();
    const hour = { inSec: 0, outSec: 3600 };
    const inSine: ClipWarpCurve = { kind: "preset", name: "easeInSine" };
    const rise = presetCurve("easeInSine")!.ease(0.09 / 3600);
    expect(rise).toBeLessThanOrEqual(1e-9);
    expect(rise * 3600).toBeGreaterThan(1e-6);
    expect(splitWarp(hour, W(1, inSine), 0.09)).toBeNull();
    const outSine: ClipWarpCurve = { kind: "preset", name: "easeOutSine" };
    const fall = 1 - presetCurve("easeOutSine")!.ease((3600 - 0.09) / 3600);
    expect(fall).toBeLessThanOrEqual(1e-9);
    expect(fall * 3600).toBeGreaterThan(1e-6);
    expect(splitWarp(hour, W(1, outSine), 3600 - 0.09)).toBeNull();
    for (const [range, warp, o] of [
      [RANGE, W(1, SINE), 0],
      [RANGE, W(1, flatEnd), 7.5],
      [huge, W(MAX_STORED_SPEED, steep), 0.1],
      [RANGE, W(2), 1e-7],
      [tenSeconds, W(1, SINE), 10 * (1 - 1.42e-4)],
      [hour, W(1, inSine), 0.09],
      [hour, W(1, outSine), 3600 - 0.09],
    ] as const) {
      expect(canSplitWarp(range, warp, o)).toBe(false);
    }
  });

  it("splits near a ramp's slow end, where a piece averages far below 0.01×", () => {
    const cubic = splitWarp({ inSec: 0, outSec: 10 }, W(1, { kind: "preset", name: "easeInOutCubic" }), 0.3)!;
    expect(cubic).not.toBeNull();
    expect(cubic.first.warp.speed).toBeCloseTo(0.0036, 6);
    const quint = splitWarp({ inSec: 0, outSec: 60 }, W(0.1, { kind: "preset", name: "easeInQuint" }), 30)!;
    expect(quint).not.toBeNull();
    expect(quint.first.warp.speed).toBeLessThan(1e-6);
    expect(quint.first.warp.speed).toBeGreaterThan(MIN_STORED_SPEED);
  });

  it("keeps a window narrower than a millionth, so a trimmed piece still plays its own part", () => {
    // 60 s at 0.1× (600 s), split at 300 s and 300.6 s; the middle piece's Out trimmed to the source's end; split
    // 0.15 s in
    const root = { range: { inSec: 0, outSec: 60 }, warp: W(0.1, SINE) };
    const half = splitWarp(root.range, root.warp, 300)!.second;
    const middle = splitWarp(half.range, half.warp, 0.6)!.first;
    const trimmed = { range: { inSec: middle.range.inSec, outSec: 60 }, warp: middle.warp };
    const piece = splitWarp(trimmed.range, trimmed.warp, 0.15)!.first;
    const [a, b] = piece.warp.window!;
    expect(a).toBeCloseTo(0.5, 9);
    expect(b - a).toBeGreaterThan(5e-7);
    expect(b - a).toBeLessThan(1e-6);
    expect(normalizeWarp(piece.warp)).toEqual(piece.warp);
    const parent = warpMap(trimmed.range, trimmed.warp);
    const own = warpMap(piece.range, piece.warp);
    for (let i = 0; i <= 20; i++) {
      const o = (i / 20) * own.length;
      expect(Math.abs(own.sourceTimeAt(o) - parent.sourceTimeAt(o))).toBeLessThanOrEqual(1e-9);
    }
    // Trimmed to 10 s of source it still plays the steepest part of the ramp at its own speed, not the whole curve
    const long = warpMap({ inSec: piece.range.inSec, outSec: piece.range.inSec + 10 }, piece.warp);
    expect(long.speedAt(long.length * 0.999)).toBeCloseTo(0.157, 3);
  });
});

describe("isPieceOfWarp", () => {
  it("knows a split's pieces, and pieces of pieces", () => {
    const random = lcg(9);
    for (const curve of [SINE, BEZIER, RAMP_POINTS]) {
      for (const reverse of [false, true]) {
        const whole = W(1.7, curve, { reverse });
        const length = warpMap(RANGE, whole).length;
        for (let k = 0; k < 20; k++) {
          const split = splitWarp(RANGE, whole, (0.05 + 0.9 * random()) * length)!;
          expect(isPieceOfWarp(whole, split.first.warp)).toBe(true);
          expect(isPieceOfWarp(whole, split.second.warp)).toBe(true);
          const again = split.second;
          const piece = splitWarp(again.range, again.warp, warpMap(again.range, again.warp).length / 3)!;
          expect(isPieceOfWarp(whole, piece.first.warp)).toBe(true);
          expect(isPieceOfWarp(split.second.warp, piece.second.warp)).toBe(true);
        }
      }
    }
  });

  it("knows a tiny piece cut near a slow end, an hour into its source", () => {
    const range = { inSec: 3600, outSec: 3660 };
    const whole = W(1, { kind: "preset", name: "easeInOutCubic" });
    const map = warpMap(range, whole);
    const split = splitWarp(range, whole, map.offsetAt(3600 + 5e-6))!;
    expect(split.first.range.outSec - split.first.range.inSec).toBeLessThan(1e-5);
    expect(isPieceOfWarp(whole, split.first.warp)).toBe(true);
    expect(isPieceOfWarp(whole, split.second.warp)).toBe(true);
    // Such pieces' root speeds are off by up to about 1e-7 relative
    let pieces = 0;
    for (const name of ["easeInOutCubic", "easeInQuint", "easeOutQuint", "easeInOutSine", "easeInExpo"]) {
      for (const reverse of [false, true]) {
        const ramp = W(0.7, { kind: "preset", name }, { reverse });
        const rampMap = warpMap(range, ramp);
        for (const source of [1.5e-6, 3e-6, 1e-5, 1e-4]) {
          for (const at of [range.inSec + source, range.outSec - source]) {
            const cut = splitWarp(range, ramp, rampMap.offsetAt(at));
            if (!cut) continue;
            pieces++;
            const label = `${name} ${reverse ? "reversed" : "forward"} at ${at}`;
            expect(isPieceOfWarp(ramp, cut.first.warp), label).toBe(true);
            expect(isPieceOfWarp(ramp, cut.second.warp), label).toBe(true);
          }
        }
      }
    }
    expect(pieces).toBeGreaterThan(50);
  });

  it("tells a speed, curve, reverse, blend or window change from a split", () => {
    const whole = W(1.7, SINE, { window: [0.2, 0.8] });
    const piece = splitWarp(RANGE, whole, 2)!.first.warp;
    expect(isPieceOfWarp(whole, { ...piece, speed: piece.speed * 1.001 })).toBe(false);
    expect(isPieceOfWarp(whole, { ...piece, curve: QUAD })).toBe(false);
    expect(isPieceOfWarp(whole, { ...piece, reverse: true })).toBe(false);
    expect(isPieceOfWarp(whole, { ...piece, blend: true })).toBe(false);
    expect(isPieceOfWarp(whole, { ...piece, window: [0.1, 0.3] })).toBe(false);
    // A window past either end of the original's, at the speed that keeps its root speed: a piece of the whole ramp,
    // not of this part of it
    const sine = presetCurve("easeInOutSine")!;
    const root = (1.7 * 0.6) / (sine.ease(0.8) - sine.ease(0.2));
    for (const [a, b] of [[0.1, 0.3], [0.7, 0.9]] as const) {
      const speed = (root * (sine.ease(b) - sine.ease(a))) / (b - a);
      const outside: ClipWarp = { ...piece, speed, window: [a, b] };
      expect(isPieceOfWarp(whole, outside)).toBe(false);
      expect(isPieceOfWarp(W(root, SINE), outside)).toBe(true);
    }
    expect(isPieceOfWarp(undefined, piece)).toBe(false);
    expect(isPieceOfWarp(whole, undefined)).toBe(false);
    expect(isPieceOfWarp(undefined, { speed: 1, curve: null, reverse: false, blend: true })).toBe(true);
  });
});

describe("trims under a warp", () => {
  it("trims the Out from the head of a reversed clip", () => {
    expect(trimField({}, "in")).toBe("inSec");
    expect(trimField({}, "out")).toBe("outSec");
    expect(trimField({ warp: { speed: 1, curve: null, reverse: false, blend: true } }, "in")).toBe("inSec");
    expect(trimField({ warp: W(2) }, "in")).toBe("inSec");
    expect(trimField({ warp: W(2) }, "out")).toBe("outSec");
    expect(trimField({ warp: W(1, null, { reverse: true }) }, "in")).toBe("outSec");
    expect(trimField({ warp: W(1, null, { reverse: true }) }, "out")).toBe("inSec");
  });

  it("gives the least and most source an edit may keep", () => {
    expect(minSourceLength(undefined, 0.1)).toBe(0.1);
    expect(minSourceLength(W(0.5), 0.1)).toBe(0.05);
    expect(minSourceLength(W(4), 0.1)).toBe(0.4);
    expect(maxSourceLength(undefined, 600)).toBe(Infinity);
    expect(maxSourceLength(W(2), 600)).toBe(Infinity);
    expect(maxSourceLength(W(1, null, { reverse: true }), 600)).toBe(Infinity);
    expect(maxSourceLength(W(0.5), 600)).toBe(300);
    expect(maxSourceLength(W(0.1), 600)).toBe(60);
    expect(maxSourceLength(W(1e-6), 600)).toBeCloseTo(6e-4, 15);
  });
});

describe("sameWarp", () => {
  it("compares every field exactly, absent as the identity", () => {
    expect(sameWarp(undefined, { speed: 1, curve: null, reverse: false, blend: true })).toBe(true);
    expect(sameWarp(null, undefined)).toBe(true);
    for (const curve of [null, QUAD, BEZIER, RAMP_POINTS]) {
      const warp = W(2, curve, { reverse: true });
      expect(sameWarp(warp, JSON.parse(JSON.stringify(warp)))).toBe(true);
    }
    const base = W(2, RAMP_POINTS, { window: [0.2, 0.6] });
    const knot = structuredClone(base);
    (knot.curve as { points: Array<[number, number]> }).points[1][1] = 0.1000001;
    const handle = W(2, { kind: "bezier", handles: [0.42, 0, 0.58, 0.999] });
    for (const changed of [
      { ...base, speed: 2 + 4.440892098500626e-16 },
      knot,
      { ...base, window: [0.2, 0.61] },
      { ...base, reverse: true },
      { ...base, blend: true },
    ] as ClipWarp[]) {
      expect(sameWarp(base, changed)).toBe(false);
    }
    expect(sameWarp(W(2, BEZIER), handle)).toBe(false);
    expect(sameWarp(base, undefined)).toBe(false);
    // The window counts only with a ramp, and [0, 1] is no window
    expect(sameWarp(W(2), { ...W(2), window: [0.2, 0.6] })).toBe(true);
    expect(sameWarp(W(2, QUAD), W(2, QUAD, { window: [0, 1] }))).toBe(true);
  });
});

describe("sanitizeWarp", () => {
  it("reads whatever was stored", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const raw of [null, undefined, 2, "2x", [], [2]]) expect(sanitizeWarp(raw)).toBeUndefined();
    expect(sanitizeWarp({ speed: -1, curve: null })!.speed).toBe(1e-9);
    expect(sanitizeWarp({ speed: 1e12, curve: null })!.speed).toBe(1e9);
    for (const speed of [Number.NaN, "2", undefined]) {
      expect(sanitizeWarp({ speed, curve: QUAD })!.speed).toBe(1);
    }
    expect(sanitizeWarp({ speed: 2, curve: QUAD })!.curve).toEqual(QUAD);
    for (const name of ["linear", "toString", "nope", 3]) {
      expect(sanitizeWarp({ speed: 2, curve: { kind: "preset", name } })!.curve).toBeNull();
    }
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    expect(sanitizeWarp({ speed: 2, curve: { kind: "bezier", handles: [-1, 2, 0.5, 0.5] } })!.curve).toEqual({
      kind: "bezier",
      handles: [0, 1, 0.5, 0.5],
    });
    for (const handles of [
      [0.3, 0.3, 0.7, 0.7],
      [0.3, 0.3 + 5e-10, 0.7, 0.7],
      [0.3, 0.3, 0.7],
      [0.3, Number.NaN, 0.7, 1],
    ]) {
      expect(sanitizeWarp({ speed: 2, curve: { kind: "bezier", handles } })!.curve).toBeNull();
    }
    expect(
      sanitizeWarp({ speed: 2, curve: { kind: "points", points: [[0, 0], [0.4, 0.8], [0.6, 0.3], [1, 1]] } })!.curve,
    ).toEqual({ kind: "points", points: [[0, 0], [0.4, 0.8], [0.6, 0.8], [1, 1]] });
    // Straight points are no ramp: at 1× forward, no warp at all
    expect(sanitizeWarp({ speed: 1, curve: { kind: "points", points: [[0, 0], [1, 1]] } })).toBeUndefined();
    expect(sanitizeWarp({ speed: 1, curve: { kind: "points", points: [[0, 0], [0.5, 0.5], [1, 1]] } })).toBeUndefined();
    const many = Array.from({ length: 70 }, (_, i) => [i / 70, (i / 70) ** 2]);
    expect(sanitizeWarp({ speed: 2, curve: { kind: "points", points: many } })!.curve).toBeNull();
    expect(sanitizeWarp({ speed: 2, curve: { kind: "spline" } })!.curve).toBeNull();
  });

  it("keeps a window only on a ramp that rises across it", () => {
    const windowOf = (window: unknown, curve: ClipWarpCurve | null = QUAD) =>
      sanitizeWarp({ speed: 2, curve, window })?.window;
    expect(windowOf([-0.5, 0.5])).toEqual([0, 0.5]);
    expect(windowOf([0.5, 0.5])).toBeUndefined();
    expect(windowOf([0.7, 0.2])).toBeUndefined();
    expect(windowOf([0, 1])).toBeUndefined();
    expect(windowOf([0.35, 0.55], FREEZE)).toBeUndefined();
    expect(windowOf([0.5, 0.5 + 1e-7], SINE)).toEqual([0.5, 0.5 + 1e-7]);
    expect(windowOf([0.2, 0.6], null)).toBeUndefined();
    expect(windowOf([0.2, Number.NaN])).toBeUndefined();
    expect(windowOf("0.2")).toBeUndefined();
  });

  it("takes reverse and blend only when true, and drops a warp that changes nothing", () => {
    expect(sanitizeWarp({ speed: 2, curve: null, reverse: "yes", blend: 1 })).toEqual(W(2));
    expect(sanitizeWarp({ speed: 1, curve: null, reverse: false, blend: true })).toBeUndefined();
    expect(sanitizeWarp({ speed: 1, curve: null, reverse: true, blend: false })).toEqual(W(1, null, { reverse: true }));
  });

  it("writes its keys in one order", () => {
    const raw = {
      blend: true,
      reverse: false,
      window: [0.2, 0.6],
      curve: { points: [[0.5, 0.2]], kind: "points" },
      speed: 2,
    };
    const warp = sanitizeWarp(raw)!;
    expect(Object.keys(warp)).toEqual(["speed", "curve", "window", "reverse", "blend"]);
    expect(Object.keys(warp.curve!)).toEqual(["kind", "points"]);
    expect(Object.keys(sanitizeWarp({ ...raw, window: undefined })!)).toEqual(["speed", "curve", "reverse", "blend"]);
    expect(Object.keys(sanitizeWarp({ curve: { name: "easeInQuad", kind: "preset" }, speed: 2 })!.curve!)).toEqual([
      "kind",
      "name",
    ]);
  });

  /** Whatever a file might hold. */
  function fuzzWarp(random: () => number): unknown {
    const pick = <T,>(options: readonly T[]): T => options[Math.floor(random() * options.length)];
    const number = () =>
      pick([random() * 12 - 1, 10 ** (random() * 24 - 12), -random(), 0, 1, Number.NaN, Number.POSITIVE_INFINITY, "2"]);
    const curve = () =>
      pick([
        null,
        "easeInQuad",
        { kind: "preset", name: pick([...PRESETS, "linear", "toString", "nope", 4]) },
        { kind: "bezier", handles: [number(), number(), number(), number()] },
        { kind: "bezier", handles: [random(), random(), random(), random()] },
        { kind: "bezier", handles: [random(), random(), random()] },
        { kind: "points", points: Array.from({ length: Math.floor(random() * 8) }, () => [number(), number()]) },
        { kind: "points", points: Array.from({ length: Math.floor(random() * 8) }, () => [random(), random()]) },
        { kind: "points", points: "nope" },
        { kind: "sketch" },
      ]);
    const raw: Record<string, unknown> = {};
    if (random() < 0.9) raw.speed = pick([number(), 10 ** (random() * 2 - 1), 1]);
    if (random() < 0.9) raw.curve = curve();
    if (random() < 0.6) raw.window = pick([[random(), random()], [number(), number()], [random()], "x", null]);
    if (random() < 0.8) raw.reverse = pick([true, false, "true", 1]);
    if (random() < 0.8) raw.blend = pick([true, false, 0]);
    return pick([raw, raw, raw, raw, null, [raw], "warp"]);
  }

  it("is a fixed point: what it returns reads back the same, and shares nothing with what it read", () => {
    const random = lcg(10);
    let warps = 0;
    for (let k = 0; k < 3000; k++) {
      const raw = fuzzWarp(random);
      const warp = sanitizeWarp(raw);
      if (!warp) continue;
      warps++;
      const text = JSON.stringify(warp);
      const again = sanitizeWarp(JSON.parse(text));
      expect(again).toEqual(warp);
      expect(JSON.stringify(again)).toBe(text);
      expect(normalizeWarp(warp)).toEqual(warp);
      const theirs = objectsIn(raw);
      for (const object of objectsIn(warp)) expect(theirs.has(object)).toBe(false);
    }
    expect(warps).toBeGreaterThan(1000);
  });
});

describe("withWarp", () => {
  const clip: { id: string; inSec: number; startSec: number; warp?: ClipWarp } = { id: "a", inSec: 0, startSec: 2 };

  it("writes an active warp, a new key last and an old one in its place", () => {
    const warped = withWarp(clip, W(2));
    expect(Object.keys(warped)).toEqual(["id", "inSec", "startSec", "warp"]);
    expect(warped.warp).toEqual(W(2));
    const rewarped = withWarp({ id: "a", warp: W(2), inSec: 0 }, W(3));
    expect(Object.keys(rewarped)).toEqual(["id", "warp", "inSec"]);
    expect(rewarped.warp!.speed).toBe(3);
  });

  it("drops the key for a warp that changes nothing, and keeps a clip without one as it is", () => {
    for (const warp of [undefined, null, IDENTITY_WARP]) expect(withWarp(clip, warp)).toBe(clip);
    const dropped = withWarp({ id: "a", warp: W(2), inSec: 0 }, IDENTITY_WARP);
    expect("warp" in dropped).toBe(false);
    expect(Object.keys(dropped)).toEqual(["id", "inSec"]);
  });

  it("has a frozen identity that is never active", () => {
    expect(Object.isFrozen(IDENTITY_WARP)).toBe(true);
    expect(isWarped(IDENTITY_WARP)).toBe(false);
    expect(activeWarp({ warp: IDENTITY_WARP })).toBeNull();
    expect(activeWarp({ warp: { speed: 1, curve: QUAD, reverse: false, blend: false } })).not.toBeNull();
    const straight: ClipWarpCurve = { kind: "bezier", handles: [0.2, 0.2, 0.8, 0.8] };
    expect(activeWarp({ warp: { speed: 1, curve: straight, reverse: false, blend: false } })).toBeNull();
    // Handles outside the box play clamped, here straight, as the sanitized warp reads
    const clampedStraight: ClipWarp = W(1, { kind: "bezier", handles: [-1, 0, 0.5, 0.5] });
    expect(activeWarp({ warp: clampedStraight })).toBeNull();
    expect(sameWarp(undefined, clampedStraight)).toBe(true);
    expect(sanitizeWarp(clampedStraight)).toBeUndefined();
  });
});

describe("cloneWarp", () => {
  it("shares nothing", () => {
    for (const curve of [null, QUAD, BEZIER, RAMP_POINTS]) {
      const warp = W(0.5, curve, { blend: true, ...(curve ? { window: [0.1, 0.9] as [number, number] } : {}) });
      const copy = cloneWarp(warp);
      expect(copy).toEqual(warp);
      const theirs = objectsIn(warp);
      for (const object of objectsIn(copy)) expect(theirs.has(object)).toBe(false);
    }
  });
});

describe("dropsSound", () => {
  it("is a constant speed above 4× or below 0.25×", () => {
    expect(dropsSound(undefined)).toBe(false);
    expect(dropsSound(null)).toBe(false);
    expect(dropsSound(W(4))).toBe(false);
    expect(dropsSound(W(4.01))).toBe(true);
    expect(dropsSound(W(0.25))).toBe(false);
    expect(dropsSound(W(0.24))).toBe(true);
    expect(dropsSound(W(8, QUAD))).toBe(false);
    expect(dropsSound(W(1, null, { reverse: true }))).toBe(false);
  });
});

describe("bakeError", () => {
  it("is half a source frame, kept to [0.002, 0.01]", () => {
    expect(bakeError(10, 24)).toBe(1 / 480);
    expect(bakeError(4, 24)).toBe(1 / 192);
    expect(bakeError(60, 30)).toBe(0.002);
    expect(bakeError(0.5, 24)).toBe(0.01);
    for (const fps of [null, undefined, 0, Number.NaN]) expect(bakeError(4, fps)).toBe(1 / 240);
    expect(bakeError(0, 24)).toBe(0.01);
    expect(bakeError(Number.NaN, 24)).toBe(0.01);
  });
});

describe("pointsOfWarp", () => {
  const verticalError = (points: ReadonlyArray<readonly [number, number]>, f: (u: number) => number) => {
    const ease = pointsCurve(points).ease;
    let worst = 0;
    for (let i = 0; i <= 2000; i++) worst = Math.max(worst, Math.abs(ease(i / 2000) - f(i / 2000)));
    return worst;
  };

  it("is null without a ramp, and a points curve's own knots without a window", () => {
    expect(pointsOfWarp(undefined)).toBeNull();
    expect(pointsOfWarp(W(2))).toBeNull();
    const warp = W(2, RAMP_POINTS);
    const baked = pointsOfWarp(warp)!;
    expect(baked).toEqual(RAMP_POINTS);
    expect(baked.points).not.toBe((RAMP_POINTS as { points: unknown }).points);
    expect(baked.points[1]).not.toBe((RAMP_POINTS as { points: unknown[] }).points[1]);
  });

  it("bakes a preset, windowed or not, within the budget", () => {
    for (const warp of [W(2, SINE), W(2, QUAD, { window: [0.3, 0.8] }), W(1, BEZIER, { window: [0.1, 0.5] })]) {
      const baked = pointsOfWarp(warp, 0.004)!;
      expect(baked.kind).toBe("points");
      expect(baked.points.length).toBeLessThanOrEqual(16);
      expect(verticalError(baked.points, warpCurve(warp.curve, warp.window).ease)).toBeLessThanOrEqual(0.004);
      expect(normalizePoints(baked.points)).toEqual(baked.points);
    }
  });

  it("keeps a windowed points curve's own knots inside the window", () => {
    const curve: ClipWarpCurve = {
      kind: "points",
      points: [
        [0, 0],
        [0.2, 0.05],
        [0.4, 0.3],
        [0.6, 0.35],
        [0.8, 0.9],
        [1, 1],
      ],
    };
    const warp = W(1, curve, { window: [0.1, 0.9] });
    const baked = pointsOfWarp(warp, 0.002)!;
    const base = pointsCurve((curve as { points: Array<[number, number]> }).points);
    const [ca, cb] = [base.ease(0.1), base.ease(0.9)];
    for (const [x, y] of [[0.2, 0.05], [0.4, 0.3], [0.6, 0.35], [0.8, 0.9]]) {
      expect(baked.points).toContainEqual([(x - 0.1) / 0.8, (y - ca) / (cb - ca)]);
    }
    expect(baked.points.length).toBeLessThanOrEqual(64);
    // Within the budget wherever a knot could go; within a knot's gap none can, and a seed knot may hold it a little
    // over
    const played = warpCurve(curve, [0.1, 0.9]).ease;
    const ease = pointsCurve(baked.points).ease;
    for (let i = 0; i <= 512; i++) {
      const x = i / 512;
      if (baked.points.some(([knot]) => Math.abs(knot - x) < MIN_POINT_GAP)) continue;
      expect(Math.abs(ease(x) - played(x))).toBeLessThanOrEqual(0.002);
    }
    expect(verticalError(baked.points, played)).toBeLessThanOrEqual(0.003);
    expect(normalizePoints(baked.points)).toEqual(baked.points);
  });

  it("drops a stored knot that lands within MIN_POINT_GAP of a window's edge", () => {
    const points: Array<[number, number]> = [
      [0, 0],
      [0.21, 0.06],
      [0.5, 0.3],
      [0.89, 0.95],
      [1, 1],
    ];
    const baked = pointsOfWarp(W(1, { kind: "points", points }, { window: [0.2, 0.9] }), 0.004)!;
    // 0.21 and 0.89 would land 0.014 from the ends
    for (let i = 1; i < baked.points.length; i++) {
      expect(baked.points[i][0] - baked.points[i - 1][0]).toBeGreaterThanOrEqual(MIN_POINT_GAP);
    }
    const base = pointsCurve(points);
    const [ca, cb] = [base.ease(0.2), base.ease(0.9)];
    expect(baked.points).toContainEqual([(0.5 - 0.2) / 0.7, (0.3 - ca) / (cb - ca)]);
  });
});

describe("the rail's speed words", () => {
  it("offers 0.25, 0.5, 1, 2 and 4×", () => {
    expect(SPEED_PRESETS).toEqual([0.25, 0.5, 1, 2, 4]);
  });

  it("formats a speed to three figures, never with an exponent", () => {
    expect(formatSpeed(2)).toBe("2×");
    expect(formatSpeed(0.5)).toBe("0.5×");
    expect(formatSpeed(1.05)).toBe("1.05×");
    expect(formatSpeed(0.04123)).toBe("0.0412×");
    expect(formatSpeed(0)).toBe("0×");
    expect(formatSpeed(3e-7)).toBe("< 0.001×");
    expect(formatSpeed(150)).toBe("> 100×");
    for (const speed of [MIN_STORED_SPEED, 1e-4, 0.0005, 0.00123, 12.34, 99.94, 99.96, MAX_STORED_SPEED, 1e6]) {
      expect(formatSpeed(speed)).not.toMatch(/e/i);
    }
  });

  it("reads a typed speed, with or without its ×, a comma for the point", () => {
    for (const [text, speed] of [
      ["2", 2],
      ["2x", 2],
      ["2X", 2],
      ["2×", 2],
      [" 2 x ", 2],
      ["0,5", 0.5],
      [".5", 0.5],
      [".5 x", 0.5],
      ["1.", 1],
    ] as const) {
      expect(parseSpeed(text)).toBe(speed);
    }
    for (const text of ["", "x", "0", "0.0", "-1", "2 s", "1:00", "fast", "2xx", "1e3"]) expect(parseSpeed(text)).toBeNull();
  });

  it("names what the badge shows: the rate, or a ramp", () => {
    expect(warpRateLabel(undefined)).toBeNull();
    expect(warpRateLabel(IDENTITY_WARP)).toBeNull();
    expect(warpRateLabel(W(2))).toBe("2×");
    expect(warpRateLabel(W(0.04123))).toBe("0.0412×");
    expect(warpRateLabel(W(2, QUAD))).toBe("Ramp");
    expect(warpRateLabel(W(1, QUAD))).toBe("Ramp");
    expect(warpRateLabel(W(1, null, { reverse: true }))).toBeNull();
    expect(warpRateLabel(W(2, null, { reverse: true }))).toBe("2×");
  });

  it("tells a retimed clip from one only reversed", () => {
    expect(isWarped(IDENTITY_WARP)).toBe(false);
    expect(isRetimed(IDENTITY_WARP)).toBe(false);
    expect(isRetimed(undefined)).toBe(false);
    expect(isRetimed(W(1, null, { reverse: true }))).toBe(false);
    expect(isRetimed(W(2))).toBe(true);
    expect(isRetimed(W(1, QUAD))).toBe(true);
    expect(isRetimed(W(1, { kind: "preset", name: "linear" }))).toBe(false);
  });

  it("lets Blend frames act only where there is slow motion", () => {
    expect(canBlend(undefined)).toBe(false);
    expect(canBlend(W(1, null, { reverse: true }))).toBe(false);
    expect(canBlend(W(2))).toBe(false);
    expect(canBlend(W(0.5))).toBe(true);
    expect(canBlend(W(1, QUAD))).toBe(true);
    expect(canBlend(W(4, SINE))).toBe(true);
  });
});
