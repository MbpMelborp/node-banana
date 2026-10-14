import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useWorkflowStore } from "@/store/workflowStore";
import { useAssetStore } from "@/store/assetStore";
import type { WorkflowNode } from "@/types";
import { defaultCanvasNavigationSettings } from "@/types/canvas";
import { SceneGraph } from "@/lib/gpuCanvas/graph";
import type { Scene } from "@/lib/gpuCanvas/scene";
import { Editor, type GpuEditing } from "../editor";
import type { LiveLayer } from "../LiveLayer";

function node(id: string, x: number, y: number, selected = false): WorkflowNode {
  return { id, type: "prompt", position: { x, y }, data: { prompt: "" }, width: 300, selected } as unknown as WorkflowNode;
}

const noop = () => {};
const editing: GpuEditing = {
  navigation: defaultCanvasNavigationSettings,
  locked: false,
  disabled: false,
  tutorial: false,
  isValidConnection: () => true,
  onConnect: noop,
  onReconnect: noop,
  onConnectEnd: noop,
  onHandleClick: noop,
  onNodeDragStop: noop,
  onPaneClick: noop,
  onPaneMenu: noop,
  onEdgeClick: noop,
  onEdgeContextMenu: noop,
};

let editor: Editor;
let host: HTMLDivElement;
let settings: GpuEditing;

function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = window) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

const ids = (filter: (n: WorkflowNode) => boolean) => useWorkflowStore.getState().nodes.filter(filter).map((n) => n.id);

beforeEach(() => {
  const nodes = [node("a", 0, 0, true), node("b", 400, 0)];
  useWorkflowStore.setState({ nodes, edges: [] });
  useAssetStore.setState({ appView: "canvas" });
  const graph = new SceneGraph(nodes, [], {});
  const canvas = document.createElement("canvas");
  const scene = { graph, canvas, nodesMoved: noop, onViewChanged: () => noop, onLayoutChanged: () => noop } as unknown as Scene;
  const live = { refresh: noop } as unknown as LiveLayer;
  host = document.createElement("div");
  document.body.appendChild(host);
  settings = { ...editing };
  editor = new Editor(scene, live, host, () => settings);
});

afterEach(() => {
  editor.dispose();
  host.remove();
  document.body.innerHTML = "";
});

describe("the GPU canvas's keys", () => {
  it("deletes the selection with Delete alone, even with a menu open, but not with a modifier or inside .nokey", () => {
    press("Delete", { shiftKey: true });
    press("Backspace", { metaKey: true });
    expect(ids(() => true)).toEqual(["a", "b"]);

    const toolbar = document.createElement("div");
    toolbar.className = "nokey";
    const button = document.createElement("button");
    toolbar.appendChild(button);
    document.body.appendChild(toolbar);
    press("Backspace", {}, button);
    expect(ids(() => true)).toEqual(["a", "b"]);

    const listbox = document.createElement("div");
    listbox.setAttribute("role", "listbox");
    document.body.appendChild(listbox);
    expect(press("Delete").defaultPrevented).toBe(true);
    expect(ids(() => true)).toEqual(["b"]);
  });

  it("deletes while the navigator lock is on, but not under a dialog", () => {
    settings = { ...editing, locked: true };
    press("Delete");
    expect(ids(() => true)).toEqual(["b"]);
    useWorkflowStore.setState({ nodes: [node("a", 0, 0, true)] });
    settings = { ...editing, disabled: true };
    press("Delete");
    expect(ids(() => true)).toEqual(["a"]);
  });

  it("moves the selection 5px with an arrow key and 20px with Shift, unless locked", () => {
    expect(press("ArrowRight").defaultPrevented).toBe(true);
    press("ArrowDown", { shiftKey: true });
    const moved = useWorkflowStore.getState().nodes;
    expect(moved[0].position).toEqual({ x: 5, y: 20 });
    expect(moved[1].position).toEqual({ x: 400, y: 0 });
    settings = { ...editing, locked: true };
    expect(press("ArrowLeft").defaultPrevented).toBe(false);
    expect(useWorkflowStore.getState().nodes[0].position).toEqual({ x: 5, y: 20 });
  });

  it("leaves arrow keys to a focused field", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    press("ArrowRight", {}, input);
    expect(useWorkflowStore.getState().nodes[0].position).toEqual({ x: 0, y: 0 });
  });

  it("selects a focused live node with Enter and unselects it with Escape", () => {
    const layer = document.createElement("div");
    layer.setAttribute("data-gpu-canvas-live", "");
    const wrapper = document.createElement("div");
    wrapper.className = "react-flow__node react-flow__node-prompt";
    wrapper.setAttribute("data-id", "b");
    wrapper.tabIndex = 0;
    layer.appendChild(wrapper);
    host.appendChild(layer);
    wrapper.focus();
    press("Enter", {}, wrapper);
    expect(ids((n) => !!n.selected)).toEqual(["b"]);
    press("Escape", {}, wrapper);
    expect(ids((n) => !!n.selected)).toEqual([]);
  });
});
