// The workflow store at scale: a keystroke in a prompt, an undo step,
// autosave's serialisation and a load, at several graph sizes so any growth
// shows, with media by URL and inline.
//
// Skipped in normal test runs. Run with:
//   NB_STORE_BENCH=1 npx vitest run src/store/__tests__/storeBench.test.ts
// NB_STORE_BENCH_COPIES (default 1,4,17,34) picks the sizes: copies of the
// 303-node stress workflow. NB_STORE_BENCH_OUT writes the JSON report there.
//
// This times the store alone: no React, no React Flow and no components are
// subscribed, so it is a floor for what a keystroke costs in the app.
import { describe, it, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { WorkflowFile } from "@/store/workflowStore";
import { tileWorkflow } from "./fixtures/tiledWorkflow";

// The tests' graph freeze walks every new array; the app does not.
vi.hoisted(() => {
  process.env.NB_FREEZE_GRAPH = "off";
});

vi.mock("@/components/Toast", () => ({ useToast: { getState: () => ({ show: vi.fn() }) } }));
vi.mock("@/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), startSession: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn().mockResolvedValue(undefined), getCurrentSession: vi.fn().mockReturnValue(null) },
}));

const root = path.resolve(__dirname, "../../..");
const COPIES = (process.env.NB_STORE_BENCH_COPIES ?? "1,4,17,34").split(",").map(Number);
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

describe.skipIf(!process.env.NB_STORE_BENCH)("store benchmark", () => {
  let base: WorkflowFile;
  let inline: string[];
  const report: Record<string, unknown>[] = [];

  beforeAll(async () => {
    base = JSON.parse(await fs.readFile(path.join(root, "examples/stress-workflow.json"), "utf8"));
    const names = (await fs.readdir(path.join(root, "examples/sample-images"))).filter(name => /\.jpe?g$/i.test(name)).sort();
    inline = await inlinePhotos(names);
    // Loading hydrates media through the app's routes; nothing here needs them.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: false }), { status: 404 })));
  }, 120_000);

  afterAll(async () => {
    const out = process.env.NB_STORE_BENCH_OUT;
    if (!out) return;
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
          const { useWorkflowStore } = await import("@/store/workflowStore");
          const { serializeWorkflowRequest } = await import("@/store/utils/workflowSerializer");
          const { subscribeToNodeChanges } = await import("@/store/nodeChanges");
          const store = useWorkflowStore;
          store.getState().clearWorkflow();
          const mediaFor = media === "url"
            ? (i: number) => `/api/assets/sample-${i % 16}/file`
            : (i: number) => inline[i % inline.length];
          const workflow = tileWorkflow(base, { copies, mediaFor });
          const row: Record<string, unknown> = { copies, media, nodes: workflow.nodes.length, edges: workflow.edges.length };

          // Load: the store's own work, with media hydration answered at once.
          const loadStart = performance.now();
          await store.getState().loadWorkflow(structuredClone(workflow));
          await vi.runOnlyPendingTimersAsync();
          row.loadMs = round(performance.now() - loadStart);

          const prompt = store.getState().nodes.find(node => node.type === "prompt")!;
          let text = String((prompt.data as { prompt?: string }).prompt ?? "");

          // A keystroke after a pause: the first one starts an undo step.
          const firstAfterPause: number[] = [];
          for (let i = 0; i < 20; i++) {
            vi.advanceTimersByTime(600);
            text += "a";
            firstAfterPause.push(time(() => store.getState().updateNodeData(prompt.id, { prompt: text })));
          }
          // Keystrokes in a run of typing (the undo step is already open).
          vi.advanceTimersByTime(600);
          store.getState().updateNodeData(prompt.id, { prompt: (text += "b") });
          const typing: number[] = [];
          for (let i = 0; i < KEYSTROKES; i++) {
            text += "c";
            typing.push(time(() => store.getState().updateNodeData(prompt.id, { prompt: text })));
          }
          // The same, with a node-change listener attached (the GPU canvas's painter has one).
          let reported = 0;
          const unsubscribe = subscribeToNodeChanges(store, changes => { reported += changes.updated.size; });
          const listened: number[] = [];
          for (let i = 0; i < KEYSTROKES; i++) {
            text += "d";
            listened.push(time(() => store.getState().updateNodeData(prompt.id, { prompt: text })));
          }
          unsubscribe();
          if (reported !== KEYSTROKES) throw new Error(`Expected ${KEYSTROKES} reported changes, got ${reported}`);
          vi.advanceTimersByTime(600);
          row.keystrokeMs = stats(typing);
          row.keystrokeAfterPauseMs = stats(firstAfterPause);
          row.keystrokeWithListenerMs = stats(listened);

          // Undo steps, then the same number of redos.
          const undo: number[] = [];
          for (let i = 0; i < 10 && store.getState().canUndo; i++) undo.push(time(() => store.getState().undo()));
          row.undoMs = stats(undo);
          const redo: number[] = [];
          for (let i = 0; i < 10 && store.getState().canRedo; i++) redo.push(time(() => store.getState().redo()));
          row.redoMs = stats(redo);

          // Autosave's synchronous share: building the request body. The first
          // one serialises every node; after an edit only that node is redone.
          const serialise = () => {
            const state = store.getState();
            return serializeWorkflowRequest({ directoryPath: "/bench", filename: state.workflowName }, {
              version: 1, id: "bench", name: state.workflowName, nodes: state.nodes, edges: state.edges,
              edgeStyle: state.edgeStyle, edgeAppearance: state.edgeAppearance, groups: state.groups,
            });
          };
          try {
            let chars = 0;
            row.autosaveFirstMs = round(time(() => { chars = serialise().length; }));
            const after: number[] = [];
            for (let i = 0; i < 5; i++) {
              store.getState().updateNodeData(prompt.id, { prompt: (text += "e") });
              after.push(time(() => { chars = serialise().length; }));
            }
            row.autosaveAfterEditMs = stats(after);
            row.autosaveChars = chars;
          } catch (error) {
            row.autosaveError = error instanceof Error ? error.message : String(error);
          }
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
