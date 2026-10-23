import { describe, it, expect } from "vitest";
import { easing } from "@/lib/easing";
import { pointerToRemap, progressToY, remapMetrics, remapPolyline, yToProgress } from "../remapGeometry";

describe("remapGeometry", () => {
  it("keeps 12px clear over and under the remap", () => {
    expect(remapMetrics(120)).toEqual({ top: 12, span: 96 });
    expect(remapMetrics(64)).toEqual({ top: 12, span: 40 });
    expect(remapMetrics(10).span).toBe(0);
  });

  it("puts source progress 1 at the top and 0 at the foot, clamped", () => {
    const m = remapMetrics(120);
    expect(progressToY(1, m)).toBe(12);
    expect(progressToY(0, m)).toBe(108);
    expect(progressToY(0.5, m)).toBe(60);
    expect(progressToY(2, m)).toBe(12);
    expect(progressToY(-1, m)).toBe(108);
    expect(progressToY(Number.NaN, m)).toBe(108);
  });

  it("reads a y back as source progress, clamped, and 0 in a box with no span", () => {
    const m = remapMetrics(120);
    for (const q of [0, 0.25, 0.5, 1]) expect(yToProgress(progressToY(q, m), m)).toBeCloseTo(q, 12);
    expect(yToProgress(0, m)).toBe(1);
    expect(yToProgress(200, m)).toBe(0);
    expect(yToProgress(5, remapMetrics(10))).toBe(0);
  });

  it("reads a pointer in the box as [output progress, source progress], both clamped", () => {
    const m = remapMetrics(120);
    expect(pointerToRemap(80, 60, 320, m)).toEqual([0.25, 0.5]);
    expect(pointerToRemap(-10, 0, 320, m)).toEqual([0, 1]);
    expect(pointerToRemap(400, 300, 320, m)).toEqual([1, 0]);
    expect(pointerToRemap(10, 60, 0, m)).toEqual([0, 0.5]);
  });

  it("draws a vertex every 4px and one on each knot", () => {
    const m = remapMetrics(120);
    const line = remapPolyline(easing.linear, 64, m);
    expect(line).toHaveLength(17);
    expect(line[0]).toEqual({ x: 0, y: 108 });
    expect(line[16]).toEqual({ x: 64, y: 12 });
    const knotted = remapPolyline(easing.easeInQuad, 64, m, [0.3, 0.5, 0, 1]);
    // 0.5 is on the grid already, the ends are always there
    expect(knotted).toHaveLength(18);
    expect(knotted).toContainEqual({ x: 0.3 * 64, y: progressToY(0.09, m) });
    expect(knotted.map((v) => v.x)).toEqual([...knotted.map((v) => v.x)].sort((a, b) => a - b));
    expect(remapPolyline(easing.linear, 4, m)).toHaveLength(17);
    expect(remapPolyline(easing.linear, 4000, m)).toHaveLength(513);
    expect(remapPolyline(easing.linear, 0, m)).toEqual([]);
  });
});
