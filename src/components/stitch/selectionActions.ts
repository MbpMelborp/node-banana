import { selectedClipIds, useStitchEditorStore, type StitchEditorState } from "@/store/stitchEditorStore";
import {
  clipIdsOf,
  makeSelection,
  rangeTo,
  selectAll,
  toggleClip,
  type ClipSelection,
} from "@/lib/stitch/selection";

/**
 * How clicks, ⌘A and the selection box change which clips are selected. A
 * selection change is not an undo step.
 */

const editor = () => useStitchEditorStore.getState();

const orderOf = (s: StitchEditorState): string[] => s.draft?.timeline.map((c) => c.id) ?? [];
const clipSelectionOf = (s: StitchEditorState): ClipSelection | null =>
  s.selection?.kind === "clip" ? s.selection : null;

function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

/** ⌘ on a Mac, Ctrl elsewhere: adds a clip to the selection or takes it out. */
export function isToggleClick(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMac() ? e.metaKey : e.ctrlKey;
}

/** A Mac's Ctrl-click: its contextmenu opens the clip menu, so no press handler acts on it. */
export function isContextClick(e: { ctrlKey: boolean; button: number }): boolean {
  return isMac() && e.ctrlKey && e.button === 0;
}

/** Text selected on the page (rail text selected with the mouse): ⌘C and ⌘X then copy it. */
export function hasTextSelection(): boolean {
  if (typeof window === "undefined") return false;
  const selection = window.getSelection();
  return selection !== null && !selection.isCollapsed && selection.toString() !== "";
}

/** A lane press prevents the browser's mousedown, which would have cleared a text selection, so it clears it here. */
export function clearTextSelection(): void {
  if (hasTextSelection()) window.getSelection()?.removeAllRanges();
}

/**
 * A click on a clip: with range (⇧) the run from the anchor, else with toggle (⌘) the clip joins or leaves, else
 * the clip alone. Nothing while the clip menu is open: a Mac's Ctrl-click opens it and must keep a group.
 */
export function clickClip(clipId: string, mods: { toggle: boolean; range: boolean }): void {
  const s = editor();
  if (s.menu !== null) return;
  if (mods.range) {
    s.select(rangeTo(orderOf(s), clipSelectionOf(s), clipId));
  } else if (mods.toggle) {
    s.select(toggleClip(orderOf(s), clipSelectionOf(s), clipId));
  } else {
    s.select({ kind: "clip", clipId });
  }
}

/** The clips a press on clipId drags: the selection when it holds clipId and others, else clipId alone. */
export function pressGroup(clipId: string): string[] {
  const ids = selectedClipIds(editor());
  return ids.length > 1 && ids.includes(clipId) ? ids : [clipId];
}

/** After a group drag: the same clips selected, the one pressed leading. */
export function keepGroupSelected(ids: readonly string[], lead: string): void {
  const s = editor();
  s.select(makeSelection(orderOf(s), ids, lead, clipSelectionOf(s)?.anchorId));
}

/** ⌘A: every clip, the lead kept. */
export function selectAllClips(): void {
  const s = editor();
  if (!s.draft) return;
  const selection = selectAll(orderOf(s), clipSelectionOf(s));
  if (selection) s.select(selection);
  clearTextSelection();
}

/**
 * The selection box's release: the clips it touched, added to `base` when additive. The base lead stays when it is
 * still selected, else the first clip touched leads. No clip selected after it → no clip selection, and an audio
 * selection is left alone, as a click on empty lane space leaves it.
 */
export function applyBoxSelection(base: ClipSelection | null, hitIds: readonly string[], additive: boolean): void {
  const s = editor();
  const order = orderOf(s);
  const ids = additive ? [...clipIdsOf(base, order), ...hitIds] : [...hitIds];
  const hits = new Set(hitIds);
  const lead = base && ids.includes(base.clipId) ? base.clipId : order.find((id) => hits.has(id));
  const next = makeSelection(order, ids, lead, base?.anchorId);
  if (next === null) return clearClipSelection();
  s.select(next);
}

/** A click on empty lane space: no clip selected. An audio selection is left alone. */
export function clearClipSelection(): void {
  const s = editor();
  if (s.selection?.kind === "clip") s.select(null);
}
