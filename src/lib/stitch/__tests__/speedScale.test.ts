import { describe, it, expect } from "vitest";
import { nudgeSpeed, sliderToSpeed, speedToSlider } from "../speedScale";
import { SPEED_PRESETS } from "../warp";

describe("the speed slider's scale", () => {
  it("puts 0.1× at 0, 1× at 50 and 10× at 100, clamped", () => {
    expect(speedToSlider(0.1)).toBeCloseTo(0, 12);
    expect(speedToSlider(1)).toBe(50);
    expect(speedToSlider(10)).toBe(100);
    expect(speedToSlider(0.04)).toBe(0);
    expect(speedToSlider(50)).toBe(100);
  });

  it("reads a position as a preset within half a step, else a three-figure speed", () => {
    for (const [pos, speed] of [
      [0, 0.1],
      [19, 0.24],
      [20, 0.25],
      [21, 0.263],
      [35, 0.5],
      [50, 1],
      [51, 1.05],
      [64, 1.91],
      [65, 2],
      [66, 2.09],
      [80, 4],
      [81, 4.17],
      [99, 9.55],
      [100, 10],
      [-5, 0.1],
      [140, 10],
    ] as const) {
      expect(sliderToSpeed(pos)).toBe(speed);
    }
  });

  it("gives 101 speeds in order, each preset at one position, and each preset back from its own", () => {
    const speeds = Array.from({ length: 101 }, (_, pos) => sliderToSpeed(pos));
    expect(new Set(speeds).size).toBe(101);
    for (let i = 1; i < speeds.length; i++) expect(speeds[i]).toBeGreaterThan(speeds[i - 1]);
    for (const preset of SPEED_PRESETS) {
      expect(speeds.filter((s) => s === preset)).toHaveLength(1);
      expect(sliderToSpeed(Math.round(speedToSlider(preset)))).toBe(preset);
    }
  });

  it("nudges to the next whole position past the speed (⇧: ten)", () => {
    expect(nudgeSpeed(1, 1, false)).toBe(1.05);
    expect(nudgeSpeed(1.9, 1, false)).toBe(1.91);
    expect(nudgeSpeed(1.91, 1, false)).toBe(2);
    expect(nudgeSpeed(1, 1, true)).toBe(1.58);
    expect(nudgeSpeed(1, -1, false)).toBe(0.955);
    expect(nudgeSpeed(1.23, 1, false)).toBe(1.26);
    expect(nudgeSpeed(0.04, 1, false)).toBe(0.105);
    expect(nudgeSpeed(0.04, -1, false)).toBe(0.1);
    expect(nudgeSpeed(50, 1, false)).toBe(10);
  });

  it("never gives a preset or a rounded speed back from a step: it passes the position that would", () => {
    // 2× sits at 65.05 and 1.05× at 51.06: one whole position down reads the same speed
    expect(nudgeSpeed(2, -1, false)).toBe(1.91);
    expect(nudgeSpeed(1.05, -1, false)).toBe(1);
    expect(nudgeSpeed(0.25, 1, false)).toBe(0.263);
    expect(nudgeSpeed(0.5, 1, false)).toBe(0.525);
    expect(nudgeSpeed(4, -1, false)).toBe(3.8);
    for (let pos = 1; pos < 100; pos++) {
      const speed = sliderToSpeed(pos);
      expect(nudgeSpeed(speed, 1, false)).toBeGreaterThan(speed);
      expect(nudgeSpeed(speed, -1, false)).toBeLessThan(speed);
    }
    // At the ends there is nowhere to go
    expect(nudgeSpeed(10, 1, false)).toBe(10);
    expect(nudgeSpeed(0.1, -1, false)).toBe(0.1);
  });
});
