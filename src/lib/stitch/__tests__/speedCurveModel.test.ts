import { describe, expect, it } from "vitest";
import { getEasingFunction, MAX_CURVE_POINTS, MIN_POINT_GAP, pointsCurve } from "@/lib/easing";
import type { ClipWarp, ClipWarpCurve } from "@/types";
import { hitCurve } from "../curveModel";
import { remapMetrics } from "../remapGeometry";
import { speedCurveModel } from "../speedCurveModel";
import { editablePoints, IDENTITY_WARP, normalizeWarp, pointsOfWarp, warpCurve } from "../warp";

// A clip at x 20, 320 px wide, in a 120 px box: output progress p at X(p), source progress q at Y(q)
const view = { x: 20, width: 320, metrics: remapMetrics(120), maxError: 0.002 };
const model = speedCurveModel(view);
const X = (p: number) => 20 + 320 * p;
const Y = (q: number) => 12 + (1 - q) * 96;
const W = (curve: ClipWarpCurve | null, extra: Partial<ClipWarp> = {}): ClipWarp =>
  normalizeWarp({ speed: 1, curve, reverse: false, blend: false, ...extra }) ?? IDENTITY_WARP;
const points = (...p: Array<[number, number]>): ClipWarpCurve => ({ kind: "points", points: p });
const pointsOf = (w: ClipWarp) => (w.curve?.kind === "points" ? w.curve.points : []);

