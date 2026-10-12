"use client";

/**
 * What the painter's sheet and the live layer share: real node components
 * in a real <ReactFlow> (the nodes need its context: useReactFlow, Handle,
 * useUpdateNodeInternals, useStore, useNodeId), each in its own error
 * boundary, with their floating headers.
 */
import { memo, type ComponentType } from "react";
import type { Node, NodeTypes, ReactFlowState } from "@xyflow/react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import type { HeaderActions } from "@/components/nodes/FloatingNodeHeaders";
import type { WorkflowNode } from "@/types";
import type { HandleAnchor } from "@/lib/gpuCanvas/graph";

/** Flow units above a node that its painted image takes in, for the floating header. */
export const HEADER = 30;
/** Margin on the other sides, for the node's shadow. */
export const PAD = 8;

export const noop = () => {};

export const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Wraps each node type in an error boundary, so one broken node paints as its fallback card. */
export function boundedNodeTypes(raw: NodeTypes): NodeTypes {
  return Object.fromEntries(
    Object.entries(raw).map(([type, Component]) => {
      const Node = Component as ComponentType<Record<string, unknown>>;
      const Bounded = memo((props: Record<string, unknown>) => (
        <ErrorBoundary label={type}>
          <Node {...props} />
        </ErrorBoundary>
      ));
      Bounded.displayName = `GpuCanvasNode(${type})`;
      return [type, Bounded];
    })
  ) as NodeTypes;
}

/** A store node as the sheet or live layer's React Flow takes it, at a position. */
export function flowNode(node: WorkflowNode, x: number, y: number, width: number, selected = false): Node {
  return { id: node.id, type: node.type, position: { x, y }, data: node.data as Record<string, unknown>, style: { width }, width, selected } as Node;
}

export type HeaderProps = HeaderActions & { hints?: Record<string, string> };

/** Waits until the elements' sizes are the same two frames running (or the deadline passes). */
export async function settleSizes(elements: (() => HTMLElement | null)[], until: number, cancelled: () => boolean = () => false) {
  const sizes = () => elements.map((get) => {
    const element = get();
    return element ? `${element.offsetWidth}x${element.offsetHeight}` : "";
  }).join(",");
  let previous = sizes();
  for (;;) {
    await nextFrame();
    await nextFrame();
    if (cancelled()) return;
    const current = sizes();
    if (current === previous || performance.now() > until) return;
    previous = current;
  }
}

/** Waits for React Flow to measure the nodes (it hides a node until then), then for every image in `root` to decode. */
export async function settleNodes(root: HTMLElement, ids: readonly string[], until: number, cancelled: () => boolean = () => false): Promise<{ decodeMs: number }> {
  const element = (id: string) => root.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
  for (;;) {
    const pending = ids.filter((id) => {
      const node = element(id);
      return !node || node.style.visibility === "hidden" || !node.offsetHeight;
    });
    if (!pending.length || performance.now() > until || cancelled()) break;
    await nextFrame();
  }
  const started = performance.now();
  await Promise.all([...root.querySelectorAll("img")].map((img) => (img.complete && img.naturalWidth ? undefined : img.decode().catch(noop))));
  const decodeMs = performance.now() - started;
  // A media card resizes to its image once the image has loaded (a React
  // update after onLoad), so wait until every node's size holds still.
  await settleSizes(ids.map((id) => () => element(id)), until, cancelled);
  return { decodeMs };
}

/** Each handle's anchor (where an edge meets it), relative to its node, as React Flow measured it. */
export function handleAnchors(state: ReactFlowState, id: string): Map<string, HandleAnchor> | undefined {
  const bounds = state.nodeLookup.get(id)?.internals.handleBounds;
  if (!bounds) return undefined;
  const anchors = new Map<string, HandleAnchor>();
  for (const kind of ["source", "target"] as const) {
    for (const handle of bounds[kind] ?? []) {
      const { x, y, width, height, position } = handle;
      const anchor = position === "right" ? { x: x + width, y: y + height / 2 }
        : position === "left" ? { x, y: y + height / 2 }
        : position === "top" ? { x: x + width / 2, y }
        : { x: x + width / 2, y: y + height };
      anchors.set(`${kind}:${handle.id ?? ""}`, anchor);
    }
  }
  return anchors;
}
