import { SPEED_PRESETS } from "./warp";

/**
 * The rail's speed slider: a log scale over 0–100, 0.1× at 0, 1× at 50 and 10× at 100, that snaps to the presets.
 * Pure.
 */

const clampPos = (pos: number) => (pos > 0 ? (pos < 100 ? pos : 100) : 0);

/** Slider position 0–100 for a speed: 50 + 50·log10(speed), clamped; not rounded. */
export function speedToSlider(speed: number): number {
  return clampPos(50 + 50 * Math.log10(speed));
}

const PRESET_POSITIONS = SPEED_PRESETS.map((speed) => ({ speed, pos: speedToSlider(speed) }));

/**
 * The speed at a slider position (clamped to 0–100): a preset within half a step of it (positions 19.90, 34.95, 50,
 * 65.05, 80.10), else 10^((pos − 50)/50) to three significant figures.
 */
export function sliderToSpeed(pos: number): number {
  const at = clampPos(pos);
  const preset = PRESET_POSITIONS.find((p) => Math.abs(p.pos - at) <= 0.5);
  if (preset) return preset.speed;
  return Number((10 ** ((at - 50) / 50)).toPrecision(3));
}

/**
 * ↑/↓ in the Speed well: the speed at the next whole slider position (⇧: ten) past `speed`'s. A preset or a rounded
 * speed sits a little off its whole position (2× at 65.05), so a position that gives the same speed back is passed.
 */
export function nudgeSpeed(speed: number, dir: 1 | -1, big: boolean): number {
  const pos = speedToSlider(speed);
  const n = big ? 10 : 1;
  let at = dir > 0 ? Math.floor(pos + 1e-9) + n : Math.ceil(pos - 1e-9) - n;
  let next = sliderToSpeed(at);
  while ((dir > 0 ? next <= speed : next >= speed) && at > 0 && at < 100) {
    at += dir;
    next = sliderToSpeed(at);
  }
  return next;
}
