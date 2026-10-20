import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { gainAt } from "@/lib/stitch/curve";
import {
  layersAt,
  placedLayersAt,
  sourceTimeAt,
  type ClipSpan,
  type PreviewLayer,
} from "@/lib/stitch/timeline";
import type { VolumePoint } from "@/types";

/**
 * The editor's preview: one <video> per clip, registered by clip id (two
 * pieces of one source can play at once, and a cut between them is a hand-
 * over like any other). The clip's mute and volume are applied to the
 * elements (element volume rather than Web Audio, so a source served without
 * CORS still sounds). Each audio clip has its own hidden <audio>, playing
 * inside its span from its In at its curve's gain, re-synced when it drifts
 * and paused outside. The encode is the truth. The preview plays one loop.
 *
 * Paused, the clips under the playhead are shown at the frame under it.
 * Playing, the sequence clock moves the playhead: it runs on the frames'
 * timestamps from where Play (or a move while playing) left it, and no
 * element holds it back. The elements follow it (runLoop). A gap in a placed
 * stack is a time when no clip is live: the stage is black and the audio
 * clips play on.
 *
 * What is shown and heard is written to the elements (inline opacity, muted,
 * volume), never through React: the hook renders only with its options.
 * Track shows the clip under the playhead. Stacked takes opacity and volume
 * from layersAt; a placed stack (`stack.placed`) from the envelope instead
 * (placedLayersAt), for any number of clips at once; a clip hidden under a
 * higher row keeps playing at opacity 0, in step.
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
/** Seconds before a cut at which the next clip is shown (a frame early beats a frame of a clip's trimmed part). */
const END_SLACK = 0.03;
/** A paused element this close to its target (its preparation landed) is played without another seek. */
const LANDED = 0.08;
/** A playing element this far from the clock is seeked back into step. */
const LAYER_DRIFT = 0.15;
/**
 * A prepared clip plays, hidden and muted, from up to this far before its In (what its source has before it), so its
 * decoder is running by its start.
 */
const PREROLL = 0.15;
/** Clips starting this soon after the next one are prepared with it. */
const PREPARE_WINDOW = 0.5;
/** How long the picture holds on what it showed for a clip coming into view that has no frame to show yet. */
const HOLD_MAX = 0.5;
/** Seconds from play() to an element moving: the first guess, and the bounds of what the elements' starts teach. */
const START_LATENCY = 0.05;
const START_LATENCY_RANGE = [0.01, 0.25] as const;

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

/** layersFor, but within END_SLACK of a cut (a live clip's Out where another starts) the layers after it. */
function shownLayers(
  spans: readonly ClipSpan[],
  t: number,
  stack: { crossfade: boolean; placed?: boolean } | null | undefined,
): PreviewLayer[] {
  const layers = layersFor(spans, t, stack);
  const ahead = t + END_SLACK;
  const ending = layers.some((layer) => layer.span.end > t && layer.span.end <= ahead);
  const starting = ending && spans.some((span) => span.length > 0 && span.start > t && span.start <= ahead);
  return starting ? layersFor(spans, ahead, stack) : layers;
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

/**
 * What the frame loop shares with the hook: the registered elements, the stage's blend canvas, the options as last
 * rendered, and the seek queue.
 */
interface PlaybackRefs {
  videos: RefObject<Map<string, HTMLVideoElement>>;
  audios: RefObject<Map<string, HTMLAudioElement>>;
  canvas: RefObject<HTMLCanvasElement | null>;
  pendingSeeks: RefObject<WeakMap<HTMLVideoElement, number>>;
  latest: RefObject<SequencePlaybackOptions>;
}

/** An element that can show a frame of where it is. */
const presentable = (el: HTMLVideoElement) => !el.seeking && el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;

/**
 * Draws a blend onto the canvas as the stage would composite the elements: black, then each clip in row order at its
 * opacity, letterboxed (object-contain) into the canvas's box.
 */
function drawBlend(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  layers: ReadonlyArray<{ el: HTMLVideoElement; opacity: number }>,
) {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.round(canvas.clientWidth * ratio);
  const height = Math.round(canvas.clientHeight * ratio);
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);
  for (const { el, opacity } of layers) {
    const { videoWidth, videoHeight } = el;
    if (!videoWidth || !videoHeight || el.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) continue;
    const scale = Math.min(width / videoWidth, height / videoHeight);
    const w = videoWidth * scale;
    const h = videoHeight * scale;
    ctx.globalAlpha = opacity;
    ctx.drawImage(el, (width - w) / 2, (height - h) / 2, w, h);
  }
}

