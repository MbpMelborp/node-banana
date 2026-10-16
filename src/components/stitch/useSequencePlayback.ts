import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { gainAt } from "@/lib/stitch/curve";
import { sourceTimeAt, spanAtTime, type ClipSpan } from "@/lib/stitch/timeline";
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
 */

export interface SequencePlaybackOptions {
  spans: ClipSpan[];
  total: number;
  /** The playable URL of a clip's source, or null when it has none. */
  srcFor: (clipId: string) => string | null;
  music: { src: string | null; curve: VolumePoint[]; muted: boolean };
  soundOn: boolean;
}

/** Seconds before a clip's Out at which the next one takes over (a frame early beats a frame of the trimmed part). */
const END_SLACK = 0.03;
/** A paused element this far from its target is seeked. */
const SEEK_TOLERANCE = 0.02;
/** The music is re-synced when it drifts this far from the playhead. */
const MUSIC_DRIFT = 0.25;
/** The next clip's element is seeked to its In this long before the join. */
const PRESEEK = 0.5;

function nextSpan(spans: readonly ClipSpan[], after: ClipSpan): ClipSpan | null {
  return spans.find((s) => s.index > after.index && s.length > 0) ?? null;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));

export function useSequencePlayback(opts: SequencePlaybackOptions): {
  registerVideo: (src: string, el: HTMLVideoElement | null) => void;
  registerAudio: (el: HTMLAudioElement | null) => void;
  activeSrc: string | null;
} {
  const playing = useStitchEditorStore((s) => s.playing);
  // A string or null: the root re-renders when the source under the playhead changes, not per frame
  const activeSrc = useStitchEditorStore((s) => {
    const span = spanAtTime(opts.spans, s.playhead);
    return span ? opts.srcFor(span.clip.id) : null;
  });
  const videos = useRef(new Map<string, HTMLVideoElement>());
  const audio = useRef<HTMLAudioElement | null>(null);
  // A seek asked for while the element is still seeking: only the latest target is kept
  const pendingSeeks = useRef(new WeakMap<HTMLVideoElement, number>());
  const latest = useRef(opts);
  useLayoutEffect(() => {
    latest.current = opts;
  });

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

  const registerVideo = useCallback(
    (src: string, el: HTMLVideoElement | null) => {
      const previous = videos.current.get(src);
      if (previous === el) return;
      previous?.removeEventListener("seeked", onSeeked);
      if (el) {
        el.addEventListener("seeked", onSeeked);
        videos.current.set(src, el);
      } else {
        videos.current.delete(src);
      }
    },
    [onSeeked],
  );

  const registerAudio = useCallback((el: HTMLAudioElement | null) => {
    audio.current = el;
  }, []);

  // Paused: show the frame under the playhead
  const seekPaused = useCallback(() => {
    const s = useStitchEditorStore.getState();
    if (s.playing) return;
    const span = spanAtTime(latest.current.spans, s.playhead);
    const src = span ? latest.current.srcFor(span.clip.id) : null;
    const el = src ? videos.current.get(src) : undefined;
    if (span && el) seek(el, sourceTimeAt(span, s.playhead));
  }, [seek]);

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

  // Playing: the frame loop
  useEffect(() => {
    if (!playing) return;
    // A play() refusal that lands after this session ended must not stop the next one
    let alive = true;
    const store = useStitchEditorStore.getState();
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
    // The music element play() was last asked of; asked again after it stops at its end, a jump or a new element
    let musicAsked: HTMLAudioElement | null = null;

    const applyVolumes = (at: number) => {
      const { music, soundOn } = latest.current;
      if (el && span) {
        el.muted = span.clip.muted || !soundOn;
        el.volume = clamp01(span.clip.volume);
      }
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
        musicAsked = null;
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
