import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { clipSpans, createClip, type SourceKey } from "@/lib/stitch/timeline";
import { useSequencePlayback, type SequencePlaybackOptions } from "../useSequencePlayback";

// The preview engine against stand-in media elements and a hand-driven frame loop.

interface FakeMedia {
  currentTime: number;
  paused: boolean;
  ended: boolean;
  seeking: boolean;
  muted: boolean;
  volume: number;
  duration: number;
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
}

function fakeMedia(duration = Number.NaN): FakeMedia {
  const media: FakeMedia = {
    currentTime: 0,
    paused: true,
    ended: false,
    seeking: false,
    muted: false,
    volume: 1,
    duration,
    play: vi.fn(() => {
      media.paused = false;
      return Promise.resolve();
    }),
    pause: vi.fn(() => {
      media.paused = true;
    }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
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
  );
  return {
    spans,
    total: 10,
    srcFor: (clipId) => (clipId === "c1" ? "blob:a" : "blob:b"),
    music: { src: null, curve: [], muted: false },
    soundOn: true,
  };
}

const asVideo = (m: FakeMedia) => m as unknown as HTMLVideoElement;
const asAudio = (m: FakeMedia) => m as unknown as HTMLAudioElement;

let frames: FrameRequestCallback[] = [];
const flushFrame = () =>
  act(() => {
    const queue = frames;
    frames = [];
    for (const cb of queue) cb(0);
  });

const editor = () => useStitchEditorStore.getState();

/** One 10 s clip of source "a" (served at `url`), with music from "music.mp3". */
function options(url = "blob:a", music: string | null = "music.mp3"): SequencePlaybackOptions {
  const clip = createClip({ kind: "edge", edgeId: "e1" }, { id: "c1" });
  const spans = clipSpans([clip], new Map<SourceKey, number>([["edge:e1", 10]]));
  return {
    spans,
    total: 10,
    srcFor: () => url,
    music: { src: music, curve: [], muted: false },
    soundOn: true,
  };
}

beforeEach(() => {
  frames = [];
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

  it("starts the music again after a jump back from past its end", () => {
    const opts = options();
    const { result } = renderHook(() => useSequencePlayback(opts));
    const video = fakeMedia();
    const music = fakeMedia(3);
    act(() => {
      result.current.registerVideo("blob:a", asVideo(video));
      result.current.registerAudio(asAudio(music));
    });
    act(() => editor().setPlaying(true));
    expect(music.play).toHaveBeenCalledTimes(1);

    // Play on past the music's 3 s: it stops
    video.currentTime = 5;
    flushFrame();
    expect(editor().playhead).toBe(5);
    expect(music.paused).toBe(true);

    // Go to start while playing: the music comes back from there
    act(() => editor().setPlayhead(0));
    flushFrame();
    expect(music.play).toHaveBeenCalledTimes(2);
    expect(music.paused).toBe(false);
    expect(music.currentTime).toBe(0);
  });

  it("asks a music element whose play() was refused only once, not every frame", () => {
    const opts = options();
    const { result } = renderHook(() => useSequencePlayback(opts));
    const video = fakeMedia();
    const music = fakeMedia(30);
    music.play.mockImplementation(() => Promise.reject(new Error("NotAllowedError")));
    act(() => {
      result.current.registerVideo("blob:a", asVideo(video));
      result.current.registerAudio(asAudio(music));
    });
    act(() => editor().setPlaying(true));
    video.currentTime = 1;
    flushFrame();
    video.currentTime = 2;
    flushFrame();
    expect(music.play).toHaveBeenCalledTimes(1);
  });

  it("hands playback to a <video> remounted under the playhead", () => {
    let opts = options("data:video/mp4;base64,AAAA");
    const { result, rerender } = renderHook(() => useSequencePlayback(opts));
    const first = fakeMedia();
    act(() => result.current.registerVideo("data:video/mp4;base64,AAAA", asVideo(first)));
    act(() => editor().setPlaying(true));
    first.currentTime = 1;
    flushFrame();
    expect(editor().playhead).toBe(1);

    // The object URL arrives: React swaps the element (the old one is paused as it leaves the page)
    const second = fakeMedia();
    opts = options("blob:a");
    act(() => {
      result.current.registerVideo("data:video/mp4;base64,AAAA", null);
      result.current.registerVideo("blob:a", asVideo(second));
      first.paused = true;
    });
    rerender();
    flushFrame();
    expect(result.current.activeSrc).toBe("blob:a");
    expect(second.play).toHaveBeenCalledTimes(1);
    expect(second.currentTime).toBe(1);
    expect(editor().playing).toBe(true);

    // And the loop follows the new element
    second.currentTime = 2;
    flushFrame();
    expect(editor().playhead).toBe(2);
  });

  it("keeps playing when a move to another source aborts the previous element's pending play()", async () => {
    const opts = twoSourceOptions();
    const { result } = renderHook(() => useSequencePlayback(opts));
    const a = pendingPlayMedia();
    const b = pendingPlayMedia();
    act(() => {
      result.current.registerVideo("blob:a", asVideo(a));
      result.current.registerVideo("blob:b", asVideo(b));
    });
    act(() => editor().setPlaying(true));
    // Moved from outside into the second source's clip: "a" is paused before its play() resolved
    act(() => editor().setPlayhead(6));
    flushFrame();
    await act(async () => {
      await Promise.resolve();
    });
    expect(a.pause).toHaveBeenCalled();
    expect(b.play).toHaveBeenCalledTimes(1);
    expect(editor().playing).toBe(true);
  });

  it("keeps playing when play starts in a clip's last frame and advances before play() resolved", async () => {
    const opts = twoSourceOptions();
    const { result } = renderHook(() => useSequencePlayback(opts));
    const a = pendingPlayMedia();
    const b = pendingPlayMedia();
    act(() => {
      result.current.registerVideo("blob:a", asVideo(a));
      result.current.registerVideo("blob:b", asVideo(b));
    });
    act(() => editor().setPlayhead(4.98));
    act(() => editor().setPlaying(true));
    flushFrame();
    await act(async () => {
      await Promise.resolve();
    });
    expect(editor().playhead).toBe(5);
    expect(b.play).toHaveBeenCalledTimes(1);
    expect(editor().playing).toBe(true);
  });

  it("stops when the element playing now refuses to play", async () => {
    const opts = options(undefined, null);
    const { result } = renderHook(() => useSequencePlayback(opts));
    const video = fakeMedia();
    video.play.mockImplementation(() => Promise.reject(new DOMException("No autoplay", "NotAllowedError")));
    act(() => result.current.registerVideo("blob:a", asVideo(video)));
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
    act(() => result.current.registerVideo("blob:a", asVideo(video)));
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
});
