import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetEditProjectForTests,
  EDIT_PAUSED_MIN_WAIT_MS,
  editHasUnsavedWork,
  editWritesIdle,
  handleDesktopSave,
  LAST_EDIT_KEY,
  LIBRARY_PANE_KEY,
  useEditProjectStore,
} from "@/store/editProjectStore";
import { selectIsDirty, useStitchEditorStore } from "@/store/stitchEditorStore";
import { useAssetStore } from "@/store/assetStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { useSaveRequestStore } from "@/store/saveRequestStore";
import { editAutoSaveState } from "@/store/utils/editAutoSave";
import { openStitchEditor } from "@/components/stitch/openStitchEditor";
import { EditApiError } from "@/lib/edits/client";
import { __resetAssetInfoForTests, primeAssetInfo } from "@/lib/stitch/assetInfo";
import { createClip, type SourceKey } from "@/lib/stitch/timeline";
import type { EditDocument, EditSequence, SaveEditRequest } from "@/lib/edits/types";
import type { AssetView } from "@/lib/assets/types";
import type { WorkflowNode } from "@/types";

const api = vi.hoisted(() => ({
  fetchEditList: vi.fn(),
  fetchEdit: vi.fn(),
  createEdit: vi.fn(),
  saveEdit: vi.fn(),
  patchEdit: vi.fn(),
  deleteEdit: vi.fn(),
  revealEdit: vi.fn(),
  revealEditsFolder: vi.fn(),
  upsertWorkflowEntry: vi.fn(),
  show: vi.fn(),
  requestAssetInfo: vi.fn(),
  assetInfoThrows: false,
}));
vi.mock("@/lib/edits/client", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/edits/client")>();
  return {
    EditApiError: real.EditApiError,
    fetchEditList: api.fetchEditList,
    fetchEdit: api.fetchEdit,
    createEdit: api.createEdit,
    saveEdit: api.saveEdit,
    patchEdit: api.patchEdit,
    deleteEdit: api.deleteEdit,
    revealEdit: api.revealEdit,
    revealEditsFolder: api.revealEditsFolder,
  };
});
vi.mock("@/lib/assets/client/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/assets/client/api")>()),
  upsertWorkflowEntry: api.upsertWorkflowEntry,
}));
vi.mock("@/lib/stitch/assetInfo", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/stitch/assetInfo")>();
  return {
    ...real,
    requestAssetInfo: api.requestAssetInfo,
    getAssetInfo: (...args: Parameters<typeof real.getAssetInfo>) => {
      if (api.assetInfoThrows) throw new Error("Asset info broke");
      return real.getAssetInfo(...args);
    },
  };
});
vi.mock("@/components/Toast", () => ({ useToast: { getState: () => ({ show: api.show }) } }));

const ID = "ed0000000000a1";
const OTHER = "ed0000000000b2";
const store = () => useEditProjectStore.getState();
const editor = () => useStitchEditorStore.getState();

function sequence(assetIds: string[] = ["aclipaaaaaaaa1", "aclipaaaaaaaa2"]): EditSequence {
  return {
    timeline: assetIds.map((assetId, i) => createClip({ kind: "asset", assetId }, { id: `v${i + 1}` })),
    audioClips: [],
    loopCount: 1,
    sequenceLayout: { mode: "track", overlapSec: 0.5, crossfade: true },
  };
}

function doc(id = ID, overrides: Partial<EditDocument> = {}): EditDocument {
  return {
    kind: "node-banana-edit",
    version: 1,
    id,
    name: id === ID ? "Trip" : "Other",
    createdAt: 1000,
    updatedAt: 2000,
    sequence: sequence(),
    assets: {},
    renders: [],
    summary: { clipCount: 2, audioClipCount: 0, durationSec: 0, posterAssetId: "aclipaaaaaaaa1" },
    ...overrides,
  };
}

/** A promise answered by the test. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Opens `document` as if the view had read it. */
async function openDoc(document = doc()) {
  api.fetchEdit.mockResolvedValueOnce(document);
  await store().openEditById(document.id);
  expect(editor().editId).toBe(document.id);
}

