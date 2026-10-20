import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import { PLAYHEAD_WRITE_SEC, setLivePlayhead, useStitchEditorStore } from "@/store/stitchEditorStore";
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
/**
 * Seconds before a cut within which a clip whose element has reached its Out hands over at once (a frame early beats
 * a frame of its trimmed part).
 */
const END_SLACK = 0.03;
/** A paused element this close to its target (its preparation landed) is played without another seek. */
const LANDED = 0.08;
/**
 * A playing element within this of the clock is in step: left alone. Sound, past its time's jitter of a few ms; a
 * picture, within a frame (a picture nudged by its rate shows the odd frame a refresh longer, which is seen).
 */
const IN_STEP = { audio: 0.03, video: 0.045 };
/** A nudged element is back in step, its rate back to 1, within this. */
const SETTLED = 0.01;
/** How much faster or slower a drifting element plays: gently, and harder past FAR. */
const NUDGE = 0.02;
const NUDGE_FAR = 0.05;
const FAR = 0.12;
/** Past this an element is seeked rather than nudged. */
const SEEK_DRIFT = 0.25;
/** An element seeked this recently is nudged, not seeked again, unless it is more than a second off. */
const SEEK_COOLDOWN = 1;
/** Seconds a playing element's seek takes to land: the first guess, and the bounds of what the seeks teach. */
const SEEK_LEAD = 0.1;
const SEEK_LEAD_RANGE = [0, 1] as const;
/**
 * After a start or a move the clock waits for the clip in front to have moved this far (about a frame, more than the
 * few milliseconds a starting element reports before it really moves), at most PRIME_MAX.
 */
const PRIME_MOVED = 0.04;
const PRIME_MAX = 0.5;
/** An audio clip starting within this of the clock is put at its In, so it starts without a seek. */
const AUDIO_PREPARE = 1;
/**
 * A prepared clip plays, hidden and muted, from up to this far before its In (what its source has before it), so its
 * decoder is running by its start. A start in the middle of a file can take a quarter of a second to show a frame
 * (measured: a source with one keyframe, another element playing it too), so this is generous.
 */
const PREROLL = 0.5;
/**
 * A prepared clip is started this much earlier than its start latency says: a clip's first frame shown a little short
 * is never seen, one held a frame long is.
 */
const START_MARGIN = 0.02;
/** A clip coming into view whose element last showed a frame further than this behind its target holds the cut. */
const STALE_FRAME = 0.1;
/** Clips starting this soon after the next one are prepared with it. */
const PREPARE_WINDOW = 0.5;
/** How long the picture holds on what it showed for a clip coming into view that has no frame to show yet. */
const HOLD_MAX = 0.5;
/** Seconds from play() to an element moving: the first guess, and the bounds of what the elements' starts teach. */
const START_LATENCY = 0.05;
const START_LATENCY_RANGE = [0.01, 0.25] as const;
/**
 * How far an element must have moved before its start teaches the latency: a starting element reports a few
 * milliseconds at once, then stands still until its first frames are out.
 */
const START_MOVED = 0.08;

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

const clamp = (value: number, [min, max]: readonly [number, number]) => Math.min(max, Math.max(min, value));

/**
 * Keeps playing elements on the clock, video and audio alike (each kind its own keeper). Within `inStep` an element
 * is left alone. Past it, up to SEEK_DRIFT, its playbackRate is nudged (NUDGE, NUDGE_FAR past FAR) until it is back
 * within SETTLED, so its sound never jumps. Only past SEEK_DRIFT is it seeked, to where the clock will be when the
 * seek has landed (the seeks' own time, learned), and not again within SEEK_COOLDOWN unless it is a second off: a
 * slow seek is caught up by the rate, never chased by another. It also learns its elements' start latency (play() to
 * moving). Times passed as `wall` are the frames' timestamps, in seconds.
 */
