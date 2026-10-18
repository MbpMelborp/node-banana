"use client";

import { useRef, useState } from "react";
import { ImagePlus, LoaderCircle } from "lucide-react";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { shownAt } from "@/lib/stitch/framePlan";
import { isPlaced, type ClipSpan } from "@/lib/stitch/timeline";
import { frameToCanvas } from "./frameToCanvas";
import { RailButton } from "./railParts";
import type { ClipMediaView } from "./useStitchEditorMedia";

export interface FrameButtonInput {
  /** A capture is running. */
  busy: boolean;
  clipCount: number;
  /** Some clip's video is still being read. */
  loading: boolean;
  /** Some clip is ready with a size (the header's frame size is known). */
  hasVideo: boolean;
  /** The preview shows nothing at the playhead. */
  gap: boolean;
}

/**
 * The first row that applies wins. Busy comes first, so scrubbing into a gap during a capture neither hides the
 * spinner nor sets `disabled`, which would drop focus.
 */
export function frameButtonState(input: FrameButtonInput): { enabled: boolean; busy: boolean; reason: string | null } {
  if (input.busy) return { enabled: false, busy: true, reason: "Adding the frame…" };
  if (input.clipCount === 0) return { enabled: false, busy: false, reason: "Add clips to grab a frame" };
  if (input.loading) return { enabled: false, busy: false, reason: "Waiting for the clips to load" };
  if (!input.hasVideo) return { enabled: false, busy: false, reason: "No clip has a video yet" };
  if (input.gap) return { enabled: false, busy: false, reason: "Nothing plays at the playhead" };
  return { enabled: true, busy: false, reason: null };
}

/**
 * Frame to canvas, at the foot of the rail: the same button whatever is selected. Click or Enter; Space plays, as
 * everywhere in the editor. While the preview plays the press pauses it and takes the frame where it stopped.
 */
export function FrameToCanvasButton({
  media,
  spans,
  frameSize,
}: {
  media: ReadonlyMap<string, ClipMediaView>;
  spans: readonly ClipSpan[];
  /** The sequence's frame size (the ⋯ menu's line); null while no clip is ready with one. */
  frameSize: { width: number; height: number } | null;
}) {
  const timeline = useStitchEditorStore((s) => s.draft?.timeline);
  // Re-renders only when the playhead crosses into or out of a gap
  const gap = useStitchEditorStore((s) => {
    const layout = s.draft?.sequenceLayout;
    if (!layout) return true;
    const stack = layout.mode === "stacked" ? { crossfade: layout.crossfade, placed: isPlaced(s.draft!.timeline) } : null;
    return shownAt(spans, s.playhead, stack).size === 0;
  });
  const [busy, setBusy] = useState(false);
  const running = useRef(false);

  const state = frameButtonState({
    busy,
    clipCount: timeline?.length ?? 0,
    loading: (timeline ?? []).some((clip) => media.get(clip.id)?.status === "loading"),
    hasVideo: frameSize !== null,
    gap,
  });

  const onClick = () => {
    if (running.current || !state.enabled || !frameSize) return;
    running.current = true;
    setBusy(true);
    frameToCanvas({ spans, media, size: frameSize })
      .catch((error: unknown) => console.error("[EditVideo] Frame to canvas failed:", error))
      .finally(() => {
        running.current = false;
        setBusy(false);
      });
  };

  return (
    <RailButton
      icon={
        state.busy ? (
          <LoaderCircle size={14} strokeWidth={1.75} className="animate-spin" />
        ) : (
          <ImagePlus size={14} strokeWidth={1.75} />
        )
      }
      label={state.busy ? "Adding frame…" : "Frame to canvas"}
      disabled={!state.enabled && !state.busy}
      busy={state.busy}
      title={state.reason ?? undefined}
      onClick={onClick}
    />
  );
}