const edit = () => editor().apply((d) => ({ ...d, loopCount: d.loopCount === 3 ? 1 : ((d.loopCount + 1) as 2 | 3) }));
const sentBody = (call = 0) => api.saveEdit.mock.calls[call][1] as SaveEditRequest;
const saved = (base: EditDocument, request: SaveEditRequest, updatedAt: number): EditDocument => ({
  ...base,
  updatedAt,
  sequence: request.sequence,
  assets: request.assets,
  summary: request.summary,
});

beforeEach(() => {
  vi.clearAllMocks();
  api.assetInfoThrows = false;
  __resetEditProjectForTests();
  __resetAssetInfoForTests();
  editor().close();
  localStorage.clear();
  useAssetStore.setState({ appView: "edit" });
  useWorkflowStore.setState({ autoSaveEnabled: true });
  useSaveRequestStore.setState({ request: null });
  api.fetchEditList.mockResolvedValue({ edits: [], problems: [], folder: "/lib/Edits" });
  api.upsertWorkflowEntry.mockResolvedValue({});
});

afterEach(async () => {
  await editWritesIdle();
  editor().close();
  vi.useRealTimers();
});

describe("saving", () => {
  it("sends the draft's sequence, the asset snapshot and the summary, and marks the draft saved", async () => {
    await openDoc();
    primeAssetInfo([
      { id: "aclipaaaaaaaa1", kind: "video", filename: "a.mp4", durationSec: 4, workflow: { projectPath: "/p/Launch" } } as unknown as AssetView,
    ]);
    editor().setDurations(new Map<SourceKey, number>([["asset:aclipaaaaaaaa2", 6]]));
    edit();
    api.saveEdit.mockImplementation(async (_id: string, request: SaveEditRequest) => saved(doc(), request, 3000));
    expect(await store().saveNow("manual")).toBe("saved");
    const body = sentBody();
    expect(api.saveEdit.mock.calls[0][0]).toBe(ID);
    expect(body).toMatchObject({ baseUpdatedAt: 2000, renders: [] });
    expect(body).not.toHaveProperty("force");
    expect(body.sequence.loopCount).toBe(2);
    expect(body.assets).toEqual({ aclipaaaaaaaa1: { name: "a.mp4", kind: "video", project: "Launch", durationSec: 4 } });
    // a's length from its record, b's measured: (4 + 6) × 2 loops
    expect(body.summary).toEqual({ clipCount: 2, audioClipCount: 0, durationSec: 20, posterAssetId: "aclipaaaaaaaa1" });
    expect(selectIsDirty(editor())).toBe(false);
    expect(store().open?.baseUpdatedAt).toBe(3000);
    expect(store().save.state).toBe("saved");
  });

  it("holds Saving… while the PUT is unanswered, and an edit made meanwhile stays unsaved", async () => {
    await openDoc();
    edit();
    const answer = deferred<EditDocument>();
    api.saveEdit.mockReturnValueOnce(answer.promise);
    const done = store().saveNow("auto");
    await flush();
    expect(store().save.state).toBe("saving");
    edit();
    answer.resolve(doc(ID, { updatedAt: 3000 }));
    expect(await done).toBe("saved");
    expect(store().save.state).toBe("saved");
    expect(selectIsDirty(editor())).toBe(true);
    expect(editHasUnsavedWork()).toBe(true);
  });

  it("says unchanged with nothing to save, and sends nothing", async () => {
    await openDoc();
    expect(await store().saveNow("manual")).toBe("unchanged");
    expect(api.saveEdit).not.toHaveBeenCalled();
  });

  it("marks the parked draft saved when the view was left during the save", async () => {
    await openDoc();
    edit();
    const answer = deferred<EditDocument>();
    api.saveEdit.mockReturnValueOnce(answer.promise);
    const done = store().saveNow("manual");
    useWorkflowStore.setState({ autoSaveEnabled: false });
    store().leaveView();
    expect(editor().isOpen).toBe(false);
    answer.resolve(doc(ID, { updatedAt: 3000 }));
    await done;
    const parked = store().parked!;
    expect(parked.initial).toBe(parked.draft);
  });
});

