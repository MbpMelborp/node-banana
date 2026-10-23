import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { livePlayhead, PLAYHEAD_WRITE_SEC, useStitchEditorStore } from "@/store/stitchEditorStore";
import { gainAt } from "@/lib/stitch/curve";
import {
  clipSpans,
  createClip,
  layoutSpans,
  sourceTimeAt,
  spansEnd,
  spanWarpMap,
  type ClipSpan,
  type SourceKey,
} from "@/lib/stitch/timeline";
import type { ClipWarp, ClipWarpCurve } from "@/types";
import { useSequencePlayback, type AudioPlaybackClip, type SequencePlaybackOptions } from "../useSequencePlayback";
import { baseRate, driftScale, MIN_PLAYBACK_RATE, MIN_START_RATE, OUT_MARGIN, soundShare } from "../warpPlayback";

// The preview engine against stand-in media elements and a hand-driven frame loop. A playing stand-in advances with
// the frames' timestamps, as a real element runs on its own; a seek can take time (seekMs) before it lands, and a start
// (startMs: an element with sound waits for the sound output) before it moves; its sound turned on while it plays
// silent counts a switch (soundSwitches).

interface FakeMedia {
  currentTime: number;
  paused: boolean;
  ended: boolean;
  seeking: boolean;
  muted: boolean;
  volume: number;
  playbackRate: number;
  preservesPitch: boolean;
  readyState: number;
  duration: number;
  videoWidth: number;
  videoHeight: number;
  style: { opacity: string };
  /** currentTime writes. */
  writes: number;
  /** Every currentTime written, in order. */
  seekTargets: number[];
  /** currentTime writes while a seek was still in flight. */
  writesWhileSeeking: number;
  /** playbackRate writes taken. */
  rateWrites: number;
  /** Rates written that a browser refuses (it throws for each, keeping the rate it had). */
  rateRejected: number[];
  /** Each play(): the rate and pitch it started at. */
  plays: Array<{ rate: number; preservesPitch: boolean }>;
  /**
   * Times its sound was turned on while it played silent (unmuted, or raised from 0): a browser moves such an element's
   * sound to the speakers then, and its picture stops while it does.
   */
  soundSwitches: number;
  /** Stands still while playing (a stall, as on a buffer underrun). */
  frozen: boolean;
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  /** Moves a playing element on by `ms` of the frames' time, and lands a seek whose time has come. */
  advance(ms: number, now: number): void;
  requestVideoFrameCallback: (callback: VideoFrameRequestCallback) => number;
  /**
   * Shows a frame of `mediaTime`, sent to the screen now (the last frame's time): what requestVideoFrameCallback
   * reports, only when called, so a test decides.
   */
  present(mediaTime: number): void;
}

/** Every stand-in made since the test began, advanced by flushFrame. */
let made: FakeMedia[] = [];

function fakeMedia({
  duration = Number.NaN,
  seekMs = 0,
  startMs = 0,
}: { duration?: number; seekMs?: number; startMs?: number } = {}): FakeMedia {
  let time = 0;
  // Still until then after a play()
  let startsAt: number | null = null;
  let starting = false;
  let muted = false;
  let volume = 1;
  let rate = 1;
  let landsAt: number | null = null;
  let target = 0;
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const emit = (type: string) => {
    for (const listener of listeners.get(type) ?? []) listener({ currentTarget: media } as unknown as Event);
  };
  const media: FakeMedia = {
    get currentTime() {
      return time;
    },
    set currentTime(value: number) {
      media.seekTargets.push(value);
      if (media.seeking) media.writesWhileSeeking++;
      media.writes++;
      media.ended = false;
      time = value;
      if (seekMs <= 0) return;
      // Reports the new time at once, as a real element does, but stands still until the seek lands seekMs after the
      // next frame
      media.seeking = true;
      target = value;
      landsAt = null;
    },
    paused: true,
    ended: false,
    seeking: false,
    get muted() {
      return muted;
    },
    set muted(value: boolean) {
      if (!value && muted && volume > 0 && !media.paused) media.soundSwitches++;
      muted = value;
    },
    get volume() {
      return volume;
    },
    set volume(value: number) {
      if (value > 0 && volume === 0 && !muted && !media.paused) media.soundSwitches++;
      volume = value;
    },
    get playbackRate() {
      return rate;
    },
    // As Chromium's: 0 or 1/16-16 taken, anything else refused (NotSupportedError; non-finite, TypeError), kept
    set playbackRate(value: number) {
      if (!Number.isFinite(value) || !(value === 0 || (value >= 0.0625 && value <= 16))) {
        media.rateRejected.push(value);
        if (!Number.isFinite(value)) throw new TypeError("The provided double value is non-finite.");
        throw new DOMException(`The provided playback rate (${value}) is not in the supported playback range.`, "NotSupportedError");
      }
      rate = value;
      media.rateWrites++;
    },
    preservesPitch: true,
    // HAVE_METADATA while a seek is in flight, as Chromium reports
    get readyState() {
      return media.seeking ? 1 : 4;
    },
    duration,
    videoWidth: 1280,
    videoHeight: 720,
    style: { opacity: "" },
    writes: 0,
    seekTargets: [],
    writesWhileSeeking: 0,
    rateWrites: 0,
    rateRejected: [],
    plays: [],
    soundSwitches: 0,
    frozen: false,
    play: vi.fn(() => {
      media.plays.push({ rate: media.playbackRate, preservesPitch: media.preservesPitch });
      if (media.paused) starting = startMs > 0;
      media.paused = false;
      return Promise.resolve();
    }),
    pause: vi.fn(() => {
      media.paused = true;
      // A start not yet made is given up: played again, it waits its whole start again
      startsAt = null;
    }),
    addEventListener: vi.fn((type: string, listener: (event: Event) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: (event: Event) => void) => {
      listeners.get(type)?.delete(listener);
    }),
    advance(ms: number, now: number) {
      if (media.seeking) {
        landsAt ??= now + seekMs;
        if (now < landsAt) return;
        media.seeking = false;
        landsAt = null;
        time = target;
        emit("seeked");
        return;
      }
      if (media.paused || media.frozen || ms <= 0) return;
      if (starting) {
        startsAt ??= now - ms + startMs;
        if (now < startsAt) return;
        ms = now - startsAt;
        starting = false;
        startsAt = null;
      }
      time += (ms / 1000) * media.playbackRate;
      if (Number.isFinite(media.duration) && time >= media.duration) {
        time = media.duration;
        media.ended = true;
        media.paused = true;
      }
    },
  };
  let frameCallbacks: VideoFrameRequestCallback[] = [];
  media.requestVideoFrameCallback = (callback) => {
    frameCallbacks.push(callback);
    return frameCallbacks.length;
  };
  media.present = (mediaTime) => {
    const callbacks = frameCallbacks;
    frameCallbacks = [];
    for (const callback of callbacks) {
      callback(lastNow, { mediaTime, presentationTime: lastNow } as VideoFrameCallbackMetadata);
    }
  };
  made.push(media);
  return media;
}

/** A media element whose play() stays pending until pause() rejects it with AbortError, as browsers do. */
function pendingPlayMedia(): FakeMedia {
  const media = fakeMedia();
  let reject: ((error: unknown) => void) | null = null;
  media.play.mockImplementation(() => {
    media.paused = false;
    return new Promise<void>((_, rej) => {
      reject = rej;
    });
  });
  media.pause.mockImplementation(() => {
    media.paused = true;
    reject?.(new DOMException("The play() request was interrupted by a call to pause().", "AbortError"));
    reject = null;
  });
  return media;
}

/** Two clips, 5 s of source "a" then 5 s of source "b". */
function twoSourceOptions(): SequencePlaybackOptions {
  const first = createClip({ kind: "edge", edgeId: "e1" }, { id: "c1" });
  const second = createClip({ kind: "edge", edgeId: "e2" }, { id: "c2" });
  const spans = clipSpans(
    [first, second],
    new Map<SourceKey, number>([
      ["edge:e1", 5],
      ["edge:e2", 5],
    ]),
    0,
  );
  return {
    spans,
    total: 10,
    srcFor: (clipId) => (clipId === "c1" ? "blob:a" : "blob:b"),
    audio: { clips: [] },
    soundOn: true,
  };
}

const asVideo = (m: FakeMedia) => m as unknown as HTMLVideoElement;
/** Silent the preview's way: playing out at an inaudible volume, never muted (a browser stalls one it unmutes). */
const expectSilent = (m: FakeMedia) => {
  expect(m.muted).toBe(false);
  expect(m.volume).toBeGreaterThan(0);
  expect(m.volume).toBeLessThan(1e-4);
};
const asAudio = (m: FakeMedia) => m as unknown as HTMLAudioElement;

let frames: FrameRequestCallback[] = [];
let lastNow = 0;
/** One animation frame at `now` ms: the playing stand-ins move on by the time since the last, then the loop runs. */
const flushFrame = (now: number) =>
  act(() => {
    const elapsed = now - lastNow;
    lastNow = now;
    for (const media of made) media.advance(elapsed, now);
    const queue = frames;
    frames = [];
    for (const cb of queue) cb(now);
  });

const editor = () => useStitchEditorStore.getState();

/** An audio clip as the editor passes it: the music read from a node without audio clips by default. */
const audioClip = (init: Partial<AudioPlaybackClip> = {}): AudioPlaybackClip => ({
  id: "audio:music",
  src: "music.mp3",
  startSec: 0,
  inSec: 0,
  outSec: null,
  muted: false,
  curve: [],
  ...init,
});

/** One 10 s clip of source "a" (served at `url`), with music from "music.mp3". */
function options(url = "blob:a", music: string | null = "music.mp3", clips?: AudioPlaybackClip[]): SequencePlaybackOptions {
  const clip = createClip({ kind: "edge", edgeId: "e1" }, { id: "c1" });
  const spans = clipSpans([clip], new Map<SourceKey, number>([["edge:e1", 10]]), 0);
  return {
    spans,
    total: 10,
    srcFor: () => url,
    audio: { clips: clips ?? [audioClip({ src: music })] },
    soundOn: true,
  };
}

const warpOf = (init: Partial<ClipWarp>): ClipWarp => ({ speed: 1, curve: null, reverse: false, blend: false, ...init });
const preset = (name: string): ClipWarpCurve => ({ kind: "preset", name });

/** One clip from "blob:<edge>": its id, the edge, its source's seconds and createClip's init. */
type WarpedRow = [id: string, edge: string, source: number, init?: Parameters<typeof createClip>[1]];

/**
 * The rows' clips, `total` the spans' end: Track, or with `stack` Stacked at an overlap of 1 s (placed once some row
 * has a startSec, as placedOptions is).
 */
function warpedOptions(
  rows: WarpedRow[],
  stack?: { crossfade: boolean },
  audio: AudioPlaybackClip[] = [],
): SequencePlaybackOptions {
  const timeline = rows.map(([id, edge, , init]) => createClip({ kind: "edge", edgeId: edge }, { id, ...init }));
  const durations = new Map<SourceKey, number>(rows.map(([, edge, source]) => [`edge:${edge}` as SourceKey, source]));
  const spans = stack
    ? layoutSpans(timeline, durations, { mode: "stacked", overlapSec: 1, crossfade: stack.crossfade })
    : clipSpans(timeline, durations, 0);
  const src = new Map(rows.map(([id, edge]) => [id, `blob:${edge}`]));
  const placed = rows.some(([, , , init]) => init?.startSec !== undefined);
  return {
    spans,
    total: spansEnd(spans),
    srcFor: (clipId) => src.get(clipId) ?? null,
    audio: { clips: audio },
    soundOn: true,
    stack: stack ? { ...stack, placed } : null,
  };
}

/** The rows mounted, one stand-in each (its source's duration, src "blob:<edge>"), writes and seeks counted from here. */
function mountWarped(
  rows: WarpedRow[],
  { stack, audio, seekMs, startMs }: { stack?: { crossfade: boolean }; audio?: AudioPlaybackClip[]; seekMs?: number; startMs?: number } = {},
) {
  const opts = warpedOptions(rows, stack, audio);
  const hook = renderHook((o: SequencePlaybackOptions) => useSequencePlayback(o), { initialProps: opts });
  const media = new Map(
    rows.map(([id, edge, source]) => [id, Object.assign(fakeMedia({ duration: source, seekMs, startMs }), { src: `blob:${edge}` })]),
  );
  act(() => {
    for (const [id, m] of media) hook.result.current.registerVideo(id, asVideo(m));
  });
  for (const m of media.values()) {
    m.writes = 0;
    m.seekTargets = [];
  }
  return { ...hook, opts, el: (id: string) => media.get(id)! };
}

const FRAME = 1000 / 60;
const spanOf = (opts: SequencePlaybackOptions, id: string): ClipSpan => opts.spans.find((s) => s.clip.id === id)!;
/** Sequence seconds → the map's source seconds for clip `id` (through the spans, never worked out by hand). */
const targetOf = (opts: SequencePlaybackOptions, id: string, t: number) => sourceTimeAt(spanOf(opts, id), t);
/** The map's rate for clip `id` at sequence second t, as the preview reads it. */
const baseOf = (opts: SequencePlaybackOptions, id: string, t: number) => {
  const span = spanOf(opts, id);
  return baseRate(spanWarpMap(span)!, t - span.start);
};
/** |element − map| in sequence seconds, as the keeper weighs it. */
const lateness = (opts: SequencePlaybackOptions, id: string, m: FakeMedia, t: number) =>
  Math.abs(m.currentTime - targetOf(opts, id, t)) / driftScale(baseOf(opts, id, t));
/** The frame in effect at source time t of a 24 fps file (what an element shows and rVFC reports). */
const frame24 = (t: number) => Math.floor(t * 24 + 1e-9) / 24;
/** Rates a playing element may be at beside its own: nudged around 1. */
const NUDGED = [1, 0.98, 1.02, 0.95, 1.05];

beforeEach(() => {
  frames = [];
  made = [];
  lastNow = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    frames = [];
  });
  act(() => {
    editor().close();
    editor().setPlayhead(0);
    editor().setPlaying(false);
  });
});

afterEach(() => {
  act(() => editor().setPlaying(false));
  vi.unstubAllGlobals();
});

