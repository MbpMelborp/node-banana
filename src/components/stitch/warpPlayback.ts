import { FRAME_RATE } from "@/lib/stitch/sequencePlan";
import { dropsSound, SOUND_MIN_SPEED, type WarpMap } from "@/lib/stitch/warp";

/**
 * How the preview plays a retimed clip's <video> (useSequencePlayback): at the rate its warp map gives, within what an
 * element plays, its drifts weighed in sequence seconds, never past its Out. Reversed, slower than an element plays
 * it, or a ramp not yet at the quarter speed it is started at, it is driven by seeks instead, paused. See
 * docs/edit-video.md, "Speed and ramps".
 */

/** The rates Chromium plays; 0 stands still and is taken too. Any other value throws NotSupportedError. */
export const MIN_PLAYBACK_RATE = 0.0625;
export const MAX_PLAYBACK_RATE = 16;
/**
 * The least rate a ramp's element is started at; slower, it waits driven by seeks. Measured (Electron 44, pitch not
 * kept): an element started at 1/16, or held at 0, whose rate then rises shows a frame about 0.22-1.3 s of source ahead
 * of its time and holds it there until the clock arrives; started at a quarter and raised to 1 it leads by 30-95 ms, as
 * one started at 1 does (27-137 ms); started at 0.1, by up to 0.3 s. A constant speed never rises, so it starts at any
 * rate an element plays.
 */
export const MIN_START_RATE = 0.25;
/**
 * The least rate a drift is weighed by: slower, part of a source frame is not seen, and a drift divided by the rate
 * itself would explode where a ramp stands still.
 */
export const MIN_DRIFT_RATE = 0.25;
/** A retimed element is kept this far short of its Out and its file's end (source s): the frame in effect is the last before it. */
export const OUT_MARGIN = 1e-3;

/** A reversed clip: driven by seeks, never played (no element plays backwards). Not a type guard. */
export const reversed = (map: WarpMap) => map.warp.reverse;

/** Silenced all through: reversed, or a constant speed whose sound the render drops. */
export const silenced = (map: WarpMap) => map.warp.reverse || dropsSound(map.warp);

/**
 * The rate an element plays the map at: a constant speed exactly, else the mean over the frame from `offset` (core §8),
 * the last frame of the clip near its end, the whole clip when it is shorter than a frame (its average speed). ≥ 0.
 */
export function baseRate(map: WarpMap, offset: number): number {
  if (map.warp.curve === null) return map.warp.speed;
  const dt = 1 / FRAME_RATE;
  const b = Math.min(Math.max(offset, 0) + dt, map.length);
  const a = Math.max(0, b - dt);
  if (!(b > a)) return map.warp.speed;
  return Math.abs(map.sourceTimeAt(b) - map.sourceTimeAt(a)) / (b - a);
}

/** What a source-seconds drift at `base` is divided by to read in sequence seconds. */
export const driftScale = (base: number) => Math.max(base, MIN_DRIFT_RATE);

/** The rate an element is started at, within what it plays. */
export const startRate = (base: number) => Math.min(MAX_PLAYBACK_RATE, Math.max(MIN_PLAYBACK_RATE, base));

/**
 * Whether an element showing the map at `offset` is driven by seeks rather than played: reversed; playing, slower than
 * an element plays; not playing yet (`offset` where it would move), slower than it is started at. A ramp's element
 * started at MIN_START_RATE plays on down to MIN_PLAYBACK_RATE, so it never flaps between the two.
 */
export function driven(map: WarpMap, offset: number, playing: boolean): boolean {
  if (map.warp.reverse) return true;
  const least = playing || map.warp.curve === null ? MIN_PLAYBACK_RATE : MIN_START_RATE;
  return baseRate(map, offset) < least;
}

/** The share of a retimed clip's own sound kept at `base`: below a quarter speed it fades, as the render's does (warpResample). */
export const soundShare = (base: number) => Math.min(1, base / SOUND_MIN_SPEED);

/**
 * `rate` as the preview writes it: clamped into the playable range; null at or below 0 and for NaN (no write). The
 * preview never stands an element still by its rate (raised from 0 it shows a frame ahead, MIN_START_RATE): it pauses it.
 */
export function playableRate(rate: number): number | null {
  if (!(rate > 0)) return null;
  return Math.min(MAX_PLAYBACK_RATE, Math.max(MIN_PLAYBACK_RATE, rate));
}

/**
 * Every playbackRate the preview writes goes through here: only a rate the browser takes, and a refusal never reaches
 * the frame loop (a throw there would skip the next frame's request and freeze the preview while it says playing).
 */
export function writeRate(el: HTMLMediaElement, rate: number): void {
  const value = playableRate(rate);
  if (value === null || el.playbackRate === value) return;
  try {
    el.playbackRate = value;
  } catch {
    // Kept as it was
  }
}

/** The last source second an element shows of the clip: OUT_MARGIN short of its Out, and of its file's end (ended there). */
export function endPoint(el: HTMLMediaElement, map: WarpMap): number {
  const end = Number.isFinite(el.duration) ? Math.min(map.range.outSec, el.duration) : map.range.outSec;
  return Math.max(0, end - OUT_MARGIN);
}

/** Where an element is put to show source second `sourceSec` of the clip: never past endPoint. */
export const shownPoint = (el: HTMLMediaElement, map: WarpMap, sourceSec: number) =>
  Math.max(0, Math.min(sourceSec, endPoint(el, map)));

/** At its end: its file ended, or within OUT_MARGIN of endPoint (where a forward clip holds its last frame). */
export const atEnd = (el: HTMLMediaElement, map: WarpMap) => el.ended || el.currentTime + OUT_MARGIN >= endPoint(el, map);
