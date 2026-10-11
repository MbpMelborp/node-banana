// GPU canvas spike, question 4: does the workflow store hold at 5,000 nodes?
// Times a keystroke in a prompt, an undo step, autosave's serialisation and a
// load, with media by URL and inline, at several graph sizes so growth shows.
//
// Skipped in normal test runs. Run with:
//   GPU_SPIKE_BENCH=1 npx vitest run src/gpu-spike/storeBench.test.ts
// The report is written to docs/gpu-spike/store-bench.json (GPU_SPIKE_OUT moves it).
//
// This times the store alone: no React, no React Flow and no components are
// subscribed, so it is a floor for what a keystroke costs in the app.
import { describe, it, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { useWorkflowStore, type WorkflowFile } from "@/store/workflowStore";
import { stripDeadBlobUrls } from "@/store/utils/executionUtils";
import { tileWorkflow, sampleMediaUrls } from "./dataset";

vi.mock("@/components/Toast", () => ({ useToast: { getState: () => ({ show: vi.fn() }) } }));
vi.mock("@/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), startSession: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn().mockResolvedValue(undefined), getCurrentSession: vi.fn().mockReturnValue(null) },
}));
const storage: Record<string, string> = {};
vi.stubGlobal("localStorage", {
  getItem: (key: string) => storage[key] ?? null,
  setItem: (key: string, value: string) => { storage[key] = value; },
  removeItem: (key: string) => { delete storage[key]; },
  clear: () => { for (const key of Object.keys(storage)) delete storage[key]; },
});

const root = path.resolve(__dirname, "../..");
const COPIES = (process.env.GPU_SPIKE_COPIES ?? "1,4,17").split(",").map(Number);
const KEYSTROKES = 200;

const round = (value: number, digits = 3) => Number(value.toFixed(digits));
function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { n: samples.length, p50: round(at(.5)), p95: round(at(.95)), max: round(sorted.at(-1)!) };
}
function time(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

/** The sample photos, 1024 px on the long edge, as JPEG data URLs (the inline case). */
async function inlinePhotos(names: string[]): Promise<string[]> {
  const sharp = (await import("sharp")).default;
  return Promise.all(names.map(async name => {
    const jpeg = await sharp(path.join(root, "examples/sample-images", name)).resize(1024, 1024, { fit: "inside" }).jpeg({ quality: 90 }).toBuffer();
    return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
  }));
}

describe.skipIf(!process.env.GPU_SPIKE_BENCH)("GPU spike: store benchmark", () => {
  let base: WorkflowFile;
  let names: string[];
  let inline: string[];
  const report: Record<string, unknown>[] = [];

  beforeAll(async () => {
    base = JSON.parse(await fs.readFile(path.join(root, "examples/stress-workflow.json"), "utf8"));
    names = (await fs.readdir(path.join(root, "examples/sample-images"))).filter(name => /\.jpe?g$/i.test(name)).sort();
    inline = await inlinePhotos(names);
    // Loading hydrates media through the app's routes; nothing here needs them.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 404 })));
  }, 120_000);

  afterAll(async () => {
    const out = process.env.GPU_SPIKE_OUT ?? path.join(root, "docs/gpu-spike/store-bench.json");
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, JSON.stringify({
      date: new Date().toISOString(), node: process.version, cpu: os.cpus()[0]?.model, platform: `${os.platform()} ${os.arch()}`,
      note: "Store only: no React or React Flow subscribed. Timer-driven work (the undo debounce) is driven with fake timers.",
      results: report,
    }, null, 2));
    console.log(`\nStore benchmark written to ${out}`);
  });

  for (const copies of COPIES) {
    for (const media of ["url", "inline"] as const) {
      it(`${copies} copies, media ${media}`, async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
        try {
          const store = useWorkflowStore;
          store.getState().clearWorkflow();
          const mediaFor = media === "url" ? sampleMediaUrls(names) : (i: number) => inline[i % inline.length];
          const workflow = tileWorkflow(base, { copies, mediaFor });
          const row: Record<string, unknown> = { copies, media, nodes: workflow.nodes.length, edges: workflow.edges.length };

          // Load: the store's own work, with media hydration answered at once.
          const loadStart = performance.now();
          await store.getState().loadWorkflow(structuredClone(workflow));
          await vi.runOnlyPendingTimersAsync();
          row.loadMs = round(performance.now() - loadStart);

          const prompt = store.getState().nodes.find(node => node.type === "prompt")!;
          let text = String((prompt.data as { prompt?: string }).prompt ?? "");

          // A keystroke after a pause: the first one captures an undo snapshot of the whole graph.
          const firstAfterPause: number[] = [];
          for (let i = 0; i < 20; i++) {
            vi.advanceTimersByTime(600);
            text += "a";
            firstAfterPause.push(time(() => store.getState().updateNodeData(prompt.id, { prompt: text })));
          }
          // Keystrokes in a run of typing (the snapshot is already pending).
          vi.advanceTimersByTime(600);
          store.getState().updateNodeData(prompt.id, { prompt: (text += "b") });
          const typing: number[] = [];
          for (let i = 0; i < KEYSTROKES; i++) {
            text += "c";
            typing.push(time(() => store.getState().updateNodeData(prompt.id, { prompt: text })));
          }
          vi.advanceTimersByTime(600);
          row.keystrokeMs = stats(typing);
          row.keystrokeAfterPauseMs = stats(firstAfterPause);

          // Undo steps (each restores a full snapshot).
          const undo: number[] = [];
          for (let i = 0; i < 10 && store.getState().canUndo; i++) undo.push(time(() => store.getState().undo()));
          row.undoMs = stats(undo);

          // Autosave's synchronous share: what saveToFile builds and serialises before its network calls.
          const save: number[] = [];
          let bytes = 0;
          for (let i = 0; i < 3; i++) {
            try {
              save.push(time(() => {
                const state = store.getState();
                const json = JSON.stringify({ workflow: { version: 1, name: state.workflowName, nodes: stripDeadBlobUrls(state.nodes),
                  edges: state.edges, edgeStyle: state.edgeStyle, edgeAppearance: state.edgeAppearance, groups: state.groups } });
                bytes = json.length;
              }));
            } catch (error) {
              row.autosaveError = error instanceof Error ? error.message : String(error);
              break;
            }
          }
          if (save.length) row.autosaveSerialiseMs = stats(save);
          row.autosaveChars = bytes;
          row.heapUsedMB = round(process.memoryUsage().heapUsed / 2 ** 20, 0);

          report.push(row);
          console.log(JSON.stringify(row));
        } finally {
          vi.useRealTimers();
        }
      }, 600_000);
    }
  }
});
