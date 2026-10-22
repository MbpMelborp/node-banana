import { describe, it, expect } from "vitest";
import { sampleCurve } from "@/lib/comfy/curve";
import { bakeError } from "@/lib/stitch/warp";
import {
  MIN_POINT_GAP,
  addRemapPoint,
  bezierCurve,
  getAllEasingNames,
  isIdentityPoints,
  moveRemapPoint,
  normalizePoints,
  pointsCurve,
  presetCurve,
  removeRemapPoint,
  toPoints,
  type CurvePoint,
} from "..";

function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

/** A normalized curve of up to `knots` interior knots, some of them flat runs (freezes). */
function randomCurve(random: () => number, knots = 6): Array<[number, number]> {
  const raw: Array<[number, number]> = [];
  for (let i = 0; i < 1 + Math.floor(random() * knots); i++) raw.push([random(), random()]);
  if (random() < 0.3 && raw.length > 1) raw[1] = [raw[1][0], raw[0][1]];
  return normalizePoints(raw)!;
}

const isCirc = (name: string) => name.includes("Circ");
const isHybrid = (name: string) => name === "easeInExpoOutCubic" || name === "easeInQuartOutQuad";

function verticalError(points: ReadonlyArray<CurvePoint>, f: (u: number) => number): number {
  const ease = pointsCurve(points).ease;
  let worst = 0;
  for (let i = 0; i <= 4000; i++) worst = Math.max(worst, Math.abs(ease(i / 4000) - f(i / 4000)));
  return worst;
}

describe("normalizePoints", () => {
  it("makes a time remap of whatever was stored", () => {
    expect(normalizePoints("nope")).toBeNull();
    expect(normalizePoints(null)).toBeNull();
    expect(normalizePoints([])).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(normalizePoints([[0.5, Number.NaN], ["0.5", 0.5], [0.5, 0.5, 0.5], [0.4, 0.3], null])).toEqual([
      [0, 0],
      [0.4, 0.3],
      [1, 1],
    ]);
    // Clamped, sorted, the first of an x kept, the ends forced
    expect(
      normalizePoints([
        [2, 0.9],
        [0.6, 1.4],
        [0.3, -1],
        [0.3, 0.8],
        [0, 0.3],
      ]),
    ).toEqual([
      [0, 0],
      [0.3, 0],
      [0.6, 1],
      [1, 1],
    ]);
    // A knot within 1e-6 of an end merges into it
    expect(
      normalizePoints([
        [1e-7, 0.2],
        [0.5, 0.4],
        [1 - 1e-7, 0.6],
      ]),
    ).toEqual([
      [0, 0],
      [0.5, 0.4],
      [1, 1],
    ]);
    // A falling y is raised
    expect(
      normalizePoints([
        [0, 0],
        [0.4, 0.8],
        [0.6, 0.3],
        [1, 1],
      ]),
    ).toEqual([
      [0, 0],
      [0.4, 0.8],
      [0.6, 0.8],
      [1, 1],
    ]);
    expect(normalizePoints(Array.from({ length: 70 }, (_, i) => [i / 70, i / 70]))).toBeNull();
  });

  it("is idempotent, rising in x, never falling in y, with exact ends", () => {
    const random = lcg(1);
    const broken: string[] = [];
    for (let k = 0; k < 5000; k++) {
      const raw = Array.from({ length: Math.floor(random() * 12) }, () =>
        random() < 0.1 ? [Number.NaN, random()] : [random() * 1.4 - 0.2, random() * 1.4 - 0.2],
      );
      const points = normalizePoints(raw)!;
      const text = JSON.stringify(points);
      const [first, last] = [points[0], points[points.length - 1]];
      const ordered = points.every((p, i) => i === 0 || (p[0] > points[i - 1][0] && p[1] >= points[i - 1][1]));
      const ends = first[0] === 0 && first[1] === 0 && last[0] === 1 && last[1] === 1;
      if (JSON.stringify(normalizePoints(JSON.parse(text))) !== text || !ordered || !ends) broken.push(text);
    }
    expect(broken).toEqual([]);
  });
});

describe("isIdentityPoints", () => {
  it("is every knot within 1e-9 of the diagonal", () => {
    expect(isIdentityPoints([[0, 0], [1, 1]])).toBe(true);
    expect(isIdentityPoints([[0, 0], [0.5, 0.5], [1, 1]])).toBe(true);
    expect(isIdentityPoints([[0, 0], [0.5, 0.5 + 5e-10], [1, 1]])).toBe(true);
    expect(isIdentityPoints([[0, 0], [0.5, 0.5 + 2e-9], [1, 1]])).toBe(false);
  });
});

