import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { overlaySelectionOf, setLivePlayhead, useStitchEditorStore } from "@/store/stitchEditorStore";
import type { StitchDraft } from "@/lib/stitch/draft";
import { createTextOverlay, moveOverlays } from "@/lib/stitch/overlays";
import { DEFAULT_SEQUENCE_LAYOUT } from "@/lib/stitch/stack";
import { createClip, type SourceKey } from "@/lib/stitch/timeline";
import type { StitchOverlay } from "@/types";
import { removeSelection } from "../editorActions";
import {
  addTextOverlay,
  canEndOverlayAtPlayhead,
  canMoveOverlayRow,
  canSplitOverlaysAtPlayhead,
  canStartOverlayAtPlayhead,
  endSelectedOverlayAtPlayhead,
  moveOverlaysBody,
  moveSelectedOverlayRow,
  nudgeSelectedOverlays,
  removeOverlaySelection,
  setOverlayEdgeAtPlayhead,
  setOverlayLength,
  setOverlayStart,
  splitSelectedOverlaysAtPlayhead,
  startSelectedOverlayAtPlayhead,
  takeOverlayTextFocus,
  trimOverlayBody,
  updateOverlay,
} from "../overlayActions";

vi.mock("@/components/Toast", () => ({ useToast: { getState: () => ({ show: vi.fn() }) } }));

// The editor's text layer actions over the real store: each one recipe of overlays.ts, applied once.

const store = () => useStitchEditorStore.getState();
const text = (id: string, init: Partial<StitchOverlay> = {}) => createTextOverlay({ id, ...init });

/** Two 5 s video clips (a 10 s sequence, unless `video` is false) and these text layers. */
function openOn(overlays: StitchOverlay[] = [], { video = true }: { video?: boolean } = {}) {
  const draft: StitchDraft = {
    timeline: video
      ? [createClip({ kind: "edge", edgeId: "e1" }, { id: "a" }), createClip({ kind: "edge", edgeId: "e2" }, { id: "b" })]
      : [],
    audioClips: [],
    legacyAudio: { curve: [], muted: false },
    loopCount: 1,
    sequenceLayout: DEFAULT_SEQUENCE_LAYOUT,
    ...(overlays.length > 0 ? { overlays } : {}),
  };
  store().open({ nodeId: "n1", draft, canvasGeneration: 1 });
  store().setDurations(
    new Map<SourceKey, number>([
      ["edge:e1", 5],
      ["edge:e2", 5],
    ]),
  );
}

const layers = () => store().draft!.overlays ?? [];
const layer = (id: string) => layers().find((o) => o.id === id)!;
const select = (...ids: string[]) =>
  store().select(overlaySelectionOf({ clipId: ids[0], ...(ids.length > 1 ? { clipIds: ids } : {}) }));

beforeEach(() => store().close());
afterEach(() => store().close());

