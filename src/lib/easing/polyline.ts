import { getEasingFunction, type EasingFunction } from "./functions";

/**
 * SVG polyline points for an easing's preview: samples + 1 points across [0, width], y = (1 − f(t)) · height, one
 * decimal each (the Ease Curve node's thumbnails, and the editor's ramp presets). A name goes through
 * getEasingFunction.
 */
export function easingPolyline(
  easing: string | EasingFunction,
  width: number,
  height: number,
  samples = 20,
): string {
  const fn = typeof easing === "string" ? getEasingFunction(easing) : easing;
  return Array.from({ length: samples + 1 }, (_, i) => {
    const t = i / samples;
    const y = fn(t);
    return `${(t * width).toFixed(1)},${((1 - y) * height).toFixed(1)}`;
  }).join(" ");
}
