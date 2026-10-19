"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { formatFps } from "@/lib/stitch/labels";
import { DEFAULT_SEQUENCE_LAYOUT } from "@/lib/stitch/stack";
import { isPlaced, layoutSpans, spansEnd } from "@/lib/stitch/timeline";
import type { StitchAudioClip, StitchTimelineClip } from "@/types";
import type { PreviewLayerSource } from "./EditorStage";
import { GEOMETRY } from "./editorStyles";
import { useTimelineZoom } from "./timeline/useTimelineZoom";
import { usePlayableUrls } from "./usePlayableUrls";
import { useSequencePlayback, type AudioPlaybackClip } from "./useSequencePlayback";
import { useStitchEditorMedia, type StitchEditorMediaOptions } from "./useStitchEditorMedia";

const DEFAULT_ASPECT = 16 / 9;
const EMPTY_TIMELINE: StitchTimelineClip[] = [];
const NO_AUDIO: StitchAudioClip[] = [];

/** Everything the editor's body and its header read: the open session's media, layout, playback and zoom. */
export type EditorComposition = ReturnType<typeof useEditorComposition>;

/**
 * The open session's sequence as the editor shows and plays it, shared by the
 * node's dialog and the Edit video view. `rootRef` is the editor's column and
 * `chromePx` the height of what sits above the stage in it (the dialog's
 * header): the timeline may take what is left once the stage keeps
 * GEOMETRY.stageFloor. `mediaOptions` names a lost library clip from an edit's file (the view's).
 */
export function useEditorComposition(
  rootRef: RefObject<HTMLElement | null>,
  chromePx: number,
  mediaOptions?: StitchEditorMediaOptions,
) {
  const timeline = useStitchEditorStore((s) => s.draft?.timeline ?? EMPTY_TIMELINE);
  const durations = useStitchEditorStore((s) => s.durations);
  const audioClips = useStitchEditorStore((s) => s.draft?.audioClips ?? NO_AUDIO);
  const layout = useStitchEditorStore((s) => s.draft?.sequenceLayout ?? DEFAULT_SEQUENCE_LAYOUT);
  const soundOn = useStitchEditorStore((s) => s.soundOn);

  const { byClip, audioByClip } = useStitchEditorMedia(mediaOptions);

  // The timeline may take what leaves the stage GEOMETRY.stageFloor (Infinity until measured)
  const [maxTimeline, setMaxTimeline] = useState(Infinity);
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      if (root.clientHeight > 0) setMaxTimeline(root.clientHeight - chromePx - GEOMETRY.stageFloor);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [rootRef, chromePx]);

  const stacked = layout.mode === "stacked";
  const crossfade = layout.crossfade;
  const placed = stacked && isPlaced(timeline);
  const spans = useMemo(() => layoutSpans(timeline, durations, layout), [timeline, durations, layout]);
  // The latest end of a clip with some length: an empty clip placed past it adds nothing to the encode
  const total = spansEnd(spans);

  // What the encode will produce: the largest ready size, and the shared rate when the clips agree.
  // Read from the spans, so a clip the encode drops (nothing left after its trim) does not count.
  const { size, frameSize, fps, aspect } = useMemo(() => {
    let width = 0;
    let height = 0;
    const rates: (number | null)[] = [];
    for (const span of spans) {
      if (span.length <= 0) continue;
      const view = byClip.get(span.clip.id);
      if (view?.status !== "ready") continue;
      width = Math.max(width, view.width ?? 0);
      height = Math.max(height, view.height ?? 0);
      rates.push(view.fps);
    }
    const known = width > 0 && height > 0;
    return {
      size: known ? `${width} × ${height}` : null,
      // Frame to canvas makes its PNG at this size, so the two never disagree
      frameSize: known ? { width, height } : null,
      fps: formatFps(rates),
      aspect: known ? width / height : DEFAULT_ASPECT,
    };
  }, [spans, byClip]);

  const rawSources = useMemo(() => {
    const srcs: string[] = [];
    for (const view of byClip.values()) if (view.src && !srcs.includes(view.src)) srcs.push(view.src);
    for (const view of audioByClip.values()) if (view.src && !srcs.includes(view.src)) srcs.push(view.src);
    return srcs;
  }, [byClip, audioByClip]);
  const playable = usePlayableUrls(rawSources);
  // Track: one element per source. Stacked: one per clip, in timeline order, since two pieces of one source can
  // show at once
  const videoLayers = useMemo(() => {
    const layers: PreviewLayerSource[] = [];
    if (stacked) {
      for (const clip of timeline) {
        const src = byClip.get(clip.id)?.src;
        const url = src ? playable.get(src) : undefined;
        if (url) layers.push({ key: clip.id, src: url });
      }
      return layers;
    }
    for (const view of byClip.values()) {
      const url = view.src ? playable.get(view.src) : undefined;
      if (url && !layers.some((layer) => layer.src === url)) layers.push({ key: url, src: url });
    }
    return layers;
  }, [stacked, timeline, byClip, playable]);
  // One element per audio clip: two pieces of one file play at their own times
  const audioUrl = useCallback(
    (clipId: string) => {
      const src = audioByClip.get(clipId)?.src;
      return src ? (playable.get(src) ?? null) : null;
    },
    [audioByClip, playable],
  );
  const audioLayers = useMemo(
    () =>
      audioClips.flatMap((clip): PreviewLayerSource[] => {
        const url = audioUrl(clip.id);
        return url ? [{ key: clip.id, src: url }] : [];
      }),
    [audioClips, audioUrl],
  );

  const srcFor = useCallback(
    (clipId: string) => {
      const src = byClip.get(clipId)?.src;
      return src ? (playable.get(src) ?? null) : null;
    },
    [byClip, playable],
  );
  const audioPlayback = useMemo(
    () => ({
      clips: audioClips.map(
        (clip): AudioPlaybackClip => ({
          id: clip.id,
          src: audioUrl(clip.id),
          startSec: clip.startSec,
          inSec: clip.inSec,
          outSec: clip.outSec,
          muted: clip.muted,
          curve: clip.curve,
        }),
      ),
    }),
    [audioClips, audioUrl],
  );
  const stack = useMemo(() => (stacked ? { crossfade, placed } : null), [stacked, crossfade, placed]);
  const { registerVideo, registerAudio, activeSrc } = useSequencePlayback({
    spans,
    total,
    srcFor,
    audio: audioPlayback,
    soundOn,
    stack,
  });

  // Any change of Track/Stacked (the toggle, ⌘Z, ⇧⌘Z) swaps every preview element: stop before the next frame
  // ticks against the ones leaving. After the playback hook, whose own layout effect hands it the new layout
  // first: the pause re-seeks the paused frame, and must do it the new layout's way.
  const shownStacked = useRef(stacked);
  useLayoutEffect(() => {
    if (shownStacked.current === stacked) return;
    shownStacked.current = stacked;
    useStitchEditorStore.getState().setPlaying(false);
  }, [stacked]);

  const zoom = useTimelineZoom(spans, stacked);

  return {
    clipCount: timeline.length,
    empty: timeline.length === 0,
    stacked,
    spans,
    total,
    size,
    frameSize,
    fps,
    aspect,
    byClip,
    audioByClip,
    videoLayers,
    audioLayers,
    srcFor,
    registerVideo,
    registerAudio,
    activeSrc,
    zoom,
    maxTimeline,
  };
}