describe("adding a text layer", () => {
  it("adds one at the playhead over a paused preview, selects it, and moves the playhead to where its fade in ends", () => {
    openOn();
    store().setPlayhead(3);
    store().setPlaying(true);
    store().openMenu({ kind: "clip", clipId: "a", x: 0, y: 0 });
    const id = addTextOverlay();
    expect(layers()).toEqual([expect.objectContaining({ id, row: 0, startSec: 3, endSec: 7, text: "Title" })]);
    expect(store().selection).toEqual({ kind: "overlay", clipId: id });
    expect(store().past).toHaveLength(1);
    expect(store().playing).toBe(false);
    expect(store().menu).toBeNull();
    expect(store().playhead).toBe(3.5);
  });

  it("starts on the frame the preview stopped on, not the store's last write while playing", () => {
    openOn();
    store().setPlayhead(3);
    store().setPlaying(true);
    // The frame loop is 90 ms past the store's last write when the click lands
    setLivePlayhead(3.09);
    const id = addTextOverlay()!;
    expect(layer(id)).toMatchObject({ startSec: 3.09 });
    expect(store().playhead).toBeCloseTo(3.59, 9);
  });

  it("starts at 0:00 when the playhead is at the end, keeping the playhead before the last frame", () => {
    openOn();
    store().setPlayhead(10);
    addTextOverlay();
    expect(layers()[0]).toMatchObject({ startSec: 0, endSec: 4 });
    expect(store().playhead).toBe(0.5);
    // Just before the end: it starts there, and the playhead stops on the last frame
    store().setPlayhead(9.8);
    addTextOverlay();
    expect(layers().map((o) => o.startSec)).toEqual([0, 9.8]);
    expect(store().playhead).toBeCloseTo(10 - 1 / 60, 9);
  });

  it("goes on the first row with room, else a new row in front", () => {
    openOn([text("t", { startSec: 2, endSec: 6 })]);
    store().setPlayhead(1);
    const front = addTextOverlay()!;
    expect(layer(front).row).toBe(1);
    store().setPlayhead(8);
    const back = addTextOverlay()!;
    expect(layer(back)).toMatchObject({ row: 0, startSec: 8 });
  });

  it("starts a second press with the layer it just added, a row up, so the two share a start", () => {
    openOn();
    store().setPlayhead(2);
    const title = addTextOverlay()!;
    expect(store().playhead).toBe(2.5);
    const subtitle = addTextOverlay()!;
    expect(layer(subtitle)).toMatchObject({ startSec: 2, row: 1 });
    expect(layer(title)).toMatchObject({ startSec: 2, row: 0 });
    expect(store().past).toHaveLength(2);
    // The playhead moved since: the next one starts there
    store().setPlayhead(4);
    expect(layer(addTextOverlay()!).startSec).toBe(4);
  });

  it("asks the rail to focus the new layer's text, once, and only for that layer", () => {
    openOn();
    const first = addTextOverlay()!;
    expect(takeOverlayTextFocus(first)).toBe(true);
    expect(takeOverlayTextFocus(first)).toBe(false);
    const second = addTextOverlay()!;
    // A rail for another layer clears the request: it never outlives the rail it was meant for
    expect(takeOverlayTextFocus(first)).toBe(false);
    expect(takeOverlayTextFocus(second)).toBe(false);
  });

  it("starts at 0:00 with no video, and leaves the playhead alone", () => {
    openOn([], { video: false });
    const id = addTextOverlay()!;
    expect(layer(id)).toMatchObject({ startSec: 0, endSec: 4, row: 0 });
    expect(store().playhead).toBe(0);
    // A second press stacks it on a row of its own
    expect(layer(addTextOverlay()!)).toMatchObject({ startSec: 0, row: 1 });
  });
});

