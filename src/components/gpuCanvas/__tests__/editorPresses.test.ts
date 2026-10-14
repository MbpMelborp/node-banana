import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkflowStore } from "@/store/workflowStore";
import type { WorkflowEdge, WorkflowNode } from "@/types";
import { defaultCanvasNavigationSettings } from "@/types/canvas";
import { GridIndex, SceneGraph } from "@/lib/gpuCanvas/graph";
import type { Scene } from "@/lib/gpuCanvas/scene";
import { Editor, type GpuEditing } from "../editor";
import { pressGoesToScene, type LiveLayer } from "../LiveLayer";

function node(id: string, x: number, y: number, selected = false): WorkflowNode {
  return { id, type: "prompt", position: { x, y }, data: { prompt: "" }, width: 300, height: 200, selected } as unknown as WorkflowNode;
}

const noop = () => {};
let editor: Editor;
let host: HTMLDivElement;
let settings: GpuEditing;
let edgeHit: number;
let stems: { segment: number[]; width: number }[];

/** A pointer event at a css point (the fake scene's css and flow coordinates are the same). */
function pointer(x: number, y: number, init: MouseEventInit = {}) {
  return new MouseEvent("pointerdown", { clientX: x, clientY: y, button: 0, ...init }) as unknown as PointerEvent;
}

function click(x: number, y: number, init: MouseEventInit = {}) {
  const gesture = editor.press(pointer(x, y, init));
  gesture?.up(pointer(x, y, init));
}

function drag(from: [number, number], to: [number, number], init: MouseEventInit = {}) {
  const gesture = editor.press(pointer(...from, init));
  gesture?.move(pointer(...to, init));
  gesture?.up(pointer(...to, init));
}

const selectedEdges = () => useWorkflowStore.getState().edges.filter((e) => e.selected).map((e) => e.id);
const frame = () => host.querySelector<HTMLElement>("[data-gpu-canvas-selection-frame]")!;
const selected = () => useWorkflowStore.getState().nodes.filter((n) => n.selected).map((n) => n.id);

beforeEach(() => {
  const nodes = [node("a", 0, 0, true), node("b", 400, 0, true), node("c", 800, 0)];
  // A connection whose route runs along y = 1000, below the nodes.
  const edges = [{ id: "ac", source: "a", target: "c", sourceHandle: "text", targetHandle: "text" } as WorkflowEdge];
  useWorkflowStore.setState({ nodes, edges, edgeMenuAnchor: null });
  const graph = new SceneGraph(nodes, edges, {});
  const index = new GridIndex(graph.nodes);
  edgeHit = -1;
  stems = [];
  const scene = {
    graph, canvas: document.createElement("canvas"), view: { x: 0, y: 0, zoom: 1 },
    local: (event: MouseEvent) => ({ x: event.clientX, y: event.clientY }),
    toWorld: (x: number, y: number) => ({ x, y }),
    toScreen: (x: number, y: number) => ({ x, y }),
    nodeAt: (x: number, y: number) => index.at(x, y),
    nodesWithin: (x0: number, y0: number, x1: number, y1: number) => index.within(x0, y0, x1, y1),
    edgeAt: () => edgeHit,
    edgesWithin: () => [0],
    edgeRoute: () => ({ segments: [[0, 1000, 400, 1000, 800, 1000, 1200, 1000]], stems }),
    capture: noop, input: noop, nodesMoved: noop, setHeldEdge: noop, panGesture: () => ({ move: noop, up: noop, cancel: noop }),
    onViewChanged: () => noop, onLayoutChanged: () => noop,
  } as unknown as Scene;
  const live = { refresh: noop, wantOnly: noop, live: new Set<string>() } as unknown as LiveLayer;
  host = document.createElement("div");
  document.body.appendChild(host);
  settings = {
    navigation: defaultCanvasNavigationSettings, locked: false, disabled: false, tutorial: false,
    isValidConnection: () => true, onConnect: noop, onReconnect: noop, onConnectEnd: noop, onHandleClick: noop, onNodeDragStop: noop,
    onPaneClick: vi.fn(), onPaneMenu: vi.fn(), onEdgeClick: noop, onEdgeContextMenu: noop,
  };
  editor = new Editor(scene, live, host, () => settings);
});

afterEach(() => {
  editor.dispose();
  host.remove();
});

