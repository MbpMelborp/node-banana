import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useWorkflowStore } from "@/store/workflowStore";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { __resetMediaInfoForTests, __setMediaExtractorForTests, __setMediaInfoForTests, mediaKeyOf } from "@/lib/stitch/mediaInfo";
import { __resetWaveformForTests, __setWaveformDecoderForTests, __setWaveformForTests } from "@/lib/stitch/waveformCache";
import { GEOMETRY } from "../editorStyles";
import { StitchEditorModal } from "../StitchEditorModal";
import { openStitchEditor } from "../openStitchEditor";
import type { VideoStitchNodeData, VolumePoint, WorkflowEdge, WorkflowNode } from "@/types";

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

// The audio lane inside the real editor, against the real stores. jsdom lays
// nothing out (every rect is at 0), so lane x is the pointer's clientX and a
// block y is its clientY. At 64 px/s a time t is at x = 16 + 64·t; the
// expanded block has 0 dB at y 16 and −∞ at y 106.

const PPS = 64;
const ORIGIN = 16;
const x = (t: number) => ORIGIN + t * PPS;
/** y of a gain in the expanded block (√ level). */
const y = (gain: number) => 16 + (1 - Math.sqrt(gain)) * 90;
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
}

function openEditor(curve?: VolumePoint[]) {
  render(<StitchEditorModal />);
  act(() => {
    openStitchEditor("stitch");
    editor().setZoom(PPS);
  });
  // A curve the editor opened with, so it is not an undo step
  if (curve) act(() => useStitchEditorStore.setState((s) => ({ draft: { ...s.draft!, audioCurve: curve }, initial: { ...s.initial!, audioCurve: curve } })));
}

const block = () => screen.getByRole("button", { name: "Audio track" });
const row = () => screen.getByTestId("stitch-audio-row");
const rail = () => screen.getByRole("complementary", { name: "Audio track" });
const points = () => screen.queryAllByTestId("stitch-curve-point");
const curve = () => editor().draft!.audioCurve;
const press = (key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });
const pointer = (type: "pointermove" | "pointerup", clientX: number, clientY: number, init: MouseEventInit = {}) =>
  act(() => {
    window.dispatchEvent(new MouseEvent(type, { clientX, clientY, bubbles: true, ...init }));
  });
const down = (clientX: number, clientY: number, init: Record<string, unknown> = {}) =>
  fireEvent.pointerDown(block(), { button: 0, clientX, clientY, pointerId: 1, ...init });
