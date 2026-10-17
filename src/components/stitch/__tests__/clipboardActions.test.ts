import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { useStitchClipboard } from "@/store/stitchClipboardStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { draftSpans, type StitchDraft } from "@/lib/stitch/draft";
import { DEFAULT_SEQUENCE_LAYOUT } from "@/lib/stitch/stack";
import { createClip, type SourceKey } from "@/lib/stitch/timeline";
import type { StitchTimelineClip, WorkflowEdge } from "@/types";
import {
  canPaste,
  copySelection,
  cutSelection,
  duplicateSelection,
  MANY_STACKED_CLIPS,
  pasteClipboard,
} from "../clipboardActions";

const { show } = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock("@/components/Toast", () => ({ useToast: { getState: () => ({ show }) } }));

// Real stores: the editor's, the clipboard and the workflow's tab, id and edges.

const editor = () => useStitchEditorStore.getState();
const clipboard = () => useStitchClipboard.getState().clipboard;
const wf = () => useWorkflowStore.getState();

const edge = (id: string, target: string, targetHandle: string): WorkflowEdge => ({
  id,
  source: `gen-${id}`,
  target,
  sourceHandle: "video",
  targetHandle,
});
const edgeClip = (id: string, edgeId: string, init: Partial<StitchTimelineClip> = {}) =>
  createClip({ kind: "edge", edgeId }, { id, ...init });
const assetClip = (id: string, assetId: string, init: Partial<StitchTimelineClip> = {}) =>
  createClip({ kind: "asset", assetId }, { id, ...init });

const DURATIONS = new Map<SourceKey, number>([
  ["edge:e1", 5],
  ["edge:e2", 5],
  ["edge:e3", 6],
  ["asset:x", 4],
]);
const STACKED = { mode: "stacked", overlapSec: 1, crossfade: true } as const;
const OTHER_NODE = "1 clip not pasted: clips from connected videos paste only into their own node.";

function open(timeline: StitchTimelineClip[], opts: { nodeId?: string; stacked?: boolean; generation?: number } = {}) {
  const draft: StitchDraft = {
    timeline,
    audioCurve: [],
    audioMuted: false,
    loopCount: 1,
    sequenceLayout: opts.stacked ? STACKED : DEFAULT_SEQUENCE_LAYOUT,
  };
  editor().close();
  editor().open({ nodeId: opts.nodeId ?? "n1", draft, canvasGeneration: opts.generation ?? 1 });
  editor().setDurations(DURATIONS);
}

const ids = () => editor().draft!.timeline.map((c) => c.id);
const steps = () => editor().past.length;
const select = (...clipIds: string[]) =>
  editor().select({ kind: "clip", clipId: clipIds[0], ...(clipIds.length > 1 ? { clipIds } : {}) });
const startOf = (clipId: string) => draftSpans(editor().draft!, editor().durations).find((s) => s.clip.id === clipId)!.start;
const track = () => [edgeClip("a", "e1"), edgeClip("b", "e2", { inSec: 1, outSec: 4, muted: true }), assetClip("c", "x")];

beforeEach(() => {
  show.mockClear();
  useStitchClipboard.setState({ clipboard: null });
  useWorkflowStore.setState({
    activeTabId: "t1",
    workflowId: "w1",
    edges: [edge("e1", "n1", "video-0"), edge("e2", "n1", "video-1"), edge("e3", "n1", "video-2")],
  });
  open(track());
});

afterEach(() => {
  editor().close();
  vi.restoreAllMocks();
});

