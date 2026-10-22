import {
  overlaySelectionOf,
  selectedOverlayIds,
  useStitchEditorStore,
  type StitchEditorState,
} from "@/store/stitchEditorStore";
import type { ClipOrigin } from "@/lib/stitch/draft";
import {
  addTextOverlayAt,
  draftOverlays,
  MIN_OVERLAY_SEC,
  moveOverlays,
  removeOverlays,
  splitOverlayAt,
  trimOverlay,
  updateOverlay as patchOverlay,
  type OverlayPatch,
} from "@/lib/stitch/overlays";
import { FRAME_RATE } from "@/lib/stitch/sequencePlan";
import { makeSelection } from "@/lib/stitch/selection";
import { END_EPSILON_SEC } from "@/lib/stitch/timeline";
import type { StitchOverlay } from "@/types";
import { BIG_NUDGE_FRAMES, drawnPlayhead, editorTotal, NUDGE_SEC } from "./editorActions";

/**
 * What the editor's keys, menus and rail do to its overlays. Each reads the
 * store at call time, calls one recipe of overlays.ts and applies once, as
 * editorActions does for audio clips.
 */

const editor = () => useStitchEditorStore.getState();

/** Selects these overlays (none: nothing selected), `lead` leading, else the first in overlay order. */
export function selectOverlays(ids: readonly string[], lead?: string): void {
  const s = editor();
  const order = s.draft ? draftOverlays(s.draft).map((o) => o.id) : [];
  const selection = makeSelection(order, ids, lead ?? ids[0]);
  s.select(selection ? overlaySelectionOf(selection) : null);
}

/** The single selected overlay, or null (none, another kind, or several). */
function singleOverlay(s: StitchEditorState): StitchOverlay | null {
  const ids = selectedOverlayIds(s);
  if (!s.draft || ids.length !== 1) return null;
  return draftOverlays(s.draft).find((o) => o.id === ids[0]) ?? null;
}

/**
 * "+ Text" and Add text: a new text layer over a paused preview, as one undo step, selected. It starts at the
 * playhead, or at 0:00 when the playhead is at the end or there is no video; while the playhead is where the selected
 * layer's fade in ends (the playhead a layer just added left), at that layer's start, so a second press gives a
 * subtitle with the title. On the first row from the bottom with room, else a new row in front. With video the
 * playhead then goes to where its fade in ends, so the stage shows it whole. Returns its id.
 */
export function addTextOverlay(): string | null {
  if (!editor().draft) return null;
  editor().setPlaying(false);
  editor().openMenu(null);
  // Read after the pause: it lands the store's playhead on the frame the preview stopped on.
  const s = editor();
  if (!s.draft) return null;
  const total = editorTotal(s);
  const at = drawnPlayhead(s);
  const lead = s.selection?.kind === "overlay" ? draftOverlays(s.draft).find((o) => o.id === s.selection?.clipId) : undefined;
  const start =
    lead && Math.abs(at - (lead.startSec + lead.fadeInSec)) <= 1e-9
      ? lead.startSec
      : at >= total - END_EPSILON_SEC
        ? 0
        : at;
  const { overlays, id } = addTextOverlayAt(draftOverlays(s.draft), start);
  s.apply((d) => ({ ...d, overlays }));
  selectOverlays([id]);
  const added = overlays.find((o) => o.id === id);
  if (added && total > 0) editor().setPlayhead(Math.max(0, Math.min(added.startSec + added.fadeInSec, total - 1 / FRAME_RATE)));
  return id;
}

/** Overlays a paste or a duplicate made, in one step: tagged and selected, the first leading. */
export function insertOverlayCopies(
  result: { overlays: StitchOverlay[]; ids: string[] },
  origin: Extract<ClipOrigin, "pasted" | "duplicated">,
): void {
  if (result.ids.length === 0) return;
  editor().apply((d) => ({ ...d, overlays: result.overlays }));
  editor().tagClips(result.ids, origin);
  selectOverlays(result.ids);
}

