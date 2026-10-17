import type { StitchClipSource, StitchSequenceLayout, StitchTimelineClip } from "@/types";
import type { StitchDraft } from "./draft";
import {
  createClip,
  layoutSpans,
  MAX_START_SEC,
  newClipId,
  pinStarts,
  runEndIndex,
  type ClipSpan,
  type SourceDurations,
} from "./timeline";

/**
 * The editor's clipboard: copied clips as plain values (sources are ids, so
 * no media), where they were copied, and where they may be pasted. Pure.
 */

/** One copied video clip. */
export interface ClipboardVideoItem {
  track: "video";
  source: StitchClipSource;
  inSec: number;
  outSec: number | null;
  muted: boolean;
  volume: number;
  /** Its span's start less the earliest copied start, seconds, in the layout it was copied from (>= 0). */
  offsetSec: number;
}

/** Every kind of copied clip. One copy holds one kind. */
export type ClipboardItem = ClipboardVideoItem;

/**
 * Where the clips were copied. tabId: the workflow store's activeTabId; workflowId: ensureWorkflowId() at the copy.
 * Together they tell this node from one with the same id in another workflow or tab, and survive a tab switch.
 */
export type ClipboardOrigin = { kind: "node"; nodeId: string; tabId: string; workflowId: string };

export interface StitchClipboard {
  origin: ClipboardOrigin;
  /** In timeline (row) order. Never empty. */
  items: readonly ClipboardItem[];
}

/** Where a paste lands. workflowId as the store holds it (null for a workflow never given one). */
export type PasteTarget = {
  kind: "node";
  nodeId: string;
  tabId: string;
  workflowId: string | null;
  liveEdgeIds: readonly string[];
};

export type SkipReason = "otherNode" | "disconnected";

const SKIP_ORDER: readonly SkipReason[] = ["otherNode", "disconnected"];

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/** The listed clips (timeline order) as clipboard items, with their offsets from layoutSpans(draft). [] when none is listed. */
export function copyItems(
  draft: Pick<StitchDraft, "timeline" | "sequenceLayout">,
  durations: SourceDurations,
  ids: readonly string[],
): ClipboardVideoItem[] {
  const wanted = new Set(ids);
  const spans = layoutSpans(draft.timeline, durations, draft.sequenceLayout).filter((span) => wanted.has(span.clip.id));
  if (spans.length === 0) return [];
  const earliest = Math.min(...spans.map((span) => span.start));
  return spans.map(({ clip, start }) => ({
    track: "video",
    source: { ...clip.source },
    inSec: clip.inSec,
    outSec: clip.outSec,
    muted: clip.muted,
    volume: clip.volume,
    offsetSec: start - earliest,
  }));
}

/** The listed clips (timeline order) with their offsets from layoutSpans(draft). null when none is listed. */
export function copyClips(
  draft: Pick<StitchDraft, "timeline" | "sequenceLayout">,
  durations: SourceDurations,
  ids: readonly string[],
  origin: ClipboardOrigin,
): StitchClipboard | null {
  const items = copyItems(draft, durations, ids);
  return items.length > 0 ? { origin, items } : null;
}

/** Whether an item may be pasted into the target, or why not. */
function skipReason(item: ClipboardItem, origin: ClipboardOrigin, target: PasteTarget): SkipReason | null {
  const track = item.track;
  switch (track) {
    case "video": {
      if (item.source.kind === "asset") return null;
      const edgeId = item.source.edgeId;
      const kind = target.kind;
      switch (kind) {
        case "node": {
          const own =
            origin.nodeId === target.nodeId && origin.tabId === target.tabId && origin.workflowId === target.workflowId;
          if (!own) return "otherNode";
          return target.liveEdgeIds.includes(edgeId) ? null : "disconnected";
        }
        default: {
          const unknown: never = kind;
          return unknown;
        }
      }
    }
    default: {
      const unknown: never = track;
      return unknown;
    }
  }
}

/**
 * Asset items always pass. An edge item passes only into its own node (the same node, tab and workflow) while its
 * edge is still connected there: "disconnected" when it is not, "otherNode" anywhere else. Skipped counts come in
 * the order otherNode, disconnected, leaving out a reason with no clip.
 */
