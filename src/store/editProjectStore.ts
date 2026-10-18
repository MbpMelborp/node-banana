import { create } from "zustand";
import { useToast } from "@/components/Toast";
import { upsertWorkflowEntry } from "@/lib/assets/client/api";
import * as editsApi from "@/lib/edits/client";
import { EditApiError } from "@/lib/edits/client";
import {
  draftFromEditSequence,
  editAssetIds,
  editSequenceFromDraft,
  normalizeEditName,
  snapshotEditAssets,
  summarizeEdit,
} from "@/lib/edits/document";
import type {
  EditAssetSnapshot,
  EditDocument,
  EditListProblem,
  EditRender,
  EditSummary,
  SaveEditRequest,
} from "@/lib/edits/types";
import { getAssetInfo, requestAssetInfo } from "@/lib/stitch/assetInfo";
import { sameDraft, type StitchDraft } from "@/lib/stitch/draft";
import { provisionalDurations } from "@/lib/stitch/libraryInsert";
import type { SourceKey } from "@/lib/stitch/timeline";
import { useAssetStore } from "./assetStore";
import { requestSave } from "./saveRequestStore";
import { parkedSessionOf, useStitchEditorStore, type StitchParkedSession } from "./stitchEditorStore";
import { useWorkflowStore } from "./workflowStore";

/**
 * The Edit video view: the list of edit projects, the one open, how its
 * saving stands, and the session it keeps while the view is left (parked).
 * The open edit's sequence lives in the editor store like a node's draft;
 * this store holds what belongs to the file.
 *
 * Every write to an edit goes through one queue, one after another, so two
 * saves never race on one `updatedAt` (the second would read as a conflict)
 * and an answer is applied only to the edit it was sent for. Every open
 * takes a token first and opens only if it is still the latest and the view
 * still shows, so a late answer never opens an edit session behind the canvas.
 */

/**
 * waiting: the library is paused by a move; saving tries again after retryAt.
 * gone: a save found no file for the edit; the banner offers "Save as a new edit".
 */
export type EditSaveState = "saved" | "saving" | "failed" | "conflict" | "waiting" | "gone";
/** What one save attempt ended as. "unchanged": nothing to save. */
export type EditSaveOutcome = "saved" | "unchanged" | "failed" | "conflict" | "waiting" | "gone";
export type EditPaneKind = "all" | "video" | "audio";
export type EditSwitch = { action: "new" } | { action: "home" } | { action: "open"; id: string } | { action: "duplicate"; id: string };

export interface OpenEditMeta {
  id: string;
  name: string;
  createdAt: number;
  /** The updatedAt the next save is based on. */
  baseUpdatedAt: number;
  assets: Record<string, EditAssetSnapshot>;
  renders: EditRender[];
}

export interface EditProjectState {
  list: {
    status: "idle" | "loading" | "ready" | "error";
    edits: EditSummary[];
    problems: EditListProblem[];
    folder: string | null;
    error: string | null;
  };
  open: OpenEditMeta | null;
  /** The id being read. */
  opening: string | null;
  /** A new edit or a copy is being created (New edit reads "Creating…"). */
  creating: boolean;
  openError: { id: string; message: string; code: string | null } | null;
  save: { state: EditSaveState; error: string | null; conflict: EditDocument | null; retryAt: number | null };
  /** The open edit's session while the view is not shown. */
  parked: StitchParkedSession | null;
  render: { state: "idle" | "rendering" | "failed"; editId: string | null; progress: number; message: string | null };
  pane: { open: boolean; kind: EditPaneKind; focusRequest: number };
  /** The source keys whose media is still loading; a Stacked add that pins waits for them. */
  clipsLoading: ReadonlySet<SourceKey>;
  /** The unsaved-changes sheet's question: what to do once it is answered. */
  pendingSwitch: EditSwitch | null;
  /** The edit the delete confirmation asks about. */
  confirmDelete: string | null;
  /** The name field's note ("Another edit has that name"). */
  renameError: string | null;

