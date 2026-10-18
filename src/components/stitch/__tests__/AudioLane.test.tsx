import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { AssetView } from "@/lib/assets/types";

const api = vi.hoisted(() => ({ fetchAsset: vi.fn() }));
vi.mock("@/lib/assets/client/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/assets/client/api")>()),
  fetchAsset: api.fetchAsset,
}));
vi.mock("@/components/Toast", () => ({ useToast: { getState: () => ({ show: vi.fn() }) } }));
vi.mock("@/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    startSession: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn().mockResolvedValue(undefined),
    getCurrentSession: vi.fn().mockReturnValue(null),
  },
}));
const storage: Record<string, string> = {};
vi.stubGlobal("localStorage", {
  getItem: vi.fn((key: string) => storage[key] ?? null),
  setItem: vi.fn((key: string, value: string) => {
    storage[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete storage[key];
  }),
  clear: vi.fn(),
});

import { useWorkflowStore } from "@/store/workflowStore";
import { audioSelectionOf, useStitchEditorStore } from "@/store/stitchEditorStore";
import { assetFileUrl } from "@/lib/assets/client/api";
import { createAudioClip, MUSIC_CLIP_ID } from "@/lib/stitch/audioClips";
import { __resetAssetInfoForTests, primeAssetInfo } from "@/lib/stitch/assetInfo";
import { fadeIn, fadeOut } from "@/lib/stitch/curve";
import { __resetMediaInfoForTests, __setMediaExtractorForTests, __setMediaInfoForTests, mediaKeyOf } from "@/lib/stitch/mediaInfo";
import { __resetWaveformForTests, __setWaveformDecoderForTests, __setWaveformForTests } from "@/lib/stitch/waveformCache";
import { StitchEditorModal } from "../StitchEditorModal";
import { openStitchEditor } from "../openStitchEditor";
import type { StitchAudioClip, VideoStitchNodeData, VolumePoint, WorkflowEdge, WorkflowNode } from "@/types";

// The audio section inside the real editor, against the real stores. jsdom
// lays nothing out (every rect is at 0), so lane x is the pointer's clientX
// and a block's y is its clientY. At 64 px/s a time t is at x = 16 + 64·t;
// an expanded block has 0 dB at y 16 and −∞ at y 106. The sequence is 9 s
// (A 5 s, B 4 s); the music is 20 s long.

const PPS = 64;
const ORIGIN = 16;
const x = (t: number) => ORIGIN + t * PPS;
/** y of a gain in the expanded block (√ level). */
const y = (gain: number) => 16 + (1 - Math.sqrt(gain)) * 90;
const TONE = "atone00000001";
const GONE = "agone00000001";
const BAD = "abadfile00001";
const wf = () => useWorkflowStore.getState();
const editor = () => useStitchEditorStore.getState();
const node = (id: string, type: string, data: Record<string, unknown>): WorkflowNode =>
  ({ id, type, data, position: { x: 0, y: 0 } }) as WorkflowNode;
const edge = (id: string, source: string, sourceHandle: string, targetHandle: string): WorkflowEdge => ({
  id,
  source,
  target: "stitch",
  sourceHandle,
  targetHandle,
});
const tone = (id: string, init: Partial<StitchAudioClip> = {}) => createAudioClip({ kind: "asset", assetId: TONE }, { id, ...init });

function seed({
  clips = true,
  music = true,
  stitch = {},
}: { clips?: boolean; music?: boolean; stitch?: Partial<VideoStitchNodeData> } = {}) {
  const nodes = [
    node("gen-a", "generateVideo", { outputVideo: "blob:a" }),
    node("gen-b", "generateVideo", { outputVideo: "blob:b" }),
    node("music", "audioInput", { audioFile: "blob:m", filename: "score.mp3", duration: 20, format: "audio/mpeg" }),
    node("stitch", "videoStitch", { clips: [], clipOrder: [], outputVideo: null, loopCount: 1, status: "idle", ...stitch }),
  ];
  const edges = [
    ...(clips ? [edge("eA", "gen-a", "video", "video-0"), edge("eB", "gen-b", "video", "video-1")] : []),
    ...(music ? [edge("eM", "music", "audio", "audio")] : []),
  ];
  useWorkflowStore.setState({ nodes, edges, openModalCount: 0, isModalOpen: false });
  __setMediaInfoForTests(mediaKeyOf("blob:a"), { duration: 5, width: 1920, height: 1080, fps: 24 });
  __setMediaInfoForTests(mediaKeyOf("blob:b"), { duration: 4, width: 1920, height: 1080, fps: 24 });
  __setWaveformForTests(mediaKeyOf("blob:m"), { duration: 20, peaks: new Float32Array(64).fill(0.5) });
  __setWaveformForTests(mediaKeyOf(assetFileUrl(TONE)), { duration: 3, peaks: new Float32Array(64).fill(0.5) });
  __setWaveformForTests(mediaKeyOf(assetFileUrl(BAD)), { duration: null, peaks: null, status: "error" });
  const record = (id: string, filename: string, durationSec: number) =>
    ({ id, kind: "audio", filename, durationSec }) as unknown as AssetView;
  primeAssetInfo([record(TONE, "tone1320.m4a", 3), record(BAD, "broken.m4a", 2)]);
}

function openEditor(curve?: VolumePoint[]) {
  render(<StitchEditorModal />);
  act(() => {
    openStitchEditor("stitch");
    editor().setZoom(PPS);
  });
  // A curve on the music the editor opened with, so it is not an undo step
  if (curve) {
    const withCurve = (clips: StitchAudioClip[]) => clips.map((c) => (c.source.kind === "music" ? { ...c, curve } : c));
    act(() =>
      useStitchEditorStore.setState((s) => ({
        draft: { ...s.draft!, audioClips: withCurve(s.draft!.audioClips) },
        initial: { ...s.initial!, audioClips: withCurve(s.initial!.audioClips) },
      })),
    );
  }
}

const lane = () => screen.getByRole("listbox", { name: "Audio clips" });
const box = (name: string) => within(lane()).getByRole("option", { name: new RegExp(`^${name.replace(".", "\\.")}`) });
const musicBox = () => box("score.mp3");
const rows = () => screen.getAllByTestId("stitch-audio-row");
const rail = () => screen.getByRole("complementary", { name: "Audio clip" });
const timelineEl = () => screen.getByTestId("stitch-timeline");
const points = () => screen.queryAllByTestId("stitch-curve-point");
const music = () => editor().draft!.audioClips.find((c) => c.source.kind === "music")!;
const curve = () => music().curve;
const press = (key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });
const pointer = (type: "pointermove" | "pointerup", clientX: number, clientY: number, init: MouseEventInit = {}) =>
  act(() => {
    window.dispatchEvent(new MouseEvent(type, { clientX, clientY, bubbles: true, ...init }));
  });
