import { overlaySelectionOf, useStitchEditorStore } from "@/store/stitchEditorStore";
import type { ClipOrigin } from "@/lib/stitch/draft";
import { draftOverlays, removeOverlays } from "@/lib/stitch/overlays";
import { makeSelection } from "@/lib/stitch/selection";
import type { StitchOverlay } from "@/types";

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
