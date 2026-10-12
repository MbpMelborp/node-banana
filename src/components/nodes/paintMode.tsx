"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useWorkflowStore } from "@/store/workflowStore";
import type { WorkflowNodeData } from "@/types";

/**
 * Painted nodes render read-only.
 *
 * The GPU canvas paints node images from the real node components, mounted
 * off screen. Some nodes save derived data when they mount (Image Resize and
 * Split Grid copy their upstream image, Array recomputes its items). A
 * painted copy must not: it would write once per paint, each write would
 * queue another paint, and the copy's view of the graph can be a batch
 * behind the live one. Inside a `PaintedNodes` tree the node's writes are
 * dropped; the live node, or the run, makes them.
 */
const PaintedContext = createContext(false);

export function PaintedNodes({ children }: { children: ReactNode }) {
  return <PaintedContext.Provider value>{children}</PaintedContext.Provider>;
}

/** True inside a painted (read-only) copy of a node. */
export function useIsPaintedNode(): boolean {
  return useContext(PaintedContext);
}

type UpdateNodeData = (nodeId: string, data: Partial<WorkflowNodeData>) => void;

const ignoreWrite: UpdateNodeData = () => {};

/** The store's `updateNodeData`, or a no-op in a painted copy. Nodes take their writer from here. */
export function useUpdateNodeData(): UpdateNodeData {
  const painted = useContext(PaintedContext);
  const update = useWorkflowStore((state) => state.updateNodeData);
  return painted ? ignoreWrite : update;
}
