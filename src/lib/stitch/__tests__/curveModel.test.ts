import { describe, expect, it } from "vitest";
import type { StitchTimelineClip, VolumePoint } from "@/types";
import { EXPANDED_CURVE } from "../curveGeometry";
import { hitCurve, LINE_HIT_PX, POINT_HIT_PX, volumeCurveModel, type CurveModel } from "../curveModel";
import { buildTimeAxis } from "../timeAxis";
import { clipSpans, createClip, type SourceDurations, type SourceKey } from "../timeline";

/** A stub: points where given, a flat line at y 50 from x 0 to 100, and a near point only where asked. */
function stub(points: Array<{ index: number; x: number; y: number }>, near = -1): CurveModel<null> {
  return {
    points: () => points,
    line: () => [
      { x: 0, y: 50 },
      { x: 100, y: 50 },
    ],
    nearPoint: () => near,
    add: (curve) => ({ curve, index: -1 }),
    move: (base) => base,
    centre: () => ({ x: 0, y: 0 }),
    hover: (_, x) => ({ x, y: 50 }),
    addOnClick: true,
  };
}

describe("hitCurve", () => {
  it("takes the nearest point within POINT_HIT_PX, a later one on a tie", () => {
    expect(POINT_HIT_PX).toBe(7);
    const model = stub([
      { index: 1, x: 20, y: 20 },
      { index: 2, x: 30, y: 20 },
    ]);
    expect(hitCurve(model, null, 21, 21)).toEqual({ kind: "point", index: 1 });
    expect(hitCurve(model, null, 25, 20)).toEqual({ kind: "point", index: 2 });
    expect(hitCurve(model, null, 20, 27)).toEqual({ kind: "point", index: 1 });
    expect(hitCurve(model, null, 20, 27.1)).toEqual({ kind: "none" });
  });

  it("takes the line within LINE_HIT_PX, a point near it on the curve's own units, else nothing", () => {
    expect(LINE_HIT_PX).toBe(6);
    expect(hitCurve(stub([]), null, 40, 56)).toEqual({ kind: "line" });
    expect(hitCurve(stub([]), null, 40, 56.1)).toEqual({ kind: "none" });
    expect(hitCurve(stub([], 3), null, 40, 52)).toEqual({ kind: "point", index: 3 });
    // A point within reach wins over the line
    expect(hitCurve(stub([{ index: 0, x: 40, y: 47 }]), null, 40, 50)).toEqual({ kind: "point", index: 0 });
  });
});

describe("volumeCurveModel", () => {
  // The music in AudioLane.test.tsx: 20 s from 0:00 at 64 px/s from x 20, on an expanded row; its curve in source
  // seconds through the clip's window
  const PPS = 64;
  const x = (t: number) => 20 + t * PPS;
  const y = (gain: number) => 16 + (1 - Math.sqrt(gain)) * 90;
  const clip = (id: string, edgeId: string, init: Partial<StitchTimelineClip> = {}) =>
    createClip({ kind: "edge", edgeId }, { id, ...init });
  const durations: SourceDurations = new Map<SourceKey, number>([["edge:e1", 20]]);
  const axis = buildTimeAxis(clipSpans([clip("a", "e1")], durations, 0), PPS, 20);
  const model = volumeCurveModel(axis, EXPANDED_CURVE, { offset: 0, from: 0, to: 20 });
  const three: VolumePoint[] = [
    { t: 0, gain: 1 },
    { t: 2, gain: 0.25 },
    { t: 6, gain: 1 },
  ];

  it("hits a point, the line and nothing where the audio section's tests press", () => {
    expect(hitCurve(model, three, x(2), y(0.25))).toEqual({ kind: "point", index: 1 });
    expect(hitCurve(model, [], x(3), y(1))).toEqual({ kind: "line" });
    expect(hitCurve(model, [], x(1), y(1) + 3)).toEqual({ kind: "line" });
    expect(hitCurve(model, [], x(3), y(0.25))).toEqual({ kind: "none" });
    // An instant step's steep part is its point, not the line (adding there would replace both)
    const step = [
      { t: 0, gain: 1 },
      { t: 5, gain: 1 },
      { t: 5.01, gain: 0.25 },
      { t: 9, gain: 0.25 },
    ];
    expect(hitCurve(model, step, x(5.005), (y(1) + y(0.25)) / 2)).toMatchObject({ kind: "point" });
  });

  it("adds a point on the line, moves one, centres it, hovers on the line and moves the whole line with ⌥", () => {
    expect(model.add([], x(1), y(1) + 3)).toEqual({ curve: [{ t: 1, gain: 1 }], index: 0 });
    expect(model.move(three, 1, x(3), y(1))[1]).toEqual({ t: 3, gain: 1 });
    expect(model.centre(three, 1)).toEqual({ x: x(2), y: y(0.25) });
    // Halfway from 0.25 to 1, linear in display level: a quarter of the way down from 0 dB
    expect(model.hover(three, x(4))).toEqual({ x: x(4), y: expect.closeTo(16 + 0.25 * 90, 9) });
    // Past the window's end, the ghost stays on its last x
    expect(model.hover([], 99999)?.x).toBe(x(20));
    expect(model.shift!([], 45)).toEqual([
      { t: 0, gain: expect.closeTo(0.25) },
      { t: 20, gain: expect.closeTo(0.25) },
    ]);
    expect(model.addOnClick).toBe(true);
  });
});
