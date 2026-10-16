import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { gainAt } from "@/lib/stitch/curve";
import { layersAt, sourceTimeAt, spanAtTime, type ClipSpan } from "@/lib/stitch/timeline";
import type { VolumePoint } from "@/types";

/**
 * The editor's preview: one <video> per source, the one under the playhead
 * shown, switched at each join, with the clip's mute and volume and the
 * music's curve applied to the elements (element volume rather than Web
 * Audio, so a source served without CORS still sounds). A short freeze at a
 * join is accepted; the encode is the truth. The preview plays one loop.
 *
 * Paused, the active element is seeked to the frame under the playhead.
 * Playing, a frame loop reads the active element's time back into the
 * playhead and moves to the next clip at its Out.
 *
 * The hook does not subscribe to the playhead itself: the frame loop writes
 * it every frame, and the editor's root (which calls this) would re-render
 * with it. It re-renders only when the source under the playhead changes.
 *
 * Stacked (`stack` set): one <video> per clip, registered by clip id, since
 * two pieces of one source can play at once. At an overlap both elements
 * play: the earlier is the clock until its Out, then the later one, already
 * playing, takes over without a seek. Opacity and volume come from layersAt
 * and are written to the elements every frame, never through React.
 */

export interface SequencePlaybackOptions {
  spans: ClipSpan[];
  total: number;
  /** The playable URL of a clip's source, or null when it has none. */
  srcFor: (clipId: string) => string | null;
  music: { src: string | null; curve: VolumePoint[]; muted: boolean };
  soundOn: boolean;
  /** Stacked: elements per clip, blended at overlaps. Absent or null: Track. */
  stack?: { crossfade: boolean } | null;
}

/** Seconds before a clip's Out at which the next one takes over (a frame early beats a frame of the trimmed part). */
const END_SLACK = 0.03;
/** A paused element this far from its target is seeked. */
const SEEK_TOLERANCE = 0.02;
/** The music is re-synced when it drifts this far from the playhead. */
const MUSIC_DRIFT = 0.25;
/** The next clip's element is seeked to its In this long before the join. */
const PRESEEK = 0.5;
/** Stacked: a paused element this close to its target (its pre-seek landed) is played without another seek. */
const LANDED = 0.08;
/** Stacked: a second playing layer this far from the clock is seeked back into step. */
const LAYER_DRIFT = 0.15;

function nextSpan(spans: readonly ClipSpan[], after: ClipSpan): ClipSpan | null {
  return spans.find((s) => s.index > after.index && s.length > 0) ?? null;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));

/**
 * The music under a playing preview: its mute and the curve's gain, started from the playhead when it is not
 * playing, re-synced when it drifts, stopped past its end. reset() asks it to play again (a jump).
 */
function createMusicDriver(audio: RefObject<HTMLAudioElement | null>, latest: RefObject<SequencePlaybackOptions>) {
  // The music element play() was last asked of; asked again after it stops at its end, a jump or a new element
  let musicAsked: HTMLAudioElement | null = null;
  return {
    reset() {
      musicAsked = null;
    },
    apply(at: number) {
      const { music, soundOn } = latest.current;
      const track = audio.current;
      if (!track) return;
      track.muted = music.muted || !soundOn;
      track.volume = clamp01(gainAt(music.curve, at));
      const length = track.duration;
      if (Number.isFinite(length) && at >= length) {
        if (!track.paused) track.pause();
        musicAsked = null;
        return;
      }
      if (!music.src) return;
      if (track.paused && musicAsked !== track) {
        // Starting, back inside the music after it ended, or a remounted element
        musicAsked = track;
        track.currentTime = at;
        track.play().catch(() => undefined);
      } else if (Math.abs(track.currentTime - at) > MUSIC_DRIFT) {
        track.currentTime = at;
      }
    },
  };
}

/** What both frame loops share: the registered elements, the options as last rendered, and the seek queue. */
interface PlaybackRefs {
  videos: RefObject<Map<string, HTMLVideoElement>>;
  audio: RefObject<HTMLAudioElement | null>;
  pendingSeeks: RefObject<WeakMap<HTMLVideoElement, number>>;
  latest: RefObject<SequencePlaybackOptions>;
}

