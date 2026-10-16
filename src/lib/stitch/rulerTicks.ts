import { formatTimecode } from "./timecode";

/**
 * The timeline ruler's ticks for a zoom, in sequence seconds: majors far
 * enough apart to read, minors between them, and labels on every major or
 * every second one. Pure.
 */

export interface RulerTicks {
  majors: number[];
  minors: number[];
  labels: Array<{ t: number; text: string }>;
}

const STEPS = [0.25, 0.5, 1, 2, 5, 10, 30, 60] as const;
/** The least room between majors. 56 keeps 1 s majors at Fit on a 1440px window (≈ 63 px/s), as Main.png draws them. */
const MIN_MAJOR_PX = 56;
/** A step under a second needs this much room, so 120 px/s keeps the whole seconds Trim.png draws. */
const MIN_SUBSECOND_PX = 100;
/** From this much room between majors: five minors per major, and a label on every one. */
const ROOMY_MAJOR_PX = 100;
/** Guards the float steps: 0.1 + 0.2 must still land on a tick. */
const EPS = 1e-6;

export function majorStep(pxPerSec: number): number {
  return STEPS.find((step) => step * pxPerSec >= (step < 1 ? MIN_SUBSECOND_PX : MIN_MAJOR_PX)) ?? STEPS[STEPS.length - 1];
}

/**
 * major = the smallest step in [0.25, 0.5, 1, 2, 5, 10, 30, 60] with step·pps >= 56 (>= 100 for a step under a second);
 * minors per major = 5 if step·pps >= 100, else 4;
 * label every major if step·pps >= 100, else every second one (the even ones, so 0:00 is labelled);
 * label digits: 2 below a half-second step, 1 if pps >= 100 or step < 1, else 0.
 * At 64 px/s: majors 1 s, minors 0.25 s, labels "0:00","0:02",…  At 120 px/s: majors 1 s, minors 0.2 s, "0:04.0" every second.
 */
export function rulerTicks(pxPerSec: number, fromSec: number, toSec: number): RulerTicks {
  const majors: number[] = [];
  const minors: number[] = [];
  const labels: Array<{ t: number; text: string }> = [];
  if (!(pxPerSec > 0) || !Number.isFinite(fromSec) || !Number.isFinite(toSec) || toSec < fromSec) {
    return { majors, minors, labels };
  }
  const step = majorStep(pxPerSec);
  const roomy = step * pxPerSec >= ROOMY_MAJOR_PX;
  const perMajor = roomy ? 5 : 4;
  const minorStep = step / perMajor;
  const digits: 0 | 1 | 2 = step < 0.5 ? 2 : pxPerSec >= 100 || step < 1 ? 1 : 0;

  const first = Math.max(0, Math.floor(fromSec / step - EPS));
  const last = Math.ceil(toSec / step + EPS);
  for (let i = first; i <= last; i++) {
    const t = i * step;
    if (t < fromSec - EPS || t > toSec + EPS) continue;
    majors.push(t);
    if (roomy || i % 2 === 0) labels.push({ t, text: formatTimecode(t, digits) });
  }
  for (let i = first; i <= last; i++) {
    for (let k = 1; k < perMajor; k++) {
      const t = i * step + k * minorStep;
      if (t >= fromSec - EPS && t <= toSec + EPS) minors.push(t);
    }
  }
  return { majors, minors, labels };
}