function createStepKeeper(inStep: number) {
  let startLatency = START_LATENCY;
  let seekLead = SEEK_LEAD;
  const starting = new Map<HTMLMediaElement, { wall: number; source: number }>();
  const seeks = new Map<HTMLMediaElement, number>();
  const lastSeek = new WeakMap<HTMLMediaElement, number>();
  const setRate = (el: HTMLMediaElement, rate: number) => {
    if (el.playbackRate !== rate) el.playbackRate = rate;
  };
  return {
    startLatency: () => startLatency,
    /** A play() asked of `el` at `wall`, to learn from; null before the first frame (nothing to time it by). */
    started(el: HTMLMediaElement, wall: number | null) {
      if (wall !== null) starting.set(el, { wall, source: el.currentTime });
    },
    /** A start timed elsewhere (the clock's wait for the front clip): `sample` seconds from play() to moving. */
    learnStart(sample: number) {
      startLatency = clamp(startLatency * 0.5 + sample * 0.5, START_LATENCY_RANGE);
    },
    keep(el: HTMLMediaElement, target: number, wall: number) {
      if (el.paused || el.seeking) return;
      const drift = el.currentTime - target;
      const off = Math.abs(drift);
      if (off > SEEK_DRIFT && (off > 1 || wall - (lastSeek.get(el) ?? -Infinity) > SEEK_COOLDOWN)) {
        setRate(el, 1);
        lastSeek.set(el, wall);
        seeks.set(el, wall);
        el.currentTime = target + seekLead;
        return;
      }
      if (off <= SETTLED) setRate(el, 1);
      else if (off > inStep || el.playbackRate !== 1) setRate(el, 1 - Math.sign(drift) * (off > FAR ? NUDGE_FAR : NUDGE));
    },
    learn(wall: number) {
      for (const [el, asked] of seeks) {
        if (el.seeking) continue;
        seeks.delete(el);
        seekLead = clamp(seekLead * 0.5 + (wall - asked) * 0.5, SEEK_LEAD_RANGE);
      }
      for (const [el, start] of starting) {
        if (el.paused || el.seeking) {
          if (el.paused) starting.delete(el);
          continue;
        }
        const moved = el.currentTime - start.source;
        if (moved < START_MOVED) continue;
        starting.delete(el);
        startLatency = clamp(startLatency * 0.75 + (wall - start.wall - moved) * 0.25, START_LATENCY_RANGE);
      }
    },
  };
}

/**
 * The audio clips under a playing preview: each element's mute and its curve's gain at its own source time. A clip
 * coming up is put at its In ahead (AUDIO_PREPARE) and started its start latency before its start, so it is moving as
 * the clock reaches it; from the middle (a start, a move) it is started where the clock will be when it moves. Playing, its keeper keeps it on the
 * clock; outside its span (or past its Out or its file's end) it is paused. reset() asks each to play again (a jump);
 * pause() stops them where they are (the clock waiting for the picture).
 */
