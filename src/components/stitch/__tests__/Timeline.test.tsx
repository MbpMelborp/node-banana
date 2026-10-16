import { Profiler, type ProfilerOnRenderCallback } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useWorkflowStore } from "@/store/workflowStore";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import {
  __resetMediaInfoForTests,
  __setMediaExtractorForTests,
  __setMediaInfoForTests,
  mediaKeyOf,
  nearestFrame,
} from "@/lib/stitch/mediaInfo";
import { StitchEditorModal } from "../StitchEditorModal";
import { openStitchEditor } from "../openStitchEditor";
import { moveClipTo, setCrossfade } from "../editorActions";
import type { StitchTimelineClip, VideoStitchNodeData, WorkflowEdge, WorkflowNode } from "@/types";

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

// The timeline inside the real editor, against the real stores. jsdom lays
// nothing out (every rect is at 0), so lane x is the pointer's clientX.

const PPS = 64;
const ORIGIN = 16;
const wf = () => useWorkflowStore.getState();
const editor = () => useStitchEditorStore.getState();
const node = (id: string, type: string, data: Record<string, unknown>): WorkflowNode =>
  ({ id, type, data, position: { x: 0, y: 0 } }) as WorkflowNode;
const edge = (id: string, source: string, targetHandle: string): WorkflowEdge => ({
  id,
  source,
  target: "stitch",
  sourceHandle: "video",
  targetHandle,
});

function seed({ bRan = true, stitch = {} }: { bRan?: boolean; stitch?: Partial<VideoStitchNodeData> } = {}) {
  useWorkflowStore.setState({
    nodes: [
      node("gen-a", "generateVideo", {
        outputVideo: "blob:a",
        selectedModel: { provider: "kie", modelId: "veo", displayName: "Veo 3.1" },
      }),
      node("gen-b", "generateVideo", bRan ? { outputVideo: "blob:b" } : {}),
      node("stitch", "videoStitch", { clips: [], clipOrder: [], outputVideo: null, loopCount: 1, status: "idle", ...stitch }),
    ],
    edges: [edge("eA", "gen-a", "video-0"), edge("eB", "gen-b", "video-1")],
    openModalCount: 0,
    isModalOpen: false,
  });
  __setMediaInfoForTests(mediaKeyOf("blob:a"), { duration: 5, width: 1920, height: 1080, fps: 24 });
  __setMediaInfoForTests(mediaKeyOf("blob:b"), { duration: 4, width: 1920, height: 1080, fps: 24 });
}

function openEditor(onRender?: ProfilerOnRenderCallback) {
  render(
    onRender ? (
      <Profiler id="modal" onRender={onRender}>
        <StitchEditorModal />
      </Profiler>
    ) : (
      <StitchEditorModal />
    ),
  );
  act(() => {
    openStitchEditor("stitch");
    editor().setZoom(PPS);
  });
  return screen.getByRole("dialog", { name: "Edit stitch" });
}

const lane = () => screen.getByRole("listbox", { name: "Clips" });
const clipBox = (name: string) => within(lane()).getByRole("option", { name });
const rail = () => screen.getByRole("complementary", { name: "Clip" });
const press = (key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });
/** A key pressed where focus is (a focused field hears it first). */
const pressOnFocus = (key: string) =>
  act(() => {
    (document.activeElement ?? window).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
/** A clip's hover mute button or muted badge (pointer shortcuts, out of the accessibility tree). */
const soundButton = (name: string, label: string) => clipBox(name).querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const handleOf = (name: string, edge: "in" | "out") =>
  clipBox(name).querySelector<HTMLElement>(`[data-trim-handle="${edge}"]`)!;
const clipItem = (id: string, init: Partial<StitchTimelineClip> = {}): StitchTimelineClip => ({
  id: `clip:${id}`,
  source: { kind: "edge", edgeId: id },
  inSec: 0,
  outSec: null,
  muted: false,
  volume: 1,
  ...init,
});
const pointer = (type: "pointermove" | "pointerup", clientX: number, init: MouseEventInit = {}) =>
  act(() => {
    window.dispatchEvent(new MouseEvent(type, { clientX, bubbles: true, ...init }));
  });
/** A press and release on a clip's body, with no travel: a click. */
const click = (el: HTMLElement, clientX = 100) => {
  fireEvent.pointerDown(el, { button: 0, clientX, pointerId: 1 });
  pointer("pointerup", clientX);
};

beforeEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  wf().clearWorkflow();
  editor().close();
  __resetMediaInfoForTests();
  __setMediaExtractorForTests({ probe: () => new Promise(() => {}), open: () => new Promise(() => {}) });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
});

afterEach(() => {
  act(() => editor().close());
  __setMediaExtractorForTests(null);
  __resetMediaInfoForTests();
  vi.restoreAllMocks();
});

