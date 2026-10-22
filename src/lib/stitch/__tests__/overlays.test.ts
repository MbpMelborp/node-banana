import { describe, expect, it } from "vitest";
import type { StitchOverlay, StitchTextOverlay } from "@/types";
import {
  addTextOverlayAt,
  APP_SANS_FAMILY,
  clampOverlay,
  compactOverlayRows,
  copyOverlayItems,
  createTextOverlay,
  describeOverlayChanges,
  draftOverlays,
  duplicateOverlays,
  MAX_OVERLAY_TEXT,
  moveOverlays,
  NO_OVERLAYS,
  normalizeOverlays,
  overlayFadeKnees,
  overlayOpacityAt,
  overlayOverlapsOnRow,
  overlayRowCount,
  pasteOverlays,
  removeOverlays,
  sameOverlayRows,
  sameOverlays,
  sanitizeOverlays,
  splitOverlayAt,
  trimOverlay,
  updateOverlay,
} from "../overlays";

const text = (id: string, init: Partial<StitchTextOverlay> = {}) => createTextOverlay({ id, ...init });
const at = (overlays: readonly StitchOverlay[], id: string) => overlays.find((o) => o.id === id)!;
const rows = (overlays: readonly StitchOverlay[]) => overlays.map((o) => [o.id, o.row]);

describe("createTextOverlay", () => {
  it("makes a 4 s Title in the app's sans over a 0.5 wash, fading 0.5 s, centred", () => {
    const o = createTextOverlay({ startSec: 2 });
    expect(o).toEqual({
      id: expect.stringMatching(/^ovl_[0-9a-f]{8}$/),
      kind: "text",
      row: 0,
      startSec: 2,
      endSec: 6,
      fadeInSec: 0.5,
      fadeOutSec: 0.5,
      text: "Title",
      font: { family: APP_SANS_FAMILY },
      size: 0.08,
      weight: 600,
      color: "#ffffff",
      align: "center",
      x: 0.5,
      y: 0.5,
      wash: { opacity: 0.5 },
    });
    expect(createTextOverlay().id).not.toBe(o.id);
  });

  it("takes what it is given, through the shared clamp, and copies font and wash", () => {
    const font = { family: "Inter", file: "Inter.ttf" };
    const wash = { opacity: 0.25 };
    const o = createTextOverlay({ id: "o", font, wash, size: 0.9, color: "#FF0000" });
    expect(o).toMatchObject({ id: "o", font, wash, size: 0.5, color: "#ff0000" });
    expect(o.font).not.toBe(font);
    expect(o.wash).not.toBe(wash);
  });
});

