import type { VolumePoint } from "@/types";
import { MAX_START_SEC } from "./placement";
import { MAX_OVERLAP_SEC } from "./stack";

/**
 * What stitchVideosAsync takes. Pure: the executor builds these from the
 * node's timeline, and older callers still pass bare Blobs and a bare music
 * buffer, which normalizeStitchArgs reads with their old meaning.
 */

/** One clip of the sequence: a video and the part of it to play. */
export interface StitchClipInput {
  blob: Blob;
  /** Trim start, in source seconds. */
  inSec: number;
  /** Trim end, in source seconds; null = the video track's end. */
  outSec: number | null;
  /** The clip's own sound is left out. */
  muted: boolean;
  /** 0..1 linear gain on the clip's own sound. */
  volume: number;
  /** Which video this clip plays (the timeline's source key). Adjacent clips with the same one meet with a cut when stacked. */
  source?: string;
  /** Stacked, placed: where this clip starts in one loop, seconds. */
  startSec?: number;
}

/** prepareAudioAsync's result; also the engine's old AudioData shape. */
export interface StitchAudioData {
  buffer: AudioBuffer;
  duration: number;
}

/** The music track: decoded audio, its volume curve over one loop, and its mute. */
export interface StitchMusicInput {
  audio: StitchAudioData;
  curve: VolumePoint[];
  muted: boolean;
}

export interface StitchOptions {
  /** How many times the sequence plays; an integer >= 1, default 1. */
  loopCount?: number;
  /** Stacked: how far each clip starts before the previous one ends, seconds. Absent, 0 or not finite: clips butt (Track). */
  overlapSec?: number;
  /** Stacked: dissolve and crossfade across each overlap; off, the earlier clip stays in front. Default true. */
  crossfade?: boolean;
  /**
   * Stacked with positions: clips start at their startSec; a clip without one resolves from overlapSec (resolveStarts).
   * Absent or false: Track or the lined-up stack, exactly as before.
   */
  placed?: boolean;
}

export function isMusicInput(audio: StitchAudioData | StitchMusicInput): audio is StitchMusicInput {
  return "audio" in audio;
}

function isClipInput(clip: Blob | StitchClipInput): clip is StitchClipInput {
  return "blob" in clip;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function readClip(clip: StitchClipInput): StitchClipInput {
  const inSec = finite(clip.inSec) && clip.inSec > 0 ? clip.inSec : 0;
  return {
    blob: clip.blob,
    inSec,
    outSec: finite(clip.outSec) ? clip.outSec : null,
    muted: clip.muted === true,
    volume: finite(clip.volume) ? Math.min(Math.max(clip.volume, 0), 1) : 1,
    ...(typeof clip.source === "string" && clip.source !== "" ? { source: clip.source } : {}),
    ...(finite(clip.startSec) ? { startSec: Math.min(Math.max(clip.startSec, 0), MAX_START_SEC) } : {}),
  };
}

/**
 * Old call shapes keep their meaning:
 * - A bare Blob plays whole, at volume 1. It is muted only when `audio` is a
 *   bare StitchAudioData: the old engine let that music replace clip sound.
 * - A bare StitchAudioData becomes music with a flat curve, unmuted.
 * Explicit inputs pass through, with In, Out and volume made finite.
 */
export function normalizeStitchArgs(
  clips: ReadonlyArray<Blob | StitchClipInput>,
  audio: StitchAudioData | StitchMusicInput | null | undefined,
): { clips: StitchClipInput[]; music: StitchMusicInput | null } {
  const music: StitchMusicInput | null = !audio
    ? null
    : isMusicInput(audio)
      ? audio
      : { audio, curve: [], muted: false };
  const musicReplacesSound = audio != null && music !== audio;
  return {
    clips: clips.map((clip) =>
      isClipInput(clip)
        ? readClip(clip)
        : { blob: clip, inSec: 0, outSec: null, muted: musicReplacesSound, volume: 1 },
    ),
    music,
  };
}

/** loopCount as the engine uses it: a whole number, at least 1. */
export function normalizeLoopCount(options: StitchOptions | undefined): number {
  const count = options?.loopCount;
  return finite(count) && count >= 1 ? Math.floor(count) : 1;
}

/** null unless overlapSec is finite and > 0; overlapSec clamped to MAX_OVERLAP_SEC; crossfade = options.crossfade !== false. */
export function normalizeStack(options: StitchOptions | undefined): { overlapSec: number; crossfade: boolean } | null {
  const overlapSec = options?.overlapSec;
  if (!finite(overlapSec) || overlapSec <= 0) return null;
  return { overlapSec: Math.min(overlapSec, MAX_OVERLAP_SEC), crossfade: options?.crossfade !== false };
}

/**
 * Non-null only when options.placed === true: { crossfade: options.crossfade !== false, overlapSec: finite and > 0 ?
 * min(overlapSec, MAX_OVERLAP_SEC) : 0 }. Clips' startSec never decides the route.
 */
export function normalizePlacement(options: StitchOptions | undefined): { crossfade: boolean; overlapSec: number } | null {
  if (options?.placed !== true) return null;
  const overlapSec = options.overlapSec;
  return {
    crossfade: options.crossfade !== false,
    overlapSec: finite(overlapSec) && overlapSec > 0 ? Math.min(overlapSec, MAX_OVERLAP_SEC) : 0,
  };
}
