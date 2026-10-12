/**
 * What the GPU canvas measures about itself: frame times and the scene's
 * JavaScript per frame, input latency (from the event to the frame that drew
 * it), and the painter's timings. Exposed on window.__gpuCanvas for runners,
 * and read by the performance overlay.
 */

const MAX_SAMPLES = 4096;

export interface Percentiles {
  count: number;
  p50: number;
  p95: number;
  max: number;
}

export function percentiles(values: readonly number[]): Percentiles {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))] : 0);
  const round = (n: number) => Math.round(n * 100) / 100;
  return { count: sorted.length, p50: round(at(0.5)), p95: round(at(0.95)), max: round(sorted.at(-1) ?? 0) };
}

export class GpuCanvasStats {
  /** Named samples in ms (painter.batchMs, input.latencyMs, …), newest last. */
  readonly samples: Record<string, number[]> = {};
  frameTimes: number[] = [];
  jsMs: number[] = [];

  record(name: string, value: number) {
    const list = (this.samples[name] ??= []);
    list.push(value);
    if (list.length > MAX_SAMPLES) list.splice(0, list.length - MAX_SAMPLES / 2);
  }

  frame(now: number, jsMs: number) {
    this.frameTimes.push(now);
    this.jsMs.push(jsMs);
    if (this.frameTimes.length > MAX_SAMPLES * 3) {
      this.frameTimes = this.frameTimes.slice(-MAX_SAMPLES);
      this.jsMs = this.jsMs.slice(-MAX_SAMPLES);
    }
  }

  /** Clears samples and frames, for a runner starting a measurement. */
  reset() {
    for (const key of Object.keys(this.samples)) delete this.samples[key];
    this.frameTimes = [];
    this.jsMs = [];
  }

  summary() {
    const intervals = this.frameTimes.slice(1).map((t, i) => t - this.frameTimes[i]);
    const seconds = this.frameTimes.length > 1 ? (this.frameTimes.at(-1)! - this.frameTimes[0]) / 1000 : 0;
    return {
      fps: seconds ? Math.round(((this.frameTimes.length - 1) / seconds) * 10) / 10 : 0,
      frameMs: percentiles(intervals),
      jsMs: percentiles(this.jsMs),
      samples: Object.fromEntries(Object.entries(this.samples).map(([name, values]) => [name, percentiles(values)])),
    };
  }
}