describe("sanitizeOverlays", () => {
  it("drops what is not a text layer with an id, and renames repeated ids", () => {
    const list = sanitizeOverlays([
      null,
      "x",
      [text("arr")],
      { ...text("img"), kind: "image" },
      { ...text("none"), id: "" },
      { ...text("n"), id: 7 },
      text("a", { startSec: 1 }),
      text("a", { startSec: 0 }),
    ]);
    expect(list.map((o) => [o.id, o.startSec])).toEqual([
      ["a~2", 0],
      ["a", 1],
    ]);
    expect(sanitizeOverlays("nope")).toEqual([]);
    expect(sanitizeOverlays({ 0: text("a") })).toEqual([]);
  });

  it("coerces every value it cannot keep", () => {
    const [o] = sanitizeOverlays([
      {
        id: "o",
        kind: "text",
        row: 1.5,
        startSec: 900,
        endSec: "late",
        fadeInSec: -1,
        fadeOutSec: 1e9,
        text: 3,
        font: { family: "  Big \u0007 \n Font  ", file: "../secret.ttf" },
        size: 0,
        weight: 1234.5,
        color: "red",
        align: "justify",
        x: -2,
        y: Number.NaN,
        wash: { opacity: 7 },
        extra: "dropped",
      },
    ]);
    expect(o).toStrictEqual({
      id: "o",
      kind: "text",
      row: 0,
      startSec: 600,
      endSec: 600.1,
      fadeInSec: 0,
      fadeOutSec: 600,
      text: "",
      font: { family: "Big Font" },
      size: 0.01,
      weight: 900,
      color: "#ffffff",
      align: "center",
      x: 0,
      y: 0.5,
      wash: { opacity: 1 },
    });
  });

  it("fills missing values with a new layer's, the end MIN_OVERLAY_SEC after the start, and the family the app's sans", () => {
    const [o] = sanitizeOverlays([{ id: "o", kind: "text", startSec: 2 }]);
    expect(o).toMatchObject({ startSec: 2, endSec: 2.1, fadeInSec: 0, fadeOutSec: 0, text: "", size: 0.08, weight: 600 });
    expect(o.font).toStrictEqual({ family: APP_SANS_FAMILY });
    expect(o.wash).toStrictEqual({ opacity: 0.5 });
  });

  it("keeps an end after the start up to 600 s on, and fades longer than the layer", () => {
    const [kept, capped, backwards] = sanitizeOverlays([
      text("a", { startSec: 1, endSec: 1.05, fadeInSec: 3, fadeOutSec: 2 }),
      text("b", { row: 1, startSec: 1, endSec: 900 }),
      text("c", { row: 2, startSec: 5, endSec: 4 }),
    ]);
    expect([kept.endSec, kept.fadeInSec, kept.fadeOutSec]).toEqual([1.05, 3, 2]);
    expect(capped.endSec).toBe(601);
    expect(backwards.endSec).toBe(5.1);
  });

  it("keeps a font file only by a font file's name", () => {
    const fileOf = (file: unknown) => sanitizeOverlays([{ ...text("o"), font: { family: "F", file } }])[0].font.file;
    expect(fileOf("Inter-Bold.woff2")).toBe("Inter-Bold.woff2");
    expect(fileOf("Ünïcödé Sans.OTF")).toBe("Ünïcödé Sans.OTF");
    for (const bad of ["../x.ttf", "a/b.ttf", "a\\b.ttf", ".hidden.ttf", "x.exe", "x.ttc", "%2e%2e.ttf", "Half \uD83C.ttf", "", 3]) {
      expect(fileOf(bad), String(bad)).toBeUndefined();
    }
  });

  it("keeps line breaks as \\n, and cuts long text and families without halving a character", () => {
    const [o] = sanitizeOverlays([{ ...text("o"), text: "One\r\nTwo\rThree", font: { family: "x".repeat(300) } }]);
    expect(o.text).toBe("One\nTwo\nThree");
    expect(o.font.family).toBe("x".repeat(200));
    const [long] = sanitizeOverlays([{ ...text("o"), text: `a${"😀".repeat(MAX_OVERLAY_TEXT)}` }]);
    expect(long.text).toBe(`a${"😀".repeat(MAX_OVERLAY_TEXT / 2 - 1)}`);
  });

  it("compacts the rows and sorts by row, start, id", () => {
    const list = sanitizeOverlays([text("d", { row: 7 }), text("c", { row: 3, startSec: 4 }), text("b", { row: 3, startSec: 1 })]);
    expect(rows(list)).toEqual([
      ["b", 0],
      ["c", 0],
      ["d", 1],
    ]);
  });
});

describe("rows", () => {
  it("normalizes without renumbering, and keeps the same array when sorted", () => {
    const list = [text("a", { row: 2 }), text("b", { row: 0 })];
    expect(normalizeOverlays(list).map((o) => o.row)).toEqual([0, 2]);
    const sorted = normalizeOverlays(list);
    expect(normalizeOverlays(sorted)).toBe(sorted);
  });

  it("compacts with a row map, and compares compacted forms", () => {
    const list = [text("a", { row: 0 }), text("b", { row: 2 })];
    const { overlays: compacted, rowMap } = compactOverlayRows(list);
    expect(compacted.map((o) => o.row)).toEqual([0, 1]);
    expect(rowMap).toEqual([0, null, 1]);
    expect(compactOverlayRows(compacted).overlays).toBe(compacted);
    expect(sameOverlays(list, compacted)).toBe(true);
    expect(overlayRowCount(list)).toBe(3);
    expect(overlayRowCount([])).toBe(0);
  });

  it("reads a draft without overlays as the one empty list", () => {
    expect(draftOverlays({})).toBe(NO_OVERLAYS);
    const overlays = [text("a")];
    expect(draftOverlays({ overlays })).toBe(overlays);
  });

  it("finds overlaps on a row, the ignored aside, touching boxes not overlapping", () => {
    const list = [text("a", { startSec: 2, endSec: 4 })];
    expect(overlayOverlapsOnRow(list, 0, 3, 5, new Set())).toBe(true);
    expect(overlayOverlapsOnRow(list, 0, 4, 1, new Set())).toBe(false);
    expect(overlayOverlapsOnRow(list, 0, 0, 2, new Set())).toBe(false);
    expect(overlayOverlapsOnRow(list, 1, 3, 1, new Set())).toBe(false);
    expect(overlayOverlapsOnRow(list, 0, 3, 1, new Set(["a"]))).toBe(false);
  });
});

