import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StitchTextOverlay } from "@/types";
import {
  drawOverlays,
  layoutOverlay,
  overlayLayoutSize,
  overlayTransform,
  type OverlayFontList,
  type OverlayLayoutCache,
  type OverlayRotation,
} from "../overlayDraw";
import { createTextOverlay } from "../overlays";

const fonts = vi.hoisted(() => ({ generation: 0 }));
vi.mock("../fonts", () => ({ fontGeneration: () => fonts.generation }));

const APP = '"Space Grotesk", sans-serif';
const fontList: OverlayFontList = (font) => (font.family === "Space Grotesk" ? APP : `"${font.family}", ${APP}`);
const text = (id: string, init: Partial<StitchTextOverlay> = {}) => createTextOverlay({ id, ...init });

type Call = { op: string; args: unknown[]; alpha: number; style: string; font: string; align: string };

/**
 * A 2D context that records what is painted, and measures each character as half the font's size (times `glyph`,
 * which a test changes to stand for another face). A value `refuse` says no to is ignored, as an invalid one is.
 */
function fakeContext({ refuse = () => false }: { refuse?: (font: string) => boolean } = {}) {
  const calls: Call[] = [];
  let font = "10px sans-serif";
  const ctx = {
    glyph: 0.5,
    globalAlpha: 1,
    fillStyle: "",
    textAlign: "start",
    textBaseline: "alphabetic",
    get font() {
      return font;
    },
    set font(value: string) {
      if (!refuse(value)) font = value;
    },
    measureText: vi.fn((s: string) => ({ width: s.length * Number(/([\d.]+)px/.exec(font)![1]) * ctx.glyph })),
    setTransform: vi.fn((...args: number[]) => record("transform", args)),
    fillRect: vi.fn((...args: number[]) => record("fillRect", args)),
    fillText: vi.fn((...args: unknown[]) => record("fillText", args)),
  };
  const record = (op: string, args: unknown[]) =>
    calls.push({ op, args, alpha: ctx.globalAlpha, style: String(ctx.fillStyle), font, align: ctx.textAlign });
  const as2d = ctx as unknown as CanvasRenderingContext2D;
  return { ctx, as2d, calls, painted: () => calls.filter((c) => c.op !== "transform") };
}

/** A square 1000-unit frame: 5 % margins are 50, a 0.04 size is 40 px, so 20 per character and 45 to a line. */
const SQUARE = { width: 1000, height: 1000 };
const FLAT = { layout: SQUARE, canvas: SQUARE, rotation: 0 as const };

beforeEach(() => {
  fonts.generation = 0;
});

