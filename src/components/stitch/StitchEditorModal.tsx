"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, type HTMLAttributes } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { selectIsDirty, useStitchEditorStore } from "@/store/stitchEditorStore";
import { formatFps } from "@/lib/stitch/labels";
import { DEFAULT_SEQUENCE_LAYOUT } from "@/lib/stitch/stack";
import { isPlaced, layoutSpans, spansEnd } from "@/lib/stitch/timeline";
import type { StitchTimelineClip } from "@/types";
import { commitStitchEdit } from "./commitStitchEdit";
import { DiscardSheet } from "./DiscardSheet";
import { EditorHeader } from "./EditorHeader";
import { EditorRail } from "./EditorRail";
import { EditorStage, type PreviewLayerSource } from "./EditorStage";
import { EditorTransport } from "./EditorTransport";
import { STITCH_EDITOR_PANEL } from "./editorStyles";
import { LibraryPicker } from "./library/LibraryPicker";
import { Timeline } from "./timeline/Timeline";
import { useTimelineZoom } from "./timeline/useTimelineZoom";
import { useEditorLifecycle } from "./useEditorLifecycle";
import { usePlayableUrls } from "./usePlayableUrls";
import { useSequencePlayback } from "./useSequencePlayback";
import { useStitchEditorKeys } from "./useStitchEditorKeys";
import { useStitchEditorMedia } from "./useStitchEditorMedia";

const DEFAULT_ASPECT = 16 / 9;
const EMPTY_TIMELINE: StitchTimelineClip[] = [];

/** Cancel and Escape: straight out when nothing changed, otherwise the discard sheet asks. */
function requestClose(): void {
  const s = useStitchEditorStore.getState();
  if (selectIsDirty(s)) s.setDiscardOpen(true);
  else s.close();
}

/** The marker the library picker hands focus back by (see STITCH_EDITOR_PANEL). */
const EDITOR_PANEL_PROPS = { [STITCH_EDITOR_PANEL]: "" } as HTMLAttributes<HTMLDivElement>;

/**
 * The Stitch editor: a near-full-screen dialog over the canvas, opened by
 * the node's Expand or Open editor. On the Dialog primitive inset 24px, like
 * the annotation editor, so it sits under the desktop's drag regions rather
 * than in them. Everything it edits is the editor store's draft until Done
 * writes it to the node in one step.
 */
export function StitchEditorModal() {
  const isOpen = useStitchEditorStore((s) => s.isOpen);
  if (!isOpen) return null;
  return <StitchEditor />;
}

function StitchEditor() {
  const rootRef = useRef<HTMLDivElement>(null);
  const timeline = useStitchEditorStore((s) => s.draft?.timeline ?? EMPTY_TIMELINE);
  const durations = useStitchEditorStore((s) => s.durations);
  const curve = useStitchEditorStore((s) => s.draft?.audioCurve);
  const audioMuted = useStitchEditorStore((s) => s.draft?.audioMuted ?? false);
  const layout = useStitchEditorStore((s) => s.draft?.sequenceLayout ?? DEFAULT_SEQUENCE_LAYOUT);
  const soundOn = useStitchEditorStore((s) => s.soundOn);

  useEditorLifecycle();
  useStitchEditorKeys(rootRef, requestClose);
  const { byClip, music } = useStitchEditorMedia();

  const stacked = layout.mode === "stacked";
  const crossfade = layout.crossfade;
  const placed = stacked && isPlaced(timeline);
  const spans = useMemo(() => layoutSpans(timeline, durations, layout), [timeline, durations, layout]);
  // The latest end of a clip with some length: an empty clip placed past it adds nothing to the encode
  const total = spansEnd(spans);

  // What the encode will produce: the largest ready size, and the shared rate when the clips agree.
  // Read from the spans, so a clip the encode drops (nothing left after its trim) does not count.
  const { size, fps, aspect } = useMemo(() => {
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
      fps: formatFps(rates),
      aspect: known ? width / height : DEFAULT_ASPECT,
    };
  }, [spans, byClip]);

  const rawSources = useMemo(() => {
    const srcs: string[] = [];
    for (const view of byClip.values()) if (view.src && !srcs.includes(view.src)) srcs.push(view.src);
    if (music?.src) srcs.push(music.src);
    return srcs;
  }, [byClip, music]);
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
  const musicUrl = music?.src ? (playable.get(music.src) ?? null) : null;

  const srcFor = useCallback(
    (clipId: string) => {
      const src = byClip.get(clipId)?.src;
      return src ? (playable.get(src) ?? null) : null;
    },
    [byClip, playable],
  );
  const musicPlayback = useMemo(
    () => ({ src: musicUrl, curve: curve ?? [], muted: audioMuted }),
    [musicUrl, curve, audioMuted],
  );
  const stack = useMemo(() => (stacked ? { crossfade, placed } : null), [stacked, crossfade, placed]);
  const { registerVideo, registerAudio, activeSrc } = useSequencePlayback({
    spans,
    total,
    srcFor,
    music: musicPlayback,
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

  const empty = timeline.length === 0;
  return (
    <Dialog
      open
      onClose={requestClose}
      closeOnBackdrop={false}
      closeOnEscape={false}
      stopWheel={false}
      label="Edit stitch"
      panelProps={EDITOR_PANEL_PROPS}
      className="w-[calc(100vw-48px)] max-w-none h-[calc(100vh-48px)] max-h-none bg-editor-chrome"
    >
      <div ref={rootRef} className="flex h-full min-h-0 flex-col">
        <EditorHeader
          clipCount={timeline.length}
          total={total}
          size={size}
          fps={fps}
          onCancel={requestClose}
          onDone={commitStitchEdit}
        />
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <EditorStage
              empty={empty}
              aspect={aspect}
              layers={videoLayers}
              stacked={stacked}
              activeSrc={activeSrc}
              registerVideo={registerVideo}
              musicSrc={musicUrl}
              registerAudio={registerAudio}
            />
            <EditorTransport total={total} empty={empty} zoom={zoom} />
          </div>
          <EditorRail media={byClip} music={music} total={total} />
        </div>
        <Timeline spans={spans} media={byClip} zoom={zoom} srcFor={srcFor} music={music} stacked={stacked} />
      </div>
      <DiscardSheet />
      <LibraryPicker />
    </Dialog>
  );
}
