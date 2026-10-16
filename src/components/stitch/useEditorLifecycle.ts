import { useEffect } from "react";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { useWorkflowStore, type WorkflowStore } from "@/store/workflowStore";

/**
 * Closes the editor, writing nothing, when what it edits goes away under it:
 * the canvas is replaced (load, clear, tab switch) or the node is deleted
 * (an agent's graph ops can do that while the dialog is up).
 */
export function useEditorLifecycle(): void {
  const isOpen = useStitchEditorStore((s) => s.isOpen);
  useEffect(() => {
    if (!isOpen) return;
    const check = (wf: Pick<WorkflowStore, "canvasGeneration" | "nodes">) => {
      const { nodeId, canvasGeneration, isOpen: open, close } = useStitchEditorStore.getState();
      if (!open) return;
      const gone = !wf.nodes.some((n) => n.id === nodeId && n.type === "videoStitch");
      if (gone || wf.canvasGeneration !== canvasGeneration) close();
    };
    check(useWorkflowStore.getState());
    return useWorkflowStore.subscribe(check);
  }, [isOpen]);
}