describe("one write at a time", () => {
  it("sends ⌘S during an automatic save after it answers, on its updatedAt, with no conflict", async () => {
    await openDoc();
    edit();
    const first = deferred<EditDocument>();
    api.saveEdit.mockReturnValueOnce(first.promise);
    api.saveEdit.mockImplementationOnce(async (_id: string, request: SaveEditRequest) => saved(doc(), request, 4000));
    const auto = store().saveNow("auto");
    await flush();
    edit();
    const manual = store().saveNow("manual");
    await flush();
    expect(api.saveEdit).toHaveBeenCalledTimes(1);
    first.resolve(doc(ID, { updatedAt: 3000 }));
    expect(await auto).toBe("saved");
    expect(await manual).toBe("saved");
    expect(api.saveEdit).toHaveBeenCalledTimes(2);
    expect(sentBody(1).baseUpdatedAt).toBe(3000);
    expect(store().save.state).toBe("saved");
    expect(store().open?.baseUpdatedAt).toBe(4000);
  });

  it("chains exactly one save behind a running one, however many are asked for", async () => {
    await openDoc();
    edit();
    const first = deferred<EditDocument>();
    api.saveEdit.mockReturnValueOnce(first.promise);
    api.saveEdit.mockImplementation(async (_id: string, request: SaveEditRequest) => saved(doc(), request, 5000));
    const calls = [store().saveNow("auto")];
    await flush();
    edit();
    calls.push(store().saveNow("manual"), store().saveNow("manual"), store().saveNow("auto"));
    first.resolve(doc(ID, { updatedAt: 3000 }));
    await Promise.all(calls);
    expect(api.saveEdit).toHaveBeenCalledTimes(2);
  });

  it("counts a save that could not even be built as failed, and the next save still sends", async () => {
    await openDoc();
    edit();
    const first = deferred<EditDocument>();
    api.saveEdit.mockReturnValueOnce(first.promise);
    api.saveEdit.mockImplementation(async (_id: string, request: SaveEditRequest) => saved(doc(), request, 5000));
    const running = store().saveNow("auto");
    await flush();
    edit();
    api.assetInfoThrows = true;
    const chained = store().saveNow("manual");
    first.resolve(doc(ID, { updatedAt: 3000 }));
    expect(await running).toBe("saved");
    expect(await chained).toBe("failed");
    expect(store().save).toMatchObject({ state: "failed", error: "Asset info broke" });
    api.assetInfoThrows = false;
    expect(await store().saveNow("manual")).toBe("saved");
    expect(api.saveEdit).toHaveBeenCalledTimes(2);
    expect(store().save.state).toBe("saved");
  });

  it("sends a rename made during a save after the save, with no conflict", async () => {
    await openDoc();
    edit();
    const first = deferred<EditDocument>();
    api.saveEdit.mockReturnValueOnce(first.promise);
    api.patchEdit.mockImplementation(async () => ({ document: doc(ID, { name: "Launch cut", updatedAt: 3001 }), previousUpdatedAt: 3000 }));
    const save = store().saveNow("auto");
    await flush();
    const rename = store().rename("Launch cut");
    await flush();
    expect(api.patchEdit).not.toHaveBeenCalled();
    first.resolve(doc(ID, { updatedAt: 3000 }));
    await save;
    expect(await rename).toBe(true);
    expect(store().open).toMatchObject({ name: "Launch cut", baseUpdatedAt: 3001 });
    expect(store().save.state).toBe("saved");
  });

  it("leaves another edit's base as its GET gave it when a save of the first answers late", async () => {
    await openDoc();
    edit();
    useWorkflowStore.setState({ autoSaveEnabled: false });
    const first = deferred<EditDocument>();
    api.saveEdit.mockReturnValueOnce(first.promise);
    const save = store().saveNow("manual");
    api.fetchEdit.mockResolvedValueOnce(doc(OTHER, { updatedAt: 7000 }));
    const switched = store().openEditById(OTHER);
    await flush();
    first.resolve(doc(ID, { updatedAt: 3000 }));
    await save;
    await switched;
    expect(store().open).toMatchObject({ id: OTHER, baseUpdatedAt: 7000 });
    expect(editor().editId).toBe(OTHER);
  });
});