describe("speedCurveModel", () => {
  it("offers the interior knots of a points curve over the whole clip, and none on any other line", () => {
    expect(model.points(W(points([0, 0], [0.5, 0.25], [1, 1])))).toEqual([{ index: 1, x: 180, y: 84 }]);
    expect(model.points(W({ kind: "preset", name: "easeInQuad" }))).toEqual([]);
    expect(model.points(W({ kind: "bezier", handles: [0.42, 0, 0.58, 1] }))).toEqual([]);
    expect(model.points(W(points([0, 0], [0.5, 0.25], [1, 1]), { window: [0, 0.5] }))).toEqual([]);
    expect(model.points(IDENTITY_WARP)).toEqual([]);
    expect(model.centre(W(points([0, 0], [0.5, 0.25], [1, 1])), 1)).toEqual({ x: 180, y: 84 });
  });

  it("draws the line through the knots in lane x, and the same line for the same warp", () => {
    const w = W(points([0, 0], [0.3, 0.1], [1, 1]));
    const line = model.line(w);
    expect(line[0]).toEqual({ x: 20, y: 108 });
    expect(line[line.length - 1]).toEqual({ x: 340, y: 12 });
    expect(line).toContainEqual({ x: X(0.3), y: Y(0.1) });
    expect(model.line(w)).toBe(line);
    // Another view draws its own
    expect(speedCurveModel({ ...view, x: 30 }).line(w)[0]).toEqual({ x: 30, y: 108 });
  });

  it("turns a line press near a knot into a press on that knot", () => {
    const w = W(points([0, 0], [0.3, 0.1], [0.7, 0.9], [1, 1]));
    expect(model.nearPoint(w, X(0.31), 0)).toBe(1);
    expect(model.nearPoint(w, X(0.3 + MIN_POINT_GAP), 0)).toBe(-1);
    expect(model.nearPoint(W({ kind: "preset", name: "easeInQuad" }), X(0.5), 0)).toBe(-1);
    // On a long clip the gap is wide on screen: only a press within POINT_HIT_PX of the knot takes it there
    const wide = speedCurveModel({ ...view, width: 3840 });
    expect(wide.nearPoint(w, 20 + 3840 * 0.3 + 5, 0)).toBe(1);
    expect(wide.nearPoint(w, 20 + 3840 * 0.3 + 70, 0)).toBe(-1);
    // Further off in the gap the press drags it all the same, and the hover says so: no ghost of a point added
    expect(wide.takes!(w, 20 + 3840 * 0.3 + 70)).toBe(1);
    expect(wide.hover(w, 20 + 3840 * 0.3 + 70)).toBeNull();
    expect(wide.takes!(w, 20 + 3840 * (0.3 + MIN_POINT_GAP) + 1)).toBe(-1);
    expect(wide.takes!(w, 20 + 3840 * 0.01)).toBe(-1);
    expect(wide.takes!(W({ kind: "preset", name: "easeInQuad" }), X(0.5))).toBe(-1);
  });

  it("adds a point on a preset by baking it into points at the bake budget, with a knot where it was pressed", () => {
    const ease = getEasingFunction("easeInOutSine");
    const w = W({ kind: "preset", name: "easeInOutSine" });
    const { curve, index } = model.add(w, X(0.42), 0);
    const knots = pointsOf(curve);
    expect(curve.curve?.kind).toBe("points");
    expect("window" in curve).toBe(false);
    expect(index).toBeGreaterThan(0);
    expect(index).toBeLessThan(knots.length - 1);
    expect(knots[index][0]).toBeCloseTo(0.42, 12);
    // Every knot sits on the named curve, the pressed one too
    knots.forEach(([p, q]) => expect(Math.abs(q - ease(p))).toBeLessThan(1e-9));
    expect(knots).toEqual(pointsOfWarp(w, view.maxError, knots[index][0])!.points);
  });

  it("drags a knot under the pointer on a preset even where the bake put one of its own beside it", () => {
    const w = W({ kind: "preset", name: "easeInOutSine" });
    const baked = pointsOfWarp(w, view.maxError)!.points;
    const near = baked[Math.floor(baked.length / 2)][0];
    const p = near + MIN_POINT_GAP / 2;
    const { curve, index } = model.add(w, X(p), 0);
    const knots = pointsOf(curve);
    expect(knots[index][0]).toBeCloseTo(p, 12);
    // The knot the bake had there went: none within the gap of the one pressed
    knots.forEach(([x], i) => {
      if (i !== index) expect(Math.abs(x - knots[index][0])).toBeGreaterThanOrEqual(MIN_POINT_GAP);
    });
    expect(model.hover(w, X(p))).toEqual({ x: X(p), y: expect.closeTo(Y(warpCurve(w.curve).ease(p)), 9) });
  });

  it("bakes a bezier and a split piece's part of a ramp into points that keep the curve they play", () => {
    for (const w of [
      W({ kind: "bezier", handles: [0.42, 0, 0.58, 1] }),
      W(points([0, 0], [0.5, 0.25], [1, 1]), { window: [0.25, 0.75] }),
    ]) {
      const ease = warpCurve(w.curve, w.window).ease;
      const { curve, index } = model.add(w, X(0.6), 0);
      const knots = pointsOf(curve);
      expect(curve.curve?.kind).toBe("points");
      expect("window" in curve).toBe(false);
      // More than the ends and the press: a bake, not a straight line restarted
      expect(knots.length).toBeGreaterThan(3);
      knots.forEach(([p, q], i) => {
        if (i !== index) expect(Math.abs(q - ease(p))).toBeLessThan(1e-6);
      });
      expect(Math.abs(knots[index][1] - ease(knots[index][0]))).toBeLessThanOrEqual(view.maxError);
    }
  });

  it("adds on the straight line of a clip at its own speed, takes a knot within the gap, refuses an end", () => {
    expect(model.add(IDENTITY_WARP, X(0.4), 0)).toEqual({
      curve: { speed: 1, curve: points([0, 0], [0.4, 0.4], [1, 1]), reverse: false, blend: false },
      index: 1,
    });
    const w = W(points([0, 0], [0.3, 0.1], [1, 1]));
    const taken = model.add(w, X(0.31), 0);
    expect(taken.index).toBe(1);
    expect(pointsOf(taken.curve)).toEqual(pointsOf(w));
    expect(model.add(w, X(0.01), 0)).toEqual({ curve: w, index: -1 });
    expect(model.add(w, X(0.995), 0)).toEqual({ curve: w, index: -1 });
    // A stored curve already at MAX_CURVE_POINTS takes no new knot (one more and the store would drop the ramp)
    const crowd = Array.from({ length: MAX_CURVE_POINTS - 2 }, (_, i): [number, number] => [0.3 + i * 1e-4, 0.1 + i * 1e-4]);
    const crowded = W(points([0, 0], ...crowd, [1, 1]));
    expect(pointsOf(crowded)).toHaveLength(MAX_CURVE_POINTS);
    expect(model.add(crowded, X(0.8), 0)).toEqual({ curve: crowded, index: -1 });
    expect(model.hover(crowded, X(0.8))).toBeNull();
    // Within a knot's gap it drags that knot, as anywhere: no ghost there either
    expect(model.add(crowded, X(0.31), 0).index).toBeGreaterThan(0);
    expect(model.takes!(crowded, X(0.31))).toBe(model.add(crowded, X(0.31), 0).index);
    expect(model.hover(crowded, X(0.31))).toBeNull();
    // A split piece's part of its ramp becomes the whole clip's points: the window goes
    const piece = W(points([0, 0], [0.5, 0.25], [1, 1]), { window: [0.25, 0.75] });
    const added = model.add(piece, X(0.6), 0);
    expect(added.index).not.toBe(-1);
    expect("window" in added.curve).toBe(false);
  });

  it("moves a knot between its neighbours (y) and their gap (x); the ends never move", () => {
    const w = W(points([0, 0], [0.3, 0.1], [0.7, 0.9], [1, 1]));
    expect(pointsOf(model.move(w, 1, X(0.4), Y(0.2)))[1]).toEqual([expect.closeTo(0.4, 12), expect.closeTo(0.2, 12)]);
    expect(pointsOf(model.move(w, 2, X(0.7), Y(0)))[2]).toEqual([0.7, 0.1]);
    expect(pointsOf(model.move(w, 1, X(0.9), Y(0.1)))[1]).toEqual([expect.closeTo(0.68, 12), expect.closeTo(0.1, 12)]);
    expect(pointsOf(model.move(w, 0, X(0.5), Y(0.5)))).toEqual(pointsOf(w));
    expect(pointsOf(model.move(w, 3, X(0.5), Y(0.5)))).toEqual(pointsOf(w));
  });

  it("puts the hover ghost on the line, and adds a point only after a drag", () => {
    const w = W(points([0, 0], [0.3, 0.1], [1, 1]));
    const ease = pointsCurve(pointsOf(w)).ease;
    expect(model.hover(w, X(0.6))).toEqual({ x: X(0.6), y: expect.closeTo(Y(ease(0.6)), 9) });
    // None where a press would add nothing: within the gap of an end (past the line, its end)
    for (const at of [X(0.01), X(0.99), 9999]) expect(model.hover(w, at)).toBeNull();
    expect(model.hover(W({ kind: "preset", name: "easeInOutSine" }), X(0.01))).toBeNull();
    expect(model.hover(IDENTITY_WARP, X(0.5))).toEqual({ x: X(0.5), y: Y(0.5) });
    expect(hitCurve(model, w, X(0.6), Y(ease(0.6)) + 2)).toEqual({ kind: "line" });
    expect(model.addOnClick).toBe(false);
    expect(model.shift).toBeUndefined();
  });

  it("shows the ghost only where a press adds a knot, and that knot lands under the pointer", () => {
    const curves = [
      W(points([0, 0], [0.3, 0.1], [0.7, 0.9], [1, 1])),
      W({ kind: "preset", name: "easeInOutCubic" }),
      W({ kind: "bezier", handles: [0.7, 0, 0.3, 1] }),
      W(points([0, 0], [0.5, 0.25], [1, 1]), { window: [0.25, 0.75] }),
      IDENTITY_WARP,
    ];
    // A 10 s clip at 64 and at 480 px/s
    for (const width of [640, 4800]) {
      const wide = speedCurveModel({ ...view, width });
      for (const w of curves) {
        const before = editablePoints(w)?.length ?? 0;
        // Finely along a points curve, past its knots' gaps; a line to bake is pressed less often (a bake a press)
        for (let x = 20; x <= 20 + width; x += width / (before > 0 ? 160 : 24)) {
          const ghost = wide.hover(w, x);
          const added = wide.add(w, x, 0);
          const knots = pointsOf(added.curve);
          if (ghost === null) {
            // Refused (an end's gap), or a press that drags a knot already there
            expect(added.index === -1 || knots.length === before).toBe(true);
            continue;
          }
          expect(added.index).toBeGreaterThan(0);
          if (before > 0) expect(knots).toHaveLength(before + 1);
          expect(Math.abs(20 + knots[added.index][0] * width - x)).toBeLessThan(1);
        }
      }
    }
  });
});