const down = (el: HTMLElement, clientX: number, clientY: number, init: Record<string, unknown> = {}) =>
  fireEvent.pointerDown(el, { button: 0, clientX, clientY, pointerId: 1, ...init });
/** A press and release on a box with no travel: a click. */
const click = (el: HTMLElement, clientX = x(4), clientY = 30) => {
  down(el, clientX, clientY);
  pointer("pointerup", clientX, clientY);
};
const toggle = (row = 0) =>
  fireEvent.click(
    screen.getAllByRole("button", { name: /^(Show|Hide) volume curve$/ })[row] as HTMLElement,
  );
/** The music selected on an expanded row: its curve takes presses. */
const editMusic = () => {
  click(musicBox());
  toggle(0);
};
/** Two presses and the dblclick a browser sends after them. */
const doubleClickAt = (clientX: number, clientY: number) => {
  down(musicBox(), clientX, clientY);
  pointer("pointerup", clientX, clientY);
  down(musicBox(), clientX, clientY);
  pointer("pointerup", clientX, clientY);
  fireEvent.doubleClick(musicBox(), { clientX, clientY });
};
const content = () => screen.getByTestId("stitch-lanes").firstElementChild as HTMLElement;
const rect = (left: number, top: number): DOMRect =>
  ({ left, top, right: left, bottom: top, width: 0, height: 0, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
/** Every audio box's and header's place, as drawn. */
const placesOf = () =>
  [...screen.getAllByRole("option").filter((el) => el.dataset.audioClipId), ...document.querySelectorAll<HTMLElement>("[data-audio-row-header]")].map(
    (el) => `${el.dataset.audioClipId ?? el.dataset.audioRowHeader}:${el.style.left}:${el.style.top}:${el.style.width}:${el.style.height}`,
  );

beforeEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  wf().clearWorkflow();
  editor().close();
  __resetMediaInfoForTests();
  __resetWaveformForTests();
  __resetAssetInfoForTests();
  api.fetchAsset.mockImplementation(async () => null);
  __setMediaExtractorForTests({ probe: () => new Promise(() => {}), open: () => new Promise(() => {}) });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  // jsdom has no 2D canvas; the waveform draws nothing, but its element is there
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
});