describe("moveOverlays", () => {
  const list = normalizeOverlays([
    text("a", { startSec: 0, endSec: 20 }),
    text("t", { row: 1, startSec: 2, endSec: 5 }),
    text("r", { row: 1, startSec: 6, endSec: 8 }),
  ]);

  it("moves start and end together and across rows, the group keeping its spacing", () => {
    const { overlays, newRow, insertedAfter } = moveOverlays(list, ["t", "r"], 1.5, 1);
    expect([at(overlays, "t").startSec, at(overlays, "t").endSec, at(overlays, "t").row]).toEqual([3.5, 6.5, 2]);
    expect([at(overlays, "r").startSec, at(overlays, "r").endSec, at(overlays, "r").row]).toEqual([7.5, 9.5, 2]);
    expect(newRow).toBe(true);
    // A new row after the last, not inserted
    expect(insertedAfter).toBeNull();
  });

  it("clamps at 0:00 and 10:00, keeping the spacing and the lengths", () => {
    const early = moveOverlays(list, ["t", "r"], -10, 0).overlays;
    expect([at(early, "t").startSec, at(early, "t").endSec, at(early, "r").startSec]).toEqual([0, 3, 4]);
    const late = moveOverlays(list, ["t", "r"], 1000, 0).overlays;
    expect([at(late, "t").startSec, at(late, "r").startSec, at(late, "r").endSec]).toEqual([596, 600, 602]);
  });

  it("puts a move that would overlap onto new rows after the target row, the rows after it moving up", () => {
    const three = normalizeOverlays([...list, text("u", { row: 2, startSec: 0, endSec: 1 })]);
    // t (2–5) onto row 0 over a (0–20)
    const { overlays, rowMap, newRow, insertedAfter } = moveOverlays(three, ["t"], 0, -1);
    expect(at(overlays, "t").row).toBe(1);
    expect(at(overlays, "r").row).toBe(2);
    expect(at(overlays, "u").row).toBe(3);
    expect(rowMap).toEqual([0, 2, 3]);
    expect(newRow).toBe(true);
    expect(insertedAfter).toBe(0);
  });

  it("puts a blocked group that reaches the new-row slot after the last row, with no empty row between", () => {
    const two = normalizeOverlays([
      text("a", { startSec: 0, endSec: 5 }),
      text("b", { row: 1, startSec: 10, endSec: 15 }),
      text("c", { row: 1, startSec: 0, endSec: 5 }),
    ]);
    const { overlays, insertedAfter } = moveOverlays(two, ["a", "b"], 0, 1);
    expect(rows(overlays)).toEqual([
      ["c", 1],
      ["a", 2],
      ["b", 3],
    ]);
    expect(insertedAfter).toBe(1);
  });

  it("keeps a row the move empties, and makes a new row no further than one past the last", () => {
    const solo = normalizeOverlays([text("a"), text("t", { row: 1, startSec: 2 }), text("r", { row: 2, startSec: 9 })]);
    const emptied = moveOverlays(solo, ["t"], 0, 2).overlays;
    expect(at(emptied, "t").row).toBe(3);
    expect(emptied.some((o) => o.row === 1)).toBe(false);
    expect(overlayRowCount(emptied)).toBe(4);
    expect(at(moveOverlays(solo, ["t"], 0, 9).overlays, "t").row).toBe(3);
  });

  it("returns the same array for no move", () => {
    expect(moveOverlays(list, ["t"], 0, 0).overlays).toBe(list);
    expect(moveOverlays(list, ["nope"], 1, 1).overlays).toBe(list);
    expect(moveOverlays(list, ["t"], Number.NaN, Number.NaN).overlays).toBe(list);
  });
});