/**
 * Stacked, playing. The clock is the earliest live layer: its element's time is the playhead. Every frame each live
 * layer gets its opacity and volume; a layer that is not playing yet is started (seeked only when its pre-seek has
 * not landed), one that drifts is put back in step; every other element is paused and hidden. At the clock's Out the
 * next clip, when it is already playing through the overlap, becomes the clock as it is; otherwise it is started at
 * its start (a cut). Returns the loop's cleanup.
 */
function runStackedLoop({ videos, audio, pendingSeeks, latest }: PlaybackRefs): () => void {
  let alive = true;
  const store = useStitchEditorStore.getState();
  const music = createMusicDriver(audio, latest);
  const elementOf = (span: ClipSpan) => videos.current.get(span.clip.id) ?? null;
  const pauseAll = () => {
    for (const el of videos.current.values()) el.pause();
    audio.current?.pause();
  };
  const stop = (at?: number) => {
    pauseAll();
    const s = useStitchEditorStore.getState();
    s.setPlaying(false);
    if (at !== undefined) s.setPlayhead(at);
  };

  let t = store.playhead;
  if (t >= latest.current.total - 0.001) {
    t = 0;
    store.setPlayhead(0);
  }
  let clock: ClipSpan | null = null;
  let clockEl: HTMLVideoElement | null = null;
  // After a hand-over the new clock may sit a hair behind the old one's Out: the playhead never goes back past it
  let floor = 0;
  let written = t;
  let preseeked: string | null = null;
  let frame = 0;

  /** play(), where only a refusal by the clock stops the preview (an AbortError is a pause, not a refusal). */
  const play = (el: HTMLVideoElement) => {
    el.play().catch((error: unknown) => {
      if (!alive || el !== clockEl) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      useStitchEditorStore.getState().setPlaying(false);
    });
  };

  const applyLayers = (at: number) => {
    const { spans, soundOn, stack } = latest.current;
    const live = new Set<HTMLVideoElement>();
    for (const layer of layersAt(spans, at, stack?.crossfade ?? true)) {
      const el = elementOf(layer.span);
      if (!el) continue;
      live.add(el);
      el.style.opacity = String(layer.opacity);
      el.muted = layer.span.clip.muted || !soundOn;
      el.volume = clamp01(layer.span.clip.volume * layer.gain);
      if (el === clockEl) continue;
      const target = sourceTimeAt(layer.span, at);
      if (el.paused) {
        pendingSeeks.current.delete(el);
        if (Math.abs(el.currentTime - target) > LANDED) el.currentTime = target;
        play(el);
      } else if (Math.abs(el.currentTime - target) > LAYER_DRIFT) {
        el.currentTime = target;
      }
    }
    for (const el of videos.current.values()) {
      if (live.has(el)) continue;
      if (!el.paused) el.pause();
      el.style.opacity = "0";
    }
  };

  /** Makes the earliest clip at `at` the clock, from its own source time. false when there is nothing to play there. */
  const startAt = (at: number): boolean => {
    const { spans, stack } = latest.current;
    const first = layersAt(spans, at, stack?.crossfade ?? true)[0];
    const el = first ? elementOf(first.span) : null;
    if (!first || !el) return false;
    clock = first.span;
    clockEl = el;
    floor = 0;
    preseeked = null;
    // A paused seek still in flight would pull the playing element back when it lands
    pendingSeeks.current.delete(el);
    const target = sourceTimeAt(first.span, at);
    if (!el.paused || Math.abs(el.currentTime - target) > LANDED) el.currentTime = target;
    applyLayers(at);
    music.apply(at);
    play(el);
    return true;
  };

  if (!startAt(t)) {
    stop();
    return () => {
      alive = false;
    };
  }

  const tick = () => {
    const s = useStitchEditorStore.getState();
    const current = clock;
    const currentEl = clockEl;
    if (!current || !currentEl) return;
    // The playhead was moved from outside (Go to start, the ruler): carry on from there
    if (Math.abs(s.playhead - written) > 1e-6) {
      written = s.playhead;
      music.reset();
      if (!startAt(s.playhead)) return stop();
      frame = requestAnimationFrame(tick);
      return;
    }
    const { spans, total } = latest.current;
    // An edit while playing can remove or reshape the clip under the playhead
    const live = spans.find((x) => x.clip.id === current.clip.id) ?? null;
    if (!live) return stop();
    clock = live;
    // The clip's <video> was remounted: hand playback over to the new one
    if (elementOf(live) !== currentEl) {
      if (!startAt(written)) return stop();
      frame = requestAnimationFrame(tick);
      return;
    }
    // The clock's element reloaded in place (a data: to blob: swap): the load paused it and sent it back to 0
    if (currentEl.paused && !currentEl.ended) {
      if (!startAt(written)) return stop();
      frame = requestAnimationFrame(tick);
      return;
    }
    const sourceTime = currentEl.currentTime;
    const at = Math.max(floor, Math.min(live.end, Math.max(live.start, live.start + (sourceTime - live.clip.inSec))));
    if (sourceTime >= live.clip.inSec + live.length - END_SLACK || currentEl.ended) {
      const following = nextSpan(spans, live);
      if (!following) return stop(total);
      const followingEl = elementOf(following);
      if (followingEl && followingEl !== currentEl && !followingEl.paused && following.start < live.end) {
        // Already playing through the overlap: it takes over as it is
        clock = following;
        clockEl = followingEl;
        floor = live.end;
        const next = following.start + (followingEl.currentTime - following.clip.inSec);
        written = Math.min(following.end, Math.max(floor, next));
        s.setPlayhead(written);
        applyLayers(written);
        music.apply(written);
      } else {
        written = following.start;
        s.setPlayhead(following.start);
        if (!startAt(following.start)) return stop();
      }
    } else {
      written = at;
      s.setPlayhead(at);
      applyLayers(at);
      music.apply(at);
      // Seek the next clip's element to its In ahead of its start
      const following = nextSpan(spans, live);
      if (following && preseeked !== following.clip.id && following.start - at < PRESEEK) {
        const nextEl = elementOf(following);
        if (nextEl && nextEl !== currentEl && nextEl.paused) {
          pendingSeeks.current.delete(nextEl);
          nextEl.currentTime = following.clip.inSec;
        }
        preseeked = following.clip.id;
      }
    }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);

  return () => {
    alive = false;
    cancelAnimationFrame(frame);
    pauseAll();
  };
}

