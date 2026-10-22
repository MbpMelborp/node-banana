import { isFontFileName } from "@/lib/edits/fontFiles";
import type { StitchOverlay, StitchTextOverlay } from "@/types";
import type { ClipboardOverlayItem } from "./clipboard";
import type { ClipOrigin, StitchDraft } from "./draft";
import { counted } from "./labels";
import { MAX_START_SEC } from "./timeline";

/**
 * The edit's overlays: layers drawn over the video, a text layer first, each
 * a box on an overlay row. Every edit is a pure recipe over the list, which
 * the editor's actions wrap and apply once.
 *
 * Rows are numbered from 0, the row nearest the video; a higher row draws in
 * front. The list is kept sorted by row, then start, then id. A move never
 * removes a row (an emptied row stays until a removal, a read or a write
 * compacts the rows), so nothing jumps after a release. Every recipe returns
 * the same array when nothing changes, and passes each layer it makes through
 * clampOverlay, so what the editor holds is what a save reads back.
 */

/** Row map of a recipe that renumbers rows: rowMap[oldRow] = newRow, or null for a row that is gone. */
export type OverlayRowMap = (number | null)[];

/** The rail's settings of a layer: everything but its identity and its place in time and rows. */
export type OverlayPatch = Partial<
  Pick<
    StitchTextOverlay,
    "fadeInSec" | "fadeOutSec" | "text" | "font" | "size" | "weight" | "color" | "align" | "x" | "y" | "wash"
  >
>;

/** What a draft without overlays reads as: one array, so selectors and staleness checks see no change. Not mutated. */
export const NO_OVERLAYS: StitchOverlay[] = [];
/** Splits are refused this close to a layer's ends, and trims keep a layer at least this long. */
export const MIN_OVERLAY_SEC = 0.1;
/** A new text layer's length. */
export const DEFAULT_OVERLAY_SEC = 4;
/** The longest layer, and the longest fade. */
export const MAX_OVERLAY_SEC = 600;
/** The longest text, in UTF-16 units. */
export const MAX_OVERLAY_TEXT = 2000;
/** The app's sans: a new layer's font, and the one a missing font falls back to. */
export const APP_SANS_FAMILY = "Space Grotesk";
/** A layer's text size, as a fraction of the frame's height. */
export const MIN_OVERLAY_SIZE = 0.01;
export const MAX_OVERLAY_SIZE = 0.5;

const MAX_FAMILY_LENGTH = 200;
const DEFAULT_FADE_SEC = 0.5;
const DEFAULT_SIZE = 0.08;
const DEFAULT_WEIGHT = 600;
const DEFAULT_COLOR = "#ffffff";
const DEFAULT_WASH = 0.5;
const ALIGNS: readonly StitchTextOverlay["align"][] = ["left", "center", "right"];
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
/** Overlaps and time differences smaller than this are float noise. */
const EPS = 1e-9;
const NO_IGNORE: ReadonlySet<string> = new Set();

type Fields = Record<string, unknown>;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isFields = (value: unknown): value is Fields => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const near = (a: number, b: number) => Math.abs(a - b) <= EPS;

/** The draft's overlays; NO_OVERLAYS when it has none. */
export function draftOverlays(d: Pick<StitchDraft, "overlays">): StitchOverlay[] {
  return d.overlays ?? NO_OVERLAYS;
}

export function newOverlayId(): string {
  return `ovl_${crypto.randomUUID().slice(0, 8)}`;
}

