import { useEffect, useMemo } from "react";
import { useShallow } from "zustand/shallow";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { useStitchMediaInfo, type StitchMediaEntry } from "@/hooks/useStitchMediaInfo";
import { assetFileUrl } from "@/lib/assets/client/api";
import { nodeKindLabel, nodeModelLabel } from "@/lib/stitch/labels";
import { assetMediaKey, mediaKeyOf } from "@/lib/stitch/mediaInfo";
import { stitchVideoEdgeIds } from "@/lib/stitch/migrate";
import { edgeClipSourcesFromTuple, edgeClipSourceTuple, stitchMusicEdge, stitchMusicMedia } from "@/lib/stitch/sources";
import { sourceKey, type SourceKey } from "@/lib/stitch/timeline";
import { formatSeconds } from "@/lib/stitch/timecode";
import type { AudioInputNodeData, WorkflowEdge, WorkflowNode } from "@/types";

/**
 * What the editor shows for each clip of its draft, read live from the
 * workflow store (whether a source has run, and what it holds) and from the
 * shared media cache (length, size, rate, frames). Nothing here is written
 * to node data; the durations go to the editor's own store.
 */

export interface ClipMediaView {
  clipId: string;
  key: SourceKey;
  /** What a <video> plays: the source's output, or the library file. null: the source has not run. */
  src: string | null;
  mediaKey: string | null;
  status: "empty" | "loading" | "ready" | "error";
  /** D, the source's full length. */
  duration: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  frames: ReadonlyArray<string | null>;
  sourceNodeId: string | null;
  /** Label bar: the model ("Veo 3.1"), else the node's kind ("Ease curve"); "Library" for a library clip. */
  sourceLabel: string;
  /** "Generate video · Veo 3.1 · 5.00 s". */
  railSubtitle: string;
}

export interface MusicView {
  src: string | null;
  mediaKey: string | null;
  fileName: string;
  sourceLabel: string;
  sourceNodeId: string | null;
}

const NO_FRAMES: ReadonlyArray<string | null> = [];
const EMPTY: string[] = [];
const LABEL_WIDTH = 3;

/**
 * The labels of each node feeding a live video edge, as primitives, [nodeId, kind, model, …], for a useShallow
 * selector beside edgeClipSourceTuple (which carries the edges' media).
 */
function sourceLabelTuple(nodeId: string, nodes: WorkflowNode[], edges: WorkflowEdge[]): string[] {
  const tuple: string[] = [];
  const seen = new Set<string>();
  const live = new Set(stitchVideoEdgeIds(nodeId, edges));
  for (const edge of edges) {
    if (!live.has(edge.id) || seen.has(edge.source)) continue;
    const node = nodes.find((n) => n.id === edge.source);
    if (!node) continue;
    seen.add(node.id);
    tuple.push(node.id, nodeKindLabel(node), nodeModelLabel(node) ?? "");
  }
  return tuple;
}

/** The music edge's source node, as primitives: [nodeId, file name, kind]. The edge is found by the shared rule. */
function musicSourceTuple(nodeId: string, nodes: WorkflowNode[], edges: WorkflowEdge[], dimmed?: Set<string>): string[] {
  const edge = stitchMusicEdge(nodeId, edges, dimmed, nodes);
  const node = edge ? nodes.find((n) => n.id === edge.source) : undefined;
  if (!node) return EMPTY;
  const fileName = node.type === "audioInput" ? (node.data as AudioInputNodeData).filename : null;
  return [node.id, fileName || "Audio", nodeKindLabel(node)];
}