/**
 * Playing. The clock: the playhead is where Play (or a move while playing) left it plus the frames' time since, so a
 * clip whose element stalls never stops it. One element per clip, Track and Stacked alike. Every frame:
 *
 * - each clip live at the clock is shown at its opacity with its sound, its element started (seeked only when its
 *   preparation has not landed) or, playing, put back in step past LAYER_DRIFT;
 * - the clips starting next are prepared as soon as they are next: paused at their pre-roll point (PREROLL before
 *   their In, as far as the source allows), then played, hidden and muted, so they reach their In as the clock
 *   reaches their start, already moving;
 * - every other element is hidden and muted at once and paused a frame later, after what replaces it is shown.
 *
 * Shown and heard are written here, never through React, so a cut is one style change. Where clips blend (a
 * crossfade, a placed stack's shares) they are drawn together on the stage's canvas and the elements hidden under
 * it: a browser composites two playing videos blended at half its frame rate or worse. A clip coming into view whose
 * element has no frame to show yet (still seeking) leaves the picture on what it showed, at most HOLD_MAX. At the
 * sequence's end the preview stops there. Returns the loop's cleanup.
 */
function runLoop({ videos, audios, canvas, pendingSeeks, latest }: PlaybackRefs): () => void {
  let alive = true;
  const store = useStitchEditorStore.getState();
  const sound = createAudioDriver(audios, latest);
  const elementOf = (span: ClipSpan) => videos.current.get(span.clip.id) ?? null;
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
  let frame = 0;
  // The element the picture is on (the first live layer's): only its refusal to play stops the preview
  let front: HTMLVideoElement | null = null;
  // Elements whose play() was refused: not asked again every frame
  let refused = new WeakSet<HTMLVideoElement>();
  // Hidden last frame and still playing: paused now
  let leaving = new Set<HTMLVideoElement>();
  // Clock time a cut began waiting for its incoming element to have a frame
  let holdingSince: number | null = null;
  // Each live clip's element and the opacity it was given last frame (on the canvas or itself)
  let shown = new Map<HTMLVideoElement, number>();
  // The canvas's 2D context, once asked for; null where there is none (the elements blend themselves)
  let blendContext: CanvasRenderingContext2D | null | undefined;
  // play() to moving, learned from each start: where and when it was asked
  let startLatency = START_LATENCY;
  const starting = new Map<HTMLVideoElement, { at: number; source: number }>();

  /** play(), where a refusal by the front element stops the preview (an AbortError is a pause, not a refusal). */
  const play = (el: HTMLVideoElement, at: number) => {
    starting.set(el, { at, source: el.currentTime });
    el.play().catch((error: unknown) => {
      if (!alive) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      refused.add(el);
      if (el === front) stop();
    });
  };

  /** Learns how long an element takes from play() to moving, from the ones that just started. */
  const learn = (at: number) => {
    for (const [el, start] of starting) {
      if (el.paused || el.seeking) {
        if (el.paused) starting.delete(el);
        continue;
      }
      const moved = el.currentTime - start.source;
      if (moved <= 0.001) continue;
      starting.delete(el);
      const sample = at - start.at - moved;
      const [min, max] = START_LATENCY_RANGE;
      startLatency = Math.min(max, Math.max(min, startLatency * 0.75 + sample * 0.25));
    }
  };

  const setOpacity = (el: HTMLElement, opacity: number) => {
    const value = String(opacity);
    if (el.style.opacity !== value) el.style.opacity = value;
  };
  const setSound = (el: HTMLVideoElement, muted: boolean, volume: number) => {
    if (el.muted !== muted) el.muted = muted;
    if (el.volume !== volume) el.volume = volume;
  };
  const contextOf = (cv: HTMLCanvasElement) => {
    if (blendContext === undefined) blendContext = cv.getContext("2d");
    return blendContext;
  };

  /** Keeps a live clip's element at `target` source seconds. */
  const follow = (el: HTMLVideoElement, target: number, at: number) => {
    // At its file's end the element holds its last frame until the clock leaves the clip
    if (el.ended && Math.abs(el.currentTime - target) <= LAYER_DRIFT) return;
    if (el.paused) {
      if (refused.has(el)) return;
      // A paused seek still in flight would pull the playing element back when it lands
      pendingSeeks.current.delete(el);
      if (Math.abs(el.currentTime - target) > LANDED) el.currentTime = target;
      play(el, at);
    } else if (!el.seeking && Math.abs(el.currentTime - target) > LAYER_DRIFT) {
      el.currentTime = target;
    }
  };

  /**
   * The clips starting next (and any within PREPARE_WINDOW of them): paused at their pre-roll point until it is time,
   * then playing towards their In. Returns the elements playing ahead of their start.
   */
  const prepare = (at: number, live: ReadonlyMap<HTMLVideoElement, unknown>) => {
    const rolling = new Set<HTMLVideoElement>();
    const { spans } = latest.current;
    const next = nextByStart(spans, at);
    if (!next) return rolling;
    for (const span of spans) {
      if (!(span.length > 0) || span.start <= at || span.start > next.start + PREPARE_WINDOW) continue;
      const el = elementOf(span);
      if (!el || live.has(el) || refused.has(el)) continue;
      const preroll = Math.min(PREROLL, span.clip.inSec);
      // Asked to play now, it moves startLatency later and must reach its In at the clip's start
      const startAt = span.start - preroll - startLatency;
      if (at < startAt) {
        if (!el.paused) el.pause();
        const point = span.clip.inSec - preroll;
        if (!el.seeking && Math.abs(el.currentTime - point) > SEEK_TOLERANCE) {
          pendingSeeks.current.delete(el);
          el.currentTime = point;
        }
        continue;
      }
      rolling.add(el);
      if (!el.paused) continue;
      // Late (the clock came from a move just before the start): from where it must be to reach its In in time
      const point = Math.max(0, span.clip.inSec - (span.start - at) + startLatency);
      if (Math.abs(el.currentTime - point) > SEEK_TOLERANCE) {
        pendingSeeks.current.delete(el);
        el.currentTime = point;
      }
      play(el, at);
    }
    return rolling;
  };

  /** The elements at `at`: the live clips shown and in step, the next ones prepared, the rest hidden then paused. */
  const applyLayers = (at: number) => {
    const { spans, soundOn, stack } = latest.current;
    const live = new Map<HTMLVideoElement, PreviewLayer>();
    for (const layer of shownLayers(spans, at, stack)) {
      const el = elementOf(layer.span);
      if (el) live.set(el, layer);
    }
    front = live.keys().next().value ?? null;
    const rolling = prepare(at, live);
    learn(at);

    // A clip coming into view whose element cannot show a frame yet: the picture stays on what it showed (the
    // elements' opacities and the canvas as they are), what left it still, until the clip has a frame
    const incoming = (el: HTMLVideoElement) => !((shown.get(el) ?? 0) > 0);
    let hold = false;
    for (const [el, layer] of live) {
      if (layer.opacity > 0 && incoming(el) && !presentable(el)) hold = true;
    }
    if (hold) {
      holdingSince ??= at;
      if (at - holdingSince > HOLD_MAX) hold = false;
    } else {
      holdingSince = null;
    }

    for (const [el, layer] of live) {
      follow(el, sourceTimeAt(layer.span, at), at);
      setSound(el, (hold && incoming(el)) || layer.span.clip.muted || !soundOn, clamp01(layer.span.clip.volume * layer.gain));
    }
    const next = new Set<HTMLVideoElement>();
    for (const el of videos.current.values()) {
      if (live.has(el)) continue;
      if (rolling.has(el)) {
        setOpacity(el, 0);
        setSound(el, true, el.volume);
        continue;
      }
      if (hold && (shown.get(el) ?? 0) > 0) {
        if (!el.paused) el.pause();
        continue;
      }
      setOpacity(el, 0);
      setSound(el, true, el.volume);
      if (el.paused) continue;
      if (leaving.has(el)) el.pause();
      else next.add(el);
    }
    leaving = next;
    if (hold) return;

    // In row order, the stage's: what paints later is on top
    const order = [...live].sort(([, a], [, b]) => a.span.index - b.span.index);
    const visible = order.filter(([, layer]) => layer.opacity > 0);
    const cv = canvas.current;
    const ctx = cv && visible.length > 1 && visible.some(([, layer]) => layer.opacity < 1) ? contextOf(cv) : null;
    if (cv && ctx) {
      drawBlend(cv, ctx, visible.map(([el, layer]) => ({ el, opacity: layer.opacity })));
      setOpacity(cv, 1);
      for (const [el] of order) setOpacity(el, 0);
    } else {
      if (cv) setOpacity(cv, 0);
      for (const [el, layer] of order) setOpacity(el, layer.opacity);
    }
    shown = new Map(order.map(([el, layer]) => [el, layer.opacity]));
  };

  const step = (at: number) => {
    applyLayers(at);
    sound.apply(at);
  };

  const tick = (now: number) => {
    const s = useStitchEditorStore.getState();
    // The playhead was moved from outside (Go to start, the ruler): the clock carries on from there
    if (Math.abs(s.playhead - written) > 1e-6) {
      from = s.playhead;
      written = s.playhead;
      anchor = now;
      refused = new WeakSet();
      holdingSince = null;
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
  registerVideo: (clipId: string, el: HTMLVideoElement | null) => void;
  registerAudio: (clipId: string, el: HTMLAudioElement | null) => void;
  /** The stage's canvas, over its elements, that a blend is drawn on while playing. */
  registerCanvas: (el: HTMLCanvasElement | null) => void;
} {
  const playing = useStitchEditorStore((s) => s.playing);
  // Keyed by clip id
  const videos = useRef(new Map<string, HTMLVideoElement>());
  // Keyed by audio clip id
  const audios = useRef(new Map<string, HTMLAudioElement>());
  const canvas = useRef<HTMLCanvasElement | null>(null);
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

  // Paused: every clip at the playhead shown at its opacity, at the frame under it; the rest hidden (all of them in a
  // gap)
  const seekPaused = useCallback(() => {
    const s = useStitchEditorStore.getState();
    if (s.playing) return;
    const { spans, stack } = latest.current;
    const shown = new Set<HTMLVideoElement>();
    for (const layer of layersFor(spans, s.playhead, stack)) {
      const el = videos.current.get(layer.span.clip.id);
      if (!el) continue;
      shown.add(el);
      seek(el, sourceTimeAt(layer.span, s.playhead));
      el.style.opacity = String(layer.opacity);
    }
    for (const el of videos.current.values()) if (!shown.has(el)) el.style.opacity = "0";
    // Paused elements blend themselves at no cost: the canvas is only for playing
    if (canvas.current) canvas.current.style.opacity = "0";
  }, [seek]);

  // An element keeps its identity when its URL changes (a data: to blob: swap), which sends it back to 0
  const onLoadedMetadata = useCallback(() => seekPaused(), [seekPaused]);

  const registerVideo = useCallback(
    (clipId: string, el: HTMLVideoElement | null) => {
      const previous = videos.current.get(clipId);
      if (previous === el) return;
      previous?.removeEventListener("seeked", onSeeked);
      previous?.removeEventListener("loadedmetadata", onLoadedMetadata);
      // One leaving the page could play on unseen
      previous?.pause();
      if (el) {
        el.addEventListener("seeked", onSeeked);
        el.addEventListener("loadedmetadata", onLoadedMetadata);
        videos.current.set(clipId, el);
      } else {
        videos.current.delete(clipId);
      }
    },
    [onSeeked, onLoadedMetadata],
  );

  const registerCanvas = useCallback((el: HTMLCanvasElement | null) => {
    canvas.current = el;
  }, []);

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
  // On a trim or a new clip (the spans)
  useEffect(() => {
    seekPaused();
  }, [opts.spans, seekPaused]);
  // On a switch of layout either way (at Overlap 0 nothing else changes), of crossfade or of placement (Stacked
  // blends differently) and on a new URL
  useEffect(() => {
    seekPaused();
  }, [stacked, crossfade, placed, opts.srcFor, seekPaused]);

  // Playing: the frame loop
  useEffect(() => {
    if (!playing) return;
    return runLoop({ videos, audios, canvas, pendingSeeks, latest });
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

  return useMemo(
    () => ({ registerVideo, registerAudio, registerCanvas }),
    [registerVideo, registerAudio, registerCanvas],
  );
}