describe("opening only into a view that shows", () => {
  const seedNode = () =>
    useWorkflowStore.setState({
      nodes: [{ id: "s1", type: "videoStitch", position: { x: 0, y: 0 }, data: { clips: [], loopCount: 1 } } as unknown as WorkflowNode],
      edges: [],
    });

  it("drops a GET that answers after the view was left: the editor stays free for the dialog", async () => {
    localStorage.setItem(LAST_EDIT_KEY, ID);
    const answer = deferred<EditDocument>();
    api.fetchEdit.mockReturnValueOnce(answer.promise);
    const entering = store().enterView();
    store().leaveView();
    useAssetStore.setState({ appView: "canvas" });
    answer.resolve(doc());
    await entering;
    expect(editor().isOpen).toBe(false);
    // The canvas's A/C guard and Expand both see a free editor
    seedNode();
    expect(openStitchEditor("s1")).toBe(true);
    expect(editor().nodeId).toBe("s1");
  });

  it("drops a POST from New edit that answers after the view was left; the edit still exists and is remembered", async () => {
    const answer = deferred<EditDocument>();
    api.createEdit.mockReturnValueOnce(answer.promise);
    const creating = store().newEdit();
    await flush();
    store().leaveView();
    useAssetStore.setState({ appView: "canvas" });
    seedNode();
    expect(openStitchEditor("s1")).toBe(true);
    answer.resolve(doc());
    await creating;
    expect(editor().nodeId).toBe("s1");
    expect(editor().editId).toBeNull();
    expect(localStorage.getItem(LAST_EDIT_KEY)).toBe(ID);
  });

  it("opens the edit once in StrictMode's enter, leave, enter", async () => {
    localStorage.setItem(LAST_EDIT_KEY, ID);
    const first = deferred<EditDocument>();
    const second = deferred<EditDocument>();
    api.fetchEdit.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const a = store().enterView();
    store().leaveView();
    const b = store().enterView();
    const opened = vi.spyOn(useStitchEditorStore.getState(), "openEdit");
    first.resolve(doc());
    second.resolve(doc());
    await Promise.all([a, b]);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(editor().editId).toBe(ID);
  });
});

describe("conflicts", () => {
  const conflict = (current: EditDocument) => new EditApiError("Changed elsewhere", 409, "conflict", current);

  it("stops autosave and offers Keep mine, a forced save", async () => {
    await openDoc();
    edit();
    api.saveEdit.mockRejectedValueOnce(conflict(doc(ID, { updatedAt: 2500 })));
    expect(await store().saveNow("auto")).toBe("conflict");
    expect(store().save.state).toBe("conflict");
    expect(editAutoSaveState().autoSaveEnabled).toBe(false);
    // An automatic save does not send the refused edit again
    expect(await store().saveNow("auto")).toBe("conflict");
    expect(api.saveEdit).toHaveBeenCalledTimes(1);

    api.saveEdit.mockImplementationOnce(async (_id: string, request: SaveEditRequest) => saved(doc(), request, 2600));
    await store().resolveConflict("keepMine");
    expect(sentBody(1)).toMatchObject({ force: true });
    expect(store().save.state).toBe("saved");
    expect(selectIsDirty(editor())).toBe(false);
  });

  it("Use the other version reopens what is stored, the history cleared", async () => {
    await openDoc();
    edit();
    const current = doc(ID, { updatedAt: 2500, sequence: { ...sequence(["aclipaaaaaaaa9"]), loopCount: 3 } });
    api.saveEdit.mockRejectedValueOnce(conflict(current));
    await store().saveNow("manual");
    await store().resolveConflict("useTheirs");
    expect(editor().draft?.timeline.map((c) => c.source)).toEqual([{ kind: "asset", assetId: "aclipaaaaaaaa9" }]);
    expect(editor().past).toEqual([]);
    expect(store().open?.baseUpdatedAt).toBe(2500);
    expect(store().save.state).toBe("saved");
  });
});

