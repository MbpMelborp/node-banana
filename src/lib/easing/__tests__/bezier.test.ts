import { describe, it, expect } from "vitest";
import { MAX_SLOPE, bezierCurve, createBezierEasing, isIdentityBezier } from "..";

type Handles = [number, number, number, number];

function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

/** The curve's own polynomials, for oracles. */
function polynomials([x1, y1, x2, y2]: Handles) {
  const cx = 3 * x1; const bx = 3 * (x2 - x1) - cx; const ax = 1 - cx - bx;
  const cy = 3 * y1; const by = 3 * (y2 - y1) - cy; const ay = 1 - cy - by;
  return {
    x: (t: number) => ((ax * t + bx) * t + cx) * t,
    y: (t: number) => ((ay * t + by) * t + cy) * t,
  };
}

/** The curve at u by a 200-step bisection on x: exact to the float spacing. */
function exactEase(handles: Handles, u: number): number {
  const { x, y } = polynomials(handles);
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (x(mid) < u) lo = mid;
    else hi = mid;
  }
  return y(lo);
}

/** The solver the Ease Curve node had before (1e-6 in x), as the oracle for how far its render moves. */
function previousBezier(p1x: number, p1y: number, p2x: number, p2y: number): (t: number) => number {
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  const x1 = clamp(p1x); const y1 = clamp(p1y);
  const x2 = clamp(p2x); const y2 = clamp(p2y);
  const cx = 3 * x1; const bx = 3 * (x2 - x1) - cx; const ax = 1 - cx - bx;
  const cy = 3 * y1; const by = 3 * (y2 - y1) - cy; const ay = 1 - cy - by;
  const sampleCurveX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleCurveY = (t: number) => ((ay * t + by) * t + cy) * t;
  const sampleDerivativeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  const solveCurveX = (x: number) => {
    let t2 = x; const epsilon = 1e-6;
    for (let i = 0; i < 8; i++) {
      const x2 = sampleCurveX(t2) - x;
      if (Math.abs(x2) < epsilon) return t2;
      const d2 = sampleDerivativeX(t2);
      if (Math.abs(d2) < epsilon) break;
      t2 -= x2 / d2;
    }
    let t0 = 0; let t1 = 1; t2 = x;
    while (t0 < t1) {
      const x2 = sampleCurveX(t2);
      if (Math.abs(x2 - x) < epsilon) return t2;
      if (x > x2) t0 = t2; else t1 = t2;
      t2 = (t1 + t0) / 2;
    }
    return t2;
  };
  return (t: number) => sampleCurveY(solveCurveX(clamp(t)));
}

function worstStepBack(ease: (u: number) => number, steps: number): number {
  let previous = ease(0);
  let worst = 0;
  for (let i = 1; i <= steps; i++) {
    const value = ease(i / steps);
    worst = Math.max(worst, previous - value);
    previous = value;
  }
  return worst;
}