export function useStitchEditorMedia(): { byClip: ReadonlyMap<string, ClipMediaView>; music: MusicView | null } {
  const nodeId = useStitchEditorStore((s) => s.nodeId);
  const timeline = useStitchEditorStore((s) => s.draft?.timeline);
  const setDurations = useStitchEditorStore((s) => s.setDurations);

  const edgeTuple = useWorkflowStore(
    useShallow((s) => (nodeId ? edgeClipSourceTuple(nodeId, s.nodes, s.edges, s.dimmedNodeIds) : EMPTY)),
  );
  const labelTuple = useWorkflowStore(useShallow((s) => (nodeId ? sourceLabelTuple(nodeId, s.nodes, s.edges) : EMPTY)));
  const musicMedia = useWorkflowStore((s) =>
    nodeId ? stitchMusicMedia(nodeId, s.nodes, s.edges, s.dimmedNodeIds) : null,
  );
  const musicTuple = useWorkflowStore(
    useShallow((s) => (nodeId ? musicSourceTuple(nodeId, s.nodes, s.edges, s.dimmedNodeIds) : EMPTY)),
  );

  const edgeViews = useMemo(() => {
    const labels = new Map<string, { kind: string; model: string | null }>();
    for (let i = 0; i + LABEL_WIDTH <= labelTuple.length; i += LABEL_WIDTH) {
      const [sourceNodeId, kind, model] = labelTuple.slice(i, i + LABEL_WIDTH);
      labels.set(sourceNodeId, { kind, model: model || null });
    }
    const views = new Map<string, { sourceNodeId: string | null; media: string | null; kind: string; model: string | null }>();
    for (const source of edgeClipSourcesFromTuple(edgeTuple).values()) {
      const label = source.sourceNodeId ? labels.get(source.sourceNodeId) : undefined;
      views.set(source.edgeId, {
        sourceNodeId: source.sourceNodeId,
        media: source.media,
        kind: label?.kind ?? "",
        model: label?.model ?? null,
      });
    }
    return views;
  }, [edgeTuple, labelTuple]);

  // Where each clip's video is read from
  const sources = useMemo(
    () =>
      (timeline ?? []).map((clip) => {
        if (clip.source.kind === "asset") {
          const assetId = clip.source.assetId;
          return { clip, src: assetFileUrl(assetId), mediaKey: assetMediaKey(assetId), edge: null };
        }
        const edge = edgeViews.get(clip.source.edgeId) ?? null;
        const src = edge?.media ?? null;
        return { clip, src, mediaKey: src ? mediaKeyOf(src) : null, edge };
      }),
    [timeline, edgeViews],
  );

  const entries = useMemo(() => {
    const seen = new Map<string, StitchMediaEntry>();
    for (const { src, mediaKey } of sources) if (src && mediaKey) seen.set(mediaKey, { key: mediaKey, src });
    return [...seen.values()];
  }, [sources]);
  const infos = useStitchMediaInfo(entries, "filmstrip");

  const byClip = useMemo(() => {
    const views = new Map<string, ClipMediaView>();
    for (const { clip, src, mediaKey, edge } of sources) {
      const info = mediaKey ? infos.get(mediaKey) : undefined;
      const duration = info?.status === "ready" ? info.duration : null;
      // An edge clip whose edge went away while the editor was open is still a video, not a library clip
      const kind = clip.source.kind === "asset" ? "Library" : edge?.kind || "Video";
      const model = edge?.model ?? null;
      views.set(clip.id, {
        clipId: clip.id,
        key: sourceKey(clip.source),
        src,
        mediaKey,
        status: !src ? "empty" : (info?.status ?? "loading"),
        duration,
        width: info?.width ?? null,
        height: info?.height ?? null,
        fps: info?.fps ?? null,
        frames: info?.frames ?? NO_FRAMES,
        sourceNodeId: edge?.sourceNodeId ?? null,
        sourceLabel: model ?? kind,
        railSubtitle: [kind, model, duration !== null ? formatSeconds(duration) : null].filter(Boolean).join(" · "),
      });
    }
    return views;
  }, [sources, infos]);

  // The ready lengths go to the store, where the timeline maths reads them; only when they change
  useEffect(() => {
    const next = new Map<SourceKey, number>();
    for (const view of byClip.values()) if (view.duration !== null) next.set(view.key, view.duration);
    const current = useStitchEditorStore.getState().durations;
    const same = current.size === next.size && [...next].every(([key, value]) => current.get(key) === value);
    if (!same) setDurations(next);
  }, [byClip, setDurations]);

  const music = useMemo<MusicView | null>(() => {
    if (musicTuple.length === 0 && !musicMedia) return null;
    const [sourceNodeId, fileName, kind] = musicTuple;
    return {
      src: musicMedia,
      mediaKey: musicMedia ? mediaKeyOf(musicMedia) : null,
      fileName: fileName ?? "Audio",
      sourceLabel: kind ?? "Audio",
      sourceNodeId: sourceNodeId ?? null,
    };
  }, [musicTuple, musicMedia]);

  return { byClip, music };
}
