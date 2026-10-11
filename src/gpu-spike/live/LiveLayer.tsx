"use client";

// GPU canvas spike (throwaway): the live layer. Real React nodes (a real
// <ReactFlow> with the scene's viewport) over the scene for the hovered node,
// selected nodes and every visible node above 100% zoom. A node's painted
// image stays in the scene until its live component has been measured and
// its images decoded; only then is the scene's copy hidden, so the swap shows
// no gap.
import { useLayoutEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ReactFlow, ReactFlowProvider, useReactFlow, type Node } from "@xyflow/react";
import { rawNodeTypes } from "@/components/WorkflowCanvas";
import { FloatingNodeHeaders } from "@/components/nodes/FloatingNodeHeaders";
import { useWorkflowStore } from "@/store/workflowStore";
import type { Scene, View } from "../scene/Scene";
import type { SceneGraph } from "../scene/graph";
import { recordTiming, type SpikeApi } from "../instrumentation";
import { nodeTitle, settleSizes } from "../painter/PainterSheet";

const noop = () => {};
const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

// The pane must not take the pointer: pans and drags on empty space go to the scene.
const LIVE_STYLE = `
  [data-gpu-spike-live] .react-flow__pane, [data-gpu-spike-live] .react-flow__renderer, [data-gpu-spike-live] .react-flow { pointer-events: none !important; background: transparent !important; }
  [data-gpu-spike-live] .react-flow__node { pointer-events: all; }
`;

interface Handle { setNodes: (nodes: Node[]) => void; setView: (view: View) => void; committed: () => void }

function ViewSync({ handle }: { handle: Handle }) {
  const flow = useReactFlow();
  useLayoutEffect(() => { handle.setView = view => { void flow.setViewport(view); }; }, [flow, handle]);
  return null;
}

function Live({ handle, initialView }: { handle: Handle; initialView: View }) {
  const [nodes, setNodes] = useState<Node[]>([]);
  useLayoutEffect(() => { handle.setNodes = setNodes; }, [handle]);
  useLayoutEffect(() => { handle.committed(); }, [nodes, handle]);
  return (
    <ReactFlowProvider>
      <style>{LIVE_STYLE}</style>
      <ReactFlow nodes={nodes} edges={[]} nodeTypes={rawNodeTypes} defaultViewport={initialView} minZoom={0.01} maxZoom={4}
        nodesDraggable={false} nodesConnectable={false} panOnDrag={false} zoomOnScroll={false} panOnScroll={false} zoomOnPinch={false}
        zoomOnDoubleClick={false} preventScrolling={false} proOptions={{ hideAttribution: true }} style={{ background: "transparent" }}>
        <ViewSync handle={handle} />
        <FloatingNodeHeaders nodes={nodes} getNodeTitle={nodeTitle} onCustomTitleChange={noop} onCommentChange={noop} onRunNode={noop}
          onExpandNode={noop} onBrowse={noop} onToggleOptional={noop} onOpenFallback={noop} />
      </ReactFlow>
    </ReactFlowProvider>
  );
}

export class LiveLayer {
  readonly element: HTMLDivElement;
  private root: Root;
  private handle: Handle = { setNodes: noop, setView: noop, committed: noop };
  /** Nodes asked to be live, and why. */
  private wanted = new Map<number, Set<string>>();
  /** Nodes whose live component is on screen and whose scene image is hidden. */
  readonly live = new Set<number>();
  private generation = 0;
  private pending: Promise<void> = Promise.resolve();

  /** Resolves once the latest change of live nodes has finished swapping. */
  settled() { return this.pending; }

  constructor(host: HTMLElement, private scene: Scene, private graph: SceneGraph, private api: SpikeApi) {
    this.element = document.createElement("div");
    this.element.dataset.gpuSpikeLive = "";
    this.element.style.cssText = "position:absolute;inset:0;pointer-events:none;";
    host.appendChild(this.element);
    // Wheel over a live node still pans and zooms the scene.
    this.element.addEventListener("wheel", event => scene.wheel(event), { passive: false });
    // A press on a live node's body drags it through the scene, as on the canvas; its fields and buttons keep it.
    this.element.addEventListener("pointerdown", event => {
      const target = event.target as Element;
      if (!target.closest(".react-flow__node") || target.closest("input, textarea, select, button, [contenteditable='true'], .nodrag, .react-flow__handle")) return;
      scene.pointerDown(event);
    }, true);
    this.root = createRoot(this.element);
    this.root.render(<Live handle={this.handle} initialView={{ ...scene.view }} />);
  }

  setView(view: View) { this.handle.setView({ ...view }); }

  /** Adds or removes a reason for a node to be live ("hover", "selected", "zoom", "test"). */
  want(i: number, reason: string, on: boolean) {
    const reasons = this.wanted.get(i) ?? new Set<string>();
    if (on) reasons.add(reason); else reasons.delete(reason);
    if (reasons.size) this.wanted.set(i, reasons); else this.wanted.delete(i);
    this.pending = this.sync();
  }

  /** Replaces one reason's set of nodes. */
  wantOnly(reason: string, nodes: Iterable<number>) {
    const next = new Set(nodes);
    for (const [i, reasons] of this.wanted) if (reasons.has(reason) && !next.has(i)) { reasons.delete(reason); if (!reasons.size) this.wanted.delete(i); }
    for (const i of next) (this.wanted.get(i) ?? this.wanted.set(i, new Set()).get(i)!).add(reason);
    this.pending = this.sync();
  }

  /** Resolves when every wanted node is live and every other node is back in the scene. */
  private async sync() {
    const generation = ++this.generation;
    const started = performance.now();
    const wanted = [...this.wanted.keys()];
    const store = useWorkflowStore.getState();
    const byId = new Map(store.nodes.map(node => [node.id, node]));
    const nodes: Node[] = wanted.map(i => {
      const n = this.graph.nodes[i], source = byId.get(n.id);
      return { id: n.id, type: n.type, position: { x: n.x, y: n.y }, data: (source?.data ?? {}) as Record<string, unknown>, style: { width: n.w }, width: n.w,
        selected: this.scene.selected.has(i) } as Node;
    });
    await new Promise<void>(resolve => { this.handle.committed = resolve; this.handle.setNodes(nodes); });
    // Leaving nodes: back in the scene at once (their image never went away).
    for (const i of [...this.live]) if (!this.wanted.has(i)) { this.live.delete(i); this.scene.setHidden(i, false); }
    const entering = wanted.filter(i => !this.live.has(i));
    if (!entering.length) return;
    // Wait for React Flow to measure them and their images to decode.
    const until = performance.now() + 3000;
    for (;;) {
      const pending = entering.filter(i => {
        const element = this.nodeElement(this.graph.nodes[i].id);
        return !element || element.style.visibility === "hidden" || !element.offsetHeight;
      });
      if (!pending.length || performance.now() > until) break;
      await nextFrame();
      if (generation !== this.generation) return;
    }
    await Promise.all([...this.element.querySelectorAll("img")].map(img => img.complete && img.naturalWidth ? undefined : img.decode().catch(noop)));
    await settleSizes(entering.map(i => () => this.nodeElement(this.graph.nodes[i].id)), until);
    if (generation !== this.generation) return;
    for (const i of entering) {
      if (!this.wanted.has(i)) continue;
      this.live.add(i);
      this.scene.setHidden(i, true);
    }
    recordTiming(this.api, "live.swapMs", performance.now() - started);
  }

  nodeElement(id: string): HTMLElement | null {
    return this.element.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
  }

  dispose() {
    this.root.unmount();
    this.element.remove();
  }
}