describe("an edit that is gone", () => {
  it("stops autosave; Save as a new edit moves the session to the new edit, history kept", async () => {
    await openDoc();
    edit();
    api.saveEdit.mockRejectedValueOnce(new EditApiError("Not found", 404, "not_found"));
    expect(await store().saveNow("auto")).toBe("gone");
    expect(store().save.state).toBe("gone");
    expect(editAutoSaveState().autoSaveEnabled).toBe(false);
    expect(editHasUnsavedWork()).toBe(true);

    api.createEdit.mockResolvedValueOnce(doc(OTHER, { name: "Trip", updatedAt: 9000 }));
    await store().saveAsNew();
    expect(api.createEdit.mock.calls[0][0]).toMatchObject({ name: "Trip", sequence: { loopCount: 2 } });
    expect(editor().editId).toBe(OTHER);
    expect(editor().past).toHaveLength(1);
    expect(selectIsDirty(editor())).toBe(false);
    expect(store().open).toMatchObject({ id: OTHER, baseUpdatedAt: 9000 });
    expect(store().save.state).toBe("saved");
    expect(localStorage.getItem(LAST_EDIT_KEY)).toBe(OTHER);
  });
});

describe("a library that is moving", () => {
  it("waits until the retry time, without counting a failure", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(10_000);
    await openDoc();
    edit();
    api.saveEdit.mockRejectedValueOnce(new EditApiError("Paused", 503, "paused", undefined, 1000));
    expect(await store().saveNow("auto")).toBe("waiting");
    expect(store().save).toMatchObject({ state: "waiting", retryAt: 10_000 + EDIT_PAUSED_MIN_WAIT_MS });
    expect(editAutoSaveState(10_000).isRunning).toBe(true);
    expect(editAutoSaveState(10_000 + EDIT_PAUSED_MIN_WAIT_MS).isRunning).toBe(false);
    expect(editAutoSaveState().autoSaveEnabled).toBe(true);
    expect(editHasUnsavedWork()).toBe(true);
  });

  it("waits as long as Retry-After asks when that is longer", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(10_000);
    await openDoc();
    edit();
    api.saveEdit.mockRejectedValueOnce(new EditApiError("Paused", 503, "paused", undefined, 8000));
    await store().saveNow("auto");
    expect(store().save.retryAt).toBe(18_000);
  });
});

describe("leaving and entering the view", () => {
  it("parks the session and, with autosave on and changes, saves the parked draft", async () => {
    await openDoc();
    edit();
    api.saveEdit.mockImplementation(async (_id: string, request: SaveEditRequest) => saved(doc(), request, 3000));
    store().leaveView();
    expect(editor().isOpen).toBe(false);
    expect(store().parked?.editId).toBe(ID);
    await editWritesIdle();
    expect(api.saveEdit).toHaveBeenCalledTimes(1);
    expect(sentBody().sequence.loopCount).toBe(2);
    expect(store().parked!.initial).toBe(store().parked!.draft);
  });

  it("keeps the changes parked with autosave off, and asks nothing", async () => {
    useWorkflowStore.setState({ autoSaveEnabled: false });
    await openDoc();
    edit();
    store().leaveView();
    await editWritesIdle();
    expect(api.saveEdit).not.toHaveBeenCalled();
    expect(editHasUnsavedWork()).toBe(true);
  });

  it("restores the parked session on return, playhead and history included", async () => {
    await openDoc();
    edit();
    editor().setPlayhead(4.2);
    useWorkflowStore.setState({ autoSaveEnabled: false });
    store().leaveView();
    await store().enterView();
    expect(editor().editId).toBe(ID);
    expect(editor().playhead).toBe(4.2);
    expect(editor().past).toHaveLength(1);
    expect(api.fetchEdit).toHaveBeenCalledTimes(1);
  });

  it("opens the last edit, and forgets it when it is gone", async () => {
    localStorage.setItem(LAST_EDIT_KEY, ID);
    api.fetchEdit.mockResolvedValueOnce(doc());
    await store().enterView();
    expect(editor().editId).toBe(ID);

    editor().close();
    __resetEditProjectForTests();
    api.fetchEdit.mockRejectedValueOnce(new EditApiError("Not found", 404, "not_found"));
    await store().enterView();
    expect(editor().isOpen).toBe(false);
    expect(localStorage.getItem(LAST_EDIT_KEY)).toBeNull();
    expect(api.show).not.toHaveBeenCalled();
  });

  it.each([
    ["the server fails", new EditApiError("Internal error", 500, "internal")],
    ["the server cannot be reached", new EditApiError("Failed to fetch", 0)],
    ["the library is moving", new EditApiError("Library paused", 503, "paused")],
  ])("says so when opening fails because %s, offers Try again, and reads the list again", async (_why, error) => {
    await openDoc();
    api.fetchEditList.mockClear();
    api.fetchEdit.mockRejectedValueOnce(error);
    await store().openEditById(OTHER);
    expect(store().opening).toBeNull();
    expect(editor().isOpen).toBe(false);
    expect(api.show).toHaveBeenCalledWith("Couldn't open the edit", "error", false, error.message, [
      expect.objectContaining({ label: "Try again" }),
    ]);
    expect(api.fetchEditList).toHaveBeenCalled();

    api.fetchEdit.mockResolvedValueOnce(doc(OTHER));
    const [, , , , actions] = api.show.mock.calls[0] as [string, string, boolean, string, Array<{ onClick: () => void }>];
    actions[0].onClick();
    await vi.waitFor(() => expect(editor().editId).toBe(OTHER));
  });

  it("never takes the dialog's session: entering with one open goes back to the canvas", async () => {
    useWorkflowStore.setState({
      nodes: [{ id: "s1", type: "videoStitch", position: { x: 0, y: 0 }, data: { clips: [], loopCount: 1 } } as unknown as WorkflowNode],
      edges: [],
    });
    openStitchEditor("s1");
    await store().enterView();
    expect(useAssetStore.getState().appView).toBe("canvas");
    expect(editor().nodeId).toBe("s1");
  });
});

