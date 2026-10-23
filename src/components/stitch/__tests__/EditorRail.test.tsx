import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { getEasingBezier } from "@/lib/easing";
import type { StitchDraft } from "@/lib/stitch/draft";
import { WAITING_FOR_CLIPS } from "@/lib/stitch/libraryInsert";
import { seedRamp } from "@/lib/stitch/rampModes";
import { DEFAULT_SEQUENCE_LAYOUT } from "@/lib/stitch/stack";
import { createClip, sourceKey, type SourceKey } from "@/lib/stitch/timeline";
import { bakeError, normalizeWarp, withWarp } from "@/lib/stitch/warp";
import type { ClipWarp, ClipWarpCurve, StitchTimelineClip } from "@/types";
import { EditorRail } from "../EditorRail";
import { ClipContextMenu } from "../timeline/ClipContextMenu";
import type { ClipMediaView } from "../useStitchEditorMedia";

vi.mock("@/components/Toast", () => ({ useToast: { getState: () => ({ show: vi.fn() }) } }));

// The video clip rail's Speed section, through EditorRail, against the real editor store: the slider, the well and
// the presets, the notes, the ramp picker, Reverse and Blend frames, Reset speed, and several clips' Speed and Reverse;
// and Reset trim, in the rail and the clip menu.

const editor = () => useStitchEditorStore.getState();
const W = (speed: number, extra: Partial<ClipWarp> = {}): ClipWarp => ({
  speed,
  curve: null,
  reverse: false,
  blend: false,
  ...extra,
});
const QUAD: ClipWarpCurve = { kind: "preset", name: "easeInQuad" };
const edgeClip = (id: string, edgeId: string, init: Partial<StitchTimelineClip> = {}, warp?: ClipWarp) =>
  withWarp(createClip({ kind: "edge", edgeId }, { id, ...init }), warp ? normalizeWarp(warp) : undefined);

/** The rail's media view of a clip whose source has this length (null: not read yet). */
const viewOf = (clip: StitchTimelineClip, duration: number | null): ClipMediaView => ({
  clipId: clip.id,
  key: sourceKey(clip.source),
  src: "blob:a",
  mediaKey: null,
  status: "ready",
  duration,
  width: 1920,
  height: 1080,
  fps: 24,
  frames: [],
  sourceNodeId: null,
  sourceLabel: "Veo 3.1",
  railSource: { kind: "Generate video", detail: "Veo 3.1" },
  missing: false,
});

/** The clips with their sources' lengths (seconds, or null for unknown), the first selected. */
function open(clips: Array<[StitchTimelineClip, number | null]>, { stacked = false }: { stacked?: boolean } = {}) {
  const draft: StitchDraft = {
    timeline: clips.map(([clip]) => clip),
    audioClips: [],
    legacyAudio: { curve: [], muted: false },
    loopCount: 1,
    sequenceLayout: stacked ? { mode: "stacked", overlapSec: 1, crossfade: true } : DEFAULT_SEQUENCE_LAYOUT,
  };
  const known = clips.flatMap(([clip, d]) => (d === null ? [] : [[sourceKey(clip.source), d] as [SourceKey, number]]));
  act(() => {
    editor().open({ nodeId: "stitch", draft, canvasGeneration: 1 });
    editor().setDurations(new Map(known));
    editor().select({ kind: "clip", clipId: clips[0][0].id });
  });
  return new Map(clips.flatMap(([clip, d]) => (d === null ? [] : [[clip.id, viewOf(clip, d)] as const])));
}

/** The rail in a panel focus can go back to, as the editor's column is. */
function renderRail(media: ReadonlyMap<string, ClipMediaView>) {
  return render(
    <div data-stitch-editor="" tabIndex={-1} data-testid="panel">
      <EditorRail media={media} audio={new Map()} frameSize={null} />
    </div>,
  );
}

