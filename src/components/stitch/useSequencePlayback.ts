import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { gainAt } from "@/lib/stitch/curve";
import {
  layersAt,
  placedLayersAt,
  sourceTimeAt,
  spanAtTime,
  type ClipSpan,
  type PreviewLayer,
} from "@/lib/stitch/timeline";
import type { VolumePoint } from "@/types";

/**
 * The editor's preview: in Track one <video> per source, the one under the
 * playhead shown; in Stacked one per clip. The clip's mute and volume are
 * applied to the elements (element volume rather than Web Audio, so a source
 * served without CORS still sounds). Each audio clip has its own hidden
 * <audio>, playing inside its span from its In at its curve's gain, re-synced
 * when it drifts and paused outside. The encode is the truth. The preview
 * plays one loop.
 *
 * Paused, the elements are seeked to the frame under the playhead.
 * Playing, the sequence clock moves the playhead: it runs on the frames'
 * timestamps from where Play (or a move while playing) left it, and no
 * element holds it back. The elements follow it: each clip live at the clock
 * is started from its own source time when it is not playing and put back in
 * step when it drifts; every other element is paused. The next clip's
 * element is seeked to its In ahead of its start. A gap in a placed stack is
 * a time when no clip is live: the stage is black and the audio clips play on.
 *
 * The hook does not subscribe to the playhead itself: the frame loop writes
 * it every frame, and the editor's root (which calls this) would re-render
 * with it. It re-renders only when the source under the playhead changes.
 *
 * Stacked (`stack` set): one <video> per clip, registered by clip id, since
 * two pieces of one source can play at once. At an overlap both elements
 * play. Opacity and volume come from layersAt and are written to the
 * elements every frame, never through React. A placed stack
 * (`stack.placed`) takes them from the envelope instead (placedLayersAt),
 * for any number of clips at once; a clip hidden under a higher row keeps
 * playing at opacity 0, in step.
 */

/** One audio clip as the preview plays it. */
export interface AudioPlaybackClip {
  id: string;
  /** What its element plays; null with nothing to play (no music connected, a file not in the library). */
  src: string | null;
  startSec: number;
  inSec: number;
  /** Source seconds its sound stops at; null = the file's end. */
  outSec: number | null;
  muted: boolean;
  /** Source seconds. */
  curve: VolumePoint[];
}

export interface SequencePlaybackOptions {
  spans: ClipSpan[];
  total: number;
  /** The playable URL of a clip's source, or null when it has none. */
  srcFor: (clipId: string) => string | null;
  audio: { clips: readonly AudioPlaybackClip[] };
  soundOn: boolean;
  /** Stacked: elements per clip, blended at overlaps; placed once some clip has a stored start. Absent or null: Track. */
  stack?: { crossfade: boolean; placed?: boolean } | null;
}

/** A paused element this far from its target is seeked. */
const SEEK_TOLERANCE = 0.02;
/** An audio clip is re-synced when it drifts this far from the playhead. */
const AUDIO_DRIFT = 0.25;
/** The next clip's element is seeked to its In this long before its start. */
const PRESEEK = 0.5;
/** A paused element this close to its target (its pre-seek landed) is played without another seek. */
const LANDED = 0.08;
/** A playing element this far from the clock is seeked back into step. */
const LAYER_DRIFT = 0.15;

/** The earlier of two spans by start time, the higher row on a tie. */
const startsFirst = (a: ClipSpan, b: ClipSpan) => a.start - b.start || a.index - b.index;

/** The next clip to start after t, by start time (Track and lined-up stacks: the next one along). */
function nextByStart(spans: readonly ClipSpan[], t: number): ClipSpan | null {
  let next: ClipSpan | null = null;
  for (const span of spans) {
    if (span.length > 0 && span.start > t && (!next || startsFirst(span, next) < 0)) next = span;
  }
  return next;
}

/**
 * The clips the preview plays at t: in Track the one under it; in a stack commit 9's two-layer rule while lined up,
 * the envelope once placed.
 */
function layersFor(
  spans: readonly ClipSpan[],
  t: number,
  stack: { crossfade: boolean; placed?: boolean } | null | undefined,
): PreviewLayer[] {
  if (!stack) return layersAt(spans, t, false);
  return stack.placed ? placedLayersAt(spans, t, stack.crossfade) : layersAt(spans, t, stack.crossfade);
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));

