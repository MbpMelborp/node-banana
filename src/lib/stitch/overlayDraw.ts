import type { StitchOverlay, StitchOverlayFont } from "@/types";
import { fontGeneration } from "./fonts";
import { APP_SANS_FAMILY, overlayOrder } from "./overlays";

/**
 * Drawing the overlays: one function for the preview, the encoder and Frame
 * to canvas, so the three cannot drift. A layer is laid out in layout units —
 * the output's display pixels, which its x, y and size are fractions of — and
 * drawn onto the canvas through one transform that scales, and for a rotated
 * file turns, those units into the canvas's pixels. Line breaks therefore do
 * not depend on the size anything is drawn at.
 *
 * Every visible wash is painted first, then every visible text, each in
 * ascending row: a wash is always behind all text, and washes that overlap
 * compound (1 − Π(1 − wash · opacity)).
 */

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface OverlaySize {
  width: number;
  height: number;
}

export type OverlayRotation = 0 | 90 | 180 | 270;

export interface OverlayTarget {
  /** The output's display size: what the text is laid out in. */
  layout: OverlaySize;
  /** The context's pixel size. */
  canvas: OverlaySize;
  /** The file's rotation, which a player turns the canvas's (coded) pixels clockwise by; 0 for the preview and capture. */
  rotation: OverlayRotation;
}

/** A layer's font as a CSS family list, ending in the app's sans and sans-serif (see fonts.ts). */
export type OverlayFontList = (font: StitchOverlayFont) => string;

export interface OverlayLine {
  text: string;
  /** Where the line is drawn from: the block's left edge, centre or right edge by the layer's align. */
  x: number;
  /** The line's vertical centre. */
  y: number;
  width: number;
}

export interface OverlayLayout {
  /** The `font` value the lines were measured in, and are drawn in. */
  font: string;
  lineHeight: number;
  lines: OverlayLine[];
  /** The text block in layout units. */
  box: { x: number; y: number; width: number; height: number };
  /** False when the block is too tall or too wide for the frame inside its margins: it is centred, and runs off. */
  fitsFrame: boolean;
}

/** Layouts a caller keeps between draws, so drawing a frame measures nothing a previous frame measured. */
export type OverlayLayoutCache = WeakMap<StitchOverlay, { key: string; layout: OverlayLayout }>;

/** The margin text keeps from the frame's edges, as a fraction of the frame's width (left, right) and height (top, bottom). */
export const OVERLAY_MARGIN = 0.05;
/** Line height, as a multiple of the font size. */
export const OVERLAY_LINE_HEIGHT = 1.2;

/** A value no layer's font can be (theirs end in sans-serif): set before a layer's, to see whether that one took. */
const FONT_PROBE = "1px serif";

type Matrix = [number, number, number, number, number, number];

/** A frame size as the render makes one: each side rounded down to even, at least 2. */
export function overlayLayoutSize(width: number, height: number): OverlaySize {
  const even = (value: number) => (Number.isFinite(value) ? Math.max(2, Math.floor(value / 2) * 2) : 2);
  return { width: even(width), height: even(height) };
}

/**
 * Layout units to canvas pixels: scaled per axis to the canvas (as the encoder stretches its box to the file), then
 * turned by the inverse of the player's clockwise rotation, as ctx.setTransform's (a, b, c, d, e, f).
 */
export function overlayTransform({ layout, canvas, rotation }: OverlayTarget): Matrix {
  const { width: Wc, height: Hc } = canvas;
  const turned = rotation === 90 || rotation === 270;
  const sx = (turned ? Hc : Wc) / layout.width;
  const sy = (turned ? Wc : Hc) / layout.height;
  switch (rotation) {
    case 90:
      return [0, -sx, sy, 0, 0, Hc];
    case 180:
      return [-sx, 0, 0, -sy, Wc, Hc];
    case 270:
      return [0, sx, -sy, 0, Wc, 0];
    default:
      return [sx, 0, 0, sy, 0, 0];
  }
}

/** Sets the first of `values` the context takes (it keeps its font when a value is invalid), and returns it. */
function setFont(ctx: Context2D, values: readonly string[]): string {
  ctx.font = FONT_PROBE;
  const probe = ctx.font;
  for (const value of values) {
    ctx.font = value;
    if (ctx.font !== probe) return value;
  }
  return probe;
}

/** One typed line as the lines it wraps into: greedily at spaces, and a word too wide for a line between characters. */
function wrapLine(line: string, maxWidth: number, measure: (text: string) => number): string[] {
  if (measure(line) <= maxWidth) return [line];
  const lines: string[] = [];
  let current = "";
  const push = () => {
    const trimmed = current.trim();
    if (trimmed) lines.push(trimmed);
    current = "";
  };
  for (const word of line.split(" ")) {
    const joined = current ? `${current} ${word}` : word;
    if (measure(joined) <= maxWidth) {
      current = joined;
      continue;
    }
    push();
    if (measure(word) <= maxWidth) {
      current = word;
      continue;
    }
    for (const char of word) {
      if (current && measure(current + char) > maxWidth) push();
      current += char;
    }
  }
  push();
  return lines.length ? lines : [""];
}

