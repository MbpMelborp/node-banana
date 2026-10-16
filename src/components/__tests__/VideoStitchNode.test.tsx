import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { VideoStitchNodeData } from "@/types";

// Mock the workflow store
const mockUpdateNodeData = vi.fn();
const mockRegenerateNode = vi.fn();
const mockRemoveEdge = vi.fn();
const mockUseWorkflowStore = vi.fn();
// What getState() returns: the state setMockStoreState last set
let mockStoreState: Record<string, unknown> = {};

vi.mock("@/store/workflowStore", () => ({
  useWorkflowStore: Object.assign(
    (selector?: (state: unknown) => unknown) => {
      if (selector) {
        return mockUseWorkflowStore(selector);
      }
      return mockUseWorkflowStore((s: unknown) => s);
    },
    { getState: () => mockStoreState }
  ),
}));

// Mock @xyflow/react
vi.mock("@xyflow/react", () => {
  const React = require("react");
  const MockHandle = (props: Record<string, unknown>) =>
    React.createElement("div", {
      "data-testid": `handle-${props.id}`,
      "data-handleid": props.id,
      "data-handletype": props["data-handletype"],
      "data-type": props.type,
      "data-position": props.position,
      "data-connectable": String(props.isConnectable ?? ""),
      className: `react-flow__handle react-flow__handle-${props.position}`,
      style: props.style,
    });
  return {
    Handle: MockHandle,
    NodeResizer: () => null,
    NodeResizeControl: () => null,
    useNodeConnections: () => [],
    useStore: () => undefined,
    useStoreApi: () => ({ getState: () => ({ nodeLookup: new Map() }), subscribe: () => () => {} }),
    useUpdateNodeInternals: () => () => {},
    Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
    ReactFlowProvider: ({ children }: { children: React.ReactNode }) => children,
    useReactFlow: () => ({
      getNodes: () => [],
      setNodes: () => {},
      screenToFlowPosition: (pos: unknown) => pos,
    }),
    useConnection: (selector: (state: { inProgress: boolean }) => boolean) => selector({ inProgress: false }),
    useNodeId: () => "node-1",
  };
});

// Mock useStitchVideos (this also prevents mediabunny from loading)
const mockCheckEncoderSupport = vi.fn();
vi.mock("@/hooks/useStitchVideos", () => ({
  checkEncoderSupport: () => mockCheckEncoderSupport(),
}));

vi.mock("@/components/Toast", () => ({
  useToast: { getState: () => ({ show: vi.fn() }) },
}));

vi.mock("@/hooks/useCommentNavigation", () => ({
  useCommentNavigation: () => null,
}));

vi.mock("@/components/nodes/BaseNode", () => {
  const React = require("react");
  return {
    BaseNode: ({ children, ...props }: Record<string, unknown>) =>
      React.createElement(
        "div",
        { "data-testid": "base-node", "data-title": props.title },
        children as React.ReactNode
      ),
  };
});

import { VideoStitchNode } from "@/components/nodes/VideoStitchNode";
import { createDefaultNodeData } from "@/store/utils/nodeDefaults";
import { createClip } from "@/lib/stitch/timeline";

/** Set up mock store state, merging overrides onto the base state. */
function setMockStoreState(overrides: Record<string, unknown> = {}) {
  const state = {
    updateNodeData: mockUpdateNodeData,
    regenerateNode: mockRegenerateNode,
    removeEdge: mockRemoveEdge,
    edges: [],
    nodes: [],
    isRunning: false,
    currentNodeIds: [],
    groups: {},
    getNodesWithComments: vi.fn(() => []),
    markCommentViewed: vi.fn(),
    setNavigationTarget: vi.fn(),
    ...overrides,
  };
  mockStoreState = state;
  mockUseWorkflowStore.mockImplementation((selector: (s: typeof state) => unknown) => selector(state));
}