/** The first `max` UTF-16 units of `value`, less a surrogate pair's first half the cut would leave alone. */
function cutUnits(value: string, max: number): string {
  const cut = value.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

function cleanFamily(family: string): string {
  const clean = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  return clean(cutUnits(clean(family), MAX_FAMILY_LENGTH)) || APP_SANS_FAMILY;
}

const fadeOf = (sec: number) => (finite(sec) && sec >= 0 ? Math.min(sec, MAX_OVERLAY_SEC) : 0);
const unitOr = (value: number, fallback: number) => (finite(value) ? clamp(value, 0, 1) : fallback);

/**
 * The one set of rules for a layer's values, shared by every recipe, the rail's setters and the sanitizer, so the
 * editor never holds a value a save would read back otherwise (a new layer object, font and wash copied):
 * row a whole number >= 0, else 0. startSec 0..MAX_START_SEC, else 0. endSec kept when finite and after the start,
 * capped at start + MAX_OVERLAY_SEC, else start + MIN_OVERLAY_SEC. Fades 0..MAX_OVERLAY_SEC, else 0, never cut to the
 * length (overlayOpacityAt meets fades that overlap). text with "\n" line breaks, at most MAX_OVERLAY_TEXT units.
 * font.family with control characters out and whitespace collapsed, at most 200 characters, else the app's sans;
 * font.file only when it names a font file. size MIN..MAX_OVERLAY_SIZE, else 0.08. weight a whole 100..900, else 600.
 * color "#rrggbb" in lower case, else white. align one of the three, else "center". x, y and the wash 0..1, else 0.5.
 */
export function clampOverlay(o: StitchOverlay): StitchOverlay {
  const startSec = finite(o.startSec) ? clamp(o.startSec, 0, MAX_START_SEC) : 0;
  const endSec =
    finite(o.endSec) && o.endSec > startSec ? Math.min(o.endSec, startSec + MAX_OVERLAY_SEC) : startSec + MIN_OVERLAY_SEC;
  const file = o.font.file;
  return {
    id: o.id,
    kind: "text",
    row: Number.isInteger(o.row) && o.row >= 0 ? o.row : 0,
    startSec,
    endSec,
    fadeInSec: fadeOf(o.fadeInSec),
    fadeOutSec: fadeOf(o.fadeOutSec),
    text: cutUnits(o.text.replace(/\r\n?/g, "\n"), MAX_OVERLAY_TEXT),
    font: {
      family: cleanFamily(o.font.family),
      ...(typeof file === "string" && isFontFileName(file) ? { file } : {}),
    },
    size: finite(o.size) ? clamp(o.size, MIN_OVERLAY_SIZE, MAX_OVERLAY_SIZE) : DEFAULT_SIZE,
    weight: finite(o.weight) ? clamp(Math.round(o.weight), 100, 900) : DEFAULT_WEIGHT,
    color: HEX_COLOR.test(o.color) ? o.color.toLowerCase() : DEFAULT_COLOR,
    align: ALIGNS.includes(o.align) ? o.align : "center",
    x: unitOr(o.x, 0.5),
    y: unitOr(o.y, 0.5),
    wash: { opacity: unitOr(o.wash.opacity, DEFAULT_WASH) },
  };
}

/**
 * A new text layer: "Title" in the app's sans at 8 % of the frame's height, weight 600, white, centred, over a 0.5
 * wash, fading in and out over 0.5 s, 4 s long from its start. Any of it given in `init`, through clampOverlay.
 */
export function createTextOverlay(init: Partial<StitchTextOverlay> = {}): StitchOverlay {
  const startSec = init.startSec ?? 0;
  return clampOverlay({
    id: init.id ?? newOverlayId(),
    kind: "text",
    row: init.row ?? 0,
    startSec,
    endSec: init.endSec ?? startSec + DEFAULT_OVERLAY_SEC,
    fadeInSec: init.fadeInSec ?? DEFAULT_FADE_SEC,
    fadeOutSec: init.fadeOutSec ?? DEFAULT_FADE_SEC,
    text: init.text ?? "Title",
    font: init.font ?? { family: APP_SANS_FAMILY },
    size: init.size ?? DEFAULT_SIZE,
    weight: init.weight ?? DEFAULT_WEIGHT,
    color: init.color ?? DEFAULT_COLOR,
    align: init.align ?? "center",
    x: init.x ?? 0.5,
    y: init.y ?? 0.5,
    wash: init.wash ?? { opacity: DEFAULT_WASH },
  });
}

/** An entry's fields in their types, before clampOverlay judges the values: a wrong type reads as NaN or "". */
function readTextOverlay(id: string, entry: Fields): StitchOverlay {
  const number = (value: unknown) => (typeof value === "number" ? value : Number.NaN);
  const string = (value: unknown) => (typeof value === "string" ? value : "");
  const font = isFields(entry.font) ? entry.font : {};
  return {
    id,
    kind: "text",
    row: number(entry.row),
    startSec: number(entry.startSec),
    endSec: number(entry.endSec),
    fadeInSec: number(entry.fadeInSec),
    fadeOutSec: number(entry.fadeOutSec),
    text: string(entry.text),
    font: { family: string(font.family), ...(typeof font.file === "string" ? { file: font.file } : {}) },
    size: number(entry.size),
    weight: number(entry.weight),
    color: string(entry.color),
    align: entry.align as StitchTextOverlay["align"],
    x: number(entry.x),
    y: number(entry.y),
    wash: { opacity: number(isFields(entry.wash) ? entry.wash.opacity : undefined) },
  };
}

/**
 * A stored or sent list. Drops entries that are not objects, of a kind this build does not know (a later build's
 * layers are lost when this one writes the list), or without a string id; a repeated id gets `${id}~2`… Every value
 * through clampOverlay. Sorted, rows compacted. A fixed point of every recipe here: their output reads back as is.
 */
export function sanitizeOverlays(raw: unknown): StitchOverlay[] {
  if (!Array.isArray(raw)) return [];
  const overlays: StitchOverlay[] = [];
  const ids = new Set<string>();
  for (const entry of raw as unknown[]) {
    if (!isFields(entry) || entry.kind !== "text" || typeof entry.id !== "string" || !entry.id) continue;
    let id = entry.id;
    for (let n = 2; ids.has(id); n++) id = `${entry.id}~${n}`;
    ids.add(id);
    overlays.push(clampOverlay(readTextOverlay(id, entry)));
  }
  return compactOverlayRows(normalizeOverlays(overlays)).overlays;
}

/** The list's order, and the order layers are painted in: by row, then start, then id. */
export function overlayOrder(a: StitchOverlay, b: StitchOverlay): number {
  return a.row - b.row || a.startSec - b.startSec || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Sorted by row, start, id. Rows are not renumbered. The same array when already sorted. */
export function normalizeOverlays(overlays: readonly StitchOverlay[]): StitchOverlay[] {
  const sorted = overlays.every((o, i) => i === 0 || overlayOrder(overlays[i - 1], o) <= 0);
  return sorted ? (overlays as StitchOverlay[]) : [...overlays].sort(overlayOrder);
}

/** Rows renumbered 0..R−1 in their order, empty ones dropped. The same array when no row changes. */
export function compactOverlayRows(overlays: readonly StitchOverlay[]): {
  overlays: StitchOverlay[];
  rowMap: OverlayRowMap;
} {
  const used = [...new Set(overlays.map((o) => o.row))].sort((a, b) => a - b);
  const rowMap: OverlayRowMap = Array.from({ length: overlayRowCount(overlays) }, () => null);
  used.forEach((row, i) => (rowMap[row] = i));
  if (used.every((row, i) => row === i)) return { overlays: overlays as StitchOverlay[], rowMap };
  return { overlays: overlays.map((o) => ({ ...o, row: rowMap[o.row]! })), rowMap };
}

/** Highest row + 1 (empty rows included), 0 for no overlays. */
export function overlayRowCount(overlays: readonly StitchOverlay[]): number {
  return overlays.reduce((count, o) => Math.max(count, o.row + 1), 0);
}

const identityRows = (count: number): OverlayRowMap => Array.from({ length: count }, (_, row) => row);

/** Rows after `after` are renumbered up by `count` (rows inserted after it). */
const insertedRows = (rowCount: number, after: number, count: number): OverlayRowMap =>
  Array.from({ length: rowCount }, (_, row) => (row <= after ? row : row + count));

/** Whether [start, start + length) overlaps a layer on `row`, the layers in `ignore` aside. */
export function overlayOverlapsOnRow(
  overlays: readonly StitchOverlay[],
  row: number,
  start: number,
  length: number,
  ignore: ReadonlySet<string>,
): boolean {
  return overlays.some(
    (o) => o.row === row && !ignore.has(o.id) && o.startSec < start + length - EPS && start < o.endSec - EPS,
  );
}

const clampStart = (sec: number) => clamp(finite(sec) ? sec : 0, 0, MAX_START_SEC);

/** The layer at `row`, its start and end moved by deltaSec. */
const placed = (o: StitchOverlay, row: number, deltaSec: number) =>
  clampOverlay({ ...o, row, startSec: o.startSec + deltaSec, endSec: o.endSec + deltaSec });

/**
 * A move of one or several layers: each id gets start and end + deltaSec and row + deltaRow, clamped so the group
 * keeps its spacing (the earliest start >= 0, the latest <= MAX_START_SEC, the lowest row >= 0, the highest at most
 * one past the last: a new row). When any moved layer would overlap an unmoved one on its target row, the whole group
 * goes onto new rows numbered after the highest target row (insertedAfter), keeping its row spacing, and the rows
 * after them move up by its span. Rows are never compacted. The same array when nothing changes.
 */
export function moveOverlays(
  overlays: StitchOverlay[],
  ids: readonly string[],
  deltaSec: number,
  deltaRow: number,
): { overlays: StitchOverlay[]; rowMap: OverlayRowMap; newRow: boolean; insertedAfter: number | null } {
  const rowCount = overlayRowCount(overlays);
  const moving = new Set(ids);
  const moved = overlays.filter((o) => moving.has(o.id));
  const unchanged = { overlays, rowMap: identityRows(rowCount), newRow: false, insertedAfter: null };
  if (moved.length === 0) return unchanged;
  const starts = moved.map((o) => o.startSec);
  const rows = moved.map((o) => o.row);
  const dt = clamp(finite(deltaSec) ? deltaSec : 0, -Math.min(...starts), MAX_START_SEC - Math.max(...starts));
  const dr = clamp(finite(deltaRow) ? Math.round(deltaRow) : 0, -Math.min(...rows), rowCount - Math.max(...rows));
  if (dt === 0 && dr === 0) return unchanged;

  const blocked = moved.some((o) =>
    overlayOverlapsOnRow(overlays, o.row + dr, o.startSec + dt, o.endSec - o.startSec, moving),
  );
  if (!blocked) {
    const next = overlays.map((o) => (moving.has(o.id) ? placed(o, o.row + dr, dt) : o));
    return {
      overlays: normalizeOverlays(next),
      rowMap: identityRows(rowCount),
      newRow: moved.some((o) => o.row + dr >= rowCount),
      insertedAfter: null,
    };
  }
  const low = Math.min(...rows) + dr;
  // A group reaching the new-row slot goes in after the last row, leaving no empty row that never existed
  const after = Math.min(Math.max(...rows) + dr, rowCount - 1);
  const span = Math.max(...rows) - Math.min(...rows) + 1;
  const next = overlays.map((o) => {
    if (moving.has(o.id)) return placed(o, after + 1 + (o.row + dr - low), dt);
    return o.row > after ? { ...o, row: o.row + span } : o;
  });
  return {
    overlays: normalizeOverlays(next),
    rowMap: insertedRows(rowCount, after, span),
    newRow: true,
    insertedAfter: after,
  };
}

/** The layer before and after `o` on its row (by start), its own id aside. */
function rowNeighbours(overlays: readonly StitchOverlay[], o: StitchOverlay) {
  const others = overlays.filter((other) => other.row === o.row && other.id !== o.id);
  const before = others.filter((other) => other.startSec <= o.startSec);
  const after = others.filter((other) => other.startSec > o.startSec);
  return {
    previous: before.length > 0 ? before[before.length - 1] : undefined,
    next: after.length > 0 ? after[0] : undefined,
  };
}

/**
 * Moves one or both edges of a layer, the fades kept. The start: no earlier than 0:00, the previous layer's end on its
 * row, or MAX_OVERLAY_SEC before the end; no later than MIN_OVERLAY_SEC before the end. The end (after the start's
 * move): no earlier than MIN_OVERLAY_SEC after the start; no later than the next layer's start on its row, or
 * MAX_OVERLAY_SEC after the start. The same array when nothing changes.
 */
export function trimOverlay(
  overlays: StitchOverlay[],
  id: string,
  patch: { startSec?: number; endSec?: number },
): StitchOverlay[] {
  const o = overlays.find((other) => other.id === id);
  if (!o) return overlays;
  const { previous, next } = rowNeighbours(overlays, o);
  let { startSec, endSec } = o;
  if (finite(patch.startSec)) {
    const min = Math.max(0, previous?.endSec ?? 0, endSec - MAX_OVERLAY_SEC);
    const max = Math.min(endSec - MIN_OVERLAY_SEC, MAX_START_SEC);
    if (max >= min) startSec = clamp(patch.startSec, min, max);
  }
  if (finite(patch.endSec)) {
    const min = startSec + MIN_OVERLAY_SEC;
    const max = Math.min(next?.startSec ?? Infinity, startSec + MAX_OVERLAY_SEC);
    if (max >= min) endSec = clamp(patch.endSec, min, max);
  }
  if (startSec === o.startSec && endSec === o.endSec) return overlays;
  const trimmed = clampOverlay({ ...o, startSec, endSec });
  return normalizeOverlays(overlays.map((other) => (other.id === id ? trimmed : other)));
}

/**
 * Splits layer `id` at sequence time t (at least MIN_OVERLAY_SEC from both ends, and no later than 10:00, where the
 * right piece could not start). The left piece keeps the id, ends at t with no fade out, its fade in at most its
 * length; the right one gets rightId, starts at t on the same row with no fade in, its fade out at most its length.
 * Outside the fades the picture is what it was. null when refused.
 */
export function splitOverlayAt(
  overlays: StitchOverlay[],
  id: string,
  t: number,
  rightId: string = newOverlayId(),
): { overlays: StitchOverlay[]; rightId: string } | null {
  const o = overlays.find((other) => other.id === id);
  if (!o || !finite(t) || t > MAX_START_SEC) return null;
  if (t - o.startSec < MIN_OVERLAY_SEC || o.endSec - t < MIN_OVERLAY_SEC) return null;
  const left = clampOverlay({ ...o, endSec: t, fadeInSec: Math.min(o.fadeInSec, t - o.startSec), fadeOutSec: 0 });
  const right = clampOverlay({
    ...o,
    id: rightId,
    startSec: t,
    fadeInSec: 0,
    fadeOutSec: Math.min(o.fadeOutSec, o.endSec - t),
  });
  const next = overlays.flatMap((other) => (other.id === id ? [left, right] : [other]));
  return { overlays: normalizeOverlays(next), rightId };
}

/** Removes them and compacts the rows. */
export function removeOverlays(
  overlays: StitchOverlay[],
  ids: ReadonlySet<string>,
): { overlays: StitchOverlay[]; rowMap: OverlayRowMap } {
  const kept = overlays.filter((o) => !ids.has(o.id));
  if (kept.length === overlays.length) return { overlays, rowMap: identityRows(overlayRowCount(overlays)) };
  const compacted = compactOverlayRows(kept);
  // Rows past the last kept layer are gone too
  const rowMap = Array.from({ length: overlayRowCount(overlays) }, (_, row) => compacted.rowMap[row] ?? null);
  return { overlays: compacted.overlays, rowMap };
}

/**
 * The rail's settings on one layer, through clampOverlay (a key given as undefined is left alone). The same array when
 * the layer is not there or no value changes; font and wash compare by value.
 */
export function updateOverlay(overlays: StitchOverlay[], id: string, patch: OverlayPatch): StitchOverlay[] {
  const o = overlays.find((other) => other.id === id);
  if (!o) return overlays;
  const given = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
  const next = clampOverlay({ ...o, ...given });
  if (sameOverlay(o, next)) return overlays;
  return overlays.map((other) => (other.id === id ? next : other));
}

/**
 * A new text layer at clamp(at, 0, 10:00), DEFAULT_OVERLAY_SEC long, the rest from createTextOverlay and `init`: on the
 * first row from 0 with room for it, else on a new row after the last.
 */
export function addTextOverlayAt(
  overlays: StitchOverlay[],
  at: number,
  init: OverlayPatch = {},
): { overlays: StitchOverlay[]; id: string } {
  const startSec = clampStart(at);
  const rowCount = overlayRowCount(overlays);
  let row = 0;
  while (row < rowCount && overlayOverlapsOnRow(overlays, row, startSec, DEFAULT_OVERLAY_SEC, NO_IGNORE)) row++;
  const overlay = createTextOverlay({ ...init, row, startSec });
  return { overlays: normalizeOverlays([...overlays, overlay]), id: overlay.id };
}

/** A layer's settings without its place (id, row, start and end), as a copy. */
function settingsOf(o: StitchOverlay): ClipboardOverlayItem["overlay"] {
  return {
    kind: o.kind,
    fadeInSec: o.fadeInSec,
    fadeOutSec: o.fadeOutSec,
    text: o.text,
    font: { ...o.font },
    size: o.size,
    weight: o.weight,
    color: o.color,
    align: o.align,
    x: o.x,
    y: o.y,
    wash: { ...o.wash },
  };
}

/** The listed layers (overlay order) as clipboard items: offsetSec from the earliest start, rowOffset from the lowest. */
export function copyOverlayItems(overlays: readonly StitchOverlay[], ids: readonly string[]): ClipboardOverlayItem[] {
  const wanted = new Set(ids);
  const selected = overlays.filter((o) => wanted.has(o.id));
  if (selected.length === 0) return [];
  const earliest = Math.min(...selected.map((o) => o.startSec));
  const lowest = Math.min(...selected.map((o) => o.row));
  return selected.map((o) => ({
    track: "overlay",
    overlay: settingsOf(o),
    lengthSec: o.endSec - o.startSec,
    offsetSec: o.startSec - earliest,
    rowOffset: o.row - lowest,
  }));
}

/**
 * New layers from items on new rows after the last (in front): the first at `at`, or earlier when the latest would
 * start after 10:00; lengths, time and row spacing kept.
 */
export function pasteOverlays(
  overlays: StitchOverlay[],
  items: readonly ClipboardOverlayItem[],
  at: number,
): { overlays: StitchOverlay[]; ids: string[] } {
  if (items.length === 0) return { overlays, ids: [] };
  const first = overlayRowCount(overlays);
  const start = Math.min(clampStart(at), MAX_START_SEC - Math.max(...items.map((item) => item.offsetSec)));
  const added = items.map((item) => {
    const startSec = start + item.offsetSec;
    return clampOverlay({
      ...item.overlay,
      id: newOverlayId(),
      row: first + item.rowOffset,
      startSec,
      endSec: startSec + item.lengthSec,
    });
  });
  return { overlays: normalizeOverlays([...overlays, ...added]), ids: added.map((o) => o.id) };
}

/**
 * Copies of `ids` (new ids), the earliest starting at the latest end of the selection, the spacing kept. On their own
 * rows when every copy fits there; otherwise all on new rows numbered after the highest selected row, row spacing
 * kept, the rows after it moving up by the selection's span.
 */
export function duplicateOverlays(
  overlays: StitchOverlay[],
  ids: readonly string[],
): { overlays: StitchOverlay[]; ids: string[]; rowMap: OverlayRowMap } {
  const rowCount = overlayRowCount(overlays);
  const wanted = new Set(ids);
  const selected = overlays.filter((o) => wanted.has(o.id));
  if (selected.length === 0) return { overlays, ids: [], rowMap: identityRows(rowCount) };
  const earliest = Math.min(...selected.map((o) => o.startSec));
  const latest = Math.max(...selected.map((o) => o.startSec));
  const shift = Math.min(Math.max(...selected.map((o) => o.endSec)) - earliest, MAX_START_SEC - latest);
  const copies = selected.map((o) => placed({ ...o, id: newOverlayId() }, o.row, shift));
  const fits = copies.every(
    (copy) => !overlayOverlapsOnRow(overlays, copy.row, copy.startSec, copy.endSec - copy.startSec, NO_IGNORE),
  );
  const newIds = copies.map((copy) => copy.id);
  if (fits) {
    return { overlays: normalizeOverlays([...overlays, ...copies]), ids: newIds, rowMap: identityRows(rowCount) };
  }
  const low = Math.min(...selected.map((o) => o.row));
  const high = Math.max(...selected.map((o) => o.row));
  const span = high - low + 1;
  const shifted = overlays.map((o) => (o.row > high ? { ...o, row: o.row + span } : o));
  const moved = copies.map((copy) => ({ ...copy, row: high + 1 + (copy.row - low) }));
  return {
    overlays: normalizeOverlays([...shifted, ...moved]),
    ids: newIds,
    rowMap: insertedRows(rowCount, high, span),
  };
}

/** The same picture whenever it shows: kind, text, font, size, weight, colour, alignment, position and wash. */
function sameLook(a: StitchOverlay, b: StitchOverlay): boolean {
  return (
    a.kind === b.kind &&
    a.text === b.text &&
    a.font.family === b.font.family &&
    a.font.file === b.font.file &&
    a.size === b.size &&
    a.weight === b.weight &&
    a.color === b.color &&
    a.align === b.align &&
    a.x === b.x &&
    a.y === b.y &&
    a.wash.opacity === b.wash.opacity
  );
}

function sameOverlay(a: StitchOverlay, b: StitchOverlay): boolean {
  return (
    a.id === b.id &&
    a.row === b.row &&
    a.startSec === b.startSec &&
    a.endSec === b.endSec &&
    a.fadeInSec === b.fadeInSec &&
    a.fadeOutSec === b.fadeOutSec &&
    sameLook(a, b)
  );
}

/** By value on the compacted forms (an empty row a move left is not a change), every field. */
export function sameOverlays(a: readonly StitchOverlay[], b: readonly StitchOverlay[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  const left = compactOverlayRows(normalizeOverlays(a)).overlays;
  const right = compactOverlayRows(normalizeOverlays(b)).overlays;
  return left.every((o, i) => sameOverlay(o, right[i]));
}

/**
 * Every layer of `a` is on the same row in `b`. sameOverlays compares the rows compacted (a row a move emptied is no
 * change to save), but the editor draws that row until a removal: a move that empties one is still an edit.
 */
export function sameOverlayRows(a: readonly StitchOverlay[], b: readonly StitchOverlay[]): boolean {
  return a.every((o) => b.find((other) => other.id === o.id)?.row === o.row);
}

/** Each layer's row as a rank among the rows the listed layers use, so a row closed up by a removal is no move. */
function rowRanks(overlays: readonly StitchOverlay[], ids: ReadonlySet<string>): Map<string, number> {
  const kept = overlays.filter((o) => ids.has(o.id));
  const rows = [...new Set(kept.map((o) => o.row))].sort((a, b) => a - b);
  return new Map(kept.map((o) => [o.id, rows.indexOf(o.row)]));
}

/**
 * The added layers that continue `now` as split pieces, taken from `added`: a chain of layers with the look it had,
 * each starting where the one before ends. `end` is where the chain ends; whole when that is where `now` would end
 * with the length it had, so its shorter box is only the split, wherever it moved.
 */
function splitChain(
  was: StitchOverlay,
  now: StitchOverlay,
  added: readonly StitchOverlay[],
  taken: Set<string>,
): { pieces: number; end: number; whole: boolean } {
  const whole = now.startSec + (was.endSec - was.startSec);
  let end = now.endSec;
  let pieces = 0;
  while (!near(end, whole)) {
    const piece = added.find((o) => !taken.has(o.id) && near(o.startSec, end) && sameLook(o, was));
    if (!piece) break;
    taken.add(piece.id);
    pieces++;
    end = piece.endSec;
  }
  return { pieces, end, whole: near(end, whole) };
}

/**
 * The discard sheet's overlay parts, matching layers by id: added, pasted, duplicated, removed, cut, moved (both ends
 * the same way in time, or to another row), trimmed, split and edited layers (any setting or a fade, but the fades a
 * split gives its left piece). An added layer is a split piece when it continues a layer's box with that layer's look,
 * unless `origins` says it was pasted or duplicated.
 */
export function describeOverlayChanges(
  initial: readonly StitchOverlay[],
  draft: readonly StitchOverlay[],
  origins: ReadonlyMap<string, ClipOrigin> = new Map(),
): string[] {
  const before = new Map(initial.map((o) => [o.id, o]));
  const after = new Map(draft.map((o) => [o.id, o]));
  const fresh = draft.filter((o) => !before.has(o.id));
  const pasted = fresh.filter((o) => origins.get(o.id) === "pasted").length;
  const duplicated = fresh.filter((o) => origins.get(o.id) === "duplicated").length;
  const added = fresh.filter((o) => origins.get(o.id) !== "pasted" && origins.get(o.id) !== "duplicated");
  const gone = initial.filter((o) => !after.has(o.id));
  const cut = gone.filter((o) => origins.get(o.id) === "cut").length;

  const common = new Set(draft.filter((o) => before.has(o.id)).map((o) => o.id));
  const ranksBefore = rowRanks(initial, common);
  const ranksAfter = rowRanks(draft, common);
  const pieces = new Set<string>();
  let moved = 0;
  let trimmed = 0;
  let edited = 0;
  for (const o of draft) {
    const was = before.get(o.id);
    if (!was) continue;
    const split = splitChain(was, o, added, pieces);
    // Both ends of its box (split pieces included) moved the same way: a trim moves one, or both apart or together
    const startDelta = o.startSec - was.startSec;
    const endDelta = split.end - was.endSec;
    const shifted = !near(startDelta, 0) && !near(endDelta, 0) && Math.sign(startDelta) === Math.sign(endDelta);
    if (shifted || ranksBefore.get(o.id) !== ranksAfter.get(o.id)) moved++;
    if (!split.whole) trimmed++;
    const fadeIn = split.pieces > 0 ? Math.min(was.fadeInSec, o.endSec - o.startSec) : was.fadeInSec;
    const fadeOut = split.pieces > 0 ? 0 : was.fadeOutSec;
    if (!sameLook(was, o) || !near(o.fadeInSec, fadeIn) || !near(o.fadeOutSec, fadeOut)) edited++;
  }

  return [
    counted(added.length - pieces.size, "an added text layer", "added text layers"),
    counted(pasted, "a pasted text layer", "pasted text layers"),
    counted(duplicated, "a duplicated text layer", "duplicated text layers"),
    counted(gone.length - cut, "a removed text layer", "removed text layers"),
    counted(cut, "a cut text layer", "cut text layers"),
    counted(moved, "a moved text layer", "moved text layers"),
    counted(trimmed, "a trimmed text layer", "trimmed text layers"),
    counted(pieces.size, "a text layer split", "text layer splits"),
    counted(edited, "an edited text layer", "edited text layers"),
  ].filter((part): part is string => part !== null);
}

/**
 * How opaque a layer is at sequence time t, 0..1: 0 before its start and from its end on; rising linearly over
 * fadeInSec from the start and falling over fadeOutSec to the end, the lower of the two where they overlap (so fades
 * that overlap peak below 1). A fade of 0 is a cut. The drawing, the render, Frame to canvas and the timeline's ramps
 * all read it.
 */
export function overlayOpacityAt(
  o: Pick<StitchOverlay, "startSec" | "endSec" | "fadeInSec" | "fadeOutSec">,
  t: number,
): number {
  if (!(t >= o.startSec && t < o.endSec)) return 0;
  const rise = o.fadeInSec > 0 ? (t - o.startSec) / o.fadeInSec : 1;
  const fall = o.fadeOutSec > 0 ? (o.endSec - t) / o.fadeOutSec : 1;
  return clamp(Math.min(rise, fall), 0, 1);
}

/**
 * The corners of overlayOpacityAt's curve, for the box's ramps: from 0 at startSec up to `peak` at fadeInEnd, level
 * to fadeOutStart, down to 0 at endSec. Fades that overlap meet in one corner below 1.
 */
export function overlayFadeKnees(o: Pick<StitchOverlay, "startSec" | "endSec" | "fadeInSec" | "fadeOutSec">): {
  fadeInEnd: number;
  fadeOutStart: number;
  peak: number;
} {
  const length = o.endSec - o.startSec;
  const fades = o.fadeInSec + o.fadeOutSec;
  if (fades <= length) return { fadeInEnd: o.startSec + o.fadeInSec, fadeOutStart: o.endSec - o.fadeOutSec, peak: 1 };
  const at = (o.endSec * o.fadeInSec + o.startSec * o.fadeOutSec) / fades;
  return { fadeInEnd: at, fadeOutStart: at, peak: length / fades };
}
