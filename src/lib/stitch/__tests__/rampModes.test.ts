import { describe, it, expect } from "vitest";
import type { ClipWarpCurve } from "@/types";
import { DEFAULT_CUSTOM_BEZIER, getAllEasingNames, getEasingBezier, isIdentityPoints } from "@/lib/easing";
import { DEFAULT_RAMP, RAMP_PRESETS, rampModeOf, seedRamp } from "../rampModes";
import { bakeError, normalizeWarp, pointsOfWarp, warpCurve } from "../warp";

const QUAD: ClipWarpCurve = { kind: "preset", name: "easeInQuad" };
const BEZIER: ClipWarpCurve = { kind: "bezier", handles: [0.2, 0.1, 0.6, 0.9] };
const POINTS: ClipWarpCurve = {
  kind: "points",
  points: [
    [0, 0],
    [0.4, 0.1],
    [1, 1],
  ],
};
const PIECE: [number, number] = [0.2, 0.7];
/** What Points bakes: the ramp as played, as points within the budget. */
const baked = (curve: ClipWarpCurve, window?: [number, number], maxError = 0.01) =>
  pointsOfWarp({ speed: 1, curve, ...(window ? { window } : {}), reverse: false, blend: false }, maxError);

describe("rampModeOf", () => {
  it("shows a stored ramp as its kind, and a split piece as points", () => {
    expect(rampModeOf(null)).toBe("none");
    expect(rampModeOf(QUAD)).toBe("preset");
    expect(rampModeOf(BEZIER)).toBe("bezier");
    expect(rampModeOf(POINTS)).toBe("points");
    expect(rampModeOf(BEZIER, [0, 1])).toBe("bezier");
    for (const curve of [QUAD, BEZIER, POINTS]) expect(rampModeOf(curve, PIECE)).toBe("points");
    expect(rampModeOf(null, PIECE)).toBe("none");
  });
});

describe("RAMP_PRESETS", () => {
  it("is every named easing but linear, in the library's order", () => {
    expect(RAMP_PRESETS).toHaveLength(23);
    expect(RAMP_PRESETS).not.toContain("linear");
    expect(RAMP_PRESETS).toEqual(getAllEasingNames().filter((name) => name !== "linear"));
  });
});

describe("seedRamp", () => {
  it("None is no ramp, from anything", () => {
    for (const curve of [QUAD, BEZIER, POINTS]) {
      expect(seedRamp("none", curve)).toBeNull();
      expect(seedRamp("none", curve, PIECE)).toBeNull();
    }
  });

  it("Preset keeps a preset's name, else starts from the default", () => {
    expect(seedRamp("preset", null)).toEqual({ kind: "preset", name: DEFAULT_RAMP });
    expect(seedRamp("preset", BEZIER)).toEqual({ kind: "preset", name: DEFAULT_RAMP });
    expect(seedRamp("preset", POINTS)).toEqual({ kind: "preset", name: DEFAULT_RAMP });
    expect(seedRamp("preset", QUAD, PIECE)).toEqual(QUAD);
    expect(seedRamp("preset", BEZIER, PIECE)).toEqual({ kind: "preset", name: DEFAULT_RAMP });
  });

  it("Bezier keeps a bezier's handles, takes a preset's bezier, else the default bezier", () => {
    expect(seedRamp("bezier", null)).toEqual({ kind: "bezier", handles: DEFAULT_CUSTOM_BEZIER });
    expect(seedRamp("bezier", QUAD)).toEqual({ kind: "bezier", handles: getEasingBezier("easeInQuad") });
    expect(seedRamp("bezier", POINTS)).toEqual({ kind: "bezier", handles: DEFAULT_CUSTOM_BEZIER });
    expect(seedRamp("bezier", BEZIER, PIECE)).toEqual(BEZIER);
    expect(seedRamp("bezier", QUAD, PIECE)).toEqual({ kind: "bezier", handles: getEasingBezier("easeInQuad") });
    expect(seedRamp("bezier", POINTS, PIECE)).toEqual({ kind: "bezier", handles: DEFAULT_CUSTOM_BEZIER });
    // Fresh handles: never the library's own array
    const seeded = seedRamp("bezier", null) as { handles: number[] };
    expect(seeded.handles).not.toBe(DEFAULT_CUSTOM_BEZIER);
  });

  it("Points bakes what plays, the default ramp from None, within the budget given", () => {
    const fromNone = seedRamp("points", null)!;
    expect(fromNone).toEqual(baked({ kind: "preset", name: DEFAULT_RAMP }));
    expect(isIdentityPoints((fromNone as { points: Array<[number, number]> }).points)).toBe(false);
    expect(seedRamp("points", QUAD)).toEqual(baked(QUAD));
    expect(seedRamp("points", BEZIER)).toEqual(baked(BEZIER));
    for (const curve of [QUAD, BEZIER, POINTS]) expect(seedRamp("points", curve, PIECE)).toEqual(baked(curve, PIECE));
    expect(seedRamp("points", QUAD, undefined, 0.002)).toEqual(baked(QUAD, undefined, 0.002));
    expect(seedRamp("points", QUAD, undefined, 0.002)).not.toEqual(seedRamp("points", QUAD));
  });

  it("Points keeps a ramp that never strays the budget from the diagonal, by its furthest knot", () => {
    // 0.0058 off the diagonal at most, under the 0.01 budget: a bake alone is the straight line, no ramp
    const gentle: ClipWarpCurve = { kind: "bezier", handles: [0.42, 0.4, 0.58, 0.6] };
    expect(isIdentityPoints(baked(gentle)!.points)).toBe(true);
    const seeded = seedRamp("points", gentle) as { kind: "points"; points: Array<[number, number]> };
    expect(seeded.kind).toBe("points");
    expect(seeded.points).toHaveLength(3);
    expect(isIdentityPoints(seeded.points)).toBe(false);
    expect(normalizeWarp({ speed: 1, curve: seeded, reverse: false, blend: false })?.curve).toEqual(seeded);
  });

  it("Points on a gentle S stays within the budget, nearer the drawn curve than the straight line", () => {
    const gap = (f: (x: number) => number, g: (x: number) => number) => {
      let worst = 0;
      for (let i = 0; i <= 4096; i++) worst = Math.max(worst, Math.abs(f(i / 4096) - g(i / 4096)));
      return worst;
    };
    // The rail's budget (half a source frame) and the default; one knot on one hump missed the other by about 1.5×
    for (const [handles, maxError] of [
      [[0.42, 0.39, 0.58, 0.61], 0.01],
      [[0.5, 0.484, 0.5, 0.516], bakeError(4.2, 24)],
      [[0.45, 0.445, 0.55, 0.555], bakeError(10, 24)],
    ] as Array<[[number, number, number, number], number]>) {
      const gentle: ClipWarpCurve = { kind: "bezier", handles };
      expect(isIdentityPoints(baked(gentle, undefined, maxError)!.points)).toBe(true);
      const seeded = seedRamp("points", gentle, undefined, maxError) as { kind: "points"; points: Array<[number, number]> };
      expect(isIdentityPoints(seeded.points)).toBe(false);
      const drawn = warpCurve(gentle).ease;
      const error = gap(warpCurve(seeded).ease, drawn);
      expect(error).toBeLessThanOrEqual(maxError);
      expect(error).toBeLessThan(gap((x) => x, drawn));
    }
  });
});