function createAudioDriver(
  audios: RefObject<Map<string, HTMLAudioElement>>,
  latest: RefObject<SequencePlaybackOptions>,
) {
  const keeper = createStepKeeper(IN_STEP.audio);
  // The elements play() was last asked of; asked again after one stops at its end, a jump or a new element
  let asked = new Set<HTMLAudioElement>();
  return {
    reset() {
      asked = new Set();
    },
    pause() {
      for (const track of audios.current.values()) if (!track.paused) track.pause();
      asked = new Set();
    },
    apply(at: number, wall: number | null) {
      if (wall !== null) keeper.learn(wall);
      const { audio, soundOn } = latest.current;
      const lead = keeper.startLatency();
      for (const clip of audio.clips) {
        const track = audios.current.get(clip.id);
        if (!track) continue;
        const target = clip.inSec + (at - clip.startSec);
        const length = track.duration;
        const end = Math.min(clip.outSec ?? Infinity, Number.isFinite(length) ? length : Infinity);
        track.muted = clip.muted || !soundOn;
        track.volume = clamp01(gainAt(clip.curve, Math.max(clip.inSec, target)));
        if (clip.startSec - at > lead || target >= end) {
          if (!track.paused) track.pause();
          asked.delete(track);
          if (target < clip.inSec && clip.startSec - at <= AUDIO_PREPARE && !track.seeking) {
            if (Math.abs(track.currentTime - clip.inSec) > SEEK_TOLERANCE) track.currentTime = clip.inSec;
          }
          continue;
        }
        if (!clip.src) continue;
        if (track.paused && !asked.has(track)) {
          // Starting, back inside the clip after it ended, or a remounted element
          asked.add(track);
          const point = at < clip.startSec ? clip.inSec : target + lead;
          if (Math.abs(track.currentTime - point) > SEEK_TOLERANCE) track.currentTime = point;
          keeper.started(track, wall);
          track.play().catch(() => undefined);
        } else if (at >= clip.startSec && wall !== null) {
          keeper.keep(track, target, wall);
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
  /** The media time of the frame each element last presented, where the browser says (requestVideoFrameCallback). */
  presented: RefObject<WeakMap<HTMLVideoElement, number>>;
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
 * clip whose element stalls never stops it. Only after a start or a move does it wait (PRIME_MAX at most) for the
 * clip in front to be moving, and takes up from there with the audio clips, so picture and sound set off together
 * and no sound runs ahead of a picture still seeking. One element per clip, Track and Stacked alike. Every frame:
 *
 * - each clip live at the clock is shown at its opacity with its sound, its element started (seeked only when its
 *   preparation has not landed) or, playing, kept on the clock (createStepKeeper);
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
function runLoop({ videos, audios, canvas, pendingSeeks, latest, presented }: PlaybackRefs): () => void {
  let alive = true;
  const store = useStitchEditorStore.getState();
  const sound = createAudioDriver(audios, latest);
  const keeper = createStepKeeper(IN_STEP.video);
  const elementOf = (span: ClipSpan) => videos.current.get(span.clip.id) ?? null;
  const pauseAll = () => {
    for (const el of [...videos.current.values(), ...audios.current.values()]) {
      el.pause();
      if (el.playbackRate !== 1) el.playbackRate = 1;
    }
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
  // The frame timestamp the clock counts from, once the front clip moves after a start or a move
  let anchor = 0;
  let priming = true;
  let primeSince: number | null = null;
  // The front element, and its time once its start had landed, to see it move from
  let primeEl: HTMLVideoElement | null = null;
  let primeFrom: number | null = null;
  // The frame its start had landed by
  let primeLanded: number | null = null;
  // The elements put at their target for this priming (each once: they play on from there)
  let primed = new WeakSet<HTMLVideoElement>();
  // This frame's timestamp in seconds; null before the first frame
  let wall: number | null = null;
  let written = from;
  // Where the clock was at the last frame
  let clockAt = from;
  let frame = 0;
  // The element the picture is on (the first live layer's): only its refusal to play stops the preview
  let front: HTMLVideoElement | null = null;
  let frontSpan: ClipSpan | null = null;
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
  /** play(), where a refusal by the front element stops the preview (an AbortError is a pause, not a refusal). */
  const play = (el: HTMLVideoElement) => {
    keeper.started(el, wall);
    el.play().catch((error: unknown) => {
      if (!alive) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      refused.add(el);
      if (el === front) stop();
    });
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

  /**
   * Keeps a live clip's element at `target` source seconds. Priming, the clock waits for it: put at the target once
   * and started. Else started when paused from where the clock will be when it moves, and kept on the clock.
   */
  const follow = (el: HTMLVideoElement, target: number) => {
    // At its file's end the element holds its last frame until the clock leaves the clip
    if (el.ended && Math.abs(el.currentTime - target) <= SEEK_DRIFT) return;
    if (priming) {
      if (!primed.has(el)) {
        primed.add(el);
        // A paused seek still in flight would pull the element back when it lands
        pendingSeeks.current.delete(el);
        if (Math.abs(el.currentTime - target) > LANDED) el.currentTime = target;
      }
      if (el.paused && !refused.has(el)) play(el);
      return;
    }
    if (el.paused) {
      if (refused.has(el)) return;
      pendingSeeks.current.delete(el);
      const point = target + keeper.startLatency();
      if (Math.abs(el.currentTime - point) > LANDED) el.currentTime = point;
      play(el);
    } else if (wall !== null) {
      keeper.keep(el, target, wall);
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
      const startLatency = keeper.startLatency();
      const startAt = span.start - preroll - startLatency - START_MARGIN;
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
      play(el);
    }
    return rolling;
  };

  /** The elements at `at`: the live clips shown and in step, the next ones prepared, the rest hidden then paused. */
  const applyLayers = (at: number) => {
    const { spans, soundOn, stack } = latest.current;
    let layers = layersFor(spans, at, stack);
    // A clip whose element reached its Out just ahead of the clock hands over to the one cut to after it now
    const done = layers.find(({ span }) => {
      const el = elementOf(span);
      return (
        el !== null &&
        span.end > at &&
        span.end - at <= END_SLACK &&
        el.currentTime >= span.clip.inSec + span.length - 1e-3 &&
        spans.some((other) => other.length > 0 && other.start > at && other.start <= span.end + 1e-9)
      );
    });
    if (done) layers = layersFor(spans, done.span.end, stack);
    const live = new Map<HTMLVideoElement, PreviewLayer>();
    for (const layer of layers) {
      const el = elementOf(layer.span);
      if (el) live.set(el, layer);
    }
    const first = live.entries().next().value;
    front = first?.[0] ?? null;
    frontSpan = first?.[1].span ?? null;
    const rolling = prepare(at, live);
    if (wall !== null) keeper.learn(wall);

    // A clip coming into view whose element cannot show a frame of it yet (still seeking, short of its In after a
    // late start, or its last frame out an older one): the picture stays on what it showed (the elements' opacities
    // and the canvas as they are), what left it still, until the clip has a frame
    const incoming = (el: HTMLVideoElement) => !((shown.get(el) ?? 0) > 0);
    let hold = false;
    for (const [el, layer] of live) {
      if (!(layer.opacity > 0) || !incoming(el)) continue;
      const target = sourceTimeAt(layer.span, at);
      const short = el.currentTime < layer.span.clip.inSec - SEEK_TOLERANCE;
      const last = presented.current.get(el);
      const stale = last !== undefined && !el.paused && last < target - STALE_FRAME;
      if (!presentable(el) || short || stale) hold = true;
    }
    if (hold) {
      holdingSince ??= at;
      if (at - holdingSince > HOLD_MAX) hold = false;
    } else {
      holdingSince = null;
    }

    for (const [el, layer] of live) {
      follow(el, sourceTimeAt(layer.span, at));
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

  /**
   * Priming: the elements started at `from`, the audio clips stopped, until the front element has moved PRIME_MOVED
   * from where its start landed (or PRIME_MAX passed, or nothing is in front). Returns whether it still waits, and
   * otherwise sets the clock off from where that element is (its own time on its clip's span).
   */
  const prime = (now: number) => {
    primeSince ??= now;
    applyLayers(from);
    const el = front;
    // The front can change while waiting (it reached its Out): measured from the new one's start
    if (el !== primeEl) {
      primeEl = el;
      primeFrom = null;
      primeLanded = null;
    }
    if (el && primeFrom === null && !el.paused && !el.seeking) {
      primeFrom = el.currentTime;
      primeLanded = now;
    }
    const moved = el && primeFrom !== null ? el.currentTime - primeFrom : 0;
    if (el && !el.ended && moved < PRIME_MOVED && now - primeSince < PRIME_MAX * 1000) return true;
    priming = false;
    // How long it took from its start to moving teaches the latency the next clips are started ahead by
    if (el && primeLanded !== null && moved >= PRIME_MOVED) keeper.learnStart((now - primeLanded) / 1000 - moved);
    // From where the picture is, never back
    if (el && frontSpan && primeFrom !== null) from = Math.max(from, frontSpan.start + (el.currentTime - frontSpan.clip.inSec));
    anchor = now;
    return false;
  };

  const tick = (now: number) => {
    const s = useStitchEditorStore.getState();
    wall = now / 1000;
    // The playhead was moved from outside (Go to start, the ruler): the clock carries on from there once the clip in
    // front is moving again, and the audio clips with it
    if (Math.abs(s.playhead - written) > 1e-6) {
      from = s.playhead;
      written = s.playhead;
      priming = true;
      primeSince = null;
      primeEl = null;
      primeFrom = null;
      primeLanded = null;
      primed = new WeakSet();
      refused = new WeakSet();
      holdingSince = null;
      sound.pause();
    }
    if (priming && prime(now)) {
      frame = requestAnimationFrame(tick);
      return;
    }
    const at = from + Math.max(0, now - anchor) / 1000;
    const { total } = latest.current;
    if (at >= total) return stop(total);
    // Drawn every frame; the store's playhead, which the rest of the editor renders on, only every
    // PLAYHEAD_WRITE_SEC (and exactly at a pause, a key or a press: flush)
    clockAt = at;
    setLivePlayhead(at);
    if (Math.abs(at - written) >= PLAYHEAD_WRITE_SEC) {
      written = at;
      s.setPlayhead(at);
    }
    applyLayers(at);
    sound.apply(at, wall);
    frame = requestAnimationFrame(tick);
  };

  /**
   * A key or a press while playing (before what it does reads the playhead): the store's playhead is written where
   * the clock is, so a split, a paste or a move made now lands on the frame shown.
   */
  const flush = () => {
    if (priming || written === clockAt) return;
    written = clockAt;
    useStitchEditorStore.getState().setPlayhead(clockAt);
  };

  // Started at once, inside the press that asked for it; the clock sets off once the clip in front moves
  applyLayers(from);
  if (!front && layersFor(latest.current.spans, from, latest.current.stack).length > 0) {
    // Nothing to show where something should play (no element yet): nothing to follow
    stop();
    return () => {
      alive = false;
    };
  }
  frame = requestAnimationFrame(tick);
  window.addEventListener("keydown", flush, true);
  window.addEventListener("pointerdown", flush, true);

  return () => {
    alive = false;
    cancelAnimationFrame(frame);
    window.removeEventListener("keydown", flush, true);
    window.removeEventListener("pointerdown", flush, true);
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
  const presented = useRef(new WeakMap<HTMLVideoElement, number>());
  // Each element's frame callback, to stop when it leaves
  const frameWatches = useRef(new WeakMap<HTMLVideoElement, number>());
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
      const watch = previous ? frameWatches.current.get(previous) : undefined;
      if (previous && watch !== undefined) previous.cancelVideoFrameCallback?.(watch);
      if (el) {
        el.addEventListener("seeked", onSeeked);
        el.addEventListener("loadedmetadata", onLoadedMetadata);
        videos.current.set(clipId, el);
        if (typeof el.requestVideoFrameCallback === "function") {
          const onFrame: VideoFrameRequestCallback = (_now, frame) => {
            presented.current.set(el, frame.mediaTime);
            frameWatches.current.set(el, el.requestVideoFrameCallback(onFrame));
          };
          frameWatches.current.set(el, el.requestVideoFrameCallback(onFrame));
        }
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
    return runLoop({ videos, audios, canvas, pendingSeeks, latest, presented });
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
