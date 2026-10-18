import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { audioSelectionOf, useStitchEditorStore } from "@/store/stitchEditorStore";
import { createAudioClip, MUSIC_CLIP_ID, type AudioSourceKey } from "@/lib/stitch/audioClips";
import type { StitchDraft } from "@/lib/stitch/draft";
import { DEFAULT_SEQUENCE_LAYOUT } from "@/lib/stitch/stack";
import { createClip, type SourceKey } from "@/lib/stitch/timeline";
import type { StitchAudioClip } from "@/types";
import { AudioClipRail } from "../AudioClipRail";
import type { AudioClipView } from "../useStitchEditorMedia";

vi.mock("@/components/Toast", () => ({ useToast: { getState: () => ({ show: vi.fn() }) } }));

// The rail for selected audio clips, against the real editor store. The views stand in for useStitchEditorMedia's.

const TONE = "atone00000001";
const editor = () => useStitchEditorStore.getState();
const tone = (id: string, init: Partial<StitchAudioClip> = {}) => createAudioClip({ kind: "asset", assetId: TONE }, { id, ...init });

function view(clip: StitchAudioClip, init: Partial<AudioClipView> = {}): AudioClipView {
  const music = clip.source.kind === "music";
  return {
    clipId: clip.id,
    key: (music ? "music" : `asset:${TONE}`) as AudioSourceKey,
    source: clip.source,
    src: music ? "blob:m" : `/api/assets/${TONE}/file`,
    mediaKey: null,
    fileName: music ? "score.mp3" : "tone1320.m4a",
    sourceLabel: music ? "Audio input" : "Library",
    railSubtitle: music ? "Audio input · 20.00 s" : "Library · Kling 3 · 3.00 s",
    duration: music ? 20 : 3,
    recordDuration: music ? null : 3,
    status: "ready",
    missing: false,
    ...init,
  };
}

function open(audioClips: StitchAudioClip[], decoded = true) {
  // A 10 s video under the audio, so the clips are heard
  const draft: StitchDraft = {
    timeline: [createClip({ kind: "edge", edgeId: "e1" }, { id: "c1" })],
    audioClips,
    legacyAudio: { curve: [], muted: false },
    loopCount: 1,
    sequenceLayout: DEFAULT_SEQUENCE_LAYOUT,
  };
  act(() => {
    editor().open({ nodeId: "stitch", draft, canvasGeneration: 1 });
    editor().setDurations(new Map<SourceKey, number>([["edge:e1", 10]]));
    if (decoded) editor().setAudioDurations(new Map<AudioSourceKey, number>([["music", 20], [`asset:${TONE}`, 3]]));
  });
}

const clipsNow = () => editor().draft!.audioClips;
function renderRail(ids: string[], init: Partial<AudioClipView> = {}) {
  const clips = clipsNow().filter((c) => ids.includes(c.id));
  const views = new Map(clipsNow().map((c) => [c.id, view(c, init)]));
  return render(<AudioClipRail clips={clips} views={views} />);
}

beforeEach(() => {
  act(() => editor().close());
});
afterEach(() => {
  act(() => editor().close());
});

