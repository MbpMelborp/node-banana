import type { ComfyAppNodeData, SwitchNodeData, WorkflowEdge, WorkflowNode } from "@/types";
import { getConnectedInputsPure, getSourceOutput } from "@/store/utils/connectedInputs";
import type { StitchReadContext } from "./draft";
import { stitchVideoEdgeIds } from "./migrate";

/**
 * What feeds a Stitch node, read from the graph the way the executor reads it:
 * routers and switches followed, dimmed sources dropped.
 *
 * Selectors over these helpers must return primitives only (see
 * edgeClipSourceTuple): zustand's useShallow compares array elements with
 * Object.is, so a fresh object per call re-renders forever.
 */

/** One edge's videos, in order. A router or switch edge can carry several (a router input is multi). */
export function resolveEdgeVideos(
  nodeId: string,
  edgeId: string,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  dimmed?: Set<string>,
): string[] {
  const onlyThisEdge = edges.filter((e) => e.target !== nodeId || e.id === edgeId);
  return getConnectedInputsPure(nodeId, nodes, onlyThisEdge, undefined, dimmed).videos;
}

/** What a timeline clip of that edge plays: the edge's first video, or null when its source has none. */
export function resolveEdgeVideo(
  nodeId: string,
  edgeId: string,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  dimmed?: Set<string>,
): string | null {
  return resolveEdgeVideos(nodeId, edgeId, nodes, edges, dimmed)[0] ?? null;
}

/** The music the executor would use. */
export function stitchMusicMedia(
  nodeId: string,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  dimmed?: Set<string>,
): string | null {
  return getConnectedInputsPure(nodeId, nodes, edges, undefined, dimmed).audio[0] ?? null;
}

/**
 * Can this edge ever bring the stitch music? Read from graph state a run does not change, the way
 * getConnectedInputsPure walks it: a dimmed source, a disabled Switch output and a Conditional Switch (a gate that
 * passes no data) carry nothing; routers and switches are followed upstream. A generator (generateAudio, a Comfy app's
 * audio output) counts before it has run, so the answer does not flip when it finishes; any other source, such as an
 * Audio Input, counts only while it holds audio, because no run will fill it.
 */
function edgeCarriesMusic(
  edge: WorkflowEdge,
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
  dimmed: Set<string> | undefined,
  visited: Set<string>,
): boolean {
  if (edge.data?.isLoop || dimmed?.has(edge.source)) return false;
  const source = nodes.find((n) => n.id === edge.source);
  if (!source) return false;
  const upstream = () => {
    if (visited.has(source.id)) return false;
    visited.add(source.id);
    return edges.some((e) => e.target === source.id && edgeCarriesMusic(e, nodes, edges, dimmed, visited));
  };
  switch (source.type) {
    case "router":
      return edge.sourceHandle === "audio" && upstream();
    case "switch": {
      const data = source.data as SwitchNodeData;
      const entry = data.switches?.find((s) => s.id === edge.sourceHandle);
      return Boolean(entry?.enabled) && data.inputType === "audio" && upstream();
    }
    case "conditionalSwitch":
      return false;
    case "generateAudio":
      return true;
    case "comfyApp": {
      const output = (source.data as ComfyAppNodeData).app?.outputs.find((o) => o.id === edge.sourceHandle);
      return output?.type === "audio";
    }
    default: {
      const { type, value } = getSourceOutput(source, edge.sourceHandle, edge.data as Record<string, unknown> | undefined);
      return type === "audio" && Boolean(value);
    }
  }
}

/**
 * "Music is connected", read from the graph: a non-loop edge into the "audio" handle whose source is not dimmed.
 * Output is not consulted for sources a run fills, so the card's mute badges do not flip when the music source
 * finishes running. With `nodes`, an edge counts only if it can ever deliver music (edgeCarriesMusic): the executor
 * reads music from output, and a disabled Switch output or an empty Audio Input never gives it any, so counting them
 * would show clips muted that the encode plays with their sound.
 */
export function stitchHasMusicEdge(
  nodeId: string,
  edges: readonly WorkflowEdge[],
  dimmed?: Set<string>,
  nodes?: readonly WorkflowNode[],
): boolean {
  return edges.some(
    (e) =>
      e.target === nodeId &&
      e.targetHandle === "audio" &&
      !e.data?.isLoop &&
      !dimmed?.has(e.source) &&
      (!nodes || edgeCarriesMusic(e, nodes, edges, dimmed, new Set([nodeId]))),
  );
}

/** For the card and the editor. The executor builds its own, with hasMusic read from output. */
export function stitchReadContext(
  nodeId: string,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  dimmed?: Set<string>,
): StitchReadContext {
  return { liveEdgeIds: stitchVideoEdgeIds(nodeId, edges), hasMusic: stitchHasMusicEdge(nodeId, edges, dimmed, nodes) };
}

export interface EdgeClipSource {
  edgeId: string;
  sourceNodeId: string | null;
  media: string | null;
  videoCount: number;
}

/** Each live video edge's source node and media, keyed by edge id, in edge order. */
export function edgeClipSources(
  nodeId: string,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  dimmed?: Set<string>,
): Map<string, EdgeClipSource> {
  const sources = new Map<string, EdgeClipSource>();
  for (const edgeId of stitchVideoEdgeIds(nodeId, edges)) {
    const edge = edges.find((e) => e.id === edgeId);
    const videos = resolveEdgeVideos(nodeId, edgeId, nodes, edges, dimmed);
    sources.set(edgeId, {
      edgeId,
      sourceNodeId: edge && nodes.some((n) => n.id === edge.source) ? edge.source : null,
      media: videos[0] ?? null,
      videoCount: videos.length,
    });
  }
  return sources;
}

const TUPLE_WIDTH = 4;

/**
 * For zustand selectors: the same data as a FLAT array of primitives, [edgeId, sourceNodeId ?? "", media ?? "", String(videoCount), …].
 * useShallow compares array elements with Object.is, so a selector must return only primitives: spreading a Map, or returning
 * EdgeClipSource objects, gives fresh tuples/objects on every call and loops "Maximum update depth exceeded".
 */
export function edgeClipSourceTuple(
  nodeId: string,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  dimmed?: Set<string>,
): string[] {
  const tuple: string[] = [];
  for (const s of edgeClipSources(nodeId, nodes, edges, dimmed).values()) {
    tuple.push(s.edgeId, s.sourceNodeId ?? "", s.media ?? "", String(s.videoCount));
  }
  return tuple;
}

/** Inverse of edgeClipSourceTuple, used in a useMemo keyed on the tuple. */
export function edgeClipSourcesFromTuple(tuple: readonly string[]): Map<string, EdgeClipSource> {
  const sources = new Map<string, EdgeClipSource>();
  for (let i = 0; i + TUPLE_WIDTH <= tuple.length; i += TUPLE_WIDTH) {
    const [edgeId, sourceNodeId, media, videoCount] = tuple.slice(i, i + TUPLE_WIDTH);
    sources.set(edgeId, {
      edgeId,
      sourceNodeId: sourceNodeId || null,
      media: media || null,
      videoCount: Number(videoCount),
    });
  }
  return sources;
}