describe("trimOverlay", () => {
  const list = normalizeOverlays([
    text("a", { startSec: 1, endSec: 4, fadeInSec: 0.5, fadeOutSec: 1 }),
    text("b", { startSec: 6, endSec: 9 }),
  ]);

  it("moves the end, stopped by the next layer on the row and 0.1 s after the start, the fades kept", () => {
    expect(at(trimOverlay(list, "a", { endSec: 5 }), "a")).toMatchObject({ startSec: 1, endSec: 5, fadeInSec: 0.5, fadeOutSec: 1 });
    expect(at(trimOverlay(list, "a", { endSec: 7 }), "a").endSec).toBe(6);
    expect(at(trimOverlay(list, "a", { endSec: 0 }), "a").endSec).toBeCloseTo(1.1, 12);
    expect(at(trimOverlay(list, "b", { endSec: 1000 }), "b").endSec).toBe(606);
  });

  it("moves the start, stopped by 0:00, the previous layer's end and 0.1 s before the end", () => {
    expect(at(trimOverlay(list, "a", { startSec: 0.5 }), "a")).toMatchObject({ startSec: 0.5, endSec: 4 });
    expect(at(trimOverlay(list, "a", { startSec: -3 }), "a").startSec).toBe(0);
    expect(at(trimOverlay(list, "b", { startSec: 2 }), "b").startSec).toBe(4);
    expect(at(trimOverlay(list, "b", { startSec: 20 }), "b").startSec).toBeCloseTo(8.9, 12);
    // Never longer than MAX_OVERLAY_SEC
    const long = [text("l", { startSec: 100, endSec: 700 })];
    expect(at(trimOverlay(long, "l", { startSec: 0 }), "l").startSec).toBe(100);
  });

  it("returns the same array when nothing changes", () => {
    expect(trimOverlay(list, "a", { startSec: 1, endSec: 4 })).toBe(list);
    expect(trimOverlay(list, "a", {})).toBe(list);
    expect(trimOverlay(list, "nope", { endSec: 2 })).toBe(list);
    expect(trimOverlay(list, "a", { endSec: Number.NaN })).toBe(list);
  });
});

describe("splitOverlayAt", () => {
  const list = [text("a", { row: 1, startSec: 2, endSec: 6, fadeInSec: 1, fadeOutSec: 1.5, text: "Hello" })];

  it("cuts one layer into two on its row: the left keeps the id and its fade in, the right its fade out", () => {
    const { overlays, rightId } = splitOverlayAt(list, "a", 3.5, "r")!;
    expect(rightId).toBe("r");
    const [left, right] = overlays;
    expect(left).toMatchObject({ id: "a", row: 1, startSec: 2, endSec: 3.5, fadeInSec: 1, fadeOutSec: 0, text: "Hello" });
    expect(right).toMatchObject({ id: "r", row: 1, startSec: 3.5, endSec: 6, fadeInSec: 0, fadeOutSec: 1.5, text: "Hello" });
    expect(left.font).not.toBe(right.font);
    expect(left.wash).not.toBe(list[0].wash);
  });

  it("cuts a fade longer than its piece", () => {
    const [early] = splitOverlayAt(list, "a", 2.5, "r")!.overlays;
    expect(early.fadeInSec).toBe(0.5);
    const late = splitOverlayAt(list, "a", 5.5, "r")!.overlays[1];
    expect(late.fadeOutSec).toBe(0.5);
  });

  it("refuses within 0.1 s of an end, outside the layer, and for a layer that is not there", () => {
    expect(splitOverlayAt(list, "a", 2.05)).toBeNull();
    expect(splitOverlayAt(list, "a", 5.95)).toBeNull();
    expect(splitOverlayAt(list, "a", 9)).toBeNull();
    expect(splitOverlayAt(list, "a", Number.NaN)).toBeNull();
    expect(splitOverlayAt(list, "nope", 3)).toBeNull();
  });

  it("refuses a cut after 10:00, where the right piece could not start", () => {
    const late = [text("l", { startSec: 598, endSec: 602 })];
    expect(splitOverlayAt(late, "l", 601)).toBeNull();
    expect(splitOverlayAt(late, "l", 599, "r")!.overlays.map((o) => [o.id, o.row, o.startSec, o.endSec])).toEqual([
      ["l", 0, 598, 599],
      ["r", 0, 599, 602],
    ]);
    expect(splitOverlayAt(late, "l", 600, "r")!.overlays[1].startSec).toBe(600);
    // Added past the end of a long edit: held at 10:00
    const added = addTextOverlayAt([], 650);
    expect(splitOverlayAt(added.overlays, added.id, 602)).toBeNull();
  });
});