  refreshList(): Promise<void>;
  /** Restores the parked session, else opens the last edit, else shows the home screen. */
  enterView(): Promise<void>;
  /** Parks the session and, with Save automatically on and changes, saves it. */
  leaveView(): void;
  newEdit(): Promise<void>;
  openEditById(id: string): Promise<void>;
  goHome(): Promise<void>;
  /** Copies the edit (the open one when no id is given) and opens the copy. */
  duplicate(id?: string): Promise<void>;
  /** false with renameError set when the name is taken. */
  rename(name: string, id?: string): Promise<boolean>;
  requestDelete(id?: string): void;
  confirmDeleteEdit(): Promise<void>;
  cancelDelete(): void;
  reveal(id?: string): Promise<void>;
  revealFolder(): Promise<void>;
  /** "Make it a separate edit" for a file listed as a copy. */
  separateDuplicate(fileName: string): Promise<void>;
  saveNow(reason: "auto" | "manual"): Promise<EditSaveOutcome>;
  /** From "gone": writes the session as a new edit, which the session then edits, history kept. */
  saveAsNew(): Promise<void>;
  resolveConflict(choice: "keepMine" | "useTheirs"): Promise<void>;
  resolveSwitch(choice: "save" | "discard" | "cancel"): Promise<void>;
  /** A render finished: kept in the edit's file (through the queue), never changing its updatedAt. */
  addRender(editId: string, render: EditRender): Promise<void>;
  startRender(): void;
  stopRender(): void;
  setRenderState(render: Partial<EditProjectState["render"]>): void;
  setPaneOpen(open: boolean): void;
  setPaneKind(kind: EditPaneKind): void;
  /** "+" in the view: the pane opens, takes the kind and focuses its search. */
  requestPaneFocus(kind?: "video" | "audio"): void;
  setClipsLoading(keys: ReadonlySet<SourceKey>): void;
}

export const LAST_EDIT_KEY = "node-banana-edit-last";
/** "open" | "closed"; absent = open. */
export const LIBRARY_PANE_KEY = "node-banana-edit-library-pane";
export const EDIT_UNSAVED_WARNING = "An edit in the Edit video view has changes that are not saved.";
/** A paused library is asked again no sooner than this. */
export const EDIT_PAUSED_MIN_WAIT_MS = 3_000;

const SAVED: EditProjectState["save"] = { state: "saved", error: null, conflict: null, retryAt: null };
const NO_LOADING: ReadonlySet<SourceKey> = new Set();

function readStorage(key: string): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private windows and blocked storage: the view still works, it just does not remember
  }
}

const readLast = () => readStorage(LAST_EDIT_KEY);
const writeLast = (id: string | null) => writeStorage(LAST_EDIT_KEY, id);

/* The write queue and the open token: module state, not store state (nothing renders from them). */

let writes: Promise<unknown> = Promise.resolve();
/** The save running or queued now, and at most one save chained after it. */
let inflight: Promise<EditSaveOutcome> | null = null;
let again: Promise<EditSaveOutcome> | null = null;
let openSeq = 0;
let listSeq = 0;

/** Every write to an edit runs here, one after another, in call order. */
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = writes.then(fn, fn);
  writes = run.catch(() => undefined);
  return run;
}

/** Resolves once every queued write has settled, including any queued meanwhile. */
export async function editWritesIdle(): Promise<void> {
  let seen: Promise<unknown>;
  do {
    seen = writes;
    await seen;
  } while (seen !== writes);
}

/** A save is running or queued (the autosave waits for it). */
export const editSaveInFlight = (): boolean => inflight !== null;

const get = () => useEditProjectStore.getState();
const set = (patch: Partial<EditProjectState>) => useEditProjectStore.setState(patch);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function metaOf(document: EditDocument): OpenEditMeta {
  return {
    id: document.id,
    name: document.name,
    createdAt: document.createdAt,
    baseUpdatedAt: document.updatedAt,
    assets: document.assets,
    renders: document.renders,
  };
}

/** The session the open edit lives in now: the editor store's when it holds this edit, else the parked one. */
export function currentEditSession(): StitchParkedSession | null {
  const { open, parked } = get();
  if (!open) return null;
  const editor = useStitchEditorStore.getState();
  if (editor.isOpen && editor.editId === open.id) return parkedSessionOf(editor);
  return parked?.editId === open.id ? parked : null;
}

export function sessionIsDirty(session: Pick<StitchParkedSession, "initial" | "draft"> | null): boolean {
  return Boolean(session?.initial && session.draft && !sameDraft(session.initial, session.draft));
}

/** Changes not on disk: the draft differs from the saved one, or a save is under way, waiting, failed, refused or gone. */
export function editHasUnsavedWork(): boolean {
  if (sessionIsDirty(currentEditSession())) return true;
  return get().open !== null && get().save.state !== "saved";
}

