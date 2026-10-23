import { describe, it, expect, vi } from "vitest";
import {
  LINEAR_CURVE,
  MAX_SLOPE,
  bezierCurve,
  getAllEasingNames,
  isMonotoneEasing,
  pointsCurve,
  presetCurve,
  windowCurve,
} from "..";

describe("presetCurve", () => {
  it.each(getAllEasingNames())("%s is a time remap: monotone, 0 at 0, 1 at 1, inside [0, 1]", (name) => {
    expect(isMonotoneEasing(name)).toBe(true);
    const { ease } = presetCurve(name)!;
    expect(ease(0) === 0).toBe(true);
    expect(Math.abs(ease(1) - 1)).toBeLessThanOrEqual(1e-12);
    let previous = ease(0);
    let worstStepBack = 0;
    let outside = 0;
    for (let i = 1; i <= 100_000; i++) {
      const value = ease(i / 100_000);
      worstStepBack = Math.max(worstStepBack, previous - value);
      if (value < 0 || value > 1) outside++;
      previous = value;
    }
    expect(worstStepBack).toBeLessThanOrEqual(1e-12);
    expect(outside).toBe(0);
  });

  it("refuses names that are not the library's own, without a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const name of ["toString", "constructor", "nope", ""]) {
      expect(isMonotoneEasing(name)).toBe(false);
      expect(presetCurve(name)).toBeNull();
    }
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("reports finite slopes, the Expo jump and Circ's vertical end kept out", () => {
    expect(presetCurve("easeInQuad")!.slope(0.5)).toBeCloseTo(1, 6);
    expect(Math.abs(presetCurve("easeInExpo")!.slope(0) - 0.0068)).toBeLessThan(1e-3);
    const circEnd = presetCurve("easeInCirc")!.slope(1);
    expect(Number.isFinite(circEnd)).toBe(true);
    expect(circEnd).toBeLessThanOrEqual(MAX_SLOPE);
    for (const name of getAllEasingNames()) {
      for (const u of [0, 0.5, 1]) expect(Number.isNaN(presetCurve(name)!.slope(u)), `${name} at ${u}`).toBe(false);
    }
  });

  it("clamps its input: the raw Circ is NaN outside [0, 1]", () => {
    const circ = presetCurve("easeInCirc")!;
    expect(circ.ease(1.5)).toBe(1);
    expect(circ.ease(-0.5)).toBe(0);
  });
});

describe("windowCurve", () => {
  const quad = presetCurve("easeInQuad")!;

  it("is the part [a, b] stretched back to [0, 1], ends exact", () => {
    const part = windowCurve(quad, 0.2, 0.7)!;
    expect(part.ease(0)).toBe(0);
    expect(part.ease(1)).toBe(1);
    expect(part.ease(-1)).toBe(0);
    expect(part.ease(2)).toBe(1);
    const c = (u: number) => u * u;
    for (let i = 1; i < 50; i++) {
      const p = i / 50;
      expect(part.ease(p)).toBeCloseTo((c(0.2 + p * 0.5) - c(0.2)) / (c(0.7) - c(0.2)), 12);
    }
  });

  it("has the slope of its part", () => {
    const part = windowCurve(presetCurve("easeInOutSine")!, 0.1, 0.8)!;
    for (let i = 1; i < 20; i++) {
      const p = i / 20;
      const h = 1e-6;
      const difference = (part.ease(p + h) - part.ease(p - h)) / (2 * h);
      expect(Math.abs(part.slope(p) - difference)).toBeLessThanOrEqual(1e-4 * difference);
    }
  });

  it("is null inside a freeze and for an empty part", () => {
    const freeze = pointsCurve([
      [0, 0],
      [0.3, 0.5],
      [0.6, 0.5],
      [1, 1],
    ]);
    expect(windowCurve(freeze, 0.35, 0.55)).toBeNull();
    expect(windowCurve(LINEAR_CURVE, 0.5, 0.5)).toBeNull();
    expect(windowCurve(LINEAR_CURVE, 0.7, 0.2)).toBeNull();
    // A part that rises 1e-9 or less is a freeze too: easeInSine rises 7.7e-10 over its first 2.5e-5
    const inSine = presetCurve("easeInSine")!;
    expect(windowCurve(inSine, 0, 2.5e-5)).toBeNull();
    expect(windowCurve(inSine, 0, 3e-5)).not.toBeNull();
  });

  it("keeps a part narrower than a millionth, monotone", () => {
    // A split piece near the steepest point of a 60 s ramp at 0.1× (the narrowest window an edit makes)
    const part = windowCurve(presetCurve("easeInOutSine")!, 0.5, 0.5 + 7.85e-7)!;
    expect(part).not.toBeNull();
    let previous = 0;
    let worstStepBack = 0;
    for (let i = 1; i <= 10_000; i++) {
      const value = part.ease(i / 10_000);
      worstStepBack = Math.max(worstStepBack, previous - value);
      previous = value;
    }
    expect(worstStepBack).toBeLessThanOrEqual(0);
    expect(previous).toBe(1);
  });
});

describe("every kind", () => {
  it("reads NaN progress as 0", () => {
    const curves = [
      LINEAR_CURVE,
      presetCurve("easeInOutCirc")!,
      bezierCurve([0.42, 0, 0.58, 1]),
      pointsCurve([
        [0, 0],
        [0.3, 0.1],
        [0.7, 0.8],
        [1, 1],
      ]),
      windowCurve(presetCurve("easeInQuad")!, 0.2, 0.7)!,
    ];
    for (const curve of curves) {
      expect(curve.ease(Number.NaN)).toBe(0);
      expect(Number.isFinite(curve.slope(Number.NaN))).toBe(true);
    }
  });
});