/**
 * The audio clips under a playing preview: each element's mute and its curve's gain at its own source time; inside
 * its span it is started from the playhead when it is not playing and re-synced when it drifts, outside it (or past
 * its Out or its file's end) it is paused. reset() asks each to play again (a jump).
 */
function createAudioDriver(
  audios: RefObject<Map<string, HTMLAudioElement>>,
  latest: RefObject<SequencePlaybackOptions>,
) {
  // The elements play() was last asked of; asked again after one stops at its end, a jump or a new element
  let asked = new Set<HTMLAudioElement>();
  return {
    reset() {
      asked = new Set();
    },
    apply(at: number) {
      const { audio, soundOn } = latest.current;
      for (const clip of audio.clips) {
        const track = audios.current.get(clip.id);
        if (!track) continue;
        const target = clip.inSec + (at - clip.startSec);
        const length = track.duration;
        const end = Math.min(clip.outSec ?? Infinity, Number.isFinite(length) ? length : Infinity);
        track.muted = clip.muted || !soundOn;
        track.volume = clamp01(gainAt(clip.curve, target));
        if (at < clip.startSec || target >= end) {
          if (!track.paused) track.pause();
          asked.delete(track);
          continue;
        }
        if (!clip.src) continue;
        if (track.paused && !asked.has(track)) {
          // Starting, back inside the clip after it ended, or a remounted element
          asked.add(track);
          track.currentTime = target;
          track.play().catch(() => undefined);
        } else if (Math.abs(track.currentTime - target) > AUDIO_DRIFT) {
          track.currentTime = target;
        }
      }
    },
  };
}

/** What the frame loop shares with the hook: the registered elements, the options as last rendered, and the seek queue. */
interface PlaybackRefs {
  videos: RefObject<Map<string, HTMLVideoElement>>;
  audios: RefObject<Map<string, HTMLAudioElement>>;
  pendingSeeks: RefObject<WeakMap<HTMLVideoElement, number>>;
  latest: RefObject<SequencePlaybackOptions>;
}

/**
 * Playing. The clock: the playhead is where Play (or a move while playing) left it plus the frames' time since, so a
 * clip whose element stalls never stops it. Every frame each clip live at the clock gets its element started (seeked
 * only when its pre-seek has not landed) or, playing, put back in step past LAYER_DRIFT, and its mute and volume (in
 * Stacked its opacity too); every other element is paused (in Stacked hidden). The next clip's element is seeked to
 * its In ahead of its start. At the sequence's end the preview stops there. Returns the loop's cleanup.
 */
