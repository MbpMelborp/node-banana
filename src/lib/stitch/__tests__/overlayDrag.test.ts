import { describe, expect, it } from "vitest";
import type { StitchOverlay, StitchTimelineClip } from "@/types";
import { audioMoveAt, audioSnapText } from "../audioDrag";
import { overlayMoveTargets, overlayRowAt, overlayTrimAt, overlayTrimBounds } from "../overlayDrag";
import { createTextOverlay, normalizeOverlays } from "../overlays";
import { buildTimeAxis } from "../timeAxis";
import { clipSpans, createClip, type SourceDurations, type SourceKey } from "../timeline";

const video = (id: string, edgeId: string, init: Partial<StitchTimelineClip> = {}) =>
  createClip({ kind: "edge", edgeId }, { id, ...init });
const videoDurations = (entries: Record<string, number>): SourceDurations =>
  new Map(Object.entries(entries) as [SourceKey, number][]);

/** 10 s at 10 px/s from x 16: x = 16 + 10·t. */
const linear = () => buildTimeAxis(clipSpans([video("a", "e1")], videoDurations({ "edge:e1": 10 }), 0), 10);
/** 4 s, an empty slot (160 px) at t = 4 (x 56..216), then 6 s. */
const slotted = () =>
  buildTimeAxis(
    clipSpans([video("a", "e1"), video("gap", "e2"), video("b", "e3")], videoDurations({ "edge:e1": 4, "edge:e3": 6 }), 0),
    10,
  );
const videoSpans = clipSpans([video("a", "e1"), video("b", "e2")], videoDurations({ "edge:e1": 4, "edge:e2": 6 }), 0);
const text = (id: string, init: Partial<StitchOverlay> = {}) => createTextOverlay({ id, ...init });
const overlays = normalizeOverlays([
  text("title", { startSec: 1, endSec: 3, text: "Title\nsecond line" }),
  text("sub", { startSec: 4, endSec: 6, text: "Subtitle" }),
  text("top", { row: 1, startSec: 2, endSec: 7, text: "" }),
]);
const names = (o: StitchOverlay) => (o.text ? `“${o.text.split("\n")[0]}”` : "Empty text");

describe("overlayMoveTargets", () => {
  it("takes the playhead, 0:00, the end, the video clips' edges and the other layers' edges", () => {
    const targets = overlayMoveTargets(overlays, videoSpans, new Set(["title"]), 3, 10, names);
    expect(targets.map((t) => [t.label, t.t])).toEqual([
      ["the playhead", 3],
      ["the start", 0],
      ["the end", 10],
      ["Clip 1's start", 0],
      ["Clip 1's end", 4],
      ["Clip 2's start", 4],
      ["Clip 2's end", 10],
      ["“Subtitle”'s start", 4],
      ["“Subtitle”'s end", 6],
      ["Empty text's start", 2],
      ["Empty text's end", 7],
    ]);
  });

  it("has no end with no video", () => {
    const targets = overlayMoveTargets(overlays, [], new Set(["title", "sub", "top"]), 0, 0, names);
    expect(targets.map((t) => t.label)).toEqual(["the playhead", "the start"]);
  });

  it("drives audioMoveAt: a move snaps the lead's end to a video clip's end", () => {
    const targets = overlayMoveTargets(overlays, videoSpans, new Set(["sub"]), 0, 10, names);
    // "sub" (4–6 s) moved 3.9 s: its end lands 0.1 s from the end at 10
    const result = audioMoveAt(linear(), { start: 4, length: 2 }, 39, targets, { snap: true });
    expect(result.deltaSec).toBeCloseTo(4, 9);
    expect(result.snappedEdge).toBe("end");
    expect(audioSnapText(result)).toBe("End snapped to the end");
  });
});