describe("presses on the GPU canvas", () => {
  it("a click on empty canvas in select mode clears the selection and is a pane click", () => {
    click(2000, 2000, { shiftKey: true });
    expect(selected()).toEqual([]);
    expect(settings.onPaneClick).toHaveBeenCalledTimes(1);
  });

  it("a drag on empty canvas in select mode still selects by marquee", () => {
    drag([780, -20], [1200, 400], { shiftKey: true });
    expect(selected()).toEqual(["c"]);
    expect(settings.onPaneClick).not.toHaveBeenCalled();
  });

  it("a plain click on a member of a multi-selection keeps the selection; Shift takes it out", () => {
    click(100, 100);
    expect(selected()).toEqual(["a", "b"]);
    click(900, 100);
    expect(selected()).toEqual(["c"]);
    editor.clickNode("a", true);
    expect(selected()).toEqual(["a", "c"]);
    editor.clickNode("a", true);
    expect(selected()).toEqual(["c"]);
  });

  it("a marquee replaces the selection: over empty canvas it leaves none, across a connection it takes that one", () => {
    drag([2000, 2000], [2100, 2100], { shiftKey: true });
    expect(selected()).toEqual([]);
    expect(selectedEdges()).toEqual([]);
    editor.selectNodes(["a", "b"], false);
    drag([500, 950], [600, 1050], { shiftKey: true });
    expect(selected()).toEqual([]);
    expect(selectedEdges()).toEqual(["ac"]);
    expect(useWorkflowStore.getState().edgeMenuAnchor?.edgeId).toBe("ac");
  });

  it("Shift+click on a connection while nodes are selected changes nothing", () => {
    settings.onEdgeClick = vi.fn();
    edgeHit = 0;
    click(500, 1000, { shiftKey: true });
    expect(selected()).toEqual(["a", "b"]);
    expect(selectedEdges()).toEqual([]);
    expect(settings.onEdgeClick).not.toHaveBeenCalled();
  });

  it("a click on a handle selects its node and opens the handle menu", () => {
    settings.onHandleClick = vi.fn();
    useWorkflowStore.getState().onEdgesChange([{ type: "select", id: "ac", selected: true }]);
    editor["scene"].graph.nodes[2].handles = new Map([["source:text", { x: 300, y: 100 }]]);
    click(1100, 100);
    expect(selected()).toEqual(["c"]);
    expect(selectedEdges()).toEqual([]);
    expect(settings.onHandleClick).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "c", handleId: "text", type: "source" }));
  });

  it("a marquee that takes nodes frames them until a click", () => {
    drag([-20, -20], [750, 250], { shiftKey: true });
    expect(selected()).toEqual(["a", "b"]);
    expect(frame().style.display).toBe("block");
    expect([frame().style.left, frame().style.top, frame().style.width, frame().style.height]).toEqual(["0px", "0px", "700px", "200px"]);
    // Taking a node out of the selection reframes the rest.
    editor.selectNodes(["b"], true);
    expect(frame().style.display).toBe("block");
    useWorkflowStore.getState().onNodesChange([{ type: "select", id: "a", selected: false }]);
    expect(frame().style.display).toBe("none");
    drag([-20, -20], [750, 250], { shiftKey: true });
    expect(frame().style.display).toBe("block");
    click(2000, 2000, { shiftKey: true });
    expect(frame().style.display).toBe("none");
  });

  it("a marquee across only a bundle's stem takes the connection that draws it", () => {
    useWorkflowStore.getState().onNodesChange([{ type: "select", id: "a", selected: false }, { type: "select", id: "b", selected: false }]);
    stems = [{ segment: [300, 1500, 320, 1500, 340, 1500, 360, 1500], width: 4 }];
    drag([310, 1450], [350, 1550], { shiftKey: true });
    expect(selectedEdges()).toEqual(["ac"]);
  });

  it("on a locked canvas a pane click keeps the selection and a connection click still moves its toolbar", () => {
    settings = { ...settings, locked: true, onEdgeClick: vi.fn() };
    click(2000, 2000);
    expect(selected()).toEqual(["a", "b"]);
    expect(settings.onPaneClick).toHaveBeenCalledTimes(1);
    edgeHit = 0;
    click(500, 1000);
    expect(selected()).toEqual(["a", "b"]);
    expect(selectedEdges()).toEqual([]);
    expect(settings.onEdgeClick).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: "ac" }));
  });

  it("with the selection key held a drag from a handle draws a marquee; without it, it starts a connection", () => {
    useWorkflowStore.getState().onNodesChange([{ type: "select", id: "a", selected: false }, { type: "select", id: "b", selected: false }]);
    editor["scene"].graph.nodes[2].handles = new Map([["source:text", { x: 300, y: 200 }]]);
    settings.onConnectEnd = vi.fn();
    // From the handle at the card's corner back across the card.
    drag([1100, 200], [780, -20], { shiftKey: true });
    expect(settings.onConnectEnd).not.toHaveBeenCalled();
    expect(selected()).toEqual(["c"]);
    // jsdom has no hit testing: nothing under the dropped wire.
    document.elementsFromPoint ??= () => [];
    drag([1100, 200], [1300, 300]);
    expect(settings.onConnectEnd).toHaveBeenCalledTimes(1);
  });

  it("a marquee's start stays on the same canvas spot when the view pans under it", () => {
    useWorkflowStore.getState().onNodesChange([{ type: "select", id: "a", selected: false }, { type: "select", id: "b", selected: false }]);
    const scene = editor["scene"] as unknown as Record<string, unknown>;
    let panX = 0;
    const listeners = new Set<() => void>();
    Object.assign(scene, {
      toWorld: (x: number, y: number) => ({ x: x - panX, y }),
      toScreen: (x: number, y: number) => ({ x: x + panX, y }),
      onViewChanged: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    });
    // Around "a" only.
    const gesture = editor.press(pointer(-20, -20, { shiftKey: true }))!;
    gesture.move(pointer(320, 250, { shiftKey: true }));
    expect(selected()).toEqual(["a"]);
    // The view pans 500px left: the box now reaches past "b", its start still left of "a".
    panX = -500;
    for (const listener of listeners) listener();
    expect(selected()).toEqual(["a", "b"]);
    gesture.up(pointer(320, 250, { shiftKey: true }));
    expect(listeners.size).toBe(0);
  });

  it("a right-click on a painted handle is not the pane's: no add-node menu, the browser's own menu", () => {
    editor["scene"].graph.nodes[2].handles = new Map([["source:text", { x: 300, y: 100 }]]);
    const event = new MouseEvent("contextmenu", { clientX: 1102, clientY: 100, cancelable: true });
    editor.contextMenu(event);
    expect(settings.onPaneMenu).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("a double-click opens the add-node menu on empty canvas only, not on a connection", () => {
    edgeHit = 0;
    editor.paneDoubleClick(2000, 2000, { x: 1, y: 1 });
    expect(settings.onPaneMenu).not.toHaveBeenCalled();
    edgeHit = -1;
    editor.paneDoubleClick(2000, 2000, { x: 1, y: 1 });
    expect(settings.onPaneMenu).toHaveBeenCalledWith(1, 1);
  });
});

