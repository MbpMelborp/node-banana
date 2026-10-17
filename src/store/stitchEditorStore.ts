import { create, type StoreApi, type UseBoundStore } from "zustand";
import { sameCurve } from "@/lib/stitch/curve";
import { sameDraft, type ClipOrigin, type StitchDraft } from "@/lib/stitch/draft";
import { clipIdsOf, makeSelection, type ClipSelection } from "@/lib/stitch/selection";
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

export type StitchSelection = ClipSelection | { kind: "audio"; point: number | null } | null;

export interface StitchContextMenu {
  clipId: string;
  x: number;
  y: number;
}

export interface StitchEditorState {
  isOpen: boolean;
  nodeId: string | null;
  canvasGeneration: number | null;
  /** As opened or last saved; the editor is dirty while the draft differs from it. */
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
  /**
   * The clips a paste or duplicate made and the ones a cut took, by id, for the discard sheet. Outside the history:
   * an undo or redo brings back the same ids, so their tags stay true.
   */
  clipOrigins: ReadonlyMap<string, ClipOrigin>;

  open(payload: { nodeId: string; draft: StitchDraft; canvasGeneration: number }): void;
  /** Resets all but snap and soundOn. Asks nothing: the UI confirms first. */
  close(): void;
  /** Save wrote this to the node: Cancel and the discard sheet count from it now. The undo history stays. */
  markSaved(saved: StitchDraft): void;
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
  /** A clip keeps the first tag it gets: a pasted clip cut and brought back by undo is still a pasted clip. */
  tagClips(ids: readonly string[], origin: ClipOrigin): void;
  /** A clip removed without ⌘X loses its "cut" tag: the tag names how a clip last left, and it left another way. */
  untagCut(ids: readonly string[]): void;
}

export const STITCH_HISTORY_LIMIT = 100;

const EMPTY_DURATIONS: SourceDurations = new Map();
const NO_ORIGINS: ReadonlyMap<string, ClipOrigin> = new Map();

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
  | "clipOrigins"
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
  clipOrigins: NO_ORIGINS,
});

/**
 * After a history move: a clip selection drops the clips that are gone (the
 * first that remains leads when the lead went; none left, none selected), and
 * an audio selection forgets its point, so ⌫ never removes a point by a stale
 * index.
 */
function pruneSelection(selection: StitchSelection, draft: StitchDraft): StitchSelection {
  if (selection?.kind === "clip") {
    const order = draft.timeline.map((c) => c.id);
    const next = makeSelection(order, clipIdsOf(selection, order), selection.clipId, selection.anchorId);
    const same =
      next !== null &&
      next.clipId === selection.clipId &&
      next.anchorId === selection.anchorId &&
      (next.clipIds ?? []).join("\n") === (selection.clipIds ?? []).join("\n");
    return same ? selection : next;
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

    markSaved: (saved) => set({ initial: saved }),

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
    tagClips: (ids, origin) => {
      const current = get().clipOrigins;
      const fresh = ids.filter((id) => !current.has(id));
      if (fresh.length === 0) return;
      const next = new Map(current);
      for (const id of fresh) next.set(id, origin);
      set({ clipOrigins: next });
    },
    untagCut: (ids) => {
      const current = get().clipOrigins;
      const cut = ids.filter((id) => current.get(id) === "cut");
      if (cut.length === 0) return;
      const next = new Map(current);
      for (const id of cut) next.delete(id);
      set({ clipOrigins: next });
    },
  }),
);

export const selectIsDirty = (s: StitchEditorState): boolean =>
  s.initial !== null && s.draft !== null && !sameDraft(s.initial, s.draft);
export const selectCanUndo = (s: StitchEditorState): boolean => s.past.length > 0;
export const selectCanRedo = (s: StitchEditorState): boolean => s.future.length > 0;

/**
 * The selected clips' ids in timeline order ([] for an audio selection or none). A new array per call: components
 * subscribe to s.selection and derive this in a useMemo, never through a selector.
 */
export function selectedClipIds(s: Pick<StitchEditorState, "selection" | "draft">): string[] {
  if (s.selection?.kind !== "clip" || !s.draft) return [];
  return clipIdsOf(s.selection, s.draft.timeline.map((c) => c.id));
}

/** Several clips selected: group actions act on all of them, single-clip ones (trims, Start, In, Out) do nothing. */
export const selectIsMulti = (s: StitchEditorState): boolean => selectedClipIds(s).length > 1;