afterEach(() => {
  act(() => editor().close());
  __setMediaExtractorForTests(null);
  __resetMediaInfoForTests();
  __resetWaveformForTests();
  vi.restoreAllMocks();
});

describe("Audio section", () => {
  it("draws the music as a clip on Audio 1: its waveform, name and curve, hatched past the last frame", () => {
    seed();
    openEditor([
      { t: 0, gain: 0 },
      { t: 1, gain: 1 },
    ]);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].style.height).toBe("64px");
    expect(musicBox().style.left).toBe(`${x(0)}px`);
    expect(musicBox().style.width).toBe(`${20 * PPS}px`);
    expect(musicBox()).toHaveAccessibleName("score.mp3, Audio 1, starts 0:00.00");
    expect(within(musicBox()).getByText("score.mp3")).toBeInTheDocument();
    expect(within(musicBox()).getByText("Audio input")).toBeInTheDocument();
    expect(within(musicBox()).getByTestId("stitch-waveform")).toBeInTheDocument();
    expect(within(musicBox()).getByTestId("stitch-curve")).toBeInTheDocument();
    // The point at the clip's In gets no dot (the boards draw none at the ends); the other is r 4
    expect(points()).toHaveLength(1);
    expect(points()[0]).toHaveAttribute("r", "4");
    expect(screen.queryByTestId("stitch-db-guides")).toBeNull();
    // The 11 s past the 9 s sequence are not heard
    const hatch = within(musicBox()).getByTestId("stitch-audio-after-end");
    expect(hatch.style.left).toBe(`${9 * PPS}px`);
    expect(hatch).toHaveAttribute("title", "After the last frame: not heard");
    // The label bar is drawn over the curve, as on the boards
    const label = within(musicBox()).getByText("score.mp3").parentElement!;
    expect(screen.getByTestId("stitch-curve").compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("grows a row only by its header's toggle, never by a selection", () => {
    seed();
    openEditor();
    // Two clips (Stacked would want 2 rows): 24 + 113 + one audio row and the strip
    expect(timelineEl().style.height).toBe("225px");
    click(musicBox());
    expect(editor().selection).toMatchObject({ kind: "audio", clipId: MUSIC_CLIP_ID, point: null });
    expect(rows()[0].style.height).toBe("64px");
    expect(timelineEl().style.height).toBe("225px");
    expect(rail()).toBeInTheDocument();
    const show = screen.getByRole("button", { name: "Show volume curve" });
    expect(show).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(show);
    expect(editor().audioExpandedRow).toBe(0);
    expect(editor().past).toHaveLength(0);
    expect(rows()[0].style.height).toBe("136px");
    expect(musicBox().style.height).toBe("120px");
    expect(timelineEl().style.height).toBe("297px");
    expect(screen.getByTestId("stitch-db-guides")).toBeInTheDocument();
    // The labels stand above the header's controls: −∞ sits at their level, so it is left out
    expect(screen.getAllByTestId("stitch-db-label").map((el) => el.textContent)).toEqual(["0 dB", "−12"]);
    // The same button, now the one that hides it
    expect(screen.getByRole("button", { name: "Hide volume curve" })).toBe(show);
    expect(show).toHaveAttribute("aria-expanded", "true");
    // Selecting a video clip leaves the row as it is
    click(screen.getByRole("option", { name: "Clip 1" }), 100, 0);
    expect(rows()[0].style.height).toBe("136px");
    expect(timelineEl().style.height).toBe("297px");
    fireEvent.click(show);
    expect(editor().audioExpandedRow).toBeNull();
    expect(rows()[0].style.height).toBe("64px");
  });

  it("moves no box and no header when a clip on another row is clicked while row 0 is expanded", () => {
    seed({ stitch: { audioClips: [tone("t", { row: 1, startSec: 2 })] } });
    openEditor();
    toggle(0);
    for (let run = 0; run < 5; run++) {
      const before = placesOf();
      click(box("tone1320.m4a"), x(3), 30);
      expect(editor().selection).toMatchObject({ kind: "audio", clipId: "t" });
      expect(placesOf()).toEqual(before);
      click(musicBox());
      expect(placesOf()).toEqual(before);
    }
  });

  it("edits the curve only on the single selected clip of the expanded row", () => {
    seed({ stitch: { audioClips: [tone("t", { row: 1, startSec: 2 })] } });
    openEditor();
    toggle(0);
    // Not selected: a press on its line selects it, and adds nothing
    click(musicBox(), x(3), y(1));
    expect(curve()).toEqual([]);
    expect(editor().selection).toMatchObject({ kind: "audio", clipId: MUSIC_CLIP_ID });
    // Selected with another: still nothing
    click(box("tone1320.m4a"), x(3), 30);
    down(musicBox(), x(4), 30, { shiftKey: true });
    pointer("pointerup", x(4), 30, { shiftKey: true });
    expect(editor().selection).toMatchObject({ kind: "audio", clipIds: [MUSIC_CLIP_ID, "t"] });
    click(musicBox(), x(3), y(1));
    expect(curve()).toEqual([]);
    // The single selection: a press on the line adds a point there
    click(musicBox(), x(3), y(1));
    expect(curve()).toEqual([{ t: 3, gain: 1 }]);
    expect(editor().past).toHaveLength(1);
  });

  it("adds no point on the single selected clip while its row is collapsed", () => {
    seed();
    openEditor();
    click(musicBox());
    for (const clientY of [20, 30, 40]) click(musicBox(), x(3), clientY);
    expect(curve()).toEqual([]);
    expect(editor().past).toHaveLength(0);
    expect(points()).toHaveLength(0);
    expect(editor().selection).toMatchObject({ kind: "audio", clipId: MUSIC_CLIP_ID, point: null });
  });

  it("places a fade in and a fade out from the rail over the part that is heard, and Flat clears the curve", () => {
    seed();
    openEditor();
    click(musicBox());
    fireEvent.click(within(rail()).getByRole("button", { name: "Fade in" }));
    // The untouched music under a 9 s sequence: exactly the sequence's fades
    expect(curve()).toEqual(fadeIn([], 9));
    fireEvent.click(within(rail()).getByRole("button", { name: "Fade out" }));
    expect(curve()).toEqual(fadeOut(fadeIn([], 9), 9));
    expect(editor().past).toHaveLength(2);
    fireEvent.click(within(rail()).getByRole("button", { name: "Flat" }));
    expect(curve()).toEqual([]);
    expect(within(rail()).getByRole("button", { name: "Flat" })).toBeDisabled();
  });

  it("mutes the music with M when no audio clip is selected, and from its row's header", () => {
    seed();
    openEditor([{ t: 2, gain: 0.5 }]);
    press("m");
    expect(music().muted).toBe(true);
    expect(within(musicBox()).getByTestId("stitch-audio-muted")).toHaveTextContent("Muted");
    expect(screen.queryByTestId("stitch-curve")).toBeNull();
    expect(musicBox()).toHaveAccessibleName("score.mp3, Audio 1, starts 0:00.00, muted");
    fireEvent.click(screen.getByRole("button", { name: "Unmute Audio 1" }));
    expect(music().muted).toBe(false);
    expect(editor().past).toHaveLength(2);
    click(musicBox());
    expect(within(rail()).getByRole("switch", { name: "Sound" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(within(rail()).getByRole("switch", { name: "Sound" }));
    expect(music().muted).toBe(true);
    expect(within(rail()).getByRole("button", { name: "Fade in" })).toBeDisabled();
  });

  it("writes the music's curve and mute to the node on Done, with no audioClips key", () => {
    seed();
    openEditor();
    click(musicBox());
    fireEvent.click(within(rail()).getByRole("button", { name: "Fade in" }));
    press("m");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    const data = wf().nodes.find((n) => n.id === "stitch")!.data as VideoStitchNodeData;
    expect(data.audioCurve).toEqual(fadeIn([], 9));
    expect(data.audioMuted).toBe(true);
    expect("audioClips" in data).toBe(false);
  });

  it("says how to add audio when there is none, wide enough for its copy", () => {
    seed({ music: false });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
    openEditor();
    act(() => editor().setZoom(8));
    const placeholder = screen.getByTestId("stitch-audio-placeholder");
    expect(placeholder).toHaveTextContent("Connect audio to the node, or add it from the library");
    expect(placeholder.style.width).toBe("260px");
    expect(screen.queryAllByRole("option").filter((el) => el.dataset.audioClipId)).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /^Mute Audio/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Show volume curve" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add audio" })).toBeEnabled();
  });

  it("can still unmute a legacy node's muted music that was disconnected", () => {
    seed({ music: false, stitch: { audioMuted: true } });
    openEditor();
    expect(editor().draft!.legacyAudio.muted).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Unmute Audio 1" }));
    expect(editor().draft!.legacyAudio.muted).toBe(false);
    expect(screen.queryByRole("button", { name: /mute Audio 1/i })).toBeNull();
  });

  it("draws music that is not connected, a file gone from the library and one that cannot be read, dashed", () => {
    seed({
      music: false,
      stitch: {
        audioClips: [
          createAudioClip({ kind: "music" }, { id: MUSIC_CLIP_ID }),
          createAudioClip({ kind: "asset", assetId: GONE }, { id: "g", row: 1 }),
          createAudioClip({ kind: "asset", assetId: BAD }, { id: "b", row: 2 }),
        ],
      },
    });
    act(() => primeAssetInfo([]));
    openEditor();
    act(() => useStitchEditorStore.getState());
    const notConnected = box("No audio connected");
    expect(notConnected).toHaveClass("border-dashed", "border-handle-audio/30");
    expect(notConnected.style.width).toBe("160px");
    const broken = box("Can't read this audio");
    expect(broken).toHaveClass("border-dashed", "border-red-400/40");
    // A record length draws it; no handles until the file's own length is read
    expect(broken.style.width).toBe(`${2 * PPS}px`);
    expect(broken.querySelector("[data-trim-handle]")).toBeNull();
    // Each is selectable
    click(notConnected, x(1), 30);
    expect(editor().selection).toMatchObject({ kind: "audio", clipId: MUSIC_CLIP_ID });
  });

  it("draws a gone library file as not in the library once its record is missing", async () => {
    seed({ stitch: { audioClips: [createAudioClip({ kind: "asset", assetId: GONE }, { id: "g" })] } });
    openEditor();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const gone = box("Not in the library");
    expect(gone).toHaveClass("border-red-400/40");
  });

  it("draws boxes with no video yet at 64 px/s, all hatched, and they can be selected", () => {
    seed({ clips: false });
    render(<StitchEditorModal />);
    act(() => openStitchEditor("stitch"));
    expect(musicBox().style.left).toBe(`${x(0)}px`);
    expect(musicBox().style.width).toBe(`${20 * 64}px`);
    expect(within(musicBox()).getByTestId("stitch-audio-after-end").style.left).toBe("0px");
    click(musicBox(), x(1), 30);
    expect(editor().selection).toMatchObject({ kind: "audio", clipId: MUSIC_CLIP_ID });
  });

  it("removes a point on a double-click and selects the one before it, so ⌫ removes points, never the clip", () => {
    seed();
    openEditor([
      { t: 0, gain: 1 },
      { t: 2, gain: 0.25 },
      { t: 6, gain: 1 },
    ]);
    editMusic();
    doubleClickAt(x(2), y(0.25));
    expect(curve()).toEqual([
      { t: 0, gain: 1 },
      { t: 6, gain: 1 },
    ]);
    expect(editor().selection).toMatchObject({ kind: "audio", point: 0, onCurve: true });
    expect(editor().past).toHaveLength(1);
    press("Backspace");
    expect(curve()).toEqual([{ t: 6, gain: 1 }]);
    expect(editor().selection).toMatchObject({ kind: "audio", point: 0 });
    press("Backspace");
    expect(curve()).toEqual([]);
    expect(editor().selection).toMatchObject({ kind: "audio", point: null, onCurve: true });
    // With no point left, ⌫ after a curve gesture removes nothing
    press("Backspace");
    expect(editor().draft!.audioClips).toHaveLength(1);
    // A press on the box's body leaves the curve: ⌫ then removes the clip
    down(musicBox(), x(12), 60);
    pointer("pointerup", x(12), 60);
    expect(editor().selection).toMatchObject({ kind: "audio", onCurve: false });
    press("Backspace");
    expect(editor().draft!.audioClips).toHaveLength(0);
  });

  it("adds one point on a double-click on the line, and does not take it away again", () => {
    seed();
    openEditor();
    editMusic();
    doubleClickAt(x(3), y(1));
    expect(curve()).toEqual([{ t: 3, gain: 1 }]);
    expect(editor().past).toHaveLength(1);
  });

  it("drags a point in one undo step with a readout, and leaves it selected; after ⌘Z, ⌫ removes nothing", () => {
    seed();
    openEditor([
      { t: 0, gain: 1 },
      { t: 2, gain: 0.25 },
      { t: 6, gain: 1 },
    ]);
    editMusic();
    down(musicBox(), x(2), y(0.25));
    pointer("pointermove", x(3), y(1));
    // The drag is local: the draft has not moved, the readout follows the point
    expect(curve()[1]).toEqual({ t: 2, gain: 0.25 });
    const readout = screen.getByTestId("stitch-curve-readout");
    expect(readout).toHaveTextContent("0.0 dB");
    expect(readout).toHaveTextContent("0:03.00");
    pointer("pointerup", x(3), y(1));
    expect(curve()).toEqual([
      { t: 0, gain: 1 },
      { t: 3, gain: 1 },
      { t: 6, gain: 1 },
    ]);
    expect(editor().past).toHaveLength(1);
    expect(editor().selection).toMatchObject({ kind: "audio", point: 1 });
    expect(screen.queryByTestId("stitch-curve-readout")).toBeNull();
    press("z", { metaKey: true });
    expect(curve()[1]).toEqual({ t: 2, gain: 0.25 });
    expect(editor().selection).toMatchObject({ kind: "audio", point: null });
    press("Backspace");
    expect(curve()).toHaveLength(3);
  });

  it("adds a point on the line where it is clicked, with an Add point hint on hover", () => {
    seed();
    openEditor();
    editMusic();
    fireEvent.pointerMove(musicBox(), { clientX: x(3), clientY: y(1) + 2 });
    expect(screen.getByTestId("stitch-add-point")).toHaveTextContent("Add point");
    fireEvent.pointerMove(musicBox(), { clientX: x(3), clientY: y(0.25) });
    expect(screen.queryByTestId("stitch-add-point")).toBeNull();
    click(musicBox(), x(1), y(1) + 3);
    expect(curve()).toEqual([{ t: 1, gain: 1 }]);
    expect(editor().past).toHaveLength(1);
    expect(editor().selection).toMatchObject({ kind: "audio", point: 0, onCurve: true });
  });

  it("moves the whole line with ⌥ held, leaving no point selected", () => {
    seed();
    openEditor();
    editMusic();
    down(musicBox(), x(2), 40, { altKey: true });
    pointer("pointermove", x(2), 40 + 45);
    pointer("pointerup", x(2), 40 + 45);
    // An empty curve becomes two points across the clip's window, both at the new level
    expect(curve()).toEqual([
      { t: 0, gain: expect.closeTo(0.25) },
      { t: 20, gain: expect.closeTo(0.25) },
    ]);
    expect(editor().past).toHaveLength(1);
    expect(editor().selection).toMatchObject({ kind: "audio", point: null, onCurve: true });
  });

  it("cancels a point drag on Escape, leaving the curve and the editor as they were", () => {
    seed();
    openEditor([{ t: 2, gain: 0.25 }]);
    editMusic();
    down(musicBox(), x(2), y(0.25));
    pointer("pointermove", x(5), y(1));
    press("Escape");
    pointer("pointerup", x(5), y(1));
    expect(curve()).toEqual([{ t: 2, gain: 0.25 }]);
    expect(editor().past).toHaveLength(0);
    expect(editor().isOpen).toBe(true);
    expect(editor().discardOpen).toBe(false);
  });

  it("drops a release onto a curve that changed under the drag", () => {
    seed();
    openEditor([{ t: 2, gain: 0.25 }]);
    editMusic();
    down(musicBox(), x(2), y(0.25));
    pointer("pointermove", x(4), y(1));
    act(() =>
      editor().apply((d) => ({
        ...d,
        audioClips: d.audioClips.map((c) => ({ ...c, curve: [{ t: 1, gain: 0.5 }] })),
      })),
    );
    pointer("pointerup", x(4), y(1));
    expect(curve()).toEqual([{ t: 1, gain: 0.5 }]);
  });

  it("takes a click on the steep part of an instant step as a press on its point, removing nothing", () => {
    seed();
    const step = [
      { t: 0, gain: 1 },
      { t: 5, gain: 1 },
      { t: 5.01, gain: 0.25 },
      { t: 9, gain: 0.25 },
    ];
    openEditor(step);
    editMusic();
    const midY = (y(1) + y(0.25)) / 2;
    fireEvent.pointerMove(musicBox(), { clientX: x(5.005), clientY: midY });
    expect(screen.queryByTestId("stitch-add-point")).toBeNull();
    click(musicBox(), x(5.005), midY);
    expect(curve()).toEqual(step);
    expect(editor().past).toHaveLength(0);
    expect(editor().selection).toMatchObject({ kind: "audio", point: expect.any(Number) });
  });

  it("keeps a dragged point under the pointer when the lanes scroll mid-drag", () => {
    seed();
    openEditor([{ t: 2, gain: 0.25 }]);
    editMusic();
    down(musicBox(), x(2), y(0.25));
    pointer("pointermove", x(2) + 10, y(0.25));
    // The lanes scroll 2 s to the left with the pointer held still: it is now over t = 4 + 10px
    vi.spyOn(content(), "getBoundingClientRect").mockReturnValue(rect(-2 * PPS, 0));
    act(() => {
      screen.getByTestId("stitch-lanes").dispatchEvent(new Event("scroll"));
    });
    expect(screen.getByTestId("stitch-curve-readout")).toHaveTextContent(/0:04\.1\d/);
    pointer("pointerup", x(2) + 10, y(0.25));
    expect(curve()[0].t).toBeCloseTo(4 + 10 / PPS);
  });

  it("does not move a point a click nudges by a pixel, and shows a grab cursor over a point", () => {
    seed();
    openEditor([{ t: 2, gain: 0.25 }]);
    editMusic();
    fireEvent.pointerMove(musicBox(), { clientX: x(2), clientY: y(0.25) });
    expect(musicBox()).toHaveClass("cursor-grab");
    fireEvent.pointerMove(musicBox(), { clientX: x(5), clientY: y(0.25) + 1 });
    expect(musicBox()).toHaveClass("cursor-pointer");
    expect(screen.getByTestId("stitch-add-point").style.left).toBe(`${x(5) + 6}px`);
    down(musicBox(), x(2), y(0.25));
    pointer("pointermove", x(2) + 1, y(0.25) + 1);
    pointer("pointerup", x(2) + 1, y(0.25) + 1);
    expect(curve()).toEqual([{ t: 2, gain: 0.25 }]);
    expect(editor().past).toHaveLength(0);
    expect(editor().selection).toMatchObject({ kind: "audio", point: 0 });
  });

  it("does not remove a point it no longer shows: ⌫ after M leaves the curve alone", () => {
    seed();
    openEditor([
      { t: 0, gain: 1 },
      { t: 2, gain: 0.25 },
    ]);
    editMusic();
    click(musicBox(), x(2), y(0.25));
    expect(editor().selection).toMatchObject({ kind: "audio", point: 1 });
    press("m");
    expect(editor().selection).toMatchObject({ kind: "audio", point: null });
    act(() => editor().select(audioSelectionOf({ clipId: MUSIC_CLIP_ID }, 1, true)));
    press("Backspace");
    expect(curve()).toHaveLength(2);
    expect(editor().past).toHaveLength(1);
  });

  it("moves a clip onto the strip as a new row: no row changes before release, one undo step after", () => {
    seed({ stitch: { audioClips: [tone("t", { row: 1, startSec: 2 })] } });
    openEditor();
    const heights = () => rows().map((row) => `${row.style.top}/${row.style.height}`);
    const before = heights();
    // Row 1's block centre is at 96 in the rows; the strip starts at 128
    down(box("tone1320.m4a"), x(3), 96);
    pointer("pointermove", x(3), 96 + 20);
    expect(heights()).toEqual(before);
    pointer("pointermove", x(3), 96 + 40);
    expect(heights()).toEqual(before);
    expect(screen.getByTestId("stitch-audio-new-row")).toHaveTextContent("New row");
    expect(screen.getByTestId("stitch-audio-move-chip")).toHaveTextContent("New row");
    expect(editor().draft!.audioClips.find((c) => c.id === "t")!.row).toBe(1);
    pointer("pointerup", x(3), 96 + 40);
    expect(editor().draft!.audioClips.find((c) => c.id === "t")!.row).toBe(2);
    expect(editor().past).toHaveLength(1);
    // The emptied row stays, so nothing moved up under the pointer
    expect(rows()).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Mute Audio 2" })).toBeDisabled();
  });

  it("marks where an overlap inserts a row, and lands there", () => {
    seed({ stitch: { audioClips: [tone("t", { row: 1, startSec: 2 }), tone("u", { row: 2, startSec: 0 })] } });
    openEditor();
    const rowBoxes = () => rows().map((row) => [row.style.top, row.style.height]);
    const before = rowBoxes();
    const u = within(lane()).getAllByRole("option").find((el) => el.dataset.audioClipId === "u")!;
    down(u, x(1), 160);
    pointer("pointermove", x(1), 160 - 128);
    const line = screen.getByTestId("stitch-audio-insertion");
    // Under row 0 (64px), on the line between it and the next
    expect(line.style.top).toBe(`${64 - 1.5}px`);
    // Nothing moves before the release
    expect(rowBoxes()).toEqual(before);
    pointer("pointerup", x(1), 160 - 128);
    const clips = editor().draft!.audioClips;
    expect(clips.find((c) => c.id === "u")!.row).toBe(1);
    expect(clips.find((c) => c.id === "t")!.row).toBe(2);
    expect(clips.find((c) => c.id === MUSIC_CLIP_ID)!.row).toBe(0);
    expect(editor().past).toHaveLength(1);
  });

  it("moves a clip in time by the drag, and Escape puts it back", () => {
    seed({ stitch: { audioClips: [tone("t", { row: 1, startSec: 2 })] } });
    openEditor();
    down(box("tone1320.m4a"), x(3), 96);
    pointer("pointermove", x(3) + PPS, 96, { shiftKey: true });
    expect(screen.getByTestId("stitch-audio-move-chip")).toHaveTextContent("0:03.00–0:06.00 · +1.00 s");
    press("Escape");
    pointer("pointerup", x(3) + PPS, 96);
    expect(editor().draft!.audioClips.find((c) => c.id === "t")!.startSec).toBe(2);
    expect(editor().past).toHaveLength(0);
    down(box("tone1320.m4a"), x(3), 96);
    pointer("pointermove", x(3) + PPS, 96, { shiftKey: true });
    pointer("pointerup", x(3) + PPS, 96, { shiftKey: true });
    expect(editor().draft!.audioClips.find((c) => c.id === "t")!.startSec).toBeCloseTo(3);
    expect(editor().past).toHaveLength(1);
  });

  it("trims a clip's In with its sound kept in place", () => {
    seed({ stitch: { audioClips: [tone("t", { row: 1, startSec: 2 })] } });
    openEditor();
    click(box("tone1320.m4a"), x(3), 96);
    const handle = box("tone1320.m4a").querySelector<HTMLElement>('[data-trim-handle="in"]')!;
    fireEvent.pointerDown(handle, { button: 0, clientX: x(2), clientY: 96, pointerId: 1, shiftKey: true });
    pointer("pointermove", x(2) + 32, 96, { shiftKey: true });
    expect(screen.getByTestId("stitch-audio-trim-chip")).toHaveTextContent("In 0:00.50");
    pointer("pointerup", x(2) + 32, 96, { shiftKey: true });
    expect(editor().draft!.audioClips.find((c) => c.id === "t")).toMatchObject({ inSec: 0.5, startSec: 2.5, outSec: null });
    expect(editor().past).toHaveLength(1);
  });

  it("moves the selection along the audio clips with the arrows, Home and End", () => {
    seed({ stitch: { audioClips: [tone("t", { row: 1, startSec: 2 }), tone("u", { row: 1, startSec: 6 })] } });
    openEditor();
    click(musicBox());
    act(() => musicBox().focus());
    const key = (k: string) => fireEvent.keyDown(lane(), { key: k });
    key("ArrowRight");
    expect(editor().selection).toMatchObject({ kind: "audio", clipId: "t" });
    expect(document.activeElement).toBe(box("tone1320.m4a, Audio 2, starts 0:02"));
    key("End");
    expect(editor().selection).toMatchObject({ clipId: "u" });
    key("Home");
    expect(editor().selection).toMatchObject({ clipId: MUSIC_CLIP_ID });
    // ↓: the clip on the row below whose start is nearest
    act(() => editor().select(audioSelectionOf({ clipId: MUSIC_CLIP_ID })));
    key("ArrowDown");
    expect(editor().selection).toMatchObject({ clipId: "t" });
    key("ArrowUp");
    expect(editor().selection).toMatchObject({ clipId: MUSIC_CLIP_ID });
  });

  it("decodes the music for its waveform when the cache has none", async () => {
    seed();
    __resetWaveformForTests();
    const decode = vi.fn(async () => ({ channels: [new Float32Array(64).fill(0.5)], duration: 20 }));
    __setWaveformDecoderForTests(decode);
    openEditor();
    expect(decode).toHaveBeenCalledWith("blob:m");
    expect(screen.queryByTestId("stitch-waveform")).toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(within(musicBox()).getByTestId("stitch-waveform")).toBeInTheDocument();
  });
});
