import { create, type StoreApi, type UseBoundStore } from "zustand";
import { sameCurve } from "@/lib/stitch/curve";
import { sameDraft, type StitchDraft } from "@/lib/stitch/draft";
import type { SourceDurations } from "@/lib/stitch/timeline";

/**
 * The Stitch editor's working state: the draft being edited with its own
 * undo history, and the editor's UI state. Nothing here reaches the workflow
 * store until Done writes the draft in one updateNodeData.
 *
 * History holds whole drafts: `past` the ones before the current draft,
 * `future` the ones Undo stepped back over. A pointer gesture applies once,
 * on pointer up; a slider or a run of arrow keys shares a `gestureKey`, so it
 * coalesces into one step until endGesture.
 */

export type StitchSelection = { kind: "clip"; clipId: string } | { kind: "audio"; point: number | null } | null;

export interface StitchContextMenu {
  clipId: string;
  x: number;
  y: number;
}

export interface StitchEditorState {
  isOpen: boolean;
  nodeId: string | null;
  canvasGeneration: number | null;
  /** As opened; the editor is dirty while the draft differs from it. */
  initial: StitchDraft | null;
  draft: StitchDraft | null;
  past: StitchDraft[];
  future: StitchDraft[];
  /** Coalesces a slider drag or arrow keys into one undo step. */
  gestureKey: string | null;
  selection: StitchSelection;
  /** Pushed by the editor from the media caches; not undoable. */
  durations: SourceDurations;
  /** Sequence seconds. */
  playhead: number;
  playing: boolean;
  /** Kept across opens. */
  snap: boolean;
  /** Preview sound, kept across opens. */
  soundOn: boolean;
  /** null = Fit. */
  pxPerSec: number | null;
  menu: StitchContextMenu | null;
  discardOpen: boolean;
  pickerOpen: boolean;
  /** Set by a drag hook while a pointer gesture runs; Escape calls it. */
  cancelGesture: (() => void) | null;

  open(payload: { nodeId: string; draft: StitchDraft; canvasGeneration: number }): void;
  /** Resets all but snap and soundOn. Asks nothing: the UI confirms first. */
  close(): void;
  apply(recipe: (draft: StitchDraft) => StitchDraft, opts?: { gestureKey?: string }): void;
  endGesture(): void;
  undo(): void;
  redo(): void;
  select(selection: StitchSelection): void;
  setDurations(durations: SourceDurations): void;
  /** Clamped to >= 0. */
  setPlayhead(t: number): void;
  setPlaying(playing: boolean): void;
  setSnap(on: boolean): void;
  setSoundOn(on: boolean): void;
  setZoom(pxPerSec: number | null): void;
  openMenu(menu: StitchContextMenu | null): void;
  setDiscardOpen(open: boolean): void;
  setPickerOpen(open: boolean): void;
  setCancelGesture(cancel: (() => void) | null): void;
}

export const STITCH_HISTORY_LIMIT = 100;

const EMPTY_DURATIONS: SourceDurations = new Map();

type SessionState = Pick<
  StitchEditorState,
  | "isOpen"
  | "nodeId"
  | "canvasGeneration"
  | "initial"
  | "draft"
  | "past"
  | "future"
  | "gestureKey"
  | "selection"
  | "durations"
  | "playhead"
  | "playing"
  | "pxPerSec"
  | "menu"
  | "discardOpen"
  | "pickerOpen"
  | "cancelGesture"
>;

/** Everything one editing session owns; snap and soundOn outlive it. */
const closedSession = (): SessionState => ({
  isOpen: false,
  nodeId: null,
  canvasGeneration: null,
  initial: null,
  draft: null,
  past: [],
  future: [],
  gestureKey: null,
  selection: null,
  durations: EMPTY_DURATIONS,
  playhead: 0,
  playing: false,
  pxPerSec: null,
  menu: null,
  discardOpen: false,
  pickerOpen: false,
  cancelGesture: null,
});

/**
 * After a history move: a clip selection whose clip is gone is dropped, and an
 * audio selection forgets its point, so ⌫ never removes a point by a stale index.
 */
function pruneSelection(selection: StitchSelection, draft: StitchDraft): StitchSelection {
  if (selection?.kind === "clip") {
    return draft.timeline.some((c) => c.id === selection.clipId) ? selection : null;
  }
  if (selection?.kind === "audio" && selection.point !== null) return { kind: "audio", point: null };
  return selection;
}

export const useStitchEditorStore: UseBoundStore<StoreApi<StitchEditorState>> = create<StitchEditorState>(
  (set, get) => ({
    ...closedSession(),
    snap: true,
    soundOn: true,

    open: ({ nodeId, draft, canvasGeneration }) => {
      set({
        ...closedSession(),
        isOpen: true,
        nodeId,
        canvasGeneration,
        initial: draft,
        draft,
        selection: draft.timeline[0] ? { kind: "clip", clipId: draft.timeline[0].id } : null,
      });
    },

    close: () => set(closedSession()),

    apply: (recipe, opts) => {
      const { draft, gestureKey, past, selection } = get();
      if (!draft) return;
      const next = recipe(draft);
      // Most recipes rebuild the draft object, so an unchanged value is told apart by content
      if (next === draft || sameDraft(next, draft)) return;
      // A point index means nothing once the curve has changed under it
      const nextSelection: StitchSelection =
        selection?.kind === "audio" && selection.point !== null && !sameCurve(draft.audioCurve, next.audioCurve)
          ? { kind: "audio", point: null }
          : selection;
      if (opts?.gestureKey !== undefined && opts.gestureKey === gestureKey) {
        set({ draft: next, future: [], selection: nextSelection });
        return;
      }
      set({
        past: [...past, draft].slice(-STITCH_HISTORY_LIMIT),
        draft: next,
        future: [],
        gestureKey: opts?.gestureKey ?? null,
        selection: nextSelection,
      });
    },

    endGesture: () => set({ gestureKey: null }),

    undo: () => {
      const { draft, past, future, selection } = get();
      if (!draft || past.length === 0) return;
      const previous = past[past.length - 1];
      set({
        past: past.slice(0, -1),
        draft: previous,
        future: [draft, ...future],
        gestureKey: null,
        selection: pruneSelection(selection, previous),
      });
    },

    redo: () => {
      const { draft, past, future, selection } = get();
      if (!draft || future.length === 0) return;
      const [next, ...rest] = future;
      set({
        past: [...past, draft].slice(-STITCH_HISTORY_LIMIT),
        draft: next,
        future: rest,
        gestureKey: null,
        selection: pruneSelection(selection, next),
      });
    },

    select: (selection) => set({ selection }),
    setDurations: (durations) => set({ durations }),
    setPlayhead: (t) => set({ playhead: Number.isFinite(t) ? Math.max(0, t) : 0 }),
    setPlaying: (playing) => set({ playing }),
    setSnap: (on) => set({ snap: on }),
    setSoundOn: (on) => set({ soundOn: on }),
    setZoom: (pxPerSec) => set({ pxPerSec }),
    openMenu: (menu) => set({ menu }),
    setDiscardOpen: (open) => set({ discardOpen: open }),
    setPickerOpen: (open) => set({ pickerOpen: open }),
    setCancelGesture: (cancel) => set({ cancelGesture: cancel }),
  }),
);

export const selectIsDirty = (s: StitchEditorState): boolean =>
  s.initial !== null && s.draft !== null && !sameDraft(s.initial, s.draft);
export const selectCanUndo = (s: StitchEditorState): boolean => s.past.length > 0;
export const selectCanRedo = (s: StitchEditorState): boolean => s.future.length > 0;