describe("overlayTrimBounds", () => {
  it("stops a start at 0:00, at the previous layer's end on its row and before the minimum length", () => {
    const sub = overlays.find((o) => o.id === "sub")!;
    expect(overlayTrimBounds(overlays, sub, "in")).toEqual({ min: 3, max: 6 - 0.1 });
    const title = overlays.find((o) => o.id === "title")!;
    expect(overlayTrimBounds(overlays, title, "in")).toEqual({ min: 0, max: 3 - 0.1 });
  });

  it("stops an end at the minimum length and at the next layer's start on its row", () => {
    const title = overlays.find((o) => o.id === "title")!;
    expect(overlayTrimBounds(overlays, title, "out")).toEqual({ min: 1.1, max: 4 });
    // Nothing after it on its row: ten minutes from its start
    const top = overlays.find((o) => o.id === "top")!;
    expect(overlayTrimBounds(overlays, top, "out")).toEqual({ min: 2.1, max: 602 });
  });
});

describe("overlayTrimAt", () => {
  const targets = overlayMoveTargets(overlays, videoSpans, new Set(["sub"]), 4.95, 10, names);
  const sub = overlays.find((o) => o.id === "sub")!;

  it("moves one edge where it is drawn, the other kept", () => {
    expect(overlayTrimAt(linear(), sub, "in", -5, { min: 3, max: 5.9 }, targets, { snap: false })).toEqual({
      startSec: 3.5,
      snapped: null,
    });
    const out = overlayTrimAt(linear(), sub, "out", 12, { min: 4.1, max: 10 }, targets, { snap: false });
    expect(out.endSec).toBeCloseTo(7.2, 9);
    expect(out.startSec).toBeUndefined();
  });

  it("snaps within 8 px, the playhead winning a tie", () => {
    // The end at 6 s moved −10 px: 5 s, 0.05 s from the playhead (4.95) and from nothing else
    const result = overlayTrimAt(linear(), sub, "out", -10, { min: 4.1, max: 10 }, targets, { snap: true });
    expect(result).toEqual({ endSec: 4.95, snapped: expect.objectContaining({ label: "the playhead" }) });
    // ⇧: no snap
    expect(overlayTrimAt(linear(), sub, "out", -10, { min: 4.1, max: 10 }, targets, { snap: false }).endSec).toBeCloseTo(5, 9);
  });

  it("clamps to its bounds, and a snap the bounds pulled off is no snap", () => {
    expect(overlayTrimAt(linear(), sub, "out", 200, { min: 4.1, max: 8 }, targets, { snap: true }).endSec).toBe(8);
    // The start pulled toward Clip 1's end at 4 s is held at 4.5 s
    const pulled = overlayTrimAt(linear(), sub, "in", 0, { min: 4.5, max: 5.9 }, targets, { snap: true });
    expect(pulled).toEqual({ startSec: 4.5, snapped: null });
  });

  it("does not jump across a Track slot", () => {
    // From 3 s (x 46), 20 px right: into the slot (x 66), whose pixels all read 4 s
    expect(overlayTrimAt(slotted(), { startSec: 1, endSec: 3 }, "out", 20, { min: 1.1, max: 20 }, [], { snap: false }).endSec).toBeCloseTo(4, 9);
  });
});

describe("overlayRowAt", () => {
  // Three rows bottom-up: row 2 at 0–52, row 1 at 52–104, row 0 at 104–156 in the rows block
  it("keeps the row within its band and 4 px more", () => {
    expect(overlayRowAt(130, 0, 3)).toBe(0);
    expect(overlayRowAt(101, 0, 3)).toBe(0);
    expect(overlayRowAt(99, 0, 3)).toBe(1);
    expect(overlayRowAt(55, 1, 3)).toBe(1);
    expect(overlayRowAt(49, 1, 3)).toBe(1);
    expect(overlayRowAt(47, 1, 3)).toBe(2);
    expect(overlayRowAt(107, 1, 3)).toBe(1);
    expect(overlayRowAt(109, 1, 3)).toBe(0);
  });

  it("goes onto a new row above the top one past its band by 4 px, and stays there", () => {
    expect(overlayRowAt(-3, 2, 3)).toBe(2);
    expect(overlayRowAt(-5, 2, 3)).toBe(3);
    expect(overlayRowAt(3, 3, 3)).toBe(3);
    expect(overlayRowAt(5, 3, 3)).toBe(2);
    // Below the last row: row 0
    expect(overlayRowAt(400, 2, 3)).toBe(0);
    expect(overlayRowAt(Number.NaN, 1, 3)).toBe(1);
    // One row: above it is a new one
    expect(overlayRowAt(-10, 0, 1)).toBe(1);
  });
});
