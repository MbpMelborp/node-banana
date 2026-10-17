import type { NodeChange, XYPosition } from "@xyflow/react";
import { useToast } from "@/components/Toast";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { blobToDataUrl } from "@/lib/assets/client/mediaBlob";
import type { FrameCapture, FrameCaptureError } from "@/lib/stitch/frameCapture";
import { frameClips, frameOptions, shownAt } from "@/lib/stitch/framePlan";
import { isPlaced, type ClipSpan, type SourceKey } from "@/lib/stitch/timeline";
import { formatTimecode } from "@/lib/stitch/timecode";
import { STACK_GAP } from "@/utils/arrangeNodes";
import { getNodeSize } from "@/utils/nodeDimensions";
import type { ImageInputNodeData, WorkflowNode } from "@/types";
import type { ClipMediaView } from "./useStitchEditorMedia";

/**
 * Frame to canvas: the frame under the editor's playhead, decoded by Render's rules (frameCapture.ts), added to the
 * canvas as an Image Input node and kept in the asset library. It reads the editor's session once, at the press,
 * and never writes to it or to the Edit Video node.
 */

/** Loaded at the first press: the decoder stays out of the editor's bundle until then. */
type FrameCaptureModule = typeof import("@/lib/stitch/frameCapture");

/** A capture that has not finished by then is given up. */
export const CAPTURE_TIMEOUT_MS = 30_000;

/** The Edit Video node as it was at the press: where its frames go if it is deleted before the capture ends. */
export interface NotedNode {
  id: string;
  position: XYPosition;
  width: number;
}

/** The last frame node each Edit Video node added, and the canvas it was added on: the next one goes under it. */
const lastFrame = new Map<string, { frameNodeId: string; generation: number }>();

export function __resetFramePlacementForTests(): void {
  lastFrame.clear();
}

/** Right of the node; under the last frame it added while that frame is still on this canvas. */
export function frameNodePosition(noted: NotedNode): XYPosition {
  const wf = useWorkflowStore.getState();
  const last = lastFrame.get(noted.id);
  const frame = last && last.generation === wf.canvasGeneration ? wf.nodes.find((n) => n.id === last.frameNodeId) : undefined;
  if (frame) return { x: frame.position.x, y: frame.position.y + getNodeSize(frame).height + STACK_GAP };
  return { x: noted.position.x + noted.width + STACK_GAP, y: noted.position.y };
}

/**
 * The frame as an Image Input node, the only one selected. addNode is the only canvas write (dimensions go in with
 * the data, not after), so one undo takes the node away; selecting pushes no undo step. The second select pass is
 * paste's: React Flow's reconciliation can re-select the nodes that were selected before.
 */
export function addFrameNode(a: {
  dataUrl: string;
  filename: string;
  size: { width: number; height: number };
  position: XYPosition;
}): string {
  const wf = useWorkflowStore.getState();
  const data: Partial<ImageInputNodeData> = { image: a.dataUrl, filename: a.filename, dimensions: { ...a.size } };
  const id = wf.addNode("imageInput", a.position, data);
  const selectOnly = () => {
    const changes: NodeChange<WorkflowNode>[] = useWorkflowStore
      .getState()
      .nodes.map((n) => ({ type: "select" as const, id: n.id, selected: n.id === id }));
    useWorkflowStore.getState().onNodesChange(changes);
  };
  selectOnly();
  requestAnimationFrame(selectOnly);
  return id;
}

/** "frame-0-04-60.png" for 4.6 s. */
export function frameFileName(t: number): string {
  return `frame-${formatTimecode(t, 2).replace(/[:.]/g, "-")}.png`;
}

/** What the toast says when a capture fails. */
export function frameErrorText(error: FrameCaptureError): string {
  const clip = error.clipNumber !== undefined ? `clip ${error.clipNumber}'s` : "a clip's";
  switch (error.kind) {
    case "empty":
      return "Nothing plays at the playhead.";
    case "crossOrigin":
      return `Can't read ${clip} video from its site: the site blocks copying, or the file is gone.`;
    case "timeout":
      return `Reading ${clip} video took too long.`;
    case "unreadable":
      return error.clipNumber !== undefined
        ? `Couldn't read clip ${error.clipNumber}'s video at the playhead.`
        : "Couldn't read the video at the playhead.";
  }
}

const UNREADABLE = "Couldn't read the video at the playhead.";
const DROPPED = "The canvas changed while the frame was being made, so it was not added.";

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/**
 * Where the frame goes. Item 3 has one target, beside the Edit Video node the editor edits; an editor not tied to a
 * node (the Edit video view) adds its own branch here, with its own position and toast.
 */
function frameTarget(): NotedNode | null {
  const nodeId = useStitchEditorStore.getState().nodeId;
  const node = nodeId ? useWorkflowStore.getState().nodes.find((n) => n.id === nodeId) : undefined;
  if (!node) return null;
  return { id: node.id, position: { ...node.position }, width: getNodeSize(node).width };
}

