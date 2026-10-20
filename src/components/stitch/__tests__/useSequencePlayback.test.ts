import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { gainAt } from "@/lib/stitch/curve";
import { clipSpans, createClip, layoutSpans, spansEnd, type SourceKey } from "@/lib/stitch/timeline";
import { useSequencePlayback, type AudioPlaybackClip, type SequencePlaybackOptions } from "../useSequencePlayback";

// The preview engine against stand-in media elements and a hand-driven frame loop. A playing stand-in advances with
// the frames' timestamps, as a real element runs on its own; a seek can take time (seekMs) before it lands.

interface FakeMedia {
  currentTime: number;
  paused: boolean;
  ended: boolean;
  seeking: boolean;
  muted: boolean;
  volume: number;
  playbackRate: number;
  readyState: number;
  duration: number;
  videoWidth: number;
  videoHeight: number;
  style: { opacity: string };
  /** currentTime writes. */
  writes: number;
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  /** Moves a playing element on by `ms` of the frames' time, and lands a seek whose time has come. */
  advance(ms: number, now: number): void;
}

/** Every stand-in made since the test began, advanced by flushFrame. */
let made: FakeMedia[] = [];

function fakeMedia({ duration = Number.NaN, seekMs = 0 }: { duration?: number; seekMs?: number } = {}): FakeMedia {
  let time = 0;
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
    muted: false,
    volume: 1,
    playbackRate: 1,
    readyState: 4,
    duration,
    videoWidth: 1280,
    videoHeight: 720,
    style: { opacity: "" },
    writes: 0,
    play: vi.fn(() => {
      media.paused = false;
      return Promise.resolve();
    }),
    pause: vi.fn(() => {
      media.paused = true;
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
      if (media.paused || ms <= 0) return;
      time += (ms / 1000) * media.playbackRate;
      if (Number.isFinite(media.duration) && time >= media.duration) {
        time = media.duration;
        media.ended = true;
        media.paused = true;
      }
    },
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
    flushFrame(1000);
    expect(editor().playhead).toBe(2);
    flushFrame(1500);
    expect(editor().playhead).toBeCloseTo(2.5, 9);
    // Paused: the clock stops; Play again carries on from there
    act(() => editor().setPlaying(false));
    flushFrame(3000);
    expect(editor().playhead).toBeCloseTo(2.5, 9);
  });

  it("keeps the playhead moving while the clip's element is stalled on a seek", () => {
    const opts = options(undefined, null);
    const { result } = renderHook(() => useSequencePlayback(opts));
    const video = fakeMedia({ seekMs: 400 });
    act(() => result.current.registerVideo("c1", asVideo(video)));
    act(() => editor().setPlayhead(3));
    act(() => editor().setPlaying(true));
    // Playing from 3 needs a seek that takes 400 ms: the clock does not wait for it
    expect(video.seeking).toBe(true);
    flushFrame(0);
    flushFrame(200);
    expect(video.seeking).toBe(true);
    expect(editor().playhead).toBeCloseTo(3.2, 9);
    // Nor is the element asked again while its seek is in flight
    expect(video.writes).toBe(1);
    flushFrame(500);
    expect(editor().playhead).toBeCloseTo(3.5, 9);
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
    expect(editor().playhead).toBe(10);
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
    expect(music.play).toHaveBeenCalledTimes(1);

    // Play on past the music's 3 s: it stops
    flushFrame(0);
    flushFrame(5000);
    expect(editor().playhead).toBe(5);
    expect(music.paused).toBe(true);

    // Go to start while playing: the music comes back from there
    act(() => editor().setPlayhead(0));
    flushFrame(5100);
    expect(music.play).toHaveBeenCalledTimes(2);
    expect(music.paused).toBe(false);
    expect(music.currentTime).toBe(0);
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

  it("drives the music read from a legacy node as the single music element did: its time and its curve's gain", () => {
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
    expect(music.play).toHaveBeenCalledTimes(1);
    expect(music.currentTime).toBe(0);
    flushFrame(0);
    for (const t of [1, 2, 3.5]) {
      flushFrame(t * 1000);
      // In step with the clock, and the gain at the playhead on the curve's own clock: sequence seconds for an
      // untouched music clip
      expect(music.currentTime).toBeCloseTo(t, 6);
      expect(music.volume).toBeCloseTo(gainAt(curve, t), 6);
    }
    // Drifted past 0.25 s: sought back to the clock
    music.currentTime = 4;
    flushFrame(3500);
    expect(music.currentTime).toBeCloseTo(3.5, 6);
    expect(music.play).toHaveBeenCalledTimes(1);
  });

  it("plays a clip that starts at 2 s only from 2 s, from its In, at its curve's gain there", () => {
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
    expect(tone.play).not.toHaveBeenCalled();
    flushFrame(0);
    flushFrame(1500);
    expect(tone.paused).toBe(true);
    expect(tone.play).not.toHaveBeenCalled();
    // Inside its span: its In plus the time since its start
    flushFrame(2500);
    expect(tone.play).toHaveBeenCalledTimes(1);
    expect(tone.currentTime).toBeCloseTo(1.5, 6);
    expect(tone.volume).toBeCloseTo(gainAt(curve, 1.5), 6);
  });

  it("pauses a clip past its Out and a muted clip stays muted", () => {
    const opts = options("blob:a", null, [audioClip({ id: "aclip_1", src: "tone.m4a", startSec: 0, inSec: 0, outSec: 2, muted: true })]);
    const { result } = renderHook(() => useSequencePlayback(opts));
    const video = fakeMedia();
    const tone = fakeMedia({ duration: 10 });
    act(() => {
      result.current.registerVideo("c1", asVideo(video));
      result.current.registerAudio("aclip_1", asAudio(tone));
    });
    act(() => editor().setPlaying(true));
    expect(tone.muted).toBe(true);
    expect(tone.play).toHaveBeenCalledTimes(1);
    flushFrame(0);
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
    expect(editor().playhead).toBe(1);

    // React swaps the clip's element: the old one is paused as it leaves, the new one picks up where the clock is
    const second = fakeMedia();
    act(() => {
      result.current.registerVideo("c1", null);
      result.current.registerVideo("c1", asVideo(second));
    });
    expect(first.paused).toBe(true);
    flushFrame(1000);
    expect(second.play).toHaveBeenCalledTimes(1);
    expect(second.currentTime).toBe(1);
    expect(editor().playing).toBe(true);

    // And it plays on with the clock
    flushFrame(2000);
    expect(editor().playhead).toBe(2);
    expect(second.currentTime).toBe(2);
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
    flushFrame(30);
    await act(async () => {
      await Promise.resolve();
    });
    expect(editor().playhead).toBeCloseTo(5.01, 9);
    expect(b.play).toHaveBeenCalledTimes(1);
    expect(editor().playing).toBe(true);
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

    it("starts the later clip hidden just before an overlap, without pausing the earlier one or seeking", () => {
      const { a, b } = mount(stackedOptions());
      act(() => editor().setPlayhead(3));
      act(() => editor().setPlaying(true));
      expect(a.play).toHaveBeenCalledTimes(1);
      flushFrame(0);
      // The later clip is next: it waits at its In (already there, so never seeked)
      flushFrame(600);
      expect(b.paused).toBe(true);
      // Its start latency before its start (learned from the earlier clip's start: these stand-ins move at once): it
      // plays, hidden and muted
      flushFrame(970);
      expect(b.play).toHaveBeenCalledTimes(1);
      expect(b.style.opacity).toBe("0");
      expect(b.muted).toBe(true);
      // Its start: shown and heard, moving and in step
      flushFrame(1050);
      expect(Number(b.style.opacity)).toBeCloseTo(0.05, 9);
      expect(b.muted).toBe(false);
      expect(b.currentTime).toBeCloseTo(0.08, 9);
      expect(b.play).toHaveBeenCalledTimes(1);
      expect(b.writes).toBe(0);
      expect(a.pause).not.toHaveBeenCalled();
      expect(editor().playhead).toBeCloseTo(4.05, 9);
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
      expect(editor().playhead).toBeCloseTo(5, 9);
      expect(a.paused).toBe(true);
      expect(a.style.opacity).toBe("0");
      flushFrame(2100);
      expect(editor().playhead).toBeCloseTo(6, 9);
      expect(b.currentTime).toBeCloseTo(2, 9);
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
      act(() => editor().setPlayhead(2.2));
      act(() => editor().setPlaying(true));
      flushFrame(0);
      // Waiting at its pre-roll point, 0.15 s before its In
      expect(b.currentTime).toBeCloseTo(2.35, 9);
      expect(b.writes).toBe(1);
      expect(b.paused).toBe(true);
      // Started a pre-roll and a start latency before the cut, from there
      flushFrame(110);
      expect(b.play).toHaveBeenCalledTimes(1);
      expect(b.writes).toBe(1);
      expect(b.style.opacity).toBe("0");
      // The cut: shown at its In, the earlier piece hidden and silent at once and paused a frame later
      flushFrame(300);
      expect(editor().playhead).toBeCloseTo(2.5, 9);
      expect(b.style.opacity).toBe("1");
      expect(b.currentTime).toBeCloseTo(2.54, 9);
      expect(a.style.opacity).toBe("0");
      expect(a.muted).toBe(true);
      expect(a.paused).toBe(false);
      flushFrame(316);
      expect(a.paused).toBe(true);
      expect(b.writes).toBe(1);
      expect(b.play).toHaveBeenCalledTimes(1);
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
      expect(editor().playhead).toBe(2);
      // The load pauses the element and sends it back to 0, keeping it
      const onLoaded = a.addEventListener.mock.calls.find(([type]) => type === "loadedmetadata")![1] as () => void;
      a.paused = true;
      a.currentTime = 0;
      onLoaded();
      flushFrame(1000);
      expect(a.play).toHaveBeenCalledTimes(2);
      expect(a.currentTime).toBe(2);
      expect(editor().playing).toBe(true);
      flushFrame(1500);
      expect(editor().playhead).toBeCloseTo(2.5, 9);
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
        flushFrame(1000);
        // A reaches its Out: nothing plays until B, and the clock goes on
        flushFrame(1500);
        expect(editor().playhead).toBe(2);
        expect(editor().playing).toBe(true);
        expect(opacities(media)).toEqual([0, 0]);
        flushFrame(3000);
        expect(editor().playhead).toBeCloseTo(3.5, 9);
        expect(el("B").play).not.toHaveBeenCalled();
        flushFrame(3600);
        expect(editor().playing).toBe(true);
        expect(el("B").play).toHaveBeenCalledTimes(1);
        expect(el("B").currentTime).toBeCloseTo(0.1, 9);
        flushFrame(4500);
        expect(editor().playhead).toBeCloseTo(5, 9);
        expect(el("B").currentTime).toBeCloseTo(1, 9);
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
        expect(editor().playhead).toBeCloseTo(5.01, 9);
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
        expect(editor().playhead).toBeCloseTo(3.5, 9);
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
        expect(editor().playhead).toBe(3.5);
        flushFrame(3500);
        expect(el("B").paused).toBe(true);
        expect(el("A").pause).not.toHaveBeenCalled();
        expect(editor().playhead).toBe(5.5);
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
});
