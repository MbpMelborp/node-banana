import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StitchTimelineClip, WorkflowEdge, WorkflowNode } from "@/types";
import { getConnectedInputsPure } from "@/store/utils/connectedInputs";
import type { NodeExecutionContext } from "../types";
import { gatherStitchInputs } from "../stitchInputs";

const mocks = vi.hoisted(() => {
  class AssetApiError extends Error {
    constructor(
      message: string,
      public readonly status: number,
    ) {
      super(message);
      this.name = "AssetApiError";
    }
  }
  return { AssetApiError, fetchAssetBlob: vi.fn(), prepareAudioAsync: vi.fn(), requestAssetInfo: vi.fn() };
});
vi.mock("@/lib/assets/client/api", () => ({ AssetApiError: mocks.AssetApiError, fetchAssetBlob: mocks.fetchAssetBlob }));
vi.mock("@/hooks/useAudioMixing", () => ({ prepareAudioAsync: mocks.prepareAudioAsync }));
vi.mock("@/lib/stitch/assetInfo", () => ({ requestAssetInfo: mocks.requestAssetInfo }));

/** Where each fetched Blob came from (jsdom's Blob cannot be read back). */
const origins = new WeakMap<Blob, string>();
function sourced(from: string, type: string): Blob {
  const blob = new Blob([from], { type });
  origins.set(blob, from);
  return blob;
}
const mockFetch = vi.fn(async (url: string) => ({ blob: async () => sourced(url, url.startsWith("audio") ? "audio/mpeg" : "video/mp4") }));
vi.stubGlobal("fetch", mockFetch);

const node = (id: string, type: string, data: Record<string, unknown>) =>
  ({ id, type, position: { x: 0, y: 0 }, data }) as unknown as WorkflowNode;
const edge = (id: string, source: string, target: string, targetHandle: string, sourceHandle = "video") =>
  ({ id, source, target, sourceHandle, targetHandle }) as WorkflowEdge;
const video = (id: string, url: string | null) => node(id, "generateVideo", { outputVideo: url });
const edgeClip = (id: string, edgeId: string, extra: Partial<StitchTimelineClip> = {}): StitchTimelineClip => ({
  id,
  source: { kind: "edge", edgeId },
  inSec: 0,
  outSec: null,
  muted: false,
  volume: 1,
  ...extra,
});
const assetClip = (id: string, assetId: string, extra: Partial<StitchTimelineClip> = {}): StitchTimelineClip => ({
  id,
  source: { kind: "asset", assetId },
  inSec: 0,
  outSec: null,
  muted: false,
  volume: 1,
  ...extra,
});

function stitchNode(data: Record<string, unknown> = {}): WorkflowNode {
  return node("s", "videoStitch", { clips: [], clipOrder: [], loopCount: 1, outputVideo: null, ...data });
}

/** A context over a real graph; getConnectedInputs reads it the way the store does. */
function makeCtx(stitch: WorkflowNode, nodes: WorkflowNode[], edges: WorkflowEdge[], extra: Partial<NodeExecutionContext> = {}) {
  const all = [stitch, ...nodes];
  return {
    node: stitch,
    getConnectedInputs: (id: string) => getConnectedInputsPure(id, all, edges),
    updateNodeData: vi.fn(),
    getFreshNode: (id: string) => all.find((n) => n.id === id),
    getEdges: () => edges,
    getNodes: () => all,
    get: () => ({ dimmedNodeIds: new Set<string>() }),
    ...extra,
  } as unknown as NodeExecutionContext;
}

function texts(blobs: Blob[]): Array<string | undefined> {
  return blobs.map((b) => origins.get(b));
}

const twoVideos = () => ({
  nodes: [video("g1", "blob:one"), video("g2", "blob:two")],
  edges: [edge("e1", "g1", "s", "video-0"), edge("e2", "g2", "s", "video-1")],
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchAssetBlob.mockImplementation(async (id: string) => sourced(`asset:${id}`, "video/mp4"));
  mocks.prepareAudioAsync.mockResolvedValue({ buffer: { sampleRate: 48000 }, duration: 3 });
});