describe("removeOverlays", () => {
  it("removes and compacts, with the row map", () => {
    const list = normalizeOverlays([text("a"), text("t", { row: 1 }), text("r", { row: 2 })]);
    const { overlays, rowMap } = removeOverlays(list, new Set(["t"]));
    expect(rows(overlays)).toEqual([
      ["a", 0],
      ["r", 1],
    ]);
    expect(rowMap).toEqual([0, null, 1]);
    expect(removeOverlays(list, new Set(["x"])).overlays).toBe(list);
    expect(removeOverlays(list, new Set(["r"])).rowMap).toEqual([0, 1, null]);
  });
});

describe("updateOverlay", () => {
  const list = [text("a", { font: { family: "Inter", file: "Inter.ttf" }, size: 0.2, x: 0.2, wash: { opacity: 0.3 } })];

  it("returns the same array when nothing changes, comparing font and wash by value", () => {
    expect(updateOverlay(list, "a", { font: { family: "Inter", file: "Inter.ttf" } })).toBe(list);
    expect(updateOverlay(list, "a", { wash: { opacity: 0.3 }, size: 0.2 })).toBe(list);
    expect(updateOverlay(list, "nope", { size: 0.3 })).toBe(list);
  });

  it("leaves a key given as undefined alone", () => {
    const blank = { size: undefined, x: undefined, text: undefined, font: undefined, wash: undefined };
    expect(updateOverlay(list, "a", blank)).toBe(list);
    expect(at(updateOverlay(list, "a", { ...blank, y: 0.9 }), "a")).toMatchObject({
      size: 0.2,
      x: 0.2,
      y: 0.9,
      text: "Title",
      font: { family: "Inter", file: "Inter.ttf" },
      wash: { opacity: 0.3 },
    });
  });

  it("sets the rail's values through the shared clamp", () => {
    const next = updateOverlay(list, "a", {
      size: 2,
      color: "#ABCDEF",
      font: { family: " Big  Font " },
      weight: 449.6,
      text: "One\r\nTwo",
      align: "left",
      x: 1.5,
      fadeInSec: 2,
    });
    expect(at(next, "a")).toMatchObject({ size: 0.5, color: "#abcdef", weight: 450, text: "One\nTwo", align: "left", x: 1, fadeInSec: 2 });
    expect(at(next, "a").font).toStrictEqual({ family: "Big Font" });
    // Clamped to what it already is: no change
    expect(updateOverlay(next, "a", { size: 0.9 })).toBe(next);
  });
});

