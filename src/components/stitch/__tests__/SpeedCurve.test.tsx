import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useWorkflowStore } from "@/store/workflowStore";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { getEasingFunction, pointsCurve } from "@/lib/easing";
import type { StitchDraft } from "@/lib/stitch/draft";
import {
  __resetMediaInfoForTests,
  __setMediaExtractorForTests,
  __setMediaInfoForTests,
  mediaKeyOf,
  nearestFrame,
} from "@/lib/stitch/mediaInfo";
import { bakeError, formatSpeed, normalizeWarp, pointsOfWarp, warpCurve, warpMap, withWarp } from "@/lib/stitch/warp";
import type { ClipWarp, ClipWarpCurve, WorkflowEdge, WorkflowNode } from "@/types";
import { restoreStoreActions } from "@/test/storeActions";
import { HEADER_PX } from "../editorStyles";
import { StitchEditorModal } from "../StitchEditorModal";
import { openStitchEditor } from "../openStitchEditor";
import { libraryDrop } from "../timeline/libraryDrop";

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

// A clip's speed curve on its open row, inside the real editor, against the real stores. jsdom lays nothing out
// (every rect is at 0), so lane x is the pointer's clientX and a box's y is its clientY. Clip 1 (5 s) and Clip 2
// (4 s) at 64 px/s from x 20; Clip 1's open 120 px box draws output progress p at X(p) and source progress q at Y(q).

const PPS = 64;
const ORIGIN = 20;
const X = (p: number) => ORIGIN + 5 * PPS * p;
const Y = (q: number) => 12 + (1 - q) * 96;
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

function seed() {
  useWorkflowStore.setState({
    nodes: [
      node("gen-a", "generateVideo", { outputVideo: "blob:a" }),
      node("gen-b", "generateVideo", { outputVideo: "blob:b" }),
      node("stitch", "videoStitch", { clips: [], clipOrder: [], outputVideo: null, loopCount: 1, status: "idle" }),
    ],
    edges: [edge("eA", "gen-a", "video-0"), edge("eB", "gen-b", "video-1")],
    openModalCount: 0,
    isModalOpen: false,
  });
  __setMediaInfoForTests(mediaKeyOf("blob:a"), { duration: 5, width: 1920, height: 1080, fps: 24 });
  __setMediaInfoForTests(mediaKeyOf("blob:b"), { duration: 4, width: 1920, height: 1080, fps: 24 });
}

/** One clip per length (seconds, 24 fps), Clip 1 first. */
function seedClips(lengths: number[]) {
  useWorkflowStore.setState({
    nodes: [
      ...lengths.map((_, i) => node(`gen-${i}`, "generateVideo", { outputVideo: `blob:s${i}` })),
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

function openEditor() {
  render(<StitchEditorModal />);
  act(() => {
    openStitchEditor("stitch");
    editor().setZoom(PPS);
  });
}

const W = (speed: number, extra: Partial<ClipWarp> = {}): ClipWarp => ({
  speed,
  curve: null,
  reverse: false,
  blend: false,
  ...extra,
});
const points = (...p: Array<[number, number]>): ClipWarpCurve => ({ kind: "points", points: p });
const RAMP = points([0, 0], [0.3, 0.1], [0.7, 0.9], [1, 1]);
/** Clip `index` with this warp as the editor opened it: no undo step. */
const seedWarp = (index: number, warp: ClipWarp) =>
  act(() =>
    useStitchEditorStore.setState((s) => {
      const put = (d: StitchDraft) => ({
        ...d,
        timeline: d.timeline.map((c, i) => (i === index ? withWarp(c, normalizeWarp(warp)) : c)),
      });
      return { draft: put(s.draft!), initial: put(s.initial!) };
    }),
  );
const warpOf = (index = 0) => editor().draft!.timeline[index].warp;
const pointsOf = (index = 0) => {
  const curve = warpOf(index)?.curve;
  return curve?.kind === "points" ? curve.points : [];
};

const lane = () => screen.getByRole("listbox", { name: "Clips" });
const clipBox = (name: string) => within(lane()).getByRole("option", { name: new RegExp(`^${name}(,|$)`) });
const box1 = () => clipBox("Clip 1");
const rail = () => screen.getByRole("complementary", { name: "Clip" });
const timelineEl = () => screen.getByTestId("stitch-timeline");
const content = () => screen.getByTestId("stitch-lanes").firstElementChild as HTMLElement;
const lineOf = (box: HTMLElement) => within(box).getByTestId("stitch-speed-curve").querySelector("polyline")!;
const menuItem = (name: string) => within(screen.getByRole("menu")).getByRole("menuitem", { name: new RegExp(`^${name}`) });
const press = (key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });
const pointer = (type: "pointermove" | "pointerup", clientX: number, clientY: number, init: MouseEventInit = {}) =>
  act(() => {
    window.dispatchEvent(new MouseEvent(type, { clientX, clientY, bubbles: true, ...init }));
  });
const down = (el: Element, clientX: number, clientY: number, init: Record<string, unknown> = {}) =>
  fireEvent.pointerDown(el, { button: 0, clientX, clientY, pointerId: 1, ...init });
/** A press and release with no travel: a click. */
const click = (el: Element, clientX: number, clientY: number) => {
  down(el, clientX, clientY);
  pointer("pointerup", clientX, clientY);
};
/** A press, a move by (dx, dy) and the release there. */
const drag = (el: Element, x: number, y: number, dx: number, dy: number, init: Record<string, unknown> = {}) => {
  down(el, x, y, init);
  pointer("pointermove", x + dx, y + dy);
  pointer("pointerup", x + dx, y + dy);
};
/** Two presses and the dblclick a browser sends after them. */
const doubleClickAt = (el: Element, clientX: number, clientY: number) => {
  click(el, clientX, clientY);
  click(el, clientX, clientY);
  fireEvent.doubleClick(el, { clientX, clientY });
};
const rect = (left: number, top: number): DOMRect =>
  ({ left, top, right: left, bottom: top, width: 0, height: 0, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
/** Clip 1 selected, its row opened from the rail. */
const openCurve = () => {
  click(box1(), 100, 0);
  fireEvent.click(within(rail()).getByRole("button", { name: "Show speed curve" }));
};
const toStacked = () =>
  fireEvent.click(within(screen.getByRole("group", { name: "Timeline layout" })).getByRole("button", { name: "Stacked" }));
/** A ResizeObserver that measures at once on observe(); `measure()` reports again, as a browser does after layout. */
function observeSizes() {
  const globals = globalThis as { ResizeObserver?: unknown };
  const original = globals.ResizeObserver;
  const callbacks: Array<() => void> = [];
  globals.ResizeObserver = class {
    constructor(private callback: () => void) {
      callbacks.push(callback);
    }
    observe() {
      this.callback();
    }
    disconnect() {}
  };
  return {
    measure: () => act(() => callbacks.forEach((callback) => callback())),
    restore: () => {
      globals.ResizeObserver = original;
    },
  };
}
/**
 * Stacked with `count` 5 s clips, its lanes as tall as the timeline draws them at once, as a browser lays them out, and
 * their scroll kept in their content; the editor's own measure of them comes later, after its layout effects.
 * `view` is the rows' view: the lanes less the ruler and the audio section.
 */
function scrollingStacked(count: number) {
  const sizes = observeSizes();
  const lanesHeight = (el: HTMLElement) =>
    parseFloat(el.parentElement!.style.height) - 1 - parseFloat(el.style.marginBottom || "0");
  const isLanes = (el: HTMLElement) => el.dataset.testid === "stitch-lanes";
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return isLanes(this) ? lanesHeight(this) : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return isLanes(this) ? lanesHeight(this) : 0;
  });
  let scroll = 0;
  seedClips(Array.from({ length: count }, () => 5));
  openEditor();
  const lanes = screen.getByTestId("stitch-lanes");
  Object.defineProperty(lanes, "scrollTop", {
    configurable: true,
    get: () => scroll,
    set: (v: number) => {
      const content = parseFloat((lanes.firstElementChild as HTMLElement).style.height);
      scroll = Math.min(Math.max(0, v), Math.max(0, content - lanesHeight(lanes)));
    },
  });
  toStacked();
  sizes.measure();
  return { sizes, scroll: () => scroll, view: () => lanesHeight(lanes) - 28 - 80 };
}
/** The editor leaves the timeline this much room under the stage's floor (its root is this tall). */
const editorRoom = (timeline: number) =>
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("flex-col") && this.classList.contains("h-full") && this.parentElement?.getAttribute("role") !== "listbox"
      ? timeline + HEADER_PX + 344
      : 0;
  });

beforeEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  useWorkflowStore.getState().clearWorkflow();
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
  restoreStoreActions(useStitchEditorStore);
});

