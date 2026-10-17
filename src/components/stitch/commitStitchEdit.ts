import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { draftPatch, readSequenceLayout, readStitchDraft, sameDraft, sameLayout, type StitchDraft } from "@/lib/stitch/draft";
import { stitchVideoEdgeIds } from "@/lib/stitch/migrate";
import { stitchReadContext } from "@/lib/stitch/sources";
import { edgeIdsInOrder } from "@/lib/stitch/timeline";
import type { VideoStitchNodeData } from "@/types";

export type CommitResult = "closed" | "written" | "gone";
export type SaveResult = "saved" | "unchanged" | "gone";

/**
 * Done. Writes the draft to the node and closes the editor; it does not
 * encode. "closed" when nothing changed, so a legacy node stays legacy.
 */
export function commitStitchEdit(): CommitResult {
  const written = writeStitchEdit();
  useStitchEditorStore.getState().close();
  return written === "gone" ? "gone" : written === "unchanged" ? "closed" : "written";
}

/**
 * Save (the header's Save, ⌘S, File › Save): Done's write with the editor
 * left open. What was written becomes the editor's starting point, so
 * Cancel keeps it and asks only about edits made since. The workflow file
 * is the save request's to write; this only puts the edit in the node first.
 */
export function saveStitchEdit(): SaveResult {
  const written = writeStitchEdit();
  const s = useStitchEditorStore.getState();
  if (written === "gone") {
    s.close();
    return "gone";
  }
  if (written === "unchanged") return "unchanged";
  s.markSaved(written);
  return "saved";
}

/**
 * Writes the draft to the node in one updateNodeData, and returns what it
 * wrote.
 *
 * - The node is gone, or the canvas was replaced: writes nothing ("gone").
 * - Nothing changed: writes nothing ("unchanged").
 * - Otherwise: an edge whose every clip the user removed is
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
function writeStitchEdit(): StitchDraft | "unchanged" | "gone" {
  const s = useStitchEditorStore.getState();
  const wf = useWorkflowStore.getState();
  const nodeId = s.nodeId;
  const node = nodeId ? wf.nodes.find((n) => n.id === nodeId && n.type === "videoStitch") : undefined;
  if (!nodeId || !node || !s.draft || !s.initial || wf.canvasGeneration !== s.canvasGeneration) return "gone";

  const live = stitchVideoEdgeIds(nodeId, wf.edges);
  const referencedAtOpen = new Set(edgeIdsInOrder(s.initial.timeline));
  const referencedNow = new Set(edgeIdsInOrder(s.draft.timeline));
  const orphaned = live.filter((id) => referencedAtOpen.has(id) && !referencedNow.has(id));

  if (orphaned.length === 0 && sameDraft(s.initial, s.draft)) return "unchanged";

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
  return draft;
}