describe("add, copy, paste, duplicate", () => {
  it("adds a text layer at the playhead on the first row with room, else on a new row", () => {
    const list = normalizeOverlays([text("a", { startSec: 0, endSec: 4 }), text("b", { row: 1, startSec: 3, endSec: 5 })]);
    const later = addTextOverlayAt(list, 4.5);
    expect(at(later.overlays, later.id)).toMatchObject({ row: 0, startSec: 4.5, endSec: 8.5, text: "Title" });
    const blocked = addTextOverlayAt(list, 2);
    expect(at(blocked.overlays, blocked.id).row).toBe(2);
    const first = addTextOverlayAt([], -3, { text: "Sub", y: 0.82 });
    expect(first.overlays).toEqual([expect.objectContaining({ row: 0, startSec: 0, endSec: 4, text: "Sub", y: 0.82 })]);
  });

  it("copies with offsets from the earliest start and the lowest row, the settings a copy", () => {
    const list = normalizeOverlays([text("a", { startSec: 1, endSec: 3, text: "One" }), text("b", { row: 2, startSec: 4, endSec: 9 })]);
    const items = copyOverlayItems(list, ["b", "a"]);
    expect(items.map((i) => [i.track, i.lengthSec, i.offsetSec, i.rowOffset])).toEqual([
      ["overlay", 2, 0, 0],
      ["overlay", 5, 3, 2],
    ]);
    const { font, wash, ...rest } = list[0];
    expect(items[0].overlay).toStrictEqual({
      kind: rest.kind,
      fadeInSec: rest.fadeInSec,
      fadeOutSec: rest.fadeOutSec,
      text: "One",
      font,
      size: rest.size,
      weight: rest.weight,
      color: rest.color,
      align: rest.align,
      x: rest.x,
      y: rest.y,
      wash,
    });
    expect(items[0].overlay.font).not.toBe(font);
    expect(copyOverlayItems(list, [])).toEqual([]);
  });

  it("pastes on new rows after the last, the first at the playhead, lengths and spacing kept", () => {
    const list = normalizeOverlays([text("a", { startSec: 1, endSec: 3, text: "One" }), text("b", { row: 2, startSec: 4, endSec: 9 })]);
    const { overlays, ids } = pasteOverlays(list, copyOverlayItems(list, ["a", "b"]), 5);
    expect(ids.map((id) => [at(overlays, id).row, at(overlays, id).startSec, at(overlays, id).endSec])).toEqual([
      [3, 5, 7],
      [5, 8, 13],
    ]);
    expect(at(overlays, ids[0]).text).toBe("One");
    expect(ids.every((id) => !["a", "b"].includes(id))).toBe(true);
    expect(pasteOverlays(list, [], 5).overlays).toBe(list);
  });

  it("pastes earlier near 10:00, so the latest starts by then, the spacing kept", () => {
    const pair = normalizeOverlays([text("a", { startSec: 0, endSec: 4 }), text("b", { startSec: 5, endSec: 9 })]);
    const { overlays, ids } = pasteOverlays(pair, copyOverlayItems(pair, ["a", "b"]), 598);
    expect(ids.map((id) => [at(overlays, id).row, at(overlays, id).startSec, at(overlays, id).endSec])).toEqual([
      [1, 595, 599],
      [1, 600, 604],
    ]);
  });

  it("duplicates from the latest end on the same rows when every copy fits", () => {
    const pair = normalizeOverlays([text("a", { startSec: 0, endSec: 2 }), text("b", { row: 1, startSec: 1, endSec: 4 })]);
    const { overlays, ids, rowMap } = duplicateOverlays(pair, ["a", "b"]);
    expect(ids.map((id) => [at(overlays, id).row, at(overlays, id).startSec, at(overlays, id).endSec])).toEqual([
      [0, 4, 6],
      [1, 5, 8],
    ]);
    expect(rowMap).toEqual([0, 1]);
  });

  it("duplicates onto new rows after the highest selected row when a copy would overlap", () => {
    const blocked = normalizeOverlays([
      text("a", { startSec: 0, endSec: 3 }),
      text("x", { startSec: 4, endSec: 6 }),
      text("c", { row: 1 }),
    ]);
    const result = duplicateOverlays(blocked, ["a"]);
    expect(at(result.overlays, result.ids[0])).toMatchObject({ row: 1, startSec: 3, endSec: 6 });
    expect(at(result.overlays, "c").row).toBe(2);
    expect(result.rowMap).toEqual([0, 2]);
    expect(duplicateOverlays(blocked, ["nope"]).overlays).toBe(blocked);
  });
});

describe("sameOverlays", () => {
  const base = normalizeOverlays([text("a"), text("b", { row: 1, startSec: 4 })]);

  it("ignores an empty row a move left, and sees every field", () => {
    expect(sameOverlays(base, base.map((o) => ({ ...o, row: o.row * 2 })))).toBe(true);
    const changes: Partial<StitchTextOverlay>[] = [
      // Onto a's row, where it fits: the compacted order stays a, b
      { row: 0 },
      { startSec: 1 },
      { endSec: 9 },
      { fadeInSec: 1 },
      { fadeOutSec: 0 },
      { text: "Other" },
      { font: { family: "Inter" } },
      { font: { family: APP_SANS_FAMILY, file: "Inter.ttf" } },
      { size: 0.1 },
      { weight: 700 },
      { color: "#000000" },
      { align: "right" },
      { x: 0.2 },
      { y: 0.8 },
      { wash: { opacity: 0 } },
    ];
    for (const patch of changes) {
      expect(sameOverlays(base, base.map((o) => (o.id === "b" ? { ...o, ...patch } : o))), JSON.stringify(patch)).toBe(false);
    }
    expect(sameOverlays(base, base.slice(1))).toBe(false);
    expect(sameOverlays(base, base.map((o) => (o.id === "b" ? { ...o, id: "c" } : o)))).toBe(false);
  });

  it("tells a row a move emptied from the same rows", () => {
    const moved = base.map((o) => (o.id === "b" ? { ...o, row: 2 } : o));
    expect(sameOverlays(base, moved)).toBe(true);
    expect(sameOverlayRows(moved, base)).toBe(false);
    expect(sameOverlayRows(base, [...base])).toBe(true);
  });
});

