import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkflowStore } from "@/store/workflowStore";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { openStitchEditor } from "../openStitchEditor";
import { commitStitchEdit } from "../commitStitchEdit";
import { removeClip, splitClipAt, trimClip, type SourceKey } from "@/lib/stitch/timeline";
import type { VideoStitchNodeData, WorkflowEdge, WorkflowNode } from "@/types";

vi.mock("@/components/Toast", () => ({ useToast: { getState: () => ({ show: vi.fn() }) } }));

// Real stores: what Done does to the canvas, and how it undoes.

const wf = () => useWorkflowStore.getState();
const editor = () => useStitchEditorStore.getState();
const node = (id: string, type: string, data: Record<string, unknown>): WorkflowNode =>
  ({ id, type, data, position: { x: 0, y: 0 } }) as WorkflowNode;
const edge = (id: string, source: string, targetHandle: string): WorkflowEdge => ({
  id,
  source,
  target: "stitch",
  sourceHandle: "video",
  targetHandle,
});

const DURATIONS = new Map<SourceKey, number>([
  ["edge:eA", 5],
  ["edge:eB", 4],
]);

function seed() {
  useWorkflowStore.setState({
    nodes: [
      node("gen-a", "generateVideo", { outputVideo: "blob:a" }),
      node("gen-b", "generateVideo", { outputVideo: "blob:b" }),
      node("stitch", "videoStitch", { clips: [], clipOrder: ["eA", "eB"], outputVideo: null, loopCount: 1, status: "idle" }),
    ],
    edges: [edge("eA", "gen-a", "video-0"), edge("eB", "gen-b", "video-1")],
  });
  openStitchEditor("stitch");
  editor().setDurations(DURATIONS);
}

const data = () => wf().nodes.find((n) => n.id === "stitch")!.data as VideoStitchNodeData;
const edgeIds = () => wf().edges.map((e) => e.id);
const remove = (clipId: string) => editor().apply((d) => ({ ...d, timeline: removeClip(d.timeline, clipId).timeline }));

beforeEach(async () => {
  // An edge removal holds the store's delete checkpoint until the next task; let an earlier test's go
  await new Promise((resolve) => setTimeout(resolve, 0));
  wf().clearWorkflow();
  editor().close();
  seed();
});
afterEach(() => {
  editor().close();
  wf().clearWorkflow();
});

describe("commitStitchEdit", () => {
  it("closes without writing when nothing changed, so a legacy node stays legacy", () => {
    const before = wf().nodes;
    expect(commitStitchEdit()).toBe("closed");
    expect(editor().isOpen).toBe(false);
    expect(wf().nodes).toBe(before);
    expect("timeline" in data()).toBe(false);
  });

  it("writes the timeline, the curve, the music mute, the loop count and the clip order", () => {
    editor().apply((d) => ({ ...d, timeline: trimClip(d.timeline, "clip:eA", DURATIONS, { inSec: 1 }), loopCount: 2 }));
    expect(commitStitchEdit()).toBe("written");
    expect(data()).toMatchObject({
      timeline: [expect.objectContaining({ id: "clip:eA", inSec: 1 }), expect.objectContaining({ id: "clip:eB" })],
      audioCurve: [],
      audioMuted: false,
      loopCount: 2,
      clipOrder: ["eA", "eB"],
    });
    expect(editor().isOpen).toBe(false);
  });

  it("disconnects a video whose clip was removed, and one Undo brings back the edge and the old data", () => {
    const before = data();
    remove("clip:eA");
    expect(commitStitchEdit()).toBe("written");
    expect(edgeIds()).toEqual(["eB"]);
    expect(data().timeline!.map((c) => c.id)).toEqual(["clip:eB"]);
    expect(data().clipOrder).toEqual(["eB"]);

    wf().undo();
    expect(edgeIds()).toEqual(["eA", "eB"]);
    expect(data()).toEqual(before);
  });

  it("keeps the edge when one piece of a split is removed", () => {
    const split = splitClipAt(editor().draft!.timeline, DURATIONS, 2, () => "clip:eA-right")!;
    editor().apply((d) => ({ ...d, timeline: split.timeline }));
    remove("clip:eA-right");
    commitStitchEdit();
    expect(edgeIds()).toEqual(["eA", "eB"]);
    expect(data().timeline!.map((c) => [c.id, c.outSec])).toEqual([
      ["clip:eA", 2],
      ["clip:eB", null],
    ]);
  });

  it("removing every clip disconnects every edge and writes an empty timeline, undone in one step", () => {
    remove("clip:eA");
    remove("clip:eB");
    expect(commitStitchEdit()).toBe("written");
    expect(edgeIds()).toEqual([]);
    expect(data().timeline).toEqual([]);

    wf().undo();
    expect(edgeIds()).toEqual(["eA", "eB"]);
    expect("timeline" in data()).toBe(false);
  });

  it("picks up a video connected while the editor was open", () => {
    editor().apply((d) => ({ ...d, loopCount: 3 }));
    useWorkflowStore.setState({
      nodes: [...wf().nodes, node("gen-c", "generateVideo", { outputVideo: "blob:c" })],
      edges: [...wf().edges, edge("eC", "gen-c", "video-2")],
    });
    commitStitchEdit();
    expect(data().clipOrder).toEqual(["eA", "eB", "eC"]);
  });

  it("writes nothing when the canvas was replaced under it", () => {
    editor().apply((d) => ({ ...d, loopCount: 3 }));
    useWorkflowStore.setState({ canvasGeneration: wf().canvasGeneration + 1 });
    expect(commitStitchEdit()).toBe("gone");
    expect(data().loopCount).toBe(1);
    expect(editor().isOpen).toBe(false);
  });
});
