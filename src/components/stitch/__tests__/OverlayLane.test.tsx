import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

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
import { applyLibraryStatus } from "@/lib/assets/client/recorder";
import type { LibraryStatus } from "@/lib/assets/types";
import { overlaySelectionOf, useStitchEditorStore } from "@/store/stitchEditorStore";
import { createTextOverlay } from "@/lib/stitch/overlays";
import { __resetMediaInfoForTests, __setMediaExtractorForTests, __setMediaInfoForTests, mediaKeyOf } from "@/lib/stitch/mediaInfo";
import { StitchEditorModal } from "../StitchEditorModal";
import { openStitchEditor } from "../openStitchEditor";
import type { StitchOverlay, VideoStitchNodeData, WorkflowEdge, WorkflowNode } from "@/types";

// The text layers' rows inside the real editor, against the real stores.
// jsdom lays nothing out (every rect is at 0), so lane x is the pointer's
// clientX and a block's y is its clientY. At 64 px/s a time t is at
// x = 20 + 64·t. The sequence is 9 s (A 5 s, B 4 s). The rows run up from
// the video: with two rows, row 1's block is at 6–46 in the rows block and
// row 0's at 58–98, under the 28px ruler in the lanes' content.

const PPS = 64;
const ORIGIN = 20;
const x = (t: number) => ORIGIN + t * PPS;
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
const text = (id: string, init: Partial<StitchOverlay> = {}) => createTextOverlay({ id, ...init });