describe("the sanitizer is a fixed point of the editor", () => {
  const list = normalizeOverlays([
    text("a", { startSec: 0.2, endSec: 3.3, fadeInSec: 0.7 }),
    text("d", { startSec: 5, endSec: 9 }),
    text("b", { row: 1, startSec: 0.1, endSec: 2.9, text: "Line one\nLine two" }),
    text("c", { row: 2, startSec: 590, endSec: 1190, font: { family: "Inter", file: "Inter.ttf" } }),
  ]);
  const made = (): StitchOverlay[][] => [
    list,
    moveOverlays(list, ["a"], 0.1 * 3, 1).overlays,
    moveOverlays(list, ["a", "b"], 1000, 0).overlays,
    moveOverlays(list, ["a"], 0.7, -0).overlays,
    trimOverlay(list, "a", { endSec: 0 }),
    trimOverlay(list, "a", { startSec: 1e9 }),
    trimOverlay(list, "c", { startSec: 0 }),
    splitOverlayAt(list, "a", 2.0123)!.overlays,
    splitOverlayAt(list, "b", 0.1 + 0.2)!.overlays,
    splitOverlayAt(list, "c", 599.9)!.overlays,
    removeOverlays(list, new Set(["b"])).overlays,
    updateOverlay(list, "a", { color: "#ABCDEF", font: { family: "  My\tFont  " }, size: 3, weight: 512.6, x: -1 }),
    updateOverlay(list, "b", { text: "a\r\nb", wash: { opacity: 0.33333 }, fadeOutSec: 1e6 }),
    addTextOverlayAt(list, 7.77).overlays,
    addTextOverlayAt(list, 650).overlays,
    pasteOverlays(list, copyOverlayItems(list, ["a", "b"]), 3.3).overlays,
    pasteOverlays(list, copyOverlayItems(list, ["c"]), 599.9).overlays,
    pasteOverlays(list, copyOverlayItems(list, ["a", "d"]), 598).overlays,
    duplicateOverlays(list, ["a", "c"]).overlays,
    duplicateOverlays(list, ["b"]).overlays,
  ];

  it("reads back what every recipe and setter makes, as it is", () => {
    for (const overlays of made()) {
      expect(sanitizeOverlays(JSON.parse(JSON.stringify(overlays)))).toStrictEqual(
        compactOverlayRows(normalizeOverlays(overlays)).overlays,
      );
    }
  });

  it("never leaves two layers sharing time on a row", () => {
    for (const overlays of made()) {
      const shared = overlays.filter((o) => overlayOverlapsOnRow(overlays, o.row, o.startSec, o.endSec - o.startSec, new Set([o.id])));
      expect(shared.map((o) => [o.id, o.row, o.startSec, o.endSec])).toEqual([]);
    }
  });

  it("changes nothing a clamp already made", () => {
    const o = clampOverlay({ ...text("o"), endSec: Number.NaN, font: { family: "\u0001 A \u0002 B ", file: "x.ttf" } });
    expect(clampOverlay(o)).toStrictEqual(o);
    expect(o.font).toStrictEqual({ family: "A B", file: "x.ttf" });
  });
});

describe("opacity", () => {
  const o = text("o", { startSec: 2, endSec: 6, fadeInSec: 1, fadeOutSec: 2 });

  it("rises over the fade in, holds, falls over the fade out, and is 0 outside", () => {
    const samples = [1.9, 2, 2.5, 3, 4, 5, 5.999, 6, 7, Number.NaN].map((t) => overlayOpacityAt(o, t));
    expect(samples[0]).toBe(0);
    expect(samples[1]).toBe(0);
    expect(samples[2]).toBe(0.5);
    expect(samples[3]).toBe(1);
    expect(samples[4]).toBe(1);
    expect(samples[5]).toBe(0.5);
    expect(samples[6]).toBeCloseTo(0.0005, 9);
    expect(samples.slice(7)).toEqual([0, 0, 0]);
  });

  it("cuts in and out without fades", () => {
    const cut = { ...o, fadeInSec: 0, fadeOutSec: 0 };
    expect([overlayOpacityAt(cut, 1.999), overlayOpacityAt(cut, 2), overlayOpacityAt(cut, 5.999), overlayOpacityAt(cut, 6)]).toEqual([0, 1, 1, 0]);
  });

  it("meets overlapping fades below 1, and the knees draw the same curve", () => {
    expect(overlayFadeKnees(o)).toEqual({ fadeInEnd: 3, fadeOutStart: 4, peak: 1 });
    const triangle = { startSec: 0, endSec: 1, fadeInSec: 1, fadeOutSec: 1 };
    expect(overlayFadeKnees(triangle)).toEqual({ fadeInEnd: 0.5, fadeOutStart: 0.5, peak: 0.5 });
    expect(overlayOpacityAt(triangle, 0.5)).toBe(0.5);
    const lopsided = { startSec: 0, endSec: 1, fadeInSec: 2, fadeOutSec: 0.5 };
    const knees = overlayFadeKnees(lopsided);
    expect(knees.fadeInEnd).toBeCloseTo(0.8, 12);
    expect(knees.peak).toBeCloseTo(0.4, 12);
    expect(overlayOpacityAt(lopsided, knees.fadeInEnd)).toBeCloseTo(knees.peak, 12);
    // A cut in under a long fade out starts below 1
    const late = { startSec: 0, endSec: 1, fadeInSec: 0, fadeOutSec: 2 };
    expect(overlayFadeKnees(late)).toEqual({ fadeInEnd: 0, fadeOutStart: 0, peak: 0.5 });
    expect(overlayOpacityAt(late, 0)).toBe(0.5);
  });
});