describe("unsaved work", () => {
  it("counts a dirty draft and every save state but saved", async () => {
    expect(editHasUnsavedWork()).toBe(false);
    await openDoc();
    expect(editHasUnsavedWork()).toBe(false);
    for (const state of ["saving", "waiting", "failed", "gone", "conflict"] as const) {
      useEditProjectStore.setState({ save: { state, error: null, conflict: null, retryAt: null } });
      expect(editHasUnsavedWork()).toBe(true);
    }
    useEditProjectStore.setState({ save: { state: "saved", error: null, conflict: null, retryAt: null } });
    edit();
    expect(editHasUnsavedWork()).toBe(true);
  });
});

describe("File › Save in the desktop app", () => {
  it("saves the edit while the view shows, and asks for nothing from the workflow", async () => {
    await openDoc();
    edit();
    api.saveEdit.mockImplementation(async (_id: string, request: SaveEditRequest) => saved(doc(), request, 3000));
    handleDesktopSave();
    await editWritesIdle();
    expect(api.saveEdit).toHaveBeenCalledTimes(1);
    expect(useSaveRequestStore.getState().request).toBeNull();
  });

  it("saves the workflow everywhere else", () => {
    useAssetStore.setState({ appView: "canvas" });
    handleDesktopSave();
    expect(useSaveRequestStore.getState().request).toMatchObject({ reason: "desktop" });
    expect(api.saveEdit).not.toHaveBeenCalled();
  });
});

describe("switching edits", () => {
  it("asks first with autosave off and changes; Don't save opens the other", async () => {
    useWorkflowStore.setState({ autoSaveEnabled: false });
    await openDoc();
    edit();
    await store().openEditById(OTHER);
    expect(store().pendingSwitch).toEqual({ action: "open", id: OTHER });
    expect(editor().editId).toBe(ID);
    api.fetchEdit.mockResolvedValueOnce(doc(OTHER));
    await store().resolveSwitch("discard");
    expect(editor().editId).toBe(OTHER);
    expect(api.saveEdit).not.toHaveBeenCalled();
  });

  it("Save then switches; Cancel stays", async () => {
    useWorkflowStore.setState({ autoSaveEnabled: false });
    await openDoc();
    edit();
    await store().goHome();
    await store().resolveSwitch("cancel");
    expect(editor().editId).toBe(ID);
    await store().goHome();
    api.saveEdit.mockImplementation(async (_id: string, request: SaveEditRequest) => saved(doc(), request, 3000));
    await store().resolveSwitch("save");
    expect(api.saveEdit).toHaveBeenCalledTimes(1);
    expect(editor().isOpen).toBe(false);
    expect(store().open).toBeNull();
  });

  it("saves first with autosave on, and stays when that save fails", async () => {
    await openDoc();
    edit();
    api.saveEdit.mockRejectedValueOnce(new EditApiError("Disk full", 500));
    await store().newEdit();
    expect(api.createEdit).not.toHaveBeenCalled();
    expect(editor().editId).toBe(ID);
    expect(store().save).toMatchObject({ state: "failed", error: "Disk full" });

    api.saveEdit.mockImplementation(async (_id: string, request: SaveEditRequest) => saved(doc(), request, 3000));
    api.createEdit.mockResolvedValueOnce(doc(OTHER));
    await store().newEdit();
    expect(editor().editId).toBe(OTHER);
  });

  it("asks rather than saving a gone edit, so it can still be left", async () => {
    await openDoc();
    edit();
    useEditProjectStore.setState({ save: { state: "gone", error: null, conflict: null, retryAt: null } });
    await store().goHome();
    expect(store().pendingSwitch).toEqual({ action: "home" });
  });

  it("All edits closes the edit and forgets it as the last one", async () => {
    await openDoc();
    await store().goHome();
    expect(editor().isOpen).toBe(false);
    expect(store().open).toBeNull();
    expect(localStorage.getItem(LAST_EDIT_KEY)).toBeNull();
  });
});

