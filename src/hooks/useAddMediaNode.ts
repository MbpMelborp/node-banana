"use client";

import { useCallback } from "react";
import { useReactFlow, type XYPosition } from "@xyflow/react";
import { useWorkflowStore } from "@/store/workflowStore";
import { defaultNodeDimensions } from "@/store/utils/nodeDefaults";

export interface AddMediaNodeOptions {
  kind: "image" | "video";
  src: string;
  filename: string;
  /** Where the node's top-left goes, in flow coordinates (a drop point). */
  position?: XYPosition;
}

/**
 * Put a piece of media on the canvas as an input node, at `position` or the
 * middle of the viewport (nudged off anything already there), selected. What
 * "Add to graph" in the media viewer does, for the history and the output
 * gallery, and what dropping a history item on the canvas does.
 */
export function useAddMediaNode() {
  const { screenToFlowPosition, setNodes } = useReactFlow();
  const addNode = useWorkflowStore((state) => state.addNode);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);

  return useCallback(
    ({ kind, src, filename, position: at }: AddMediaNodeOptions): string => {
      const type = kind === "video" ? "videoInput" : "imageInput";
      let position = at;
      if (!position) {
        const { width, height } = defaultNodeDimensions[type];
        const centre = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
        position = { x: centre.x - width / 2, y: centre.y - height / 2 };
      }
      const id =
        kind === "video"
          ? addNode("videoInput", position, { video: src, filename })
          : addNode("imageInput", position, { image: src, filename });

      if (kind === "image" && typeof Image !== "undefined") {
        const img = new Image();
        img.onload = () => updateNodeData(id, { dimensions: { width: img.width, height: img.height } });
        img.src = src;
      }

      setNodes((nodes) => nodes.map((node) => ({ ...node, selected: node.id === id })));
      return id;
    },
    [screenToFlowPosition, setNodes, addNode, updateNodeData],
  );
}
