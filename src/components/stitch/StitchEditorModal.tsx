"use client";

import { useCallback, useMemo, useRef } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { selectIsDirty, useStitchEditorStore } from "@/store/stitchEditorStore";
import { formatFps } from "@/lib/stitch/labels";
import { clipSpans } from "@/lib/stitch/timeline";
import type { StitchTimelineClip } from "@/types";
import { commitStitchEdit } from "./commitStitchEdit";
import { DiscardSheet } from "./DiscardSheet";
import { EditorHeader } from "./EditorHeader";
import { EditorRail } from "./EditorRail";
import { EditorStage } from "./EditorStage";
import { EditorTransport } from "./EditorTransport";
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
  const soundOn = useStitchEditorStore((s) => s.soundOn);

  useEditorLifecycle();
  useStitchEditorKeys(rootRef, requestClose);
  const { byClip, music } = useStitchEditorMedia();

  const spans = useMemo(() => clipSpans(timeline, durations), [timeline, durations]);
  const total = spans.length > 0 ? spans[spans.length - 1].end : 0;

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
  const videoSources = useMemo(() => {
    const urls: string[] = [];
    for (const view of byClip.values()) {
      const url = view.src ? playable.get(view.src) : undefined;
      if (url && !urls.includes(url)) urls.push(url);
    }
    return urls;
  }, [byClip, playable]);
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
  const { registerVideo, registerAudio, activeSrc } = useSequencePlayback({
    spans,
    total,
    srcFor,
    music: musicPlayback,
    soundOn,
  });

  const empty = timeline.length === 0;
  return (
    <Dialog
      open
      onClose={requestClose}
      closeOnBackdrop={false}
      closeOnEscape={false}
      stopWheel={false}
      label="Edit stitch"
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
              sources={videoSources}
              activeSrc={activeSrc}
              registerVideo={registerVideo}
              musicSrc={musicUrl}
              registerAudio={registerAudio}
            />
            <EditorTransport total={total} empty={empty} />
          </div>
          <EditorRail media={byClip} />
        </div>
      </div>
      <DiscardSheet />
    </Dialog>
  );
}