function seed({ clips = true, stitch = {} }: { clips?: boolean; stitch?: Partial<VideoStitchNodeData> } = {}) {
  useWorkflowStore.setState({
    nodes: [
      node("gen-a", "generateVideo", { outputVideo: "blob:a" }),
      node("gen-b", "generateVideo", { outputVideo: "blob:b" }),
      node("stitch", "videoStitch", { clips: [], clipOrder: [], outputVideo: null, loopCount: 1, status: "idle", ...stitch }),
    ],
    edges: clips ? [edge("eA", "gen-a", "video-0"), edge("eB", "gen-b", "video-1")] : [],
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
}

const lane = () => screen.getByRole("listbox", { name: "Text layers" });
const box = (id: string) => lane().querySelector<HTMLElement>(`[data-overlay-id="${id}"]`)!;
const rows = () => screen.getAllByTestId("stitch-overlay-row");
const layers = () => editor().draft!.overlays ?? [];
const layer = (id: string) => layers().find((o) => o.id === id)!;
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
const click = (el: HTMLElement, clientX: number, clientY: number) => {
  down(el, clientX, clientY);
  pointer("pointerup", clientX, clientY);
};

beforeEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  wf().clearWorkflow();
  editor().close();
  __resetMediaInfoForTests();
  __setMediaExtractorForTests({ probe: () => new Promise(() => {}), open: () => new Promise(() => {}) });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  // jsdom has no 2D canvas; the stage's overlay canvas draws nothing
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
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

describe("Text layers' rows", () => {
  it("take no room, and draw nothing, without text layers", () => {
    seed();
    openEditor();
    expect(screen.queryByTestId("stitch-overlay-section")).toBeNull();
    expect(screen.queryByRole("listbox", { name: "Text layers" })).toBeNull();
  });

  it("draw each layer as a box on its row, bottom-up: its first line, its fades as ramps, hatched past the last frame", () => {
    seed({
      stitch: {
        overlays: [
          text("t", { startSec: 1, endSec: 4, text: "\nTitle\nSecond line" }),
          text("u", { row: 1, startSec: 6, endSec: 12, text: "  ", fadeInSec: 0, fadeOutSec: 1 }),
        ],
      },
    });
    openEditor();
    const section = screen.getByTestId("stitch-overlay-section");
    expect(section).toHaveAttribute("data-overlay-section");
    expect(section.style.height).toBe("104px");
    // Row 0 is the lower one, nearest the video
    expect(rows().map((row) => [row.dataset.row, row.style.top, row.style.height])).toEqual([
      ["0", "52px", "52px"],
      ["1", "0px", "52px"],
    ]);
    const title = within(lane()).getByRole("option", { name: "Title, Text 1, starts 0:01.00" });
    expect(title).toBe(box("t"));
    expect(title.style.left).toBe(`${x(1)}px`);
    expect(title.style.width).toBe(`${3 * PPS}px`);
    expect(title.style.top).toBe("58px");
    expect(title.style.height).toBe("40px");
    expect(title).toHaveClass("bg-edit-clip");
    expect(within(title).getByText("Title")).toHaveClass("text-neutral-300");
    expect(title).toHaveAttribute("title", "\nTitle\nSecond line");
    const empty = within(lane()).getByRole("option", { name: "Empty text, Text 2, starts 0:06.00" });
    expect(empty.style.top).toBe("6px");
    expect(within(empty).getByText("Empty text")).toHaveClass("text-ink-3");
    // The fades from the render's own corners: 0.5 s in and out on the title (32 px), only out on the other
    const fadeIn = within(title).getByTestId("stitch-overlay-fade-in");
    expect([fadeIn.getAttribute("x1"), fadeIn.getAttribute("y1"), fadeIn.getAttribute("x2"), fadeIn.getAttribute("y2")]).toEqual(["0", "40", "32", "0"]);
    expect(within(title).getByTestId("stitch-overlay-fade-out").getAttribute("x1")).toBe(`${3 * PPS - 32}`);
    expect(within(empty).queryByTestId("stitch-overlay-fade-in")).toBeNull();
    expect(within(empty).getByTestId("stitch-overlay-fade-out").getAttribute("x1")).toBe(`${5 * PPS}`);
    // The sequence ends at 9 s: the part of the second box after it is hatched, the first has none
    expect(within(title).queryByTestId("stitch-overlay-after-end")).toBeNull();
    const hatch = within(empty).getByTestId("stitch-overlay-after-end");
    expect(hatch).toHaveAttribute("title", "After the last frame: not shown");
    expect(hatch.style.left).toBe(`${3 * PPS}px`);
    // Its length on hover only; nothing selected, no ring
    expect(within(title).getByText("3.0 s")).toHaveClass("opacity-0", "group-hover:opacity-100");
    expect(title.querySelector("[data-selected-ring]")).toBeNull();
    expect(title).toHaveAttribute("tabindex", "0");
    expect(empty).toHaveAttribute("tabindex", "-1");
  });

  it("meets fades that overlap in one corner below the top", () => {
    seed({ stitch: { overlays: [text("t", { startSec: 1, endSec: 1.5, fadeInSec: 0.5, fadeOutSec: 0.5 })] } });
    openEditor();
    const fadeIn = within(box("t")).getByTestId("stitch-overlay-fade-in");
    const fadeOut = within(box("t")).getByTestId("stitch-overlay-fade-out");
    // Half a second of fades meeting half way: peak 0.5, at 16 px of the 32 px box
    expect([fadeIn.getAttribute("x2"), fadeIn.getAttribute("y2")]).toEqual(["16", "20"]);
    expect([fadeOut.getAttribute("x1"), fadeOut.getAttribute("y1")]).toEqual(["16", "20"]);
  });

  it("hatch nothing when there is no video at all", () => {
    seed({ clips: false, stitch: { overlays: [text("t", { startSec: 0, endSec: 4 })] } });
    openEditor();
    expect(box("t")).toBeInTheDocument();
    expect(screen.queryByTestId("stitch-overlay-after-end")).toBeNull();
  });

  it("select a layer on a click, ring it, and show the rail's default body", () => {
    seed({ stitch: { overlays: [text("t", { startSec: 1, endSec: 4 })] } });
    openEditor();
    click(box("t"), x(2), 30);
    expect(editor().selection).toEqual({ kind: "overlay", clipId: "t" });
    expect(box("t")).toHaveAttribute("aria-selected", "true");
    expect(box("t").querySelector("[data-selected-ring]")).not.toBeNull();
    expect(editor().past).toHaveLength(0);
  });

  it("move a layer in time by the drag, the chip saying where; ⇧ turns the snap off and Escape puts it back", () => {
    seed({ stitch: { overlays: [text("t", { startSec: 2, endSec: 5 })] } });
    openEditor();
    down(box("t"), x(3), 30);
    pointer("pointermove", x(3) + PPS, 30, { shiftKey: true });
    expect(screen.getByTestId("stitch-overlay-move-chip")).toHaveTextContent("0:03.00–0:06.00 · +1.00 s");
    // Nothing moves before the release
    expect(layer("t").startSec).toBe(2);
    press("Escape");
    pointer("pointerup", x(3) + PPS, 30);
    expect(layer("t")).toMatchObject({ startSec: 2, endSec: 5 });
    expect(editor().past).toHaveLength(0);
    down(box("t"), x(3), 30);
    pointer("pointermove", x(3) + PPS, 30, { shiftKey: true });
    pointer("pointerup", x(3) + PPS, 30, { shiftKey: true });
    expect(layer("t").startSec).toBeCloseTo(3);
    expect(layer("t").endSec).toBeCloseTo(6);
    expect(editor().past).toHaveLength(1);
    expect(editor().selection).toEqual({ kind: "overlay", clipId: "t" });
  });

  it("snap a moved layer's start to the playhead, the guide standing in for the playhead's line", () => {
    seed({ stitch: { overlays: [text("t", { startSec: 2, endSec: 5 })] } });
    openEditor();
    act(() => editor().setPlayhead(4));
    down(box("t"), x(3), 30);
    // 2 s → 3.95 s: 3 px from the playhead
    pointer("pointermove", x(3) + 1.95 * PPS, 30);
    expect(screen.getByTestId("stitch-snap-chip")).toHaveTextContent("Snapped to the playhead");
    expect(screen.queryByTestId("stitch-playhead-line")).toBeNull();
    pointer("pointerup", x(3) + 1.95 * PPS, 30);
    expect(layer("t")).toMatchObject({ startSec: 4, endSec: 7 });
  });

  it("move a layer onto a new row above the top one: no row changes before release, one undo step after", () => {
    seed({ stitch: { overlays: [text("t", { startSec: 2, endSec: 5 }), text("u", { row: 1, startSec: 6, endSec: 8 })] } });
    openEditor();
    const places = () => rows().map((row) => `${row.style.top}/${row.style.height}`);
    const before = places();
    // u's block centre is at 26 in the rows block: up past the top row's band by 4 px
    down(box("u"), x(7), 26);
    pointer("pointermove", x(7), 26 - 20);
    expect(places()).toEqual(before);
    expect(screen.queryByTestId("stitch-overlay-insertion")).toBeNull();
    pointer("pointermove", x(7), 26 - 40);
    expect(places()).toEqual(before);
    expect(screen.getByTestId("stitch-overlay-move-chip")).toHaveTextContent("New row");
    expect(screen.getByTestId("stitch-overlay-insertion").style.top).toBe("0px");
    expect(layer("u").row).toBe(1);
    pointer("pointerup", x(7), 26 - 40);
    expect(screen.queryByTestId("stitch-overlay-insertion")).toBeNull();
    expect(layer("u").row).toBe(2);
    expect(editor().past).toHaveLength(1);
    // The emptied row stays, so nothing moved under the pointer
    expect(rows()).toHaveLength(3);
  });

  it("land on the row a drag reaches, tinted while it runs, and insert a row where it overlaps", () => {
    seed({ stitch: { overlays: [text("t", { startSec: 2, endSec: 5 }), text("u", { row: 1, startSec: 6, endSec: 8 })] } });
    openEditor();
    // t's centre (78) up to row 1's band: no overlap there, so it lands on row 1
    down(box("t"), x(3), 78);
    pointer("pointermove", x(3), 78 - 52, { shiftKey: true });
    expect(rows().find((row) => row.dataset.row === "1")).toHaveClass("bg-white/6");
    expect(screen.getByTestId("stitch-overlay-move-chip")).not.toHaveTextContent("New row");
    pointer("pointerup", x(3), 78 - 52, { shiftKey: true });
    expect(layer("t").row).toBe(1);
    expect(editor().past).toHaveLength(1);
    act(() => editor().undo());
    // Now 2 s later, into u: an overlap on row 1 puts t on a new row in front of it
    down(box("t"), x(3), 78);
    pointer("pointermove", x(3) + 3 * PPS, 78 - 52, { shiftKey: true });
    expect(screen.getByTestId("stitch-overlay-insertion")).toBeInTheDocument();
    expect(screen.getByTestId("stitch-overlay-move-chip")).toHaveTextContent("0:05.00–0:08.00 · +3.00 s · New row");
    pointer("pointerup", x(3) + 3 * PPS, 78 - 52, { shiftKey: true });
    expect([layer("t").row, layer("u").row]).toEqual([2, 1]);
  });

  it("mark where an overlap inserts a row between two, and land there", () => {
    seed({ stitch: { overlays: [text("t", { startSec: 2, endSec: 5 }), text("u", { row: 1, startSec: 6, endSec: 8 })] } });
    openEditor();
    const places = () => rows().map((row) => `${row.style.top}/${row.style.height}`);
    const before = places();
    // u's centre (26) down to row 0's band and 2 s earlier, into t: a new row goes in above row 0
    down(box("u"), x(7), 26);
    pointer("pointermove", x(5), 26 + 52, { shiftKey: true });
    // On row 0's top edge, 52px down the rows block
    expect(screen.getByTestId("stitch-overlay-insertion").style.top).toBe(`${52 - 1.5}px`);
    // Nothing moves before the release
    expect(places()).toEqual(before);
    pointer("pointerup", x(5), 26 + 52, { shiftKey: true });
    expect(layer("u")).toMatchObject({ row: 1, startSec: 4, endSec: 6 });
    expect(layer("t").row).toBe(0);
    expect(editor().past).toHaveLength(1);
  });

  it("move a group of selected layers together", () => {
    seed({ stitch: { overlays: [text("t", { startSec: 2, endSec: 5 }), text("u", { row: 1, startSec: 6, endSec: 8 })] } });
    openEditor();
    act(() => editor().select(overlaySelectionOf({ clipId: "t", clipIds: ["t", "u"] })));
    down(box("u"), x(7), 26);
    pointer("pointermove", x(7) - PPS, 26, { shiftKey: true });
    expect(screen.getByTestId("stitch-overlay-move-chip")).toHaveTextContent("2 layers · 0:05.00–0:07.00 · −1.00 s");
    pointer("pointerup", x(7) - PPS, 26, { shiftKey: true });
    expect([layer("t").startSec, layer("u").startSec]).toEqual([1, 5]);
    expect(editor().selection).toEqual({ kind: "overlay", clipId: "u", clipIds: ["t", "u"] });
    expect(editor().past).toHaveLength(1);
  });

  it("trim a layer's start and end by its handles, the other edge kept", () => {
    seed({ stitch: { overlays: [text("t", { startSec: 2, endSec: 5 })] } });
    openEditor();
    const handle = (edge: "in" | "out") => box("t").querySelector<HTMLElement>(`[data-trim-handle="${edge}"]`)!;
    fireEvent.pointerDown(handle("in"), { button: 0, clientX: x(2), clientY: 30, pointerId: 1, shiftKey: true });
    expect(editor().selection).toEqual({ kind: "overlay", clipId: "t" });
    pointer("pointermove", x(2) + 32, 30, { shiftKey: true });
    expect(screen.getByTestId("stitch-overlay-trim-chip")).toHaveTextContent("Start 0:02.50");
    pointer("pointerup", x(2) + 32, 30, { shiftKey: true });
    expect(layer("t")).toMatchObject({ startSec: 2.5, endSec: 5 });
    expect(editor().past).toHaveLength(1);
    // The end snaps to the sequence's end at 9 s from 7 px away
    fireEvent.pointerDown(handle("out"), { button: 0, clientX: x(5), clientY: 30, pointerId: 1 });
    pointer("pointermove", x(9) - 7, 30);
    expect(screen.getByTestId("stitch-overlay-trim-chip")).toHaveTextContent("End 0:09.00");
    expect(screen.getByTestId("stitch-snap-chip")).toHaveTextContent("Snapped to the end");
    pointer("pointerup", x(9) - 7, 30);
    expect(layer("t")).toMatchObject({ startSec: 2.5, endSec: 9 });
    expect(editor().past).toHaveLength(2);
  });

  it("select the layers a box drawn on their rows touches, and clear on a click on empty row space", () => {
    seed({
      stitch: {
        overlays: [text("t", { startSec: 1, endSec: 3 }), text("v", { startSec: 6, endSec: 8 }), text("u", { row: 1, startSec: 2, endSec: 4 })],
      },
    });
    openEditor();
    // In the lanes' content: row 1's blocks at 34–74, row 0's at 86–126; from 0.5 s to 5 s across both rows
    fireEvent.pointerDown(lane(), { button: 0, clientX: x(0.5), clientY: 40, pointerId: 1 });
    pointer("pointermove", x(5), 100);
    expect(screen.getByTestId("stitch-marquee")).toBeInTheDocument();
    expect(box("t").querySelector("[data-selected-ring]")).not.toBeNull();
    expect(box("v").querySelector("[data-selected-ring]")).toBeNull();
    pointer("pointerup", x(5), 100);
    expect(editor().selection).toEqual({ kind: "overlay", clipId: "t", clipIds: ["t", "u"] });
    fireEvent.pointerDown(lane(), { button: 0, clientX: x(5), clientY: 40, pointerId: 1 });
    pointer("pointerup", x(5), 40);
    expect(editor().selection).toBeNull();
  });

  it("move the selection along the layers with the arrows, Home and End; ↑ is the row above", () => {
    seed({
      stitch: {
        overlays: [text("t", { startSec: 1, endSec: 3 }), text("v", { startSec: 6, endSec: 8 }), text("u", { row: 1, startSec: 5, endSec: 7 })],
      },
    });
    openEditor();
    click(box("t"), x(2), 78);
    act(() => box("t").focus());
    const key = (k: string) => fireEvent.keyDown(lane(), { key: k });
    key("ArrowRight");
    expect(editor().selection).toEqual({ kind: "overlay", clipId: "v" });
    expect(document.activeElement).toBe(box("v"));
    key("End");
    expect(editor().selection).toMatchObject({ clipId: "u" });
    key("Home");
    expect(editor().selection).toMatchObject({ clipId: "t" });
    // ↑: the layer on the row above whose start is nearest; ↓ back down to the nearest on row 0
    key("ArrowUp");
    expect(editor().selection).toMatchObject({ clipId: "u" });
    key("ArrowUp");
    expect(editor().selection).toMatchObject({ clipId: "u" });
    key("ArrowDown");
    expect(editor().selection).toMatchObject({ clipId: "v" });
  });

  it("open the layer's menu on a right-click, and its rows act on it", () => {
    seed({ stitch: { overlays: [text("t", { startSec: 1, endSec: 4, text: "Opening" }), text("u", { row: 1, startSec: 2, endSec: 3 })] } });
    openEditor();
    act(() => editor().setPlayhead(2));
    fireEvent.contextMenu(box("t"), { clientX: 200, clientY: 300 });
    expect(editor().selection).toEqual({ kind: "overlay", clipId: "t" });
    const menu = screen.getByRole("menu", { name: "“Opening” · Text 1" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Split at playheadS",
      "Start at playhead[",
      "End at playhead]",
      "Move up a row⌥↑",
      "Move down a row⌥↓",
      "Copy⌘C",
      "Cut⌘X",
      "Paste⌘V",
      "Duplicate⌘D",
      "Remove text⌫",
    ]);
    // Row 0 is the lowest; ] needs as much time before the playhead as the layer lasts
    expect(within(menu).getByRole("menuitem", { name: /Move down a row/ })).toBeDisabled();
    expect(within(menu).getByRole("menuitem", { name: /End at playhead/ })).toBeDisabled();
    expect(within(menu).getByRole("menuitem", { name: /Paste/ })).toBeDisabled();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Split at playhead/ }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(layer("t")).toMatchObject({ startSec: 1, endSec: 2 });
    expect(layers()).toHaveLength(3);
    // The video is not cut
    expect(editor().draft!.timeline).toHaveLength(2);
    // A group's menu acts on the group
    act(() => editor().select(overlaySelectionOf({ clipId: "t", clipIds: ["t", "u"] })));
    fireEvent.contextMenu(box("u"), { clientX: 200, clientY: 300 });
    const group = screen.getByRole("menu", { name: "2 text layers" });
    expect(within(group).getByRole("menuitem", { name: /Start at playhead/ })).toBeDisabled();
    fireEvent.click(within(group).getByRole("menuitem", { name: /Remove 2 text layers/ }));
    expect(layers().map((o) => o.startSec)).toEqual([2]);
  });

  it("open the menu from the keyboard, under the focused layer", () => {
    seed({ stitch: { overlays: [text("t", { startSec: 1, endSec: 4 })] } });
    openEditor();
    act(() => box("t").focus());
    fireEvent.keyDown(lane(), { key: "F10", shiftKey: true });
    expect(screen.getByRole("menu", { name: "“Title” · Text 1" })).toBeInTheDocument();
    expect(editor().menu).toMatchObject({ kind: "overlay", clipId: "t" });
  });

  it("scroll their rows past two by the wheel, never Stacked's rows, and count the rows out of view", () => {
    seed({
      stitch: {
        overlays: [text("a", { startSec: 0, endSec: 1 }), text("b", { row: 1, startSec: 0, endSec: 1 }), text("c", { row: 2, startSec: 0, endSec: 1 })],
      },
    });
    openEditor();
    const block = screen.getByTestId("stitch-overlay-rows");
    const section = screen.getByTestId("stitch-overlay-section");
    expect(section.style.height).toBe("104px");
    // Rows 0 and 1 show; row 2 is above them
    expect(block.style.transform).toBe("translateY(-52px)");
    expect(screen.getByTestId("stitch-overlay-hidden-rows")).toHaveTextContent(/^1 text row above1$/);
    const lanes = screen.getByTestId("stitch-lanes");
    act(() => {
      box("a").dispatchEvent(new WheelEvent("wheel", { deltaY: -30, bubbles: true, cancelable: true }));
    });
    expect(block.style.transform).toBe("translateY(-22px)");
    expect(lanes.scrollTop).toBe(0);
    act(() => {
      box("a").dispatchEvent(new WheelEvent("wheel", { deltaY: -300, bubbles: true, cancelable: true }));
    });
    expect(block.style.transform).toBe("translateY(0px)");
    expect(screen.getByTestId("stitch-overlay-hidden-rows")).toHaveTextContent(/^1 text row below1$/);
  });

  it("bring a lead selected by a key into view: its row, and focus from a focused layer", () => {
    seed({
      stitch: {
        overlays: [text("a", { startSec: 0, endSec: 1 }), text("b", { row: 1, startSec: 0, endSec: 1 }), text("c", { row: 2, startSec: 0, endSec: 1 })],
      },
    });
    openEditor();
    const block = screen.getByTestId("stitch-overlay-rows");
    act(() => editor().select(overlaySelectionOf({ clipId: "c" })));
    expect(block.style.transform).toBe("translateY(0px)");
    act(() => editor().select(overlaySelectionOf({ clipId: "a" })));
    expect(block.style.transform).toBe("translateY(-52px)");
    // A duplicate: the copy leads, and takes focus from the focused original
    act(() => box("a").focus());
    press("d", { metaKey: true });
    const copy = editor().selection!.clipId;
    expect(copy).not.toBe("a");
    expect(document.activeElement).toBe(box(copy));
  });

  it("bring a new lead into view sideways: a copy past the lanes' right edge", () => {
    seed({ stitch: { overlays: [text("t", { startSec: 6, endSec: 8 })] } });
    openEditor();
    const lanes = screen.getByTestId("stitch-lanes");
    Object.defineProperty(lanes, "clientWidth", { value: 300, configurable: true });
    act(() => editor().select(overlaySelectionOf({ clipId: "t" })));
    expect(lanes.scrollLeft).toBe(0);
    press("d", { metaKey: true });
    // The copy (8–10 s) starts past the 300px in view: it comes in 64px from their left
    expect(lanes.scrollLeft).toBe(x(8) - 64);
  });

  it("put their rows' scroll back with the layers on Escape", () => {
    seed({
      stitch: {
        overlays: [text("a", { startSec: 0, endSec: 1 }), text("b", { row: 1, startSec: 0, endSec: 1 }), text("c", { row: 2, startSec: 0, endSec: 1 })],
      },
    });
    openEditor();
    const block = screen.getByTestId("stitch-overlay-rows");
    expect(block.style.transform).toBe("translateY(-52px)");
    // a's block centre is at 130 in the rows block, row 0 being the lowest of three
    down(box("a"), x(0.5), 130);
    pointer("pointermove", x(0.5) + PPS, 130, { shiftKey: true });
    act(() => {
      screen.getByTestId("stitch-overlay-section").dispatchEvent(new WheelEvent("wheel", { deltaY: -30, bubbles: true, cancelable: true }));
    });
    expect(block.style.transform).toBe("translateY(-22px)");
    press("Escape");
    expect(block.style.transform).toBe("translateY(-52px)");
    pointer("pointerup", x(0.5) + PPS, 130, { shiftKey: true });
    expect(layer("a")).toMatchObject({ row: 0, startSec: 0 });
    expect(editor().past).toHaveLength(0);
  });

  it("widen the lanes to a layer past the last frame, and to one dragged past it", () => {
    seed({ stitch: { overlays: [text("t", { startSec: 20, endSec: 24 })] } });
    openEditor();
    const width = () => parseFloat((screen.getByTestId("stitch-lanes").firstElementChild as HTMLElement).style.width);
    expect(width()).toBeGreaterThanOrEqual(x(24));
    down(box("t"), x(22), 30);
    pointer("pointermove", x(22) + 10 * PPS, 30, { shiftKey: true });
    expect(width()).toBeGreaterThanOrEqual(x(34));
    press("Escape");
    pointer("pointerup", x(22) + 10 * PPS, 30);
  });

  it("zoom with no ⌘ wheel from a press on a layer, or on their rows, to the release", () => {
    seed({ stitch: { overlays: [text("t", { startSec: 1, endSec: 4 })] } });
    openEditor();
    const lanes = screen.getByTestId("stitch-lanes");
    const zoom = () => fireEvent.wheel(lanes, { metaKey: true, deltaY: -100, clientX: 400 });
    down(box("t"), x(2), 30);
    zoom();
    expect(editor().pxPerSec).toBe(PPS);
    pointer("pointerup", x(2), 30);
    // A press on the rows' empty space starts a selection box
    fireEvent.pointerDown(lane(), { button: 0, clientX: x(6), clientY: 30, pointerId: 1 });
    zoom();
    expect(editor().pxPerSec).toBe(PPS);
    pointer("pointerup", x(6), 30);
    zoom();
    expect(editor().pxPerSec).toBeGreaterThan(PPS);
  });

  it("leave focus on the video clip a layout switch takes away, not on a text layer above it", () => {
    seed({ stitch: { overlays: [text("t", { startSec: 1, endSec: 4 })] } });
    openEditor();
    const clip = (name: string) =>
      within(screen.getByRole("listbox", { name: "Clips" })).getByRole("option", { name: new RegExp(`^${name}(,|$)`) });
    const layoutButton = within(screen.getByRole("group", { name: "Timeline layout" })).getByRole("button", { name: "Stacked" });
    act(() => editor().select({ kind: "clip", clipId: "clip:eB" }));
    act(() => clip("Clip 2").focus());
    fireEvent.mouseDown(layoutButton);
    fireEvent.click(layoutButton);
    expect(editor().draft!.sequenceLayout.mode).toBe("stacked");
    expect(document.activeElement).toBe(clip("Clip 2"));
  });

  it('add a text layer from "+ Text" at the playhead, selected, its rows appearing', () => {
    seed();
    openEditor();
    act(() => editor().setPlayhead(2));
    const status = (available: boolean) =>
      ({ available, reasonCode: available ? undefined : "hosted", root: null, source: "default", defaultRoot: "/x", cacheDir: "/x", platform: "darwin" }) as LibraryStatus;
    // A text layer needs no library: "+ Text" stays on while "+ Audio" is off
    try {
      act(() => applyLibraryStatus(status(false)));
      expect(screen.getByRole("button", { name: "Add audio" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Add text" })).toBeEnabled();
      fireEvent.click(screen.getByRole("button", { name: "Add text" }));
    } finally {
      act(() => applyLibraryStatus(status(true)));
    }
    const [added] = layers();
    expect(added).toMatchObject({ startSec: 2, endSec: 6, row: 0, text: "Title" });
    expect(editor().selection).toEqual({ kind: "overlay", clipId: added.id });
    expect(box(added.id)).toHaveAttribute("aria-selected", "true");
    expect(editor().playhead).toBe(2.5);
    // Its removal takes the rows away, focus going back to the panel
    act(() => box(added.id).focus());
    press("Backspace");
    expect(screen.queryByTestId("stitch-overlay-section")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("dialog", { name: "Edit video" }));
  });
});