describe("moving and trimming text layers", () => {
  it("applies a drag's release once, and drops it when the overlays changed under the drag", () => {
    openOn([text("t", { startSec: 1, endSec: 3 })]);
    const from = layers();
    moveOverlaysBody(from, moveOverlays(from, ["t"], 2, 1));
    expect(layer("t")).toMatchObject({ startSec: 3, endSec: 5, row: 1 });
    expect(store().past).toHaveLength(1);
    // Stale: the press's list is no longer the draft's
    moveOverlaysBody(from, moveOverlays(from, ["t"], 4, 0));
    trimOverlayBody(from, "t", { endSec: 9 });
    expect(layer("t")).toMatchObject({ startSec: 3, endSec: 5 });
    expect(store().past).toHaveLength(1);
    trimOverlayBody(layers(), "t", { endSec: 9 });
    expect(layer("t").endSec).toBe(9);
    expect(store().past).toHaveLength(2);
  });

  it("nudges the selected layers a frame (⇧: ten), in Track; a held key is one step", () => {
    openOn([text("t", { startSec: 2, endSec: 4 }), text("u", { row: 1, startSec: 5, endSec: 6 })]);
    select("t", "u");
    nudgeSelectedOverlays(1, false, false);
    nudgeSelectedOverlays(1, false, true);
    expect(layer("t").startSec).toBeCloseTo(2 + 2 / 60, 9);
    expect(layer("u").endSec).toBeCloseTo(6 + 2 / 60, 9);
    expect(store().past).toHaveLength(1);
    nudgeSelectedOverlays(-1, true, false);
    expect(layer("t").startSec).toBeCloseTo(2 + 2 / 60 - 10 / 60, 9);
    expect(store().past).toHaveLength(2);
  });

  it("moves rows: up is in front and always possible (a new row on top), down needs a row below", () => {
    openOn([text("t", { startSec: 0, endSec: 2 }), text("u", { row: 1, startSec: 0, endSec: 2 })]);
    select("t");
    expect(canMoveOverlayRow(store(), -1)).toBe(false);
    expect(canMoveOverlayRow(store(), 1)).toBe(true);
    // Row 1 holds u at the same time: t goes onto a new row inserted above it, and row 0 stays until a removal
    moveSelectedOverlayRow(1);
    expect([layer("t").row, layer("u").row]).toEqual([2, 1]);
    select("u");
    expect(canMoveOverlayRow(store(), -1)).toBe(true);
    moveSelectedOverlayRow(-1);
    expect(layer("u").row).toBe(0);
    expect(canMoveOverlayRow(store(), -1)).toBe(false);
    moveSelectedOverlayRow(-1);
    expect(layer("u").row).toBe(0);
    expect(store().past).toHaveLength(2);
  });

  it("starts or ends the selected layer at the playhead, its length kept; ] needs room before the playhead", () => {
    openOn([text("t", { startSec: 1, endSec: 4 })]);
    expect(canStartOverlayAtPlayhead(store())).toBe(false);
    select("t");
    store().setPlayhead(6);
    startSelectedOverlayAtPlayhead();
    expect(layer("t")).toMatchObject({ startSec: 6, endSec: 9 });
    store().setPlayhead(5);
    endSelectedOverlayAtPlayhead();
    expect(layer("t")).toMatchObject({ startSec: 2, endSec: 5 });
    store().setPlayhead(2);
    expect(canEndOverlayAtPlayhead(store())).toBe(false);
    endSelectedOverlayAtPlayhead();
    expect(layer("t").startSec).toBe(2);
    expect(store().past).toHaveLength(2);
    // Start is one layer's
    openOn([text("t", { startSec: 1, endSec: 4 }), text("u", { startSec: 5, endSec: 6 })]);
    select("t", "u");
    expect(canStartOverlayAtPlayhead(store())).toBe(false);
    setOverlayStart("u", 7);
    expect(layer("u")).toMatchObject({ startSec: 7, endSec: 8 });
  });

  it("I and O set the start or the end at the playhead, only well inside the layer", () => {
    openOn([text("t", { startSec: 1, endSec: 5, fadeInSec: 0.5 })]);
    select("t");
    store().setPlayhead(2);
    setOverlayEdgeAtPlayhead("in");
    expect(layer("t")).toMatchObject({ startSec: 2, endSec: 5, fadeInSec: 0.5 });
    store().setPlayhead(4);
    setOverlayEdgeAtPlayhead("out");
    expect(layer("t")).toMatchObject({ startSec: 2, endSec: 4 });
    expect(store().past).toHaveLength(2);
    // At an edge, or outside: nothing
    store().setPlayhead(4);
    setOverlayEdgeAtPlayhead("in");
    store().setPlayhead(2.05);
    setOverlayEdgeAtPlayhead("out");
    store().setPlayhead(8);
    setOverlayEdgeAtPlayhead("in");
    expect(layer("t")).toMatchObject({ startSec: 2, endSec: 4 });
    expect(store().past).toHaveLength(2);
  });
});