/**
 * A body drag's release: the overlays it drew (moveOverlays over the overlays at the press), as one undo step.
 * Dropped when the draft's overlays changed under the drag.
 */
export function moveOverlaysBody(from: readonly StitchOverlay[], next: { overlays: StitchOverlay[] }): void {
  const s = editor();
  if (!s.draft || draftOverlays(s.draft) !== from || next.overlays === from) return;
  s.apply((d) => ({ ...d, overlays: next.overlays }));
}

/**
 * An edge drag's release: the layer's start or end as drawn (trimOverlay over the overlays at the press), one undo
 * step. Dropped when the overlays changed under the drag.
 */
export function trimOverlayBody(
  from: readonly StitchOverlay[],
  id: string,
  patch: { startSec?: number; endSec?: number },
): void {
  const s = editor();
  if (!s.draft || draftOverlays(s.draft) !== from) return;
  const overlays = trimOverlay(draftOverlays(s.draft), id, patch);
  if (overlays !== from) s.apply((d) => ({ ...d, overlays }));
}

/** The selected overlays by a time and a row delta (moveOverlays: an overlap sends them onto new rows). */
function moveSelectedOverlays(deltaSec: number, deltaRow: number, opts?: { gestureKey?: string }): void {
  const s = editor();
  const ids = selectedOverlayIds(s);
  if (!s.draft || ids.length === 0) return;
  const list = draftOverlays(s.draft);
  const result = moveOverlays(list, ids, deltaSec, deltaRow);
  if (result.overlays !== list) s.apply((d) => ({ ...d, overlays: result.overlays }), opts);
}

/** ⌥← / ⌥→ with text layers selected: one output frame (⇧: ten), in Track too. A held key's repeats are one step. */
export function nudgeSelectedOverlays(dir: 1 | -1, big: boolean, repeat: boolean): void {
  const s = editor();
  const ids = selectedOverlayIds(s);
  if (ids.length === 0) return;
  if (!repeat) s.endGesture();
  moveSelectedOverlays(dir * (big ? BIG_NUDGE_FRAMES : 1) * NUDGE_SEC, 0, { gestureKey: `overlay-nudge:${ids.join(",")}` });
}

/** ⌥↑ / ⌥↓ and the menu: whether the selected layers have a row to go to (up always: a new row in front). */
export function canMoveOverlayRow(s: StitchEditorState, dir: 1 | -1): boolean {
  const ids = new Set(selectedOverlayIds(s));
  if (!s.draft || ids.size === 0) return false;
  return dir === 1 || draftOverlays(s.draft).every((o) => !ids.has(o.id) || o.row > 0);
}

/** ⌥↑ (+1) / ⌥↓ (−1) with text layers selected: one row up (in front) or down; up from the top row makes a new row. */
export function moveSelectedOverlayRow(dir: 1 | -1): void {
  moveSelectedOverlays(0, dir);
}

/** The layer starts at `sec`, its length kept: [, ] and the rail's Start. One undo step, or one per gesture. */
export function setOverlayStart(id: string, sec: number, opts?: { gestureKey?: string }): void {
  const s = editor();
  if (!s.draft || !Number.isFinite(sec)) return;
  const list = draftOverlays(s.draft);
  const o = list.find((other) => other.id === id);
  if (!o) return;
  const result = moveOverlays(list, [id], sec - o.startSec, 0);
  if (result.overlays !== list) s.apply((d) => ({ ...d, overlays: result.overlays }), opts);
}

/** [ and the menu, with text layers selected: one layer is selected. */
export function canStartOverlayAtPlayhead(s: StitchEditorState): boolean {
  return singleOverlay(s) !== null;
}

/** ] and the menu: the selected layer fits before the playhead. */
export function canEndOverlayAtPlayhead(s: StitchEditorState): boolean {
  const o = singleOverlay(s);
  return o !== null && drawnPlayhead(s) - (o.endSec - o.startSec) >= -1e-9;
}

