import { useToast } from "@/components/Toast";
import { selectedClipIds, useStitchEditorStore, type StitchEditorState } from "@/store/stitchEditorStore";
import { useStitchClipboard } from "@/store/stitchClipboardStore";
import { useWorkflowStore } from "@/store/workflowStore";
import {
  copyClips,
  copyItems,
  duplicateAt,
  pastableItems,
  pasteIntoTimeline,
  skippedMessage,
  type ClipboardItem,
  type ClipboardVideoItem,
  type PasteTarget,
} from "@/lib/stitch/clipboard";
import { draftSpans, type ClipOrigin } from "@/lib/stitch/draft";
import { makeSelection } from "@/lib/stitch/selection";
import { stitchVideoEdgeIds } from "@/lib/stitch/migrate";
import { drawnPlayhead, keepZoom, removeClipsById } from "./editorActions";

/**
 * ⌘C, ⌘X, ⌘V and ⌘D in the editor, and the clip menu's Copy, Cut, Paste and
 * Duplicate. Each reads the stores at call time, as editorActions does; each
 * edit is one undo step.
 */

/** Past this many clips in Stacked, a paste or duplicate says the preview may slow down (one <video> per clip). */
export const MANY_STACKED_CLIPS = 24;

const editor = () => useStitchEditorStore.getState();

/** The node the editor edits, as a paste target. The editor is always on the active tab: it closes on a switch. */
export function pasteTarget(s: Pick<StitchEditorState, "nodeId">): PasteTarget | null {
  if (!s.nodeId) return null;
  const wf = useWorkflowStore.getState();
  return {
    kind: "node",
    nodeId: s.nodeId,
    tabId: wf.activeTabId,
    workflowId: wf.workflowId,
    liveEdgeIds: stitchVideoEdgeIds(s.nodeId, wf.edges),
  };
}

/** Paste is offered whenever something was copied and a draft is open; what cannot be pasted is said by the notice. */
export function canPaste(hasClipboard: boolean, s: Pick<StitchEditorState, "draft">): boolean {
  return hasClipboard && s.draft !== null;
}

/**
 * ⌘C: the selected clips to the clipboard. An unsaved workflow is given its id first, so a clip from a connected
 * video still knows its own node after a tab switch. False when nothing is selected (the clipboard is kept).
 */
export function copySelection(): boolean {
  const s = editor();
  const ids = selectedClipIds(s);
  if (!s.draft || !s.nodeId || ids.length === 0) return false;
  const wf = useWorkflowStore.getState();
  const clipboard = copyClips(s.draft, s.durations, ids, {
    kind: "node",
    nodeId: s.nodeId,
    tabId: wf.activeTabId,
    workflowId: wf.ensureWorkflowId(),
  });
  if (!clipboard) return false;
  useStitchClipboard.getState().setClipboard(clipboard);
  return true;
}

/** ⌘X: copy, then remove the selected clips in one step; the clip now at the first removed index is selected. */
export function cutSelection(): void {
  const ids = selectedClipIds(editor());
  if (!copySelection()) return;
  const removed = removeClipsById(ids);
  editor().tagClips(removed, "cut");
}

function videoItems(items: readonly ClipboardItem[]): ClipboardVideoItem[] {
  return items.filter((item): item is ClipboardVideoItem => item.track === "video");
}

/** The notice that Stacked now has many clips, when this edit took it past MANY_STACKED_CLIPS. */
function manyClipsNotice(before: number, after: number, stacked: boolean): string | null {
  if (!stacked || before > MANY_STACKED_CLIPS || after <= MANY_STACKED_CLIPS) return null;
  return `${after} clips: in Stacked each clip loads its own video, so the preview may slow down.`;
}

/**
 * Inserts copies in one step (pasteIntoTimeline), tags them, and selects them, the first leading. One notice holds
 * `skipped` and, in Stacked, the many-clips sentence.
 */
function insertCopies(
  items: readonly ClipboardVideoItem[],
  at: { afterIndex: number; startSec: number },
  origin: Extract<ClipOrigin, "pasted" | "duplicated">,
  skipped: string | null,
): void {
  const s = editor();
  const draft = s.draft;
  if (!draft) return;
  const { timeline, ids } = pasteIntoTimeline(draft.timeline, s.durations, draft.sequenceLayout, items, at);
  if (ids.length > 0) {
    keepZoom(s, timeline);
    s.apply((d) => ({ ...d, timeline }));
    const after = editor();
    after.tagClips(ids, origin);
    after.select(makeSelection(timeline.map((c) => c.id), ids, ids[0]));
  }
  const stacked = draft.sequenceLayout.mode === "stacked";
  const notice = [skipped, manyClipsNotice(draft.timeline.length, timeline.length, stacked)].filter(
    (part): part is string => part !== null,
  );
  if (notice.length > 0) useToast.getState().show(notice.join(" "), "info");
}

/** The index pasted clips go after: the last selected clip, else the last clip. */
function lastSelectedIndex(s: StitchEditorState): number {
  const timeline = s.draft?.timeline ?? [];
  const ids = new Set(selectedClipIds(s));
  let last = -1;
  timeline.forEach((c, i) => {
    if (ids.has(c.id)) last = i;
  });
  return last === -1 ? timeline.length - 1 : last;
}

/**
 * ⌘V: in Track after the last selected clip (or at the end); in Stacked on new rows below it (or at the bottom), the
 * first at the playhead and the others at their copied offsets. Clips that may not be pasted here are left out and
 * a notice says why; with none left, nothing is written.
 */
export function pasteClipboard(): void {
  const s = editor();
  const clipboard = useStitchClipboard.getState().clipboard;
  const target = pasteTarget(s);
  if (!clipboard || !s.draft || !target) return;
  const { items, skipped } = pastableItems(clipboard, target);
  const at = { afterIndex: lastSelectedIndex(s), startSec: drawnPlayhead(s) };
  insertCopies(videoItems(items), at, "pasted", skippedMessage(skipped));
}

/** ⌘D: copies of the selected clips right after them (Stacked: starting where the selection ends). The clipboard is kept. */
export function duplicateSelection(): void {
  const s = editor();
  const ids = selectedClipIds(s);
  if (!s.draft || ids.length === 0) return;
  const items = copyItems(s.draft, s.durations, ids);
  insertCopies(items, duplicateAt(draftSpans(s.draft, s.durations), new Set(ids)), "duplicated", null);
}