describe("overlayLayoutSize", () => {
  it("rounds each side down to even, as the render does, and never below 2", () => {
    expect(overlayLayoutSize(1285, 717)).toEqual({ width: 1284, height: 716 });
    expect(overlayLayoutSize(1920.6, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(overlayLayoutSize(0, Number.NaN)).toEqual({ width: 2, height: 2 });
  });
});

describe("the fade", () => {
  const o = text("a", { startSec: 2, endSec: 6, fadeInSec: 0.5, fadeOutSec: 0.5, wash: { opacity: 0.5 } });

  const drawAt = (t: number) => {
    const { as2d, painted } = fakeContext();
    const drew = drawOverlays(as2d, FLAT, t, [o], fontList);
    return { drew, painted: painted().map(({ op, alpha }) => [op, alpha]) };
  };

  it("rises from nothing at the start, holds, and falls to nothing at the end, the wash with the text", () => {
    expect(drawAt(2)).toEqual({ drew: false, painted: [] });
    expect(drawAt(2.25)).toEqual({ drew: true, painted: [["fillRect", 0.25], ["fillText", 0.5]] });
    expect(drawAt(4)).toEqual({ drew: true, painted: [["fillRect", 0.5], ["fillText", 1]] });
    expect(drawAt(5.75)).toEqual({ drew: true, painted: [["fillRect", 0.25], ["fillText", 0.5]] });
    expect(drawAt(6)).toEqual({ drew: false, painted: [] });
  });

  it("paints the wash black over the whole layout frame and the text in its colour, then restores the context", () => {
    const { ctx, as2d, calls } = fakeContext();
    drawOverlays(as2d, FLAT, 4, [{ ...o, color: "#ff8800" }], fontList);
    expect(calls.find((c) => c.op === "fillRect")).toMatchObject({ args: [0, 0, 1000, 1000], style: "#000" });
    expect(calls.find((c) => c.op === "fillText")).toMatchObject({ style: "#ff8800", font: `600 80px ${APP}`, align: "center" });
    expect(ctx.textBaseline).toBe("middle");
    expect(ctx.globalAlpha).toBe(1);
    expect(calls.filter((c) => c.op === "transform").map((c) => c.args)).toEqual([
      [1, 0, 0, 1, 0, 0],
      [1, 0, 0, 1, 0, 0],
    ]);
  });

  it("paints no wash at 0, and only the wash for empty text", () => {
    const { as2d, painted } = fakeContext();
    drawOverlays(as2d, FLAT, 4, [{ ...o, wash: { opacity: 0 } }, { ...o, id: "b", text: "" }], fontList);
    expect(painted().map((c) => [c.op, c.op === "fillText" ? c.args[0] : c.alpha])).toEqual([
      ["fillRect", 0.5],
      ["fillText", "Title"],
    ]);
  });

  it("draws nothing on an empty frame", () => {
    const { as2d, calls } = fakeContext();
    expect(drawOverlays(as2d, { ...FLAT, canvas: { width: 0, height: 10 } }, 4, [o], fontList)).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("layoutOverlay", () => {
  const lay = (init: Partial<StitchTextOverlay>, size = SQUARE) => layoutOverlay(fakeContext().as2d, text("a", { size: 0.04, ...init }), size, fontList);
  const texts = (init: Partial<StitchTextOverlay>) => lay(init).lines.map((line) => line.text);

  it("keeps a line that fits as typed, and wraps one that doesn't at spaces, within the margins", () => {
    expect(texts({ text: "  Fits as typed  " })).toEqual(["  Fits as typed  "]);
    const words = "aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd eeeeeeeeee ffff";
    expect(texts({ text: words })).toEqual(["aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd", "eeeeeeeeee ffff"]);
    expect(Math.max(...lay({ text: words }).lines.map((line) => line.width))).toBeLessThanOrEqual(900);
  });

  it("breaks a word wider than a line between characters", () => {
    expect(texts({ text: `ab ${"x".repeat(100)} cd` })).toEqual(["ab", "x".repeat(45), "x".repeat(45), `${"x".repeat(10)} cd`]);
  });

  it("starts a line at every newline and keeps empty lines, which take their height", () => {
    const layout = lay({ text: "One\n\nTwo" });
    expect(layout.lines.map((line) => line.text)).toEqual(["One", "", "Two"]);
    expect(layout.lineHeight).toBe(48);
    expect(layout.box.height).toBe(144);
    expect(layout.lines.map((line) => line.y)).toEqual([452, 500, 548]);
  });

  it("centres the block on x and y, and aligns the lines inside it without moving it", () => {
    const at = (align: StitchTextOverlay["align"]) => lay({ text: "Hello\nHi", align, x: 0.3, y: 0.6 });
    for (const align of ["left", "center", "right"] as const) {
      expect(at(align).box).toEqual({ x: 250, y: 552, width: 100, height: 96 });
      expect(at(align).fitsFrame).toBe(true);
    }
    expect(at("left").lines.map((line) => [line.x, line.y])).toEqual([[250, 576], [250, 624]]);
    expect(at("center").lines.map((line) => line.x)).toEqual([300, 300]);
    expect(at("right").lines.map((line) => line.x)).toEqual([350, 350]);
  });

  it("keeps the block inside the margins, and centres one taller than the frame", () => {
    expect(lay({ text: "Hello\nHi", x: 0, y: 0 }).box).toMatchObject({ x: 50, y: 50 });
    expect(lay({ text: "Hello\nHi", x: 1, y: 1 }).box).toMatchObject({ x: 850, y: 854 });
    const tall = lay({ text: Array.from({ length: 30 }, () => "line").join("\n") });
    expect(tall.box).toMatchObject({ y: -220, height: 1440 });
    expect(tall.fitsFrame).toBe(false);
  });

  it("sizes the font as a fraction of the frame's height, with lines 1.2 sizes apart", () => {
    expect(lay({ text: "Hello", size: 0.1 }, { width: 1920, height: 1080 })).toMatchObject({
      font: `600 108px ${APP}`,
      lineHeight: 108 * 1.2,
      box: { x: 825, width: 270 },
    });
  });

  it("falls back to the app's sans when the context refuses the layer's font", () => {
    const { as2d } = fakeContext({ refuse: (font) => font.includes("Broken") });
    const layout = layoutOverlay(as2d, text("a", { font: { family: "Broken" }, size: 0.04 }), SQUARE, fontList);
    expect(layout.font).toBe(`600 40px ${APP}`);
    expect(as2d.font).toBe(`600 40px ${APP}`);
    const fine = layoutOverlay(fakeContext().as2d, text("a", { font: { family: "Inter" }, size: 0.04 }), SQUARE, fontList);
    expect(fine.font).toBe(`600 40px "Inter", ${APP}`);
  });
});

describe("drawOverlays", () => {
  it("paints every wash before any text, each in row order, so no wash covers text", () => {
    const { as2d, painted } = fakeContext();
    const lower = text("lower", { row: 0, text: "Lower", wash: { opacity: 0.4 } });
    const upper = text("upper", { row: 1, text: "Upper", wash: { opacity: 0.5 } });
    drawOverlays(as2d, FLAT, 2, [upper, lower], fontList);
    expect(painted().map((c) => [c.op, c.op === "fillText" ? c.args[0] : c.alpha])).toEqual([
      ["fillRect", 0.4],
      ["fillRect", 0.5],
      ["fillText", "Lower"],
      ["fillText", "Upper"],
    ]);
  });

  // The preview draws at its backing size and the render into the encoder's box: neither may move a line or resize text.
  it("lays the text out in layout units, whatever the canvas's pixel size", () => {
    const layout = { width: 1920, height: 1080 };
    const drawn = (canvas: { width: number; height: number }, o = text("a")) => {
      const { as2d, calls } = fakeContext();
      drawOverlays(as2d, { layout, canvas, rotation: 0 }, 2, [o], fontList);
      return calls.filter((c) => c.op === "fillText").map((c) => [...c.args, c.font]);
    };
    expect(drawn({ width: 960, height: 540 })).toEqual([["Title", 960, 540, `600 86.4px ${APP}`]]);
    const long = text("b", { text: Array.from({ length: 8 }, () => "aaaaaaaaaa").join(" ") });
    expect(drawn(layout, long)).toHaveLength(3);
    expect(drawn({ width: 960, height: 540 }, long)).toEqual(drawn(layout, long));
    expect(drawn({ width: 3840, height: 2160 }, long)).toEqual(drawn(layout, long));
  });

  it("lays a rotated file's text out in its display frame, not in the canvas's coded one", () => {
    const { as2d, calls } = fakeContext();
    const target = { layout: { width: 720, height: 1280 }, canvas: { width: 1280, height: 720 }, rotation: 90 as const };
    // 0.08 of 1280 is 102.4 px, 51.2 to a character: 12 fit in the 648 a 720-wide frame leaves inside its margins.
    drawOverlays(as2d, target, 2, [text("a", { text: "aaaaaa bbbbbb cccccc" })], fontList);
    expect(calls.filter((c) => c.op === "fillText").map((c) => [c.args[0], c.font])).toEqual([
      ["aaaaaa", `600 102.4px ${APP}`],
      ["bbbbbb", `600 102.4px ${APP}`],
      ["cccccc", `600 102.4px ${APP}`],
    ]);
    expect(calls.filter((c) => c.op === "fillText").map((c) => c.args[1])).toEqual([360, 360, 360]);
  });

  it("measures once with a cache, and again after a font loads", () => {
    const { ctx, as2d, calls } = fakeContext();
    const cache: OverlayLayoutCache = new WeakMap();
    const o = text("a", { text: "Hello", size: 0.04, align: "left", x: 0.5 });
    drawOverlays(as2d, FLAT, 2, [o], fontList, cache);
    const measured = ctx.measureText.mock.calls.length;
    drawOverlays(as2d, FLAT, 2.5, [o], fontList, cache);
    expect(ctx.measureText.mock.calls.length).toBe(measured);

    ctx.glyph = 0.25;
    fonts.generation++;
    drawOverlays(as2d, FLAT, 2.5, [o], fontList, cache);
    expect(ctx.measureText.mock.calls.length).toBeGreaterThan(measured);
    expect(calls.filter((c) => c.op === "fillText").map((c) => c.args[1])).toEqual([450, 450, 475]);
  });
});

describe("overlayTransform", () => {
  type Point = [number, number];
  const apply = ([a, b, c, d, e, f]: number[], [x, y]: Point): Point => [a * x + c * y + e, b * x + d * y + f];
  /** Where a player shows a pixel of a file `file` (coded) big that it turns clockwise by `rotation`. */
  const shown = (rotation: OverlayRotation, [x, y]: Point, file: { width: number; height: number }): Point =>
    rotation === 90
      ? [file.height - y, x]
      : rotation === 180
        ? [file.width - x, file.height - y]
        : rotation === 270
          ? [y, file.width - x]
          : [x, y];

  it("is the pinned matrix for each rotation", () => {
    const canvas = { width: 400, height: 200 };
    expect(overlayTransform({ layout: { width: 800, height: 400 }, canvas, rotation: 0 })).toEqual([0.5, 0, 0, 0.5, 0, 0]);
    expect(overlayTransform({ layout: { width: 400, height: 800 }, canvas, rotation: 90 })).toEqual([0, -0.5, 0.5, 0, 0, 200]);
    expect(overlayTransform({ layout: { width: 800, height: 400 }, canvas, rotation: 180 })).toEqual([-0.5, 0, 0, -0.5, 400, 200]);
    expect(overlayTransform({ layout: { width: 400, height: 800 }, canvas, rotation: 270 })).toEqual([0, 0.5, -0.5, 0, 400, 0]);
  });

  // The operator's edit: the encoder's box is the first clip's 1284×716, the file 1284×720; the box is stretched to it.
  it.each([0, 90, 180, 270] as const)("lands within half a pixel once the 1284×716 box is stretched to the 1284×720 file, at %i°", (rotation) => {
    const file = { width: 1284, height: 720 };
    const box = { width: 1284, height: 716 };
    const turned = rotation === 90 || rotation === 270;
    const layout = turned ? { width: file.height, height: file.width } : file;
    const matrix = overlayTransform({ layout, canvas: box, rotation });
    for (const point of [[0, 0], [layout.width, layout.height], [layout.width * 0.5, layout.height * 0.82], [37.5, 611.25]] as Point[]) {
      const [x, y] = apply(matrix, point);
      const [sx, sy] = shown(rotation, [(x * file.width) / box.width, (y * file.height) / box.height], file);
      expect(Math.abs(sx - point[0]), `${point} x`).toBeLessThanOrEqual(0.5);
      expect(Math.abs(sy - point[1]), `${point} y`).toBeLessThanOrEqual(0.5);
    }
  });

  it("is what drawOverlays draws through, with the layout's frame for the wash", () => {
    const { as2d, calls } = fakeContext();
    const target = { layout: { width: 720, height: 1280 }, canvas: { width: 1280, height: 720 }, rotation: 90 as const };
    drawOverlays(as2d, target, 2, [text("a")], fontList);
    expect(calls[0]).toMatchObject({ op: "transform", args: overlayTransform(target) });
    expect(calls[1]).toMatchObject({ op: "fillRect", args: [0, 0, 720, 1280] });
    expect(calls.at(-1)).toMatchObject({ op: "transform", args: [1, 0, 0, 1, 0, 0] });
  });
});
