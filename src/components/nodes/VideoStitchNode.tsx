"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TriangleAlert, X } from "lucide-react";
import { NodeProps, Node } from "@xyflow/react";
import { NodeShell } from "./NodeShell";
import {
  ChipGroup,
  ControlsCard,
  EmptyState,
  Field,
  FieldRow,
  PanelButton,
  ScrubRow,
  Spinner,
  SummaryValues,
  type SocketSpec,
} from "./ui";
import { useWorkflowStore } from "@/store/workflowStore";
import { useShallow } from "zustand/shallow";
import type { VideoStitchNodeData } from "@/types";
import { readStitchDraft, type StitchReadContext } from "@/lib/stitch/draft";
import { isLegacyStitch, stitchOrderPatch } from "@/lib/stitch/migrate";
import { edgeClipSourceTuple, edgeClipSourcesFromTuple, stitchReadContext } from "@/lib/stitch/sources";
import { edgeIdsInOrder, moveClip } from "@/lib/stitch/timeline";
import { checkEncoderSupport } from "@/hooks/useStitchVideos";
import { useVideoBlobUrl } from "@/hooks/useVideoBlobUrl";
import { useVideoAutoplay } from "@/hooks/useVideoAutoplay";

type VideoStitchNodeType = Node<VideoStitchNodeData, "videoStitch">;

/** One filmstrip tile. */
interface CardClip {
  id: string;
  edgeId: string;
  videoData: string | null;
}

/** A tile's extracted frame and its source's length, kept in component state (never in node data). */
interface TileThumbnail {
  src: string;
  duration: number;
}

const OUTPUT_SOCKETS: SocketSpec[] = [{ id: "video", type: "video", label: "Output" }];
const EMPTY_HEIGHT = 120;
const LOOP_OPTIONS = [
  { value: "1", label: "1x" },
  { value: "2", label: "2x" },
  { value: "3", label: "3x" },
];

