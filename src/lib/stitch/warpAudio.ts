import type { Pcm } from "./audioMix";
import { SOUND_MIN_SPEED } from "./warp";

/**
 * A retimed clip's own sound, played through its warp map: each output sample reads the source where the picture is,
 * like tape, so a faster clip sounds higher and a ramp glides; below a quarter speed it fades out, as a slowing tape
 * does, and a hold is silent. A windowed-sinc resampler whose low-pass follows the momentary speed keeps fast motion
 * from aliasing. Pure: no Web Audio.
 */

/** The kernel's half-width in zero crossings at full band. */
export const SINC_ZEROS = 16;
/** Table entries per zero crossing (linear between). */
export const SINC_TABLE_RES = 512;
export const KAISER_BETA = 8.6;
/** The cutoff's share of the band: the Kaiser window's transition sits below the band's edge. */
export const SINC_ROLLOFF = 0.94;
/** The narrowest cutoff: from about 60× on (at equal rates) the low-pass stops narrowing. */
export const SINC_BETA_MIN = 1 / 64;
/** The lookup table holds the warp map at this many knots per second of output, and at least MIN_KNOTS. */
const KNOTS_PER_SEC = 1000;
const MIN_KNOTS = 4097;
const MAX_KNOTS = 2 ** 21;
const ABORT_CHECK_SAMPLES = 65536;
const YIELD_SAMPLES = 262144;

function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 64; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

/** The Kaiser-windowed sinc at u zero crossings, u in [0, SINC_ZEROS]; 0 past it. */
const KERNEL_TABLE = (() => {
  const table = new Float64Array(SINC_ZEROS * SINC_TABLE_RES + 2);
  const scale = besselI0(KAISER_BETA);
  for (let i = 0; i < table.length; i++) {
    const u = i / SINC_TABLE_RES;
    if (u >= SINC_ZEROS) continue;
    const sinc = u === 0 ? 1 : Math.sin(Math.PI * u) / (Math.PI * u);
    const r = u / SINC_ZEROS;
    table[i] = (sinc * besselI0(KAISER_BETA * Math.sqrt(1 - r * r))) / scale;
  }
  return table;
})();

/** The kernel at u >= 0 zero crossings, linear between the table's entries. */
export function sincKernel(u: number): number {
  const x = u * SINC_TABLE_RES;
  const k = x | 0;
  if (k >= SINC_ZEROS * SINC_TABLE_RES) return 0;
  return KERNEL_TABLE[k] + (KERNEL_TABLE[k + 1] - KERNEL_TABLE[k]) * (x - k);
}

/** Seconds of source sound to decode either side of a retimed clip: the widest kernel's half-width at the track's rate. */
export function warpSoundMargin(sampleRate: number): number {
  const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 8000;
  return (Math.ceil(SINC_ZEROS / SINC_BETA_MIN) + 4) / rate;
}

export interface WarpSoundJob {
  /** The clip's sound at its source rate, in the master's channels; index 0 is source sample firstSample. */
  pcm: Pcm;
  firstSample: number;
  /** Source seconds at output offset o, 0 <= o <= length (the warp map's sourceTimeAt). */
  sourceAt: (offset: number) => number;
  /** The momentary speed at output offset o (the warp map's speedAt). */
  speedAt: (offset: number) => number;
  /** The clip's warped length, seconds. */
  length: number;
  /** The master rate. */
  sampleRate: number;
  signal?: AbortSignal;
}

/** Lets the page paint and the Stop button act; unlike a timer, not throttled while the window is hidden. */
function yieldToPage(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

/**
 * Exactly round(length · sampleRate) samples per channel, in new arrays. Each output sample reads the source at the
 * map's time through a lookup table of one knot per millisecond, its low-pass and gain set by the momentary speed
 * (linear between the knots' segments, so neither steps at 1 kHz). Positions outside the decoded range read silence.
 */
export async function warpResample(job: WarpSoundJob): Promise<Pcm> {
  const { pcm, firstSample, sourceAt, speedAt, length, signal } = job;
  const outRate = job.sampleRate;
  const n = Math.max(0, Math.round(length * outRate));
  const channels = pcm.channels.map(() => new Float32Array(n));
  const out: Pcm = { sampleRate: outRate, channels };
  if (n === 0 || channels.length === 0) return out;

  const knots = Math.min(MAX_KNOTS, Math.max(MIN_KNOTS, Math.ceil(length * KNOTS_PER_SEC) + 1));
  const step = length / (knots - 1);
  const lut = new Float64Array(knots);
  for (let g = 0; g < knots; g++) lut[g] = sourceAt(g * step);
  // Each segment's speed, at its middle: its secant, which the position really sweeps, but never more than the map's
  // own speed there. A jump in the curve (the Expo family's ends) is a skip, not a millisecond of full-level fast play
  const segments = new Float64Array(knots - 1);
  for (let g = 0; g + 1 < knots; g++) {
    segments[g] = Math.min(Math.abs(lut[g + 1] - lut[g]) / step, speedAt((g + 0.5) * step));
  }

  const srcRate = pcm.sampleRate;
  const source = pcm.channels;
  const m = source[0].length;
  const acc = new Float64Array(channels.length);
  for (let i = 0; i < n; i++) {
    if (i % ABORT_CHECK_SAMPLES === 0 && signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (i > 0 && i % YIELD_SAMPLES === 0) await yieldToPage();
    const q = i / outRate / step;
    const k = Math.min(Math.floor(q), knots - 2);
    const x = lut[k] + (lut[k + 1] - lut[k]) * (q - k);
    let j = Math.floor(q - 0.5);
    let u = q - 0.5 - j;
    if (j < 0) {
      j = 0;
      u = 0;
    } else if (j > knots - 3) {
      j = knots - 3;
      u = 1;
    }
    const speed = segments[j] + (segments[j + 1] - segments[j]) * u;
    const gain = Math.min(1, speed / SOUND_MIN_SPEED);
    // A hold is silent: the remap alone would hold one sample's value
    if (!(gain > 0)) continue;
    const beta = Math.max(SINC_BETA_MIN, SINC_ROLLOFF * Math.min(1, outRate / (srcRate * speed)));
    const p = x * srcRate - firstSample;
    const half = SINC_ZEROS / beta;
    const from = Math.ceil(p - half);
    const to = Math.floor(p + half);
    acc.fill(0);
    let weights = 0;
    for (let s = from; s <= to; s++) {
      const w = sincKernel(Math.abs(s - p) * beta);
      // Outside the decoded range: silence, its weight still counts
      weights += w;
      if (s < 0 || s >= m) continue;
      for (let c = 0; c < channels.length; c++) acc[c] += w * source[c][s];
    }
    if (!(weights > 0)) continue;
    for (let c = 0; c < channels.length; c++) channels[c][i] = (gain * acc[c]) / weights;
  }
  return out;
}
