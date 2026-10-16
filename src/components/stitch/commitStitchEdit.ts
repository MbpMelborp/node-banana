import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { draftPatch, readSequenceLayout, readStitchDraft, sameDraft, sameLayout } from "@/lib/stitch/draft";
import { stitchVideoEdgeIds } from "@/lib/stitch/migrate";
import { stitchReadContext } from "@/lib/stitch/sources";
import { edgeIdsInOrder } from "@/lib/stitch/timeline";
import type { VideoStitchNodeData } from "@/types";

export type CommitResult = "closed" | "written" | "gone";

/**
 * Done. Writes the draft to the node in one updateNodeData and closes the
 * editor; it does not encode.
 *
 * - The node is gone, or the canvas was replaced: closes, writes nothing ("gone").
 * - Nothing changed: closes, writes nothing, so a legacy node stays legacy ("closed").
 * - Otherwise ("written"): an edge whose every clip the user removed is
 *   disconnected (a live edge with no clip would be appended again on the
 *   next read), and the draft is reconciled once more against the edges that
 *   remain, picking up any that arrived while the editor was open. The edge
 *   removal pushes the canvas undo checkpoint and holds it for this task, so
 *   the data write joins it: one canvas undo step either way.
 *   sequenceLayout is left out when the stored value already reads as the
 *   draft's (read as non-legacy, so a legacy node with a hand-edited key gets
 *   the Track it showed): a trim does not add the key to every saved file, and
 *   a value from a newer build survives a Done that did not touch it.
 */
export function commitStitchEdit(): CommitResult {
  const s = useStitchEditorStore.getState();
  const wf = useWorkflowStore.getState();
  const nodeId = s.nodeId;
  const node = nodeId ? wf.nodes.find((n) => n.id === nodeId && n.type === "videoStitch") : undefined;
  if (!nodeId || !node || !s.draft || !s.initial || wf.canvasGeneration !== s.canvasGeneration) {
    s.close();
    return "gone";
  }

  const live = stitchVideoEdgeIds(nodeId, wf.edges);
  const referencedAtOpen = new Set(edgeIdsInOrder(s.initial.timeline));
  const referencedNow = new Set(edgeIdsInOrder(s.draft.timeline));
  const orphaned = live.filter((id) => referencedAtOpen.has(id) && !referencedNow.has(id));

  if (orphaned.length === 0 && sameDraft(s.initial, s.draft)) {
    s.close();
    return "closed";
  }

  // The card's read rule over the edges that stay (a video connected meanwhile follows the muting of the others)
  const ctx = stitchReadContext(nodeId, wf.nodes, wf.edges, wf.dimmedNodeIds);
  const orphanedIds = new Set(orphaned);
  const draft = readStitchDraft(draftPatch(s.draft), {
    ...ctx,
    liveEdgeIds: ctx.liveEdgeIds.filter((id) => !orphanedIds.has(id)),
  });

  if (orphaned.length > 0) wf.onEdgesChange(orphaned.map((id) => ({ type: "remove" as const, id })));
  const { sequenceLayout, ...patch } = draftPatch(draft);
  const stored = readSequenceLayout((node.data as VideoStitchNodeData).sequenceLayout, false);
  wf.updateNodeData(nodeId, sameLayout(stored, sequenceLayout) ? patch : { ...patch, sequenceLayout });
  s.close();
  return "written";
}
