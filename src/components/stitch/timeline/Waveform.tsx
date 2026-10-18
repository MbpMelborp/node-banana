"use client";

import { useEffect, useRef } from "react";
import { peakInRange } from "@/lib/stitch/peaks";
import type { TimeAxis } from "@/lib/stitch/timeAxis";

/** Bars on an 8px pitch, measured from the block's left edge so they hold still while the lanes scroll. */
const BAR_PITCH = 8;
/** A full-scale peak's bar, as a share of the block's height. */
const BAR_REACH = 0.7;

let audioColor: string | null = null;
/** The audio handle colour, read once from the theme (a canvas cannot take a class); again while the theme has none. */
function handleAudioColor(): string {
  if (!audioColor && typeof document !== "undefined") {
    audioColor = getComputedStyle(document.documentElement).getPropertyValue("--color-handle-audio").trim();
  }
  return audioColor ?? "";
}

/**
 * An audio clip's waveform under its volume curve: one bar per 8px, mirrored
 * about the block's centre, as tall as the loudest sample in the source
 * time it covers (sequence time + sourceOffset: a clip's In less its start). Drawn to a canvas across the visible part of the block
 * only, so a long sequence at a high zoom never makes a canvas too large to
 * draw. No bars inside a slot: it takes no time.
 */
export function Waveform({
  peaks,
  duration,
  axis,
  blockX,
  blockWidth,
  height,
  expanded,
  viewLeft,
  viewRight,
  sourceOffset = 0,
}: {
  peaks: Float32Array;
  duration: number;
  axis: TimeAxis;
  /** The block on the lane. */
  blockX: number;
  blockWidth: number;
  height: number;
  expanded: boolean;
  /** The lane range to draw (the visible lanes with an overscan). */
  viewLeft: number;
  viewRight: number;
  /** Source seconds less sequence seconds. */
  sourceOffset?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const left = Math.max(0, Math.floor(viewLeft - blockX));
  const right = Math.min(Math.ceil(blockWidth), Math.ceil(viewRight - blockX));
  const width = Math.max(0, right - left);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext("2d");
    const color = handleAudioColor();
    if (!ctx || !color) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = color;
    ctx.globalAlpha = expanded ? 0.45 : 0.5;
    const barWidth = expanded ? 4 : 3;
    const reach = height * BAR_REACH;
    const centre = height / 2;
    for (let k = Math.floor(left / BAR_PITCH); k * BAR_PITCH < right; k++) {
      const x0 = blockX + k * BAR_PITCH;
      const x1 = x0 + BAR_PITCH;
      if (axis.slots.some((slot) => x1 > slot.x && x0 < slot.x + slot.width)) continue;
      const peak = peakInRange(peaks, duration, axis.xToTime(x0) + sourceOffset, axis.xToTime(x1) + sourceOffset);
      if (peak <= 0) continue;
      const barHeight = Math.max(1, peak * reach);
      // On whole pixels (2px in), so a 3px bar stays sharp at a device pixel ratio of 1
      ctx.fillRect(k * BAR_PITCH - left + Math.floor((BAR_PITCH - barWidth) / 2), centre - barHeight / 2, barWidth, barHeight);
    }
  }, [peaks, duration, axis, blockX, left, right, width, height, expanded, sourceOffset]);

  if (width === 0) return null;
  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      data-testid="stitch-waveform"
      className="pointer-events-none absolute top-0"
      style={{ left, width, height }}
    />
  );
}