describe("copy and paste", () => {
  it("pastes a copy after the selected clip in Track, as one step, the pasted clip selected", () => {
    select("b");
    expect(copySelection()).toBe(true);
    select("c");
    pasteClipboard();
    expect(steps()).toBe(1);
    expect(ids().slice(0, 3)).toEqual(["a", "b", "c"]);
    const pasted = editor().draft!.timeline[3];
    expect(pasted).toMatchObject({ source: { kind: "edge", edgeId: "e2" }, inSec: 1, outSec: 4, muted: true });
    expect(pasted.startSec).toBeUndefined();
    expect(editor().selection).toEqual({ kind: "clip", clipId: pasted.id });
    expect(editor().clipOrigins.get(pasted.id)).toBe("pasted");
    expect(show).not.toHaveBeenCalled();
  });

  it("pastes at the end with nothing selected, the first pasted clip leading", () => {
    select("a", "b");
    copySelection();
    editor().select(null);
    pasteClipboard();
    const [, , , first, second] = ids();
    expect(ids()).toHaveLength(5);
    expect(editor().selection).toEqual({ kind: "clip", clipId: first, clipIds: [first, second] });
  });

  it("forgets the pasted clips' selection on undo", () => {
    select("a");
    copySelection();
    pasteClipboard();
    editor().undo();
    expect(editor().selection).toBeNull();
    expect(ids()).toEqual(["a", "b", "c"]);
  });

  it("cuts in one step: the clipboard holds the clips, the next clip is selected, the cut ones are tagged", () => {
    select("a", "b");
    cutSelection();
    expect(steps()).toBe(1);
    expect(ids()).toEqual(["c"]);
    expect(clipboard()!.items.map((i) => i.source)).toEqual([
      { kind: "edge", edgeId: "e1" },
      { kind: "edge", edgeId: "e2" },
    ]);
    expect(editor().selection).toEqual({ kind: "clip", clipId: "c" });
    expect(editor().clipOrigins.get("a")).toBe("cut");
    expect(editor().clipOrigins.get("b")).toBe("cut");
  });

  it("pastes after the last of several selected clips", () => {
    open([...track(), assetClip("d", "x")]);
    select("c");
    copySelection();
    select("a", "b");
    pasteClipboard();
    expect(ids()).toEqual(["a", "b", ids()[2], "c", "d"]);
    expect(editor().draft!.timeline[2].source).toEqual({ kind: "asset", assetId: "x" });
  });

  it("moves a connected video's clip with cut then paste, with no notice", () => {
    select("a");
    cutSelection();
    select("c");
    pasteClipboard();
    expect(editor().draft!.timeline.map((c) => c.source)).toEqual([
      { kind: "edge", edgeId: "e2" },
      { kind: "asset", assetId: "x" },
      { kind: "edge", edgeId: "e1" },
    ]);
    expect(steps()).toBe(2);
    expect(show).not.toHaveBeenCalled();
  });

  it("cuts nothing and keeps the clipboard with nothing selected", () => {
    select("a");
    copySelection();
    const copied = clipboard();
    editor().select(null);
    cutSelection();
    expect(steps()).toBe(0);
    expect(clipboard()).toBe(copied);
  });

  it("pastes in Stacked on new rows at the playhead, keeping the offsets and every other start", () => {
    const board = [
      edgeClip("c1", "e1", { startSec: 0 }),
      edgeClip("c2", "e2", { startSec: 6, inSec: 0.8 }),
      edgeClip("c3", "e3", { startSec: 9.2 }),
      assetClip("c4", "x", { startSec: 11, outSec: 3.2 }),
    ];
    open(board, { stacked: true });
    select("c2", "c3");
    copySelection();
    select("c4");
    editor().setPlayhead(12);
    pasteClipboard();
    expect(steps()).toBe(1);
    const [, , , , p1, p2] = ids();
    expect(ids().slice(0, 4)).toEqual(["c1", "c2", "c3", "c4"]);
    expect(startOf(p1)).toBe(12);
    expect(startOf(p2)).toBeCloseTo(15.2, 9);
    expect(["c1", "c2", "c3", "c4"].map(startOf)).toEqual([0, 6, 9.2, 11]);
  });

  it("duplicates after the selection without touching the clipboard", () => {
    select("a");
    copySelection();
    const copied = clipboard();
    select("b");
    duplicateSelection();
    expect(clipboard()).toBe(copied);
    expect(ids()).toHaveLength(4);
    const copy = editor().draft!.timeline[2];
    expect(copy).toMatchObject({ source: { kind: "edge", edgeId: "e2" }, inSec: 1, outSec: 4 });
    expect(editor().clipOrigins.get(copy.id)).toBe("duplicated");
    expect(editor().selection).toEqual({ kind: "clip", clipId: copy.id });
  });

  it("does nothing on ⌘V with nothing copied", () => {
    pasteClipboard();
    expect(steps()).toBe(0);
    expect(canPaste(false, editor())).toBe(false);
    expect(canPaste(true, editor())).toBe(true);
  });
});