const clip = (id = "a") => editor().draft!.timeline.find((c) => c.id === id)!;
const steps = () => editor().past.length;
const slider = () => screen.getByRole("slider", { name: "Clip speed" }) as HTMLInputElement;
const well = () => screen.getByRole("textbox", { name: "Speed" }) as HTMLInputElement;
const group = (name: string) => screen.getByRole("group", { name });
const preset = (label: string) => within(group("Speed presets")).getByRole("button", { name: label });
const segment = (groupName: string, label: string) => within(group(groupName)).getByRole("button", { name: label });
const pressedIn = (groupName: string) =>
  within(group(groupName))
    .getAllByRole("button")
    .filter((b) => b.getAttribute("aria-pressed") === "true")
    .map((b) => b.getAttribute("aria-label") ?? b.textContent);
const toggle = (name: string) => screen.getByRole("switch", { name });
/** Typed into a well and committed with Enter, which hands focus back to the panel. */
function commit(value: string) {
  const field = well();
  act(() => field.focus());
  fireEvent.change(field, { target: { value } });
  fireEvent.keyDown(field, { key: "Enter" });
}
const slide = (pos: number) => fireEvent.change(slider(), { target: { value: String(pos) } });
/** The bezier editor's frames at once, and its square 260px at the page's origin, as jsdom lays nothing out. */
function mockBezierSquare(handle: HTMLElement) {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    cb(0);
    return 0;
  });
  vi.spyOn(handle.parentElement!, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 260,
    height: 260,
    right: 260,
    bottom: 260,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
}

beforeEach(() => {
  act(() => editor().close());
});
afterEach(() => {
  act(() => editor().close());
  vi.restoreAllMocks();
});