export function pastableItems(
  clipboard: StitchClipboard,
  target: PasteTarget,
): { items: ClipboardItem[]; skipped: Array<{ reason: SkipReason; count: number }> } {
  const items: ClipboardItem[] = [];
  const counts = new Map<SkipReason, number>();
  for (const item of clipboard.items) {
    const reason = skipReason(item, clipboard.origin, target);
    if (reason === null) items.push(item);
    else counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  const skipped = SKIP_ORDER.flatMap((reason) => {
    const count = counts.get(reason) ?? 0;
    return count > 0 ? [{ reason, count }] : [];
  });
  return { items, skipped };
}

function skippedSentence(reason: SkipReason, count: number): string {
  const clips = count === 1 ? "1 clip" : `${count} clips`;
  switch (reason) {
    case "otherNode":
      return `${clips} not pasted: clips from connected videos paste only into their own node.`;
    case "disconnected":
      return count === 1
        ? `${clips} not pasted: its video is no longer connected.`
        : `${clips} not pasted: their videos are no longer connected.`;
    default: {
      const unknown: never = reason;
      return unknown;
    }
  }
}

/** The notice for skipped clips, or null when nothing was skipped. */
export function skippedMessage(skipped: ReadonlyArray<{ reason: SkipReason; count: number }>): string | null {
  const sentences = skipped.filter((s) => s.count > 0).map((s) => skippedSentence(s.reason, s.count));
  return sentences.length > 0 ? sentences.join(" ") : null;
}

/**
 * New clips from items (makeId each; source, In, Out, muted, volume copied), inserted at index afterIndex + 1
 * (−1 = the top or the start; afterIndex >= length − 1 or non-finite = the end).
 * Track: no startSec, the timeline unpinned, afterIndex used as given.
 * Stacked: pinStarts first; then afterIndex moves to the end of the run that row belongs to (runEndIndex), so new
 * rows never land between the pieces of a split; then each new clip starts at clamp(startSec + offsetSec, 0, 10:00).
 * Returns the new ids in order. No items → the same timeline and [].
 */
export function pasteIntoTimeline(
  timeline: StitchTimelineClip[],
  durations: SourceDurations,
  layout: StitchSequenceLayout,
  items: readonly ClipboardVideoItem[],
  at: { afterIndex: number; startSec: number },
  makeId: () => string = newClipId,
): { timeline: StitchTimelineClip[]; ids: string[] } {
  if (items.length === 0) return { timeline, ids: [] };
  const stacked = layout.mode === "stacked";
  const base = stacked ? pinStarts(timeline, durations, layout.overlapSec) : timeline;
  let after = Number.isFinite(at.afterIndex) ? clamp(Math.trunc(at.afterIndex), -1, base.length - 1) : base.length - 1;
  if (stacked && after >= 0) after = runEndIndex(layoutSpans(base, durations, layout), after);
  const clips = items.map((item) =>
    createClip(
      { ...item.source },
      {
        id: makeId(),
        inSec: item.inSec,
        outSec: item.outSec,
        muted: item.muted,
        volume: item.volume,
        ...(stacked ? { startSec: clamp(at.startSec + item.offsetSec, 0, MAX_START_SEC) } : {}),
      },
    ),
  );
  return {
    timeline: [...base.slice(0, after + 1), ...clips, ...base.slice(after + 1)],
    ids: clips.map((clip) => clip.id),
  };
}

/** Where a duplicate goes: afterIndex = the last selected index; startSec = the latest end among the selected spans. */
export function duplicateAt(spans: readonly ClipSpan[], ids: ReadonlySet<string>): { afterIndex: number; startSec: number } {
  const selected = spans.filter((span) => ids.has(span.clip.id));
  if (selected.length === 0) return { afterIndex: spans.length - 1, startSec: 0 };
  return {
    afterIndex: Math.max(...selected.map((span) => span.index)),
    startSec: Math.max(...selected.map((span) => span.end)),
  };
}