describe("AudioClipRail", () => {
  it("shows one clip's name, source and row, its Start and trim wells, its sound, the curve's buttons and its actions", () => {
    open([createAudioClip({ kind: "music" }, { id: MUSIC_CLIP_ID }), tone("t", { row: 1, startSec: 2, inSec: 0.5 })]);
    act(() => editor().select(audioSelectionOf({ clipId: "t" })));
    renderRail(["t"]);
    expect(screen.getByText("tone1320.m4a")).toBeInTheDocument();
    expect(screen.getByText("Library · Kling 3 · 3.00 s")).toBeInTheDocument();
    expect(screen.getByText("Audio 2")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Start on the timeline" })).toHaveValue("0:02.00");
    expect(screen.getByRole("textbox", { name: "In" })).toHaveValue("0:00.50");
    expect(screen.getByRole("textbox", { name: "Out" })).toHaveValue("0:03.00");
    expect(screen.getByText("2.50 s")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Clip sound" })).toHaveAttribute("aria-checked", "true");
    for (const name of ["Fade in", "Fade out", "Split at playhead", "Reset trim", "Remove clip"]) {
      expect(screen.getByRole("button", { name: new RegExp(name) })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Flat" })).toBeDisabled();
    // The playhead (0:00) is not inside the clip
    expect(screen.getByRole("button", { name: /Split at playhead/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Reset trim/ })).toBeEnabled();
  });

  it("acts on the clip: Start, mute, Fade in and Remove", () => {
    open([tone("t", { startSec: 2 })]);
    act(() => editor().select(audioSelectionOf({ clipId: "t" })));
    const { rerender } = renderRail(["t"]);
    const again = () => {
      const views = new Map(clipsNow().map((c) => [c.id, view(c)]));
      rerender(<AudioClipRail clips={clipsNow().filter((c) => c.id === "t")} views={views} />);
    };
    const start = screen.getByRole("textbox", { name: "Start on the timeline" });
    fireEvent.focus(start);
    fireEvent.change(start, { target: { value: "0:04.00" } });
    fireEvent.keyDown(start, { key: "Enter" });
    expect(clipsNow()[0].startSec).toBe(4);
    again();
    // In moves the start with it (the sound stays put); Out keeps it
    const commit = (name: string, value: string) => {
      const well = screen.getByRole("textbox", { name });
      fireEvent.focus(well);
      fireEvent.change(well, { target: { value } });
      fireEvent.keyDown(well, { key: "Enter" });
      again();
    };
    commit("In", "0:00.50");
    expect(clipsNow()[0]).toMatchObject({ inSec: 0.5, startSec: 4.5, outSec: null });
    commit("Out", "0:02.00");
    expect(clipsNow()[0]).toMatchObject({ inSec: 0.5, startSec: 4.5, outSec: 2 });
    // Inside the clip (4.5–6), Split is on
    act(() => editor().setPlayhead(5.5));
    again();
    expect(screen.getByRole("button", { name: /Split at playhead/ })).toBeEnabled();
    fireEvent.click(screen.getByRole("switch", { name: "Clip sound" }));
    expect(clipsNow()[0].muted).toBe(true);
    again();
    expect(screen.getByRole("button", { name: "Fade in" })).toBeDisabled();
    fireEvent.click(screen.getByRole("switch", { name: "Clip sound" }));
    again();
    fireEvent.click(screen.getByRole("button", { name: "Fade in" }));
    // A ramp from its In (0.5), in its source seconds, over half the 1.5 s clip
    expect(clipsNow()[0].curve).toEqual([
      { t: 0.5, gain: 0 },
      { t: 1.25, gain: 1 },
    ]);
    fireEvent.click(screen.getByRole("button", { name: /Remove clip/ }));
    expect(clipsNow()).toHaveLength(0);
  });

  it("keeps the trim wells and Fade out off until the file's length is read", () => {
    open([tone("t", { startSec: 2 })], false);
    act(() => editor().select(audioSelectionOf({ clipId: "t" })));
    renderRail(["t"], { duration: null, status: "loading" });
    expect(screen.getByRole("textbox", { name: "In" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Out" })).toBeDisabled();
    expect(screen.getByText("–")).toBeInTheDocument();
    const fadeOut = screen.getByRole("button", { name: "Fade out" });
    expect(fadeOut).toBeDisabled();
    expect(fadeOut).toHaveAttribute("title", "Reading the audio's length…");
    expect(screen.getByRole("button", { name: "Fade in" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Reset trim/ })).toBeDisabled();
  });

  it("shows several clips as a count with what applies to all of them", () => {
    open([tone("t", { startSec: 2 }), tone("u", { row: 1, startSec: 4, muted: true })]);
    act(() => editor().select(audioSelectionOf({ clipId: "t", clipIds: ["t", "u"] })));
    renderRail(["t", "u"]);
    expect(screen.getByText("2 audio clips")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Start on the timeline" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Mute all/ }));
    expect(clipsNow().every((c) => c.muted)).toBe(true);
    expect(screen.getByRole("button", { name: /Split at playhead/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Remove 2 clips/ }));
    expect(clipsNow()).toHaveLength(0);
  });
});
