import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkflowStore } from "@/store/workflowStore";
import type { WorkflowNode } from "@/types";
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

const selected = () => useWorkflowStore.getState().nodes.filter((n) => n.selected).map((n) => n.id);

beforeEach(() => {
  const nodes = [node("a", 0, 0, true), node("b", 400, 0, true), node("c", 800, 0)];
  useWorkflowStore.setState({ nodes, edges: [] });
  const graph = new SceneGraph(nodes, [], {});
  const index = new GridIndex(graph.nodes);
  edgeHit = -1;
  const scene = {
    graph, canvas: document.createElement("canvas"), view: { x: 0, y: 0, zoom: 1 },
    local: (event: MouseEvent) => ({ x: event.clientX, y: event.clientY }),
    toWorld: (x: number, y: number) => ({ x, y }),
    toScreen: (x: number, y: number) => ({ x, y }),
    nodeAt: (x: number, y: number) => index.at(x, y),
    nodesWithin: (x0: number, y0: number, x1: number, y1: number) => index.within(x0, y0, x1, y1),
    edgeAt: () => edgeHit,
    edgesWithin: () => [],
    capture: noop, input: noop, nodesMoved: noop,
  } as unknown as Scene;
  const live = { refresh: noop, wantOnly: noop } as unknown as LiveLayer;
  host = document.createElement("div");
  document.body.appendChild(host);
  settings = {
    navigation: defaultCanvasNavigationSettings, locked: false, disabled: false, tutorial: false,
    isValidConnection: () => true, onConnect: noop, onConnectEnd: noop, onHandleClick: noop, onNodeDragStop: noop,
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

  it("a double-click opens the add-node menu on empty canvas only, not on a connection", () => {
    edgeHit = 0;
    editor.paneDoubleClick(2000, 2000, { x: 1, y: 1 });
    expect(settings.onPaneMenu).not.toHaveBeenCalled();
    edgeHit = -1;
    editor.paneDoubleClick(2000, 2000, { x: 1, y: 1 });
    expect(settings.onPaneMenu).toHaveBeenCalledWith(1, 1);
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