describe("bezierCurve", () => {
  it.each<Handles>([
    [0.809, 0.95, 0.99983, 0.595],
    [1, 0.162, 0.983, 0],
    [1, 0, 0, 1],
    [1, 1, 1, 1],
    [0, 1, 1, 0],
    [1, 0, 1, 0],
    [0.55, 0, 1, 0.45],
  ])("never runs back on a million steps: [%s, %s, %s, %s]", (...handles) => {
    expect(worstStepBack(bezierCurve(handles).ease, 1_000_000)).toBeLessThanOrEqual(1e-12);
  });

  it("never runs back for a thousand handle sets near the edges", () => {
    const random = lcg(11);
    const pick = () => {
      const r = random();
      if (r < 0.2) return 0;
      if (r < 0.4) return 1;
      if (r < 0.5) return 0.5 + (random() - 0.5) * 2e-3;
      return random();
    };
    for (let k = 0; k < 1000; k++) {
      const handles: Handles = [0.8 + 0.2 * random(), pick(), random() < 0.5 ? 0.8 + 0.2 * random() : pick(), pick()];
      expect(worstStepBack(bezierCurve(handles).ease, 2000), handles.join(", ")).toBeLessThanOrEqual(1e-12);
    }
  });

  it("matches a 200-step bisection to 1e-9 for random handles", () => {
    // It solves x to 1e-10: its value is the curve's at an x within 1e-10 of u, which next to a vertical tangent (x1
    // near 1, x2 near 0) can be 4e-4 of progress from the curve's at u itself; random u never land that close
    const random = lcg(5);
    for (let k = 0; k < 200; k++) {
      const handles: Handles = [random(), random(), random(), random()];
      const ease = bezierCurve(handles).ease;
      for (let j = 0; j < 50; j++) {
        const u = random();
        expect(Math.abs(ease(u) - exactEase(handles, u)), `${handles.join(", ")} at ${u}`).toBeLessThanOrEqual(1e-9);
      }
    }
  });

  it("gives the analytic slope", () => {
    const random = lcg(3);
    for (let k = 0; k < 100; k++) {
      const handles: Handles = [0.05 + 0.9 * random(), random(), 0.05 + 0.9 * random(), random()];
      const { ease, slope } = bezierCurve(handles);
      for (let j = 0; j < 20; j++) {
        const u = 0.05 + 0.9 * random();
        const h = 1e-5;
        const difference = (ease(u + h) - ease(u - h)) / (2 * h);
        expect(Math.abs(slope(u) - difference), `${handles.join(", ")} at ${u}`).toBeLessThanOrEqual(
          1e-4 * Math.max(difference, 1e-2),
        );
      }
    }
    const easeInOut = bezierCurve([0.42, 0, 0.58, 1]);
    expect(easeInOut.slope(0)).toBe(0);
    expect(easeInOut.slope(1)).toBe(0);
    expect(bezierCurve([0, 1, 1, 0]).slope(0)).toBe(MAX_SLOPE);
  });

  it("gives the slope at an end whose handle sits on it, towards the next handle off it", () => {
    // Both derivatives are 0 there: CSS ease-out leaves 0 at 1 / 0.58, and ease-in reaches 1 at it. The last two with a
    // handle on (1, 1) pin the rounding the power form leaves in y and in x at t = 1
    const cases: Array<[Handles, 0 | 1, number]> = [
      [[0, 0, 0.58, 1], 0, 1 / 0.58],
      [[0.42, 0, 1, 1], 1, 1 / 0.58],
      [[0, 0, 0.3, 0.9], 0, 3],
      [[0, 0, 0.58, 0], 0, 0],
      [[0.2, 0.6, 1, 1], 1, 0.5],
      [[0.1, 0.3, 1, 1], 1, 0.7 / 0.9],
      [[0.33, 0.7, 1, 1], 1, 0.3 / 0.67],
    ];
    for (const [handles, end, expected] of cases) {
      const { ease, slope } = bezierCurve(handles);
      const h = 1e-6;
      const difference = end === 0 ? ease(h) / h : (1 - ease(1 - h)) / h;
      expect(slope(end), `${handles.join(", ")} at ${end}`).toBeCloseTo(expected, 9);
      expect(Math.abs(slope(end) - difference), `${handles.join(", ")} at ${end}`).toBeLessThanOrEqual(
        1e-3 * Math.max(expected, 1),
      );
    }
    // A vertical start; a curve on the diagonal standing still at an end, or in its middle with the handles crossed
    expect(bezierCurve([0, 0, 0, 0.5]).slope(0)).toBe(MAX_SLOPE);
    expect(bezierCurve([0, 0, 0, 0]).slope(0)).toBe(1);
    expect(bezierCurve([1, 1, 1, 1]).slope(1)).toBe(1);
    expect(bezierCurve([1, 1, 0, 0]).slope(0.5)).toBe(1);
  });

  it("moves the Ease Curve node's render by under 1e-4 of progress for random handles", () => {
    const random = lcg(17);
    let worst = 0;
    for (let k = 0; k < 300; k++) {
      const handles: Handles = [random(), random(), random(), random()];
      const now = bezierCurve(handles).ease;
      const before = previousBezier(...handles);
      for (let i = 0; i <= 200; i++) worst = Math.max(worst, Math.abs(now(i / 200) - before(i / 200)));
    }
    expect(worst).toBeLessThanOrEqual(1e-4);
  });

  it("moves it further only next to a vertical inflection, onto the curve the old solver missed by up to 6e-3", () => {
    // x1 near 1 and x2 near 0: the slope there turns 1e-10 in x into about 1e-7 of progress
    const handles: Handles = [1, 0.0755, 1e-6, 0.8985];
    const exact = exactEase(handles, 0.5);
    expect(Math.abs(bezierCurve(handles).ease(0.5) - exact)).toBeLessThanOrEqual(1e-6);
    expect(Math.abs(previousBezier(...handles)(0.5) - exact)).toBeGreaterThan(5e-3);
  });
});

describe("isIdentityBezier", () => {
  it("is each handle within 1e-9 of the diagonal, clamped as the curve clamps it", () => {
    expect(isIdentityBezier([0.2, 0.2, 0.8, 0.8])).toBe(true);
    expect(isIdentityBezier([0.3, 0.3 + 5e-10, 0.7, 0.7])).toBe(true);
    expect(isIdentityBezier([0.3, 0.3 + 2e-9, 0.7, 0.7])).toBe(false);
    expect(isIdentityBezier([0.42, 0, 0.58, 1])).toBe(false);
    // Outside the box: [−1, 0] plays as [0, 0], and [1.5, 2] as [1, 1]
    expect(isIdentityBezier([-1, 0, 1.5, 2])).toBe(true);
    const ease = bezierCurve([-1, 0, 1.5, 2]).ease;
    for (let i = 0; i <= 20; i++) expect(ease(i / 20)).toBeCloseTo(i / 20, 9);
  });
});

describe("createBezierEasing", () => {
  it("is the bezier curve's ease", () => {
    const random = lcg(23);
    for (let k = 0; k < 20; k++) {
      const handles: Handles = [random(), random(), random(), random()];
      const a = createBezierEasing(...handles);
      const b = bezierCurve(handles).ease;
      for (let i = 0; i <= 20; i++) expect(a(i / 20)).toBe(b(i / 20));
    }
  });
});
