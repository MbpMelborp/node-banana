"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Film } from "lucide-react";
import { cn } from "@/components/nodes/ui/cn";

/** Room left around the frame on its limiting axis. */
const STAGE_PADDING = 32;

/** A preview element: one per source in Track, one per clip in Stacked. */
export interface PreviewLayerSource {
  /** What the playback registers it by: the URL in Track, the clip id in Stacked. */
  key: string;
  src: string;
}

/**
 * One <video>, with a ref callback that keeps its identity while its key does. Track shows the active one by class;
 * Stacked leaves it hidden by class and the playback writes its inline opacity.
 */
function PreviewVideo({
  layerKey,
  src,
  active,
  stacked,
  registerVideo,
}: {
  layerKey: string;
  src: string;
  active: boolean;
  stacked: boolean;
  registerVideo: (key: string, el: HTMLVideoElement | null) => void;
}) {
  const ref = useCallback((el: HTMLVideoElement | null) => registerVideo(layerKey, el), [registerVideo, layerKey]);
  return (
    <video
      ref={ref}
      src={src}
      preload="auto"
      playsInline
      className={cn(
        "absolute inset-0 h-full w-full object-contain",
        stacked ? "opacity-0" : active ? "opacity-100" : "opacity-0",
      )}
    />
  );
}

/**
 * The preview: the sequence letterboxed on the stage, contain-fitted to the
 * output's aspect. In Track one <video> per source is mounted and the one
 * under the playhead is shown; in Stacked one per clip, in row order, and
 * the playback works their opacities out in that order (each clip's share
 * of the picture does not depend on which one paints last).
 * useSequencePlayback drives them. The music plays from a hidden <audio>.
 * An editor with no clips shows the empty state instead.
 */
export function EditorStage({
  empty,
  aspect,
  layers,
  stacked,
  activeSrc,
  registerVideo,
  musicSrc,
  registerAudio,
}: {
  empty: boolean;
  /** width / height of the output; 16:9 when no clip has a size yet. */
  aspect: number;
  /** Track: one per distinct playable URL. Stacked: one per clip with a playable URL, in timeline order. */
  layers: ReadonlyArray<PreviewLayerSource>;
  stacked: boolean;
  activeSrc: string | null;
  registerVideo: (key: string, el: HTMLVideoElement | null) => void;
  musicSrc: string | null;
  registerAudio: (el: HTMLAudioElement | null) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);

  // Measured by observation, not getBoundingClientRect: the dialog opens with a scale transform
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => setBox({ width: stage.clientWidth, height: stage.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  let frame: { width: number; height: number } | null = null;
  if (box) {
    const width = Math.max(0, box.width - STAGE_PADDING * 2);
    const height = Math.max(0, box.height - STAGE_PADDING * 2);
    frame = width / height > aspect ? { width: height * aspect, height } : { width, height: width / aspect };
  }

  return (
    <div ref={stageRef} className="relative flex min-h-0 flex-1 items-center justify-center bg-editor-stage">
      {empty ? (
        <div className="flex max-w-[392px] flex-col items-center gap-1.5 px-10 text-center">
          <Film size={22} strokeWidth={1.5} className="text-neutral-600" aria-hidden="true" />
          <p className="mt-1 text-xs font-medium text-neutral-300">No clips yet</p>
          <p className="text-[11px] leading-[15px] text-neutral-500">
            Connect videos to the node&apos;s inputs on the canvas. They line up here in socket order.
          </p>
        </div>
      ) : (
        <div
          data-testid="stitch-preview"
          className="relative overflow-hidden rounded-media bg-black ring-1 ring-white/6"
          style={frame ? { width: frame.width, height: frame.height } : { width: "100%", aspectRatio: aspect }}
        >
          {layers.map((layer) => (
            <PreviewVideo
              key={layer.key}
              layerKey={layer.key}
              src={layer.src}
              active={layer.src === activeSrc}
              stacked={stacked}
              registerVideo={registerVideo}
            />
          ))}
        </div>
      )}
      {/* Keyed by its URL: a new source is a new element, which the playback starts afresh */}
      {musicSrc && <audio key={musicSrc} ref={registerAudio} src={musicSrc} preload="auto" className="hidden" />}
    </div>
  );
}