describe("EditorRail, a clip's speed", () => {
  it("puts Speed, Ramp, Reverse and Blend frames under Volume, at 1× with no ramp", () => {
    renderRail(open([[edgeClip("a", "e1"), 10]]));
    const order = [
      screen.getByRole("slider", { name: "Clip volume" }),
      slider(),
      well(),
      group("Speed presets"),
      group("Ramp"),
      toggle("Reverse"),
      toggle("Blend frames"),
      screen.getByRole("button", { name: "Split at playhead" }),
    ];
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(slider().value).toBe("50");
    expect(slider()).toHaveAttribute("aria-valuetext", "1×");
    expect(well().value).toBe("1×");
    expect(pressedIn("Speed presets")).toEqual(["1×"]);
    expect(pressedIn("Ramp")).toEqual(["None"]);
  });

  it("makes a slider drag one step, and the next drag another", () => {
    renderRail(open([[edgeClip("a", "e1"), 10]]));
    slide(65);
    expect(slider()).toHaveAttribute("aria-valuetext", "2×");
    slide(35);
    expect(clip().warp?.speed).toBe(0.5);
    expect(steps()).toBe(1);
    fireEvent.pointerUp(slider());
    slide(100);
    expect(clip().warp?.speed).toBe(10);
    expect(steps()).toBe(2);
    // At the rail's own ends a clip with room to spare has no limit to note
    expect(screen.queryByText(/^Can't be/)).toBeNull();
    // An arrow key's step ends at its key-up
    fireEvent.keyUp(slider(), { key: "ArrowLeft" });
    slide(0);
    expect(clip().warp?.speed).toBe(0.1);
    expect(steps()).toBe(3);
    expect(screen.queryByText(/^Can't be/)).toBeNull();
  });

  it("sets a preset, notes the length on the timeline, and keeps a ramp", () => {
    renderRail(open([[edgeClip("a", "e1"), 10]]));
    fireEvent.click(preset("2×"));
    expect(clip().warp?.speed).toBe(2);
    expect(pressedIn("Speed presets")).toEqual(["2×"]);
    expect(screen.getByText("Lasts 5.00 s on the timeline.")).toBeInTheDocument();
    fireEvent.click(preset("1×"));
    expect("warp" in clip()).toBe(false);
    expect(screen.queryByText(/on the timeline\./)).toBeNull();
    fireEvent.click(segment("Ramp", "Preset"));
    fireEvent.click(preset("2×"));
    expect(clip().warp).toEqual(W(2, { curve: { kind: "preset", name: "easeInOutSine" } }));
  });

  it("takes a typed speed in the well, and a run of ↑/↓ as one step", () => {
    renderRail(open([[edgeClip("a", "e1"), 10]]));
    for (const [text, speed] of [
      ["0.5", 0.5],
      ["2x", 2],
      ["3×", 3],
      ["0,25", 0.25],
    ] as const) {
      commit(text);
      expect(clip().warp?.speed).toBe(speed);
    }
    expect(steps()).toBe(4);
    commit("fast");
    expect(clip().warp?.speed).toBe(0.25);
    expect(steps()).toBe(4);
    commit("50");
    expect(clip().warp?.speed).toBe(10);
    commit("1");
    expect("warp" in clip()).toBe(false);
    const before = steps();
    act(() => well().focus());
    fireEvent.keyDown(well(), { key: "ArrowUp" });
    fireEvent.keyDown(well(), { key: "ArrowUp" });
    expect(clip().warp?.speed).toBe(1.1);
    expect(well().value).toBe("1.1×");
    expect(steps()).toBe(before + 1);
    fireEvent.blur(well());
    act(() => well().focus());
    fireEvent.keyDown(well(), { key: "ArrowDown" });
    expect(clip().warp?.speed).toBe(1.05);
    expect(steps()).toBe(before + 2);
  });

  it("keeps a clip within 10 minutes and over 0.1 s, and says why", () => {
    const long = renderRail(open([[edgeClip("a", "e1"), 120]]));
    commit("0.1");
    expect(clip().warp?.speed).toBe(0.2);
    expect(screen.getByText("Can't be slower: it would play for more than 10 minutes.")).toBeInTheDocument();
    long.unmount();

    const short = renderRail(open([[edgeClip("a", "e1", { outSec: 0.3 }), 10]]));
    expect(preset("4×")).toBeDisabled();
    expect(preset("4×")).toHaveAttribute("title", "It would last under 0.1 s");
    commit("10");
    expect(clip().warp?.speed).toBe(3);
    expect(screen.getByText("Can't be faster: it would last under 0.1 s.")).toBeInTheDocument();
    short.unmount();

    renderRail(open([[edgeClip("a", "e1"), 900]]));
    expect(preset("0.5×")).toBeDisabled();
    expect(preset("0.5×")).toHaveAttribute("title", "It would play for more than 10 minutes");
    commit("0.5");
    expect("warp" in clip()).toBe(false);
    expect(screen.getByText("Can't be slower: it would play for more than 10 minutes.")).toBeInTheDocument();
  });

  it("shows a split piece's speed as it is, the slider pinned, and steps it only towards the range", () => {
    renderRail(open([[edgeClip("a", "e1", {}, W(0.04, { curve: QUAD, window: [0, 0.2] })), 10]]));
    expect(well().value).toBe("0.04×");
    expect(slider().value).toBe("0");
    expect(slider().style.getPropertyValue("--p")).toBe("0%");
    act(() => well().focus());
    fireEvent.keyDown(well(), { key: "ArrowDown" });
    expect(steps()).toBe(0);
    fireEvent.keyDown(well(), { key: "ArrowUp" });
    expect(clip().warp?.speed).toBe(0.105);
  });

  it("moves a piece just over its own rounded limit only towards it, by the slider as by ↑/↓", () => {
    // 0.501 s of source: 5.01× at most, and a split can leave a piece at 5.0138×
    renderRail(open([[edgeClip("a", "e1", { outSec: 0.501 }, W(5.0138)), 10]]));
    expect(slider().value).toBe("85");
    slide(86);
    act(() => well().focus());
    fireEvent.keyDown(well(), { key: "ArrowUp" });
    expect(clip().warp?.speed).toBe(5.0138);
    expect(steps()).toBe(0);
    slide(84);
    expect(clip().warp?.speed).toBeLessThan(5.0138);
    expect(steps()).toBe(1);
  });

  it("keeps the source range in the title line", () => {
    const text = "Generate video · Veo 3.1 · 10.00 s";
    const view = renderRail(open([[edgeClip("a", "e1"), 10]]));
    expect(screen.getByText(text)).toBeInTheDocument();
    view.unmount();
    renderRail(open([[edgeClip("a", "e1", {}, W(2)), 10]]));
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it("says when the render leaves the clip's own sound out", () => {
    const note = "No sound above 4× or below 0.25×.";
    for (const [warp, shown] of [
      [W(5), true],
      [W(4), false],
      [W(0.2), true],
      [W(5, { curve: QUAD }), false],
    ] as const) {
      const view = renderRail(open([[edgeClip("a", "e1", {}, warp), 10]]));
      expect(screen.queryByText(note) !== null).toBe(shown);
      view.unmount();
    }
  });

  it("reverses in one step, and forward again removes the warp", () => {
    renderRail(open([[edgeClip("a", "e1"), 10]]));
    fireEvent.click(toggle("Reverse"));
    expect(clip().warp).toEqual(W(1, { reverse: true }));
    expect(steps()).toBe(1);
    fireEvent.click(toggle("Reverse"));
    expect("warp" in clip()).toBe(false);
  });

  it("offers Blend frames only in slow motion, and a drag through 1× keeps it", () => {
    for (const warp of [undefined, W(2)]) {
      const view = renderRail(open([[edgeClip("a", "e1", {}, warp), 10]]));
      expect(toggle("Blend frames")).toBeDisabled();
      expect(toggle("Blend frames")).toHaveAttribute("title", "Only in slow motion");
      view.unmount();
    }
    const ramp = renderRail(open([[edgeClip("a", "e1", {}, W(1, { curve: QUAD })), 10]]));
    expect(toggle("Blend frames")).toBeEnabled();
    ramp.unmount();
    renderRail(open([[edgeClip("a", "e1", {}, W(0.5)), 10]]));
    fireEvent.click(toggle("Blend frames"));
    expect(clip().warp).toEqual(W(0.5, { blend: true }));
    slide(50);
    expect("warp" in clip()).toBe(false);
    slide(35);
    expect(clip().warp).toEqual(W(0.5, { blend: true }));
    expect(steps()).toBe(2);
    // The carry ends with the drag: Blend switched off stays off through the next one
    fireEvent.pointerUp(slider());
    fireEvent.click(toggle("Blend frames"));
    slide(40);
    expect(clip().warp?.blend).toBe(false);
  });

  it("keeps a bezier drag's Blend through the diagonal, where the warp itself goes", () => {
    renderRail(open([[edgeClip("a", "e1", {}, W(1, { curve: { kind: "bezier", handles: [0, 0, 0.58, 1] }, blend: true })), 10]]));
    const second = screen.getByLabelText("Adjust control point 2");
    mockBezierSquare(second);
    fireEvent.pointerDown(second, { clientX: 0.58 * 260, clientY: 0 });
    fireEvent.pointerMove(window, { clientX: 260, clientY: 0 });
    expect("warp" in clip()).toBe(false);
    fireEvent.pointerMove(window, { clientX: 260, clientY: 26 });
    fireEvent.pointerUp(window);
    expect(clip().warp?.blend).toBe(true);
    expect(steps()).toBe(1);
  });

  it("picks a ramp: a preset, another, its bezier, a drag of it, points and none, each one step", () => {
    renderRail(open([[edgeClip("a", "e1"), 5]]));
    fireEvent.click(segment("Ramp", "Preset"));
    expect(clip().warp?.curve).toEqual({ kind: "preset", name: "easeInOutSine" });
    expect(within(group("Ramp presets")).getAllByRole("button")).toHaveLength(23);
    fireEvent.click(within(group("Ramp presets")).getByRole("button", { name: "Ease out cubic" }));
    expect(clip().warp?.curve).toEqual({ kind: "preset", name: "easeOutCubic" });
    fireEvent.click(segment("Ramp", "Bezier"));
    const [x1, y1, x2, y2] = getEasingBezier("easeOutCubic");
    expect(clip().warp?.curve).toEqual({ kind: "bezier", handles: [x1, y1, x2, y2] });
    const first = screen.getByLabelText("Adjust control point 1");
    expect(first.style.left).toBe(`${x1 * 100}%`);
    expect(screen.getByLabelText("Adjust control point 2").style.top).toBe(`${(1 - y2) * 100}%`);
    expect(steps()).toBe(3);

    mockBezierSquare(first);
    fireEvent.pointerDown(first, { clientX: x1 * 260, clientY: (1 - y1) * 260 });
    fireEvent.pointerMove(window, { clientX: x1 * 260 + 13, clientY: (1 - y1) * 260 });
    fireEvent.pointerMove(window, { clientX: x1 * 260 + 26, clientY: (1 - y1) * 260 + 26 });
    fireEvent.pointerUp(window);
    const dragged = clip().warp!.curve as { kind: "bezier"; handles: number[] };
    expect(dragged.handles[0]).toBeCloseTo(x1 + 0.1, 9);
    expect(dragged.handles[1]).toBeCloseTo(y1 - 0.1, 9);
    expect(steps()).toBe(4);

    fireEvent.click(segment("Ramp", "Points"));
    // Baked within half a frame of this clip's 5 s at its 24 fps, not at the 30 fps a missing rate reads as, nor the
    // default budget
    expect(clip().warp?.curve).toEqual(seedRamp("points", dragged as ClipWarpCurve, undefined, bakeError(5, 24)));
    expect(clip().warp?.curve).not.toEqual(seedRamp("points", dragged as ClipWarpCurve, undefined, bakeError(5, null)));
    expect(clip().warp?.curve).not.toEqual(seedRamp("points", dragged as ClipWarpCurve));
    expect(screen.getByTestId("stitch-ramp-preview")).toBeInTheDocument();
    fireEvent.click(segment("Ramp", "None"));
    expect("warp" in clip()).toBe(false);
    expect(steps()).toBe(6);
  });

  it("shows a split piece as Points, and a new preset replaces its whole ramp", () => {
    renderRail(open([[edgeClip("a", "e1", {}, W(1.5, { curve: QUAD, window: [0.3, 1] })), 10]]));
    expect(pressedIn("Ramp")).toEqual(["Points"]);
    expect(screen.getByText("Part of a ramp, cut by a split.")).toBeInTheDocument();
    expect(screen.getByTestId("stitch-ramp-preview").querySelectorAll("circle")).toHaveLength(0);
    fireEvent.click(segment("Ramp", "Preset"));
    expect(clip().warp).toEqual(W(1.5, { curve: QUAD }));
    expect(steps()).toBe(1);
  });

  it("turns Speed, Ramp and Blend off while the length is unknown; Reverse, which reads none, still acts", () => {
    renderRail(open([[edgeClip("a", "e1"), null]]));
    expect(slider()).toBeDisabled();
    expect(well()).toBeDisabled();
    for (const b of within(group("Speed presets")).getAllByRole("button")) expect(b).toBeDisabled();
    for (const b of within(group("Ramp")).getAllByRole("button")) expect(b).toBeDisabled();
    expect(toggle("Blend frames")).toBeDisabled();
    fireEvent.click(toggle("Reverse"));
    expect(clip().warp).toEqual(W(1, { reverse: true }));
  });

  it("offers Reset speed only on a retimed clip; it keeps Reverse and hands focus to the panel", () => {
    for (const warp of [undefined, W(1, { reverse: true })]) {
      const view = renderRail(open([[edgeClip("a", "e1", {}, warp), 10]]));
      expect(screen.queryByRole("button", { name: "Reset speed" })).toBeNull();
      view.unmount();
    }
    const reversed = renderRail(open([[edgeClip("a", "e1", {}, W(2, { reverse: true })), 10]]));
    const reset = screen.getByRole("button", { name: "Reset speed" });
    act(() => reset.focus());
    fireEvent.click(reset);
    expect(clip().warp).toEqual(W(1, { reverse: true }));
    expect(screen.queryByRole("button", { name: "Reset speed" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("panel"));
    reversed.unmount();
    renderRail(open([[edgeClip("a", "e1", {}, W(2)), 10]]));
    fireEvent.click(screen.getByRole("button", { name: "Reset speed" }));
    expect("warp" in clip()).toBe(false);
  });

  it("hands focus to the panel when an undo takes the focused preset away", () => {
    renderRail(open([[edgeClip("a", "e1"), 10]]));
    fireEvent.click(segment("Ramp", "Preset"));
    const thumb = within(group("Ramp presets")).getByRole("button", { name: "Ease in-out sine" });
    act(() => thumb.focus());
    act(() => editor().undo());
    expect(screen.queryByRole("group", { name: "Ramp presets" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("panel"));
  });

  it("hands a focused Speed control's focus to the panel when another clip is selected, and ends its run", () => {
    renderRail(open([[edgeClip("a", "e1"), 10], [edgeClip("b", "e2"), 5]]));
    const select = (clipId: string) => act(() => editor().select({ kind: "clip", clipId }));
    for (const control of [() => preset("2×"), slider, () => toggle("Reverse")]) {
      select("a");
      act(() => control().focus());
      select("b");
      expect(document.activeElement).toBe(screen.getByTestId("panel"));
    }
    select("a");
    act(() => well().focus());
    fireEvent.keyDown(well(), { key: "ArrowUp" });
    select("b");
    select("a");
    act(() => well().focus());
    fireEvent.keyDown(well(), { key: "ArrowUp" });
    expect(clip().warp?.speed).toBe(1.1);
    expect(steps()).toBe(2);
  });

  it("ends a bezier handle's run of arrow keys when another clip is selected", () => {
    const ramp = W(1, { curve: { kind: "bezier", handles: [0.4, 0.1, 0.6, 0.9] } });
    renderRail(open([[edgeClip("a", "e1", {}, ramp), 10], [edgeClip("b", "e2"), 5]]));
    const select = (clipId: string) => act(() => editor().select({ kind: "clip", clipId }));
    const handle = () => screen.getByLabelText("Adjust control point 1");
    act(() => handle().focus());
    fireEvent.keyDown(handle(), { key: "ArrowRight" });
    expect(steps()).toBe(1);
    select("b");
    select("a");
    act(() => handle().focus());
    fireEvent.keyDown(handle(), { key: "ArrowRight" });
    expect((clip().warp?.curve as { handles: number[] }).handles[0]).toBe(0.42);
    expect(steps()).toBe(2);
  });

  it("waits in a lined-up stack while a clip is still loading: Speed off, Ramp and Reverse on", () => {
    renderRail(open([[edgeClip("a", "e1"), 10], [edgeClip("b", "e2"), 5]], { stacked: true }));
    act(() => editor().setClipsLoading(new Set<SourceKey>(["edge:e2"])));
    expect(slider()).toBeDisabled();
    expect(slider().parentElement).toHaveAttribute("title", WAITING_FOR_CLIPS);
    expect(well()).toBeDisabled();
    expect(well().parentElement).toHaveAttribute("title", WAITING_FOR_CLIPS);
    for (const b of within(group("Speed presets")).getAllByRole("button")) {
      expect(b).toBeDisabled();
      expect(b).toHaveAttribute("title", WAITING_FOR_CLIPS);
    }
    expect(toggle("Reverse")).toBeEnabled();
    expect(segment("Ramp", "Preset")).toBeEnabled();
  });

  it("names the key that sets each field: on a reversed clip I sets its Out", () => {
    const hover = (name: string) =>
      screen.getByRole("textbox", { name }).closest("label")!.querySelector(":scope > [aria-hidden='true']")!;
    const forward = renderRail(open([[edgeClip("a", "e1"), 10]]));
    expect(hover("In")).toHaveTextContent("In at the playheadI");
    expect(hover("Out")).toHaveTextContent("Out at the playheadO");
    forward.unmount();
    renderRail(open([[edgeClip("a", "e1", {}, W(1, { reverse: true })), 10]]));
    expect(hover("In")).toHaveTextContent("In at the playheadO");
    expect(hover("Out")).toHaveTextContent("Out at the playheadI");
  });

  it("says a clip too fast to last a frame is left out", () => {
    renderRail(open([[edgeClip("a", "e1", { outSec: 1 }, W(100)), 10]]));
    expect(screen.getByText("The trim is shorter than a frame, so this clip is left out.")).toBeInTheDocument();
    expect(screen.queryByText(/on the timeline\./)).toBeNull();
  });
});

describe("EditorRail, several clips' speed", () => {
  const selectBoth = () => act(() => editor().select({ kind: "clip", clipId: "a", clipIds: ["a", "b"] }));

  it("sets Speed and Reverse on all of them, Mixed while they differ", () => {
    const media = open([[edgeClip("a", "e1"), 10], [edgeClip("b", "e2", {}, W(2)), 5]]);
    selectBoth();
    renderRail(media);
    expect(well().value).toBe("–");
    expect(screen.getByText("Mixed")).toBeInTheDocument();
    expect(pressedIn("Speed presets")).toEqual([]);
    commit("0.5");
    expect([clip("a").warp?.speed, clip("b").warp?.speed]).toEqual([0.5, 0.5]);
    expect(steps()).toBe(1);
    expect(well().value).toBe("0.5×");
    expect(pressedIn("Speed presets")).toEqual(["0.5×"]);
    fireEvent.click(preset("2×"));
    expect(pressedIn("Speed presets")).toEqual(["2×"]);

    act(() => editor().apply((d) => ({ ...d, timeline: d.timeline.map((c, i) => (i === 0 ? withWarp(c, normalizeWarp(W(2, { reverse: true }))) : c)) })));
    expect(screen.getAllByText("Mixed")).toHaveLength(1);
    expect(pressedIn("Reverse")).toEqual([]);
    const before = steps();
    fireEvent.click(segment("Reverse", "On"));
    expect([clip("a").warp?.reverse, clip("b").warp?.reverse]).toEqual([true, true]);
    expect(steps()).toBe(before + 1);
    fireEvent.click(screen.getByRole("button", { name: "Reset speed" }));
    expect([clip("a").warp, clip("b").warp]).toEqual([W(1, { reverse: true }), W(1, { reverse: true })]);
    // One clip's controls are not here
    expect(screen.queryByRole("slider", { name: "Clip speed" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Ramp" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Blend frames" })).toBeNull();
  });

  it("turns Speed off while a selected clip's length is unknown", () => {
    const media = open([[edgeClip("a", "e1"), 10], [edgeClip("b", "e2"), null]]);
    selectBoth();
    renderRail(media);
    expect(well()).toBeDisabled();
    for (const b of within(group("Speed presets")).getAllByRole("button")) expect(b).toBeDisabled();
    expect(segment("Reverse", "On")).toBeEnabled();
  });
});

describe("EditorRail and the clip menu, Reset trim", () => {
  it("is offered only where it would change a clip: not on a slow one past its 10 minutes, or of unknown length", () => {
    // a: 0.1× over 100 s of a 900 s source, 1000 s on the timeline already; u: slowed, its length not read yet
    const media = open([
      [edgeClip("a", "e1", { inSec: 10, outSec: 110 }, W(0.1)), 900],
      [edgeClip("u", "e9", { inSec: 1 }, W(0.5)), null],
      [edgeClip("b", "e2", { inSec: 1 }), 5],
    ]);
    render(
      <div data-stitch-editor="" tabIndex={-1}>
        <EditorRail media={media} audio={new Map()} frameSize={null} />
        <ClipContextMenu media={media} audio={new Map()} />
      </div>,
    );
    for (const [ids, offered] of [
      [["a"], false],
      [["u"], false],
      [["a", "u"], false],
      [["a", "u", "b"], true],
    ] as const) {
      act(() => editor().select({ kind: "clip", clipId: ids[0], ...(ids.length > 1 ? { clipIds: [...ids] } : {}) }));
      expect(screen.queryByRole("button", { name: "Reset trim" }) !== null).toBe(offered);
      act(() => editor().openMenu({ kind: "clip", clipId: ids[0], x: 10, y: 10 }));
      const item = within(screen.getByRole("menu")).getByRole("menuitem", { name: /^Reset trim/ });
      expect(item.hasAttribute("disabled")).toBe(!offered);
      act(() => editor().openMenu(null));
    }
  });
});