describe("The speed curve row", () => {
  it("opens Track's clips row from the rail, 136 px with 120 px boxes, as no undo step, whatever is selected", () => {
    seed();
    openEditor();
    expect(timelineEl().style.height).toBe("189px");
    const toggle = within(rail()).getByRole("button", { name: "Show speed curve" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(timelineEl().style.height).toBe("245px");
    expect(lane().style.height).toBe("136px");
    expect([box1().style.height, clipBox("Clip 2").style.height]).toEqual(["120px", "120px"]);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveTextContent("Hide speed curve");
    expect(within(rail()).getByText("Drag the line to add a point. Double-click a point to remove it.")).toBeInTheDocument();
    expect(editor().past).toHaveLength(0);
    // What marks the row is as tall as it: a trim's snap chip under it, a library drop's marker, the selection box
    act(() => editor().setPlayhead(4.2));
    down(box1().querySelector('[data-trim-handle="out"]')!, X(1), 40);
    pointer("pointermove", X(1) - 0.8 * PPS + 4, 40);
    expect(screen.getByTestId("stitch-snap-chip").style.top).toBe(`${28 + 136 + 12}px`);
    press("Escape");
    pointer("pointerup", X(1) - 0.8 * PPS + 4, 40);
    try {
      act(() => libraryDrop.set({ lane: "clips", mode: "track", index: 1 }, { assetId: "v", kind: "video", durationSec: 2 }));
      const marker = screen.getByTestId("library-drop-marker");
      expect([marker.style.top, marker.style.height]).toEqual(["36px", "120px"]);
    } finally {
      act(() => libraryDrop.set(null));
    }
    fireEvent.pointerDown(lane(), { button: 0, clientX: 100, clientY: 28 + 8 + 100, pointerId: 1 });
    pointer("pointermove", 400, 28 + 8 + 110);
    const marquee = screen.getByTestId("stitch-marquee");
    expect([marquee.style.top, marquee.style.height]).toEqual(["28px", "136px"]);
    pointer("pointerup", 400, 28 + 8 + 110);
    expect(editor().past).toHaveLength(0);
    // Selecting another clip keeps the row open; the clip menu closes it
    click(clipBox("Clip 2"), 400, 0);
    expect(editor().selection).toEqual({ kind: "clip", clipId: "clip:eB" });
    expect(timelineEl().style.height).toBe("245px");
    fireEvent.contextMenu(clipBox("Clip 2"), { clientX: 400, clientY: 300 });
    fireEvent.click(menuItem("Hide speed curve"));
    expect(timelineEl().style.height).toBe("189px");
    expect(box1().style.height).toBe("64px");
    // Pressing Ramp's Points opens it, and pressing Points again leaves it open
    const ramp = () => within(within(rail()).getByRole("group", { name: "Ramp" }));
    fireEvent.click(ramp().getByRole("button", { name: "Points" }));
    expect(timelineEl().style.height).toBe("245px");
    fireEvent.click(ramp().getByRole("button", { name: "Points" }));
    expect(timelineEl().style.height).toBe("245px");
    expect(within(rail()).getByRole("button", { name: "Hide speed curve" })).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps the rail's toggle and its note in view once the row opens under it", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => frames.push(cb));
    const scrolled: Element[] = [];
    const scrollIntoView = vi.fn(function (this: Element) {
      scrolled.push(this);
    });
    Object.defineProperty(Element.prototype, "scrollIntoView", { value: scrollIntoView, configurable: true });
    try {
      seed();
      openEditor();
      frames.splice(0).forEach((cb) => cb(0));
      expect(scrollIntoView).not.toHaveBeenCalled();
      fireEvent.click(within(rail()).getByRole("button", { name: "Show speed curve" }));
      act(() => frames.splice(0).forEach((cb) => cb(0)));
      const toggle = within(rail()).getByRole("button", { name: "Hide speed curve" });
      expect(scrolled.at(-1)).toBe(toggle.parentElement);
      expect(toggle.parentElement).toHaveTextContent("Drag the line to add a point.");
      expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest" });
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });

  it("gives Track's open row way first in a short window, its boxes and drawn curve with it", () => {
    const sizes = observeSizes();
    editorRoom(220);
    try {
      seed();
      openEditor();
      expect(timelineEl().style.height).toBe("189px");
      openCurve();
      // 220 px: the open row gets what the rest leaves it (111), its boxes 95
      expect(timelineEl().style.height).toBe("220px");
      expect(lane().style.height).toBe("111px");
      expect([box1().style.height, clipBox("Clip 2").style.height]).toEqual(["95px", "95px"]);
      const guide = within(box1()).getByTestId("stitch-speed-guide");
      expect([guide.getAttribute("y1"), guide.getAttribute("y2")]).toEqual(["83", "12"]);
    } finally {
      sizes.restore();
    }
  });

  it("opens a Stacked clip's own row, 132 px, and every part of the lane follows the rows under it", () => {
    seed();
    openEditor();
    toStacked();
    fireEvent.click(within(rail()).getByRole("button", { name: "Show speed curve" }));
    const band = (id: string) => document.querySelector<HTMLElement>(`[data-stacked-row="${id}"]`)!;
    const grip = (id: string) => document.querySelector<HTMLElement>(`[data-row-grip="${id}"]`)!;
    expect([band("clip:eA").style.top, band("clip:eA").style.height]).toEqual(["0px", "132px"]);
    expect([band("clip:eB").style.top, band("clip:eB").style.height]).toEqual(["132px", "52px"]);
    expect([box1().style.top, box1().style.height]).toEqual(["6px", "120px"]);
    expect([clipBox("Clip 2").style.top, clipBox("Clip 2").style.height]).toEqual(["138px", "40px"]);
    expect([grip("clip:eB").style.top, grip("clip:eB").style.height]).toEqual(["138px", "40px"]);
    // The selection box hits Clip 2 where it is drawn now (the rows start under the 28 px ruler)
    fireEvent.pointerDown(lane(), { button: 0, clientX: 100, clientY: 28 + 132 + 20, pointerId: 1 });
    pointer("pointermove", 400, 28 + 132 + 30);
    pointer("pointerup", 400, 28 + 132 + 30);
    expect(editor().selection).toEqual({ kind: "clip", clipId: "clip:eB" });
    // A library drop at the boundary under the open row
    try {
      act(() =>
        libraryDrop.set({ lane: "clips", mode: "stacked", startSec: 1, row: 1 }, { assetId: "v", kind: "video", durationSec: 2 }),
      );
      const marker = screen.getByTestId("library-drop-marker");
      expect((marker.firstElementChild as HTMLElement).style.top).toBe(`${28 + 132 - 1}px`);
    } finally {
      act(() => libraryDrop.set(null));
    }
    // The grip shown is the row's under the pointer: 60 px into the open row is still Clip 1's
    const grips = screen.getByTestId("stitch-row-grips").parentElement!;
    vi.spyOn(grips, "getBoundingClientRect").mockReturnValue({ ...rect(0, 28), bottom: 28 + 184, height: 184 });
    const shown = () => ["clip:eA", "clip:eB"].map((id) => grip(id).classList.contains("opacity-100"));
    fireEvent.pointerMove(timelineEl(), { clientX: 600, clientY: 28 + 60 });
    expect(shown()).toEqual([true, false]);
    fireEvent.pointerMove(timelineEl(), { clientX: 600, clientY: 28 + 132 + 10 });
    expect(shown()).toEqual([false, true]);
    // A move of the open box snapped to the playhead puts its chip under the 120 px box
    act(() => editor().select({ kind: "clip", clipId: "clip:eB" }));
    act(() => editor().setPlayhead(3));
    down(box1(), 100, 28 + 6 + 4);
    pointer("pointermove", 100 + 2.97 * PPS, 28 + 6 + 4);
    expect(screen.getByTestId("stitch-snap-chip").style.top).toBe(`${28 + 6 + 120 + 12}px`);
    press("Escape");
    pointer("pointerup", 100 + 2.97 * PPS, 28 + 6 + 4);
    // ⌥↓ moves Clip 1 down a row, and its row stays the open one
    act(() => editor().select({ kind: "clip", clipId: "clip:eA" }));
    press("ArrowDown", { altKey: true });
    expect(editor().draft!.timeline.map((c) => c.id)).toEqual(["clip:eB", "clip:eA"]);
    expect([band("clip:eA").style.top, band("clip:eA").style.height]).toEqual(["52px", "132px"]);
    expect(band("clip:eB").style.height).toBe("52px");
    // A group has no one speed curve
    act(() => editor().select({ kind: "clip", clipId: "clip:eA", clipIds: ["clip:eB", "clip:eA"] }));
    fireEvent.contextMenu(clipBox("Clip 1"), { clientX: 400, clientY: 300 });
    expect(menuItem("Show speed curve")).toBeDisabled();
    expect(menuItem("Show speed curve")).toHaveAttribute("title", "Select one clip");
  });

  it.each([4, 6])("shows a Stacked row opened below the view whole once the grown view is measured (%i clips)", (count) => {
    const { sizes, scroll, view } = scrollingStacked(count);
    try {
      const last = editor().draft!.timeline[count - 1].id;
      act(() => editor().select({ kind: "clip", clipId: last }));
      sizes.measure();
      // The last row shown whole in the 182 px view
      expect([scroll(), view()]).toEqual([count * 52 - 182, 182]);
      fireEvent.click(within(rail()).getByRole("button", { name: "Show speed curve" }));
      sizes.measure();
      // Its 132 px row in the view grown by 80 px, the curve's start at its bottom included
      const top = (count - 1) * 52;
      expect(view()).toBe(262);
      expect(scroll()).toBeLessThanOrEqual(top);
      expect(scroll() + view()).toBeGreaterThanOrEqual(top + 132);
    } finally {
      sizes.restore();
    }
  });

  it("keeps a Stacked row opened in view where it was on screen, the rows above shown as the view grows up", () => {
    const { sizes, scroll, view } = scrollingStacked(6);
    try {
      act(() => editor().select({ kind: "clip", clipId: editor().draft!.timeline[5].id }));
      sizes.measure();
      act(() => editor().select({ kind: "clip", clipId: editor().draft!.timeline[3].id }));
      sizes.measure();
      // Clip 4's row (156–208) is 26 px into the 182 px view, whose bottom stays put on screen as it grows
      const onScreen = (rowTop: number) => rowTop - scroll() - view();
      expect([scroll(), view()]).toEqual([130, 182]);
      const before = [onScreen(156), onScreen(104)];
      fireEvent.click(within(rail()).getByRole("button", { name: "Show speed curve" }));
      // At once, from the growth the scroller reports, and not again once the editor measures it
      expect([scroll(), view(), onScreen(156), onScreen(104)]).toEqual([50, 262, ...before]);
      sizes.measure();
      expect([scroll(), view(), onScreen(156), onScreen(104)]).toEqual([50, 262, ...before]);
    } finally {
      sizes.restore();
    }
  });

  it("edits the curve on Stacked's open row, and leaves the box a press on the line that adds no point", () => {
    seedClips([60, 4]);
    openEditor();
    seedWarp(0, W(1, { curve: RAMP }));
    toStacked();
    openCurve();
    // A minute at 64 px/s: 3840 px
    const XL = (p: number) => ORIGIN + 60 * PPS * p;
    expect(within(box1()).getByTestId("stitch-speed-curve")).toBeInTheDocument();
    expect(within(box1()).getAllByTestId("stitch-speed-point")).toHaveLength(2);
    expect(within(clipBox("Clip 2")).queryByTestId("stitch-speed-curve")).toBeNull();
    const starts = () => editor().draft!.timeline.map((c) => c.startSec);
    const before = starts();
    const steps = editor().past.length;
    // A knot dragged: one step, the clip where it was (the curve took the press, not the move)
    drag(box1(), XL(0.3), Y(0.1), 16, -8);
    expect(pointsOf()[1]).toEqual([expect.closeTo(0.3 + 16 / 3840, 9), expect.closeTo(0.1 + 8 / 96, 9)]);
    expect(starts()).toEqual(before);
    expect(editor().past).toHaveLength(steps + 1);
    const knots = pointsOf();
    const lineY = (p: number) => Y(pointsCurve(knots).ease(p));
    // 70 px along the line from a knot, within its gap, a press drags that knot: no hint of a point added there, the
    // knot drawn larger; a double-click there removes nothing
    const off = 0.3 + (16 + 70) / 3840;
    fireEvent.pointerMove(box1(), { clientX: XL(off), clientY: lineY(off) });
    expect(screen.queryByTestId("stitch-speed-add-point")).toBeNull();
    expect(within(box1()).getAllByTestId("stitch-speed-point").map((k) => k.getAttribute("r"))).toEqual(["6", "4"]);
    doubleClickAt(box1(), XL(off), lineY(off));
    expect(pointsOf()).toEqual(knots);
    // Within the gap of an end the line adds nothing: no hint there, and a drag moves the clip
    fireEvent.pointerMove(box1(), { clientX: XL(0.5), clientY: lineY(0.5) });
    expect(screen.getByTestId("stitch-speed-add-point")).toBeInTheDocument();
    fireEvent.pointerMove(box1(), { clientX: XL(0.015), clientY: lineY(0.015) });
    expect(screen.queryByTestId("stitch-speed-add-point")).toBeNull();
    drag(box1(), XL(0.015), lineY(0.015), PPS, 0);
    expect(editor().draft!.timeline[0].startSec).toBeCloseTo(1, 6);
    expect(pointsOf()).toEqual(knots);
  });

  it("draws the time remap over the frames: the wash, the average speed's diagonal, the line, a points curve's knots", () => {
    seed();
    openEditor();
    seedWarp(0, W(1, { curve: points([0, 0], [0.5, 0.25], [1, 1]) }));
    expect(within(box1()).queryByTestId("stitch-speed-curve")).toBeNull();
    openCurve();
    expect(within(box1()).getByTestId("stitch-speed-wash")).toHaveClass("bg-black/45");
    const guide = within(box1()).getByTestId("stitch-speed-guide");
    expect(["x1", "y1", "x2", "y2"].map((a) => guide.getAttribute(a))).toEqual(["0", "108", "320", "12"]);
    expect(lineOf(box1())).toHaveClass("stroke-neutral-100");
    expect(lineOf(clipBox("Clip 2"))).toHaveClass("stroke-white/35");
    const knots = within(box1()).getAllByTestId("stitch-speed-point");
    expect(knots).toHaveLength(1);
    expect(["cx", "cy", "r"].map((a) => knots[0].getAttribute(a))).toEqual(["160", "84", "4"]);
    // An unselected clip's points curve is its line alone
    seedWarp(1, W(1, { curve: points([0, 0], [0.5, 0.25], [1, 1]) }));
    expect(within(clipBox("Clip 2")).queryAllByTestId("stitch-speed-point")).toHaveLength(0);
    // A preset and a split piece are a line alone
    seedWarp(0, W(1, { curve: { kind: "preset", name: "easeInQuad" } }));
    expect(within(box1()).queryAllByTestId("stitch-speed-point")).toHaveLength(0);
    seedWarp(0, W(1, { curve: points([0, 0], [0.5, 0.25], [1, 1]), window: [0.2, 0.8] }));
    expect(within(box1()).getByTestId("stitch-speed-curve")).toBeInTheDocument();
    expect(within(box1()).queryAllByTestId("stitch-speed-point")).toHaveLength(0);
    fireEvent.click(within(rail()).getByRole("button", { name: "Hide speed curve" }));
    expect(within(box1()).queryByTestId("stitch-speed-curve")).toBeNull();
  });

  it("edits only the single selected clip of an open row", () => {
    seed();
    openEditor();
    openCurve();
    // Clip 2 (5–9 s) is not selected: a press on its line selects it, and adds nothing
    click(clipBox("Clip 2"), 340 + 256 * 0.5, Y(0.5));
    expect(editor().selection).toEqual({ kind: "clip", clipId: "clip:eB" });
    // Two selected: a drag on Clip 1's line adds nothing
    act(() => editor().select({ kind: "clip", clipId: "clip:eA", clipIds: ["clip:eA", "clip:eB"] }));
    drag(box1(), X(0.5), Y(0.5), 0, -3);
    // Selected on a closed row: nothing
    act(() => editor().select({ kind: "clip", clipId: "clip:eA" }));
    fireEvent.click(within(rail()).getByRole("button", { name: "Hide speed curve" }));
    drag(box1(), X(0.5), 30, 0, -3);
    expect(editor().past).toHaveLength(0);
    expect("warp" in editor().draft!.timeline[0]).toBe(false);
  });

  it("removes a knot on a double-click, in one step; a straight line left at 1× is no warp", () => {
    seed();
    openEditor();
    seedWarp(0, W(1, { curve: RAMP }));
    openCurve();
    doubleClickAt(box1(), X(0.3), Y(0.1));
    expect(pointsOf()).toEqual([
      [0, 0],
      [0.7, 0.9],
      [1, 1],
    ]);
    expect(editor().past).toHaveLength(1);
    seedWarp(0, W(1, { curve: points([0, 0], [0.5, 0.5], [0.7, 0.9], [1, 1]) }));
    doubleClickAt(box1(), X(0.7), Y(0.9));
    expect("warp" in editor().draft!.timeline[0]).toBe(false);
    expect(editor().past).toHaveLength(2);
  });

  it("stores nothing for a click or a double-click on the line; a press that travels adds one point", () => {
    seed();
    openEditor();
    seedWarp(0, W(1, { curve: RAMP }));
    openCurve();
    click(box1(), X(0.5), Y(0.5));
    doubleClickAt(box1(), X(0.5), Y(0.5));
    expect(editor().past).toHaveLength(0);
    expect(pointsOf()).toEqual(RAMP.kind === "points" ? RAMP.points : []);
    drag(box1(), X(0.5), Y(0.5), 0, -4);
    expect(pointsOf()).toHaveLength(5);
    expect(pointsOf()[2]).toEqual([0.5, expect.closeTo(0.5 + 4 / 96, 9)]);
    expect(editor().past).toHaveLength(1);
  });

  it("drags a knot in one undo step, with its momentary speed and sequence time beside it", () => {
    seed();
    openEditor();
    seedWarp(0, W(1, { curve: RAMP }));
    openCurve();
    const before = pointsOf();
    down(box1(), X(0.3), Y(0.1));
    pointer("pointermove", X(0.4), Y(0.2));
    // The drag is the hook's: the draft has not moved, the readout follows the knot
    expect(pointsOf()).toBe(before);
    // The knot's momentary speed (the slope there times the average speed), then its sequence time
    const at = (speed: number) => normalizeWarp(W(speed, { curve: points([0, 0], [0.4, 0.2], [0.7, 0.9], [1, 1]) }))!;
    expect(screen.getByTestId("stitch-speed-readout").textContent).toBe(
      `${formatSpeed(warpMap({ inSec: 0, outSec: 5 }, at(1)).speedAt(0.4 * 5))}0:02.00`,
    );
    expect(within(box1()).getAllByTestId("stitch-speed-point")[0]).toHaveAttribute("r", "6");
    pointer("pointerup", X(0.4), Y(0.2));
    expect(pointsOf()[1]).toEqual([expect.closeTo(0.4, 9), expect.closeTo(0.2, 9)]);
    expect(pointsOf().filter((_, i) => i !== 1)).toEqual(before.filter((_, i) => i !== 1));
    expect(editor().past).toHaveLength(1);
    expect(screen.queryByTestId("stitch-speed-readout")).toBeNull();
    // Its length is the clip's own: the remap moves frames, never the clip's end
    expect(within(box1()).getByText("5.0 s")).toBeInTheDocument();
    press("z", { metaKey: true });
    expect(pointsOf()).toEqual(before);
    // At 2× the box is half as long and the knot twice as fast; the speed stays the clip's
    seedWarp(0, W(2, { curve: RAMP }));
    const X2 = (p: number) => ORIGIN + 2.5 * PPS * p;
    down(box1(), X2(0.3), Y(0.1));
    pointer("pointermove", X2(0.4), Y(0.2));
    expect(screen.getByTestId("stitch-speed-readout").textContent).toBe(
      `${formatSpeed(warpMap({ inSec: 0, outSec: 5 }, at(2)).speedAt(0.4 * 2.5))}0:01.00`,
    );
    pointer("pointerup", X2(0.4), Y(0.2));
    expect(pointsOf()[1]).toEqual([expect.closeTo(0.4, 9), expect.closeTo(0.2, 9)]);
    expect(warpOf()?.speed).toBe(2);
  });

  it("turns a preset, a bezier or a split piece into points on the first drag, keeping its other knots on its curve", () => {
    seed();
    openEditor();
    seedWarp(0, W(1, { curve: { kind: "preset", name: "easeInOutSine" } }));
    openCurve();
    expect(within(rail()).getByText("Dragging the line turns the ramp into points.")).toBeInTheDocument();
    // A click there stores nothing, and the line is the preset's all through the press
    const shown = lineOf(box1()).getAttribute("points");
    down(box1(), X(0.5), Y(0.5));
    expect(lineOf(box1()).getAttribute("points")).toBe(shown);
    pointer("pointerup", X(0.5), Y(0.5));
    expect(warpOf()?.curve).toEqual({ kind: "preset", name: "easeInOutSine" });
    expect(editor().past).toHaveLength(0);
    const seeded = warpOf()!;
    drag(box1(), X(0.5), Y(0.5), 0, -4);
    expect(warpOf()?.curve?.kind).toBe("points");
    const ease = getEasingFunction("easeInOutSine");
    // The knot pressed, where it was pressed, moved by the drag
    const moved = pointsOf().findIndex(([p]) => Math.abs(p - 0.5) < 0.02);
    expect(pointsOf()[moved]).toEqual([0.5, expect.closeTo(0.5 + 4 / 96, 9)]);
    pointsOf().forEach(([p, q], i) => {
      if (i !== moved) expect(Math.abs(q - ease(p))).toBeLessThan(1e-9);
    });
    // Baked at the clip's own budget (half a frame of its 5 s at 24 fps), not the default one, which is coarser
    const bake = pointsOfWarp(seeded, bakeError(5, 24), 0.5)!.points;
    expect(bake.length).toBeGreaterThan(pointsOfWarp(seeded, undefined, 0.5)!.points.length);
    expect(pointsOf().filter((_, i) => i !== moved)).toEqual(bake.filter(([p]) => p !== 0.5));
    expect(editor().past).toHaveLength(1);
    for (const warp of [
      W(1, { curve: { kind: "bezier", handles: [0.42, 0, 0.58, 1] } }),
      W(1, { curve: points([0, 0], [0.5, 0.25], [1, 1]), window: [0.2, 0.8] }),
    ]) {
      seedWarp(0, warp);
      const played = warpOf()!;
      const curve = warpCurve(played.curve, played.window).ease;
      drag(box1(), X(0.6), Y(curve(0.6)), 0, -4);
      expect(warpOf()?.curve?.kind).toBe("points");
      expect("window" in warpOf()!).toBe(false);
      // The curve it played, baked: every knot but the dragged one on it, more of them than a straight line has
      const dragged = pointsOf().findIndex(([p]) => Math.abs(p - 0.6) < 0.02);
      expect(pointsOf().length).toBeGreaterThan(3);
      pointsOf().forEach(([p, q], i) => {
        if (i !== dragged) expect(Math.abs(q - curve(p))).toBeLessThan(1e-6);
      });
      expect(pointsOf()[dragged][0]).toBe(0.6);
      const baked = pointsOfWarp(played, bakeError(5, 24), 0.6)!.points;
      expect(pointsOf().filter((_, i) => i !== dragged)).toEqual(baked.filter(([p]) => p !== 0.6));
    }
    expect(editor().past).toHaveLength(3);
  });

  it("adds the knot under the pointer on a preset's line, even where its bake would have put one beside it", () => {
    seed();
    openEditor();
    seedWarp(0, W(1, { curve: { kind: "preset", name: "easeInOutSine" } }));
    openCurve();
    const ease = getEasingFunction("easeInOutSine");
    const bake = pointsOfWarp(warpOf()!, bakeError(5, 24))!.points;
    // Half a gap past a knot of the clip's bake
    const beside = bake[Math.floor(bake.length / 2)][0];
    const p = beside + 0.01;
    fireEvent.pointerMove(box1(), { clientX: X(p), clientY: Y(ease(p)) });
    expect(screen.getByTestId("stitch-speed-add-point")).toBeInTheDocument();
    drag(box1(), X(p), Y(ease(p)), 0, -4);
    const knot = pointsOf().find(([x]) => Math.abs(x - p) < 1e-9);
    expect(knot?.[1]).toBeGreaterThan(ease(p));
    expect(pointsOf().some(([x]) => x === beside)).toBe(false);
    expect(editor().past).toHaveLength(1);
  });

  it("shows a press near a knot on a long clip's line as that knot's, and adds a knot under the pointer clear of it", () => {
    seedClips([60, 4]);
    openEditor();
    seedWarp(0, W(1, { curve: RAMP }));
    openCurve();
    // A minute at 64 px/s: 3840 px, so a knot's gap reaches 77 px along the line
    const XL = (p: number) => ORIGIN + 60 * PPS * p;
    const lineY = (p: number) => Y(pointsCurve(pointsOf()).ease(p));
    const near = 0.3 + 40 / 3840;
    fireEvent.pointerMove(box1(), { clientX: XL(near), clientY: lineY(near) });
    expect(screen.queryByTestId("stitch-speed-add-point")).toBeNull();
    expect(box1()).toHaveClass("cursor-grab");
    expect(within(box1()).getAllByTestId("stitch-speed-point").map((k) => k.getAttribute("r"))).toEqual(["6", "4"]);
    // The drag moves that knot by the pointer's travel, and adds none
    drag(box1(), XL(near), lineY(near), 0, -10);
    expect(pointsOf()).toEqual([
      [0, 0],
      [expect.closeTo(0.3, 9), expect.closeTo(0.1 + 10 / 96, 9)],
      [0.7, 0.9],
      [1, 1],
    ]);
    expect(editor().past).toHaveLength(1);
    // Clear of the gap the hint shows, and the drag adds a knot where it was pressed
    const clear = 0.3 + 100 / 3840;
    fireEvent.pointerMove(box1(), { clientX: XL(clear), clientY: lineY(clear) });
    expect(screen.getByTestId("stitch-speed-add-point")).toBeInTheDocument();
    expect(box1()).toHaveClass("cursor-pointer");
    drag(box1(), XL(clear), lineY(clear), 0, -4);
    expect(pointsOf()).toHaveLength(5);
    expect(pointsOf()[2][0]).toBeCloseTo(clear, 9);
    expect(editor().past).toHaveLength(2);
  });

  it("leaves a Mac's Ctrl-press on the curve to the clip menu, and a toggle or range click on it to the selection", () => {
    seed();
    openEditor();
    seedWarp(0, W(1, { curve: RAMP }));
    openCurve();
    const before = warpOf();
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    // On knot 1: the menu opens on it, and a travel before the release drags nothing
    down(box1(), X(0.3), Y(0.1), { ctrlKey: true });
    fireEvent.contextMenu(box1(), { clientX: X(0.3), clientY: Y(0.1), ctrlKey: true });
    expect(menuItem("Hide speed curve")).toBeInTheDocument();
    pointer("pointermove", X(0.3) + 10, Y(0.1) - 10, { ctrlKey: true });
    pointer("pointerup", X(0.3) + 10, Y(0.1) - 10, { ctrlKey: true });
    press("Escape");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(warpOf()).toBe(before);
    expect(editor().past).toHaveLength(0);
    // A ⇧-press on a knot is a range click: it drags nothing
    drag(box1(), X(0.3), Y(0.1), 0, -10, { shiftKey: true });
    expect(warpOf()).toBe(before);
    // ⌘-click on the line takes the clip out of the selection, as anywhere on the box
    down(box1(), X(0.5), Y(0.5), { metaKey: true });
    pointer("pointerup", X(0.5), Y(0.5), { metaKey: true });
    expect(editor().selection).toBeNull();
    expect(warpOf()).toBe(before);
  });

  it("adds a ramp to a clip at its own speed by a drag on its diagonal; a click there stores nothing", () => {
    seed();
    openEditor();
    openCurve();
    click(box1(), X(0.5), Y(0.5));
    expect("warp" in editor().draft!.timeline[0]).toBe(false);
    drag(box1(), X(0.5), Y(0.5), 0, -30);
    expect(warpOf()).toEqual({
      speed: 1,
      curve: points([0, 0], [0.5, expect.closeTo(0.5 + 30 / 96, 9)], [1, 1]),
      reverse: false,
      blend: false,
    });
    expect(editor().past).toHaveLength(1);
  });

  it("takes a press with ⌥ held as a plain one: there is no line move", () => {
    seed();
    openEditor();
    openCurve();
    drag(box1(), X(0.5), Y(0.5), 0, -30, { altKey: true });
    expect(pointsOf()).toHaveLength(3);
    drag(box1(), X(0.5), Y(0.5 + 30 / 96), 0, 10, { altKey: true });
    expect(pointsOf()).toHaveLength(3);
    expect(pointsOf()[1][1]).toBeCloseTo(0.5 + 20 / 96, 9);
  });

  it("keeps time from running backwards: a knot stays between its neighbours, the ends stay put", () => {
    seed();
    openEditor();
    seedWarp(0, W(1, { curve: RAMP }));
    openCurve();
    // Below its left neighbour: at its height
    drag(box1(), X(0.7), Y(0.9), 0, Y(0) - Y(0.9));
    expect(pointsOf()[2]).toEqual([0.7, expect.closeTo(0.1, 9)]);
    // Past its right neighbour: the gap short of it
    drag(box1(), X(0.3), Y(0.1), X(0.9) - X(0.3), 0);
    expect(pointsOf()[1][0]).toBeCloseTo(0.68, 9);
    expect(editor().past).toHaveLength(2);
    // Within the gap of an end the curve takes no press: the box's vertical drag moves no Track clip
    const ease = pointsCurve(pointsOf()).ease;
    drag(box1(), X(0.01), Y(ease(0.01)), 0, -20);
    expect(editor().past).toHaveLength(2);
    expect(pointsOf()).toHaveLength(4);
  });

  it("cancels a drag on Escape, leaving the warp and the editor as they were", () => {
    seed();
    openEditor();
    seedWarp(0, W(1, { curve: RAMP }));
    openCurve();
    const before = warpOf();
    down(box1(), X(0.3), Y(0.1));
    pointer("pointermove", X(0.5), Y(0.5));
    press("Escape");
    pointer("pointerup", X(0.5), Y(0.5));
    expect(warpOf()).toBe(before);
    expect(editor().past).toHaveLength(0);
    expect(editor().isOpen).toBe(true);
    expect(editor().discardOpen).toBe(false);
  });

  it("drops a release onto a warp that changed under the drag", () => {
    seed();
    openEditor();
    seedWarp(0, W(1, { curve: RAMP }));
    openCurve();
    down(box1(), X(0.3), Y(0.1));
    pointer("pointermove", X(0.4), Y(0.2));
    act(() =>
      editor().apply((d) => ({
        ...d,
        timeline: d.timeline.map((c, i) => (i === 0 ? withWarp(c, normalizeWarp(W(2))) : c)),
      })),
    );
    pointer("pointerup", X(0.4), Y(0.2));
    expect(warpOf()).toEqual(W(2));
  });

  it("keeps a dragged knot under the pointer when the lanes scroll mid-drag", () => {
    seed();
    openEditor();
    seedWarp(0, W(1, { curve: points([0, 0], [0.2, 0.1], [1, 1]) }));
    openCurve();
    down(box1(), X(0.2), Y(0.1));
    pointer("pointermove", X(0.2) + 10, Y(0.1));
    expect(screen.getByTestId("stitch-speed-readout")).toHaveTextContent(/0:01\.1\d/);
    // The lanes scroll 2 s with the pointer held still
    vi.spyOn(content(), "getBoundingClientRect").mockReturnValue(rect(-2 * PPS, 0));
    act(() => {
      screen.getByTestId("stitch-lanes").dispatchEvent(new Event("scroll"));
    });
    expect(screen.getByTestId("stitch-speed-readout")).toHaveTextContent(/0:03\.1\d/);
    pointer("pointerup", X(0.2) + 10, Y(0.1));
    expect(pointsOf()[1][0]).toBeCloseTo(0.2 + (10 + 2 * PPS) / 320, 9);
  });

  it("moves nothing for a 1 px nudge, shows the cursors and the hint, and hides the hover mute button on the edited box", () => {
    seed();
    openEditor();
    seedWarp(0, W(1, { curve: RAMP }));
    openCurve();
    fireEvent.pointerMove(box1(), { clientX: X(0.3), clientY: Y(0.1) });
    expect(box1()).toHaveClass("cursor-grab");
    fireEvent.pointerMove(box1(), { clientX: X(0.5), clientY: Y(0.5) + 1 });
    expect(box1()).toHaveClass("cursor-pointer");
    const hint = screen.getByTestId("stitch-speed-add-point");
    expect(hint).toHaveTextContent("Drag to add point");
    expect(hint.style.left).toBe(`${X(0.5) + 6}px`);
    fireEvent.pointerLeave(box1());
    expect(screen.queryByTestId("stitch-speed-add-point")).toBeNull();
    drag(box1(), X(0.3), Y(0.1), 1, 1);
    expect(editor().past).toHaveLength(0);
    expect(box1().querySelector('button[aria-label="Mute clip audio"]')).toBeNull();
    expect(clipBox("Clip 2").querySelector('button[aria-label="Mute clip audio"]')).not.toBeNull();
  });

  it("removes the clip on ⌫ after a curve drag: its knots are not selectable", () => {
    seed();
    openEditor();
    seedWarp(0, W(1, { curve: RAMP }));
    openCurve();
    drag(box1(), X(0.3), Y(0.1), 10, 0);
    expect(editor().past).toHaveLength(1);
    press("Backspace");
    expect(editor().draft!.timeline.map((c) => c.id)).toEqual(["clip:eB"]);
  });

  it("closes the row when its clip goes, and an undo brings the clip back closed", () => {
    seed();
    openEditor();
    openCurve();
    expect(timelineEl().style.height).toBe("245px");
    press("Backspace");
    expect(timelineEl().style.height).toBe("189px");
    press("z", { metaKey: true });
    expect(editor().draft!.timeline).toHaveLength(2);
    expect(timelineEl().style.height).toBe("189px");
    expect(editor().videoExpandedClip).toBeNull();
  });

  it("draws a reversed clip's remap rising like the forward one, its wider cells running backwards", () => {
    seed();
    const frames = Array.from({ length: 12 }, (_, i) => `data:image/png;base64,frame${i}`);
    __setMediaInfoForTests(mediaKeyOf("blob:a"), { duration: 5, frames });
    openEditor();
    const curve = points([0, 0], [0.5, 0.25], [1, 1]);
    seedWarp(0, W(1, { curve }));
    openCurve();
    const forward = lineOf(box1()).getAttribute("points");
    const reversed = W(1, { curve, reverse: true });
    seedWarp(0, reversed);
    expect(lineOf(box1()).getAttribute("points")).toBe(forward);
    const cells = Array.from(box1().querySelectorAll("img"));
    expect((cells[0].parentElement as HTMLElement).style.width).toBe("105px");
    const at = (k: number) => warpMap({ inSec: 0, outSec: 5 }, normalizeWarp(reversed)!).sourceTimeAt((k * 105 + 52.5) / PPS);
    const info = { frames, duration: 5 };
    expect(cells.map((img) => img.getAttribute("src"))).toEqual(cells.map((_, k) => nearestFrame(info, at(k))));
    expect(at(0)).toBeGreaterThan(at(1));
  });

  it("lets a knot under the In handle be dragged, while a press on the handle away from it trims", () => {
    seed();
    openEditor();
    seedWarp(0, W(1, { curve: points([0, 0], [0.02, 0.3], [1, 1]) }));
    openCurve();
    const hit = box1().querySelector<SVGCircleElement>('[data-speed-hit="1"]')!;
    expect(["cx", "cy", "r"].map((a) => hit.getAttribute(a))).toEqual(["6.4", String(Y(0.3)), "7"]);
    drag(hit, X(0.02), Y(0.3), 10, 0);
    expect(pointsOf()[1][0]).toBeCloseTo(0.02 + 10 / 320, 9);
    expect(editor().past).toHaveLength(1);
    expect(editor().draft!.timeline[0].inSec).toBe(0);
    const handle = box1().querySelector<HTMLElement>('[data-trim-handle="in"]')!;
    drag(handle, X(0), 20, PPS, 0);
    expect(editor().draft!.timeline[0].inSec).toBeCloseTo(1, 6);
    expect(editor().past).toHaveLength(2);
  });

  it("moves a lifted Track box's line with the box", () => {
    seed();
    openEditor();
    openCurve();
    const guide = () => within(clipBox("Clip 2")).getByTestId("stitch-speed-guide");
    // Clip 2's box is inset 1 px at its join: its time starts 1 px left of the box's own left
    expect(guide().getAttribute("x1")).toBe("-1");
    const left = parseFloat(clipBox("Clip 2").style.left);
    down(clipBox("Clip 2"), 400, 30);
    pointer("pointermove", 550, 30);
    expect(parseFloat(clipBox("Clip 2").style.left)).toBe(left + 150);
    expect(guide().getAttribute("x1")).toBe("-1");
    press("Escape");
    pointer("pointerup", 550, 30);
  });

  it("leaves Stacked's rows where they are while playing through an open row taller than their view", () => {
    const sizes = observeSizes();
    // The editor leaves the timeline its least height: an 80 px rows view
    editorRoom(100);
    try {
      seed();
      openEditor();
      toStacked();
      fireEvent.click(within(rail()).getByRole("button", { name: "Show speed curve" }));
      expect(timelineEl().style.height).toBe("189px");
      const lanes = screen.getByTestId("stitch-lanes");
      lanes.scrollTop = 30;
      act(() => editor().setPlaying(true));
      for (const t of [0.5, 1, 1.5]) act(() => editor().setPlayhead(t));
      expect(lanes.scrollTop).toBe(30);
      act(() => editor().setPlaying(false));
    } finally {
      sizes.restore();
    }
  });
});
