"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ensureOverlayFonts, onFontsChanged, overlayFontList } from "@/lib/stitch/fonts";
import {
  drawOverlays,
  overlayLayoutSize,
  type OverlayFontList,
  type OverlayLayoutCache,
  type OverlaySize,
} from "@/lib/stitch/overlayDraw";
import { draftOverlays, NO_OVERLAYS, overlayFadeKnees, overlayOpacitiesAt } from "@/lib/stitch/overlays";
import { FRAME_RATE, secToSlot } from "@/lib/stitch/sequencePlan";
import {
  livePlayhead,
  subscribeLivePlayhead,
  useStitchEditorStore,
  type StitchEditorState,
  type StitchSelection,
} from "@/store/stitchEditorStore";
import type { StitchOverlay } from "@/types";

/** The render's size while no clip has one (video-probing's fallback, which loads mediabunny). */
export const OVERLAY_FALLBACK_FRAME: OverlaySize = { width: 1920, height: 1080 };

const overlaysOf = (s: Pick<StitchEditorState, "draft">) => (s.draft ? draftOverlays(s.draft) : NO_OVERLAYS);

/**
 * The render's 60 fps slot the overlays are drawn on for playhead `t`: the one it lands in, never past the last, so a
 * paused frame shows what the render's frame there holds. While the clips' lengths are still being read (`total` 0)
 * there is no last slot yet: the playhead's own.
 */
export function overlayPreviewSlot(t: number, total: number): number {
  const last = total > 0 ? secToSlot(total) - 1 : Infinity;
  return Math.max(0, Math.min(secToSlot(total > 0 ? Math.min(t, total) : t), last));
}

/**
 * The slot drawn with no video clip, where there is no render to match and no playhead to move: the lead selected
 * layer (else the one that starts first) at the top of its fade-in, on the grid overlayOpacityAtSlot puts it on, inside
 * its end.
 */
export function overlayNoVideoSlot(overlays: readonly StitchOverlay[], selection: StitchSelection): number {
  const lead = selection?.kind === "overlay" ? overlays.find((o) => o.id === selection.clipId) : undefined;
  const earlier = (a: StitchOverlay | undefined, o: StitchOverlay) => (a && a.startSec <= o.startSec ? a : o);
  const shown = lead ?? overlays.reduce<StitchOverlay | undefined>(earlier, undefined);
  if (!shown) return 0;
  const from = secToSlot(shown.startSec);
  const top = from + Math.ceil((overlayFadeKnees(shown).fadeInEnd - shown.startSec) * FRAME_RATE - 1e-6);
  return Math.max(from, Math.min(top, secToSlot(shown.endSec) - 1));
}

/**
 * The draft's overlays over the stage's frame, as the render burns them in: laid out at the output's size and drawn
 * by drawOverlays onto a canvas at the frame's size times the device pixel ratio. Drawn as the live playhead moves
 * (every frame while playing), on an overlay edit, undo or redo, when a font loads and when the frame changes size,
 * never through a render. A canvas of its own over the blend canvas: the playback hides that one at every pause.
 */
export function OverlayCanvas({
  frame,
  frameSize,
  total,
  noVideo,
}: {
  /** The frame's CSS size (stageLayout's); null until the stage is measured. */
  frame: OverlaySize | null;
  /** The output's pixel size; null while no clip has one. */
  frameSize: OverlaySize | null;
  /** One loop of the video, seconds; 0 with no video, and while the clips' lengths are still being read. */
  total: number;
  /** No video clip on the timeline. */
  noVideo: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [cache] = useState<OverlayLayoutCache>(() => new WeakMap());
  const fonts = useRef<OverlayFontList | null>(null);
  // A new canvas is clear, and so is one whose size is set
  const blank = useRef(true);
  const redraw = useRef(() => {});

  const frameWidth = frame?.width ?? null;
  const frameHeight = frame?.height ?? null;
  const { width: outputWidth, height: outputHeight } = frameSize ?? OVERLAY_FALLBACK_FRAME;

  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let ctx: CanvasRenderingContext2D | null = null;
    const layout = overlayLayoutSize(outputWidth, outputHeight);
    const draw = (t: number) => {
      const s = useStitchEditorStore.getState();
      const overlays = overlaysOf(s);
      const slot = noVideo ? overlayNoVideoSlot(overlays, s.selection) : overlayPreviewSlot(t, total);
      const opacities = overlayOpacitiesAt(overlays, slot);
      if (blank.current && !opacities.some((opacity) => opacity > 0)) return;
      const ratio = window.devicePixelRatio || 1;
      const width = Math.round((frameWidth ?? canvas.clientWidth) * ratio);
      const height = Math.round((frameHeight ?? canvas.clientHeight) * ratio);
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      ctx ??= canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, width, height);
      fonts.current ??= overlayFontList(new Map());
      const target = { layout, canvas: { width, height }, rotation: 0 as const };
      blank.current = !drawOverlays(ctx, target, opacities, overlays, fonts.current, cache);
    };
    redraw.current = () => draw(livePlayhead());
    redraw.current();
    const offLive = subscribeLivePlayhead(draw);
    // With no video the time follows the selected layer
    const offStore = useStitchEditorStore.subscribe((s, prev) => {
      if (overlaysOf(s) !== overlaysOf(prev) || (noVideo && s.selection !== prev.selection)) draw(livePlayhead());
    });
    return () => {
      offLive();
      offStore();
    };
  }, [cache, frameWidth, frameHeight, outputWidth, outputHeight, total, noVideo]);

  // Font files and faces load as the layers name them, or as the fonts change; drawn in the lists they resolve to once
  // they have. Only a real load changes the fonts again, so this settles
  useEffect(() => {
    let live = true;
    let latest = 0;
    const load = (overlays: readonly StitchOverlay[]) => {
      const request = ++latest;
      void ensureOverlayFonts(overlays).then((resolved) => {
        if (!live || request !== latest) return;
        fonts.current = overlayFontList(resolved);
        redraw.current();
      });
    };
    load(overlaysOf(useStitchEditorStore.getState()));
    const offStore = useStitchEditorStore.subscribe((s, prev) => {
      if (overlaysOf(s) !== overlaysOf(prev)) load(overlaysOf(s));
    });
    // A face that loads shows at once; and a file added to the Fonts folder resolves only when asked again
    const offFonts = onFontsChanged(() => {
      redraw.current();
      load(overlaysOf(useStitchEditorStore.getState()));
    });
    return () => {
      live = false;
      offStore();
      offFonts();
    };
  }, []);

  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      data-testid="stitch-overlay-canvas"
      className="pointer-events-none absolute inset-0 h-full w-full"
    />
  );
}