describe("pointsCurve", () => {
  it("is the ComfyUI tone curve's monotone cubic", () => {
    const random = lcg(2);
    let worst = 0;
    for (let k = 0; k < 500; k++) {
      const points = randomCurve(random);
      const ease = pointsCurve(points).ease;
      const comfy = { points, interpolation: "monotone_cubic" };
      for (let i = 0; i < 200; i++) {
        const u = random();
        worst = Math.max(worst, Math.abs(ease(u) - sampleCurve(comfy, u)));
      }
    }
    expect(worst).toBeLessThanOrEqual(1e-12);
  });

  it("never runs back, and stays inside [0, 1]", () => {
    const random = lcg(4);
    for (let k = 0; k < 2000; k++) {
      const ease = pointsCurve(randomCurve(random)).ease;
      let previous = 0;
      for (let i = 1; i <= 20_000; i++) {
        const value = ease(i / 20_000);
        if (value < previous - 1e-12 || value > 1 || value < 0) {
          throw new Error(`curve ${k} runs back at ${i / 20_000}`);
        }
        previous = value;
      }
    }
  });

  it("gives its slope", () => {
    const random = lcg(6);
    for (let k = 0; k < 100; k++) {
      const points = randomCurve(random);
      const { ease, slope } = pointsCurve(points);
      for (let j = 0; j < 20; j++) {
        const u = random();
        if (points.some(([x]) => Math.abs(x - u) < 1e-3)) continue;
        const h = 1e-6;
        const difference = (ease(u + h) - ease(u - h)) / (2 * h);
        expect(Math.abs(slope(u) - difference)).toBeLessThanOrEqual(1e-4 * Math.max(difference, 1e-2));
      }
    }
    expect(pointsCurve([[0, 0], [1, 1]]).slope(0.3)).toBe(1);
    expect(pointsCurve([[0, 0], [0.3, 0.5], [0.6, 0.5], [1, 1]]).slope(0.45)).toBe(0);
  });
});