export function useSequencePlayback(opts: SequencePlaybackOptions): {
  registerVideo: (key: string, el: HTMLVideoElement | null) => void;
  registerAudio: (el: HTMLAudioElement | null) => void;
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
  const audio = useRef<HTMLAudioElement | null>(null);
  // A seek asked for while the element is still seeking: only the latest target is kept
  const pendingSeeks = useRef(new WeakMap<HTMLVideoElement, number>());
  const latest = useRef(opts);
  useLayoutEffect(() => {
    latest.current = opts;
  });
  const stacked = Boolean(opts.stack);
  const crossfade = opts.stack?.crossfade ?? true;

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
      // Every clip at the playhead, at its opacity; the rest hidden
      const shown = new Set<HTMLVideoElement>();
      for (const layer of layersAt(spans, s.playhead, stack.crossfade)) {
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

  const registerAudio = useCallback((el: HTMLAudioElement | null) => {
    audio.current = el;
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
  // On a switch of layout either way (the elements are new: at Overlap 0 nothing else changes), of crossfade (Stacked blends
  // differently) and on a new URL
  useEffect(() => {
    seekPaused();
  }, [stacked, crossfade, opts.srcFor, seekPaused]);

  // Playing: the frame loop
  useEffect(() => {
    if (!playing) return;
    if (latest.current.stack) return runStackedLoop({ videos, audio, pendingSeeks, latest });
    // A play() refusal that lands after this session ended must not stop the next one
    let alive = true;
    const store = useStitchEditorStore.getState();
    const music = createMusicDriver(audio, latest);
    const pauseAll = () => {
      for (const el of videos.current.values()) el.pause();
      audio.current?.pause();
    };
    const stop = (at?: number) => {
      pauseAll();
      const s = useStitchEditorStore.getState();
      s.setPlaying(false);
      if (at !== undefined) s.setPlayhead(at);
    };

    let t = store.playhead;
    if (t >= latest.current.total - 0.001) {
      t = 0;
      store.setPlayhead(0);
    }
    let span: ClipSpan | null = null;
    let el: HTMLVideoElement | null = null;
    let written = t;
    let preseeked: ClipSpan | null = null;
    let frame = 0;

    const applyVolumes = (at: number) => {
      const { soundOn } = latest.current;
      if (el && span) {
        el.muted = span.clip.muted || !soundOn;
        el.volume = clamp01(span.clip.volume);
      }
      music.apply(at);
    };

    /** Starts the clip under `at` from its own source time. false when there is nothing to play there. */
    const startAt = (at: number): boolean => {
      const nextSpanAt = spanAtTime(latest.current.spans, at);
      const src = nextSpanAt ? latest.current.srcFor(nextSpanAt.clip.id) : null;
      const nextEl = src ? (videos.current.get(src) ?? null) : null;
      if (!nextSpanAt || !nextEl) return false;
      if (el && el !== nextEl) el.pause();
      span = nextSpanAt;
      el = nextEl;
      preseeked = null;
      // A paused seek still in flight would pull the playing element back when it lands
      pendingSeeks.current.delete(el);
      el.currentTime = sourceTimeAt(span, at);
      applyVolumes(at);
      // Only a refusal of the element playing now stops the preview. A pending play() is
      // rejected with AbortError when its element is paused (a move to another source,
      // an advance before it started) or leaves the page (the data: to blob: swap).
      const started = el;
      el.play().catch((error: unknown) => {
        if (!alive || started !== el) return;
        if (error instanceof DOMException && error.name === "AbortError") return;
        useStitchEditorStore.getState().setPlaying(false);
      });
      return true;
    };

    // startAt also starts the music (applyVolumes)
    if (!startAt(t)) {
      stop();
      return;
    }

    const tick = () => {
      const s = useStitchEditorStore.getState();
      const current = span;
      const currentEl = el;
      if (!current || !currentEl) return;
      // The playhead was moved from outside (Go to start, the ruler): carry on from there
      if (Math.abs(s.playhead - written) > 1e-6) {
        written = s.playhead;
        // The music is asked to play again from there, if it had stopped
        music.reset();
        if (!startAt(s.playhead)) return stop();
        frame = requestAnimationFrame(tick);
        return;
      }
      const { spans, total, srcFor } = latest.current;
      // An edit while playing can remove or reshape the clip under the playhead
      const live = spans.find((x) => x.clip.id === current.clip.id) ?? null;
      if (!live) return stop();
      span = live;
      // The source's <video> was remounted (its playable URL changed): hand playback over to the new one
      const liveSrc = srcFor(live.clip.id);
      const liveEl = liveSrc ? videos.current.get(liveSrc) : undefined;
      if (liveEl !== currentEl) {
        if (!liveEl || !startAt(written)) return stop();
        frame = requestAnimationFrame(tick);
        return;
      }
      const sourceTime = currentEl.currentTime;
      const at = Math.min(live.end, Math.max(live.start, live.start + (sourceTime - live.clip.inSec)));
      if (sourceTime >= live.clip.inSec + live.length - END_SLACK || currentEl.ended) {
        const following = nextSpan(spans, live);
        if (!following) return stop(total);
        written = following.start;
        s.setPlayhead(following.start);
        if (!startAt(following.start)) return stop();
      } else {
        written = at;
        s.setPlayhead(at);
        applyVolumes(at);
        // Seek the next clip's element ahead of the join, when it is another element
        const following = nextSpan(spans, live);
        if (following && preseeked !== following && live.end - at < PRESEEK) {
          const src = srcFor(following.clip.id);
          const nextEl = src ? videos.current.get(src) : undefined;
          if (nextEl && nextEl !== currentEl) {
            pendingSeeks.current.delete(nextEl);
            nextEl.currentTime = following.clip.inSec;
          }
          preseeked = following;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      pauseAll();
    };
  }, [playing]);

  // Pause everything when the editor goes away
  useEffect(() => {
    const elements = videos.current;
    const track = audio;
    return () => {
      for (const el of elements.values()) el.pause();
      track.current?.pause();
    };
  }, []);

  return useMemo(() => ({ registerVideo, registerAudio, activeSrc }), [registerVideo, registerAudio, activeSrc]);
}