describe("Timeline", () => {
  it("lays the clips out with their names, sources and lengths", () => {
    seed();
    openEditor();
    const first = clipBox("Clip 1");
    expect(within(first).getByText("Clip 1")).toBeInTheDocument();
    expect(within(first).getByText("Veo 3.1")).toBeInTheDocument();
    expect(within(first).getByText("5.0 s")).toBeInTheDocument();
    expect(within(clipBox("Clip 2")).getByText("4.0 s")).toBeInTheDocument();
    // 5 s at 64 px/s from the origin, the next one after the 4px gap
    expect(first.style.left).toBe(`${ORIGIN}px`);
    expect(first.style.width).toBe(`${5 * PPS - 2}px`);
    expect(clipBox("Clip 2").style.left).toBe(`${ORIGIN + 5 * PPS + 2}px`);
    expect(screen.getByTestId("stitch-clip-count")).toHaveTextContent("2");
    // The ruler's labels (jsdom has no width, so only the overscan past the origin is drawn)
    expect(within(screen.getByTestId("stitch-ruler")).getByText("0:00")).toBeInTheDocument();
  });

  it("selects a clip on a click, and the rail shows it", () => {
    seed();
    openEditor();
    expect(within(rail()).getByText("1 / 2")).toBeInTheDocument();
    click(clipBox("Clip 2"), 400);
    expect(within(rail()).getByText("2 / 2")).toBeInTheDocument();
    expect(clipBox("Clip 2")).toHaveAttribute("aria-selected", "true");
    click(clipBox("Clip 1"), 100);
    expect(within(rail()).getByText("1 / 2")).toBeInTheDocument();
    // A click is no edit
    expect(editor().past).toHaveLength(0);
  });

  it("opens the clip menu on a right-click, and Remove from stitch removes the clip", () => {
    seed();
    openEditor();
    fireEvent.contextMenu(clipBox("Clip 2"), { clientX: 400, clientY: 500 });
    const menu = screen.getByRole("menu", { name: "Clip 2" });
    expect(within(rail()).getByText("2 / 2")).toBeInTheDocument();
    for (const name of ["Mute clip audio", "Split at playhead", "Reset trim", "Reveal source node", "Remove from stitch"]) {
      expect(within(menu).getByRole("menuitem", { name: new RegExp(name) })).toBeInTheDocument();
    }
    expect(within(menu).getByText("⌥M")).toBeInTheDocument();
    // Untrimmed: nothing to reset
    expect(within(menu).getByRole("menuitem", { name: /Reset trim/ })).toBeDisabled();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Remove from stitch/ }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(editor().draft?.timeline.map((c) => c.id)).toEqual(["clip:eA"]);
    expect(within(lane()).queryByRole("option", { name: "Clip 2" })).toBeNull();
  });

  it("mutes a clip from its menu, and Escape closes the menu without leaving the editor", () => {
    seed();
    openEditor();
    fireEvent.contextMenu(clipBox("Clip 1"), { clientX: 100, clientY: 500 });
    fireEvent.click(screen.getByRole("menuitem", { name: /Mute clip audio/ }));
    expect(editor().draft?.timeline[0].muted).toBe(true);
    expect(within(clipBox("Clip 1")).getByTitle("Clip audio muted")).toBeInTheDocument();
    fireEvent.contextMenu(clipBox("Clip 1"), { clientX: 100, clientY: 500 });
    expect(screen.getByRole("menuitem", { name: /Unmute clip audio/ })).toBeInTheDocument();
    press("Escape");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(editor().isOpen).toBe(true);
    expect(editor().discardOpen).toBe(false);
  });

  it("splits the clip under the playhead with S into two pieces of the same source", () => {
    seed();
    openEditor();
    act(() => editor().setPlayhead(2.5));
    press("s");
    const timeline = editor().draft!.timeline;
    expect(timeline).toHaveLength(3);
    expect(timeline[0].source).toEqual({ kind: "edge", edgeId: "eA" });
    expect(timeline[1].source).toEqual({ kind: "edge", edgeId: "eA" });
    expect(within(clipBox("Clip 1")).getByText("2.5 s")).toBeInTheDocument();
    expect(within(clipBox("Clip 2")).getByText("2.5 s")).toBeInTheDocument();
    expect(within(clipBox("Clip 3")).getByText("4.0 s")).toBeInTheDocument();
  });

  it("trims an Out by its handle in one undo step, showing the frame under the handle", () => {
    seed();
    openEditor();
    act(() => editor().setPlayhead(0));
    const handle = clipBox("Clip 1").querySelector<HTMLElement>('[data-trim-handle="out"]')!;
    const edgeX = ORIGIN + 5 * PPS;
    fireEvent.pointerDown(handle, { button: 0, clientX: edgeX, pointerId: 1 });
    pointer("pointermove", edgeX - 51);

    // While dragging: the frame popover seeks its own <video> to the edge's source time, and the chip shows the change
    const popover = screen.getByTestId("stitch-trim-popover");
    const video = within(popover).getByTestId<HTMLVideoElement>("stitch-edge-frame");
    expect(video.currentTime).toBeCloseTo(5 - 51 / PPS, 3);
    expect(within(popover).getByText("Out")).toBeInTheDocument();
    expect(within(popover).getByText("0:04.20")).toBeInTheDocument();
    expect(screen.getByTestId("stitch-trim-delta")).toHaveTextContent("−0.80 s");
    expect(screen.getByTestId("stitch-trim-ghost")).toBeInTheDocument();
    expect(within(clipBox("Clip 1")).getByText("4.20 s")).toBeInTheDocument();
    // Nothing is applied until release, and the next clip holds its place behind the ghost
    expect(editor().past).toHaveLength(0);
    expect(editor().draft?.timeline[0].outSec).toBeNull();
    expect(clipBox("Clip 2").style.left).toBe(`${ORIGIN + 5 * PPS + 2}px`);

    pointer("pointerup", edgeX - 51);
    expect(editor().past).toHaveLength(1);
    expect(editor().draft?.timeline[0].outSec).toBeCloseTo(5 - 51 / PPS, 3);
    // It closes up on release
    expect(clipBox("Clip 2").style.left).toBe(`${ORIGIN + (5 - 51 / PPS) * PPS + 2}px`);
    expect(screen.queryByTestId("stitch-trim-popover")).toBeNull();
    const out = within(rail()).getByRole("textbox", { name: "Out" }) as HTMLInputElement;
    expect(out.value).toBe("0:04.20");
    // The workflow store is untouched until Done
    const data = wf().nodes.find((n) => n.id === "stitch")!.data as VideoStitchNodeData;
    expect(data.timeline).toBeUndefined();
  });

  it("snaps a dragged edge to the playhead, and Shift trims without snapping", () => {
    seed();
    openEditor();
    act(() => editor().setPlayhead(4.2));
    const handle = clipBox("Clip 1").querySelector<HTMLElement>('[data-trim-handle="out"]')!;
    const edgeX = ORIGIN + 5 * PPS;
    fireEvent.pointerDown(handle, { button: 0, clientX: edgeX, pointerId: 1 });
    pointer("pointermove", edgeX - 0.8 * PPS + 4);
    expect(screen.getByTestId("stitch-snap-chip")).toHaveTextContent("Snapped to the playhead");
    // The dashed guide stands in for the playhead's line, which would hide it
    expect(screen.queryByTestId("stitch-playhead-line")).toBeNull();
    pointer("pointermove", edgeX - 0.8 * PPS + 4, { shiftKey: true });
    expect(screen.queryByTestId("stitch-snap-chip")).toBeNull();
    expect(screen.getByTestId("stitch-playhead-line")).toBeInTheDocument();
    pointer("pointermove", edgeX - 0.8 * PPS + 4);
    pointer("pointerup", edgeX - 0.8 * PPS + 4);
    expect(editor().draft?.timeline[0].outSec).toBeCloseTo(4.2, 6);
  });

  it("cancels a trim on Escape, leaving the draft and the editor as they were", () => {
    seed();
    openEditor();
    const handle = clipBox("Clip 1").querySelector<HTMLElement>('[data-trim-handle="out"]')!;
    fireEvent.pointerDown(handle, { button: 0, clientX: 336, pointerId: 1 });
    pointer("pointermove", 250);
    press("Escape");
    expect(screen.queryByTestId("stitch-trim-popover")).toBeNull();
    pointer("pointerup", 250);
    expect(editor().past).toHaveLength(0);
    expect(editor().isOpen).toBe(true);
    expect(editor().discardOpen).toBe(false);
  });

  it("seeks the popover to the edge's source time, not its sequence time", () => {
    seed();
    openEditor();
    act(() => editor().setPlayhead(0));
    // Clip 2 runs 5–9 in the sequence and 0–4 in its source
    const edgeX = ORIGIN + 9 * PPS;
    fireEvent.pointerDown(handleOf("Clip 2", "out"), { button: 0, clientX: edgeX, pointerId: 1 });
    pointer("pointermove", edgeX - 51);
    const popover = screen.getByTestId("stitch-trim-popover");
    expect(within(popover).getByTestId<HTMLVideoElement>("stitch-edge-frame").currentTime).toBeCloseTo(4 - 51 / PPS, 3);
    expect(within(popover).getByText("0:03.20")).toBeInTheDocument();
    pointer("pointerup", edgeX - 51);
    expect(editor().draft?.timeline[1].outSec).toBeCloseTo(4 - 51 / PPS, 3);
  });

  it("commits an In drag, and the clips after it close up", () => {
    seed();
    openEditor();
    act(() => editor().setPlayhead(9));
    fireEvent.pointerDown(handleOf("Clip 1", "in"), { button: 0, clientX: ORIGIN, pointerId: 1 });
    pointer("pointermove", ORIGIN + 32);
    expect(screen.getByTestId("stitch-trim-ghost")).toBeInTheDocument();
    pointer("pointerup", ORIGIN + 32);
    expect(editor().draft?.timeline[0].inSec).toBeCloseTo(0.5, 6);
    expect(editor().past).toHaveLength(1);
    expect((within(rail()).getByRole("textbox", { name: "In" }) as HTMLInputElement).value).toBe("0:00.50");
    expect(clipBox("Clip 2").style.left).toBe(`${ORIGIN + 4.5 * PPS + 2}px`);
  });

  it("pushes the clips after a lengthening edge live, with no ghost and no jump on release", () => {
    // Clip 1: In 1, Out 3 of its 5 s source (2 s); Clip 2 starts at 2 s
    seed({ stitch: { timeline: [clipItem("eA", { inSec: 1, outSec: 3 }), clipItem("eB")], clipOrder: ["eA", "eB"] } });
    openEditor();
    act(() => editor().setPlayhead(9));
    const outX = ORIGIN + 2 * PPS;
    fireEvent.pointerDown(handleOf("Clip 1", "out"), { button: 0, clientX: outX, pointerId: 1 });
    pointer("pointermove", outX + PPS);
    expect(screen.queryByTestId("stitch-trim-ghost")).toBeNull();
    expect(clipBox("Clip 2").style.left).toBe(`${ORIGIN + 3 * PPS + 2}px`);
    pointer("pointerup", outX + PPS);
    expect(editor().draft?.timeline[0].outSec).toBeCloseTo(4, 6);
    expect(clipBox("Clip 2").style.left).toBe(`${ORIGIN + 3 * PPS + 2}px`);

    // A lengthening In keeps the clip's left (its start does not move) and pushes the rest
    fireEvent.pointerDown(handleOf("Clip 1", "in"), { button: 0, clientX: ORIGIN, pointerId: 1 });
    pointer("pointermove", ORIGIN - 32);
    expect(clipBox("Clip 1").style.left).toBe(`${ORIGIN}px`);
    expect(clipBox("Clip 2").style.left).toBe(`${ORIGIN + 3.5 * PPS + 2}px`);
    expect(screen.queryByTestId("stitch-trim-ghost")).toBeNull();
    pointer("pointerup", ORIGIN - 32);
    expect(editor().draft?.timeline[0].inSec).toBeCloseTo(0.5, 6);
    expect(clipBox("Clip 1").style.left).toBe(`${ORIGIN}px`);
    expect(clipBox("Clip 2").style.left).toBe(`${ORIGIN + 3.5 * PPS + 2}px`);
  });

  it("moves the add slot with a lengthening Out on the last clip, and leaves it after the ghost of a shortening one", () => {
    seed();
    openEditor();
    act(() => editor().setPlayhead(0));
    const slot = () => screen.getByTestId("stitch-add-slot");
    // Clip 2 runs 5–9 s of the sequence and ends its 4 s source
    const restEnd = ORIGIN + 9 * PPS;
    expect(slot().style.left).toBe(`${restEnd + 8}px`);
    fireEvent.pointerDown(handleOf("Clip 2", "out"), { button: 0, clientX: restEnd, pointerId: 1 });
    pointer("pointermove", restEnd - PPS);
    expect(screen.getByTestId("stitch-trim-ghost")).toBeInTheDocument();
    expect(slot().style.left).toBe(`${restEnd + 8}px`);
    pointer("pointerup", restEnd - PPS);
    expect(editor().draft?.timeline[1].outSec).toBeCloseTo(3, 6);
    expect(slot().style.left).toBe(`${restEnd - PPS + 8}px`);
    // Lengthening it back pushes the slot along
    fireEvent.pointerDown(handleOf("Clip 2", "out"), { button: 0, clientX: restEnd - PPS, pointerId: 1 });
    pointer("pointermove", restEnd - PPS / 2);
    expect(slot().style.left).toBe(`${restEnd - PPS / 2 + 8}px`);
    pointer("pointerup", restEnd - PPS / 2);
  });

  it("changes nothing when a handle is pressed and released without moving", () => {
    // Clip 2 has a numeric Out: rebuilding it from the sequence would add float noise
    seed({ stitch: { timeline: [clipItem("eA"), clipItem("eB", { outSec: 1.3 })], clipOrder: ["eA", "eB"] } });
    openEditor();
    const outX = ORIGIN + 6.3 * PPS;
    fireEvent.pointerDown(handleOf("Clip 2", "out"), { button: 0, clientX: outX, pointerId: 1 });
    pointer("pointerup", outX);
    expect(editor().draft?.timeline[1].outSec).toBe(1.3);
    // An outer edge near the playhead (0.08 s, within 8px) does not snap to it on a press
    act(() => editor().setPlayhead(0.08));
    fireEvent.pointerDown(handleOf("Clip 1", "in"), { button: 0, clientX: ORIGIN, pointerId: 1 });
    expect(screen.queryByTestId("stitch-snap-chip")).toBeNull();
    pointer("pointerup", ORIGIN);
    expect(editor().draft?.timeline[0].inSec).toBe(0);
    expect(editor().past).toHaveLength(0);
    expect(editor().cancelGesture).toBeNull();
  });

  it("holds the editor's keys while a trim runs, so the release applies to the draft it measured", () => {
    seed();
    openEditor();
    act(() => editor().setPlayhead(2));
    const edgeX = ORIGIN + 5 * PPS;
    fireEvent.pointerDown(handleOf("Clip 1", "out"), { button: 0, clientX: edgeX, pointerId: 1 });
    pointer("pointermove", edgeX - 51);
    press("s");
    press("Backspace");
    press("z", { metaKey: true });
    expect(editor().draft?.timeline.map((c) => c.id)).toEqual(["clip:eA", "clip:eB"]);
    pointer("pointerup", edgeX - 51);
    expect(editor().draft?.timeline).toHaveLength(2);
    expect(editor().draft?.timeline[0].outSec).toBeCloseTo(5 - 51 / PPS, 3);
    expect(editor().past).toHaveLength(1);
    // Afterwards they work again
    press("s");
    expect(editor().draft?.timeline).toHaveLength(3);
  });

  it("opens no clip menu while a trim runs, so Escape still cancels it", () => {
    seed();
    openEditor();
    const edgeX = ORIGIN + 5 * PPS;
    fireEvent.pointerDown(handleOf("Clip 1", "out"), { button: 0, clientX: edgeX, pointerId: 1 });
    pointer("pointermove", edgeX - 40);
    fireEvent.contextMenu(clipBox("Clip 1"), { button: 2, clientX: edgeX - 40, clientY: 300 });
    expect(editor().menu).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
    press("Escape");
    expect(editor().cancelGesture).toBeNull();
    pointer("pointerup", edgeX - 40);
    expect(editor().draft?.timeline[0].outSec).toBeNull();
    expect(editor().past).toHaveLength(0);
  });

  it("drops a trim whose draft changed under it", () => {
    seed();
    openEditor();
    const edgeX = ORIGIN + 5 * PPS;
    fireEvent.pointerDown(handleOf("Clip 1", "out"), { button: 0, clientX: edgeX, pointerId: 1 });
    pointer("pointermove", edgeX - 51);
    act(() => editor().apply((d) => ({ ...d, timeline: d.timeline.slice(1) })));
    pointer("pointerup", edgeX - 51);
    expect(editor().draft?.timeline.map((c) => c.id)).toEqual(["clip:eB"]);
    expect(editor().past).toHaveLength(1);
  });

  it("lets a focused In/Out field go when a handle is pressed, so Escape cancels the drag", () => {
    seed();
    openEditor();
    const dialog = screen.getByRole("dialog", { name: "Edit stitch" });
    const out = within(rail()).getByRole("textbox", { name: "Out" });
    act(() => out.focus());
    expect(document.activeElement).toBe(out);
    const edgeX = ORIGIN + 5 * PPS;
    fireEvent.pointerDown(handleOf("Clip 1", "out"), { button: 0, clientX: edgeX, pointerId: 1 });
    expect(document.activeElement).toBe(dialog);
    pointer("pointermove", edgeX - 51);
    pressOnFocus("Escape");
    expect(screen.queryByTestId("stitch-trim-popover")).toBeNull();
    pointer("pointerup", edgeX - 51);
    expect(editor().past).toHaveLength(0);
    expect(editor().discardOpen).toBe(false);

    // The ruler too: I then reaches the editor, not the field
    act(() => out.focus());
    fireEvent.pointerDown(screen.getByTestId("stitch-ruler"), { button: 0, clientX: ORIGIN + 1 * PPS, pointerId: 1 });
    expect(document.activeElement).toBe(dialog);
  });

  it("cancels a reorder on Escape: the clip stays, the editor stays open", () => {
    seed();
    openEditor();
    fireEvent.pointerDown(clipBox("Clip 2"), { button: 0, clientX: 450, pointerId: 1 });
    pointer("pointermove", 100);
    expect(screen.getByTestId("stitch-insertion-bar")).toBeInTheDocument();
    press("Escape");
    expect(screen.queryByTestId("stitch-insertion-bar")).toBeNull();
    expect(editor().isOpen).toBe(true);
    expect(editor().discardOpen).toBe(false);
    pointer("pointerup", 100);
    expect(editor().draft?.timeline.map((c) => c.id)).toEqual(["clip:eA", "clip:eB"]);
    expect(editor().past).toHaveLength(0);
  });

  it("closes the clip menu on any press outside it, and an item acts on the menu's own clip", () => {
    seed();
    openEditor();
    const dialog = screen.getByRole("dialog", { name: "Edit stitch" });
    fireEvent.contextMenu(clipBox("Clip 2"), { clientX: 400, clientY: 500 });
    expect(screen.getByRole("menu", { name: "Clip 2" })).toBeInTheDocument();
    // A handle press cancels its pointerdown (no mousedown follows): the menu still closes
    const handle = handleOf("Clip 1", "out");
    expect(fireEvent.pointerDown(handle, { button: 0, clientX: 336, pointerId: 1 })).toBe(false);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(dialog);
    pointer("pointerup", 336);

    fireEvent.contextMenu(clipBox("Clip 2"), { clientX: 400, clientY: 500 });
    act(() => editor().select({ kind: "clip", clipId: "clip:eA" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Remove from stitch/ }));
    expect(editor().draft?.timeline.map((c) => c.id)).toEqual(["clip:eA"]);
  });

  it("returns focus to the panel when the menu closes on Escape", () => {
    seed();
    openEditor();
    const dialog = screen.getByRole("dialog", { name: "Edit stitch" });
    fireEvent.contextMenu(clipBox("Clip 1"), { clientX: 100, clientY: 500 });
    expect(document.activeElement).toHaveAttribute("role", "menuitem");
    press("Escape");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(dialog);
  });

  it("moves the selection with the arrows and opens the clip menu from the keyboard", () => {
    seed();
    openEditor();
    const first = clipBox("Clip 1");
    // The selected clip is the lane's one tab stop
    expect(first).toHaveAttribute("tabindex", "0");
    expect(clipBox("Clip 2")).toHaveAttribute("tabindex", "-1");
    act(() => first.focus());
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(within(rail()).getByText("2 / 2")).toBeInTheDocument();
    expect(document.activeElement).toBe(clipBox("Clip 2"));
    expect(clipBox("Clip 2")).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(clipBox("Clip 2"), { key: "Home" });
    expect(within(rail()).getByText("1 / 2")).toBeInTheDocument();
    fireEvent.keyDown(clipBox("Clip 1"), { key: "End" });
    fireEvent.keyDown(clipBox("Clip 2"), { key: "F10", shiftKey: true });
    expect(screen.getByRole("menu", { name: "Clip 2" })).toBeInTheDocument();
  });

  it("shows in each filmstrip cell the frame at its own source time, sliding with the In", () => {
    seed();
    const frames = Array.from({ length: 12 }, (_, i) => `data:image/png;base64,frame${i}`);
    __setMediaInfoForTests(mediaKeyOf("blob:a"), { duration: 5, frames });
    openEditor();
    const info = { frames, duration: 5 };
    const cells = () => Array.from(clipBox("Clip 1").querySelectorAll("img")).map((img) => img.getAttribute("src"));
    // jsdom has no width: the overscan draws cells 0–2
    expect(cells()).toEqual([0, 1, 2].map((k) => nearestFrame(info, (k * 56 + 28) / PPS)));
    act(() => editor().apply((d) => ({ ...d, timeline: d.timeline.map((c, i) => (i === 0 ? { ...c, inSec: 1 } : c)) })));
    expect(cells()[0]).toBe(nearestFrame(info, 1 + 28 / PPS));
    expect(cells()[0]).not.toBe(nearestFrame(info, 28 / PPS));
  });

  it("keeps a very short clip pressable at a low zoom", () => {
    seed({ stitch: { timeline: [clipItem("eA"), clipItem("eB", { inSec: 1, outSec: 1.1 })], clipOrder: ["eA", "eB"] } });
    openEditor();
    act(() => editor().setZoom(30));
    expect(clipBox("Clip 2").style.width).toBe("4px");
  });

  it("does not leave a zoom the limits held to scroll the lanes back later", () => {
    seed();
    openEditor();
    act(() => editor().setZoom(480));
    const lanes = screen.getByTestId("stitch-lanes");
    // Already at the most: a ⌘ wheel in changes nothing
    fireEvent.wheel(lanes, { ctrlKey: true, deltaY: -100, clientX: 400 });
    expect(editor().pxPerSec).toBe(480);
    lanes.scrollLeft = 2000;
    // An edit rebuilds the axis
    fireEvent.click(soundButton("Clip 2", "Mute clip audio"));
    expect(lanes.scrollLeft).toBe(2000);
  });

  it("keeps the pointer's place inside an empty slot across a ⌘ wheel zoom", () => {
    seed({ bRan: false });
    openEditor();
    const lanes = screen.getByTestId("stitch-lanes");
    Object.defineProperty(lanes, "clientWidth", { value: 600, configurable: true });
    // Clip 2 has not run: a slot at 5 s, its left at x 336; the pointer 120px into it
    const slotLeft = ORIGIN + 5 * PPS;
    fireEvent.wheel(lanes, { ctrlKey: true, deltaY: -100, clientX: slotLeft + 120 });
    const pps = editor().pxPerSec!;
    expect(pps).toBeGreaterThan(PPS);
    // The slot does not slide under the pointer: its left is still at view x 336
    expect(ORIGIN + 5 * pps - lanes.scrollLeft).toBeCloseTo(slotLeft, 6);
  });

  it("does not zoom with the ⌘ wheel while a drag runs", () => {
    seed();
    openEditor();
    const edgeX = ORIGIN + 5 * PPS;
    fireEvent.pointerDown(handleOf("Clip 1", "out"), { button: 0, clientX: edgeX, pointerId: 1 });
    fireEvent.wheel(screen.getByTestId("stitch-lanes"), { ctrlKey: true, deltaY: -100, clientX: 400 });
    expect(editor().pxPerSec).toBe(PPS);
    pointer("pointerup", edgeX);
  });

  it("drags a clip to a new place, dimming the others to their frames, in one undo step", () => {
    seed();
    openEditor();
    const second = clipBox("Clip 2");
    fireEvent.pointerDown(second, { button: 0, clientX: 450, pointerId: 1 });
    pointer("pointermove", 100);
    // The others show their frames only; the lifted one keeps its name
    expect(within(clipBox("Clip 1")).queryByText("Clip 1")).toBeNull();
    expect(within(clipBox("Clip 1")).queryByText("5.0 s")).toBeNull();
    expect(within(clipBox("Clip 2")).getByText("Clip 2")).toBeInTheDocument();
    expect(screen.getByTestId("stitch-insertion-bar")).toBeInTheDocument();
    pointer("pointerup", 100);
    expect(editor().draft?.timeline.map((c) => c.id)).toEqual(["clip:eB", "clip:eA"]);
    expect(editor().past).toHaveLength(1);
    expect(screen.queryByTestId("stitch-insertion-bar")).toBeNull();
    // The moved clip is now Clip 1, and selected
    expect(within(rail()).getByText("1 / 2")).toBeInTheDocument();
    expect(within(clipBox("Clip 1")).getByText("4.0 s")).toBeInTheDocument();
  });

  it("mutes a clip from its hover button and unmutes it from its badge", () => {
    seed();
    openEditor();
    // Pointer shortcuts (⌥M and the menu are the keyboard's way): out of the accessibility tree, taking no focus
    const mute = soundButton("Clip 2", "Mute clip audio");
    expect(mute).toHaveAttribute("aria-hidden", "true");
    expect(mute).toHaveAttribute("tabindex", "-1");
    expect(fireEvent.mouseDown(mute)).toBe(false);
    fireEvent.click(mute);
    expect(editor().draft?.timeline[1].muted).toBe(true);
    fireEvent.click(soundButton("Clip 2", "Unmute clip audio"));
    expect(editor().draft?.timeline[1].muted).toBe(false);
    expect(editor().past).toHaveLength(2);
  });

  it("keeps a slot for a source that has not run yet", () => {
    seed({ bRan: false });
    openEditor();
    const slot = clipBox("Clip 2");
    expect(slot).toHaveTextContent("Clip 2 · not generated yet");
    expect(slot.style.width).toBe("158px");
  });

  it("says when a trim starts past the end of its source, and the slot can be selected and reset", () => {
    const timeline: StitchTimelineClip[] = [
      { id: "clip:eA", source: { kind: "edge", edgeId: "eA" }, inSec: 6, outSec: null, muted: false, volume: 1 },
      { id: "clip:eB", source: { kind: "edge", edgeId: "eB" }, inSec: 0, outSec: null, muted: false, volume: 1 },
    ];
    seed({ stitch: { timeline, clipOrder: ["eA", "eB"] } });
    openEditor();
    expect(clipBox("Clip 1")).toHaveTextContent("Clip 1 · trim starts past the end");
    click(clipBox("Clip 2"), 300);
    click(clipBox("Clip 1"), 50);
    fireEvent.click(within(rail()).getByRole("button", { name: /Reset trim/ }));
    expect(within(clipBox("Clip 1")).getByText("5.0 s")).toBeInTheDocument();
  });

  it("gives a trim under one frame no time, as the encode leaves it out, and says why", () => {
    const timeline: StitchTimelineClip[] = [
      { id: "clip:eA", source: { kind: "edge", edgeId: "eA" }, inSec: 4.99, outSec: null, muted: false, volume: 1 },
      { id: "clip:eB", source: { kind: "edge", edgeId: "eB" }, inSec: 0, outSec: null, muted: false, volume: 1 },
    ];
    seed({ stitch: { timeline, clipOrder: ["eA", "eB"] } });
    openEditor();
    expect(clipBox("Clip 1")).toHaveTextContent("Clip 1 · trim is shorter than a frame");
  });

  it("shows a dashed placeholder and unlabelled ticks when there are no clips", () => {
    useWorkflowStore.setState({
      nodes: [node("stitch", "videoStitch", { clips: [], clipOrder: [], outputVideo: null, loopCount: 1, status: "idle" })],
      edges: [],
    });
    openEditor();
    expect(screen.getByTestId("stitch-empty-lane")).toBeInTheDocument();
    expect(within(screen.getByTestId("stitch-ruler")).queryByText("0:00")).toBeNull();
    expect(screen.queryByTestId("stitch-playhead-line")).toBeNull();
  });

  it("moves the playhead from the ruler, and pauses", () => {
    seed();
    openEditor();
    act(() => editor().setPlaying(true));
    fireEvent.pointerDown(screen.getByTestId("stitch-ruler"), { button: 0, clientX: ORIGIN + 2 * PPS, pointerId: 1 });
    expect(editor().playing).toBe(false);
    expect(editor().playhead).toBeCloseTo(2);
    fireEvent.pointerMove(screen.getByTestId("stitch-ruler"), { clientX: ORIGIN + 3 * PPS, pointerId: 1 });
    expect(editor().playhead).toBeCloseTo(3);
    // Clamped to the sequence
    fireEvent.pointerMove(screen.getByTestId("stitch-ruler"), { clientX: 5000, pointerId: 1 });
    expect(editor().playhead).toBeCloseTo(9);
  });

  it("snaps and zooms to the playhead where it is drawn, not past a sequence that got shorter", () => {
    seed();
    openEditor();
    const lanes = screen.getByTestId("stitch-lanes");
    Object.defineProperty(lanes, "clientWidth", { value: 600, configurable: true });
    // At the end (9 s), then Clip 2 loses a second: the playhead is stored at 9 and drawn at 8
    act(() => editor().setPlayhead(9));
    act(() => editor().apply((d) => ({ ...d, timeline: d.timeline.map((c, i) => (i === 1 ? { ...c, outSec: 3 } : c)) })));
    const edgeX = ORIGIN + 8 * PPS;
    fireEvent.pointerDown(handleOf("Clip 2", "out"), { button: 0, clientX: edgeX, pointerId: 1 });
    // One second out is where the stored playhead is, and nothing is drawn there: no snap
    pointer("pointermove", edgeX + PPS);
    expect(screen.queryByTestId("stitch-snap-chip")).toBeNull();
    // Near the drawn playhead, it snaps
    pointer("pointermove", edgeX + 4);
    expect(screen.getByTestId("stitch-snap-chip")).toHaveTextContent("Snapped to the playhead");
    press("Escape");
    pointer("pointerup", edgeX + 4);

    // Zoom in keeps the drawn playhead (8 s, at view x 528) in place
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(lanes.scrollLeft).toBeCloseTo(ORIGIN + 8 * PPS * 1.5 - (ORIGIN + 8 * PPS), 6);
  });

  it("draws the ticks for a scroll the zoom makes in the same render", () => {
    seed();
    openEditor();
    const lanes = screen.getByTestId("stitch-lanes");
    Object.defineProperty(lanes, "clientWidth", { value: 600, configurable: true });
    act(() => editor().setPlayhead(8));
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    const scrolled = lanes.scrollLeft;
    expect(scrolled).toBeGreaterThan(200);
    // jsdom fires no scroll event: the ticks follow because the zoom published its own scroll
    const lefts = Array.from(screen.getByTestId("stitch-ruler").querySelectorAll<HTMLElement>("span")).map((el) =>
      parseFloat(el.style.left),
    );
    expect(Math.max(...lefts)).toBeGreaterThan(scrolled);
  });

  it("puts the playhead where release leaves it while a trim pushes a slot along", () => {
    // Clip 1 (0–3), Clip 2 not run yet (a slot at 3 s), Clip 3 (another piece of Clip 1's source, 3–7)
    seed({
      bRan: false,
      stitch: {
        timeline: [clipItem("eA", { outSec: 3 }), clipItem("eB"), clipItem("eA", { id: "clip:c", inSec: 1 })],
        clipOrder: ["eA", "eB"],
      },
    });
    openEditor();
    act(() => editor().setPlayhead(4.5));
    const line = () => screen.getByTestId("stitch-playhead-line");
    // After the slot
    expect(line().style.left).toBe(`${ORIGIN + 4.5 * PPS + 160}px`);
    const edgeX = ORIGIN + 3 * PPS;
    fireEvent.pointerDown(handleOf("Clip 1", "out"), { button: 0, clientX: edgeX, pointerId: 1 });
    // Lengthened to 4.5 s, the edge meets the playhead and snaps: the slot moves on with Clip 3
    pointer("pointermove", edgeX + 1.5 * PPS);
    expect(screen.getByTestId("stitch-snap-chip")).toHaveTextContent("Snapped to the playhead");
    // Without the snap, the line is drawn on the edge too: release would leave the playhead there
    pointer("pointermove", edgeX + 1.5 * PPS, { shiftKey: true });
    expect(line().style.left).toBe(`${ORIGIN + 4.5 * PPS}px`);
    press("Escape");
    pointer("pointerup", edgeX + 1.5 * PPS);
    expect(line().style.left).toBe(`${ORIGIN + 4.5 * PPS + 160}px`);
  });

  it("measures a trim with the Fit zoom that the field's commit leads to", () => {
    vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(1258);
    seed();
    render(<StitchEditorModal />);
    act(() => openStitchEditor("stitch"));
    // Fit: (1258 − 16 − 76) / 9 s
    const fitBefore = (1258 - 16 - 76) / 9;
    const fitAfter = (1258 - 16 - 76) / 7;
    const out = within(rail()).getByRole("textbox", { name: "Out" }) as HTMLInputElement;
    act(() => out.focus());
    fireEvent.change(out, { target: { value: "0:03.00" } });
    // The press commits Clip 1's Out (the sequence is now 7 s), then measures
    const edgeX = ORIGIN + 9 * fitBefore;
    fireEvent.pointerDown(handleOf("Clip 2", "out"), { button: 0, clientX: edgeX, pointerId: 1 });
    expect(editor().draft?.timeline[0].outSec).toBeCloseTo(3, 6);
    pointer("pointermove", edgeX - 100);
    expect(screen.getByTestId("stitch-trim-delta")).toHaveTextContent(`−${(100 / fitAfter).toFixed(2)} s`);
    pointer("pointerup", edgeX - 100);
    expect(editor().draft?.timeline[1].outSec).toBeCloseTo(4 - 100 / fitAfter, 3);
  });

  it("keeps the clip under the pointer when the lanes scroll during a reorder", () => {
    seed();
    openEditor();
    const lanes = screen.getByTestId("stitch-lanes");
    const content = lanes.firstElementChild as HTMLElement;
    fireEvent.pointerDown(clipBox("Clip 2"), { button: 0, clientX: 450, pointerId: 1 });
    pointer("pointermove", 300);
    const restX = ORIGIN + 5 * PPS + 2;
    expect(clipBox("Clip 2").style.left).toBe(`${restX - 150}px`);
    // A wheel scrolls the lanes 100px under the still pointer
    vi.spyOn(content, "getBoundingClientRect").mockReturnValue({ left: -100, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: -100, y: 0, toJSON: () => ({}) });
    act(() => {
      lanes.scrollLeft = 100;
      lanes.dispatchEvent(new Event("scroll"));
    });
    expect(clipBox("Clip 2").style.left).toBe(`${restX - 50}px`);
    press("Escape");
    pointer("pointerup", 300);
  });

  it("leaves a narrow clip a body to press: its handles shrink to a third each", () => {
    seed({ stitch: { timeline: [clipItem("eA"), clipItem("eB", { inSec: 1, outSec: 1.25 })], clipOrder: ["eA", "eB"] } });
    openEditor();
    expect(handleOf("Clip 1", "out").style.width).toBe("10px");
    // 0.25 s at 64 px/s, less the 2px join inset: 14px wide
    expect(clipBox("Clip 2").style.width).toBe("14px");
    expect(parseFloat(handleOf("Clip 2", "in").style.width)).toBeCloseTo(14 / 3, 6);
    expect(parseFloat(handleOf("Clip 2", "out").style.width)).toBeCloseTo(14 / 3, 6);
  });

  it("keeps focus in the lane when the focused clip is removed, and on the panel when none is left", () => {
    seed();
    const dialog = openEditor();
    act(() => editor().select({ kind: "clip", clipId: "clip:eB" }));
    act(() => clipBox("Clip 2").focus());
    press("Backspace");
    expect(editor().draft?.timeline.map((c) => c.id)).toEqual(["clip:eA"]);
    expect(document.activeElement).toBe(clipBox("Clip 1"));
    // An undo brings Clip 2 back; a redo takes it away again (focus stays on Clip 1)
    press("z", { metaKey: true });
    press("z", { metaKey: true, shiftKey: true });
    expect(document.activeElement).toBe(clipBox("Clip 1"));
    // The add slot after the clip is the panel's last tab stop (the clips' mute buttons are out of the tab
    // order): Tab from it wraps inside the dialog
    const addSlot = screen.getByTestId("stitch-add-slot");
    act(() => addSlot.focus());
    fireEvent.keyDown(addSlot, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(addSlot);
    act(() => clipBox("Clip 1").focus());
    press("Backspace");
    expect(editor().draft?.timeline).toHaveLength(0);
    expect(document.activeElement).toBe(dialog);
  });

  it("keeps focus in the lane when an undo brings clips back under the focused placeholder", () => {
    seed();
    const dialog = openEditor();
    act(() => {
      editor().apply((d) => ({ ...d, timeline: [] }));
      editor().select(null);
    });
    const placeholder = screen.getByTestId("stitch-empty-lane");
    act(() => placeholder.focus());
    // The clips come back with nothing selected: the rail's own focus rescue does not run
    press("z", { metaKey: true });
    expect(editor().draft?.timeline).toHaveLength(2);
    expect(editor().selection).toBeNull();
    expect(placeholder.isConnected).toBe(false);
    expect(document.activeElement).toBe(clipBox("Clip 1"));
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("zooms with the transport's buttons and Fit", () => {
    seed();
    openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(editor().pxPerSec).toBeCloseTo(PPS * 1.5);
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(editor().pxPerSec).toBeCloseTo(PPS);
    fireEvent.click(screen.getByRole("button", { name: "Fit" }));
    expect(editor().pxPerSec).toBeNull();
  });
});

describe("Timeline, the clip menu", () => {
  it("leaves the lanes where they are on a wheel over the open menu", () => {
    seed();
    openEditor();
    const lanes = screen.getByTestId("stitch-lanes");
    fireEvent.contextMenu(clipBox("Clip 2"), { clientX: 400, clientY: 60 });
    const menu = screen.getByRole("menu");
    fireEvent.wheel(menu, { deltaY: 40 });
    expect(lanes.scrollLeft).toBe(0);
    expect(lanes.scrollTop).toBe(0);
    expect(editor().menu).toEqual({ clipId: "clip:eB", x: 400, y: 60 });
    // Over the lanes, the wheel still scrolls them
    fireEvent.wheel(lanes, { deltaY: 40 });
    expect(lanes.scrollLeft).toBe(40);
  });
});

describe("Timeline, Stacked", () => {
  const ROW = 52;
  const BOX_TOP = 6;
  /** Clips of these lengths from their own generate nodes, in order (clip ids clip:e0, clip:e1, …). */
  function seedClips(lengths: number[]) {
    useWorkflowStore.setState({
      nodes: [
        ...lengths.map((_, i) =>
          node(`gen-${i}`, "generateVideo", {
            outputVideo: `blob:s${i}`,
            selectedModel: { provider: "kie", modelId: "veo", displayName: `Model ${i + 1}` },
          }),
        ),
        node("stitch", "videoStitch", { clips: [], clipOrder: [], outputVideo: null, loopCount: 1, status: "idle" }),
      ],
      edges: lengths.map((_, i) => edge(`e${i}`, `gen-${i}`, `video-${i}`)),
      openModalCount: 0,
      isModalOpen: false,
    });
    lengths.forEach((duration, i) =>
      __setMediaInfoForTests(mediaKeyOf(`blob:s${i}`), { duration, width: 1920, height: 1080, fps: 24 }),
    );
  }
  const toggle = () => screen.getByRole("group", { name: "Timeline layout" });
  const openStacked = (onRender?: ProfilerOnRenderCallback) => {
    openEditor(onRender);
    fireEvent.click(within(toggle()).getByRole("button", { name: "Stacked" }));
    expect(editor().draft!.sequenceLayout.mode).toBe("stacked");
  };
  const at = (x: number, y: number) => ({ clientX: x, clientY: y });
  const move = (x: number, y: number) => pointer("pointermove", x, { clientY: y });
  const release = (x: number, y: number) => pointer("pointerup", x, { clientY: y });
  const order = () => editor().draft!.timeline.map((c) => c.id);
  const timelineEl = () => screen.getByTestId("stitch-lanes").parentElement!;

  it("puts Track | Stacked outside the timeline, Track pressed by default", () => {
    seed();
    openEditor();
    const track = within(toggle()).getByRole("button", { name: "Track" });
    const stacked = within(toggle()).getByRole("button", { name: "Stacked" });
    expect(track).toHaveAttribute("aria-pressed", "true");
    expect(stacked).toHaveAttribute("aria-pressed", "false");
    // The header's own tooltips, as Undo and Redo beside them have, not the system's
    expect(track).not.toHaveAttribute("title");
    expect(within(track.parentElement!).getByText("Track: clips end to end on one row")).toHaveAttribute("aria-hidden", "true");
    expect(within(stacked.parentElement!).getByText("Stacked: one row per clip, each overlapping the one before")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    // The timeline grows and shrinks with the layout, so the toggle is not in it (it is in the editor's header)
    expect(timelineEl().contains(toggle())).toBe(false);
    // Track keeps its Clips header, under an empty corner
    const clipsHeader = screen.getByTestId("stitch-clip-count").parentElement!;
    expect(clipsHeader.previousElementSibling!.childElementCount).toBe(0);
    expect(screen.getByTestId("stitch-clip-count")).toHaveTextContent("2");
    fireEvent.click(stacked);
    expect(editor().draft!.sequenceLayout.mode).toBe("stacked");
    expect(within(toggle()).getByRole("button", { name: "Stacked" })).toHaveAttribute("aria-pressed", "true");
    expect(timelineEl().contains(toggle())).toBe(false);
    expect(screen.queryByTestId("stitch-clip-count")).toBeNull();
    // Stacked's corner holds only the + that adds from the library
    const corner = screen.getByTestId("stitch-row-headers").parentElement!.previousElementSibling!;
    const add = within(corner as HTMLElement).getByRole("button", { name: "Add a clip from the library" });
    expect(corner.childElementCount).toBe(1);
    expect(corner.firstElementChild).toBe(add);
    expect(editor().past).toHaveLength(1);
  });

  it("lays out one row per clip, each box at its own start, compact, with its row header", () => {
    seedClips([5, 5, 6]);
    openStacked();
    expect(lane()).toHaveAttribute("aria-orientation", "vertical");
    expect(within(lane()).getAllByRole("option")).toHaveLength(3);
    // Overlap 1.0 s: starts 0, 4 and 8 s at 64 px/s from the origin, one 52px row each
    const starts = [0, 4, 8];
    const lengths = [5, 5, 6];
    ["Clip 1", "Clip 2", "Clip 3"].forEach((name, i) => {
      const box = clipBox(name);
      expect(box.style.left).toBe(`${ORIGIN + starts[i] * PPS}px`);
      expect(box.style.width).toBe(`${lengths[i] * PPS}px`);
      expect(box.style.top).toBe(`${i * ROW + BOX_TOP}px`);
      expect(box.style.height).toBe("40px");
    });
    // No label bar: the row header names the clip; the box keeps a length chip
    expect(within(clipBox("Clip 1")).queryByText("Clip 1")).toBeNull();
    expect(within(clipBox("Clip 1")).queryByText("Model 1")).toBeNull();
    expect(within(clipBox("Clip 1")).getByText("5.0 s")).toBeInTheDocument();
    const headers = screen.getByTestId("stitch-row-headers");
    expect(within(headers).getByText("Clip 2")).toBeInTheDocument();
    expect(within(headers).getByText("Model 2")).toBeInTheDocument();
    // The add slot after the last row's box, in that row
    const slot = screen.getByTestId("stitch-add-slot");
    expect(slot.style.left).toBe(`${ORIGIN + 14 * PPS + 8}px`);
    expect(slot.style.top).toBe(`${2 * ROW + BOX_TOP}px`);
    // 3 rows: 24 + 156 + 64 + 9
    expect(timelineEl().style.height).toBe("253px");
    expect(screen.getByTestId("stitch-lanes")).toHaveClass("overflow-y-hidden");
  });

  it("draws a 1 s crossfade as a wedge over each side of the join", () => {
    seed();
    openStacked();
    const head = clipBox("Clip 2").querySelector<SVGElement>('[data-testid="stitch-crossfade-in"]')!;
    const tail = clipBox("Clip 1").querySelector<SVGElement>('[data-testid="stitch-crossfade-out"]')!;
    expect(head.style.width).toBe(`${PPS}px`);
    expect(tail.style.width).toBe(`${PPS}px`);
    expect(clipBox("Clip 1").querySelector('[data-testid="stitch-crossfade-in"]')).toBeNull();
    expect(clipBox("Clip 2").querySelector('[data-testid="stitch-crossfade-out"]')).toBeNull();
  });

  it("with the crossfade off, darkens the head the clip above hides, without the trim hatch", () => {
    seed();
    openStacked();
    act(() => setCrossfade(false));
    const covered = clipBox("Clip 2").querySelector<HTMLElement>('[data-testid="stitch-covered-head"]')!;
    expect(covered).toHaveAttribute("title", "Hidden under Clip 1. Its sound plays.");
    expect(covered.style.width).toBe(`${PPS}px`);
    expect(clipBox("Clip 2").querySelector(".editor-ghost-hatch")).toBeNull();
    expect(screen.queryByTestId("stitch-crossfade-in")).toBeNull();
    expect(clipBox("Clip 1").querySelector('[data-testid="stitch-covered-head"]')).toBeNull();
  });

  it("moves the selection down the rows with the arrows", () => {
    seedClips([5, 5, 6]);
    openStacked();
    click(clipBox("Clip 1"));
    fireEvent.keyDown(clipBox("Clip 1"), { key: "ArrowDown" });
    expect(editor().selection).toEqual({ kind: "clip", clipId: "clip:e1" });
    fireEvent.keyDown(clipBox("Clip 2"), { key: "End" });
    expect(editor().selection).toEqual({ kind: "clip", clipId: "clip:e2" });
    fireEvent.keyDown(clipBox("Clip 3"), { key: "ArrowUp" });
    expect(editor().selection).toEqual({ kind: "clip", clipId: "clip:e1" });
  });

  it("drags a clip down two rows in one undo step, drawn at the start it will have, with the line in both columns", () => {
    seedClips([5, 5, 6]);
    openStacked();
    const before = editor().past.length;
    fireEvent.pointerDown(clipBox("Clip 1"), { button: 0, pointerId: 1, ...at(100, 26) });
    move(100, 26 + 2 * ROW);
    // Lifted down two rows, at x of its start in the order B, C, A: 5 + 6 − 2 overlaps = 9 s
    const lifted = clipBox("Clip 1");
    expect(lifted.style.top).toBe(`${BOX_TOP + 2 * ROW}px`);
    expect(lifted.style.left).toBe(`${ORIGIN + 9 * PPS}px`);
    // Below the last row, across the lanes and the headers
    expect(screen.getByTestId("stitch-insertion-bar").style.top).toBe(`${3 * ROW - 1.5}px`);
    expect(screen.getByTestId("stitch-header-insertion").style.top).toBe(`${3 * ROW - 1.5}px`);
    release(100, 26 + 2 * ROW);
    expect(order()).toEqual(["clip:e1", "clip:e2", "clip:e0"]);
    expect(editor().past).toHaveLength(before + 1);
    expect(screen.queryByTestId("stitch-insertion-bar")).toBeNull();
    expect(screen.queryByTestId("stitch-header-insertion")).toBeNull();
  });

  it("drags a clip by its row header, and a click on the header selects it", () => {
    seedClips([5, 5, 6]);
    openStacked();
    const header = (id: string) => document.querySelector<HTMLElement>(`[data-row-header="${id}"]`)!;
    fireEvent.pointerDown(header("clip:e1"), { button: 0, pointerId: 1, ...at(40, 78) });
    release(40, 78);
    expect(editor().selection).toEqual({ kind: "clip", clipId: "clip:e1" });
    expect(order()).toEqual(["clip:e0", "clip:e1", "clip:e2"]);
    fireEvent.pointerDown(header("clip:e2"), { button: 0, pointerId: 1, ...at(40, 130) });
    move(40, 130 - 2 * ROW);
    expect(screen.getByTestId("stitch-header-insertion").style.top).toBe("-1.5px");
    release(40, 130 - 2 * ROW);
    expect(order()).toEqual(["clip:e2", "clip:e0", "clip:e1"]);
  });

  it("says why a sideways drag does not move a clip in time", () => {
    seed();
    openStacked();
    fireEvent.pointerDown(clipBox("Clip 2"), { button: 0, pointerId: 1, ...at(400, 78) });
    move(300, 82);
    expect(screen.getByTestId("stitch-reorder-chip")).toHaveTextContent(
      "Clips stay in order. Overlap sets where each one starts.",
    );
    release(300, 82);
    expect(screen.queryByTestId("stitch-reorder-chip")).toBeNull();
    expect(order()).toEqual(["clip:eA", "clip:eB"]);
  });

  it("titles the menu's Split when the playhead is inside an overlap", () => {
    seed();
    openStacked();
    act(() => editor().setPlayhead(4.5));
    fireEvent.contextMenu(clipBox("Clip 2"), { clientX: 400, clientY: 60 });
    const split = screen.getByRole("menuitem", { name: /Split at playhead/ });
    expect(split).toBeDisabled();
    expect(split).toHaveAttribute("title", "Move the playhead out of the overlap to split");
  });

  it("gives a clip with no length a 160px slot in its own row", () => {
    seed({ bRan: false });
    openStacked();
    const slot = clipBox("Clip 2");
    expect(slot).toHaveAttribute("data-empty-reason", "empty");
    expect(slot.style.width).toBe("160px");
    expect(slot.style.top).toBe(`${ROW + BOX_TOP}px`);
    expect(slot.style.left).toBe(`${ORIGIN + 5 * PPS}px`);
    expect(within(screen.getByTestId("stitch-row-headers")).getByText("not generated yet")).toBeInTheDocument();
  });

  it("caps the rows at three and a half and scrolls them under the ruler, the headers following", () => {
    seedClips([5, 5, 6, 5, 5, 6]);
    const onRender = vi.fn();
    openStacked(onRender);
    // 24 + 182 + 64 + 9
    expect(timelineEl().style.height).toBe("279px");
    const lanes = screen.getByTestId("stitch-lanes");
    expect(lanes).toHaveClass("overflow-y-auto");
    const optionsBefore = within(lane()).getAllByRole("option");
    lanes.scrollTop = 40;
    // The profiler sees the modal's renders
    expect(onRender).toHaveBeenCalled();
    onRender.mockClear();
    fireEvent.scroll(lanes);
    // Written straight to the header rows: nothing renders
    expect(onRender).not.toHaveBeenCalled();
    expect(screen.getByTestId("stitch-row-headers").style.transform).toBe("translateY(-40px)");
    // The boxes stay where they were: the scroll is the scroller's own
    const optionsAfter = within(lane()).getAllByRole("option");
    expect(optionsAfter.every((el, i) => el === optionsBefore[i] && el.style.top === `${i * ROW + BOX_TOP}px`)).toBe(true);
  });

  it("scrolls the rows with a plain wheel when they overflow, and along the timeline with ⇧", () => {
    seedClips([5, 5, 6, 5, 5, 6]);
    openStacked();
    const lanes = screen.getByTestId("stitch-lanes");
    fireEvent.wheel(lanes, { deltaY: 50 });
    expect(lanes.scrollTop).toBe(50);
    expect(lanes.scrollLeft).toBe(0);
    fireEvent.wheel(lanes, { deltaY: 30, shiftKey: true });
    expect(lanes.scrollLeft).toBe(30);
    expect(lanes.scrollTop).toBe(50);
  });

  it("keeps the wheel sideways when the rows fit", () => {
    seed();
    openStacked();
    const lanes = screen.getByTestId("stitch-lanes");
    fireEvent.wheel(lanes, { deltaY: 50 });
    expect(lanes.scrollLeft).toBe(50);
    expect(lanes.scrollTop).toBe(0);
  });

  it("scrolls the rows with a wheel over their headers too", () => {
    seedClips([5, 5, 6, 5, 5, 6]);
    openStacked();
    const lanes = screen.getByTestId("stitch-lanes");
    fireEvent.wheel(screen.getByTestId("stitch-row-headers"), { deltaY: 50 });
    expect(lanes.scrollTop).toBe(50);
    // The browser's scroll event (jsdom sends none) moves the headers with them
    fireEvent.scroll(lanes);
    expect(screen.getByTestId("stitch-row-headers").style.transform).toBe("translateY(-50px)");
  });

  it("opens the clip menu from a right press on a row header", () => {
    seedClips([5, 5, 6]);
    openStacked();
    const header = document.querySelector<HTMLElement>('[data-row-header="clip:e1"]')!;
    const notCancelled = fireEvent.contextMenu(header, { clientX: 40, clientY: 78 });
    expect(notCancelled).toBe(false);
    expect(editor().menu).toEqual({ clipId: "clip:e1", x: 40, y: 78 });
    expect(editor().selection).toEqual({ kind: "clip", clipId: "clip:e1" });
  });

  it("draws an In trim's cut frames as the head, just left of the box", () => {
    seedClips([5, 5, 6]);
    openStacked();
    // Clip 2 (4–9 s) loses its first second: its join stays 1 s, so its box stays at 4 s and 4 s long
    const edgeX = ORIGIN + 4 * PPS;
    fireEvent.pointerDown(handleOf("Clip 2", "in"), { button: 0, pointerId: 1, ...at(edgeX, 78) });
    move(edgeX + PPS, 78);
    expect(clipBox("Clip 2").style.left).toBe(`${ORIGIN + 4 * PPS}px`);
    expect(clipBox("Clip 2").style.width).toBe(`${4 * PPS}px`);
    const ghost = screen.getByTestId("stitch-trim-ghost");
    expect(ghost.style.left).toBe(`${ORIGIN + 3 * PPS}px`);
    expect(ghost.style.width).toBe(`${PPS}px`);
    expect(ghost).toHaveClass("rounded-l-media");
    release(edgeX + PPS, 78);
    expect(editor().draft!.timeline[1].inSec).toBeCloseTo(1, 6);
  });

  it("keeps the sideways chip inside the visible lanes", () => {
    vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(600);
    seed();
    openStacked();
    fireEvent.pointerDown(clipBox("Clip 2"), { button: 0, pointerId: 1, ...at(400, 78) });
    // 500 + 14 + 300 would pass the 600px view: the chip goes left of the pointer
    move(500, 82);
    expect(screen.getByTestId("stitch-reorder-chip").style.left).toBe(`${500 - 14 - 300}px`);
    move(300, 82);
    // Neither side fits: against the view's right edge
    expect(screen.getByTestId("stitch-reorder-chip").style.left).toBe(`${600 - 300}px`);
    release(300, 82);
  });

  it("draws a trim as release leaves it, the half-clip cap moving the next clip during the drag", () => {
    seedClips([5, 5, 6]);
    openStacked();
    act(() => editor().setPlayhead(0));
    // Clip 1 down to 1.5 s: its join with clip 2 is capped at 0.75 s, so clip 2 starts at 0.75 s
    const edgeX = ORIGIN + 5 * PPS;
    fireEvent.pointerDown(handleOf("Clip 1", "out"), { button: 0, pointerId: 1, ...at(edgeX, 26) });
    move(edgeX - 3.5 * PPS, 26);
    const live = { width: clipBox("Clip 1").style.width, next: clipBox("Clip 2").style.left, last: clipBox("Clip 3").style.left };
    expect(live.width).toBe(`${1.5 * PPS}px`);
    expect(live.next).toBe(`${ORIGIN + 0.75 * PPS}px`);
    expect(screen.getByTestId("stitch-trim-ghost").style.left).toBe(`${ORIGIN + 1.5 * PPS}px`);
    release(edgeX - 3.5 * PPS, 26);
    expect(editor().draft!.timeline[0].outSec).toBeCloseTo(1.5, 6);
    expect(clipBox("Clip 1").style.width).toBe(live.width);
    expect(clipBox("Clip 2").style.left).toBe(live.next);
    expect(clipBox("Clip 3").style.left).toBe(live.last);
  });

  it("keeps the row of the clip that drives the preview in view while playing", () => {
    seedClips([5, 5, 6, 5, 5, 6]);
    openStacked();
    const lanes = screen.getByTestId("stitch-lanes");
    // Starts 0, 4, 8, 13, 17, 21: at 25 s only clip 6 plays. Its row (260–312) under a 190px viewport
    act(() => editor().setPlayhead(25));
    expect(lanes.scrollTop).toBe(0);
    act(() => editor().setPlaying(true));
    expect(lanes.scrollTop).toBe(5 * ROW + ROW - 190);
    act(() => editor().setPlaying(false));
  });

  it("scrolls the selected clip into view when an undo moves it to another row", () => {
    seedClips([5, 5, 6, 5, 5, 6]);
    openStacked();
    const lanes = screen.getByTestId("stitch-lanes");
    act(() => editor().select({ kind: "clip", clipId: "clip:e5" }));
    act(() => moveClipTo("clip:e5", 0));
    lanes.scrollTop = 0;
    act(() => editor().undo());
    expect(order()[5]).toBe("clip:e5");
    expect(editor().selection).toEqual({ kind: "clip", clipId: "clip:e5" });
    // Row 6 (260–312) under the 190px viewport
    expect(lanes.scrollTop).toBe(6 * ROW - 190);
  });

  it("draws Clip 1's cut head inside the lane, the frames nearest the new In", () => {
    seedClips([5, 5, 6]);
    openStacked();
    fireEvent.pointerDown(handleOf("Clip 1", "in"), { button: 0, pointerId: 1, ...at(ORIGIN, 26) });
    move(ORIGIN + PPS, 26);
    // Clip 1 keeps its start: only the origin's 16px are left of it
    expect(clipBox("Clip 1").style.left).toBe(`${ORIGIN}px`);
    const ghost = screen.getByTestId("stitch-trim-ghost");
    expect(ghost.style.left).toBe("0px");
    expect(ghost.style.width).toBe(`${ORIGIN}px`);
    release(ORIGIN + PPS, 26);
    expect(editor().draft!.timeline[0].inSec).toBeCloseTo(1, 6);
  });

  it("keeps the sideways chip of a drag from a row header inside the visible lanes", () => {
    vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(600);
    // The lanes start right of the 132px header column
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(132, 0, 600, 200));
    seedClips([5, 5, 6]);
    openStacked();
    const header = document.querySelector<HTMLElement>('[data-row-header="clip:e1"]')!;
    fireEvent.pointerDown(header, { button: 0, pointerId: 1, ...at(40, 78) });
    move(100, 80);
    expect(screen.getByTestId("stitch-reorder-chip").style.left).toBe("0px");
    release(100, 80);
  });

  it("fits an empty clip's slot that reaches past the sequence's end", () => {
    vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(800);
    seedClips([5, 5, 2]);
    useWorkflowStore.setState({
      nodes: wf().nodes.map((n) => (n.id === "gen-1" ? { ...n, data: {} } : n)),
    });
    openStacked();
    act(() => editor().setZoom(null));
    const slot = clipBox("Clip 2");
    expect(slot).toHaveAttribute("data-empty-reason", "empty");
    // Clips 5 s, empty, 2 s: the slot sits at 5 s, and its 160px would end past the sequence's 6 s at the plain fit
    expect(parseFloat(slot.style.left) + parseFloat(slot.style.width)).toBeLessThanOrEqual(800);
    // No sideways scroll in Fit: the lane content is the lane's own width
    const content = screen.getByTestId("stitch-lanes").firstElementChild as HTMLElement;
    expect(content.style.width).toBe("800px");
  });

  it("scrolls a clip selected by a key into view", () => {
    seedClips([5, 5, 6, 5, 5, 6]);
    openStacked();
    const lanes = screen.getByTestId("stitch-lanes");
    click(clipBox("Clip 1"));
    fireEvent.keyDown(clipBox("Clip 1"), { key: "End" });
    expect(lanes.scrollTop).toBe(6 * ROW - 190);
    fireEvent.keyDown(clipBox("Clip 6"), { key: "Home" });
    expect(lanes.scrollTop).toBe(0);
  });
});