/** Select the track with a press on its block (collapsed, any press selects). */
const selectTrack = () => {
  down(x(4), 30);
  pointer("pointerup", x(4), 30);
};
const height = (el: HTMLElement) => el.style.height;
/** Two presses and the dblclick a browser sends after them. */
const doubleClickAt = (clientX: number, clientY: number) => {
  down(clientX, clientY);
  pointer("pointerup", clientX, clientY);
  down(clientX, clientY);
  pointer("pointerup", clientX, clientY);
  fireEvent.doubleClick(block(), { clientX, clientY });
};
const content = () => screen.getByTestId("stitch-lanes").firstElementChild as HTMLElement;
const rect = (left: number, top: number): DOMRect =>
  ({ left, top, right: left, bottom: top, width: 0, height: 0, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

beforeEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  wf().clearWorkflow();
  editor().close();
  __resetMediaInfoForTests();
  __resetWaveformForTests();
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

describe("Audio lane", () => {
  it("shows the music collapsed with its waveform, name and curve, and no guides", () => {
    seed();
    openEditor([
      { t: 0, gain: 0 },
      { t: 1, gain: 1 },
    ]);
    expect(height(row())).toBe("64px");
    expect(block().style.width).toBe(`${9 * PPS}px`);
    expect(within(block()).getByText("score.mp3")).toBeInTheDocument();
    expect(within(block()).getByText("Audio input")).toBeInTheDocument();
    expect(screen.getByTestId("stitch-waveform")).toBeInTheDocument();
    expect(screen.getByTestId("stitch-curve")).toBeInTheDocument();
    // The point at the sequence's start gets no dot (the boards draw none at the ends); the other is r 4
    expect(points()).toHaveLength(1);
    expect(points()[0]).toHaveAttribute("r", "4");
    expect(screen.queryByTestId("stitch-db-guides")).toBeNull();
    expect(screen.queryAllByTestId("stitch-db-label")).toHaveLength(0);
    expect(block()).toHaveAttribute("aria-expanded", "false");
    // The label bar is drawn over the curve, as on the boards
    const label = within(block()).getByText("score.mp3").parentElement!;
    expect(screen.getByTestId("stitch-curve").compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("grows when its block is clicked, with dB guides, and the rail shows the track", () => {
    seed();
    openEditor();
    const timeline = screen.getByTestId("stitch-lanes").parentElement!;
    expect(height(timeline)).toBe("200px");
    selectTrack();
    expect(editor().selection).toEqual({ kind: "audio", point: null });
    expect(height(row())).toBe("136px");
    expect(height(block())).toBe("120px");
    expect(height(timeline)).toBe("272px");
    expect(screen.getByTestId("stitch-db-guides")).toBeInTheDocument();
    expect(screen.getAllByTestId("stitch-db-label").map((el) => el.textContent)).toEqual(["0 dB", "−12", "−∞"]);
    expect(within(rail()).getByText("score.mp3")).toBeInTheDocument();
    expect(rail()).toHaveTextContent("Audio input · 0:09.00");
    expect(within(rail()).getByText("0:09.00")).toHaveClass("font-mono", "tabular-nums");
    expect(block()).toHaveAttribute("aria-expanded", "true");
    expect(within(rail()).getByRole("button", { name: "Fade in" })).toBeInTheDocument();
    // Selecting a clip collapses it again
    fireEvent.pointerDown(screen.getByRole("option", { name: "Clip 1" }), { button: 0, clientX: 100, pointerId: 1 });
    pointer("pointerup", 100, 0);
    expect(height(row())).toBe("64px");
    expect(screen.getByRole("complementary", { name: "Clip" })).toBeInTheDocument();
  });

  it("places a fade in and a fade out from the rail, and Flat clears the curve", () => {
    seed();
    openEditor();
    selectTrack();
    fireEvent.click(within(rail()).getByRole("button", { name: "Fade in" }));
    expect(curve()).toEqual([
      { t: 0, gain: 0 },
      { t: 1, gain: 1 },
    ]);
    fireEvent.click(within(rail()).getByRole("button", { name: "Fade out" }));
    expect(curve()).toEqual([
      { t: 0, gain: 0 },
      { t: 1, gain: 1 },
      { t: 8, gain: 1 },
      { t: 9, gain: 0 },
    ]);
    expect(editor().past).toHaveLength(2);
    // The fades' points at 0 and 9 are the sequence's ends: no dot there
    expect(points()).toHaveLength(2);
    fireEvent.click(within(rail()).getByRole("button", { name: "Flat" }));
    expect(curve()).toEqual([]);
    expect(within(rail()).getByRole("button", { name: "Flat" })).toBeDisabled();
  });

  it("mutes the track with M: the chip shows and the curve goes; the rail's switch follows", () => {
    seed();
    openEditor([{ t: 2, gain: 0.5 }]);
    press("m");
    expect(editor().draft!.audioMuted).toBe(true);
    expect(screen.getByTestId("stitch-audio-muted")).toHaveTextContent("Muted");
    expect(screen.queryByTestId("stitch-curve")).toBeNull();
    expect(screen.getByRole("button", { name: "Unmute audio track" })).toBeInTheDocument();
    selectTrack();
    expect(within(rail()).getByRole("switch", { name: "Track sound" })).toHaveAttribute("aria-checked", "false");
    expect(within(rail()).getByRole("button", { name: "Fade in" })).toBeDisabled();
    fireEvent.click(within(rail()).getByRole("switch", { name: "Track sound" }));
    expect(editor().draft!.audioMuted).toBe(false);
    expect(screen.queryByTestId("stitch-audio-muted")).toBeNull();
    expect(screen.getByTestId("stitch-curve")).toBeInTheDocument();
  });

  it("mutes from the track header's button", () => {
    seed();
    openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Mute audio track" }));
    expect(editor().draft!.audioMuted).toBe(true);
    expect(editor().past).toHaveLength(1);
  });

  it("says when nothing is connected, and offers no mute", () => {
    seed({ music: false });
    openEditor();
    expect(within(row()).getByText("Connect audio to the node")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Audio track" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Mute audio track" })).toBeNull();
  });

  it("holds a dashed placeholder with the file name when the music has no clips to go under", () => {
    seed({ clips: false });
    openEditor();
    const placeholder = screen.getByTestId("stitch-audio-placeholder");
    expect(within(placeholder).getByText("score.mp3")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Audio track" })).toBeNull();
    expect(screen.queryByTestId("stitch-waveform")).toBeNull();
    expect(screen.queryByTestId("stitch-curve")).toBeNull();
  });

  it("removes a point on a double-click", () => {
    seed();
    openEditor([
      { t: 0, gain: 1 },
      { t: 2, gain: 0.25 },
      { t: 6, gain: 1 },
    ]);
    selectTrack();
    doubleClickAt(x(2), y(0.25));
    expect(curve()).toEqual([
      { t: 0, gain: 1 },
      { t: 6, gain: 1 },
    ]);
    expect(editor().selection).toEqual({ kind: "audio", point: null });
    expect(editor().past).toHaveLength(1);
  });

  it("removes nothing on a double-click that opens the lane, though the lane grows under the pointer", () => {
    seed();
    openEditor([
      { t: 0, gain: 1 },
      { t: 4, gain: 0.25 },
      { t: 9, gain: 1 },
    ]);
    // jsdom puts the block at 0 in both sizes: the second press lands on the expanded point at 4
    doubleClickAt(x(4), y(0.25));
    expect(curve()).toHaveLength(3);
    expect(editor().past).toHaveLength(0);
    expect(editor().selection).toEqual({ kind: "audio", point: null });
  });

  it("adds one point on a double-click on the line, and does not take it away again", () => {
    seed();
    openEditor();
    selectTrack();
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
    selectTrack();
    down(x(2), y(0.25));
    pointer("pointermove", x(3), y(1));
    // The drag is local: the draft has not moved, the readout follows the point
    expect(curve()[1]).toEqual({ t: 2, gain: 0.25 });
    const readout = screen.getByTestId("stitch-curve-readout");
    expect(readout).toHaveTextContent("0.0 dB");
    expect(readout).toHaveTextContent("0:03.00");
    expect(wf().nodes.find((n) => n.id === "stitch")!.data).not.toHaveProperty("audioCurve");
    pointer("pointerup", x(3), y(1));
    expect(curve()).toEqual([
      { t: 0, gain: 1 },
      { t: 3, gain: 1 },
      { t: 6, gain: 1 },
    ]);
    expect(editor().past).toHaveLength(1);
    expect(editor().selection).toEqual({ kind: "audio", point: 1 });
    expect(screen.queryByTestId("stitch-curve-readout")).toBeNull();
    press("z", { metaKey: true });
    expect(curve()[1]).toEqual({ t: 2, gain: 0.25 });
    expect(editor().selection).toEqual({ kind: "audio", point: null });
    press("Backspace");
    expect(curve()).toHaveLength(3);
  });

  it("removes the selected point with ⌫", () => {
    seed();
    openEditor([
      { t: 0, gain: 1 },
      { t: 2, gain: 0.25 },
    ]);
    selectTrack();
    down(x(2), y(0.25));
    pointer("pointerup", x(2), y(0.25));
    expect(editor().selection).toEqual({ kind: "audio", point: 1 });
    expect(editor().past).toHaveLength(0);
    press("Backspace");
    expect(curve()).toEqual([{ t: 0, gain: 1 }]);
  });

  it("adds a point on the line where it is clicked, with an Add point hint on hover", () => {
    seed();
    openEditor();
    selectTrack();
    fireEvent.pointerMove(block(), { clientX: x(3), clientY: y(1) + 2 });
    expect(screen.getByTestId("stitch-add-point")).toHaveTextContent("Add point");
    fireEvent.pointerMove(block(), { clientX: x(3), clientY: y(0.25) });
    expect(screen.queryByTestId("stitch-add-point")).toBeNull();
    down(x(1), y(1) + 3);
    pointer("pointerup", x(1), y(1) + 3);
    expect(curve()).toEqual([{ t: 1, gain: 1 }]);
    expect(editor().past).toHaveLength(1);
    expect(editor().selection).toEqual({ kind: "audio", point: 0 });
  });

  it("adds and drags a point in one undo step", () => {
    seed();
    openEditor();
    selectTrack();
    down(x(4), y(1));
    pointer("pointermove", x(4), y(0.25));
    pointer("pointerup", x(4), y(0.25));
    expect(curve()).toHaveLength(1);
    expect(curve()[0].t).toBeCloseTo(4);
    expect(curve()[0].gain).toBeCloseTo(0.25);
    expect(editor().past).toHaveLength(1);
  });

  it("moves the whole line with ⌥ held, leaving no point selected", () => {
    seed();
    openEditor();
    selectTrack();
    down(x(2), 40, { altKey: true });
    pointer("pointermove", x(2), 40 + 45);
    pointer("pointerup", x(2), 40 + 45);
    expect(curve()).toHaveLength(2);
    expect(curve()[0]).toEqual({ t: 0, gain: expect.closeTo(0.25) });
    expect(curve()[1]).toEqual({ t: 9, gain: expect.closeTo(0.25) });
    expect(editor().past).toHaveLength(1);
    expect(editor().selection).toEqual({ kind: "audio", point: null });
  });

  it("cancels a point drag on Escape, leaving the curve and the editor as they were", () => {
    seed();
    openEditor([{ t: 2, gain: 0.25 }]);
    selectTrack();
    down(x(2), y(0.25));
    pointer("pointermove", x(5), y(1));
    press("Escape");
    pointer("pointerup", x(5), y(1));
    expect(curve()).toEqual([{ t: 2, gain: 0.25 }]);
    expect(editor().past).toHaveLength(0);
    expect(editor().isOpen).toBe(true);
    expect(editor().discardOpen).toBe(false);
  });

  it("leaves the curve alone while collapsed: a press only selects the track", () => {
    seed();
    openEditor([{ t: 2, gain: 0.25 }]);
    down(x(2), 10 + 0.5 * 31);
    pointer("pointermove", x(5), 0);
    pointer("pointerup", x(5), 0);
    expect(curve()).toEqual([{ t: 2, gain: 0.25 }]);
    expect(editor().selection).toEqual({ kind: "audio", point: null });
  });

  it("writes the curve and the mute to the node on Done", () => {
    seed();
    openEditor();
    selectTrack();
    fireEvent.click(within(rail()).getByRole("button", { name: "Fade in" }));
    press("m");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    const data = wf().nodes.find((n) => n.id === "stitch")!.data as VideoStitchNodeData;
    expect(data.audioCurve).toEqual([
      { t: 0, gain: 0 },
      { t: 1, gain: 1 },
    ]);
    expect(data.audioMuted).toBe(true);
  });

  it("does not remove a point it no longer shows: ⌫ after M leaves the curve alone", () => {
    seed();
    openEditor([
      { t: 0, gain: 1 },
      { t: 2, gain: 0.25 },
    ]);
    selectTrack();
    down(x(2), y(0.25));
    pointer("pointerup", x(2), y(0.25));
    expect(editor().selection).toEqual({ kind: "audio", point: 1 });
    press("m");
    expect(editor().selection).toEqual({ kind: "audio", point: null });
    // Even with a point selected while muted (a selection the store kept), ⌫ does nothing
    act(() => editor().select({ kind: "audio", point: 1 }));
    press("Backspace");
    expect(curve()).toHaveLength(2);
    expect(editor().past).toHaveLength(1);
  });

  it("keeps a muted, selected track from editing: a dimmed waveform, no dB labels, a press changes nothing", () => {
    seed();
    openEditor([{ t: 3, gain: 1 }]);
    press("m");
    selectTrack();
    expect(height(row())).toBe("136px");
    expect(screen.getByTestId("stitch-waveform").parentElement).toHaveClass("opacity-35");
    expect(screen.queryAllByTestId("stitch-db-label")).toHaveLength(0);
    expect(block()).toHaveClass("ring-handle-audio/30");
    const steps = editor().past.length;
    down(x(3), y(1));
    pointer("pointermove", x(5), y(0.25));
    pointer("pointerup", x(5), y(0.25));
    down(x(6), y(1));
    pointer("pointerup", x(6), y(1));
    expect(curve()).toEqual([{ t: 3, gain: 1 }]);
    expect(editor().past).toHaveLength(steps);
  });

  it("shows the track's rail and grows only with music under a sequence with some length", () => {
    seed({ music: false });
    openEditor();
    act(() => editor().select({ kind: "audio", point: null }));
    expect(height(screen.getByTestId("stitch-lanes").parentElement!)).toBe("200px");
    expect(screen.getByRole("complementary", { name: "Clip" })).toBeInTheDocument();
    act(() => editor().close());
    seed({ clips: false });
    openEditor();
    act(() => editor().select({ kind: "audio", point: null }));
    expect(height(screen.getAllByTestId("stitch-lanes").at(-1)!.parentElement!)).toBe("200px");
    expect(screen.queryByRole("complementary", { name: "Audio track" })).toBeNull();
  });

  it("can still unmute a muted track whose music was disconnected", () => {
    seed({ music: false, stitch: { audioMuted: true } });
    openEditor();
    expect(editor().draft!.audioMuted).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Unmute audio track" }));
    expect(editor().draft!.audioMuted).toBe(false);
  });

  it("drops a release onto a curve that changed under the drag", () => {
    seed();
    openEditor([{ t: 2, gain: 0.25 }]);
    selectTrack();
    down(x(2), y(0.25));
    pointer("pointermove", x(4), y(1));
    act(() => editor().apply((d) => ({ ...d, audioCurve: [{ t: 1, gain: 0.5 }] })));
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
    selectTrack();
    const midY = (y(1) + y(0.25)) / 2;
    fireEvent.pointerMove(block(), { clientX: x(5.005), clientY: midY });
    expect(screen.queryByTestId("stitch-add-point")).toBeNull();
    down(x(5.005), midY);
    pointer("pointerup", x(5.005), midY);
    expect(curve()).toEqual(step);
    expect(editor().past).toHaveLength(0);
    expect(editor().selection).toMatchObject({ kind: "audio", point: expect.any(Number) });
  });

  it("keeps a dragged point under the pointer when the lanes scroll mid-drag", () => {
    seed();
    openEditor([{ t: 2, gain: 0.25 }]);
    selectTrack();
    down(x(2), y(0.25));
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

  it("does not move a point a click nudges by a pixel", () => {
    seed();
    openEditor([{ t: 2, gain: 0.25 }]);
    selectTrack();
    down(x(2), y(0.25));
    pointer("pointermove", x(2) + 1, y(0.25) + 1);
    pointer("pointerup", x(2) + 1, y(0.25) + 1);
    expect(curve()).toEqual([{ t: 2, gain: 0.25 }]);
    expect(editor().past).toHaveLength(0);
    expect(editor().selection).toEqual({ kind: "audio", point: 0 });
  });

  it("shows a grab cursor over a point and puts the Add point chip 6px right of the ghost", () => {
    seed();
    openEditor([{ t: 2, gain: 0.25 }]);
    selectTrack();
    fireEvent.pointerMove(block(), { clientX: x(2), clientY: y(0.25) });
    expect(block()).toHaveClass("cursor-grab");
    fireEvent.pointerMove(block(), { clientX: x(5), clientY: y(0.25) + 1 });
    expect(block()).toHaveClass("cursor-pointer");
    expect(screen.getByTestId("stitch-add-point").style.left).toBe(`${x(5) + 6}px`);
  });

  it("keeps the connect box wide enough for its copy under a short sequence", () => {
    seed({ music: false });
    // A lane 1000px wide: 9 s at 8 px/s is a 72px block
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
    openEditor();
    act(() => editor().setZoom(8));
    const box = within(row()).getByText("Connect audio to the node");
    expect(box.style.width).toBe("180px");
  });

  it("keeps the dialog's focus when the rail swaps the track for a clip", () => {
    seed();
    openEditor();
    selectTrack();
    const fade = within(rail()).getByRole("button", { name: "Fade in" });
    act(() => fade.focus());
    fireEvent.pointerDown(screen.getByRole("option", { name: "Clip 1" }), { button: 0, clientX: 100, pointerId: 1 });
    pointer("pointerup", 100, 0);
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
  });

  it("keeps the header's mute button, and its focus, when the lane collapses", () => {
    seed();
    openEditor();
    selectTrack();
    const mute = screen.getByRole("button", { name: "Mute audio track" });
    act(() => mute.focus());
    fireEvent.pointerDown(screen.getByRole("option", { name: "Clip 1" }), { button: 0, clientX: 100, pointerId: 1 });
    pointer("pointerup", 100, 0);
    expect(height(row())).toBe("64px");
    expect(screen.getByRole("button", { name: "Mute audio track" })).toBe(mute);
    expect(document.activeElement).toBe(mute);
  });

  it("places the trim popover on the lanes as they are after a press collapses the audio lane", () => {
    seed();
    openEditor();
    selectTrack();
    // The lanes sit 72px lower once the expanded audio row collapses
    vi.spyOn(content(), "getBoundingClientRect").mockImplementation(() =>
      rect(0, editor().selection?.kind === "audio" ? 100 : 172),
    );
    const handle = screen.getByRole("option", { name: "Clip 1" }).querySelector<HTMLElement>('[data-trim-handle="out"]')!;
    fireEvent.pointerDown(handle, { button: 0, clientX: x(5), pointerId: 1 });
    expect(height(row())).toBe("64px");
    expect(screen.getByTestId("stitch-trim-popover").style.top).toBe(`${172 + GEOMETRY.ruler - 101}px`);
    pointer("pointerup", x(5), 0);
  });

  it("decodes the music for its waveform when the cache has none", async () => {
    seed();
    __resetWaveformForTests();
    const decode = vi.fn(async () => ({ channels: [new Float32Array(64).fill(0.5)], duration: 20 }));
    __setWaveformDecoderForTests(decode);
    openEditor();
    expect(decode).toHaveBeenCalledTimes(1);
    expect(decode).toHaveBeenCalledWith("blob:m");
    expect(screen.queryByTestId("stitch-waveform")).toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByTestId("stitch-waveform")).toBeInTheDocument();
  });
});