const createNodeData = (overrides: Partial<VideoStitchNodeData> = {}): VideoStitchNodeData => ({
  clips: [],
  clipOrder: [],
  outputVideo: null,
  status: "idle",
  error: null,
  progress: 0,
  encoderSupported: true,
  ...overrides,
});

const createNodeProps = (data: Partial<VideoStitchNodeData> = {}) => ({
  id: "test-stitch-1",
  type: "videoStitch" as const,
  data: createNodeData(data),
  selected: false,
});

describe("VideoStitchNode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckEncoderSupport.mockResolvedValue(true);
    setMockStoreState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Handle Rendering", () => {
    it("should render video-0, video-1, audio, and output handles", () => {
      const { container } = render(<VideoStitchNode {...createNodeProps()} />);

      expect(container.querySelector('[data-handleid="video-0"]')).toBeInTheDocument();
      expect(container.querySelector('[data-handleid="video-1"]')).toBeInTheDocument();
      expect(container.querySelector('[data-handleid="audio"]')).toBeInTheDocument();
      expect(container.querySelector('[data-handleid="video"]')).toBeInTheDocument();

      const handles = container.querySelectorAll(".react-flow__handle");
      expect(handles.length).toBeGreaterThanOrEqual(4);
      handles.forEach((handle) => {
        expect(handle.classList.contains("react-flow__handle-not-connectable")).toBe(false);
      });
    });

    it("should grow dynamic handles when video edges exist", () => {
      setMockStoreState({
        edges: [
          { id: "e1", source: "gen1", target: "test-stitch-1", targetHandle: "video-0" },
          { id: "e2", source: "gen2", target: "test-stitch-1", targetHandle: "video-1" },
        ],
        nodes: [
          { id: "gen1", type: "generateVideo", data: { outputVideo: null } },
          { id: "gen2", type: "generateVideo", data: { outputVideo: null } },
        ],
      });

      const { container } = render(<VideoStitchNode {...createNodeProps()} />);

      expect(container.querySelector('[data-handleid="video-0"]')).toBeInTheDocument();
      expect(container.querySelector('[data-handleid="video-1"]')).toBeInTheDocument();
      expect(container.querySelector('[data-handleid="video-2"]')).toBeInTheDocument();
    });
  });

  describe("Encoder Detection States", () => {
    it("should show checking state when encoderSupported is null", () => {
      render(<VideoStitchNode {...createNodeProps({ encoderSupported: null })} />);
      expect(screen.getByText("Checking encoder...")).toBeInTheDocument();
    });

    it("should show unsupported message when encoderSupported is false", () => {
      render(<VideoStitchNode {...createNodeProps({ encoderSupported: false })} />);
      expect(screen.getByText("Your browser doesn't support video encoding.")).toBeInTheDocument();
    });

    it("should render handles in checking and unsupported states for connection stability", () => {
      const { container: checking } = render(
        <VideoStitchNode {...createNodeProps({ encoderSupported: null })} />
      );
      expect(checking.querySelectorAll(".react-flow__handle").length).toBeGreaterThanOrEqual(4);

      const { container: unsupported } = render(
        <VideoStitchNode {...createNodeProps({ encoderSupported: false })} />
      );
      expect(unsupported.querySelectorAll(".react-flow__handle").length).toBeGreaterThanOrEqual(4);
    });
  });

  describe("Empty State", () => {
    it("should show placeholder when no clips connected", () => {
      render(<VideoStitchNode {...createNodeProps()} />);
      expect(screen.getByText("Connect videos to stitch")).toBeInTheDocument();
    });
  });

  describe("Sequence reconciliation", () => {
    const STITCH_ID = "test-stitch-1";
    const twoEdges = {
      edges: [
        { id: "e1", source: "gen1", target: STITCH_ID, targetHandle: "video-0" },
        { id: "e2", source: "gen2", target: STITCH_ID, targetHandle: "video-1" },
      ],
      nodes: [
        { id: "gen1", type: "generateVideo", data: { outputVideo: null } },
        { id: "gen2", type: "generateVideo", data: { outputVideo: null } },
      ],
    };
    const orderWrites = () =>
      mockUpdateNodeData.mock.calls.filter(([, patch]) => "clipOrder" in patch || "timeline" in patch);

    /** The store as React Flow sees it: the stitch node itself holds `data`. */
    function setGraph(graph: { edges: unknown[]; nodes: unknown[] }, data: VideoStitchNodeData) {
      setMockStoreState({
        edges: graph.edges,
        nodes: [...graph.nodes, { id: STITCH_ID, type: "videoStitch", data }],
      });
    }
    function renderStitch(graph: { edges: unknown[]; nodes: unknown[] }, overrides: Partial<VideoStitchNodeData>) {
      const props = createNodeProps(overrides);
      setGraph(graph, props.data);
      return render(<VideoStitchNode {...props} />);
    }

    it("writes nothing for a legacy node whose clipOrder matches its edges", () => {
      renderStitch(twoEdges, { clipOrder: ["e2", "e1"] });
      expect(orderWrites()).toEqual([]);
    });

    it("writes clipOrder alone when a legacy node gains an edge", () => {
      renderStitch(twoEdges, { clipOrder: ["e2"] });
      expect(orderWrites()).toEqual([[STITCH_ID, { clipOrder: ["e2", "e1"] }]]);
    });

    it("writes the timeline with clipOrder for a node the editor emptied", () => {
      renderStitch({ edges: [twoEdges.edges[0]], nodes: [twoEdges.nodes[0]] }, { clipOrder: [], timeline: [] });
      expect(orderWrites()).toEqual([
        [
          STITCH_ID,
          {
            timeline: [
              { id: "clip:e1", source: { kind: "edge", edgeId: "e1" }, inSec: 0, outSec: null, muted: false, volume: 1 },
            ],
            clipOrder: ["e1"],
          },
        ],
      ]);
    });

    it("treats a new node as legacy and writes clipOrder alone", () => {
      const fresh = createDefaultNodeData("videoStitch") as VideoStitchNodeData;
      expect("timeline" in fresh).toBe(false);
      const data = { ...fresh, encoderSupported: true };
      setGraph({ edges: [twoEdges.edges[0]], nodes: [twoEdges.nodes[0]] }, data);
      render(<VideoStitchNode id={STITCH_ID} type="videoStitch" data={data} selected={false} />);
      expect(orderWrites()).toEqual([[STITCH_ID, { clipOrder: ["e1"] }]]);
    });

    it("writes nothing for a timeline node already in sync with its edges", () => {
      renderStitch(twoEdges, {
        clipOrder: ["e2", "e1"],
        timeline: [
          createClip({ kind: "edge", edgeId: "e2" }, { id: "clip:e2" }),
          createClip({ kind: "edge", edgeId: "e1" }, { id: "x", inSec: 1 }),
        ],
      });
      expect(orderWrites()).toEqual([]);
    });

    it("drops the clip of a vanished edge from a timeline node, keeping the others' trims", () => {
      const kept = createClip({ kind: "edge", edgeId: "e1" }, { id: "x", inSec: 1.5 });
      renderStitch(
        { edges: [twoEdges.edges[0]], nodes: [twoEdges.nodes[0]] },
        { clipOrder: ["e2", "e1"], timeline: [createClip({ kind: "edge", edgeId: "e2" }, { id: "clip:e2" }), kept] }
      );
      expect(orderWrites()).toEqual([[STITCH_ID, { timeline: [kept], clipOrder: ["e1"] }]]);
    });

    it("does not count a loop edge an older card saved into clipOrder as stale", () => {
      const loopEdge = { id: "eL", source: "gen3", target: STITCH_ID, targetHandle: "video-2", data: { isLoop: true } };
      renderStitch(
        { edges: [...twoEdges.edges, loopEdge], nodes: [...twoEdges.nodes, { id: "gen3", type: "generateVideo", data: {} }] },
        { clipOrder: ["e1", "e2", "eL"] }
      );
      expect(orderWrites()).toEqual([]);
    });

    it("does not write again when Undo restores the clipOrder from before its write", () => {
      const props = createNodeProps({ clipOrder: ["e1"] });
      setGraph(twoEdges, props.data);
      const { rerender } = render(<VideoStitchNode {...props} />);
      expect(orderWrites()).toEqual([[STITCH_ID, { clipOrder: ["e1", "e2"] }]]);

      // The write lands
      const written = createNodeData({ clipOrder: ["e1", "e2"] });
      setGraph(twoEdges, written);
      rerender(<VideoStitchNode {...props} data={written} />);
      // Undo restores the snapshot taken with the new edge and the old clipOrder
      const restored = createNodeData({ clipOrder: ["e1"] });
      setGraph(twoEdges, restored);
      rerender(<VideoStitchNode {...props} data={restored} />);

      expect(orderWrites()).toHaveLength(1);
    });

    it("builds its write from the store, not from a data prop that has not caught up", () => {
      // The store already holds a newer timeline (a trim) for the new edges in the
      // same update; the prop still carries the old data
      const stale = createNodeData({
        clipOrder: ["e1", "e2"],
        timeline: [
          createClip({ kind: "edge", edgeId: "e1" }, { id: "clip:e1" }),
          createClip({ kind: "edge", edgeId: "e2" }, { id: "clip:e2" }),
        ],
      });
      const current = createNodeData({
        clipOrder: ["e1"],
        timeline: [createClip({ kind: "edge", edgeId: "e1" }, { id: "clip:e1", inSec: 1.5 })],
      });
      setGraph({ edges: [twoEdges.edges[0]], nodes: [twoEdges.nodes[0]] }, current);
      render(<VideoStitchNode {...createNodeProps()} data={stale} />);
      expect(orderWrites()).toEqual([]);
    });

    it("shows the clips in the stored order", () => {
      const { container } = renderStitch(twoEdges, { clipOrder: ["e2", "e1"] });
      const tiles = [...container.querySelectorAll("[data-clip-id]")].map((el) => el.getAttribute("data-clip-id"));
      expect(tiles).toEqual(["clip:e2", "clip:e1"]);
      expect(screen.getByText("2 clips")).toBeInTheDocument();
    });

    describe("drag reorder", () => {
      const originalElementsFromPoint = document.elementsFromPoint;
      beforeEach(() => {
        HTMLElement.prototype.setPointerCapture ??= () => {};
        HTMLElement.prototype.releasePointerCapture ??= () => {};
      });
      afterEach(() => {
        document.elementsFromPoint = originalElementsFromPoint;
      });

      function dragTile(container: HTMLElement, from: string, to: string) {
        const source = container.querySelector(`[data-clip-id="${from}"]`) as HTMLElement;
        const target = container.querySelector(`[data-clip-id="${to}"]`) as HTMLElement;
        document.elementsFromPoint = () => [target];
        fireEvent.pointerDown(source, { button: 0, pointerId: 1 });
        fireEvent.pointerMove(source, { pointerId: 1, clientX: 10, clientY: 10 });
        fireEvent.pointerUp(source, { pointerId: 1 });
      }

      it("writes the new clipOrder alone for a legacy node", () => {
        const { container } = renderStitch(twoEdges, { clipOrder: ["e2", "e1"] });
        dragTile(container, "clip:e2", "clip:e1");
        expect(orderWrites()).toEqual([[STITCH_ID, { clipOrder: ["e1", "e2"] }]]);
      });

      it("writes the moved timeline and its clipOrder for a timeline node", () => {
        const a = createClip({ kind: "edge", edgeId: "e1" }, { id: "a", inSec: 1 });
        const b = createClip({ kind: "edge", edgeId: "e2" }, { id: "b", muted: true });
        const { container } = renderStitch(twoEdges, { clipOrder: ["e1", "e2"], timeline: [a, b] });
        dragTile(container, "a", "b");
        expect(orderWrites()).toEqual([[STITCH_ID, { timeline: [b, a], clipOrder: ["e2", "e1"] }]]);
      });
    });

    describe("duration badges", () => {
      /** jsdom cannot decode video: a <video> that loads, seeks and reports `duration`, and a canvas that encodes. */
      function stubMedia(duration: number) {
        const realCreate = document.createElement.bind(document);
        vi.spyOn(document, "createElement").mockImplementation(((tag: string, options?: ElementCreationOptions) => {
          if (tag === "video") {
            const video: Record<string, unknown> = { duration, videoWidth: 160, videoHeight: 90, load() {} };
            let src = "";
            Object.defineProperty(video, "src", {
              get: () => src,
              set: (value: string) => {
                src = value;
                if (value) setTimeout(() => (video.onloadedmetadata as (() => void) | null)?.());
              },
            });
            Object.defineProperty(video, "currentTime", {
              set: () => setTimeout(() => (video.onseeked as (() => void) | null)?.()),
            });
            return video;
          }
          if (tag === "canvas") {
            return { getContext: () => ({ drawImage() {} }), toDataURL: () => "data:image/jpeg;base64,AAAA" };
          }
          return realCreate(tag, options);
        }) as typeof document.createElement);
      }

      it("keeps the badges after a write that does not touch the sequence", async () => {
        stubMedia(5);
        const graph = {
          edges: twoEdges.edges,
          nodes: [
            { id: "gen1", type: "generateVideo", data: { outputVideo: "blob:video1" } },
            { id: "gen2", type: "generateVideo", data: { outputVideo: "blob:video2" } },
          ],
        };
        const props = createNodeProps({ clipOrder: ["e1", "e2"] });
        setGraph(graph, props.data);
        const { rerender } = render(<VideoStitchNode {...props} />);
        await waitFor(() => expect(screen.getAllByText("5s")).toHaveLength(2));

        const looped = { ...props.data, loopCount: 2 as const };
        setGraph(graph, looped);
        rerender(<VideoStitchNode {...props} data={looped} />);
        expect(screen.getAllByText("5s")).toHaveLength(2);
      });
    });
  });

  describe("Stitch Button", () => {
    it("should call regenerateNode when stitch button clicked", () => {
      setMockStoreState({
        edges: [
          { id: "e1", source: "gen1", target: "test-stitch-1", targetHandle: "video-0", data: { createdAt: 1 } },
          { id: "e2", source: "gen2", target: "test-stitch-1", targetHandle: "video-1", data: { createdAt: 2 } },
        ],
        nodes: [
          { id: "gen1", type: "generateVideo", data: { outputVideo: "blob:video1" } },
          { id: "gen2", type: "generateVideo", data: { outputVideo: "blob:video2" } },
        ],
      });

      render(<VideoStitchNode {...createNodeProps({ clipOrder: ["e1", "e2"] })} />);

      const stitchButton = screen.getByText("Stitch");
      expect(stitchButton).not.toBeDisabled();
      fireEvent.click(stitchButton);
      expect(mockRegenerateNode).toHaveBeenCalledWith("test-stitch-1");
    });

    it("should disable stitch button when less than 2 clips", () => {
      setMockStoreState({
        edges: [
          { id: "e1", source: "gen1", target: "test-stitch-1", targetHandle: "video-0", data: { createdAt: 1 } },
        ],
        nodes: [
          { id: "gen1", type: "generateVideo", data: { outputVideo: "blob:video1" } },
        ],
      });

      render(<VideoStitchNode {...createNodeProps({ clipOrder: ["e1"] })} />);
      expect(screen.getByText("Stitch")).toBeDisabled();
    });
  });
});