describe("splitting and removing text layers", () => {
  it("splits every selected layer under the playhead and selects the right pieces", () => {
    openOn([text("t", { startSec: 1, endSec: 5 }), text("u", { row: 1, startSec: 2, endSec: 8 }), text("w", { row: 2, startSec: 6, endSec: 9 })]);
    select("t", "u", "w");
    store().setPlayhead(3);
    expect(canSplitOverlaysAtPlayhead(store())).toBe(true);
    splitSelectedOverlaysAtPlayhead();
    expect(store().past).toHaveLength(1);
    expect(layer("t")).toMatchObject({ startSec: 1, endSec: 3, fadeOutSec: 0 });
    expect(layer("u")).toMatchObject({ startSec: 2, endSec: 3 });
    expect(layer("w")).toMatchObject({ startSec: 6, endSec: 9 });
    const right = store().selection!;
    expect(right.kind).toBe("overlay");
    const pieces = layers().filter((o) => !["t", "u", "w"].includes(o.id));
    expect(pieces.map((o) => [o.row, o.startSec, o.endSec, o.fadeInSec])).toEqual([
      [0, 3, 5, 0],
      [1, 3, 8, 0],
    ]);
    expect(right).toEqual({ kind: "overlay", clipId: pieces[0].id, clipIds: pieces.map((o) => o.id) });
    // Nothing under the playhead with room: nothing
    store().setPlayhead(9.5);
    select("w");
    expect(canSplitOverlaysAtPlayhead(store())).toBe(false);
    splitSelectedOverlaysAtPlayhead();
    expect(store().past).toHaveLength(1);
  });

  it("removes the selected layers (⌫ and removeSelection), the rows closing up, the neighbour selected", () => {
    openOn([text("t", { startSec: 1, endSec: 3 }), text("u", { row: 1, startSec: 2, endSec: 4 }), text("w", { row: 2, startSec: 0, endSec: 1 })]);
    select("u");
    removeOverlaySelection();
    expect(layers().map((o) => [o.id, o.row])).toEqual([
      ["t", 0],
      ["w", 1],
    ]);
    expect(store().selection).toEqual({ kind: "overlay", clipId: "w" });
    removeSelection();
    expect(layers().map((o) => o.id)).toEqual(["t"]);
    expect(store().selection).toEqual({ kind: "overlay", clipId: "t" });
    // The video is never touched
    expect(store().draft!.timeline.map((c) => c.id)).toEqual(["a", "b"]);
    removeSelection();
    expect(store().draft!.overlays).toEqual([]);
    expect(store().selection).toBeNull();
    expect(store().past).toHaveLength(3);
  });
});

describe("a text layer's settings", () => {
  it("writes them clamped in one step, a gesture's ticks in one, and nothing for no change", () => {
    openOn([text("t", { startSec: 1, endSec: 3 })]);
    updateOverlay("t", { text: "Hello", wash: { opacity: 2 } });
    expect(layer("t")).toMatchObject({ text: "Hello", wash: { opacity: 1 } });
    expect(store().past).toHaveLength(1);
    updateOverlay("t", { text: "Hello" });
    expect(store().past).toHaveLength(1);
    updateOverlay("t", { size: 0.1 }, { gestureKey: "overlay-size:t" });
    updateOverlay("t", { size: 0.12 }, { gestureKey: "overlay-size:t" });
    expect(layer("t").size).toBe(0.12);
    expect(store().past).toHaveLength(2);
    updateOverlay("gone", { text: "x" });
    expect(store().past).toHaveLength(2);
  });

  it("sets the length from the start, which stays, kept clear of the next layer on the row and at least the least", () => {
    openOn([text("t", { startSec: 1, endSec: 3 }), text("u", { startSec: 5, endSec: 6 })]);
    setOverlayLength("t", 3);
    expect(layer("t")).toMatchObject({ startSec: 1, endSec: 4 });
    expect(store().past).toHaveLength(1);
    setOverlayLength("t", 9, { gestureKey: "overlay-length:t" });
    expect(layer("t")).toMatchObject({ startSec: 1, endSec: 5 });
    setOverlayLength("t", 0, { gestureKey: "overlay-length:t" });
    expect(layer("t").endSec).toBeCloseTo(1.1, 9);
    expect(store().past).toHaveLength(2);
    // Already that long, not a number, or no such layer: nothing
    setOverlayLength("t", layer("t").endSec - 1);
    setOverlayLength("t", Number.NaN);
    setOverlayLength("gone", 2);
    expect(store().past).toHaveLength(2);
  });
});