function runLoop({ videos, audios, pendingSeeks, latest }: PlaybackRefs): () => void {
  let alive = true;
  const store = useStitchEditorStore.getState();
  const sound = createAudioDriver(audios, latest);
  // Track: one element per source, so two clips of one source share it. Stacked: one per clip
  const elementOf = (span: ClipSpan) => {
    const { stack, srcFor } = latest.current;
    const key = stack ? span.clip.id : srcFor(span.clip.id);
    return key === null ? null : (videos.current.get(key) ?? null);
  };
  const pauseAll = () => {
    for (const el of videos.current.values()) el.pause();
    for (const el of audios.current.values()) el.pause();
  };
  const stop = (at?: number) => {
    pauseAll();
    const s = useStitchEditorStore.getState();
    s.setPlaying(false);
    if (at !== undefined) s.setPlayhead(at);
  };

  let from = store.playhead;
  if (from >= latest.current.total - 0.001) {
    from = 0;
    store.setPlayhead(0);
  }
  // The frame timestamp the clock counts from: the first frame after a start or a move
  let anchor: number | null = null;
  let written = from;
  let preseeked: string | null = null;
  let frame = 0;
  // The element the picture is on (the first live layer's): only its refusal to play stops the preview
  let front: HTMLVideoElement | null = null;
  // Elements whose play() was refused: not asked again every frame
  let refused = new WeakSet<HTMLVideoElement>();

  /** play(), where a refusal by the front element stops the preview (an AbortError is a pause, not a refusal). */
  const play = (el: HTMLVideoElement) => {
    el.play().catch((error: unknown) => {
      if (!alive) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      refused.add(el);
      if (el === front) stop();
    });
  };

  /** Keeps a live clip's element at `target` source seconds. */
  const follow = (el: HTMLVideoElement, target: number) => {
    // At its file's end the element holds its last frame until the clock leaves the clip
    if (el.ended && Math.abs(el.currentTime - target) <= LAYER_DRIFT) return;
    if (el.paused) {
      if (refused.has(el)) return;
      // A paused seek still in flight would pull the playing element back when it lands
      pendingSeeks.current.delete(el);
      if (Math.abs(el.currentTime - target) > LANDED) el.currentTime = target;
      play(el);
    } else if (!el.seeking && Math.abs(el.currentTime - target) > LAYER_DRIFT) {
      el.currentTime = target;
    }
  };

  /** The elements at `at`: the live clips' in step, the rest paused (in Stacked hidden). */
  const applyLayers = (at: number) => {
    const { spans, soundOn, stack } = latest.current;
    const live = new Set<HTMLVideoElement>();
    front = null;
    for (const layer of layersFor(spans, at, stack)) {
      const el = elementOf(layer.span);
      // Track: a second clip of the same source shares the element (never two at once there)
      if (!el || live.has(el)) continue;
      live.add(el);
      front ??= el;
      if (stack) el.style.opacity = String(layer.opacity);
      el.muted = layer.span.clip.muted || !soundOn;
      el.volume = clamp01(layer.span.clip.volume * layer.gain);
      follow(el, sourceTimeAt(layer.span, at));
    }
    for (const el of videos.current.values()) {
      if (live.has(el)) continue;
      if (!el.paused) el.pause();
      if (stack) el.style.opacity = "0";
    }
  };

  /** Seeks the next clip's element to its In ahead of its start, when it is not one playing now. */
  const preseek = (at: number) => {
    const following = nextByStart(latest.current.spans, at);
    if (!following || preseeked === following.clip.id || following.start - at >= PRESEEK) return;
    const el = elementOf(following);
    if (el && el.paused) {
      pendingSeeks.current.delete(el);
      el.currentTime = following.clip.inSec;
    }
    preseeked = following.clip.id;
  };

  const step = (at: number) => {
    applyLayers(at);
    sound.apply(at);
    preseek(at);
  };

  const tick = (now: number) => {
    const s = useStitchEditorStore.getState();
    // The playhead was moved from outside (Go to start, the ruler): the clock carries on from there
    if (Math.abs(s.playhead - written) > 1e-6) {
      from = s.playhead;
      written = s.playhead;
      anchor = now;
      preseeked = null;
      refused = new WeakSet();
      // The audio clips are asked to play again from there, if they had stopped
      sound.reset();
    }
    anchor ??= now;
    const at = from + Math.max(0, now - anchor) / 1000;
    const { total } = latest.current;
    if (at >= total) return stop(total);
    written = at;
    s.setPlayhead(at);
    step(at);
    frame = requestAnimationFrame(tick);
  };

  // Started at once, inside the press that asked for it; the clock counts from the first frame
  step(from);
  if (!front && layersFor(latest.current.spans, from, latest.current.stack).length > 0) {
    // Nothing to show where something should play (no element yet): nothing to follow
    stop();
    return () => {
      alive = false;
    };
  }
  frame = requestAnimationFrame(tick);

  return () => {
    alive = false;
    cancelAnimationFrame(frame);
    pauseAll();
  };
}