/** The desktop app's File › Save: the edit while the Edit video view shows, else the workflow, as before. */
export function handleDesktopSave(): void {
  if (useAssetStore.getState().appView === "edit") void get().saveNow("manual");
  else requestSave("desktop");
}

/** The saved draft is now `sent`, wherever the session lives. */
function markSent(editId: string, sent: StitchDraft): void {
  const editor = useStitchEditorStore.getState();
  if (editor.isOpen && editor.editId === editId) {
    editor.markSaved(sent);
    return;
  }
  const parked = get().parked;
  if (parked?.editId === editId) set({ parked: { ...parked, initial: sent } });
}

/** What a save sends for this session: the sequence, the asset snapshot and the summary the list shows. */
function saveBody(open: OpenEditMeta, draft: StitchDraft, session: StitchParkedSession) {
  const sequence = editSequenceFromDraft(draft);
  return {
    sequence,
    assets: snapshotEditAssets(editAssetIds(sequence), getAssetInfo, open.assets),
    summary: summarizeEdit(draft, provisionalDurations(draft, session.durations, getAssetInfo, open.assets)),
  };
}

function saveOutcomeOf(error: unknown): { outcome: EditSaveOutcome; save: EditProjectState["save"] } {
  if (error instanceof EditApiError) {
    if (error.status === 409 && error.code === "conflict" && error.current) {
      return { outcome: "conflict", save: { state: "conflict", error: null, conflict: error.current, retryAt: null } };
    }
    if (error.status === 503 && error.code === "paused") {
      const wait = Math.max(error.retryAfterMs ?? 0, EDIT_PAUSED_MIN_WAIT_MS);
      return { outcome: "waiting", save: { state: "waiting", error: null, conflict: null, retryAt: Date.now() + wait } };
    }
    if (error.status === 404) return { outcome: "gone", save: { state: "gone", error: null, conflict: null, retryAt: null } };
  }
  return { outcome: "failed", save: { state: "failed", error: errorMessage(error), conflict: null, retryAt: null } };
}

async function saveOnce(force: boolean): Promise<EditSaveOutcome> {
  const { open, save } = get();
  const session = currentEditSession();
  if (!open || !session?.draft) return "unchanged";
  if (!force && save.state === "saved" && !sessionIsDirty(session)) return "unchanged";
  const sentId = open.id;
  const sent = session.draft;
  set({ save: { ...save, state: "saving", error: null, retryAt: null } });
  try {
    const request: SaveEditRequest = {
      baseUpdatedAt: open.baseUpdatedAt,
      ...(force ? { force: true } : {}),
      ...saveBody(open, sent, session),
      renders: open.renders,
    };
    const document = await editsApi.saveEdit(sentId, request);
    const now = get().open;
    if (now?.id !== sentId) return "saved";
    set({
      open: { ...now, name: document.name, baseUpdatedAt: document.updatedAt, assets: document.assets, renders: document.renders },
      save: SAVED,
    });
    markSent(sentId, sent);
    return "saved";
  } catch (error) {
    const { outcome, save: next } = saveOutcomeOf(error);
    if (get().open?.id === sentId) set({ save: next });
    return outcome;
  }
}

function startSave(force: boolean): Promise<EditSaveOutcome> {
  const run = enqueue(() => saveOnce(force));
  inflight = run;
  void run.finally(() => {
    if (inflight === run) inflight = null;
  });
  return run;
}

/** The one save path: a save asked for while one runs is sent once it has answered, and only one is chained. */
function saveNow(reason: "auto" | "manual"): Promise<EditSaveOutcome> {
  // An automatic save never sends a refused edit again; the banner's choices do
  const state = get().save.state;
  if (reason === "auto" && (state === "conflict" || state === "gone")) return Promise.resolve(state);
  if (again) return again;
  if (inflight) {
    const next = () => {
      again = null;
      return saveNow(reason);
    };
    again = inflight.then(next, next);
    return again;
  }
  return startSave(false);
}

/**
 * Opens `document` into the editor, only when `token` is still the latest open and the view still shows (D14). A
 * created edit dropped here still exists and is in the list.
 */
function applyOpen(token: number, document: EditDocument): boolean {
  if (token !== openSeq || useAssetStore.getState().appView !== "edit") return false;
  const editor = useStitchEditorStore.getState();
  if (editor.isOpen && editor.nodeId !== null) return false;
  set({ open: metaOf(document), opening: null, openError: null, save: SAVED, parked: null, pendingSwitch: null, renameError: null });
  editor.openEdit({ editId: document.id, draft: draftFromEditSequence(document.sequence) });
  writeLast(document.id);
  requestAssetInfo(editAssetIds(document.sequence));
  return true;
}

