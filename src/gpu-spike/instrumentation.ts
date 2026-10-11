// GPU canvas spike (throwaway, never merged): what the spike measures in the
// page, exposed on window.__spike for scripts/gpu-spike.cjs and shown by the
// performance overlay.
//
// Frame figures here are the page's own (animation frames and the JavaScript
// the scene runs in each); the runner's Chromium trace is what judges
// presented frames.

export interface FrameStats {
  frames: number;
  seconds: number;
  fps: number;
  frameMs: { p50: number; p95: number; max: number };
  /** JavaScript the spike ran per frame (scene update and draw calls). */
  jsMs: { p50: number; p95: number; max: number };
}

export interface HtmlInCanvasSupport {
  /** The flag is on and the 152 names exist. */
  available: boolean;
  drawElementImage: boolean;
  texElementImage2D: boolean;
  layoutSubtree: boolean;
  captureElementImage: boolean;
  requestPaint: boolean;
  /** Chromium 155+ names, for the adapter. */
  texElementSubImage2D: boolean;
}

export interface SpikeApi {
  ready: boolean;
  error?: string;
  dataset?: { copies: number; nodes: number; edges: number; groups: number; loadMs: number };
  htmlInCanvas: HtmlInCanvasSupport;
  /** Starts a fresh frame window; `stop` returns its figures. */
  frames: { start(): void; stop(): FrameStats };
  /** Named timings (painter batches and the like), in ms. */
  timings: Record<string, number[]>;
  memory(): { jsHeapMB: number | null; atlasMB: number; atlasPages: number };
  /** Set by the scene once it exists. */
  scene?: Record<string, unknown>;
}

const round = (value: number, digits = 2) => Number(value.toFixed(digits));

function summarise(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))] : 0;
  return { p50: round(at(.5)), p95: round(at(.95)), max: round(sorted.at(-1) ?? 0) };
}

export function detectHtmlInCanvas(): HtmlInCanvasSupport {
  const has = (proto: object | undefined, name: string) => !!proto && name in proto;
  const c2 = globalThis.CanvasRenderingContext2D?.prototype;
  const gl = globalThis.WebGL2RenderingContext?.prototype;
  const canvas = globalThis.HTMLCanvasElement?.prototype;
  const support = {
    drawElementImage: has(c2, "drawElementImage"),
    texElementImage2D: has(gl, "texElementImage2D"),
    layoutSubtree: has(canvas, "layoutSubtree"),
    captureElementImage: has(canvas, "captureElementImage"),
    requestPaint: has(canvas, "requestPaint"),
    texElementSubImage2D: has(gl, "texElementSubImage2D"),
  };
  return { available: support.texElementImage2D && support.layoutSubtree, ...support };
}

/** Atlas accounting, updated by whatever owns the atlas pages. */
export const atlasMemory = { bytes: 0, pages: 0 };

/** Frame clock: the scene calls `frame(jsMs)` once per animation frame. */
export function createFrameRecorder() {
  let times: number[] = [];
  let js: number[] = [];
  return {
    frame(now: number, jsMs: number) {
      times.push(now);
      js.push(jsMs);
      // Holds about a minute at 180 Hz.
      if (times.length > 12_000) { times = times.slice(-6_000); js = js.slice(-6_000); }
    },
    start() { times = []; js = []; },
    stop(): FrameStats {
      const intervals = times.slice(1).map((time, i) => time - times[i]);
      const seconds = times.length > 1 ? (times.at(-1)! - times[0]) / 1000 : 0;
      return { frames: times.length, seconds: round(seconds), fps: seconds ? round((times.length - 1) / seconds, 1) : 0,
        frameMs: summarise(intervals), jsMs: summarise(js) };
    },
  };
}

export function installSpikeApi(recorder: ReturnType<typeof createFrameRecorder>): SpikeApi {
  const api: SpikeApi = {
    ready: false,
    htmlInCanvas: detectHtmlInCanvas(),
    frames: { start: recorder.start, stop: recorder.stop },
    timings: {},
    memory() {
      const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
      return { jsHeapMB: heap == null ? null : round(heap / 2 ** 20, 1), atlasMB: round(atlasMemory.bytes / 2 ** 20, 1), atlasPages: atlasMemory.pages };
    },
  };
  (window as unknown as { __spike: SpikeApi }).__spike = api;
  return api;
}

export function recordTiming(api: SpikeApi, name: string, ms: number) {
  (api.timings[name] ??= []).push(round(ms, 3));
}