/**
 * The press. Pauses a playing preview and takes the frame where it stopped, then: capture (given up after
 * CAPTURE_TIMEOUT_MS) → Image Input node → asset record → toast. "dropped" when the canvas was replaced meanwhile
 * (or there is nowhere to put the frame), "failed" when the frame could not be made.
 */
export async function frameToCanvas(a: {
  spans: readonly ClipSpan[];
  media: ReadonlyMap<string, ClipMediaView>;
  size: { width: number; height: number };
}): Promise<"added" | "failed" | "dropped"> {
  const toast = useToast.getState();
  const generation = useWorkflowStore.getState().canvasGeneration;
  const noted = frameTarget();
  if (!noted) return "dropped";

  if (useStitchEditorStore.getState().playing) {
    useStitchEditorStore.getState().setPlaying(false);
    // The frame loop's last setPlayhead lands, and its cleanup runs
    await nextFrame();
    await nextFrame();
  }

  const s = useStitchEditorStore.getState();
  const draft = s.draft;
  if (!draft) return "dropped";
  const t = s.playhead;
  const layout = draft.sequenceLayout;
  const stacked = layout.mode === "stacked";
  const placed = stacked && isPlaced(draft.timeline);
  const options = frameOptions(layout, draft.timeline);
  const srcByClip = (clipId: string) => a.media.get(clipId)?.src ?? null;
  const srcBySource = new Map<SourceKey, string>();
  for (const view of a.media.values()) if (view.src && !srcBySource.has(view.key)) srcBySource.set(view.key, view.src);
  const clipNumber = new Map(draft.timeline.map((clip, i) => [clip.id, i + 1]));
  const assetOf = new Map(
    draft.timeline.flatMap((clip) => (clip.source.kind === "asset" ? [[clip.id, clip.source.assetId] as const] : [])),
  );

  let capture: FrameCapture;
  let engine: FrameCaptureModule | null = null;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("The frame took too long", "TimeoutError")),
    CAPTURE_TIMEOUT_MS,
  );
  try {
    engine = await import("@/lib/stitch/frameCapture");
    capture = await engine.captureSequenceFrame({
      clips: frameClips(draft.timeline, s.durations, srcByClip, options.placed === true),
      options,
      t,
      shown: shownAt(a.spans, t, stacked ? { crossfade: layout.crossfade, placed } : null),
      srcOf: (source) => srcBySource.get(source) ?? null,
      clipNumberOf: (clipId) => clipNumber.get(clipId) ?? 0,
      size: a.size,
      signal: controller.signal,
    });
  } catch (error) {
    if (engine && error instanceof engine.FrameCaptureError) {
      const text = frameErrorText(error);
      if (error.kind === "empty") toast.show(text, "warning");
      else toast.show(text, "error", true, error.kind === "unreadable" ? error.message : null);
    } else {
      toast.show(UNREADABLE, "error", true, error instanceof Error ? error.message : String(error));
    }
    return "failed";
  } finally {
    clearTimeout(timer);
  }

  let dataUrl: string;
  try {
    dataUrl = await blobToDataUrl(capture.blob);
  } catch (error) {
    toast.show(UNREADABLE, "error", true, error instanceof Error ? error.message : String(error));
    return "failed";
  }

  const wf = useWorkflowStore.getState();
  if (wf.canvasGeneration !== generation) {
    toast.show(DROPPED, "warning");
    return "dropped";
  }
  const node = wf.nodes.find((n) => n.id === noted.id);
  if (!node) lastFrame.delete(noted.id);
  const position = frameNodePosition(
    node ? { id: node.id, position: node.position, width: getNodeSize(node).width } : noted,
  );
  const size = { width: capture.width, height: capture.height };
  const frameNodeId = addFrameNode({ dataUrl, filename: frameFileName(t), size, position });
  if (node) lastFrame.set(noted.id, { frameNodeId, generation });

  // After the node exists, so the run's graph snapshot holds it. The image node is the producer: the agent looks up
  // an Edit Video node's results by producer, and this frame is not one of its renders
  useWorkflowStore.getState().recordUiAsset({
    kind: "image",
    origin: "edited",
    media: capture.blob,
    mime: "image/png",
    ...size,
    producer: { nodeId: frameNodeId, nodeType: "imageInput", operation: "frameGrab" },
    parameters: {
      fromNodeId: noted.id,
      atSec: t,
      slot: capture.plan.slot,
      mode: !stacked ? "track" : placed ? "placed" : "stacked",
      crossfade: layout.crossfade,
      layers: capture.drawn.map((layer) => {
        const assetId = assetOf.get(layer.clipId);
        return {
          clip: clipNumber.get(layer.clipId) ?? 0,
          ...(assetId ? { assetId } : {}),
          sourceSec: layer.sourceSec,
          weight: layer.weight,
        };
      }),
    },
  });

  toast.show("Frame added to the canvas", "success");
  return "added";
}