describe("connection ends on the GPU canvas", () => {
  beforeEach(() => {
    useWorkflowStore.getState().onNodesChange([{ type: "select", id: "a", selected: false }, { type: "select", id: "b", selected: false }]);
    const nodes = editor["scene"].graph.nodes;
    nodes[0].handles = new Map([["source:text", { x: 300, y: 100, position: "right" }]]);
    nodes[1].handles = new Map([["target:text", { x: 0, y: 100, position: "left" }]]);
    nodes[2].handles = new Map([["target:text", { x: 0, y: 100, position: "left" }]]);
    // jsdom has no hit testing: no live handle under the pointer.
    document.elementsFromPoint ??= () => [];
  });

  it("a drag from a connection's end moves that end to another handle, the connection hidden meanwhile", () => {
    settings.onReconnect = vi.fn();
    const held: number[] = [];
    (editor["scene"] as unknown as Record<string, unknown>).setHeldEdge = (e: number) => held.push(e);
    // c's input is at x = 800; its reconnect anchor is 10 to the left of it.
    drag([788, 100], [400, 100]);
    expect(settings.onReconnect).toHaveBeenCalledWith(expect.objectContaining({ id: "ac" }), { source: "a", sourceHandle: "text", target: "b", targetHandle: "text" });
    expect(held).toEqual([0, -1]);
  });

  it("a click on a connection's end selects the connection; dropped on nothing it goes to handleConnectEnd from the other end", () => {
    settings.onConnectEnd = vi.fn();
    click(788, 100);
    expect(selectedEdges()).toEqual(["ac"]);
    drag([788, 100], [2000, 2000]);
    expect(settings.onConnectEnd).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ fromHandle: { id: "text", type: "source" } }), null);
  });

  it("a wire dropped on a socket just outside a node's box names that node", () => {
    settings.onConnectEnd = vi.fn();
    // The image wire is refused at the socket, so the drop falls to handleConnectEnd.
    settings.isValidConnection = () => false;
    drag([300, 100], [795, 100]);
    expect(settings.onConnectEnd).toHaveBeenCalledWith(expect.anything(), expect.anything(), "c");
  });
});

describe("pressGoesToScene", () => {
  it("sends a node's body and handles to the scene, and keeps its fields and buttons", () => {
    document.body.innerHTML = `<div class="react-flow__node"><div id="body"><button id="button"><span id="label"></span></button><div class="react-flow__handle nodrag" id="handle"></div><textarea id="field"></textarea></div></div>`;
    const at = (id: string) => document.getElementById(id)!;
    expect(pressGoesToScene(at("body"))).toBe(true);
    expect(pressGoesToScene(at("handle"))).toBe(true);
    expect(pressGoesToScene(at("label"))).toBe(false);
    expect(pressGoesToScene(at("field"))).toBe(false);
  });
});