describe("useSequencePlayback", () => {
  it("does not re-render per playhead write while the same source stays under it", () => {
    let renders = 0;
    const opts = options();
    renderHook(() => {
      renders++;
      return useSequencePlayback(opts);
    });
    const before = renders;
    act(() => {
      editor().setPlayhead(1);
      editor().setPlayhead(2);
      editor().setPlayhead(3);
    });
    expect(renders).toBe(before);
  });

  it("moves the playhead on the frames' time, from where Play left it", () => {
    const opts = options(undefined, null);
    const { result } = renderHook(() => useSequencePlayback(opts));
    const video = fakeMedia();
    act(() => result.current.registerVideo("c1", asVideo(video)));
    act(() => editor().setPlayhead(2));
    act(() => editor().setPlaying(true));
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(video.currentTime).toBe(2);
    flushFrame(0);
    expect(livePlayhead()).toBe(2);
    // Set off once the clip moves, from where it is
    flushFrame(500);
    expect(livePlayhead()).toBeCloseTo(2.5, 9);
    flushFrame(1000);
    expect(livePlayhead()).toBeCloseTo(3, 9);
    // Paused: the clock stops
    act(() => editor().setPlaying(false));
    flushFrame(3000);
    expect(livePlayhead()).toBeCloseTo(3, 9);
  });

  it("draws the playhead every frame but writes the store's at most every PLAYHEAD_WRITE_SEC, exactly at a pause or a key", () => {
    const opts = options(undefined, null);
    const { result } = renderHook(() => useSequencePlayback(opts));
    // The editor's key hook, set up after this one, stops every key it handles from going further
    const editorKeys = (e: KeyboardEvent) => e.stopImmediatePropagation();
    window.addEventListener("keydown", editorKeys, true);
    const video = fakeMedia();
    act(() => result.current.registerVideo("c1", asVideo(video)));
    act(() => editor().setPlaying(true));
    flushFrame(0);
    flushFrame(100);
    let writes = 0;
    const unsubscribe = useStitchEditorStore.subscribe((s, prev) => {
      if (s.playhead !== prev.playhead) writes++;
    });
    for (let now = 116; now <= 1092; now += 16) flushFrame(now);
    // 62 frames over a second: the store's playhead every 7th (a 16 ms frame past 0.1 s)
    expect(livePlayhead()).toBeCloseTo(1.092, 9);
    expect(writes).toBeLessThanOrEqual(Math.ceil(1 / PLAYHEAD_WRITE_SEC));
    expect(writes).toBeGreaterThanOrEqual(8);
    // A key while playing: written where the clock is, before what the key does reads it
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "s" }));
    });
    expect(editor().playhead).toBeCloseTo(1.092, 9);
    flushFrame(1108);
    // A pause: exactly where the clock was
    act(() => editor().setPlaying(false));
    expect(editor().playhead).toBeCloseTo(1.108, 9);
    unsubscribe();
    window.removeEventListener("keydown", editorKeys, true);
  });

  it("holds the picture after a move back while playing, never preparing the clip still on screen", () => {
    const opts = twoSourceOptions();
    const { result } = renderHook(() => useSequencePlayback(opts));
    // The first clip's element takes 300 ms to seek back
    const a = fakeMedia({ duration: 5, seekMs: 300 });
    const b = fakeMedia({ duration: 5 });
    act(() => {
      result.current.registerVideo("c1", asVideo(a));
      result.current.registerVideo("c2", asVideo(b));
    });
    act(() => editor().setPlayhead(6));
    act(() => editor().setPlaying(true));
    flushFrame(0);
    flushFrame(100);
    expect(b.style.opacity).toBe("1");
    const writes = b.writes;
    // Back to 2 s: "a" seeks; meanwhile the picture stays on "b", still, and "b" (the next clip, from 0) waits
    act(() => editor().setPlayhead(2));
    flushFrame(116);
    flushFrame(232);
    expect(a.seeking).toBe(true);
    expect(b.style.opacity).toBe("1");
    expect(b.paused).toBe(true);
    expect(b.writes).toBe(writes);
    expect(a.style.opacity).toBe("0");
    // Landed and moving: "a" shows, and only now is "b" put at its In for later
    for (let now = 248; now <= 600; now += 16) flushFrame(now);
    expect(a.style.opacity).toBe("1");
    expect(b.style.opacity).toBe("0");
    expect(b.currentTime).toBe(0);
  });

  it("keeps the playhead moving while the clip's element stalls, and catches it up with one seek", () => {
    const opts = options(undefined, null);
    const { result } = renderHook(() => useSequencePlayback(opts));
    const video = fakeMedia();
    act(() => result.current.registerVideo("c1", asVideo(video)));
    act(() => editor().setPlaying(true));
    flushFrame(0);
    flushFrame(1000);
    expect(livePlayhead()).toBe(1);
    // The element stands still: the clock does not
    video.frozen = true;
    flushFrame(1200);
    expect(livePlayhead()).toBeCloseTo(1.2, 9);
    // 0.2 s behind: played faster, not seeked
    expect(video.playbackRate).toBe(1.05);
    expect(video.writes).toBe(0);
    // Past 0.25 s: seeked once, to where the clock will be when the seek lands
    flushFrame(1500);
    expect(livePlayhead()).toBeCloseTo(1.5, 9);
    expect(video.writes).toBe(1);
    expect(video.currentTime).toBeCloseTo(1.6, 9);
    expect(video.playbackRate).toBe(1);
    // Still stuck: no seek after seek, only the rate, until a second's cooldown
    flushFrame(1700);
    flushFrame(1900);
    expect(video.writes).toBe(1);
  });

  it("restarts an element left at a nudged rate at that rate, writing no rate", () => {
    const opts = twoSourceOptions();
    const { result } = renderHook(() => useSequencePlayback(opts));
    const [a, b] = [fakeMedia({ duration: 5 }), fakeMedia({ duration: 5 })];
    act(() => {
      result.current.registerVideo("c1", asVideo(a));
      result.current.registerVideo("c2", asVideo(b));
    });
    act(() => editor().setPlayhead(4));
    act(() => editor().setPlaying(true));
    let now = 0;
    flushFrame(now);
    for (let k = 0; k < 200 && livePlayhead() < 4.2; k++) flushFrame((now += 16));
    // 0.1 s behind: nudged 2 % faster, and cut away from while nudged (hidden, then paused)
    a.frozen = true;
    flushFrame((now += 100));
    a.frozen = false;
    for (let k = 0; k < 2000 && a.style.opacity === "1"; k++) flushFrame((now += 16));
    for (let k = 0; k < 3; k++) flushFrame((now += 16));
    expect(a.paused).toBe(true);
    const nudged = a.playbackRate;
    const writes = a.rateWrites;
    expect(nudged).not.toBe(1);
    // A move back into it while playing starts it again, as it was: the keeper's to bring back to 1
    act(() => editor().setPlayhead(4.5));
    flushFrame((now += 16));
    expect(a.plays.at(-1)!.rate).toBe(nudged);
    expect(a.rateWrites).toBe(writes);
  });

  it("waits for the clip in front to move before the clock and the music set off", () => {
    const opts = options();
    const { result } = renderHook(() => useSequencePlayback(opts));
    const video = fakeMedia({ seekMs: 300 });
    const music = fakeMedia({ duration: 30 });
    act(() => {
      result.current.registerVideo("c1", asVideo(video));
      result.current.registerAudio("audio:music", asAudio(music));
    });
    act(() => editor().setPlayhead(2));
    act(() => editor().setPlaying(true));
    // The paused seek to 2 is still running: nothing moves, the music waits
    flushFrame(0);
    flushFrame(200);
    expect(video.seeking).toBe(true);
    expect(livePlayhead()).toBe(2);
    expect(music.play).not.toHaveBeenCalled();
    // Landed, then moving: the clock sets off from where the picture is, the music with it
    flushFrame(400);
    expect(livePlayhead()).toBe(2);
    flushFrame(450);
    expect(livePlayhead()).toBeCloseTo(2.05, 9);
    expect(music.play).toHaveBeenCalledTimes(1);
    expect(music.currentTime).toBeCloseTo(2.1, 9);
  });

  it("waits for the clip in front again when Play is pressed again before it moved", () => {
    const opts = options(undefined, null);
    const { result } = renderHook(() => useSequencePlayback(opts));
    // A file with sound: a quarter of a second from each play() to moving
    const video = fakeMedia({ startMs: 250 });
    act(() => result.current.registerVideo("c1", asVideo(video)));
    act(() => editor().setPlayhead(2));
    act(() => editor().setPlaying(true));
    let now = 0;
    for (let k = 0; k < 6; k++) flushFrame((now += FRAME));
    // Paused before it moved, played again a second later: its start begins again
    act(() => editor().setPlaying(false));
    for (let k = 0; k < 60; k++) flushFrame((now += FRAME));
    act(() => editor().setPlaying(true));
    for (let k = 0; k < 12; k++) {
      flushFrame((now += FRAME));
      expect(video.currentTime).toBe(2);
      expect(livePlayhead()).toBe(2);
    }
    for (let k = 0; k < 30 && livePlayhead() === 2; k++) flushFrame((now += FRAME));
    // Set off once it moved, from where it is
    expect(livePlayhead()).toBeGreaterThan(2);
    expect(livePlayhead()).toBeLessThan(2.1);
  });

  it("stops at the sequence's end", () => {
    const opts = options(undefined, null);
    const { result } = renderHook(() => useSequencePlayback(opts));
    const video = fakeMedia();
    act(() => result.current.registerVideo("c1", asVideo(video)));
    act(() => editor().setPlayhead(9.5));
    act(() => editor().setPlaying(true));
    flushFrame(0);
    flushFrame(600);
    expect(editor().playing).toBe(false);
    expect(livePlayhead()).toBe(10);
    expect(video.paused).toBe(true);
  });

  it("starts the music again after a jump back from past its end", () => {
    const opts = options();
    const { result } = renderHook(() => useSequencePlayback(opts));
    const video = fakeMedia();
    const music = fakeMedia({ duration: 3 });
    act(() => {
      result.current.registerVideo("c1", asVideo(video));
      result.current.registerAudio("audio:music", asAudio(music));
    });
    act(() => editor().setPlaying(true));
    flushFrame(0);
    flushFrame(100);
    expect(music.play).toHaveBeenCalledTimes(1);

    // Play on past the music's 3 s: it stops
    flushFrame(5000);
    expect(livePlayhead()).toBe(5);
    expect(music.paused).toBe(true);

    // Go to start while playing: the music comes back from there once the picture moves again
    act(() => editor().setPlayhead(0));
    flushFrame(5100);
    expect(video.currentTime).toBe(0);
    flushFrame(5200);
    expect(livePlayhead()).toBeCloseTo(0.1, 9);
    expect(music.play).toHaveBeenCalledTimes(2);
    expect(music.paused).toBe(false);
    expect(music.currentTime).toBeCloseTo(0.15, 9);
  });

  it("asks a music element whose play() was refused only once, not every frame", () => {
    const opts = options();
    const { result } = renderHook(() => useSequencePlayback(opts));
    const video = fakeMedia();
    const music = fakeMedia({ duration: 30 });
    music.play.mockImplementation(() => Promise.reject(new Error("NotAllowedError")));
    act(() => {
      result.current.registerVideo("c1", asVideo(video));
      result.current.registerAudio("audio:music", asAudio(music));
    });
    act(() => editor().setPlaying(true));
    flushFrame(0);
    flushFrame(1000);
    flushFrame(2000);
    expect(music.play).toHaveBeenCalledTimes(1);
  });

  it("drives the music read from a legacy node on the clock, at its curve's gain", () => {
    const curve = [
      { t: 0, gain: 0 },
      { t: 4, gain: 1 },
    ];
    const opts = options("blob:a", "music.mp3", [audioClip({ curve })]);
    const { result } = renderHook(() => useSequencePlayback(opts));
    const video = fakeMedia();
    const music = fakeMedia({ duration: 30 });
    act(() => {
      result.current.registerVideo("c1", asVideo(video));
      result.current.registerAudio("audio:music", asAudio(music));
    });
    act(() => editor().setPlaying(true));
    flushFrame(0);
    flushFrame(100);
    // Started where the clock will be when it moves (its start latency on)
    expect(music.play).toHaveBeenCalledTimes(1);
    expect(music.currentTime).toBeCloseTo(0.15, 9);
    // The gain at the playhead, on the curve's own clock: sequence seconds for an untouched music clip
    flushFrame(1000);
    expect(music.volume).toBeCloseTo(gainAt(curve, 1), 6);
    // These stand-ins move at once, so it is 0.05 s ahead: slowed, never seeked
    expect(music.currentTime).toBeCloseTo(1.05, 9);
    expect(music.playbackRate).toBe(0.98);
    flushFrame(2000);
    flushFrame(3000);
    flushFrame(3500);
    // Back within 10 ms: its rate is 1 again
    expect(Math.abs(music.currentTime - 3.5)).toBeLessThan(0.01);
    expect(music.playbackRate).toBe(1);
    expect(music.writes).toBe(1);
    // A drift past 0.25 s is seeked, to where the clock will be when it lands
    music.currentTime = 4.1;
    flushFrame(3500);
    expect(music.currentTime).toBeCloseTo(3.6, 9);
    expect(music.play).toHaveBeenCalledTimes(1);
  });

  it("starts a clip that begins at 2 s just ahead of 2 s, from its In, at its curve's gain there", () => {
    const curve = [
      { t: 1, gain: 0.25 },
      { t: 3, gain: 1 },
    ];
    const opts = options("blob:a", null, [audioClip({ id: "aclip_1", src: "tone.m4a", startSec: 2, inSec: 1, curve })]);
    const { result } = renderHook(() => useSequencePlayback(opts));
    const video = fakeMedia();
    const tone = fakeMedia({ duration: 10 });
    act(() => {
      result.current.registerVideo("c1", asVideo(video));
      result.current.registerAudio("aclip_1", asAudio(tone));
    });
    act(() => editor().setPlaying(true));
    flushFrame(0);
    flushFrame(100);
    // Coming up: put at its In ahead, paused
    flushFrame(1500);
    expect(tone.paused).toBe(true);
    expect(tone.play).not.toHaveBeenCalled();
    expect(tone.currentTime).toBe(1);
    expect(tone.writes).toBe(1);
    // Its start latency before its start: played from there, so it is moving as the clock reaches it
    flushFrame(1960);
    expect(tone.play).toHaveBeenCalledTimes(1);
    // Inside its span: its In plus the time since its start, at the gain there, never seeked again
    flushFrame(2500);
    expect(tone.currentTime).toBeCloseTo(1.54, 9);
    expect(tone.volume).toBeCloseTo(gainAt(curve, 1.5), 6);
    expect(tone.writes).toBe(1);
  });

  it("pauses a clip past its Out and a muted clip stays silent", () => {
    const opts = options("blob:a", null, [audioClip({ id: "aclip_1", src: "tone.m4a", startSec: 0, inSec: 0, outSec: 2, muted: true })]);
    const { result } = renderHook(() => useSequencePlayback(opts));
    const video = fakeMedia();
    const tone = fakeMedia({ duration: 10 });
    act(() => {
      result.current.registerVideo("c1", asVideo(video));
      result.current.registerAudio("aclip_1", asAudio(tone));
    });
    act(() => editor().setPlaying(true));
    flushFrame(0);
    flushFrame(100);
    expectSilent(tone);
    expect(tone.play).toHaveBeenCalledTimes(1);
    flushFrame(2500);
    expect(tone.paused).toBe(true);
  });

  it("hands playback to a <video> remounted under the playhead", () => {
    const opts = options();
    const { result } = renderHook(() => useSequencePlayback(opts));
    const first = fakeMedia();
    act(() => result.current.registerVideo("c1", asVideo(first)));
    act(() => editor().setPlaying(true));
    flushFrame(0);
    flushFrame(1000);
    expect(livePlayhead()).toBe(1);

    // React swaps the clip's element: the old one is paused as it leaves, the new one picks up where the clock is
    const second = fakeMedia();
    act(() => {
      result.current.registerVideo("c1", null);
      result.current.registerVideo("c1", asVideo(second));
    });
    expect(first.paused).toBe(true);
    flushFrame(1000);
    expect(second.play).toHaveBeenCalledTimes(1);
    // Where the clock will be when it moves: its start latency on, which the first start taught (the least, 0.01 s:
    // these stand-ins move at once)
    expect(second.currentTime).toBeCloseTo(1.01, 9);
    expect(editor().playing).toBe(true);

    // And it plays on with the clock
    flushFrame(2000);
    expect(livePlayhead()).toBe(2);
    expect(Math.abs(second.currentTime - 2)).toBeLessThan(0.06);
  });

  it("keeps playing when a move to another source aborts the previous element's pending play()", async () => {
    const opts = twoSourceOptions();
    const { result } = renderHook(() => useSequencePlayback(opts));
    const a = pendingPlayMedia();
    const b = pendingPlayMedia();
    act(() => {
      result.current.registerVideo("c1", asVideo(a));
      result.current.registerVideo("c2", asVideo(b));
    });
    act(() => editor().setPlaying(true));
    // Moved from outside into the second source's clip: "a" is hidden at once and paused the next frame, before its
    // play() resolved
    act(() => editor().setPlayhead(6));
    flushFrame(0);
    flushFrame(16);
    await act(async () => {
      await Promise.resolve();
    });
    expect(a.pause).toHaveBeenCalled();
    expect(b.play).toHaveBeenCalledTimes(1);
    expect(editor().playing).toBe(true);
  });

  it("keeps playing when play starts in a clip's last frame and moves on before play() resolved", async () => {
    const opts = twoSourceOptions();
    const { result } = renderHook(() => useSequencePlayback(opts));
    const a = pendingPlayMedia();
    const b = pendingPlayMedia();
    act(() => {
      result.current.registerVideo("c1", asVideo(a));
      result.current.registerVideo("c2", asVideo(b));
    });
    act(() => editor().setPlayhead(4.98));
    act(() => editor().setPlaying(true));
    flushFrame(0);
    // "a" reaches its Out while the clock waits for it: "b" is in front now, and the clock waits for it instead
    flushFrame(60);
    expect(livePlayhead()).toBe(4.98);
    flushFrame(120);
    await act(async () => {
      await Promise.resolve();
    });
    // Set off from where "b" is
    expect(livePlayhead()).toBeCloseTo(5.06, 9);
    expect(b.play).toHaveBeenCalledTimes(1);
    expect(editor().playing).toBe(true);
  });

  it("cuts on the clock, or a hair early when the outgoing element has reached its Out", () => {
    const opts = twoSourceOptions();
    const { result } = renderHook(() => useSequencePlayback(opts));
    const a = fakeMedia({ duration: 5 });
    const b = fakeMedia({ duration: 5 });
    act(() => {
      result.current.registerVideo("c1", asVideo(a));
      result.current.registerVideo("c2", asVideo(b));
    });
    act(() => editor().setPlayhead(4.9));
    act(() => editor().setPlaying(true));
    flushFrame(0);
    // 20 ms before the cut, in step: the first clip still shows
    flushFrame(80);
    expect(a.style.opacity).toBe("1");
    expect(b.style.opacity).toBe("0");
    // Its element is at its Out already (ahead of the clock): the next clip shows rather than a frame past it
    a.currentTime = 5;
    flushFrame(90);
    expect(livePlayhead()).toBeCloseTo(4.99, 9);
    expect(a.style.opacity).toBe("0");
    expect(b.style.opacity).toBe("1");
    expect(b.muted).toBe(false);
  });

  it("hands a cut over prepared: the next clip timed, then moving before it, the previous paused after, the music untouched", () => {
    const opts: SequencePlaybackOptions = { ...twoSourceOptions(), audio: { clips: [audioClip()] } };
    const { result } = renderHook(() => useSequencePlayback(opts));
    // Seeks take 40 ms, as a real element's do; "a" plays the first 5 s of a longer file, so only the cut stops it
    const a = fakeMedia({ duration: 10, seekMs: 40 });
    const b = fakeMedia({ duration: 5, seekMs: 40 });
    const music = fakeMedia({ duration: 30, seekMs: 40 });
    let bAskedAt: number | null = null;
    b.play.mockImplementation(() => {
      bAskedAt ??= livePlayhead();
      b.paused = false;
      return Promise.resolve();
    });
    act(() => {
      result.current.registerVideo("c1", asVideo(a));
      result.current.registerVideo("c2", asVideo(b));
      result.current.registerAudio("audio:music", asAudio(music));
    });
    act(() => editor().setPlayhead(4));
    act(() => editor().setPlaying(true));
    let now = 0;
    const musicWrites = () => music.writes;
    let atStart: number | null = null;
    // Up to the cut: a frame every 16 ms
    while (livePlayhead() < 5) {
      flushFrame(now);
      if (atStart === null && !music.paused) atStart = musicWrites();
      now += 16;
    }
    // b was test-started at its In and put back there (its one seek, long before the cut), then asked to play before
    // the cut
    expect(b.writes).toBe(1);
    expect(b.play).toHaveBeenCalledTimes(2);
    expect(bAskedAt).not.toBeNull();
    expect(bAskedAt!).toBeLessThan(5);
    // The cut: shown and heard at once, moving; a hidden and silent, still playing until the next frame
    expect(b.style.opacity).toBe("1");
    expect(b.muted).toBe(false);
    expect(b.paused).toBe(false);
    expect(b.currentTime).toBeGreaterThan(0);
    expect(a.style.opacity).toBe("0");
    expectSilent(a);
    expect(a.paused).toBe(false);
    flushFrame(now);
    expect(a.paused).toBe(true);
    expect(a.pause).toHaveBeenCalledTimes(1);
    // The music was seeked once, to start, and never across the cut
    for (let k = 0; k < 10; k++) flushFrame((now += 16));
    expect(atStart).toBe(1);
    expect(music.writes).toBe(1);
    expect(music.paused).toBe(false);
  });

  it("times a slow-starting clip by a test start, so a cut into its first frame shows it moving", () => {
    const opts = twoSourceOptions();
    const { result } = renderHook(() => useSequencePlayback(opts));
    // "b" has sound: every start waits a quarter of a second for the sound output
    const a = fakeMedia({ duration: 10 });
    const b = fakeMedia({ duration: 5, startMs: 250 });
    act(() => {
      result.current.registerVideo("c1", asVideo(a));
      result.current.registerVideo("c2", asVideo(b));
    });
    act(() => editor().setPlayhead(3.5));
    act(() => editor().setPlaying(true));
    let now = 0;
    while (b.style.opacity !== "1") flushFrame((now += 16));
    // Shown at the cut already moving from its first frame, a frame's margin early at most, never still
    expect(livePlayhead()).toBeGreaterThanOrEqual(5);
    expect(b.currentTime).toBeGreaterThan(0.005);
    expect(b.currentTime).toBeLessThan(0.06);
    const shownAt = b.currentTime;
    flushFrame((now += 16));
    expect(b.currentTime).toBeGreaterThan(shownAt);
    expect(b.writes).toBe(1);
  });

  describe.each([
    ["Track", null],
    ["Stacked", { crossfade: false }],
  ] as const)("a cut into a slow-starting clip's first frame, in %s", (_layout, stack) => {
    it.each([24, 60])("shows it moving at %i fps, never a frame behind, and holds nothing past the cut", (fps) => {
      const first = createClip({ kind: "edge", edgeId: "e1" }, { id: "c1" });
      const second = createClip({ kind: "edge", edgeId: "e2" }, { id: "c2" });
      const opts: SequencePlaybackOptions = {
        spans: clipSpans(
          [first, second],
          new Map<SourceKey, number>([
            ["edge:e1", 5],
            ["edge:e2", 5],
          ]),
          0,
        ),
        total: 10,
        srcFor: (clipId) => (clipId === "c1" ? "blob:a" : "blob:b"),
        audio: { clips: [] },
        soundOn: true,
        stack,
      };
      const { result } = renderHook(() => useSequencePlayback(opts));
      const a = Object.assign(fakeMedia({ duration: 10 }), { src: "blob:a" });
      // Its decoder and sound output start with it: still for a quarter of a second after each play()
      const b = Object.assign(fakeMedia({ duration: 5, startMs: 250 }), { src: "blob:b" });
      act(() => {
        result.current.registerVideo("c1", asVideo(a));
        result.current.registerVideo("c2", asVideo(b));
      });
      act(() => editor().setPlayhead(3.5));
      act(() => editor().setPlaying(true));
      // The frame of its file each element shows: the one its time is in, at the clip's rate
      const frameOf = (m: FakeMedia) => Math.floor(m.currentTime * fps + 1e-6) / fps;
      let now = 0;
      while (b.style.opacity !== "1") {
        flushFrame((now += 1000 / 60));
        for (const m of [a, b]) if (!m.paused) act(() => m.present(frameOf(m)));
      }
      // At the cut, or a hair early as "a" reached its Out: never a refresh after it
      expect(livePlayhead()).toBeGreaterThan(4.97);
      expect(livePlayhead()).toBeLessThan(5 + 1 / 60 + 1e-6);
      // Its frame the clock's or a little on, never a frame behind; and moving
      const target = Math.max(0, livePlayhead() - 5);
      expect(frameOf(b)).toBeGreaterThanOrEqual(target - 1 / fps - 1e-6);
      expect(b.currentTime - target).toBeLessThan(0.05);
      const shown = b.currentTime;
      flushFrame((now += 1000 / 60));
      expect(b.currentTime).toBeGreaterThan(shown);
      expect(b.soundSwitches).toBe(0);
    });
  });

  it("learns a start's latency from the frames it shows, up to a slower one at once", () => {
    const opts = options(undefined, null);
    const { result } = renderHook(() => useSequencePlayback(opts));
    // Its file has sound: an element of it moves a quarter of a second after play()
    const first = Object.assign(fakeMedia({ startMs: 250 }), { src: "blob:a" });
    act(() => result.current.registerVideo("c1", asVideo(first)));
    act(() => editor().setPlaying(true));
    let now = 0;
    while (livePlayhead() < 1) {
      flushFrame((now += 16));
      if (!first.paused) act(() => first.present(first.currentTime));
    }
    // Another element of the file takes over: started where the clock will be when it moves, by that start
    const second = Object.assign(fakeMedia({ startMs: 250 }), { src: "blob:a" });
    act(() => {
      result.current.registerVideo("c1", null);
      result.current.registerVideo("c1", asVideo(second));
    });
    flushFrame((now += 16));
    expect(second.play).toHaveBeenCalledTimes(1);
    expect(second.currentTime - livePlayhead()).toBeGreaterThan(0.23);
    expect(second.currentTime - livePlayhead()).toBeLessThan(0.27);
  });

  it("starts a trimmed clip's pre-roll from where it waits, never moved back for its margin", () => {
    // One source cut in two at 2.5 s, in Track: the second piece waits half a second before its In
    const left = createClip({ kind: "edge", edgeId: "e1" }, { id: "c1", outSec: 2.5 });
    const right = createClip({ kind: "edge", edgeId: "e1" }, { id: "c2", inSec: 2.5 });
    const opts: SequencePlaybackOptions = {
      spans: clipSpans([left, right], new Map<SourceKey, number>([["edge:e1", 5]]), 0),
      total: 5,
      srcFor: () => "blob:a",
      audio: { clips: [] },
      soundOn: true,
    };
    const { result } = renderHook(() => useSequencePlayback(opts));
    const a = fakeMedia({ duration: 5 });
    const b = fakeMedia({ duration: 5, startMs: 250 });
    act(() => {
      result.current.registerVideo("c1", asVideo(a));
      result.current.registerVideo("c2", asVideo(b));
    });
    act(() => editor().setPlayhead(0.5));
    act(() => editor().setPlaying(true));
    let now = 0;
    let started = 0;
    // A frame every 4 ms, so the start lands within a hair of when it is due
    while (b.style.opacity !== "1") {
      flushFrame((now += 4));
      if (b.play.mock.calls.length === 2 && started === 0) started = b.writes;
    }
    // Its seeks: to the pre-roll point, and back there after its test start; none at its start
    expect(started).toBe(2);
    expect(b.writes).toBe(2);
    expect(b.currentTime).toBeGreaterThan(2.5);
    expect(b.currentTime).toBeLessThan(2.56);
  });

  it("holds a cut on the outgoing picture until the incoming element has shown a frame of where it is", () => {
    // One source cut in two at 2.5 s, in Track
    const left = createClip({ kind: "edge", edgeId: "e1" }, { id: "c1", outSec: 2.5 });
    const right = createClip({ kind: "edge", edgeId: "e1" }, { id: "c2", inSec: 2.5 });
    const opts: SequencePlaybackOptions = {
      spans: clipSpans([left, right], new Map<SourceKey, number>([["edge:e1", 5]]), 0),
      total: 5,
      srcFor: () => "blob:a",
      audio: { clips: [] },
      soundOn: true,
    };
    const { result } = renderHook(() => useSequencePlayback(opts));
    const a = fakeMedia({ duration: 5 });
    const b = fakeMedia({ duration: 5 });
    act(() => {
      result.current.registerVideo("c1", asVideo(a));
      result.current.registerVideo("c2", asVideo(b));
    });
    act(() => editor().setPlayhead(1.5));
    act(() => editor().setPlaying(true));
    flushFrame(0);
    flushFrame(100);
    // Prepared at its pre-roll point, and that frame shown (as a browser does after a seek)
    expect(b.currentTime).toBeCloseTo(2, 9);
    act(() => b.present(2));
    // It plays on towards its In, but the browser shows no newer frame of it: past the cut, the picture stays on
    // "a", still
    let now = 100;
    while (livePlayhead() < 2.55) flushFrame((now += 16));
    expect(b.paused).toBe(false);
    expect(b.currentTime).toBeGreaterThan(2.5);
    expect(a.style.opacity).toBe("1");
    expect(a.paused).toBe(true);
    expect(b.style.opacity).toBe("0");
    expectSilent(b);
    // A frame of where it is: the cut goes through
    act(() => b.present(b.currentTime));
    flushFrame((now += 16));
    expect(b.style.opacity).toBe("1");
    expect(b.muted).toBe(false);
    expect(a.style.opacity).toBe("0");
  });

  it("never turns a playing element's sound on from silent: not at a cut, a fade from 0 or the sound toggle", () => {
    const fade = audioClip({ curve: [{ t: 0, gain: 0 }, { t: 6, gain: 1 }] });
    let opts: SequencePlaybackOptions = { ...twoSourceOptions(), audio: { clips: [fade] } };
    const { result, rerender } = renderHook((o: SequencePlaybackOptions) => useSequencePlayback(o), { initialProps: opts });
    const a = fakeMedia({ duration: 10 });
    const b = fakeMedia({ duration: 5 });
    const music = fakeMedia({ duration: 30 });
    act(() => {
      result.current.registerVideo("c1", asVideo(a));
      result.current.registerVideo("c2", asVideo(b));
      result.current.registerAudio("audio:music", asAudio(music));
    });
    act(() => editor().setPlayhead(4));
    act(() => editor().setPlaying(true));
    let now = 0;
    // Through the cut at 5 s, the music rising from silence
    while (livePlayhead() < 5.5) {
      flushFrame(now);
      act(() => b.present(b.currentTime));
      now += 16;
    }
    expect(b.style.opacity).toBe("1");
    expect(b.volume).toBe(1);
    // Sound off and on again while playing
    opts = { ...opts, soundOn: false };
    rerender(opts);
    flushFrame((now += 16));
    expectSilent(b);
    expectSilent(music);
    opts = { ...opts, soundOn: true };
    rerender(opts);
    flushFrame((now += 16));
    expect(b.volume).toBe(1);
    expect(music.volume).toBeGreaterThan(0.5);
    expect(a.soundSwitches + b.soundSwitches + music.soundSwitches).toBe(0);
  });

  it("gives up holding for a fresher frame after a tenth of a second", () => {
    const left = createClip({ kind: "edge", edgeId: "e1" }, { id: "c1", outSec: 2.5 });
    const right = createClip({ kind: "edge", edgeId: "e1" }, { id: "c2", inSec: 2.5 });
    const opts: SequencePlaybackOptions = {
      spans: clipSpans([left, right], new Map<SourceKey, number>([["edge:e1", 5]]), 0),
      total: 5,
      srcFor: () => "blob:a",
      audio: { clips: [] },
      soundOn: true,
    };
    const { result } = renderHook(() => useSequencePlayback(opts));
    const a = fakeMedia({ duration: 5 });
    const b = fakeMedia({ duration: 5 });
    act(() => {
      result.current.registerVideo("c1", asVideo(a));
      result.current.registerVideo("c2", asVideo(b));
    });
    act(() => editor().setPlayhead(1.5));
    act(() => editor().setPlaying(true));
    flushFrame(0);
    flushFrame(100);
    act(() => b.present(2));
    let now = 100;
    // A browser that shows no frame of the hidden element: the cut waits a tenth of a second, then goes through
    while (livePlayhead() < 2.55) flushFrame((now += 16));
    expect(b.style.opacity).toBe("0");
    while (livePlayhead() < 2.65) flushFrame((now += 16));
    expect(b.style.opacity).toBe("1");
    expect(a.style.opacity).toBe("0");
  });

  it("loads ahead only the clips shown, playing and coming up", () => {
    const clip = (id: string, edgeId: string) => createClip({ kind: "edge", edgeId }, { id });
    const opts: SequencePlaybackOptions = {
      spans: clipSpans(
        [clip("c1", "e1"), clip("c2", "e2"), clip("c3", "e3")],
        new Map<SourceKey, number>([
          ["edge:e1", 5],
          ["edge:e2", 5],
          ["edge:e3", 5],
        ]),
        0,
      ),
      total: 15,
      srcFor: (clipId) => `blob:${clipId}`,
      audio: { clips: [] },
      soundOn: true,
    };
    const { result } = renderHook(() => useSequencePlayback(opts));
    const media = [fakeMedia({ duration: 5 }), fakeMedia({ duration: 5 }), fakeMedia({ duration: 5 })];
    const preload = () => media.map((m) => (m as unknown as { preload?: string }).preload ?? "metadata");
    act(() => media.forEach((m, i) => result.current.registerVideo(`c${i + 1}`, asVideo(m))));
    act(() => editor().setPlayhead(1));
    expect(preload()).toEqual(["auto", "metadata", "metadata"]);
    act(() => editor().setPlaying(true));
    flushFrame(0);
    flushFrame(100);
    // Playing c1: c2 is next
    expect(preload()).toEqual(["auto", "auto", "metadata"]);
  });

  it("stops when the element playing now refuses to play", async () => {
    const opts = options(undefined, null);
    const { result } = renderHook(() => useSequencePlayback(opts));
    const video = fakeMedia();
    video.play.mockImplementation(() => Promise.reject(new DOMException("No autoplay", "NotAllowedError")));
    act(() => result.current.registerVideo("c1", asVideo(video)));
    act(() => editor().setPlaying(true));
    await act(async () => {
      await Promise.resolve();
    });
    expect(editor().playing).toBe(false);
  });

  it("drops a paused seek still in flight when playback starts", () => {
    const opts = options(undefined, null);
    const { result } = renderHook(() => useSequencePlayback(opts));
    const video = fakeMedia();
    act(() => result.current.registerVideo("c1", asVideo(video)));
    const onSeeked = video.addEventListener.mock.calls.find(([type]) => type === "seeked")![1] as (e: Event) => void;

    // Paused, Go to end while a seek is still running: the target waits for 'seeked'
    video.seeking = true;
    act(() => editor().setPlayhead(9.5));
    // Space before it lands: playback starts at 9.5 and later runs on
    act(() => editor().setPlaying(true));
    video.seeking = false;
    video.currentTime = 9.6;
    onSeeked({ currentTarget: video } as unknown as Event);
    expect(video.currentTime).toBe(9.6);
  });

  describe("Stacked", () => {
    /** c1 then c2, 5 s each from sources "a" and "b", overlapping by 1 s: c1 0–5, c2 4–9. */
    function stackedOptions(crossfade = true, volume = 1): SequencePlaybackOptions {
      const first = createClip({ kind: "edge", edgeId: "e1" }, { id: "c1", volume });
      const second = createClip({ kind: "edge", edgeId: "e2" }, { id: "c2" });
      const durations = new Map<SourceKey, number>([
        ["edge:e1", 5],
        ["edge:e2", 5],
      ]);
      return {
        spans: clipSpans([first, second], durations, 1),
        total: 9,
        srcFor: (clipId) => (clipId === "c1" ? "blob:a" : "blob:b"),
        audio: { clips: [] },
        soundOn: true,
        stack: { crossfade },
      };
    }

    function mount(opts: SequencePlaybackOptions) {
      const hook = renderHook(() => useSequencePlayback(opts));
      const a = fakeMedia({ duration: 5 });
      const b = fakeMedia({ duration: 5 });
      act(() => {
        hook.result.current.registerVideo("c1", asVideo(a));
        hook.result.current.registerVideo("c2", asVideo(b));
      });
      a.writes = 0;
      b.writes = 0;
      return { ...hook, a, b };
    }

    it("shows both clips of an overlap while paused, the later at the blend's share", () => {
      const { a, b } = mount(stackedOptions());
      act(() => editor().setPlayhead(4.25));
      expect(a.currentTime).toBe(4.25);
      expect(b.currentTime).toBe(0.25);
      expect(a.style.opacity).toBe("1");
      expect(b.style.opacity).toBe("0.25");
      // Out of the overlap: only the clip under the playhead
      act(() => editor().setPlayhead(6));
      expect(a.style.opacity).toBe("0");
      expect(b.style.opacity).toBe("1");
      expect(b.currentTime).toBe(2);
    });

    it("starts the later clip hidden just before an overlap, timed by a test start, without pausing the earlier one", () => {
      const { a, b } = mount(stackedOptions());
      act(() => editor().setPlayhead(3));
      act(() => editor().setPlaying(true));
      expect(a.play).toHaveBeenCalledTimes(1);
      // The later clip is next: test-started from its In, hidden and silent, to time its start
      flushFrame(0);
      expect(b.play).toHaveBeenCalledTimes(1);
      expect(b.style.opacity).toBe("0");
      expectSilent(b);
      // Once it moves, put back at its In to wait
      flushFrame(600);
      expect(b.paused).toBe(true);
      expect(b.currentTime).toBe(0);
      expect(b.writes).toBe(1);
      // Its own start latency before its start: it plays, hidden and silent
      flushFrame(980);
      expect(b.play).toHaveBeenCalledTimes(2);
      expect(b.style.opacity).toBe("0");
      expectSilent(b);
      // Its start: shown and heard, moving and in step
      flushFrame(1050);
      expect(Number(b.style.opacity)).toBeCloseTo(0.05, 9);
      expect(b.muted).toBe(false);
      expect(b.currentTime).toBeCloseTo(0.07, 9);
      expect(b.play).toHaveBeenCalledTimes(2);
      expect(b.writes).toBe(1);
      expect(a.pause).not.toHaveBeenCalled();
      expect(livePlayhead()).toBeCloseTo(4.05, 9);
    });

    it("ramps the two volumes on equal power, times each clip's own volume", () => {
      const { a, b } = mount(stackedOptions(true, 0.8));
      act(() => editor().setPlayhead(3.9));
      act(() => editor().setPlaying(true));
      flushFrame(0);
      flushFrame(350);
      const angle = (0.25 * Math.PI) / 2;
      expect(a.volume).toBeCloseTo(0.8 * Math.cos(angle), 9);
      expect(b.volume).toBeCloseTo(Math.sin(angle), 9);
      expect(a.style.opacity).toBe("1");
      expect(b.style.opacity).toBe("0.25");
    });

    it("blends in a clip with sound from silent, never from muted or 0", () => {
      const { a, b } = mount(stackedOptions(true));
      act(() => editor().setPlayhead(3.5));
      act(() => editor().setPlaying(true));
      for (let now = 0; now <= 1600; now += 16) flushFrame(now);
      expect(b.volume).toBe(1);
      expect(a.soundSwitches + b.soundSwitches).toBe(0);
    });

    it("plays the later clip on through the earlier one's Out, with no seek", () => {
      const { a, b } = mount(stackedOptions());
      act(() => editor().setPlayhead(3.9));
      act(() => editor().setPlaying(true));
      flushFrame(0);
      flushFrame(600);
      expect(b.paused).toBe(false);
      const writes = b.writes;
      // The earlier clip reaches its Out: it is paused and hidden, the later one plays on as it is
      flushFrame(1100);
      expect(b.writes).toBe(writes);
      expect(livePlayhead()).toBeCloseTo(5, 9);
      expect(a.paused).toBe(true);
      expect(a.style.opacity).toBe("0");
      flushFrame(2100);
      expect(livePlayhead()).toBeCloseTo(6, 9);
      expect(Math.abs(b.currentTime - 2)).toBeLessThan(0.05);
      expect(b.writes).toBe(writes);
      expect(editor().playing).toBe(true);
    });

    it("draws an overlap's blend on the canvas while playing, the elements hidden under it", () => {
      const { a, b, result } = mount(stackedOptions());
      const draws: Array<[unknown, number]> = [];
      const ctx = {
        globalAlpha: 1,
        fillStyle: "",
        fillRect: vi.fn(),
        drawImage: vi.fn((el: unknown) => draws.push([el, ctx.globalAlpha])),
      };
      const canvas = { style: { opacity: "" }, width: 0, height: 0, clientWidth: 640, clientHeight: 360, getContext: vi.fn(() => ctx) };
      act(() => result.current.registerCanvas(canvas as unknown as HTMLCanvasElement));
      act(() => editor().setPlayhead(3.9));
      act(() => editor().setPlaying(true));
      flushFrame(0);
      // One clip: it shows itself
      expect(canvas.style.opacity).toBe("0");
      expect(a.style.opacity).toBe("1");
      // The overlap: both drawn in row order at their shares, letterboxed into the canvas, on black
      flushFrame(350);
      expect(canvas.style.opacity).toBe("1");
      expect(a.style.opacity).toBe("0");
      expect(b.style.opacity).toBe("0");
      expect(canvas.width).toBe(640);
      expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 640, 360);
      expect(draws).toEqual([
        [a, 1],
        [b, 0.25],
      ]);
      expect(ctx.drawImage).toHaveBeenLastCalledWith(b, 0, 0, 640, 360);
      // Both still heard, at their shares
      expect(a.muted).toBe(false);
      expect(b.muted).toBe(false);
      // Past the overlap: the later clip shows itself again
      flushFrame(1200);
      expect(canvas.style.opacity).toBe("0");
      expect(b.style.opacity).toBe("1");
      // Paused in an overlap the elements blend themselves
      act(() => editor().setPlaying(false));
      act(() => editor().setPlayhead(4.5));
      expect(canvas.style.opacity).toBe("0");
      expect(a.style.opacity).toBe("1");
      expect(b.style.opacity).toBe("0.5");
    });

    it("nudges a layer that falls behind by its rate, never seeking it", () => {
      const { a, b } = mount(stackedOptions());
      act(() => editor().setPlayhead(4.2));
      act(() => editor().setPlaying(true));
      flushFrame(0);
      flushFrame(100);
      const writes = b.writes;
      // b stands still for a tenth of a second: 0.1 s behind, played 2 % faster
      b.frozen = true;
      flushFrame(200);
      b.frozen = false;
      flushFrame(216);
      expect(b.playbackRate).toBe(1.02);
      expect(b.writes).toBe(writes);
      // Caught up: its rate is 1 again
      for (let now = 232; now <= 6000 && b.playbackRate !== 1; now += 16) flushFrame(now);
      expect(b.playbackRate).toBe(1);
      expect(b.writes).toBe(writes);
      expect(a.writes).toBe(1);
    });

    it("keeps the earlier clip in front with Crossfade off, both heard in full", () => {
      const { a, b } = mount(stackedOptions(false));
      act(() => editor().setPlayhead(4.5));
      expect(a.style.opacity).toBe("1");
      expect(b.style.opacity).toBe("0");
      act(() => editor().setPlaying(true));
      flushFrame(0);
      flushFrame(100);
      expect(b.paused).toBe(false);
      expect(a.volume).toBe(1);
      expect(b.volume).toBe(1);
      expect(b.style.opacity).toBe("0");
    });

    it("plays a cut between two pieces of one video from the next piece's pre-roll", () => {
      const left = createClip({ kind: "edge", edgeId: "e1" }, { id: "c1", outSec: 2.5 });
      const right = createClip({ kind: "edge", edgeId: "e1" }, { id: "c2", inSec: 2.5 });
      const opts: SequencePlaybackOptions = {
        spans: clipSpans([left, right], new Map<SourceKey, number>([["edge:e1", 5]]), 1),
        total: 5,
        srcFor: () => "blob:a",
        audio: { clips: [] },
        soundOn: true,
        stack: { crossfade: true },
      };
      expect(opts.spans[1].start).toBe(2.5);
      const { a, b } = mount(opts);
      act(() => editor().setPlayhead(1.4));
      act(() => editor().setPlaying(true));
      flushFrame(0);
      flushFrame(100);
      // Test-started at its pre-roll point, half a second before its In, and put back there to wait
      expect(livePlayhead()).toBeCloseTo(1.5, 9);
      expect(b.currentTime).toBeCloseTo(2, 9);
      expect(b.play).toHaveBeenCalledTimes(1);
      expect(b.writes).toBe(2);
      expect(b.paused).toBe(true);
      // Started the pre-roll and its start latency before the cut, from there
      flushFrame(580);
      expect(b.play).toHaveBeenCalledTimes(2);
      expect(b.writes).toBe(2);
      expect(b.style.opacity).toBe("0");
      expectSilent(b);
      // The cut: shown at its In, the earlier piece hidden and silent at once and paused a frame later
      flushFrame(1100);
      expect(livePlayhead()).toBeCloseTo(2.5, 9);
      expect(b.style.opacity).toBe("1");
      expect(b.currentTime).toBeCloseTo(2.52, 9);
      expect(a.style.opacity).toBe("0");
      expectSilent(a);
      expect(a.paused).toBe(false);
      flushFrame(1116);
      expect(a.paused).toBe(true);
      expect(b.writes).toBe(2);
      expect(b.play).toHaveBeenCalledTimes(2);
    });

    it("seeks a clip back to the playhead when its URL changes and the new file's metadata loads", () => {
      const { a } = mount(stackedOptions());
      act(() => editor().setPlayhead(2));
      expect(a.currentTime).toBe(2);
      const onLoaded = a.addEventListener.mock.calls.find(([type]) => type === "loadedmetadata")![1] as () => void;
      // The data: to blob: swap keeps the element and sends it back to 0
      a.currentTime = 0;
      onLoaded();
      expect(a.currentTime).toBe(2);
    });

    it("picks a clip up where the clock is when its URL changes while playing", () => {
      const { a } = mount(stackedOptions());
      act(() => editor().setPlayhead(1));
      act(() => editor().setPlaying(true));
      flushFrame(0);
      flushFrame(1000);
      expect(livePlayhead()).toBe(2);
      // The load pauses the element and sends it back to 0, keeping it
      const onLoaded = a.addEventListener.mock.calls.find(([type]) => type === "loadedmetadata")![1] as () => void;
      a.paused = true;
      a.currentTime = 0;
      onLoaded();
      flushFrame(1000);
      expect(a.play).toHaveBeenCalledTimes(2);
      // Its start latency on, as its first start taught (the least: these stand-ins move at once)
      expect(a.currentTime).toBeCloseTo(2.01, 9);
      expect(editor().playing).toBe(true);
      flushFrame(1500);
      expect(livePlayhead()).toBeCloseTo(2.5, 9);
    });

    describe("placed", () => {
      /** One clip per entry, in row order: [id, source length, startSec]; each from its own source "blob:<id>". */
      function placedOptions(rows: Array<[string, number, number]>, crossfade = true): SequencePlaybackOptions {
        const timeline = rows.map(([id, , startSec]) => createClip({ kind: "edge", edgeId: id }, { id, startSec }));
        const durations = new Map<SourceKey, number>(rows.map(([id, length]) => [`edge:${id}` as SourceKey, length]));
        const spans = layoutSpans(timeline, durations, { mode: "stacked", overlapSec: 1, crossfade });
        return {
          spans,
          total: spansEnd(spans),
          srcFor: (clipId) => `blob:${clipId}`,
          audio: { clips: [] },
          soundOn: true,
          stack: { crossfade, placed: true },
        };
      }

      function mountRows(opts: SequencePlaybackOptions) {
        const hook = renderHook(() => useSequencePlayback(opts));
        const media = new Map(opts.spans.map((span) => [span.clip.id, fakeMedia({ duration: span.length })]));
        act(() => {
          for (const [id, m] of media) hook.result.current.registerVideo(id, asVideo(m));
        });
        for (const m of media.values()) m.writes = 0;
        return { ...hook, media, el: (id: string) => media.get(id)! };
      }

      const opacities = (media: Map<string, FakeMedia>) => [...media.values()].map((m) => Number(m.style.opacity));

      // placed-three: A [0,5), B [2,7), C [3.5,9.5), top to bottom
      const placedThree = () =>
        placedOptions([
          ["A", 5, 0],
          ["B", 5, 2],
          ["C", 6, 3.5],
        ]);

      it("hides every element while paused in a gap", () => {
        const { media } = mountRows(
          placedOptions([
            ["A", 2, 0],
            ["B", 3, 4],
          ]),
        );
        act(() => editor().setPlayhead(1));
        expect(opacities(media)).toEqual([1, 0]);
        act(() => editor().setPlayhead(3));
        expect(opacities(media)).toEqual([0, 0]);
      });

      it("plays through a gap on the clock and starts the next clip at its start without stopping", () => {
        const { el, media } = mountRows(
          placedOptions([
            ["A", 2, 0],
            ["B", 3, 4],
          ]),
        );
        act(() => editor().setPlayhead(1.5));
        act(() => editor().setPlaying(true));
        flushFrame(0);
        // A reaches its Out: nothing plays until B, and the clock goes on
        flushFrame(500);
        expect(livePlayhead()).toBe(2);
        expect(editor().playing).toBe(true);
        flushFrame(516);
        expect(opacities(media)).toEqual([0, 0]);
        flushFrame(2000);
        expect(livePlayhead()).toBeCloseTo(3.5, 9);
        expect(el("B").play).not.toHaveBeenCalled();
        // Started its start latency and margin ahead, from its In
        flushFrame(2440);
        expect(editor().playing).toBe(true);
        expect(el("B").play).toHaveBeenCalledTimes(1);
        expect(el("B").currentTime).toBe(0);
        flushFrame(3500);
        expect(livePlayhead()).toBeCloseTo(5, 9);
        // Early by its first-guess latency and margin at most: these stand-ins move at once
        expect(Math.abs(el("B").currentTime - 1)).toBeLessThan(0.09);
        expect(el("B").writes).toBe(0);
      });

      it("holds the frame across a gap under a slot, paused and playing, as the encode does", () => {
        const { el, media } = mountRows(
          placedOptions([
            ["A", 5, 0],
            ["C", 5, 5.01],
          ]),
        );
        act(() => editor().setPlayhead(5.005));
        expect(opacities(media)).toEqual([1, 0]);
        act(() => editor().setPlayhead(4.9));
        act(() => editor().setPlaying(true));
        flushFrame(1000);
        // The clock reaches C's start: it plays with no frame of black before it
        flushFrame(1105);
        expect(opacities(media)).toEqual([1, 0]);
        flushFrame(1110);
        expect(editor().playing).toBe(true);
        expect(livePlayhead()).toBeCloseTo(5.01, 9);
        expect(opacities(media)).toEqual([0, 1]);
        expect(el("C").play).toHaveBeenCalledTimes(1);
      });

      it("starts from a gap on the clock", () => {
        const { el } = mountRows(
          placedOptions([
            ["A", 2, 0],
            ["B", 3, 4],
          ]),
        );
        act(() => editor().setPlayhead(3));
        act(() => editor().setPlaying(true));
        expect(editor().playing).toBe(true);
        flushFrame(0);
        flushFrame(500);
        expect(livePlayhead()).toBeCloseTo(3.5, 9);
        expect(el("A").play).not.toHaveBeenCalled();
      });

      it("plays and pauses a clip inside the one below, which plays on", () => {
        // B on the higher row, wholly inside A
        const { el } = mountRows(
          placedOptions([
            ["B", 2, 3],
            ["A", 10, 0],
          ]),
        );
        act(() => editor().setPlayhead(2));
        act(() => editor().setPlaying(true));
        expect(el("A").play).toHaveBeenCalledTimes(1);
        flushFrame(0);
        flushFrame(1500);
        expect(el("B").paused).toBe(false);
        expect(livePlayhead()).toBe(3.5);
        flushFrame(3500);
        expect(el("B").paused).toBe(true);
        expect(el("A").pause).not.toHaveBeenCalled();
        expect(livePlayhead()).toBe(5.5);
      });

      it("gives three layers their opacities in row order, the DOM's", () => {
        const { media } = mountRows(placedThree());
        act(() => editor().setPlayhead(4.75));
        const [a, b, c] = opacities(media);
        expect(a).toBeCloseTo(1, 2);
        expect(b).toBeCloseTo(0.908, 2);
        expect(c).toBeCloseTo(0.092, 2);
        // C is hidden under B here
        act(() => editor().setPlayhead(4));
        const [a4, b4, c4] = opacities(media);
        expect(a4).toBeCloseTo(1, 2);
        expect(b4).toBeCloseTo(0.667, 2);
        expect(c4).toBe(0);
      });

      it("keeps a hidden clip's element playing, at opacity 0, in step", () => {
        const { el } = mountRows(placedThree());
        act(() => editor().setPlayhead(3.9));
        act(() => editor().setPlaying(true));
        flushFrame(0);
        flushFrame(100);
        expect(el("C").paused).toBe(false);
        expect(el("C").style.opacity).toBe("0");
        expect(el("C").currentTime).toBeCloseTo(0.5, 9);
      });
    });
  });

  describe("a retimed clip", () => {
    // Each copy remembers the source time of the frame it copied
    class FakeOffscreen {
      copiedAt = Number.NaN;
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext() {
        return {
          drawImage: (image: FakeMedia) => {
            this.copiedAt = image.currentTime;
          },
        };
      }
    }
    /** The stage's canvas, each frame's images drawn on it collected in `draws` with the alpha each was drawn at. */
    const blendCanvas = (result: { current: ReturnType<typeof useSequencePlayback> }) => {
      const draws: Array<[unknown, number]> = [];
      const ctx = {
        globalAlpha: 1,
        fillStyle: "",
        fillRect: vi.fn(),
        drawImage: vi.fn((image: unknown) => draws.push([image, ctx.globalAlpha])),
      };
      const canvas = { style: { opacity: "" }, width: 0, height: 0, clientWidth: 640, clientHeight: 360, getContext: vi.fn(() => ctx) };
      act(() => result.current.registerCanvas(canvas as unknown as HTMLCanvasElement));
      return { canvas, draws };
    };
    // To its Out at 1/0.7 of its speed, then held there for the clip's last 30 %
    const endFreeze: ClipWarpCurve = {
      kind: "points",
      points: [
        [0, 0],
        [0.7, 1],
        [1, 1],
      ],
    };

    it("plays a 2× clip at 2, its pitch following, on the clock with no seek, the music untouched", () => {
      const { opts, el, result } = mountWarped([["c1", "e1", 10, { warp: warpOf({ speed: 2 }) }]], { audio: [audioClip()] });
      const music = fakeMedia({ duration: 30 });
      act(() => result.current.registerAudio("audio:music", asAudio(music)));
      const a = el("c1");
      expect(opts.total).toBe(5);
      act(() => editor().setPlaying(true));
      expect(a.playbackRate).toBe(2);
      expect(a.preservesPitch).toBe(false);
      expect(a.plays).toEqual([{ rate: 2, preservesPitch: false }]);
      flushFrame(0);
      flushFrame(1000);
      expect(livePlayhead()).toBeCloseTo(1, 9);
      expect(a.currentTime).toBeCloseTo(2, 9);
      const musicRates = new Set<number>();
      for (let now = 1000 + FRAME; now <= 1000 + 20 * FRAME + 1e-6; now += FRAME) {
        flushFrame(now);
        expect(Math.abs(a.currentTime - targetOf(opts, "c1", livePlayhead()))).toBeLessThan(1e-9);
        // Independently: In + offset × speed
        expect(a.currentTime).toBeCloseTo(2 * livePlayhead(), 9);
        musicRates.add(music.playbackRate);
      }
      expect(a.writes).toBe(0);
      expect(a.playbackRate).toBe(2);
      expect([...musicRates].every((rate) => NUDGED.includes(rate))).toBe(true);
      expect(music.preservesPitch).toBe(true);
      expect(a.rateRejected).toEqual([]);
    });

    it("nudges a 2× clip around its rate and seeks it through the map", () => {
      const { opts, el } = mountWarped([["c1", "e1", 10, { warp: warpOf({ speed: 2 }) }]]);
      const a = el("c1");
      act(() => editor().setPlaying(true));
      flushFrame(0);
      flushFrame(1000);
      a.frozen = true;
      // 0.4 s of source behind is 0.2 s of the clock: nudged hard, around its own rate
      flushFrame(1200);
      expect(a.playbackRate).toBe(2 * 1.05);
      expect(a.writes).toBe(0);
      // Past 0.25 s of the clock: seeked to where the map will be when it lands
      flushFrame(1500);
      expect(a.writes).toBe(1);
      expect(a.currentTime).toBeCloseTo(targetOf(opts, "c1", 1.6), 9);
      expect(a.currentTime).toBeCloseTo(3.2, 9);
      expect(a.playbackRate).toBe(2);
      flushFrame(1700);
      flushFrame(1900);
      expect(a.writes).toBe(1);
    });

    it("leaves a 2× clip whose element never gets going to its start until that times out, then seeks it", () => {
      const { el } = mountWarped([["c1", "e1", 20, { warp: warpOf({ speed: 2 }) }]]);
      const a = el("c1");
      act(() => editor().setPlaying(true));
      a.frozen = true;
      let now = 0;
      let seekedAt: number | null = null;
      for (let k = 0; k < 2000 && livePlayhead() < 3; k++) {
        flushFrame((now += FRAME));
        if (seekedAt === null && a.writes > 0) seekedAt = livePlayhead();
      }
      // Its start timed out (START_LATENCY_RANGE[1] + 0.5 from the clock setting off), then kept on the clock
      expect(seekedAt!).toBeGreaterThan(1.05);
      expect(seekedAt!).toBeLessThan(1.2);
      expect(a.writes).toBeGreaterThanOrEqual(2);
    });

    it("nudges a 2× clip that falls a little behind back to exactly its rate once caught up, never seeking it", () => {
      const { el } = mountWarped([["c1", "e1", 20, { warp: warpOf({ speed: 2 }) }]]);
      const a = el("c1");
      act(() => editor().setPlaying(true));
      flushFrame(0);
      flushFrame(1000);
      // 0.2 s of source behind is 0.1 s of the clock: played 2 % faster
      a.frozen = true;
      flushFrame(1100);
      a.frozen = false;
      flushFrame(1116);
      expect(a.playbackRate).toBe(2 * 1.02);
      // Caught up: its map's rate again
      for (let now = 1132; now <= 8000 && a.playbackRate !== 2; now += 16) flushFrame(now);
      expect(a.playbackRate).toBe(2);
      expect(a.writes).toBe(0);
    });

    it("weighs a 0.5× clip's drift in sequence seconds", () => {
      const { opts, el } = mountWarped([["c1", "e1", 5, { warp: warpOf({ speed: 0.5 }) }]]);
      const a = el("c1");
      expect(opts.total).toBe(10);
      act(() => editor().setPlaying(true));
      flushFrame(0);
      flushFrame(1000);
      expect(a.currentTime).toBeCloseTo(0.5, 9);
      a.frozen = true;
      // 0.1 s of source behind is 0.2 s of the clock: nudged hard
      flushFrame(1200);
      expect(a.playbackRate).toBe(0.5 * 1.05);
      flushFrame(1500);
      expect(a.writes).toBe(1);
      expect(a.currentTime).toBeCloseTo(0.8, 9);
    });

    it("primes a 0.5× clip from where it is when that is near enough, the clock set off no further than it moved", () => {
      const { el } = mountWarped([["c1", "e1", 10, { warp: warpOf({ speed: 0.5 }) }]]);
      const a = el("c1");
      act(() => editor().setPlayhead(2));
      expect(a.currentTime).toBeCloseTo(1, 12);
      // 0.03 s of source on, 0.06 s of the clock: within LANDED of the clock, so played from there
      a.currentTime = 1.03;
      a.seekTargets = [];
      act(() => editor().setPlaying(true));
      flushFrame(0);
      flushFrame(50);
      expect(a.seekTargets).toEqual([]);
      // From where Play left it, plus what it moved at its rate and a frame: never from where its picture is (2.06)
      expect(livePlayhead()).toBeCloseTo(2 + 0.025 / 0.5 + 1 / 60, 9);
    });

    it("primes a 0.5× clip 0.06 s of source off its point with a seek: 0.12 s of the clock", () => {
      const { el } = mountWarped([["c1", "e1", 10, { warp: warpOf({ speed: 0.5 }) }]]);
      const a = el("c1");
      act(() => editor().setPlayhead(2));
      a.currentTime = 1.06;
      a.seekTargets = [];
      act(() => editor().setPlaying(true));
      flushFrame(0);
      expect(a.seekTargets).toEqual([1]);
    });

    it("cuts into a 2× clip prepared at its rate: a pre-roll of half a second of decoding, no seek at its start", () => {
      const { opts, el } = mountWarped(
        [
          ["c1", "e1", 5],
          ["c2", "e2", 10, { inSec: 2, warp: warpOf({ speed: 2 }) }],
        ],
        { seekMs: 40 },
      );
      const b = el("c2");
      expect(opts.total).toBe(9);
      let bAskedAt: number | null = null;
      act(() => editor().setPlayhead(3));
      act(() => editor().setPlaying(true));
      let now = 0;
      let plays = 0;
      while (b.style.opacity !== "1" && now < 5000) {
        flushFrame((now += 16));
        if (b.plays.length !== plays) {
          plays = b.plays.length;
          if (plays === 2) bAskedAt = livePlayhead();
        }
        if (b.style.opacity !== "1") expectSilent(b);
      }
      // Its pre-roll point: 2 − min(0.5 × 2, 2)
      expect(b.seekTargets[0]).toBe(1);
      expect(b.writes).toBe(2);
      expect(b.plays).toEqual([
        { rate: 2, preservesPitch: false },
        { rate: 2, preservesPitch: false },
      ]);
      // Started its pre-roll's half second of decoding, its latency and margin early, not a whole source second
      expect(bAskedAt!).toBeGreaterThan(4);
      expect(bAskedAt!).toBeLessThan(4.5);
      expect(livePlayhead()).toBeLessThan(5 + FRAME / 1000 + 1e-6);
      const early = b.currentTime - targetOf(opts, "c2", livePlayhead());
      expect(early).toBeGreaterThan(-0.04);
      expect(early).toBeLessThan(0.12);
      expect(b.volume).toBe(1);
      for (let k = 0; k < 10; k++) flushFrame((now += 16));
      expect(b.writes).toBe(2);
    });

    it("hands a 2× clip over at its own Out, not where its source time passes its length", () => {
      const { el } = mountWarped([
        ["c1", "e1", 20, { outSec: 10, warp: warpOf({ speed: 2 }) }],
        ["c2", "e2", 5],
      ]);
      const [a, b] = [el("c1"), el("c2")];
      act(() => editor().setPlayhead(4.9));
      act(() => editor().setPlaying(true));
      flushFrame(0);
      flushFrame(80);
      expect(livePlayhead()).toBeCloseTo(4.98, 9);
      // At 9.96 of its source, past In + its 5 s on the timeline: the old gate would have cut already
      expect(a.style.opacity).toBe("1");
      expect(b.style.opacity).toBe("0");
      // Within OUT_MARGIN of its end point: the next clip shows rather than a frame past it
      a.currentTime = 10 - OUT_MARGIN - 0.0005;
      flushFrame(90);
      expect(livePlayhead()).toBeCloseTo(4.99, 9);
      expect(a.style.opacity).toBe("0");
      expect(b.style.opacity).toBe("1");
    });

    it("follows an ease-in-out ramp by its rate, written every frame, seeking only while it is slower than it starts", () => {
      const { opts, el } = mountWarped([["c1", "e1", 10, { warp: warpOf({ curve: preset("easeInOutSine") }) }]]);
      const a = el("c1");
      act(() => editor().setPlaying(true));
      let now = 0;
      flushFrame(now);
      let writesAtStart: number | null = null;
      let startedAt = 0;
      let kept = 0;
      for (let k = 0; k < 2000 && livePlayhead() < 9.5; k++) {
        flushFrame((now += FRAME));
        const t = livePlayhead();
        const base = baseOf(opts, "c1", t);
        if (a.paused) {
          // Driven by seeks until it plays at a quarter speed or more: a frame aimed a little ahead, at most
          expect(lateness(opts, "c1", a, t)).toBeLessThan(0.1);
          continue;
        }
        expect(lateness(opts, "c1", a, t)).toBeLessThan(0.045);
        if (writesAtStart === null) {
          writesAtStart = a.writes;
          startedAt = now;
        }
        // Started at the rate where it will be moving, its start latency on, and left there until it moves; from then
        // the map's own rate on every frame, nudged
        if (kept === 0 && a.playbackRate === a.plays[0].rate) {
          expect(now - startedAt).toBeLessThan(200);
          continue;
        }
        expect(NUDGED.some((factor) => Math.abs(a.playbackRate / base - factor) < 1e-9)).toBe(true);
        kept++;
      }
      expect(writesAtStart).not.toBeNull();
      expect(kept).toBeGreaterThan(300);
      // One start, at a quarter speed or more; from it on followed by its rate, never seeked
      expect(a.plays).toHaveLength(1);
      expect(a.plays[0].rate).toBeGreaterThanOrEqual(MIN_START_RATE);
      expect(a.writes).toBe(writesAtStart);
      expect(a.rateRejected).toEqual([]);
      expect(a.rateWrites).toBeGreaterThan(kept);
    });

    it("sets the clock off at once at an ease-in's first frame, driven by seeks until it plays from a quarter speed", () => {
      const { opts, el } = mountWarped([["c1", "e1", 10, { warp: warpOf({ curve: preset("easeInQuad") }) }]]);
      const a = el("c1");
      act(() => editor().setPlaying(true));
      let now = 0;
      flushFrame(now);
      flushFrame((now += FRAME));
      // No further on than the time waited: nothing to wait for
      expect(livePlayhead()).toBeGreaterThan(0);
      expect(livePlayhead()).toBeLessThanOrEqual(now / 1000 + 1e-9);
      const rates = new Set<number>();
      for (let k = 0; k < 2000 && livePlayhead() < 9.5; k++) {
        flushFrame((now += FRAME));
        expect(lateness(opts, "c1", a, livePlayhead())).toBeLessThan(0.1);
        if (!a.paused) rates.add(a.playbackRate);
      }
      expect(a.plays).toHaveLength(1);
      expect(a.plays[0].rate).toBeGreaterThanOrEqual(MIN_START_RATE);
      // Never slower than it was started at, but for a nudge
      expect(Math.min(...rates)).toBeGreaterThanOrEqual(MIN_START_RATE * 0.95);
      expect(a.rateRejected).toEqual([]);
    });

    it("drives a ramp moved into while it plays by seeks until a quarter speed, as Play pressed there does", () => {
      const { opts, el } = mountWarped([["c1", "e1", 10, { warp: warpOf({ curve: preset("easeInQuad") }) }]]);
      const a = el("c1");
      act(() => editor().setPlayhead(8));
      act(() => editor().setPlaying(true));
      let now = 0;
      for (let k = 0; k < 30; k++) flushFrame((now += FRAME));
      expect(a.paused).toBe(false);
      // Into its slow start, where it runs at a tenth: put there afresh, a start like Play's
      expect(baseOf(opts, "c1", 0.5)).toBeLessThan(MIN_START_RATE);
      act(() => editor().setPlayhead(0.5));
      const plays = a.plays.length;
      flushFrame((now += FRAME));
      expect(a.paused).toBe(true);
      for (let k = 0; k < 2000 && livePlayhead() < 2.5; k++) {
        flushFrame((now += FRAME));
        if (!a.paused) expect(a.playbackRate).toBeGreaterThanOrEqual(MIN_START_RATE * 0.95);
      }
      expect(a.plays.length).toBe(plays + 1);
      expect(a.plays.at(-1)!.rate).toBeGreaterThanOrEqual(MIN_START_RATE);
    });

    it("drives a ramp that falls far behind in its slow middle by seeks, never seeked while playing there", () => {
      // Fast, a slow middle at about a tenth from 3.7 s to 6 s, fast again
      const dip: ClipWarpCurve = {
        kind: "points",
        points: [
          [0, 0],
          [0.3, 0.4],
          [0.7, 0.5],
          [1, 1],
        ],
      };
      const { opts, el } = mountWarped([["c1", "e1", 10, { warp: warpOf({ curve: dip }) }]]);
      const a = el("c1");
      expect(baseOf(opts, "c1", 4.7)).toBeLessThan(MIN_START_RATE / 2);
      act(() => editor().setPlayhead(2));
      act(() => editor().setPlaying(true));
      let now = 0;
      flushFrame(now);
      let writes = a.writes;
      let driven = 0;
      for (let k = 0; k < 2000 && livePlayhead() < 8; k++) {
        // A stall in the slow middle, long enough to be seeked
        a.frozen = livePlayhead() > 4.2 && livePlayhead() < 4.85;
        flushFrame((now += FRAME));
        const t = livePlayhead();
        if (a.writes > writes) {
          writes = a.writes;
          // Seeked while it plays, slower than it is started at, it would rise from there with a frame ahead
          if (!a.paused) expect(baseOf(opts, "c1", t)).toBeGreaterThanOrEqual(MIN_START_RATE);
          else driven++;
        }
        if (t > 7) expect(lateness(opts, "c1", a, t)).toBeLessThan(0.045);
      }
      expect(driven).toBeGreaterThan(5);
      // Started again once the ramp reached a quarter speed
      expect(a.plays).toHaveLength(2);
      expect(a.plays[1].rate).toBeGreaterThanOrEqual(MIN_START_RATE);
    });

    it("starts an ease-in on an element with sound its start latency early, so it moves on time", () => {
      const { opts, el } = mountWarped([["c1", "e1", 10, { warp: warpOf({ curve: preset("easeInQuad") }) }]], { startMs: 250 });
      const a = el("c1");
      // Its start where the ramp is fast teaches its latency, by the frames it shows
      act(() => editor().setPlayhead(9));
      act(() => editor().setPlaying(true));
      let now = 0;
      for (let k = 0; k < 30; k++) {
        flushFrame((now += FRAME));
        if (!a.paused) act(() => a.present(a.currentTime));
      }
      // Back to its first frame while playing: driven by seeks from there until it is started, a quarter of a second
      // before it reaches a quarter speed (at 1.25 s)
      act(() => editor().setPlayhead(0));
      const plays = a.plays.length;
      let startedAt: number | null = null;
      let from = 0;
      let writes = 0;
      for (let k = 0; k < 2000 && livePlayhead() < 9.5; k++) {
        flushFrame((now += FRAME));
        const t = livePlayhead();
        if (startedAt === null && a.plays.length > plays) {
          startedAt = t;
          from = a.currentTime;
          writes = a.writes;
        }
        // Left at the rate it was started at until it moves: never lowered (to rise from there) while it starts
        if (startedAt !== null && a.currentTime === from) expect(a.playbackRate).toBe(a.plays[plays].rate);
        expect(lateness(opts, "c1", a, t)).toBeLessThan(0.25);
        if (t > 1.3) expect(lateness(opts, "c1", a, t)).toBeLessThan(0.045);
      }
      expect(a.plays.length).toBe(plays + 1);
      expect(a.plays[plays].rate).toBeGreaterThanOrEqual(MIN_START_RATE);
      expect(startedAt!).toBeGreaterThan(0.95);
      expect(startedAt!).toBeLessThan(1.05);
      expect(a.writes).toBe(writes);
    });

    it.each(["after a move", "at a cut"])(
      "starts a steep ease-in on an element with sound %s its latency early, never moved back before it moves",
      (way) => {
        // easeInQuad at 4× over 8 s of source: a quarter speed 1/16 s in, faster than 1× a quarter of a second in
        const ramp: WarpedRow = ["c2", "e2", 8, { warp: warpOf({ speed: 4, curve: preset("easeInQuad") }) }];
        // Seeks taking time at the cut, where a seek asked on its frame would hold it
        const { opts, el } = mountWarped([["c1", "e1", 3], ramp], { startMs: 250, seekMs: way === "at a cut" ? 40 : 0 });
        const [a, b] = [el("c1"), el("c2")];
        // c1's start, at the press, teaches the latency the two files share
        act(() => editor().setPlayhead(way === "at a cut" ? 1.5 : 0));
        act(() => editor().setPlaying(true));
        let now = 0;
        for (let k = 0; k < 30; k++) {
          flushFrame((now += FRAME));
          if (!a.paused && !a.seeking) act(() => a.present(a.currentTime));
        }
        if (way === "after a move") act(() => editor().setPlayhead(3));
        const plays = b.plays.length;
        let from: number | null = null;
        let writes = 0;
        let shownAt: number | null = null;
        for (let k = 0; k < 2000 && livePlayhead() < 4.5; k++) {
          flushFrame((now += FRAME));
          if (!b.paused && !b.seeking) act(() => b.present(b.currentTime));
          const t = livePlayhead();
          if (b.style.opacity === "1") shownAt ??= t;
          if (t < 3) continue;
          if (from === null && b.plays.length > plays) {
            from = b.currentTime;
            writes = b.writes;
          }
          if (from !== null && b.currentTime === from) expect(b.playbackRate).toBe(b.plays.at(-1)!.rate);
          if (t > 3.5) expect(lateness(opts, "c2", b, t)).toBeLessThan(0.045);
        }
        expect(b.plays.at(-1)!.rate).toBeGreaterThanOrEqual(MIN_START_RATE);
        expect(b.writes).toBe(writes);
        // A cut shows it on the clock: no seek of its own to wait for
        if (way === "at a cut") expect(shownAt!).toBeLessThan(3 + FRAME / 1000 + 1e-6);
      },
    );

    it.each([
      ["easeInOutSine at 1× over 3 s of source", warpOf({ curve: preset("easeInOutSine") }), 3],
      ["easeInQuad at 4× over 4 s", warpOf({ speed: 4, curve: preset("easeInQuad") }), 4],
    ] as const)("cuts into %s on a file with sound on the clock, waiting where its start sets off from", (_name, warp, source) => {
      const { opts, el } = mountWarped(
        [
          ["c1", "e1", 5],
          ["c2", "e2", 10, { inSec: 2, outSec: 2 + source, warp }],
        ],
        { startMs: 250, seekMs: 40 },
      );
      const [a, b] = [el("c1"), el("c2")];
      // Slower than it is started at on its first frame, faster a start latency on: started on the cut's frame
      expect(baseOf(opts, "c2", 5)).toBeLessThan(MIN_START_RATE);
      expect(baseOf(opts, "c2", 5.25)).toBeGreaterThanOrEqual(MIN_START_RATE);
      act(() => editor().setPlayhead(2.5));
      act(() => editor().setPlaying(true));
      let now = 0;
      flushFrame(now);
      let writes = 0;
      for (let k = 0; k < 2000 && b.style.opacity !== "1"; k++) {
        writes = b.writes;
        flushFrame((now += FRAME));
        act(() => {
          for (const m of [a, b]) if (!m.paused && !m.seeking) m.present(m.currentTime);
        });
      }
      expect(livePlayhead()).toBeLessThan(5 + FRAME / 1000 + 1e-6);
      expect(a.style.opacity).toBe("0");
      // Started from where it waited, its start latency into its map: no seek asked on the cut's frame
      expect(b.writes).toBe(writes);
      expect(b.paused).toBe(false);
      expect(b.plays.at(-1)!.rate).toBeGreaterThanOrEqual(MIN_START_RATE);
      expect(b.currentTime).toBeGreaterThan(targetOf(opts, "c2", 5.2));
    });

    it("learns a ramp's latency from its own start: the next time round it is started that much early", () => {
      const { opts, el } = mountWarped([["c1", "e1", 10, { warp: warpOf({ curve: preset("easeInQuad") }) }]], { startMs: 250 });
      const a = el("c1");
      act(() => editor().setPlaying(true));
      let now = 0;
      // Play pressed inside it, so never test-started: its first start goes by the latency guessed
      const once = () => {
        const plays = a.plays.length;
        let startedAt: number | null = null;
        let worst = 0;
        for (let k = 0; k < 2000 && livePlayhead() < 3; k++) {
          flushFrame((now += FRAME));
          if (!a.paused) act(() => a.present(a.currentTime));
          const t = livePlayhead();
          if (startedAt === null && a.plays.length > plays) startedAt = t;
          if (startedAt !== null && t > startedAt + 0.3) worst = Math.max(worst, lateness(opts, "c1", a, t));
        }
        return { startedAt: startedAt!, worst };
      };
      const first = once();
      act(() => editor().setPlayhead(0));
      const second = once();
      // A quarter of a second earlier than the guess, and on the clock from there
      expect(first.startedAt - second.startedAt).toBeGreaterThan(0.15);
      expect(second.worst).toBeLessThan(0.045);
    });

    it.each([
      ["an ease-in-out is moved back", warpOf({ curve: preset("easeInOutSine") }), 4, 2.2],
      ["an ease-in at 2× is moved back", warpOf({ speed: 2, curve: preset("easeInQuad") }), 3, 1.2],
      ["an ease-in-out is moved on", warpOf({ curve: preset("easeInOutSine") }), 2.2, 4],
    ] as const)("follows the map within half a second when %s before its start was seen moving", (_name, warp, from, to) => {
      const { opts, el } = mountWarped([["c1", "e1", 10, { warp }]], { startMs: 250, seekMs: 30 });
      const a = el("c1");
      act(() => editor().setPlayhead(from));
      act(() => editor().setPlaying(true));
      let now = 0;
      flushFrame(now);
      for (let k = 0; k < 4; k++) flushFrame((now += FRAME));
      // Started, not moving yet
      expect(a.paused).toBe(false);
      expect(a.currentTime).toBe(targetOf(opts, "c1", from));
      act(() => editor().setPlayhead(to));
      let kept = 0;
      for (let k = 0; k < 2000 && livePlayhead() < to + 2.5; k++) {
        flushFrame((now += FRAME));
        if (!a.paused && !a.seeking) act(() => a.present(a.currentTime));
        const t = livePlayhead();
        if (a.paused || t < to + 0.5) continue;
        expect(lateness(opts, "c1", a, t)).toBeLessThan(0.045);
        kept++;
      }
      expect(kept).toBeGreaterThan(60);
    });

    it("test-starts an ease-in coming up, so one on a file with sound after a clip without moves on time", () => {
      const opts = warpedOptions([
        ["c1", "e1", 5],
        ["c2", "e2", 20, { inSec: 2, warp: warpOf({ curve: preset("easeInQuad") }) }],
      ]);
      const hook = renderHook((o: SequencePlaybackOptions) => useSequencePlayback(o), { initialProps: opts });
      // c1's file has no sound (it starts in 40 ms), c2's has (250 ms)
      const a = Object.assign(fakeMedia({ duration: 5, startMs: 40, seekMs: 30 }), { src: "blob:e1" });
      const b = Object.assign(fakeMedia({ duration: 20, startMs: 250, seekMs: 30 }), { src: "blob:e2" });
      act(() => {
        hook.result.current.registerVideo("c1", asVideo(a));
        hook.result.current.registerVideo("c2", asVideo(b));
      });
      act(() => editor().setPlayhead(3));
      let now = 0;
      for (let k = 0; k < 10; k++) flushFrame((now += FRAME));
      act(() => editor().setPlaying(true));
      let startedAt: number | null = null;
      let worst = 0;
      for (let k = 0; k < 2000 && livePlayhead() < 9; k++) {
        flushFrame((now += FRAME));
        act(() => {
          if (!a.paused) a.present(a.currentTime);
          if (!b.paused) b.present(b.currentTime);
        });
        const t = livePlayhead();
        if (t < 5 || b.paused) continue;
        startedAt ??= t;
        if (t > startedAt + 0.3) worst = Math.max(worst, lateness(opts, "c2", b, t));
      }
      // Hidden, at a quarter speed from its first frame, before its cut; then once more where the ramp reaches it
      expect(b.plays).toHaveLength(2);
      expect(b.plays[0].rate).toBe(MIN_START_RATE);
      expect(worst).toBeLessThan(0.1);
    });

    it("puts an ease-in back on its first frame after its test start, so its cut shows the frame the render does", () => {
      // c2's file is 60 fps, its picture a little ahead of its time, as a browser's: its test start is timed by its next
      // frame, 1/60 s on, inside SEEK_TOLERANCE
      const frame60 = (t: number) => Math.floor(t * 60 + 1e-9) / 60;
      const { el } = mountWarped([
        ["c1", "e1", 5],
        ["c2", "e2", 10, { inSec: 2, warp: warpOf({ curve: preset("easeInQuad") }) }],
      ]);
      const b = el("c2");
      act(() => editor().setPlayhead(3));
      act(() => editor().setPlaying(true));
      let now = 0;
      for (let k = 0; k < 2000 && b.style.opacity !== "1"; k++) {
        flushFrame((now += FRAME));
        act(() => {
          if (!b.paused) b.present(frame60(b.currentTime + 0.005));
        });
      }
      expect(b.plays[0].rate).toBe(MIN_START_RATE);
      // In's frame at the cut: the next would be held there until the ramp reached it, 0.37 s of the clock on
      expect(b.style.opacity).toBe("1");
      expect(frame60(b.currentTime)).toBe(2);
    });

    it.each([0, 250])("holds a freeze on the render's frame, paused, and plays on after it (a start taking %i ms)", (startMs) => {
      const freeze: ClipWarpCurve = {
        kind: "points",
        points: [
          [0, 0],
          [0.3, 0.4],
          [0.6, 0.4],
          [1, 1],
        ],
      };
      const { opts, el } = mountWarped([["c1", "e1", 10, { warp: warpOf({ curve: freeze }) }]], { startMs });
      const a = el("c1");
      // Source 4 from 3 s to 6 s
      expect(targetOf(opts, "c1", 4.5)).toBeCloseTo(4, 12);
      act(() => editor().setPlayhead(2.5));
      act(() => editor().setPlaying(true));
      let now = 0;
      flushFrame(now);
      let writes: number | null = null;
      let pausedAt: number | null = null;
      let from: number | null = null;
      for (let k = 0; k < 2000 && livePlayhead() < 7.5; k++) {
        flushFrame((now += FRAME));
        if (!a.paused) act(() => a.present(a.currentTime));
        const t = livePlayhead();
        if (pausedAt === null && a.paused) pausedAt = t;
        if (a.plays.length === 2) {
          writes ??= a.writes;
          from ??= a.currentTime;
          // Started its latency early, still in the freeze: at that rate until it moves, the map's rate at the clock
          // below 1/16 or not
          if (a.currentTime === from) expect(a.playbackRate).toBe(a.plays[1].rate);
        }
        // On its frame, though it played into the freeze a little ahead of the clock (as the keeper leaves it)
        if (t >= 3.2 && t <= 5.8) {
          expect(a.paused).toBe(true);
          expect(Math.abs(a.currentTime - 4)).toBeLessThanOrEqual(1e-3);
        }
        if (t > 6.5) expect(lateness(opts, "c1", a, t)).toBeLessThan(0.1);
        expect(a.playbackRate).not.toBe(0);
      }
      // Played into it until its rate at the clock is below 1/16 (a pause takes no time to stop it), never its start
      // latency early
      expect(baseOf(opts, "c1", pausedAt!)).toBeLessThan(MIN_PLAYBACK_RATE);
      expect(baseOf(opts, "c1", pausedAt! - FRAME / 1000)).toBeGreaterThanOrEqual(MIN_PLAYBACK_RATE);
      // Started before it, and once more after it, at a quarter speed or more, its start latency early: no seek
      expect(a.plays).toHaveLength(2);
      expect(a.plays[1].rate).toBeGreaterThanOrEqual(MIN_START_RATE);
      expect(a.writes).toBe(writes);
      expect(a.rateRejected).toEqual([]);
    });

    it("never sets a rate an element refuses on a ramp past 16×, and plays it to the end", () => {
      // easeInOutCubic at 10×: 4 s long, peaking at 30×, standing still at both ends
      const { opts, el } = mountWarped([["c1", "e1", 40, { warp: warpOf({ speed: 10, curve: preset("easeInOutCubic") }) }]]);
      const a = el("c1");
      expect(opts.total).toBe(4);
      act(() => editor().setPlaying(true));
      let now = 0;
      flushFrame(now);
      const rates = new Set<number>();
      for (let k = 0; k < 2000 && editor().playing; k++) {
        flushFrame((now += FRAME));
        if (!a.paused) rates.add(a.playbackRate);
        // Its file ends at its Out: never past it
        expect(a.currentTime).toBeLessThanOrEqual(40);
        const t = livePlayhead();
        // Its slowing end weighs a lag more, inside the seek cooldown
        if (t >= 3.6 && t <= 3.95) expect(lateness(opts, "c1", a, t)).toBeLessThan(0.5);
      }
      expect(a.rateRejected).toEqual([]);
      expect([...rates].every((rate) => rate >= MIN_PLAYBACK_RATE && rate <= 16)).toBe(true);
      expect(Math.max(...rates)).toBe(16);
      expect(livePlayhead()).toBe(4);
      expect(editor().playing).toBe(false);
      // Behind at 16× and seeked on, a few times
      expect(a.writes).toBeGreaterThanOrEqual(1);
      expect(a.writes).toBeLessThanOrEqual(6);
    });

    it("plays a stored 50× at 16 and drives a stored 0.02× by seeks", () => {
      const fast = mountWarped([["c1", "e1", 100, { warp: warpOf({ speed: 50 }) }]]);
      act(() => editor().setPlaying(true));
      expect(fast.el("c1").playbackRate).toBe(16);
      let now = 0;
      for (let k = 0; k < 2000 && editor().playing; k++) flushFrame((now += FRAME));
      expect(fast.el("c1").rateRejected).toEqual([]);
      expect(fast.el("c1").writes).toBeGreaterThanOrEqual(1);
      fast.unmount();

      act(() => editor().setPlayhead(0));
      const slow = mountWarped([["c2", "e2", 0.2, { warp: warpOf({ speed: 0.02 }) }]]);
      const b = slow.el("c2");
      expect(slow.opts.total).toBeCloseTo(10, 9);
      act(() => editor().setPlaying(true));
      for (let k = 0; k < 600; k++) {
        flushFrame((now += FRAME));
        const t = livePlayhead();
        // Within its seek tolerance there (DRIVEN_LAG of the clock at 0.02×) and its aim
        if (t > 0.2) expect(Math.abs(b.currentTime - targetOf(slow.opts, "c2", t))).toBeLessThanOrEqual(0.0025);
      }
      expect(b.play).not.toHaveBeenCalled();
      expect(b.paused).toBe(true);
      expect(b.writes).toBeGreaterThan(5);
      expect(b.rateRejected).toEqual([]);
    });

    it("drives a reversed clip by seeks, never played, never back towards its Out", () => {
      const { opts, el } = mountWarped([["c1", "e1", 10, { warp: warpOf({ reverse: true }) }]]);
      const a = el("c1");
      act(() => editor().setPlayhead(2));
      expect(a.currentTime).toBe(targetOf(opts, "c1", 2));
      expect(a.currentTime).toBeCloseTo(8, 9);
      act(() => editor().setPlaying(true));
      flushFrame(0);
      let last = a.currentTime;
      for (let k = 1; k <= 60; k++) {
        flushFrame(16 * k);
        // The clock sets off on the first frame
        expect(livePlayhead()).toBeCloseTo(2 + 0.016 * k, 9);
        expect(a.currentTime).toBeLessThanOrEqual(last);
        last = a.currentTime;
        if (k >= 6) expect(Math.abs(a.currentTime - targetOf(opts, "c1", livePlayhead()))).toBeLessThanOrEqual(0.1);
      }
      expect(a.play).not.toHaveBeenCalled();
      expect(a.paused).toBe(true);
      expect(a.rateWrites).toBe(0);
      expect(a.rateRejected).toEqual([]);
    });

    it("drives a reversed clip from its start at the last frame before its Out, never its file's end", () => {
      const { el } = mountWarped([["c1", "e1", 10, { warp: warpOf({ reverse: true }) }]]);
      const a = el("c1");
      act(() => editor().setPlaying(true));
      flushFrame(0);
      for (let k = 1; k <= 10; k++) flushFrame(16 * k);
      expect(a.seekTargets.every((point) => point <= 10 - OUT_MARGIN + 1e-12)).toBe(true);
      expect(a.ended).toBe(false);
      expect(a.currentTime).toBeLessThan(9.9);
    });

    it("keeps one seek of a reversed clip in flight, aimed ahead of the clock", () => {
      const { opts, el } = mountWarped([["c1", "e1", 10, { warp: warpOf({ reverse: true }) }]], { seekMs: 40 });
      const a = el("c1");
      act(() => editor().setPlayhead(2));
      let now = 0;
      flushFrame(now);
      act(() => editor().setPlaying(true));
      for (let k = 0; k < 20 && livePlayhead() === 2; k++) flushFrame((now += 16));
      a.writes = 0;
      a.writesWhileSeeking = 0;
      const asked: Array<[number, number]> = [];
      for (let k = 0; k < 60; k++) {
        const before = a.writes;
        flushFrame((now += 16));
        if (a.writes > before) asked.push([a.seekTargets.at(-1)!, livePlayhead()]);
      }
      expect(a.writesWhileSeeking).toBe(0);
      expect(a.writes).toBeGreaterThanOrEqual(10);
      expect(a.writes).toBeLessThanOrEqual(16);
      // Once the lead is learnt, each aimed at least 0.03 s of the clock on (earlier in its source)
      for (const [point, at] of asked.slice(-5)) expect(point).toBeLessThanOrEqual(targetOf(opts, "c1", at) - 0.03);
    });

    it("sets the clock off inside a reversed clip once its seek has landed", () => {
      const { el } = mountWarped([["c1", "e1", 10, { warp: warpOf({ reverse: true }) }]], { seekMs: 40 });
      act(() => editor().setPlayhead(3));
      expect(el("c1").seeking).toBe(true);
      act(() => editor().setPlaying(true));
      flushFrame(0);
      flushFrame(16);
      flushFrame(32);
      flushFrame(48);
      expect(livePlayhead()).toBe(3);
      flushFrame(148);
      expect(livePlayhead()).toBeCloseTo(3.1, 9);
    });

    it("cuts into a reversed clip at its first frame, prepared, with no hold", () => {
      const { el } = mountWarped(
        [
          ["c1", "e1", 5],
          ["c2", "e2", 5, { warp: warpOf({ reverse: true }) }],
        ],
        { seekMs: 40 },
      );
      const [a, b] = [el("c1"), el("c2")];
      act(() => editor().setPlayhead(4));
      act(() => editor().setPlaying(true));
      let now = 0;
      while (b.style.opacity !== "1" && now < 3000) flushFrame((now += 16));
      expect(b.play).not.toHaveBeenCalled();
      expect(b.seekTargets[0]).toBeCloseTo(5 - OUT_MARGIN, 12);
      expect(livePlayhead()).toBeLessThan(5 + 2 * 0.016);
      expect(b.currentTime).toBeGreaterThanOrEqual(4.9);
      const shown = b.currentTime;
      let last = shown;
      for (let k = 0; k < 10; k++) {
        flushFrame((now += 16));
        expect(b.currentTime).toBeLessThanOrEqual(last);
        last = b.currentTime;
        if (k === 0) expect(a.paused).toBe(true);
      }
      expect(b.currentTime).toBeLessThan(shown);
    });

    it.each([
      [0.5, false],
      [0.1, true],
    ])("keeps a reversed %s× clip coming up as near its first frame as it is kept driven (put back: %s)", (speed, putBack) => {
      const { el } = mountWarped([
        ["c1", "e1", 5],
        ["c2", "e2", 10, { inSec: 2, outSec: 3, warp: warpOf({ reverse: true, speed }) }],
      ]);
      const b = el("c2");
      act(() => editor().setPlayhead(4));
      act(() => editor().setPlaying(true));
      let now = 0;
      for (let k = 0; k < 5; k++) flushFrame((now += 16));
      expect(b.paused).toBe(true);
      expect(b.currentTime).toBeCloseTo(3 - OUT_MARGIN, 12);
      // 0.01 s of source off: within SEEK_TOLERANCE, past the 0.008 a tenth of a speed is kept within
      b.currentTime -= 0.01;
      const writes = b.writes;
      flushFrame((now += 16));
      expect(b.writes).toBe(putBack ? writes + 1 : writes);
      expect(b.currentTime).toBeCloseTo(3 - OUT_MARGIN - (putBack ? 0 : 0.01), 12);
    });

    it("shows a reversed clip trimmed at its Out from the last frame before it", () => {
      const { el } = mountWarped(
        [
          ["c1", "e1", 5],
          ["c2", "e2", 5, { outSec: 4, warp: warpOf({ reverse: true }) }],
        ],
        { seekMs: 40 },
      );
      const b = el("c2");
      act(() => editor().setPlayhead(4));
      act(() => editor().setPlaying(true));
      let now = 0;
      for (let k = 0; k < 10; k++) flushFrame((now += 16));
      expect(b.seekTargets[0]).toBeCloseTo(4 - OUT_MARGIN, 12);
      act(() => editor().setPlaying(false));
      act(() => editor().setPlayhead(5));
      for (let k = 0; k < 10; k++) flushFrame((now += 16));
      expect(b.currentTime).toBeCloseTo(4 - OUT_MARGIN, 12);
    });

    it("cuts out of a reversed clip on the clock", () => {
      const { el } = mountWarped([
        ["c1", "e1", 5, { warp: warpOf({ reverse: true }) }],
        ["c2", "e2", 5],
      ]);
      const [a, b] = [el("c1"), el("c2")];
      act(() => editor().setPlayhead(4.5));
      act(() => editor().setPlaying(true));
      let now = 0;
      while (b.style.opacity !== "1" && now < 3000) flushFrame((now += 16));
      expect(livePlayhead()).toBeGreaterThanOrEqual(5 - 1e-9);
      expect(a.currentTime).toBeLessThan(0.2);
    });

    it.each([
      ["a 2× clip", warpOf({ speed: 2 }), { 1.5: 3 }],
      ["an ease-in-out ramp", warpOf({ curve: preset("easeInOutSine") }), {}],
      ["a reversed clip", warpOf({ reverse: true }), { 1.5: 8.5 }],
    ] as const)("shows %s paused at the frame its map gives", (_name, warp, independent: Record<number, number>) => {
      const { opts, el } = mountWarped([["c1", "e1", 10, { warp }]]);
      const a = el("c1");
      for (const t of [1.5, 0, 3.25]) {
        act(() => editor().setPlayhead(t));
        // A reversed clip's first frame is the last before its Out
        if (warp.reverse && t === 0) expect(a.currentTime).toBeCloseTo(10 - OUT_MARGIN, 12);
        else expect(a.currentTime).toBe(targetOf(opts, "c1", t));
        if (t in independent) expect(a.currentTime).toBeCloseTo(independent[t], 9);
      }
    });

    describe("its sound", () => {
      it.each([
        ["5×", 20, 5],
        ["0.2×", 2, 0.2],
      ])("silences a constant %s, whose sound the render drops, without ever turning it on", (_name, source, speed) => {
        const { el } = mountWarped([["c1", "e1", source, { warp: warpOf({ speed }) }]]);
        const a = el("c1");
        act(() => editor().setPlaying(true));
        let now = 0;
        for (let k = 0; k < 2000 && livePlayhead() < 2; k++) {
          flushFrame((now += FRAME));
          expectSilent(a);
        }
        expect(a.soundSwitches).toBe(0);
      });

      it("keeps the sound of a 2× clip and of a fast ramp, and silences a speed edited past 4× while it plays", () => {
        const rows = (speed: number): WarpedRow[] => [["c1", "e1", 20, { warp: warpOf({ speed }) }]];
        const { el, rerender } = mountWarped(rows(2));
        const a = el("c1");
        act(() => editor().setPlaying(true));
        let now = 0;
        flushFrame(now);
        flushFrame((now += 100));
        expect(a.volume).toBe(1);
        rerender(warpedOptions(rows(5)));
        flushFrame((now += FRAME));
        expectSilent(a);
        rerender(warpedOptions(rows(2)));
        flushFrame((now += FRAME));
        expect(a.volume).toBe(1);
        expect(a.soundSwitches).toBe(0);
        act(() => editor().setPlaying(false));

        const ramp = mountWarped([["c2", "e2", 20, { warp: warpOf({ speed: 5, curve: preset("easeInOutSine") }) }]]);
        act(() => editor().setPlayhead(2));
        act(() => editor().setPlaying(true));
        flushFrame((now += FRAME));
        flushFrame((now += 100));
        expect(ramp.el("c2").volume).toBe(1);
      });

      it("fades a ramp's sound below a quarter speed as the render does, and is silent driven by seeks", () => {
        // easeOutQuad over 10 s: 2× at its start, slowing to a standstill at its end
        const { opts, el } = mountWarped([["c1", "e1", 10, { warp: warpOf({ curve: preset("easeOutQuad") }) }]]);
        const a = el("c1");
        act(() => editor().setPlayhead(8));
        act(() => editor().setPlaying(true));
        let now = 0;
        let faded = 0;
        let driven = 0;
        for (let k = 0; k < 2000 && editor().playing; k++) {
          flushFrame((now += FRAME));
          const base = baseOf(opts, "c1", livePlayhead());
          // Paused: no sound at all
          if (a.paused) {
            driven++;
            continue;
          }
          expect(a.volume).toBeCloseTo(Math.max(1e-5, soundShare(base)), 12);
          if (base < MIN_START_RATE) faded++;
        }
        expect(faded).toBeGreaterThan(10);
        // Its last stretch, slower than an element plays
        expect(driven).toBeGreaterThan(10);
        expect(a.soundSwitches).toBe(0);
      });

      it("keeps a reversed clip silent", () => {
        const { el } = mountWarped([["c1", "e1", 10, { warp: warpOf({ reverse: true }) }]]);
        const a = el("c1");
        act(() => editor().setPlaying(true));
        let now = 0;
        for (let k = 0; k < 120; k++) {
          flushFrame((now += FRAME));
          expectSilent(a);
        }
      });
    });

    it("leaves a clip at its own speed as it is beside a retimed one, and as it was once its warp goes", () => {
      const rows = (warp?: ClipWarp): WarpedRow[] => [
        ["c1", "e1", 5],
        ["c2", "e2", 10, warp ? { warp } : {}],
      ];
      const { el, rerender } = mountWarped(rows(warpOf({ speed: 2 })));
      const [a, b] = [el("c1"), el("c2")];
      act(() => editor().setPlayhead(4));
      act(() => editor().setPlaying(true));
      let now = 0;
      for (let k = 0; k < 2000 && livePlayhead() < 6; k++) {
        flushFrame((now += FRAME));
        expect(NUDGED).toContain(a.playbackRate);
        expect(a.preservesPitch).toBe(true);
      }
      expect(b.plays.length).toBeGreaterThan(0);
      expect(b.plays.every((p) => p.rate === 2 && !p.preservesPitch)).toBe(true);
      const writes = b.writes;
      rerender(warpedOptions(rows()));
      flushFrame((now += FRAME));
      expect(b.preservesPitch).toBe(true);
      expect(b.writes).toBe(writes + 1);
      expect(b.playbackRate).toBe(1);
    });

    it("follows a speed edited while it plays at once, with one seek", () => {
      const rows = (speed: number): WarpedRow[] => [["c1", "e1", 20, { warp: warpOf({ speed }) }]];
      const { el, rerender } = mountWarped(rows(2));
      const a = el("c1");
      act(() => editor().setPlaying(true));
      flushFrame(0);
      flushFrame(1000);
      const faster = warpedOptions(rows(4));
      rerender(faster);
      flushFrame(1000 + FRAME);
      expect(a.playbackRate).toBe(4);
      expect(a.writes).toBe(1);
      expect(a.currentTime).toBeCloseTo(targetOf(faster, "c1", livePlayhead() + 0.1), 6);
    });

    it("draws a reversed clip's last landed frame in a crossfade while its next seek is in flight", () => {
      vi.stubGlobal("OffscreenCanvas", FakeOffscreen);
      const { el, result } = mountWarped(
        [
          ["c1", "e1", 5],
          ["c2", "e2", 5, { warp: warpOf({ reverse: true }) }],
        ],
        { stack: { crossfade: true }, seekMs: 40 },
      );
      const [a, b] = [el("c1"), el("c2")];
      const { canvas, draws } = blendCanvas(result);
      act(() => editor().setPlayhead(3.9));
      act(() => editor().setPlaying(true));
      let now = 0;
      let seeking = 0;
      const shown = new Set<number>();
      for (let k = 0; k < 2000 && livePlayhead() < 4.9; k++) {
        draws.length = 0;
        flushFrame((now += 16));
        const t = livePlayhead();
        if (t < 4.02 || t > 4.9) continue;
        expect(draws).toHaveLength(2);
        expect(draws[0]).toEqual([a, 1]);
        expect(draws[1][1]).toBeCloseTo(t - 4, 9);
        if (b.seeking) {
          seeking++;
          // The frame it landed on last, the seek before the one in flight
          const still = draws[1][0] as FakeOffscreen;
          expect(still).toBeInstanceOf(FakeOffscreen);
          expect(still.copiedAt).toBe(b.seekTargets.at(-2));
          shown.add(still.copiedAt);
        }
      }
      expect(seeking).toBeGreaterThan(5);
      expect(shown.size).toBeGreaterThan(3);
      for (let k = 0; k < 20; k++) flushFrame((now += 16));
      expect(canvas.style.opacity).toBe("0");
    });

    describe("in a blend, driven by seeks forwards", () => {
      // Slow from its start, then a freeze at 9.5 of its source from 9.2 s into it
      const slowStartAndFreeze: ClipWarpCurve = {
        kind: "points",
        points: [
          [0, 0],
          [0.1, 0.01],
          [0.3, 0.3],
          [0.92, 0.95],
          [0.97, 0.95],
          [1, 1],
        ],
      };

      it.each([
        ["an ease-in fading in", [["A", "e1", 5], ["B", "e2", 10, { warp: warpOf({ curve: preset("easeInQuad") }) }]], 3.9, 5, null],
        ["an ease-out fading out to its Out", [["B", "e1", 5, { warp: warpOf({ curve: preset("easeOutCubic") }) }], ["A", "e2", 5]], 3.9, 5, null],
        [
          "a ramp into its second slow stretch, after a stall",
          [["A", "e1", 5], ["B", "e2", 10, { warp: warpOf({ curve: slowStartAndFreeze }) }], ["C", "e3", 5]],
          12.5,
          14,
          // A decoder that falls a little behind as it slows into its freeze
          [12.95, 13.05],
        ],
      ] as Array<[string, WarpedRow[], number, number, [number, number] | null]>)(
        "keeps %s in the blend on every frame, the frame it showed standing in while it seeks",
        (_name, rows, from, to, stall) => {
          vi.stubGlobal("OffscreenCanvas", FakeOffscreen);
          const { opts, el, result } = mountWarped(rows, { stack: { crossfade: true }, seekMs: 40 });
          const b = el("B");
          const { canvas, draws } = blendCanvas(result);
          act(() => editor().setPlayhead(from));
          act(() => editor().setPlaying(true));
          let now = 0;
          let stood = 0;
          for (let k = 0; k < 2000 && livePlayhead() < to; k++) {
            draws.length = 0;
            b.frozen = stall !== null && livePlayhead() >= stall[0] && livePlayhead() < stall[1];
            flushFrame((now += 16));
            const t = livePlayhead();
            if (canvas.style.opacity !== "1") continue;
            expect(draws).toHaveLength(2);
            const image = draws.map(([d]) => d).find((d) => d === b || d instanceof FakeOffscreen);
            if (b.seeking) {
              stood++;
              // Never a frame from an earlier stretch
              expect(image).toBeInstanceOf(FakeOffscreen);
              expect(Math.abs((image as FakeOffscreen).copiedAt - targetOf(opts, "B", t))).toBeLessThan(0.1);
            } else {
              expect(image).toBe(b);
            }
          }
          expect(stood).toBeGreaterThan(3);
        },
      );

      it("never draws an old frame for a ramp seeked by its keeper while it plays", () => {
        vi.stubGlobal("OffscreenCanvas", FakeOffscreen);
        const { el, result } = mountWarped(
          [
            ["B", "e1", 5, { warp: warpOf({ curve: preset("easeInQuad") }) }],
            ["A", "e2", 5],
          ],
          { stack: { crossfade: true }, seekMs: 40 },
        );
        const b = el("B");
        const { canvas, draws } = blendCanvas(result);
        act(() => editor().setPlaying(true));
        let now = 0;
        let seeked = 0;
        for (let k = 0; k < 2000 && livePlayhead() < 4.9; k++) {
          draws.length = 0;
          // Driven by seeks from its first frame (frames kept for a blend), then played; a stall in the blend has its
          // keeper seek it on while it plays
          b.frozen = livePlayhead() >= 4.1 && livePlayhead() < 4.4;
          flushFrame((now += 16));
          if (canvas.style.opacity !== "1" || !b.seeking) continue;
          seeked++;
          expect(b.paused).toBe(false);
          expect(draws.some(([d]) => d instanceof FakeOffscreen)).toBe(false);
        }
        expect(seeked).toBeGreaterThan(0);
      });

      it("never draws a frame from before a ramp fell far behind where it is slower than it is started at", () => {
        vi.stubGlobal("OffscreenCanvas", FakeOffscreen);
        // From about 1× into a slow middle under a quarter speed (1/16 at its slowest) in the crossfade's second half
        const slowMiddle: ClipWarpCurve = {
          kind: "points",
          points: [
            [0, 0],
            [0.02, 0.02],
            [0.09, 0.03],
            [1, 1],
          ],
        };
        const { opts, el, result } = mountWarped(
          [
            ["A", "e1", 5],
            ["B", "e2", 10, { warp: warpOf({ curve: slowMiddle }) }],
          ],
          { stack: { crossfade: true }, seekMs: 40 },
        );
        const b = el("B");
        const { canvas, draws } = blendCanvas(result);
        act(() => editor().setPlayhead(4.1));
        act(() => editor().setPlaying(true));
        let now = 0;
        let behind = false;
        let driven = 0;
        for (let k = 0; k < 2000 && livePlayhead() < 5; k++) {
          draws.length = 0;
          // Put 0.1 s of source behind where it is slow (a stall's lag at once): far enough to be seeked, so driven by
          // seeks from there
          if (!behind && baseOf(opts, "B", livePlayhead()) < 0.15) {
            behind = true;
            b.currentTime = targetOf(opts, "B", livePlayhead()) - 0.1;
          }
          flushFrame((now += 16));
          const t = livePlayhead();
          if (canvas.style.opacity !== "1") continue;
          if (b.paused) driven++;
          for (const [image] of draws) {
            if (image instanceof FakeOffscreen) {
              expect(Math.abs(image.copiedAt - targetOf(opts, "B", t)) / driftScale(baseOf(opts, "B", t))).toBeLessThan(0.1);
            }
          }
        }
        expect(driven).toBeGreaterThan(3);
      });

      it("keeps a retimed layer's frame in the blend while a move inside the crossfade seeks it", () => {
        vi.stubGlobal("OffscreenCanvas", FakeOffscreen);
        const { el, result } = mountWarped(
          [
            ["A", "e1", 5],
            ["B", "e2", 10, { warp: warpOf({ speed: 2 }) }],
          ],
          { stack: { crossfade: true }, seekMs: 40 },
        );
        const b = el("B");
        const { canvas, draws } = blendCanvas(result);
        act(() => editor().setPlayhead(3.9));
        act(() => editor().setPlaying(true));
        let now = 0;
        for (let k = 0; k < 2000 && livePlayhead() < 4.3; k++) flushFrame((now += 16));
        for (let k = 0; k < 10; k++) flushFrame((now += 16));
        expect(b.seeking).toBe(false);
        // Both already shown: nothing holds, the blend is drawn while B's priming seek lands
        act(() => editor().setPlayhead(4.7));
        let stood = 0;
        for (let k = 0; k < 20; k++) {
          draws.length = 0;
          flushFrame((now += 16));
          if (canvas.style.opacity !== "1" || !b.seeking) continue;
          expect(draws.some(([d]) => d instanceof FakeOffscreen)).toBe(true);
          stood++;
        }
        expect(stood).toBeGreaterThan(0);
      });

      it("keeps a 16× layer's frame in the blend while it is put back from past its Out", () => {
        vi.stubGlobal("OffscreenCanvas", FakeOffscreen);
        const { el, result } = mountWarped(
          [
            ["B", "e1", 100, { outSec: 80, warp: warpOf({ speed: 16 }) }],
            ["A", "e2", 5],
          ],
          { stack: { crossfade: true }, seekMs: 40 },
        );
        const b = el("B");
        const { canvas, draws } = blendCanvas(result);
        act(() => editor().setPlayhead(3.5));
        act(() => editor().setPlaying(true));
        let now = 0;
        let putBack = 0;
        for (let k = 0; k < 120; k++) {
          draws.length = 0;
          const writes = b.writes;
          // Its decoder 13 ms ahead of the clock once (inside IN_STEP), within a frame of its Out: it runs past it
          if (livePlayhead() > 4.97 && livePlayhead() < 4.98) b.advance(13, now);
          flushFrame((now += 16));
          if (b.writes === writes || !b.seeking || canvas.style.opacity !== "1") continue;
          expect(b.seekTargets.at(-1)).toBeCloseTo(80 - OUT_MARGIN, 9);
          expect(draws.some(([d]) => d instanceof FakeOffscreen)).toBe(true);
          putBack++;
        }
        expect(putBack).toBe(1);
      });
    });

    it("cuts between the pieces of a 2× clip split in a placed stack like any two clips", () => {
      const { opts, el } = mountWarped(
        [
          ["A1", "e1", 10, { inSec: 0, outSec: 4, startSec: 0, warp: warpOf({ speed: 2 }) }],
          ["A2", "e1", 10, { inSec: 4, startSec: 2, warp: warpOf({ speed: 2 }) }],
        ],
        { stack: { crossfade: true } },
      );
      const [a1, a2] = [el("A1"), el("A2")];
      act(() => editor().setPlayhead(0.5));
      act(() => editor().setPlaying(true));
      let now = 0;
      while (a2.style.opacity !== "1" && now < 3000) flushFrame((now += 16));
      // Its pre-roll point: 4 − min(0.5 × 2, 4)
      expect(a2.seekTargets[0]).toBe(3);
      expect(a2.writes).toBe(2);
      expect(a2.plays.every((p) => p.rate === 2)).toBe(true);
      expect(livePlayhead()).toBeLessThan(2 + 2 * 0.016);
      const early = a2.currentTime - targetOf(opts, "A2", livePlayhead());
      expect(early).toBeGreaterThan(-0.04);
      expect(early).toBeLessThan(0.12);
      flushFrame((now += 16));
      expect(a1.paused).toBe(true);
    });

    it("plays the split pieces of a 2× clip over a lower row as one run, with no fade at their join", () => {
      // A1 [1, 3) and A2 [3, 6) over B [0, 6): one run fades in over B once, and stays in front to its end
      const { el, result } = mountWarped(
        [
          ["A1", "e1", 10, { inSec: 0, outSec: 4, startSec: 1, warp: warpOf({ speed: 2 }) }],
          ["A2", "e1", 10, { inSec: 4, startSec: 3, warp: warpOf({ speed: 2 }) }],
          ["B", "e2", 6, { startSec: 0 }],
        ],
        { stack: { crossfade: true } },
      );
      const a2 = el("A2");
      const ctx = { globalAlpha: 1, fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn() };
      const canvas = { style: { opacity: "" }, width: 0, height: 0, clientWidth: 640, clientHeight: 360, getContext: vi.fn(() => ctx) };
      act(() => result.current.registerCanvas(canvas as unknown as HTMLCanvasElement));
      act(() => editor().setPlayhead(2.5));
      act(() => editor().setPlaying(true));
      let now = 0;
      let seen = false;
      for (let k = 0; k < 2000 && livePlayhead() < 3.1; k++) {
        flushFrame((now += 16));
        const t = livePlayhead();
        if (t < 2.9) continue;
        expect(canvas.style.opacity).not.toBe("1");
        if (t >= 3) {
          expect(a2.style.opacity).toBe("1");
          seen = true;
        }
      }
      expect(seen).toBe(true);
    });

    it("learns a retimed start's latency in wall seconds", () => {
      const { result } = mountWarped([["c1", "e1", 20, { warp: warpOf({ speed: 2 }) }]], { startMs: 250 });
      act(() => editor().setPlaying(true));
      let now = 0;
      const first = made[0];
      for (let k = 0; k < 2000 && livePlayhead() < 1; k++) {
        flushFrame((now += 16));
        if (!first.paused) act(() => first.present(first.currentTime));
      }
      const second = Object.assign(fakeMedia({ duration: 20, startMs: 250 }), { src: "blob:e1" });
      act(() => {
        result.current.registerVideo("c1", null);
        result.current.registerVideo("c1", asVideo(second));
      });
      flushFrame((now += 16));
      expect(second.play).toHaveBeenCalledTimes(1);
      // Started where the map will be a quarter of a second on: half a second of source
      const ahead = second.currentTime - 2 * livePlayhead();
      expect(ahead).toBeGreaterThan(0.46);
      expect(ahead).toBeLessThan(0.54);
    });

    it("never shows a frame past a retimed clip's Out through an end freeze, held on its last frame by its seeks", () => {
      const rows: WarpedRow[] = [
        ["c1", "e1", 10, { outSec: 4.03, warp: warpOf({ curve: endFreeze }) }],
        ["c2", "e2", 5],
      ];
      const { el } = mountWarped(rows);
      const [a, b] = [el("c1"), el("c2")];
      act(() => editor().setPlaying(true));
      let now = 0;
      for (let k = 0; k < 2000 && b.style.opacity !== "1"; k++) {
        flushFrame((now += FRAME));
        if (b.style.opacity === "1") break;
        expect(a.currentTime).toBeLessThan(4.03 - 0.0005);
        if (livePlayhead() > 3) {
          expect(a.paused).toBe(true);
          expect(a.currentTime).toBeGreaterThanOrEqual(4.03 - 0.003);
        }
      }
      expect(livePlayhead()).toBeGreaterThanOrEqual(4.03 - 0.03);
      expect(a.play).toHaveBeenCalledTimes(1);
      expect(a.rateRejected).toEqual([]);
    });

    describe("at its Out", () => {
      // A 2× clip of 4 s of a 10 s file, then a clip at its own speed
      const rows: WarpedRow[] = [
        ["c1", "e1", 10, { outSec: 4, warp: warpOf({ speed: 2 }) }],
        ["c2", "e2", 5],
      ];

      it("holds a 2× clip that runs ahead on its last frame, paused, rather than playing what was trimmed off", () => {
        const { opts, el } = mountWarped(rows);
        const [a, b] = [el("c1"), el("c2")];
        act(() => editor().setPlayhead(1.5));
        act(() => editor().setPlaying(true));
        let now = 0;
        flushFrame(now);
        for (let k = 0; k < 2000 && livePlayhead() < 1.8; k++) flushFrame((now += FRAME));
        // 0.3 s of source ahead, 0.15 s of the clock: nudged back, never seeked
        a.currentTime = targetOf(opts, "c1", livePlayhead()) + 0.3;
        let furthest = 0;
        let pausedAtCut = false;
        for (let k = 0; k < 2000 && b.style.opacity !== "1"; k++) {
          flushFrame((now += FRAME));
          if (b.style.opacity === "1") break;
          furthest = Math.max(furthest, a.currentTime);
          pausedAtCut = a.paused;
        }
        // At most a refresh of movement past its end point, and left on its last frame
        expect(furthest).toBeLessThan(4 + (2 * FRAME) / 1000);
        expect(a.currentTime).toBeLessThanOrEqual(4 - OUT_MARGIN + 1e-12);
        expect(pausedAtCut).toBe(true);
      });

      it("puts a clip held at its Out back on its last frame once when its picture already shows the frame there", () => {
        const { el } = mountWarped(rows);
        const [a, b] = [el("c1"), el("c2")];
        act(() => editor().setPlayhead(1.5));
        act(() => editor().setPlaying(true));
        let now = 0;
        flushFrame(now);
        for (let k = 0; k < 2000 && livePlayhead() < 1.8; k++) flushFrame((now += FRAME));
        // Ahead of the clock, just short of its end point: held there, its time left as it is
        a.frozen = true;
        a.currentTime = 4 - OUT_MARGIN - 0.0005;
        flushFrame((now += FRAME));
        a.frozen = false;
        expect(a.paused).toBe(true);
        expect(a.currentTime).toBe(4 - OUT_MARGIN - 0.0005);
        const writes = a.writes;
        // Its picture went on to the frame at its Out, as a browser's runs ahead of currentTime
        act(() => a.present(4));
        flushFrame((now += FRAME));
        expect(a.writes).toBe(writes + 1);
        expect(a.currentTime).toBe(4 - OUT_MARGIN);
        for (let k = 0; k < 5; k++) flushFrame((now += FRAME));
        expect(b.style.opacity).not.toBe("1");
        expect(a.writes).toBe(writes + 1);
      });

      it.each([0.5, 0.25])("holds a %s× clip whose picture runs a frame ahead once it shows the frame at its Out", (speed) => {
        // c1 ends at 2; its 24 fps file presented a frame ahead of currentTime while it plays, as Chromium's is
        const out = 2 + 2 * speed;
        const { el } = mountWarped([
          ["c1", "e1", 10, { inSec: 2, outSec: out, warp: warpOf({ speed }) }],
          ["c2", "e2", 5],
        ]);
        const [a, b] = [el("c1"), el("c2")];
        act(() => editor().setPlayhead(1));
        act(() => editor().setPlaying(true));
        let now = 0;
        let shownFrame = -1;
        let pastOut = 0;
        for (let k = 0; k < 2000 && b.style.opacity !== "1"; k++) {
          flushFrame((now += FRAME));
          if (a.seeking) continue;
          // Paused (held, or put back), the frame in effect at its time
          const frame = frame24(a.currentTime) + (a.paused ? 0 : 1 / 24);
          if (frame !== shownFrame) {
            shownFrame = frame;
            act(() => a.present(frame));
          }
          if (a.style.opacity === "1" && shownFrame >= out - 1e-9) pastOut++;
        }
        // Only the refresh it came out on (left playing, a source frame of its time: 5 at 0.5×, 9 at a quarter)
        expect(pastOut).toBeLessThanOrEqual(1);
        expect(a.paused).toBe(true);
        expect(a.currentTime).toBeLessThanOrEqual(out - OUT_MARGIN + 1e-12);
        expect(livePlayhead()).toBeLessThan(2 + FRAME / 1000 + 1e-9);
      });

      it.each([16, 4])("puts a %i× clip that ran past its Out between two frames back on its last frame", (speed) => {
        const placed = (): WarpedRow[] => [
          ["c1", "e1", 40, { outSec: 2 * speed, startSec: 0, warp: warpOf({ speed }) }],
          ["c2", "e2", 5, { startSec: 3 }],
        ];
        const { opts, el } = mountWarped(placed(), { stack: { crossfade: false } });
        const a = el("c1");
        act(() => editor().setPlayhead(1.5));
        act(() => editor().setPlaying(true));
        let now = 0;
        let bumped = false;
        for (let k = 0; k < 200 && livePlayhead() < 2.2; k++) {
          flushFrame((now += FRAME));
          const t = livePlayhead();
          // 30 ms of the clock ahead, inside IN_STEP: left there, so it passes its Out before the clock does
          if (!bumped && t > 1.8) {
            bumped = true;
            a.currentTime = targetOf(opts, "c1", t) + 0.03 * speed;
          }
          // Then a gap: nothing hands over, it holds
          if (a.style.opacity === "1") expect(a.currentTime).toBeLessThanOrEqual(2 * speed - OUT_MARGIN + 1e-12);
        }
        expect(a.paused).toBe(true);
      });

      it.each([10, 4])("never shows a %i× clip past its Out while the cut after it waits for the next clip's frame", (speed) => {
        // Stacked, lined up, Crossfade off: c1, reversed, plays hidden under c0 and is revealed at c0's end with a seek
        // in flight, so the cut holds the picture on c0
        const rows: WarpedRow[] = [
          ["c0", "e0", 9, { outSec: 8.8, warp: warpOf({ speed }) }],
          ["c1", "e1", 3, { inSec: 1, outSec: 2.5, warp: warpOf({ reverse: true }) }],
        ];
        let held = 0;
        for (const d of [0, 0.003, 0.006, 0.009, 0.012, 0.015]) {
          const { opts, el, unmount } = mountWarped(rows, { stack: { crossfade: false }, seekMs: 40 });
          const a = el("c0");
          const end = spanOf(opts, "c0").end;
          act(() => editor().setPlayhead(end - 0.6 + d));
          act(() => editor().setPlaying(true));
          let now = 0;
          flushFrame(now);
          for (let k = 0; k < 120 && livePlayhead() < end + 0.3; k++) {
            flushFrame((now += FRAME));
            if (Number(a.style.opacity) > 0 && livePlayhead() >= end) held++;
            // The frame in effect never past the last before its Out (a 24 fps file)
            if (Number(a.style.opacity) > 0) expect(frame24(a.currentTime)).toBeLessThanOrEqual(frame24(8.8 - OUT_MARGIN));
          }
          act(() => editor().setPlaying(false));
          unmount();
        }
        expect(held).toBeGreaterThan(0);
      });

      it("holds a 10× clip moved into in its last refresh where it is, the clock set off at once", () => {
        const { opts, el } = mountWarped([
          ["c1", "e1", 40, { outSec: 20, warp: warpOf({ speed: 10 }) }],
          ["c2", "e2", 5],
        ]);
        const [a, b] = [el("c1"), el("c2")];
        act(() => editor().setPlayhead(1));
        act(() => editor().setPlaying(true));
        let now = 0;
        for (let k = 0; k < 10; k++) flushFrame((now += FRAME));
        // A move while playing to 5 ms before its end: played there, it would pass its Out before the clock moved
        const end = spanOf(opts, "c1").end;
        act(() => editor().setPlayhead(end - 0.005));
        for (let k = 0; k < 3 && b.style.opacity !== "1"; k++) {
          flushFrame((now += FRAME));
          expect(a.currentTime).toBeLessThanOrEqual(20 - OUT_MARGIN);
        }
        expect(a.paused).toBe(true);
        expect(b.style.opacity).toBe("1");
        expect(livePlayhead()).toBeGreaterThan(end);
      });

      it("plays a clip left at its Out again from its map when the playhead moves back into it", () => {
        const { opts, el } = mountWarped(rows);
        const [a, b] = [el("c1"), el("c2")];
        act(() => editor().setPlayhead(1.8));
        act(() => editor().setPlaying(true));
        let now = 0;
        flushFrame(now);
        for (let k = 0; k < 2000 && livePlayhead() < 2.5; k++) flushFrame((now += FRAME));
        expect(b.style.opacity).toBe("1");
        act(() => editor().setPlayhead(0.5));
        for (let k = 0; k < 30; k++) flushFrame((now += FRAME));
        expect(a.paused).toBe(false);
        expect(Math.abs(a.currentTime - targetOf(opts, "c1", livePlayhead()))).toBeLessThan(0.1);
      });

      it("never seeks a stalled clip near its Out past its last frame", () => {
        const { el } = mountWarped(rows);
        const a = el("c1");
        act(() => editor().setPlayhead(1.5));
        act(() => editor().setPlaying(true));
        let now = 0;
        flushFrame(now);
        for (let k = 0; k < 2000 && livePlayhead() < 1.7; k++) flushFrame((now += FRAME));
        const seeks = a.seekTargets.length;
        a.frozen = true;
        for (let k = 0; k < 30 && livePlayhead() < 2; k++) flushFrame((now += FRAME));
        // Seeked to where its map will be when the seek lands, within its seek time of its end: its last frame
        expect(a.seekTargets.slice(seeks)).toHaveLength(1);
        expect(a.seekTargets.at(-1)).toBeCloseTo(4 - OUT_MARGIN, 12);
      });
    });

    it("puts a paused clip back from past its Out, however near its point, and sets the clock off at once there", () => {
      const { el } = mountWarped([["c1", "e1", 10, { outSec: 4.03, warp: warpOf({ curve: endFreeze }) }]]);
      const a = el("c1");
      act(() => editor().setPlayhead(3.5));
      expect(a.currentTime).toBeCloseTo(4.03 - OUT_MARGIN, 12);
      // Past its Out, within SEEK_TOLERANCE of its point
      a.currentTime = 4.035;
      act(() => editor().setPlayhead(3.6));
      expect(a.currentTime).toBeCloseTo(4.03 - OUT_MARGIN, 12);
      // Play pressed there: held, it will not move, so the clock sets off at once
      act(() => editor().setPlaying(true));
      flushFrame(0);
      flushFrame(100);
      flushFrame(200);
      expect(livePlayhead()).toBeGreaterThan(3.7);
    });

    describe("paused in a slow clip's last frame", () => {
      // A quarter speed over half a second of a 24 fps file: its last frame (from 2.4583) lasts 1/6 s, from 1.833 to 2
      const rows: WarpedRow[] = [
        ["c1", "e1", 10, { inSec: 2, outSec: 2.5, warp: warpOf({ speed: 0.25 }) }],
        ["c2", "e2", 5],
      ];
      /** c1 played from 1 to 1.9 (2.475 of its source), each frame presented once its time reaches it. */
      const playInto = () => {
        const { el } = mountWarped(rows);
        const a = el("c1");
        act(() => editor().setPlayhead(1));
        act(() => editor().setPlaying(true));
        let now = 0;
        for (let k = 0; k < 2000 && livePlayhead() < 1.9; k++) {
          flushFrame((now += FRAME));
          act(() => a.present(frame24(a.currentTime)));
        }
        expect(frame24(a.currentTime)).toBeCloseTo(frame24(2.49), 12);
        return a;
      };

      it("puts it back once when its picture had gone on to the frame at its Out", () => {
        const a = playInto();
        // A frame ahead of its time, as a browser's runs, and paused before the next frame
        act(() => a.present(2.5));
        const writes = a.writes;
        act(() => editor().setPlaying(false));
        expect(a.writes).toBe(writes + 1);
        expect(a.currentTime).toBeLessThanOrEqual(2.5 - OUT_MARGIN);
        // Answered: a move within the frame before it presents the frame there asks nothing more
        act(() => editor().setPlayhead(editor().playhead + 0.002));
        expect(a.writes).toBe(writes + 1);
      });

      it("puts it back once when that frame comes out after the pause", () => {
        const a = playInto();
        const writes = a.writes;
        act(() => editor().setPlaying(false));
        expect(a.writes).toBe(writes);
        act(() => a.present(2.5));
        expect(a.writes).toBe(writes + 1);
        expect(a.currentTime).toBeLessThanOrEqual(2.5 - OUT_MARGIN);
        act(() => a.present(frame24(a.currentTime)));
        expect(a.writes).toBe(writes + 1);
      });
    });

    it("never shows a frame past the Out of a constant 0.1× clip", () => {
      const { el } = mountWarped([
        ["c1", "e1", 10, { outSec: 0.4, warp: warpOf({ speed: 0.1 }) }],
        ["c2", "e2", 5],
      ]);
      const [a, b] = [el("c1"), el("c2")];
      act(() => editor().setPlaying(true));
      let now = 0;
      for (let k = 0; k < 2000 && b.style.opacity !== "1"; k++) {
        flushFrame((now += FRAME));
        if (b.style.opacity !== "1") expect(a.currentTime).toBeLessThan(0.4);
      }
      expect(b.style.opacity).toBe("1");
    });

    it.each([
      ["a 0.1× clip", warpOf({ speed: 0.1 }), 2.43],
      ["an ease-in", warpOf({ curve: preset("easeInQuad") }), null],
    ] as const)("cuts into %s without waiting on a frame a source frame old", (_name, warp, outSec) => {
      const { el } = mountWarped([
        ["c1", "e1", 5],
        ["c2", "e2", 10, { inSec: 2.03, ...(outSec !== null ? { outSec } : {}), warp }],
      ]);
      const [a, b] = [el("c1"), el("c2")];
      act(() => editor().setPlayhead(4));
      act(() => editor().setPlaying(true));
      let now = 0;
      for (let k = 0; k < 2000 && b.style.opacity !== "1"; k++) {
        flushFrame((now += FRAME));
        act(() => {
          a.present(frame24(a.currentTime));
          b.present(frame24(b.currentTime));
        });
      }
      // Its frame is 2.0, its target 2.03: shown on the first frame at the cut
      expect(livePlayhead()).toBeGreaterThanOrEqual(5 - 0.03);
      expect(livePlayhead()).toBeLessThan(5 + FRAME / 1000 + 1e-6);
    });

    it("cuts into a 4× clip whose last frame out is under a frame of its sequence time behind", () => {
      const { opts, el } = mountWarped([
        ["c1", "e1", 5, { outSec: 2.5 }],
        ["c2", "e2", 20, { inSec: 2, warp: warpOf({ speed: 4 }) }],
      ]);
      const [a, b] = [el("c1"), el("c2")];
      act(() => editor().setPlayhead(1.5));
      act(() => editor().setPlaying(true));
      let now = 0;
      flushFrame(now);
      while (livePlayhead() + 0.016 < 2.5) {
        flushFrame((now += 16));
        if (!a.paused) act(() => a.present(a.currentTime));
      }
      // 0.2 s of source short of where the clock will be next frame, 0.05 s of the clock: stale only from 0.4
      act(() => b.present(targetOf(opts, "c2", livePlayhead() + 0.016) - 0.2));
      flushFrame((now += 16));
      expect(livePlayhead()).toBeGreaterThan(2.5);
      expect(b.style.opacity).toBe("1");
    });

    it("starts a slow clip reached late without a seek for less than a source frame", () => {
      const { el } = mountWarped([
        ["c1", "e1", 5],
        ["c2", "e2", 10, { inSec: 2, warp: warpOf({ speed: 0.1 }) }],
      ]);
      const b = el("c2");
      act(() => editor().setPlayhead(3));
      act(() => editor().setPlaying(true));
      let now = 0;
      for (let k = 0; k < 2000 && livePlayhead() < 4.38; k++) flushFrame((now += 16));
      // Test-started and put back at its pre-roll point, 0.05 s of source before its In
      expect(b.paused).toBe(true);
      expect(b.currentTime).toBeCloseTo(1.95, 9);
      const writes = b.writes;
      const plays = b.plays.length;
      // Its start, due at 4.46, reached 0.06 s late: 0.003 s of source apart, inside SEEK_TOLERANCE × a quarter
      flushFrame((now += (4.52 - livePlayhead()) * 1000));
      expect(b.plays.length).toBe(plays + 1);
      for (let k = 0; k < 10; k++) flushFrame((now += 16));
      expect(b.writes).toBe(writes);
    });

    it("starts a clip whose warp went while it waited at its own rate and pitch", () => {
      const rows = (warp?: ClipWarp): WarpedRow[] => [
        ["c1", "e1", 5],
        ["c2", "e2", 10, { inSec: 2, ...(warp ? { warp } : {}) }],
      ];
      const { el, rerender } = mountWarped(rows(warpOf({ speed: 2 })));
      const b = el("c2");
      act(() => editor().setPlayhead(3));
      act(() => editor().setPlaying(true));
      let now = 0;
      for (let k = 0; k < 2000 && b.plays.length === 0; k++) flushFrame((now += 16));
      expect(b.plays[0]).toEqual({ rate: 2, preservesPitch: false });
      const plain = warpedOptions(rows());
      rerender(plain);
      for (let k = 0; k < 2000 && b.style.opacity !== "1"; k++) flushFrame((now += 16));
      expect(b.plays.at(-1)).toEqual({ rate: 1, preservesPitch: true });
      expect(b.playbackRate).toBe(1);
      expect(Math.abs(b.currentTime - targetOf(plain, "c2", livePlayhead()))).toBeLessThan(0.12);
    });

    it("seeks a reversed layer hidden under a higher row as it would a visible one", () => {
      const { opts, el } = mountWarped(
        [
          ["U", "e1", 2, { startSec: 1 }],
          ["R", "e2", 10, { startSec: 0, warp: warpOf({ reverse: true }) }],
        ],
        { stack: { crossfade: false }, seekMs: 40 },
      );
      const r = el("R");
      act(() => editor().setPlayhead(1.5));
      act(() => editor().setPlaying(true));
      let now = 0;
      flushFrame(now);
      r.writes = 0;
      for (let k = 0; k < 60; k++) {
        flushFrame((now += 16));
        expect(r.style.opacity).toBe("0");
      }
      expect(r.writes).toBeGreaterThanOrEqual(10);
      expect(r.writes).toBeLessThanOrEqual(16);
      // Shown once the seek it has in flight as the higher row ends has landed (40 ms), at the frame it landed on
      let past: number | null = null;
      for (let k = 0; k < 2000 && r.style.opacity !== "1"; k++) {
        flushFrame((now += 16));
        if (livePlayhead() > 3) past ??= livePlayhead();
      }
      expect(livePlayhead() - past!).toBeLessThan(0.04 + 0.016);
      expect(Math.abs(r.currentTime - targetOf(opts, "R", livePlayhead()))).toBeLessThan(0.1);
    });

    it.each([
      ["a reversed clip", warpOf({ reverse: true })],
      ["a reversed 0.5× clip", warpOf({ reverse: true, speed: 0.5 })],
      ["an ease-in", warpOf({ curve: preset("easeInQuad") })],
    ])("cuts into %s live hidden under the clip before it (Stacked, no crossfade) on time", (_name, warp) => {
      const { el } = mountWarped(
        [
          ["c1", "e1", 5],
          ["c2", "e2", 5, { warp }],
        ],
        { stack: { crossfade: false }, seekMs: 30 },
      );
      const b = el("c2");
      act(() => editor().setPlayhead(3.5));
      act(() => editor().setPlaying(true));
      let now = 0;
      flushFrame(now);
      // Live at opacity 0 from 4, seeked all the while; c1 ends at 5
      for (let k = 0; k < 400 && b.style.opacity !== "1"; k++) flushFrame((now += 16));
      expect(livePlayhead()).toBeGreaterThanOrEqual(5);
      expect(livePlayhead()).toBeLessThan(5 + 0.016 + 1e-9);
    });
  });
});