/** Leaves the open edit without saving (the switch has saved or the user said not to). */
function closeCurrent(): void {
  const editor = useStitchEditorStore.getState();
  if (editor.isOpen && editor.editId !== null) editor.close();
  set({ open: null, parked: null, save: SAVED, renameError: null });
}

async function readAndOpen(id: string, opts: { quiet?: boolean } = {}): Promise<void> {
  const token = ++openSeq;
  set({ opening: id, openError: null });
  try {
    const document = await editsApi.fetchEdit(id);
    applyOpen(token, document);
  } catch (error) {
    if (token !== openSeq) return;
    set({ opening: null });
    if (error instanceof EditApiError && error.status === 404) {
      if (readLast() === id) writeLast(null);
      if (!opts.quiet) useToast.getState().show("That edit is gone", "warning");
      void get().refreshList();
      return;
    }
    const message = errorMessage(error);
    set({ openError: { id, message, code: error instanceof EditApiError ? (error.code ?? null) : null } });
    useToast.getState().show("Couldn't open the edit", "error", false, message, [
      { label: "Try again", onClick: () => void get().openEditById(id) },
    ]);
    // An unreadable or newer file is then listed with its problem
    void get().refreshList();
  }
}

/** Creates an edit (new, or a copy of `from`) and opens it. */
async function createAndOpen(from?: string): Promise<void> {
  const token = ++openSeq;
  set({ creating: true });
  try {
    const document = await enqueue(() => editsApi.createEdit(from ? { from } : {}));
    writeLast(document.id);
    void get().refreshList();
    applyOpen(token, document);
  } catch (error) {
    useToast.getState().show(from ? "Couldn't copy the edit" : "Couldn't create the edit", "error", false, errorMessage(error));
  } finally {
    set({ creating: false });
  }
}

/**
 * Before New, Open, Duplicate or All edits: the queue is waited for; changes are saved first with Save automatically
 * on, else the sheet asks. A refused or gone edit always asks (its save cannot succeed), so it can still be left.
 */
async function readyToSwitch(next: EditSwitch): Promise<boolean> {
  await editWritesIdle();
  if (!sessionIsDirty(currentEditSession())) return true;
  const state = get().save.state;
  if (useWorkflowStore.getState().autoSaveEnabled && state !== "conflict" && state !== "gone") {
    const outcome = await saveNow("manual");
    return outcome === "saved" || outcome === "unchanged";
  }
  set({ pendingSwitch: next });
  return false;
}

async function performSwitch(next: EditSwitch): Promise<void> {
  switch (next.action) {
    case "new":
      closeCurrent();
      return createAndOpen();
    case "duplicate":
      closeCurrent();
      return createAndOpen(next.id);
    case "open":
      closeCurrent();
      return readAndOpen(next.id);
    case "home":
      ++openSeq;
      closeCurrent();
      writeLast(null);
      set({ opening: null });
      return get().refreshList();
  }
}

async function switchTo(next: EditSwitch): Promise<void> {
  if (await readyToSwitch(next)) await performSwitch(next);
}

function initialPane(): EditProjectState["pane"] {
  return { open: readStorage(LIBRARY_PANE_KEY) !== "closed", kind: "all", focusRequest: 0 };
}

const sameKeys = (a: ReadonlySet<SourceKey>, b: ReadonlySet<SourceKey>) => a.size === b.size && [...a].every((k) => b.has(k));