/**
 * Where `o`'s text goes in a frame of `size` layout units: its lines wrapped to the frame's width less the margins,
 * 1.2 font sizes apart, the block centred on (x, y) and kept inside the margins (centred when it cannot be), each line
 * aligned within the block. Sets ctx.font to measure.
 */
export function layoutOverlay(ctx: Context2D, o: StitchOverlay, size: OverlaySize, fontList: OverlayFontList): OverlayLayout {
  const { width: W, height: H } = size;
  const px = o.size * H;
  const font = setFont(ctx, [
    `${o.weight} ${px}px ${fontList(o.font)}`,
    `${o.weight} ${px}px ${fontList({ family: APP_SANS_FAMILY })}`,
    `${o.weight} ${px}px sans-serif`,
  ]);
  const measure = (text: string) => ctx.measureText(text).width;
  const marginX = OVERLAY_MARGIN * W;
  const marginY = OVERLAY_MARGIN * H;
  const lineHeight = OVERLAY_LINE_HEIGHT * px;
  const texts = o.text.split("\n").flatMap((line) => wrapLine(line, W - 2 * marginX, measure));
  const widths = texts.map(measure);
  const width = Math.max(0, ...widths);
  const height = texts.length * lineHeight;
  const fitsX = width <= W - 2 * marginX;
  const fitsY = height <= H - 2 * marginY;
  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
  const x = fitsX ? clamp(o.x * W - width / 2, marginX, W - marginX - width) : (W - width) / 2;
  const y = fitsY ? clamp(o.y * H - height / 2, marginY, H - marginY - height) : (H - height) / 2;
  const anchor = o.align === "left" ? x : o.align === "right" ? x + width : x + width / 2;
  return {
    font,
    lineHeight,
    lines: texts.map((text, i) => ({ text, x: anchor, y: y + (i + 0.5) * lineHeight, width: widths[i] })),
    box: { x, y, width, height },
    fitsFrame: fitsX && fitsY,
  };
}

function cachedLayout(
  ctx: Context2D,
  o: StitchOverlay,
  size: OverlaySize,
  fontList: OverlayFontList,
  cache: OverlayLayoutCache | undefined,
): OverlayLayout {
  if (!cache) return layoutOverlay(ctx, o, size, fontList);
  const key = `${size.width}x${size.height}|${fontList(o.font)}|${fontGeneration()}`;
  const hit = cache.get(o);
  if (hit?.key === key) return hit.layout;
  const layout = layoutOverlay(ctx, o, size, fontList);
  cache.set(o, { key, layout });
  return layout;
}

/**
 * Paints the overlays onto `ctx` over what it holds, each at its opacity in `opacities` (overlayOpacitiesAt's on the
 * slot drawn; one at 0 is not painted), through overlayTransform's transform, which it sets and then puts back to
 * identity (globalAlpha back to 1). Returns whether it painted anything. `cache` keeps layouts between calls; a font
 * load (fonts.ts's generation) renews them.
 */
export function drawOverlays(
  ctx: Context2D,
  target: OverlayTarget,
  opacities: readonly number[],
  overlays: readonly StitchOverlay[],
  fontList: OverlayFontList,
  cache?: OverlayLayoutCache,
): boolean {
  const { layout: size } = target;
  if (!(size.width > 0 && size.height > 0 && target.canvas.width > 0 && target.canvas.height > 0)) return false;
  const visible = overlays
    .map((o, i) => ({ o, opacity: opacities[i] ?? 0 }))
    .filter(({ opacity }) => opacity > 0)
    .sort((a, b) => overlayOrder(a.o, b.o));
  if (!visible.length) return false;
  ctx.setTransform(...overlayTransform(target));
  ctx.fillStyle = "#000";
  for (const { o, opacity } of visible) {
    const alpha = o.wash.opacity * opacity;
    if (alpha <= 0) continue;
    ctx.globalAlpha = alpha;
    ctx.fillRect(0, 0, size.width, size.height);
  }
  for (const { o, opacity } of visible) {
    const layout = cachedLayout(ctx, o, size, fontList, cache);
    if (!layout.lines.some((line) => line.text)) continue;
    ctx.font = layout.font;
    ctx.textAlign = o.align;
    ctx.textBaseline = "middle";
    ctx.fillStyle = o.color;
    ctx.globalAlpha = opacity;
    for (const line of layout.lines) if (line.text) ctx.fillText(line.text, line.x, line.y);
  }
  ctx.globalAlpha = 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return true;
}
