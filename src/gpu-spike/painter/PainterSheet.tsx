"use client";

// GPU canvas spike (throwaway): the painter's sheet. A real <ReactFlow> at
// 100% holding a batch of real nodes, with their floating headers, rendered
// inside the scene's <canvas layoutsubtree>: laid out like the page, never
// shown, and painted into a texture in one call. The nodes read the real
// workflow store, as they do on the canvas.
import { startTransition, useLayoutEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ReactFlow, ReactFlowProvider, type Node } from "@xyflow/react";
import { rawNodeTypes } from "@/components/WorkflowCanvas";
import { FloatingNodeHeaders } from "@/components/nodes/FloatingNodeHeaders";
import { NODE_TITLES } from "@/lib/nodes/handles";

/** Flow units above a node that its painted image takes in, for the floating header. */
export const HEADER = 30;
/** Margin on the other sides, for the node's shadow. */
export const PAD = 8;

const noop = () => {};

export function nodeTitle(node: Node): string {
  const data = node.data as Record<string, { displayName?: string; name?: string } | undefined> & { app?: { name?: string } };
  if (["nanoBanana", "generateVideo", "generate3d", "generateAudio"].includes(node.type ?? "") && data.selectedModel?.displayName) return data.selectedModel.displayName;
  if (node.type === "llmGenerate") {
    const model = data.selectedLLMModel || data.selectedModel;
    if (model?.displayName) return model.displayName;
    if (model?.name) return model.name;
  }
  if (node.type === "comfyApp") return data.app?.name || "";
  return NODE_TITLES[node.type || ""] || "Node";
}

// Transitions and animations would be painted mid-way.
const SHEET_STYLE = `
  [data-gpu-spike-sheet] *, [data-gpu-spike-sheet] *::before, [data-gpu-spike-sheet] *::after { transition: none !important; animation: none !important; }
  [data-gpu-spike-sheet] .react-flow__pane, [data-gpu-spike-sheet] .react-flow__renderer { background: transparent !important; }
`;

function Sheet({ nodes, onCommit }: { nodes: Node[]; onCommit: () => void }) {
  useLayoutEffect(onCommit, [nodes, onCommit]);
  return (
    <ReactFlowProvider>
      <style>{SHEET_STYLE}</style>
      <ReactFlow nodes={nodes} edges={[]} nodeTypes={rawNodeTypes} defaultViewport={{ x: 0, y: 0, zoom: 1 }} minZoom={1} maxZoom={1}
        nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} panOnDrag={false} zoomOnScroll={false} panOnScroll={false}
        zoomOnDoubleClick={false} preventScrolling={false} proOptions={{ hideAttribution: true }} style={{ background: "transparent" }}>
        <FloatingNodeHeaders nodes={nodes} getNodeTitle={nodeTitle} onCustomTitleChange={noop} onCommentChange={noop} onRunNode={noop}
          onExpandNode={noop} onBrowse={noop} onToggleOptional={noop} onOpenFallback={noop} />
      </ReactFlow>
    </ReactFlowProvider>
  );
}

function SheetHost({ api }: { api: SheetHandle }) {
  const [state, setState] = useState<{ nodes: Node[]; done: () => void }>({ nodes: [], done: noop });
  useLayoutEffect(() => { api.set = next => startTransition(() => setState(next)); }, [api]);
  return <Sheet nodes={state.nodes} onCommit={state.done} />;
}

interface SheetHandle { set: (next: { nodes: Node[]; done: () => void }) => void }

const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

/** Waits until the elements' sizes are the same two frames running (or the deadline passes). */
export async function settleSizes(elements: (() => HTMLElement | null)[], until: number) {
  const sizes = () => elements.map(get => { const element = get(); return element ? `${element.offsetWidth}x${element.offsetHeight}` : ""; }).join(",");
  let previous = sizes();
  for (;;) {
    await nextFrame();
    await nextFrame();
    const current = sizes();
    if (current === previous || performance.now() > until) return;
    previous = current;
  }
}

export class PainterSheet {
  readonly element: HTMLDivElement;
  private root: Root;
  private handle: SheetHandle = { set: noop };

  constructor(canvas: HTMLCanvasElement, readonly width: number, readonly height: number) {
    this.element = document.createElement("div");
    this.element.dataset.gpuSpikeSheet = "";
    // Laid out at its size; never takes the pointer from the scene.
    this.element.style.cssText = `position:absolute;left:0;top:0;width:${width}px;height:${height}px;pointer-events:none;contain:strict;`;
    this.element.inert = true;
    canvas.appendChild(this.element);
    this.root = createRoot(this.element);
    this.root.render(<SheetHost api={this.handle} />);
  }

  /** Renders the nodes and resolves once React has committed them. */
  render(nodes: Node[]): Promise<void> {
    return new Promise(resolve => this.handle.set({ nodes, done: resolve }));
  }

  /** Resolves once React Flow has measured every node (it hides a node until then) and every image has decoded. */
  async settle(ids: string[], timeoutMs = 5000): Promise<{ decodeMs: number }> {
    const until = performance.now() + timeoutMs;
    for (;;) {
      const pending = ids.filter(id => {
        const element = this.nodeElement(id);
        return !element || element.style.visibility === "hidden" || !element.offsetHeight;
      });
      if (!pending.length || performance.now() > until) break;
      await nextFrame();
    }
    const started = performance.now();
    await Promise.all([...this.element.querySelectorAll("img")].map(img => img.complete && img.naturalWidth ? undefined : img.decode().catch(noop)));
    const decodeMs = performance.now() - started;
    // A media card resizes to its image once the image has loaded (a React
    // update after onLoad), so wait until every node's size holds still.
    await settleSizes(ids.map(id => () => this.nodeElement(id)), until);
    return { decodeMs };
  }

  nodeElement(id: string): HTMLElement | null {
    return this.element.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
  }

  dispose() {
    this.root.unmount();
    this.element.remove();
  }
}