export function VideoStitchNode({ id, data, selected }: NodeProps<VideoStitchNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const [thumbnails, setThumbnails] = useState<Map<string, TileThumbnail>>(new Map());
  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const isRunning = useWorkflowStore((state) => state.isRunning);
  const removeEdge = useWorkflowStore((state) => state.removeEdge);
  const videoBlobUrl = useVideoBlobUrl(nodeData.outputVideo ?? null);
  const videoAutoplayRef = useVideoAutoplay(id, videoBlobUrl);
  const [expanded, setExpanded] = useState(true);
  const [loadedAspect, setLoadedAspect] = useState<{ src: string; aspect: number } | null>(null);

  // Check encoder support on mount
  useEffect(() => {
    if (nodeData.encoderSupported === null) {
      checkEncoderSupport().then((supported) => {
        updateNodeData(id, { encoderSupported: supported });
      });
    }
  }, [id, nodeData.encoderSupported, updateNodeData]);

  // What the card reads from the graph, as primitives so the card only
  // re-renders when the edges into it or its music connection change
  const contextTuple = useWorkflowStore(
    useShallow((state) => {
      const ctx = stitchReadContext(id, state.nodes, state.edges, state.dimmedNodeIds);
      return [ctx.hasMusic ? "music" : "", ...ctx.liveEdgeIds];
    })
  );
  const readContext = useMemo<StitchReadContext>(
    () => ({ hasMusic: contextTuple[0] === "music", liveEdgeIds: contextTuple.slice(1) }),
    [contextTuple]
  );
  // Each edge's source and video, resolved the way the executor resolves it
  const sourceTuple = useWorkflowStore(
    useShallow((state) => edgeClipSourceTuple(id, state.nodes, state.edges, state.dimmedNodeIds))
  );
  const clipSources = useMemo(() => edgeClipSourcesFromTuple(sourceTuple), [sourceTuple]);
  // Socket count follows every video edge, loops included, as before
  const videoEdgeCount = useWorkflowStore(
    (state) => state.edges.filter((e) => e.target === id && e.targetHandle?.startsWith("video-")).length
  );

  // The sequence, migrated and reconciled on read (never written just by reading).
  // Keyed on the fields it reads, so a status or output write keeps the same tiles.
  const { timeline, clipOrder, audioCurve, audioMuted, loopCount } = nodeData;
  const draft = useMemo(
    () => readStitchDraft({ timeline, clipOrder, audioCurve, audioMuted, loopCount }, readContext),
    [timeline, clipOrder, audioCurve, audioMuted, loopCount, readContext]
  );

  // Write back only when the edges changed what is stored: a legacy node keeps
  // writing clipOrder alone, a node the editor wrote gets its timeline too.
  // The draft only says when to look. The write is built from one store
  // snapshot, because the data prop catches up with the store a render after
  // the edges do, and a patch built from it would replace a newer timeline.
  const lastWrittenRef = useRef<string | null>(null);
  useEffect(() => {
    const state = useWorkflowStore.getState();
    const node = state.nodes.find((n) => n.id === id);
    if (!node) return;
    const stored = node.data as VideoStitchNodeData;
    const fresh = readStitchDraft(stored, stitchReadContext(id, state.nodes, state.edges, state.dimmedNodeIds));
    const legacy = isLegacyStitch(stored);
    let saved: string[];
    if (legacy) {
      // An older card counted loop edges into clipOrder; they are not clips, so they do not make it stale
      const loopEdgeIds = new Set(
        state.edges.filter((e) => e.target === id && e.data?.isLoop).map((e) => e.id)
      );
      saved = (Array.isArray(stored.clipOrder) ? stored.clipOrder : []).filter((edgeId) => !loopEdgeIds.has(edgeId));
    } else {
      saved = (stored.timeline ?? []).map((c) => c?.id);
    }
    const current = legacy ? edgeIdsInOrder(fresh.timeline) : fresh.timeline.map((c) => c.id);
    if (current.length === saved.length && current.every((v, i) => v === saved[i])) return;

    // Skip a sequence this card already wrote. Undo can restore the data from
    // before that write; every reader reconciles on read, so leaving it is
    // harmless, while writing again would put a new step on the undo stack
    // each time and Undo could never get past it.
    const key = current.join("\n");
    if (lastWrittenRef.current === key) return;
    lastWrittenRef.current = key;
    updateNodeData(id, stitchOrderPatch(stored, fresh.timeline));
  }, [draft, id, updateNodeData]);

  // The card's tiles: the sequence's edge clips, with their media
  const orderedClips = useMemo<CardClip[]>(
    () =>
      draft.timeline.flatMap((clip) => {
        if (clip.source.kind !== "edge") return [];
        const source = clipSources.get(clip.source.edgeId);
        return [{ id: clip.id, edgeId: clip.source.edgeId, videoData: source?.media ?? null }];
      }),
    [draft.timeline, clipSources]
  );

  // Stable key that only changes when clip edges or video data actually change
  const clipKey = useMemo(
    () => orderedClips.map((c) => `${c.id}:${c.videoData ? c.videoData.slice(-20) : "0"}`).join(","),
    [orderedClips]
  );

  // Ref-based cache so the effect doesn't read stale `thumbnails` state
  const thumbnailsRef = useRef<Map<string, TileThumbnail>>(new Map());
  // Fingerprint cache: clip id -> last-20-chars of videoData, used to detect which clips changed
  const thumbnailFingerprintsRef = useRef<Map<string, string>>(new Map());

  // Extract thumbnails from connected videos
  useEffect(() => {
    let cancelled = false;
    let activeVideo: HTMLVideoElement | null = null;
    let activeBlobUrl: string | null = null;

    const cleanupVideo = (video: HTMLVideoElement, blobUrl?: string | null) => {
      video.onloadedmetadata = null;
      video.onerror = null;
      video.onseeked = null;
      video.src = "";
      video.load();
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };

    const extractThumbnails = async () => {
      const newThumbnails = new Map<string, TileThumbnail>();
      const newFingerprints = new Map<string, string>();

      for (const clip of orderedClips) {
        if (cancelled) return;
        if (!clip.videoData) continue;

        const fingerprint = clip.videoData.slice(-20);
        newFingerprints.set(clip.id, fingerprint);

        // Reuse cached thumbnail if the video data hasn't changed
        const cachedFingerprint = thumbnailFingerprintsRef.current.get(clip.id);
        if (cachedFingerprint === fingerprint && thumbnailsRef.current.has(clip.id)) {
          newThumbnails.set(clip.id, thumbnailsRef.current.get(clip.id)!);
          continue;
        }

        const video = document.createElement("video");
        activeVideo = video;
        activeBlobUrl = null;
        // Convert data URLs to blob URLs for metadata loading efficiency
        // (avoids re-parsing the full base64 payload into the element).
        let blobUrl: string | null = null;
        if (clip.videoData.startsWith("data:")) {
          try {
            const blob = await (await fetch(clip.videoData)).blob();
            if (cancelled) return;
            blobUrl = URL.createObjectURL(blob);
            activeBlobUrl = blobUrl;
          } catch {
            blobUrl = null;
          }
        }
        try {
          video.src = blobUrl ?? clip.videoData;
          video.crossOrigin = "anonymous";
          video.muted = true;
          video.preload = "metadata";

          await new Promise<void>((resolve, reject) => {
            video.onloadedmetadata = () => resolve();
            video.onerror = () => reject(new Error("Failed to load video"));
          });

          if (cancelled) { cleanupVideo(video, blobUrl); return; }

          const seekTime = video.duration * 0.25;
          video.currentTime = seekTime;

          await Promise.race([
            new Promise<void>((resolve) => {
              video.onseeked = () => resolve();
            }),
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error("Seek timeout")), 10_000)
            ),
          ]);

          if (cancelled) { cleanupVideo(video, blobUrl); return; }

          const canvas = document.createElement("canvas");
          const thumbWidth = 160;
          const rawAspectRatio = video.videoHeight > 0 ? video.videoWidth / video.videoHeight : 0;
          const aspectRatio = Number.isFinite(rawAspectRatio) && rawAspectRatio > 0 ? rawAspectRatio : 16 / 9;
          canvas.width = thumbWidth;
          canvas.height = Math.round(thumbWidth / aspectRatio);
          const ctx = canvas.getContext("2d");
          if (!ctx) { cleanupVideo(video, blobUrl); continue; }

          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          newThumbnails.set(clip.id, { src: canvas.toDataURL("image/jpeg", 0.7), duration: video.duration });
        } catch (error) {
          console.warn(`Failed to extract thumbnail for clip ${clip.id}:`, error);
        }
        cleanupVideo(video, blobUrl);
        activeVideo = null;
        activeBlobUrl = null;
      }

      if (!cancelled) {
        thumbnailsRef.current = newThumbnails;
        thumbnailFingerprintsRef.current = newFingerprints;
        setThumbnails(newThumbnails);
      }
    };

    extractThumbnails();
    return () => {
      cancelled = true;
      if (activeVideo) {
        cleanupVideo(activeVideo, activeBlobUrl);
        activeVideo = null;
        activeBlobUrl = null;
      }
    };
  }, [clipKey]); // eslint-disable-line react-hooks/exhaustive-deps -- orderedClips accessed via closure, clipKey is the stable dep

  // Pointer-based drag reorder (HTML5 drag doesn't work inside React Flow nodes)
  const [draggedClipId, setDraggedClipId] = useState<string | null>(null);
  const [hoverClipId, setHoverClipId] = useState<string | null>(null);

  const handlePointerDown = useCallback((e: React.PointerEvent, clipId: string) => {
    // Only left mouse button
    if (e.button !== 0) return;
    e.stopPropagation();
    setDraggedClipId(clipId);
    setHoverClipId(null);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!draggedClipId) return;
    // Find which clip element the pointer is over
    const elementsUnder = document.elementsFromPoint(e.clientX, e.clientY);
    for (const el of elementsUnder) {
      const clipEl = (el as HTMLElement).closest("[data-clip-id]") as HTMLElement | null;
      if (clipEl) {
        const targetId = clipEl.dataset.clipId!;
        if (targetId !== draggedClipId) {
          setHoverClipId(targetId);
        }
        return;
      }
    }
    setHoverClipId(null);
  }, [draggedClipId]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    // Always release pointer capture to prevent capture leak
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch { /* element may have been removed */ }

    if (!draggedClipId || !hoverClipId || draggedClipId === hoverClipId) {
      setDraggedClipId(null);
      setHoverClipId(null);
      return;
    }

    const draggedIndex = draft.timeline.findIndex((c) => c.id === draggedClipId);
    const targetIndex = draft.timeline.findIndex((c) => c.id === hoverClipId);

    if (draggedIndex !== -1 && targetIndex !== -1) {
      const moved = moveClip(draft.timeline, draggedIndex, targetIndex);
      if (moved !== draft.timeline) updateNodeData(id, stitchOrderPatch(nodeData, moved));
    }

    setDraggedClipId(null);
    setHoverClipId(null);
  }, [draggedClipId, hoverClipId, draft.timeline, nodeData, id, updateNodeData]);

  const handleRemoveClip = useCallback(
    (edgeId: string) => {
      removeEdge(edgeId);
    },
    [removeEdge]
  );

  const handleStitch = useCallback(() => {
    regenerateNode(id);
  }, [id, regenerateNode]);

  // Dynamic video input sockets: one per connected clip plus a free slot.
  const inputSockets = useMemo<SocketSpec[]>(() => {
    const count = Math.max(videoEdgeCount + 1, 2);
    const sockets: SocketSpec[] = Array.from({ length: count }, (_, i) => ({
      id: `video-${i}`,
      type: "video",
      label: `Video ${i + 1}`,
    }));
    sockets.push({ id: "audio", type: "audio", label: "Audio" });
    return sockets;
  }, [videoEdgeCount]);

  const encoderChecking = nodeData.encoderSupported === null;
  const encoderUnsupported = nodeData.encoderSupported === false;
  const encoderReady = !encoderChecking && !encoderUnsupported;
  const showOutput = encoderReady && Boolean(nodeData.outputVideo) && nodeData.status !== "loading";

  const media = showOutput
    ? { kind: "aspect" as const, aspect: loadedAspect?.src === nodeData.outputVideo ? loadedAspect.aspect : 16 / 9 }
    : { kind: "fixed" as const, height: EMPTY_HEIGHT };

  const filmstrip = (
    <div className="overflow-y-auto nowheel grid grid-cols-4 content-start gap-1.5 p-1.5 bg-well rounded-well squircle shadow-well max-h-[140px]">
      {orderedClips.map((clip) => {
        const thumbnail = thumbnails.get(clip.id);
        return (
          <div
            key={clip.id}
            data-clip-id={clip.id}
            onPointerDown={(e) => handlePointerDown(e, clip.id)}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            className={`nodrag relative w-full aspect-video bg-neutral-800 border rounded cursor-move transition-colors group ${
              draggedClipId === clip.id
                ? "opacity-50 border-blue-500"
                : hoverClipId === clip.id && draggedClipId
                  ? "border-blue-400 ring-1 ring-blue-400/50"
                  : "border-neutral-600 hover:border-neutral-500"
            }`}
          >
            {thumbnail ? (
              <img src={thumbnail.src} alt={`Clip ${clip.edgeId}`} className="w-full h-full object-cover rounded" />
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <Spinner size={14} className="text-neutral-500" />
              </div>
            )}
            {thumbnail?.duration ? (
              <div className="absolute bottom-1 right-1 bg-black/70 px-1 py-0.5 rounded text-[8px] text-white">
                {Math.round(thumbnail.duration)}s
              </div>
            ) : null}
            <button
              onClick={() => handleRemoveClip(clip.edgeId)}
              className="absolute top-0.5 right-0.5 w-4 h-4 bg-red-600/80 hover:bg-red-500 rounded text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
              title="Disconnect"
            >
              <X size={10} strokeWidth={2} />
            </button>
          </div>
        );
      })}
    </div>
  );

  return (
    <NodeShell
      id={id}
      selected={selected}
      isExecuting={isRunning}
      hasError={nodeData.status === "error"}
      media={media}
      inputs={inputSockets}
      outputs={OUTPUT_SOCKETS}
      minWidth={300}
      mediaClassName="group"
      gap={showOutput ? <ScrubRow videoRef={videoAutoplayRef} src={videoBlobUrl} className="w-full" /> : undefined}
      controls={
        <ControlsCard
          id={id}
          summary={{
            title: `${orderedClips.length} clip${orderedClips.length === 1 ? "" : "s"}`,
            values: <SummaryValues items={[`loop ${nodeData.loopCount || 1}x`]} />,
          }}
          expanded={expanded}
          onToggle={() => setExpanded((v) => !v)}
        >
          {orderedClips.length > 0 ? (
            <FieldRow className="h-auto">
              <div className="w-full">{filmstrip}</div>
            </FieldRow>
          ) : (
            <span className="text-node text-neutral-500 py-1">No clips connected</span>
          )}
          <Field label="Loop">
            <ChipGroup
              value={String(nodeData.loopCount || 1)}
              options={LOOP_OPTIONS}
              onChange={(v) => updateNodeData(id, { loopCount: Number(v) as 1 | 2 | 3 })}
            />
          </Field>
          <FieldRow className="justify-end">
            <PanelButton
              primary
              onClick={handleStitch}
              disabled={orderedClips.length < 2 || nodeData.status === "loading" || isRunning}
            >
              {nodeData.status === "loading" ? "Processing..." : "Stitch"}
            </PanelButton>
          </FieldRow>
        </ControlsCard>
      }
    >
      {encoderUnsupported ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center px-4 bg-neutral-900/40">
          <TriangleAlert size={32} strokeWidth={1.5} className="text-neutral-500" />
          <span className="text-xs text-neutral-400">Your browser doesn&apos;t support video encoding.</span>
          <a
            href="https://discord.com/invite/89Nr6EKkTf"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] text-blue-400 hover:text-blue-300 underline"
          >
            Doesn&apos;t seem right? Message Willie on Discord.
          </a>
        </div>
      ) : encoderChecking ? (
        <div className="absolute inset-0 flex items-center justify-center gap-2 text-neutral-400 bg-neutral-900/40">
          <Spinner />
          <span className="text-xs">Checking encoder...</span>
        </div>
      ) : showOutput ? (
        <>
          <video
            ref={videoAutoplayRef}
            src={videoBlobUrl ?? undefined}
            loop
            muted
            playsInline
            className="absolute inset-0 w-full h-full object-cover"
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              if (v.videoWidth > 0 && v.videoHeight > 0 && nodeData.outputVideo) {
                setLoadedAspect({ src: nodeData.outputVideo, aspect: v.videoWidth / v.videoHeight });
              }
            }}
          />
          <button
            onClick={() => updateNodeData(id, { outputVideo: null, status: "idle" })}
            className="absolute top-1 right-1 w-5 h-5 bg-neutral-900/80 hover:bg-red-600/80 rounded flex items-center justify-center text-neutral-400 hover:text-white transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
            title="Clear video"
          >
            <X size={12} strokeWidth={2} />
          </button>
        </>
      ) : (
        <EmptyState message={orderedClips.length === 0 ? "Connect videos to stitch" : "Stitch to preview"} />
      )}

      {encoderReady && nodeData.status === "loading" && (
        <div className="absolute inset-0 bg-neutral-900/70 flex flex-col items-center justify-center gap-2">
          <Spinner size={24} className="text-white" />
          <span className="text-white text-xs">Processing... {Math.round(nodeData.progress)}%</span>
        </div>
      )}
    </NodeShell>
  );
}