describe("rename, duplicate, delete", () => {
  it("shows a note when the name is taken", async () => {
    await openDoc();
    api.patchEdit.mockRejectedValueOnce(new EditApiError("Taken", 409, "name_taken"));
    expect(await store().rename("Other")).toBe(false);
    expect(store().renameError).toBe("Another edit has that name");
    expect(store().open?.name).toBe("Trip");
  });

  it("keeps the base when another window saved first, so the next save still finds that change", async () => {
    await openDoc();
    api.patchEdit.mockResolvedValueOnce({ document: doc(ID, { name: "New", updatedAt: 6001 }), previousUpdatedAt: 6000 });
    await store().rename("New");
    expect(store().open).toMatchObject({ name: "New", baseUpdatedAt: 2000 });
  });

  it("renames the edit's renders in the library only when it has some", async () => {
    await openDoc();
    api.patchEdit.mockResolvedValueOnce({ document: doc(ID, { name: "New", updatedAt: 2001 }), previousUpdatedAt: 2000 });
    await store().rename("New");
    expect(api.upsertWorkflowEntry).not.toHaveBeenCalled();
    const render = { assetId: "arender000001", renderedAt: 1, durationSec: 4 };
    api.patchEdit.mockResolvedValueOnce({ document: doc(ID, { name: "Newer", updatedAt: 2002, renders: [render] }), previousUpdatedAt: 2001 });
    await store().rename("Newer");
    expect(api.upsertWorkflowEntry).toHaveBeenCalledWith(ID, expect.objectContaining({ name: "Newer", projectPath: null }));
  });

  it("duplicates and opens the copy", async () => {
    await openDoc();
    api.createEdit.mockResolvedValueOnce(doc(OTHER, { name: "Trip copy" }));
    await store().duplicate();
    expect(api.createEdit).toHaveBeenCalledWith({ from: ID });
    expect(editor().editId).toBe(OTHER);
    expect(store().open?.name).toBe("Trip copy");
  });

  it("deletes after the confirmation and returns home", async () => {
    await openDoc();
    api.deleteEdit.mockResolvedValueOnce(undefined);
    store().requestDelete();
    expect(store().confirmDelete).toBe(ID);
    await store().confirmDeleteEdit();
    expect(api.deleteEdit).toHaveBeenCalledWith(ID);
    expect(editor().isOpen).toBe(false);
    expect(store().open).toBeNull();
    expect(localStorage.getItem(LAST_EDIT_KEY)).toBeNull();
  });
});