describe("where clips may be pasted", () => {
  it("pastes a library clip into another node and leaves a connected video's clip out, with a notice", () => {
    select("a", "c");
    copySelection();
    open([assetClip("z", "x")], { nodeId: "n2" });
    pasteClipboard();
    expect(steps()).toBe(1);
    expect(editor().draft!.timeline.map((c) => c.source)).toEqual([
      { kind: "asset", assetId: "x" },
      { kind: "asset", assetId: "x" },
    ]);
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(OTHER_NODE, "info");
  });

  it("writes nothing when every clip is left out, and says why", () => {
    select("a");
    copySelection();
    open([assetClip("z", "x")], { nodeId: "n2" });
    pasteClipboard();
    expect(steps()).toBe(0);
    expect(show).toHaveBeenCalledWith(OTHER_NODE, "info");
  });

  it("leaves out a clip whose video is no longer connected to its own node", () => {
    select("a");
    copySelection();
    useWorkflowStore.setState({ edges: wf().edges.filter((e) => e.id !== "e1") });
    pasteClipboard();
    expect(steps()).toBe(0);
    expect(show).toHaveBeenCalledWith("1 clip not pasted: its video is no longer connected.", "info");
  });

  it("still pastes into its own node after the tab was switched away and back", () => {
    select("a");
    copySelection();
    open(track(), { generation: 7 });
    pasteClipboard();
    expect(steps()).toBe(1);
    expect(show).not.toHaveBeenCalled();
  });

  it("treats the same node id in another tab or another workflow as another node", () => {
    select("a");
    copySelection();
    useWorkflowStore.setState({ activeTabId: "t2" });
    pasteClipboard();
    useWorkflowStore.setState({ activeTabId: "t1", workflowId: "w2" });
    pasteClipboard();
    expect(steps()).toBe(0);
    expect(show).toHaveBeenCalledTimes(2);
    expect(show).toHaveBeenLastCalledWith(OTHER_NODE, "info");
  });

  it("gives an unsaved workflow its id on copy, and asks for none with nothing selected", () => {
    useWorkflowStore.setState({ workflowId: null });
    const ensure = vi.spyOn(wf(), "ensureWorkflowId");
    editor().select(null);
    expect(copySelection()).toBe(false);
    expect(ensure).not.toHaveBeenCalled();
    expect(wf().workflowId).toBeNull();
    select("a");
    expect(copySelection()).toBe(true);
    const id = wf().workflowId;
    expect(typeof id).toBe("string");
    expect(clipboard()!.origin).toEqual({ kind: "node", nodeId: "n1", tabId: "t1", workflowId: id });
    pasteClipboard();
    expect(steps()).toBe(1);
  });
});

describe("many clips in Stacked", () => {
  const thirteen = () => Array.from({ length: 13 }, (_, i) => assetClip(`k${i}`, "x"));
  const MANY = (n: number) => `${n} clips: in Stacked each clip loads its own video, so the preview may slow down.`;

  it("says so once, when a duplicate takes the count past the limit", () => {
    expect(MANY_STACKED_CLIPS).toBe(24);
    open(thirteen(), { stacked: true });
    select(...ids());
    duplicateSelection();
    expect(ids()).toHaveLength(26);
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(MANY(26), "info");
    select(...ids());
    duplicateSelection();
    expect(ids()).toHaveLength(52);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("counts from 24: 12 → 24 is silent, 24 → 25 says so, 25 → 26 is silent", () => {
    open(Array.from({ length: 12 }, (_, i) => assetClip(`k${i}`, "x")), { stacked: true });
    select(...ids());
    duplicateSelection();
    expect(ids()).toHaveLength(24);
    expect(show).not.toHaveBeenCalled();
    select(ids()[0]);
    copySelection();
    pasteClipboard();
    expect(ids()).toHaveLength(25);
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(MANY(25), "info");
    duplicateSelection();
    expect(ids()).toHaveLength(26);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("says nothing in Track", () => {
    open(thirteen());
    select(...ids());
    duplicateSelection();
    expect(ids()).toHaveLength(26);
    expect(show).not.toHaveBeenCalled();
  });

  it("puts the skipped clips first in one notice", () => {
    open([...thirteen(), edgeClip("e", "e1")], { stacked: true });
    select(...ids());
    copySelection();
    open(Array.from({ length: 12 }, (_, i) => assetClip(`m${i}`, "x")), { nodeId: "n2", stacked: true });
    pasteClipboard();
    expect(ids()).toHaveLength(25);
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(`${OTHER_NODE} ${MANY(25)}`, "info");
  });
});