describe("gatherStitchInputs", () => {
  it("follows the timeline's order, not the edges'", async () => {
    const { nodes, edges } = twoVideos();
    const stitch = stitchNode({ timeline: [edgeClip("b", "e2"), edgeClip("a", "e1")] });
    const g = await gatherStitchInputs(makeCtx(stitch, nodes, edges), stitch.data as never);
    expect(texts(g.clips.map((c) => c.blob))).toEqual(["blob:two", "blob:one"]);
  });

  it("honours an unedited node's reordered clipOrder", async () => {
    const { nodes, edges } = twoVideos();
    const stitch = stitchNode({ clipOrder: ["e2", "e1"] });
    const g = await gatherStitchInputs(makeCtx(stitch, nodes, edges), stitch.data as never);
    expect(texts(g.clips.map((c) => c.blob))).toEqual(["blob:two", "blob:one"]);
  });

  it("passes In, Out, mute and volume through", async () => {
    const { nodes, edges } = twoVideos();
    const stitch = stitchNode({
      timeline: [edgeClip("a", "e1", { inSec: 0.8, outSec: 5 }), edgeClip("b", "e2", { muted: true, volume: 0.4 })],
    });
    const g = await gatherStitchInputs(makeCtx(stitch, nodes, edges), stitch.data as never);
    expect(g.clips.map(({ inSec, outSec, muted, volume }) => ({ inSec, outSec, muted, volume }))).toEqual([
      { inSec: 0.8, outSec: 5, muted: false, volume: 1 },
      { inSec: 0, outSec: null, muted: true, volume: 0.4 },
    ]);
    expect(g.clipCount).toBe(2);
  });

  it("loads a library clip from the asset library, with the run's signal", async () => {
    const { nodes, edges } = twoVideos();
    const signal = new AbortController().signal;
    const stitch = stitchNode({ timeline: [edgeClip("a", "e1"), assetClip("x", "aasset0000009")] });
    const g = await gatherStitchInputs(makeCtx(stitch, nodes, edges, { signal }), stitch.data as never);
    expect(mocks.fetchAssetBlob).toHaveBeenCalledWith("aasset0000009", signal);
    // e2 is not in the timeline yet, so it is appended, as on the card
    expect(texts(g.clips.map((c) => c.blob))).toEqual(["blob:one", "asset:aasset0000009", "blob:two"]);
  });

  it("fetches a split clip's source once", async () => {
    const { nodes, edges } = twoVideos();
    const stitch = stitchNode({
      timeline: [edgeClip("a1", "e1", { outSec: 2 }), edgeClip("a2", "e1", { inSec: 2 }), assetClip("x1", "alibrary00001"), assetClip("x2", "alibrary00001"), edgeClip("b", "e2")],
    });
    const g = await gatherStitchInputs(makeCtx(stitch, nodes, edges), stitch.data as never);
    expect(g.clips).toHaveLength(5);
    expect(g.clips[0].blob).toBe(g.clips[1].blob);
    expect(mockFetch.mock.calls.filter(([url]) => url === "blob:one")).toHaveLength(1);
    expect(mocks.fetchAssetBlob).toHaveBeenCalledTimes(1);
  });

  it("skips a clip whose source has not generated yet", async () => {
    const nodes = [video("g1", "blob:one"), video("g2", null), video("g3", "blob:three")];
    const edges = [edge("e1", "g1", "s", "video-0"), edge("e2", "g2", "s", "video-1"), edge("e3", "g3", "s", "video-2")];
    const stitch = stitchNode({ timeline: [edgeClip("a", "e1"), edgeClip("b", "e2"), edgeClip("c", "e3")] });
    const g = await gatherStitchInputs(makeCtx(stitch, nodes, edges), stitch.data as never);
    expect(texts(g.clips.map((c) => c.blob))).toEqual(["blob:one", "blob:three"]);
  });

  it("refuses one playable clip before fetching anything", async () => {
    const nodes = [video("g1", "blob:one"), video("g2", null)];
    const edges = [edge("e1", "g1", "s", "video-0"), edge("e2", "g2", "s", "video-1")];
    const stitch = stitchNode();
    await expect(gatherStitchInputs(makeCtx(stitch, nodes, edges), stitch.data as never)).rejects.toThrow(
      "Need at least 2 video clips to stitch",
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("mutes an unedited node's clips under music, as the stitch did", async () => {
    const { nodes, edges } = twoVideos();
    const music = node("m", "generateAudio", { outputAudio: "audio:song" });
    const stitch = stitchNode();
    const g = await gatherStitchInputs(makeCtx(stitch, [...nodes, music], [...edges, edge("em", "m", "s", "audio", "audio")]), stitch.data as never);
    expect(g.clips.map((c) => c.muted)).toEqual([true, true]);
    expect(g.music).toEqual({ audio: { buffer: { sampleRate: 48000 }, duration: 3 }, curve: [], muted: false });
    expect(mocks.prepareAudioAsync).toHaveBeenCalledWith(expect.any(Blob), 0);
  });

  it("keeps an unedited node's clip sound when its music would not decode", async () => {
    const { nodes, edges } = twoVideos();
    const music = node("m", "generateAudio", { outputAudio: "audio:song" });
    mocks.prepareAudioAsync.mockResolvedValue(null);
    const stitch = stitchNode();
    const g = await gatherStitchInputs(makeCtx(stitch, [...nodes, music], [...edges, edge("em", "m", "s", "audio", "audio")]), stitch.data as never);
    expect(g.music).toBeNull();
    expect(g.clips.map((c) => c.muted)).toEqual([false, false]);
  });

  describe("an edge from a router carrying three videos", () => {
    const nodes = [
      video("g1", "blob:1"),
      video("g2", "blob:2"),
      video("g3", "blob:3"),
      node("r", "router", {}),
    ];
    const edges = [
      edge("a", "g1", "r", "video"),
      edge("b", "g2", "r", "video"),
      edge("c", "g3", "r", "video"),
      edge("e1", "r", "s", "video-0"),
    ];

    it("gives an unedited node every video, in the router's order", async () => {
      const stitch = stitchNode();
      const g = await gatherStitchInputs(makeCtx(stitch, nodes, edges), stitch.data as never);
      expect(texts(g.clips.map((c) => c.blob))).toEqual(["blob:1", "blob:2", "blob:3"]);
    });

    it("gives a timeline node's clip the first video only", async () => {
      const stitch = stitchNode({ timeline: [edgeClip("a", "e1"), assetClip("x", "alibrary00001")] });
      const g = await gatherStitchInputs(makeCtx(stitch, nodes, edges), stitch.data as never);
      expect(texts(g.clips.map((c) => c.blob))).toEqual(["blob:1", "asset:alibrary00001"]);
    });
  });

  it("neither decodes nor returns muted music", async () => {
    const { nodes, edges } = twoVideos();
    const music = node("m", "generateAudio", { outputAudio: "audio:song" });
    const stitch = stitchNode({ timeline: [edgeClip("a", "e1"), edgeClip("b", "e2")], audioMuted: true });
    const g = await gatherStitchInputs(makeCtx(stitch, [...nodes, music], [...edges, edge("em", "m", "s", "audio", "audio")]), stitch.data as never);
    expect(g.music).toBeNull();
    expect(mocks.prepareAudioAsync).not.toHaveBeenCalled();
  });

  it("hands the music its curve and the node's loop count", async () => {
    const { nodes, edges } = twoVideos();
    const music = node("m", "generateAudio", { outputAudio: "audio:song" });
    const curve = [{ t: 1, gain: 0.25 }];
    const stitch = stitchNode({ timeline: [edgeClip("a", "e1"), edgeClip("b", "e2")], audioCurve: curve, loopCount: 3 });
    const g = await gatherStitchInputs(makeCtx(stitch, [...nodes, music], [...edges, edge("em", "m", "s", "audio", "audio")]), stitch.data as never);
    expect(g.music?.curve).toEqual(curve);
    expect(g.loopCount).toBe(3);
  });

  it("says which clip's library video is gone", async () => {
    const { nodes, edges } = twoVideos();
    mocks.fetchAssetBlob.mockRejectedValue(new mocks.AssetApiError("No such asset in the library.", 404));
    const stitch = stitchNode({ timeline: [edgeClip("a", "e1"), edgeClip("b", "e2"), assetClip("x", "agone00000001")] });
    await expect(gatherStitchInputs(makeCtx(stitch, nodes, edges), stitch.data as never)).rejects.toThrow(
      "Clip 3's library video is no longer in the library",
    );
    // The card and the editor hear it now, not at the next open
    expect(mocks.requestAssetInfo).toHaveBeenCalledWith(["agone00000001"], { refresh: true });
  });

  it("falls back to the connected videos when there are no edges to read", async () => {
    const stitch = stitchNode();
    const ctx = makeCtx(stitch, [], [], {
      getConnectedInputs: vi.fn().mockReturnValue({ videos: ["v1", "v2"], audio: [] }),
    });
    const g = await gatherStitchInputs(ctx, stitch.data as never);
    expect(texts(g.clips.map((c) => c.blob))).toEqual(["v1", "v2"]);
    expect(g.clips.every((c) => c.inSec === 0 && c.outSec === null && !c.muted && c.volume === 1)).toBe(true);
  });
});