/** [ with a text layer selected: it starts at the playhead. */
export function startSelectedOverlayAtPlayhead(): void {
  const s = editor();
  const o = singleOverlay(s);
  if (o) setOverlayStart(o.id, drawnPlayhead(s));
}

/** ] with a text layer selected: it ends at the playhead; nothing when it would have to start before 0:00. */
export function endSelectedOverlayAtPlayhead(): void {
  const s = editor();
  const o = canEndOverlayAtPlayhead(s) ? singleOverlay(s) : null;
  if (o) setOverlayStart(o.id, Math.max(0, drawnPlayhead(s) - (o.endSec - o.startSec)));
}

/**
 * I / O with a text layer selected: its start or its end at the playhead, the other edge kept, when the playhead is
 * inside it by at least MIN_OVERLAY_SEC from both ends.
 */
export function setOverlayEdgeAtPlayhead(edge: "in" | "out"): void {
  const s = editor();
  const o = singleOverlay(s);
  const t = drawnPlayhead(s);
  if (!s.draft || !o || t - o.startSec < MIN_OVERLAY_SEC || o.endSec - t < MIN_OVERLAY_SEC) return;
  const list = draftOverlays(s.draft);
  const overlays = trimOverlay(list, o.id, edge === "in" ? { startSec: t } : { endSec: t });
  if (overlays !== list) s.apply((d) => ({ ...d, overlays }));
}

/** The cuts S would make: every selected layer under the playhead with room to split, in overlay order. */
function overlaySplits(s: StitchEditorState): { overlays: StitchOverlay[]; rightIds: string[] } | null {
  if (!s.draft) return null;
  const t = drawnPlayhead(s);
  let overlays = draftOverlays(s.draft);
  const rightIds: string[] = [];
  for (const id of selectedOverlayIds(s)) {
    const split = splitOverlayAt(overlays, id, t);
    if (!split) continue;
    overlays = split.overlays;
    rightIds.push(split.rightId);
  }
  return rightIds.length > 0 ? { overlays, rightIds } : null;
}

/** Whether S would split a selected text layer now. */
export function canSplitOverlaysAtPlayhead(s: StitchEditorState): boolean {
  return overlaySplits(s) !== null;
}

/** S with text layers selected: every selected layer under the playhead splits; the right pieces are selected. */
export function splitSelectedOverlaysAtPlayhead(): void {
  const split = overlaySplits(editor());
  if (!split) return;
  editor().apply((d) => ({ ...d, overlays: split.overlays }));
  selectOverlays(split.rightIds);
}

/**
 * Removes the listed overlays in one step, the rows closing up. The overlay now at the first removed place (overlay
 * order) takes the selection. Returns the ids removed.
 */
export function removeOverlaysById(ids: readonly string[]): string[] {
  const s = editor();
  if (!s.draft) return [];
  const list = draftOverlays(s.draft);
  const wanted = new Set(ids);
  const index = list.findIndex((o) => wanted.has(o.id));
  if (index === -1) return [];
  const removed = list.filter((o) => wanted.has(o.id)).map((o) => o.id);
  const { overlays } = removeOverlays(list, wanted);
  s.apply((d) => ({ ...d, overlays }));
  const neighbour = overlays[Math.min(index, overlays.length - 1)];
  editor().select(neighbour ? overlaySelectionOf({ clipId: neighbour.id }) : null);
  return removed;
}

/** ⌫ with text layers selected: all of them. */
export function removeOverlaySelection(): void {
  const s = editor();
  editor().untagCut(removeOverlaysById(selectedOverlayIds(s)));
}

/**
 * The rail's settings on one layer (updateOverlay: clamped, nothing when no value changes), one undo step, or one per
 * gesture with opts.gestureKey (a slider's drag, typing in the text).
 */
export function updateOverlay(id: string, patch: OverlayPatch, opts?: { gestureKey?: string }): void {
  const s = editor();
  if (!s.draft) return;
  const list = draftOverlays(s.draft);
  const overlays = patchOverlay(list, id, patch);
  if (overlays !== list) s.apply((d) => ({ ...d, overlays }), opts);
}
