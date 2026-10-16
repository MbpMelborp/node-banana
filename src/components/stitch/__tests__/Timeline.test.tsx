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

function openEditor() {
  render(<StitchEditorModal />);
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
    // The clip is the panel's last tab stop (its mute buttons are out of the tab order): Tab wraps inside the dialog
    fireEvent.keyDown(clipBox("Clip 1"), { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(clipBox("Clip 1"));
    act(() => clipBox("Clip 1").focus());
    press("Backspace");
    expect(editor().draft?.timeline).toHaveLength(0);
    expect(document.activeElement).toBe(dialog);
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