export function useSequencePlayback(opts: SequencePlaybackOptions): {
  registerVideo: (key: string, el: HTMLVideoElement | null) => void;
  registerAudio: (clipId: string, el: HTMLAudioElement | null) => void;
  activeSrc: string | null;
} {
  const playing = useStitchEditorStore((s) => s.playing);
  // A string or null: the root re-renders when the source under the playhead changes, not per frame
  const activeSrc = useStitchEditorStore((s) => {
    const span = spanAtTime(opts.spans, s.playhead);
    return span ? opts.srcFor(span.clip.id) : null;
  });
  // Keyed by source URL in Track, by clip id in Stacked
  const videos = useRef(new Map<string, HTMLVideoElement>());
  // Keyed by audio clip id
  const audios = useRef(new Map<string, HTMLAudioElement>());
  // A seek asked for while the element is still seeking: only the latest target is kept
  const pendingSeeks = useRef(new WeakMap<HTMLVideoElement, number>());
  const latest = useRef(opts);
  useLayoutEffect(() => {
    latest.current = opts;
  });
  const stacked = Boolean(opts.stack);
  const crossfade = opts.stack?.crossfade ?? true;
  const placed = opts.stack?.placed ?? false;

  const seek = useCallback((el: HTMLVideoElement, time: number) => {
    if (el.seeking) {
      pendingSeeks.current.set(el, time);
      return;
    }
    if (Math.abs(el.currentTime - time) > SEEK_TOLERANCE) el.currentTime = time;
  }, []);

  const onSeeked = useCallback(
    (event: Event) => {
      const el = event.currentTarget as HTMLVideoElement;
      const target = pendingSeeks.current.get(el);
      if (target === undefined) return;
      pendingSeeks.current.delete(el);
      seek(el, target);
    },
    [seek],
  );

  // Paused: show the frame under the playhead
  const seekPaused = useCallback(() => {
    const s = useStitchEditorStore.getState();
    if (s.playing) return;
    const { spans, srcFor, stack } = latest.current;
    if (stack) {
      // Every clip at the playhead, at its opacity; the rest hidden (all of them in a gap)
      const shown = new Set<HTMLVideoElement>();
      for (const layer of layersFor(spans, s.playhead, stack)) {
        const el = videos.current.get(layer.span.clip.id);
        if (!el) continue;
        shown.add(el);
        seek(el, sourceTimeAt(layer.span, s.playhead));
        el.style.opacity = String(layer.opacity);
      }
      for (const el of videos.current.values()) if (!shown.has(el)) el.style.opacity = "0";
      return;
    }
    const span = spanAtTime(spans, s.playhead);
    const src = span ? srcFor(span.clip.id) : null;
    const el = src ? videos.current.get(src) : undefined;
    if (span && el) seek(el, sourceTimeAt(span, s.playhead));
  }, [seek]);

  // Stacked elements keep their identity when their URL changes (a data: to blob: swap), which sends them back to 0
  const onLoadedMetadata = useCallback(() => {
    if (latest.current.stack) seekPaused();
  }, [seekPaused]);

  const registerVideo = useCallback(
    (key: string, el: HTMLVideoElement | null) => {
      const previous = videos.current.get(key);
      if (previous === el) return;
      previous?.removeEventListener("seeked", onSeeked);
      previous?.removeEventListener("loadedmetadata", onLoadedMetadata);
      if (el) {
        el.addEventListener("seeked", onSeeked);
        el.addEventListener("loadedmetadata", onLoadedMetadata);
        videos.current.set(key, el);
      } else {
        videos.current.delete(key);
      }
    },
    [onSeeked, onLoadedMetadata],
  );

  const registerAudio = useCallback((clipId: string, el: HTMLAudioElement | null) => {
    const previous = audios.current.get(clipId);
    if (previous === el) return;
    previous?.pause();
    if (el) audios.current.set(clipId, el);
    else audios.current.delete(clipId);
  }, []);

  // On a playhead move or a pause, read from the store rather than a render
  useEffect(
    () =>
      useStitchEditorStore.subscribe((s, prev) => {
        if (s.playhead !== prev.playhead || s.playing !== prev.playing) seekPaused();
      }),
    [seekPaused],
  );
  // On a trim (the spans) or another element under the playhead
  useEffect(() => {
    seekPaused();
  }, [opts.spans, activeSrc, seekPaused]);
  // On a switch of layout either way (the elements are new: at Overlap 0 nothing else changes), of crossfade or of
  // placement (Stacked blends differently) and on a new URL
  useEffect(() => {
    seekPaused();
  }, [stacked, crossfade, placed, opts.srcFor, seekPaused]);

  // Playing: the frame loop
  useEffect(() => {
    if (!playing) return;
    return runLoop({ videos, audios, pendingSeeks, latest });
  }, [playing]);

  // Pause everything when the editor goes away
  useEffect(() => {
    const elements = videos.current;
    const tracks = audios.current;
    return () => {
      for (const el of elements.values()) el.pause();
      for (const el of tracks.values()) el.pause();
    };
  }, []);

  return useMemo(() => ({ registerVideo, registerAudio, activeSrc }), [registerVideo, registerAudio, activeSrc]);
}