describe("describeOverlayChanges", () => {
  const initial = normalizeOverlays([
    text("a", { startSec: 0, endSec: 4 }),
    text("b", { row: 1, startSec: 2, endSec: 6, text: "Hello" }),
    text("c", { row: 2, startSec: 1, endSec: 3, text: "Credits" }),
  ]);
  const edit = (id: string, patch: Partial<StitchTextOverlay>) => initial.map((o) => (o.id === id ? { ...o, ...patch } : o));
  const split = splitOverlayAt(initial, "b", 4, "b2")!.overlays;

  it("names each kind of change", () => {
    const cases: Array<[StitchOverlay[], string[], Map<string, "pasted" | "duplicated" | "cut">?]> = [
      [[...initial, text("n", { row: 3, text: "New" })], ["an added text layer"]],
      [[...initial, text("p", { row: 3 })], ["a pasted text layer"], new Map([["p", "pasted" as const]])],
      [[...initial, text("d", { row: 3 })], ["a duplicated text layer"], new Map([["d", "duplicated" as const]])],
      [initial.filter((o) => o.id !== "c"), ["a removed text layer"]],
      [initial.filter((o) => o.id !== "c"), ["a cut text layer"], new Map([["c", "cut" as const]])],
      [edit("b", { startSec: 3, endSec: 7 }), ["a moved text layer"]],
      [edit("b", { row: 2 }), ["a moved text layer"]],
      [edit("b", { endSec: 5 }), ["a trimmed text layer"]],
      [edit("b", { startSec: 3 }), ["a trimmed text layer"]],
      [edit("b", { startSec: 3, endSec: 5 }), ["a trimmed text layer"]],
      [edit("b", { startSec: 1, endSec: 7 }), ["a trimmed text layer"]],
      [split, ["a text layer split"]],
      [splitOverlayAt(split, "b2", 5, "b3")!.overlays, ["two text layer splits"]],
      [moveOverlays(split, ["b", "b2"], 1, 0).overlays, ["a moved text layer", "a text layer split"]],
      [trimOverlay(split, "b", { startSec: 3 }), ["a trimmed text layer", "a text layer split"]],
      [trimOverlay(trimOverlay(split, "b", { startSec: 3 }), "b2", { endSec: 5 }), ["a trimmed text layer", "a text layer split"]],
      [edit("b", { text: "Bye" }), ["an edited text layer"]],
      [edit("b", { fadeInSec: 2 }), ["an edited text layer"]],
      [edit("b", { wash: { opacity: 0 } }), ["an edited text layer"]],
      [initial.map((o) => (o.id === "c" ? o : { ...o, startSec: o.startSec + 1, endSec: o.endSec + 1 })), ["two moved text layers"]],
      [initial.filter((o) => o.id !== "a").map((o) => ({ ...o, color: "#000000" })), ["a removed text layer", "two edited text layers"]],
    ];
    for (const [draft, parts, origins] of cases) {
      expect(describeOverlayChanges(initial, draft, origins), parts.join(", ")).toEqual(parts);
    }
  });

  it("sees nothing in a row closed up by a removal, and no split in a layer added where another ends", () => {
    expect(describeOverlayChanges(initial, removeOverlays(initial, new Set(["b"])).overlays)).toEqual(["a removed text layer"]);
    expect(describeOverlayChanges(initial, [...initial, text("n", { startSec: 4, endSec: 8 })])).toEqual(["an added text layer"]);
    expect(describeOverlayChanges(initial, initial)).toEqual([]);
  });
});