export const useEditProjectStore = create<EditProjectState>(() => ({
  list: { status: "idle", edits: [], problems: [], folder: null, error: null },
  open: null,
  opening: null,
  creating: false,
  openError: null,
  save: SAVED,
  parked: null,
  render: { state: "idle", editId: null, progress: 0, message: null },
  pane: initialPane(),
  clipsLoading: NO_LOADING,
  pendingSwitch: null,
  confirmDelete: null,
  renameError: null,

  refreshList: async () => {
    const seq = ++listSeq;
    // A list already shown stays while it is read again, so its cards never jump
    const list = get().list;
    set({ list: { ...list, status: list.status === "ready" ? "ready" : "loading", error: null } });
    try {
      const list = await editsApi.fetchEditList();
      if (seq !== listSeq) return;
      set({ list: { status: "ready", edits: list.edits, problems: list.problems, folder: list.folder, error: null } });
    } catch (error) {
      if (seq !== listSeq) return;
      set({ list: { ...get().list, status: "error", error: errorMessage(error) } });
    }
  },

  enterView: async () => {
    const editor = useStitchEditorStore.getState();
    // The dialog's overlay covers the tab strip, so this cannot come from the UI; never take its session
    if (editor.isOpen && editor.nodeId !== null) {
      useAssetStore.getState().setAppView("canvas");
      return;
    }
    void get().refreshList();
    if (editor.isOpen) return;
    const { parked, open } = get();
    if (parked && open?.id === parked.editId) {
      editor.restore(parked);
      set({ parked: null });
      return;
    }
    const last = readLast();
    if (last) await readAndOpen(last, { quiet: true });
  },

  leaveView: () => {
    ++openSeq;
    const parked = useStitchEditorStore.getState().park();
    set({ opening: null, pendingSwitch: null, clipsLoading: NO_LOADING, ...(parked ? { parked } : {}) });
    if (parked && useWorkflowStore.getState().autoSaveEnabled && sessionIsDirty(parked)) void saveNow("auto");
  },

  newEdit: () => switchTo({ action: "new" }),

  openEditById: async (id) => {
    if (get().open?.id === id) return;
    await switchTo({ action: "open", id });
  },

  goHome: () => switchTo({ action: "home" }),

  duplicate: async (id) => {
    const from = id ?? get().open?.id;
    if (from) await switchTo({ action: "duplicate", id: from });
  },

  rename: async (name, id) => {
    const editId = id ?? get().open?.id;
    if (!editId) return false;
    const was = get().open?.id === editId ? get().open?.name : get().list.edits.find((e) => e.id === editId)?.name;
    const next = normalizeEditName(name);
    set({ renameError: null });
    if (next === was) return true;
    try {
      const { document, previousUpdatedAt } = await enqueue(() => editsApi.patchEdit(editId, { op: "rename", name: next }));
      const open = get().open;
      if (open?.id === editId) {
        // A rename based on what this window last saved moves the base; one over another window's save leaves it,
        // so the next save still finds that change
        const baseUpdatedAt = previousUpdatedAt === open.baseUpdatedAt ? document.updatedAt : open.baseUpdatedAt;
        set({ open: { ...open, name: document.name, baseUpdatedAt } });
      }
      // Assets labels an edit's renders by the name the library's workflows table holds for its id
      if (document.renders.length > 0) {
        void upsertWorkflowEntry(editId, { name: document.name, projectPath: null, asOf: Date.now() }).catch((error) =>
          console.warn("[EditVideo] Couldn't rename the edit's renders in the library:", error),
        );
      }
      void get().refreshList();
      return true;
    } catch (error) {
      if (error instanceof EditApiError && error.code === "name_taken") {
        set({ renameError: "Another edit has that name" });
        return false;
      }
      useToast.getState().show("Couldn't rename the edit", "error", false, errorMessage(error));
      return false;
    }
  },

  requestDelete: (id) => {
    const editId = id ?? get().open?.id;
    if (editId) set({ confirmDelete: editId });
  },

  cancelDelete: () => set({ confirmDelete: null }),

  confirmDeleteEdit: async () => {
    const editId = get().confirmDelete;
    if (!editId) return;
    set({ confirmDelete: null });
    const name = get().open?.id === editId ? get().open?.name : get().list.edits.find((e) => e.id === editId)?.name;
    try {
      await enqueue(() => editsApi.deleteEdit(editId));
    } catch (error) {
      if (!(error instanceof EditApiError && error.status === 404)) {
        useToast.getState().show("Couldn't delete the edit", "error", false, errorMessage(error));
        return;
      }
    }
    if (get().open?.id === editId) {
      ++openSeq;
      closeCurrent();
    }
    if (readLast() === editId) writeLast(null);
    useToast.getState().show(name ? `Moved “${name}” to the Trash` : "Moved the edit to the Trash", "info");
    void get().refreshList();
  },

  reveal: async (id) => {
    const editId = id ?? get().open?.id;
    if (!editId) return;
    try {
      await editsApi.revealEdit(editId);
    } catch (error) {
      useToast.getState().show("Couldn't show the edit's file", "error", false, errorMessage(error));
    }
  },

  revealFolder: async () => {
    try {
      await editsApi.revealEditsFolder();
    } catch (error) {
      useToast.getState().show("Couldn't open the Edits folder", "error", false, errorMessage(error));
    }
  },

  separateDuplicate: async (fileName) => {
    try {
      await enqueue(() => editsApi.createEdit({ separate: fileName }));
    } catch (error) {
      useToast.getState().show("Couldn't make it a separate edit", "error", false, errorMessage(error));
    }
    await get().refreshList();
  },

  saveNow,

  saveAsNew: async () => {
    const open = get().open;
    const session = currentEditSession();
    if (!open || !session?.draft) return;
    const sentId = open.id;
    const sent = session.draft;
    const body = saveBody(open, sent, session);
    set({ save: { ...get().save, state: "saving", error: null } });
    try {
      const document = await enqueue(() => editsApi.createEdit({ name: open.name, ...body }));
      // Moved wherever the session is (shown or parked): no new session is opened, so no token is needed
      if (get().open?.id !== sentId) return;
      const editor = useStitchEditorStore.getState();
      if (editor.isOpen && editor.editId === sentId) {
        editor.setEditId(document.id);
        editor.markSaved(sent);
      } else {
        const parked = get().parked;
        if (parked?.editId === sentId) set({ parked: { ...parked, editId: document.id, initial: sent } });
      }
      set({ open: metaOf(document), save: SAVED });
      writeLast(document.id);
      void get().refreshList();
    } catch (error) {
      if (get().open?.id === sentId) set({ save: { state: "gone", error: errorMessage(error), conflict: null, retryAt: null } });
    }
  },

  resolveConflict: async (choice) => {
    if (get().save.state !== "conflict") return;
    if (choice === "keepMine") {
      await startSave(true);
      return;
    }
    const current = get().save.conflict;
    if (!current) return;
    await editWritesIdle();
    applyOpen(++openSeq, current);
  },

  resolveSwitch: async (choice) => {
    const next = get().pendingSwitch;
    if (!next) return;
    set({ pendingSwitch: null });
    if (choice === "cancel") return;
    if (choice === "save") {
      const outcome = await saveNow("manual");
      if (outcome !== "saved" && outcome !== "unchanged") return;
    }
    await performSwitch(next);
  },

  addRender: async (editId, render) => {
    try {
      const { document } = await enqueue(() => editsApi.patchEdit(editId, { op: "addRender", render }));
      const open = get().open;
      if (open?.id === editId) set({ open: { ...open, renders: document.renders } });
      void get().refreshList();
    } catch (error) {
      // The video is in the library either way; only the edit's own list of renders misses it
      console.warn("[EditVideo] Couldn't add the render to the edit:", error);
    }
  },

  startRender: () => {
    if (get().render.state === "rendering") return;
    void import("@/components/edit/renderEdit").then((m) => m.renderEdit());
  },

  stopRender: () => {
    void import("@/components/edit/renderEdit").then((m) => m.stopEditRender());
  },

  setRenderState: (render) => set({ render: { ...get().render, ...render } }),

  setPaneOpen: (open) => {
    writeStorage(LIBRARY_PANE_KEY, open ? "open" : "closed");
    set({ pane: { ...get().pane, open } });
  },

  setPaneKind: (kind) => set({ pane: { ...get().pane, kind } }),

  requestPaneFocus: (kind) => {
    const pane = get().pane;
    if (!pane.open) writeStorage(LIBRARY_PANE_KEY, "open");
    set({ pane: { open: true, kind: kind ?? pane.kind, focusRequest: pane.focusRequest + 1 } });
  },

  setClipsLoading: (keys) => {
    if (!sameKeys(keys, get().clipsLoading)) set({ clipsLoading: keys });
  },
}));

/** For tests: the queue, the chained save and the tokens back to their start. */
export function __resetEditProjectForTests(): void {
  writes = Promise.resolve();
  inflight = null;
  again = null;
  openSeq = 0;
  listSeq = 0;
  useEditProjectStore.setState({
    list: { status: "idle", edits: [], problems: [], folder: null, error: null },
    open: null,
    opening: null,
    creating: false,
    openError: null,
    save: SAVED,
    parked: null,
    render: { state: "idle", editId: null, progress: 0, message: null },
    pane: initialPane(),
    clipsLoading: NO_LOADING,
    pendingSwitch: null,
    confirmDelete: null,
    renameError: null,
  });
}