describe("renders in the file", () => {
  it("adds a render through the queue, to the edit it was made from only", async () => {
    await openDoc();
    const render = { assetId: "arender000001", renderedAt: 5, durationSec: 4 };
    api.patchEdit.mockResolvedValueOnce({ document: doc(ID, { renders: [render] }), previousUpdatedAt: 2000 });
    await store().addRender(ID, render);
    expect(api.patchEdit).toHaveBeenCalledWith(ID, { op: "addRender", render });
    expect(store().open?.renders).toEqual([render]);
    expect(store().open?.baseUpdatedAt).toBe(2000);

    api.patchEdit.mockResolvedValueOnce({ document: doc(OTHER, { renders: [render] }), previousUpdatedAt: 1 });
    await store().addRender(OTHER, { ...render, assetId: "arender000002" });
    expect(store().open?.renders).toEqual([render]);
  });

  it("sends a render made during a save after the save, without moving the base", async () => {
    await openDoc();
    edit();
    const render = { assetId: "arender000001", renderedAt: 5, durationSec: 4 };
    const first = deferred<EditDocument>();
    api.saveEdit.mockReturnValueOnce(first.promise);
    api.patchEdit.mockResolvedValueOnce({ document: doc(ID, { updatedAt: 3000, renders: [render] }), previousUpdatedAt: 3000 });
    const save = store().saveNow("auto");
    await flush();
    const adding = store().addRender(ID, render);
    await flush();
    expect(api.patchEdit).not.toHaveBeenCalled();
    first.resolve(doc(ID, { updatedAt: 3000 }));
    await Promise.all([save, adding]);
    expect(api.patchEdit).toHaveBeenCalledTimes(1);
    expect(api.patchEdit).toHaveBeenCalledWith(ID, { op: "addRender", render });
    expect(store().open).toMatchObject({ baseUpdatedAt: 3000, renders: [render] });
  });

  it("keeps quiet when the render cannot be added to the file: the video is in the library anyway", async () => {
    await openDoc();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    api.patchEdit.mockRejectedValueOnce(new Error("Disk full"));
    await expect(store().addRender(ID, { assetId: "arender000001", renderedAt: 5, durationSec: 4 })).resolves.toBeUndefined();
    expect(api.show).not.toHaveBeenCalled();
    expect(store().open?.renders).toEqual([]);
    warn.mockRestore();
  });
});

describe("the library pane", () => {
  it("is open by default and remembers being hidden", () => {
    expect(store().pane.open).toBe(true);
    store().setPaneOpen(false);
    expect(localStorage.getItem(LIBRARY_PANE_KEY)).toBe("closed");
    __resetEditProjectForTests();
    expect(store().pane.open).toBe(false);
  });

  it("+ opens it, sets its kind and asks for its search's focus", () => {
    store().setPaneOpen(false);
    store().requestPaneFocus("audio");
    expect(store().pane).toEqual({ open: true, kind: "audio", focusRequest: 1 });
    store().requestPaneFocus();
    expect(store().pane).toEqual({ open: true, kind: "audio", focusRequest: 2 });
  });

  it("keeps the loading set when its keys are the same", () => {
    const keys = new Set<SourceKey>(["asset:aclipaaaaaaaa1"]);
    store().setClipsLoading(keys);
    store().setClipsLoading(new Set(keys));
    expect(store().clipsLoading).toBe(keys);
  });
});

describe("the list", () => {
  it("keeps a shown list while it is read again, and shows an error when it cannot be read", async () => {
    api.fetchEditList.mockResolvedValueOnce({ edits: [{ id: ID, name: "Trip" }], problems: [], folder: "/lib/Edits" });
    await store().refreshList();
    expect(store().list).toMatchObject({ status: "ready", folder: "/lib/Edits" });
    const answer = deferred<unknown>();
    api.fetchEditList.mockReturnValueOnce(answer.promise);
    const refreshing = store().refreshList();
    expect(store().list.status).toBe("ready");
    expect(store().list.edits).toHaveLength(1);
    answer.reject(new EditApiError("Library unavailable", 503));
    await refreshing;
    expect(store().list).toMatchObject({ status: "error", error: "Library unavailable" });
  });

  it("drops an older answer that arrives after a newer one", async () => {
    const older = deferred<unknown>();
    api.fetchEditList.mockReturnValueOnce(older.promise);
    const first = store().refreshList();
    api.fetchEditList.mockResolvedValueOnce({ edits: [], problems: [], folder: "/new/Edits" });
    await store().refreshList();
    older.resolve({ edits: [], problems: [], folder: "/old/Edits" });
    await first;
    expect(store().list.folder).toBe("/new/Edits");
  });
});