describe("addRemapPoint", () => {
  const points: CurvePoint[] = [
    [0, 0],
    [0.5, 0.2],
    [1, 1],
  ];

  it("inserts a knot in order, on the curve when y is omitted", () => {
    const added = addRemapPoint(points, 0.75, 0.5);
    expect(added).toEqual({ points: [[0, 0], [0.5, 0.2], [0.75, 0.5], [1, 1]], index: 2 });
    const onCurve = addRemapPoint(points, 0.25);
    expect(onCurve.index).toBe(1);
    expect(onCurve.points[1][1]).toBe(pointsCurve(points).ease(0.25));
  });

  it("holds y between the neighbours'", () => {
    expect(addRemapPoint(points, 0.25, 0.9).points[1]).toEqual([0.25, 0.2]);
    expect(addRemapPoint(points, 0.75, 0.1).points[2]).toEqual([0.75, 0.2]);
  });

  it("takes the nearer knot within the gap, and refuses an end or a bad x", () => {
    const two: CurvePoint[] = [
      [0, 0],
      [0.4, 0.3],
      [0.43, 0.5],
      [1, 1],
    ];
    expect(addRemapPoint(two, 0.41)).toEqual({ points: two, index: 1 });
    expect(addRemapPoint(two, 0.42)).toEqual({ points: two, index: 2 });
    expect(addRemapPoint(two, 0.41).points).toBe(two);
    for (const x of [0.01, 0.99, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = addRemapPoint(points, x);
      expect(result.index).toBe(-1);
      expect(result.points).toBe(points);
    }
  });
});

describe("moveRemapPoint", () => {
  const points: CurvePoint[] = [
    [0, 0],
    [0.3, 0.2],
    [0.6, 0.7],
    [1, 1],
  ];

  it("never moves an end", () => {
    expect(moveRemapPoint(points, 0, 0.5, 0.5)).toBe(points);
    expect(moveRemapPoint(points, 3, 0.5, 0.5)).toBe(points);
    expect(moveRemapPoint(points, 7, 0.5, 0.5)).toBe(points);
  });

  it("keeps x the gap from both neighbours and y between theirs", () => {
    expect(moveRemapPoint(points, 1, 0.9, 0.9)[1]).toEqual([0.6 - MIN_POINT_GAP, 0.7]);
    expect(moveRemapPoint(points, 1, -1, -1)[1]).toEqual([MIN_POINT_GAP, 0]);
    expect(moveRemapPoint(points, 2, 0.5, 0.1)[2]).toEqual([0.5, 0.2]);
  });

  it("moves a knot of a crowded stored curve in y only, and keeps a non-finite coordinate", () => {
    // Its neighbours sit closer than two gaps: no x keeps the gap from both
    const crowded: CurvePoint[] = [
      [0, 0],
      [0.5, 0.3],
      [0.51, 0.4],
      [0.52, 0.5],
      [1, 1],
    ];
    expect(moveRemapPoint(crowded, 2, 0.8, 0.45)[2]).toEqual([0.51, 0.45]);
    expect(moveRemapPoint(points, 1, Number.NaN, 0.5)[1]).toEqual([0.3, 0.5]);
    expect(moveRemapPoint(points, 1, 0.4, Number.NaN)[1]).toEqual([0.4, 0.2]);
  });

  it("gives the same array when nothing moves", () => {
    expect(moveRemapPoint(points, 1, 0.3, 0.2)).toBe(points);
  });
});

describe("removeRemapPoint", () => {
  it("removes an interior knot; the ends are permanent", () => {
    const points: CurvePoint[] = [
      [0, 0],
      [0.3, 0.2],
      [1, 1],
    ];
    expect(removeRemapPoint(points, 1)).toEqual([
      [0, 0],
      [1, 1],
    ]);
    for (const index of [0, 2, -1, 5, 0.5]) expect(removeRemapPoint(points, index)).toBe(points);
  });
});

describe("toPoints", () => {
  it("gives the straight line for linear", () => {
    expect(toPoints(presetCurve("linear")!.ease)).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });

  it.each(getAllEasingNames().filter((name) => name !== "linear"))("bakes %s within its budget", (name) => {
    const f = presetCurve(name)!.ease;
    const points = toPoints(f);
    expect(points.length).toBeLessThanOrEqual(16);
    expect(verticalError(points, f)).toBeLessThanOrEqual(isCirc(name) ? 0.05 : 0.01);
    expect(normalizePoints(points)).toEqual(points);
    for (let i = 1; i < points.length; i++) {
      expect(points[i][0] - points[i - 1][0]).toBeGreaterThanOrEqual(MIN_POINT_GAP);
    }
  });

  it.each(getAllEasingNames().filter((name) => name !== "linear" && !isCirc(name)))(
    "keeps a 10 s clip at 24 fps within a frame of %s at every slot (two for the hybrids)",
    (name) => {
      const f = presetCurve(name)!.ease;
      const g = pointsCurve(toPoints(f, bakeError(10, 24))).ease;
      let worst = 0;
      for (let slot = 0; slot < 600; slot++) {
        const p = (slot + 0.5) / 600;
        worst = Math.max(worst, Math.abs(Math.round(f(p) * 240) - Math.round(g(p) * 240)));
      }
      expect(worst).toBeLessThanOrEqual(isHybrid(name) ? 2 : 1);
    },
  );

  it("keeps every seed knot", () => {
    // Knots on the curve, as a windowed points curve's own are
    const f = presetCurve("easeInOutCubic")!.ease;
    const seed: CurvePoint[] = [0, 0.2, 0.5, 0.8, 1].map((x) => [x, f(x)]);
    const points = toPoints(f, 0.002, { seed });
    for (const knot of seed) expect(points).toContainEqual([...knot]);
    expect(points.length).toBeLessThanOrEqual(64);
  });

  it("stops at 16 knots, or at the count asked for", () => {
    const f = presetCurve("easeInOutCubic")!.ease;
    expect(toPoints(f, 1e-5)).toHaveLength(16);
    expect(toPoints(f, 1e-5, { maxPoints: 8 })).toHaveLength(8);
    expect(toPoints(f, 1e-5, { seed: [[0, 0], [1, 1]], maxPoints: 20 })).toHaveLength(20);
  });

  it("bakes beziers into at most 16 knots", () => {
    const random = lcg(9);
    for (let k = 0; k < 40; k++) {
      const points = toPoints(bezierCurve([random(), random(), random(), random()]).ease);
      expect(points.length).toBeLessThanOrEqual(16);
    }
  });

  it("stays above its budget only within a knot's gap, where a steep stretch can keep it with knots to spare", () => {
    const random = lcg(31);
    for (let k = 0; k < 100; k++) {
      const f = bezierCurve([0.05 + 0.9 * random(), random(), 0.05 + 0.9 * random(), random()]).ease;
      const points = toPoints(f, 0.002);
      if (points.length >= 16) continue;
      const ease = pointsCurve(points).ease;
      for (let i = 0; i <= 512; i++) {
        const x = i / 512;
        if (points.some(([knot]) => Math.abs(knot - x) < MIN_POINT_GAP)) continue;
        expect(Math.abs(ease(x) - f(x)), `bezier ${k} at ${x}`).toBeLessThanOrEqual(0.002);
      }
    }
    // A start as steep as 13, no handle on an edge: about 0.024 beside the first knot, on 11 knots (toPoints' note)
    const steep = bezierCurve([0.056, 0.733, 0.413, 0.152]).ease;
    const points = toPoints(steep, 0.002);
    expect(points.length).toBeLessThan(16);
    expect(verticalError(points, steep)).toBeGreaterThan(0.01);
    expect(verticalError(points, steep)).toBeLessThanOrEqual(0.04);
  });
});
