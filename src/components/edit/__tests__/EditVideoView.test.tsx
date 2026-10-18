import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AssetFacets, AssetPage, AssetView, LibraryStatus } from "@/lib/assets/types";
import type { EditDocument, EditSummary } from "@/lib/edits/types";

const edits = vi.hoisted(() => ({
  fetchEditList: vi.fn(),
  fetchEdit: vi.fn(),
  createEdit: vi.fn(),
  saveEdit: vi.fn(),
  patchEdit: vi.fn(),
  deleteEdit: vi.fn(),
  revealEdit: vi.fn(),
  revealEditsFolder: vi.fn(),
}));
vi.mock("@/lib/edits/client", async (importOriginal) => ({
  EditApiError: (await importOriginal<typeof import("@/lib/edits/client")>()).EditApiError,
  ...edits,
}));

const assetsApi = vi.hoisted(() => ({
  fetchAssetPage: vi.fn(),
  fetchFacets: vi.fn(),
  fetchAsset: vi.fn(),
  upsertWorkflowEntry: vi.fn(),
}));
vi.mock("@/lib/assets/client/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/assets/client/api")>()),
  ...assetsApi,
}));

const recorded = vi.hoisted(() => ({ listeners: new Set<(result: { asset: AssetView }) => void>() }));
vi.mock("@/lib/assets/client/recorder", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/assets/client/recorder")>()),
  onAssetRecorded: (listener: (result: { asset: AssetView }) => void) => {
    recorded.listeners.add(listener);
    return () => recorded.listeners.delete(listener);
  },
}));

vi.mock("@/hooks/useStitchVideos", () => ({ checkEncoderSupport: async () => true, stitchVideosAsync: vi.fn() }));
const toast = vi.hoisted(() => vi.fn());
vi.mock("@/components/Toast", () => ({ useToast: { getState: () => ({ show: toast }) } }));
vi.mock("@/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    startSession: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn().mockResolvedValue(undefined),
    getCurrentSession: vi.fn().mockReturnValue(null),
  },
}));
const storage: Record<string, string> = {};
vi.stubGlobal("localStorage", {
  getItem: vi.fn((key: string) => storage[key] ?? null),
  setItem: vi.fn((key: string, value: string) => {
    storage[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete storage[key];
  }),
  clear: vi.fn(),
});

import { EditApiError } from "@/lib/edits/client";
import { applyLibraryStatus } from "@/lib/assets/client/recorder";
import { __resetAssetInfoForTests } from "@/lib/stitch/assetInfo";
import { __resetMediaInfoForTests, __setMediaExtractorForTests, __setMediaInfoForTests, assetMediaKey } from "@/lib/stitch/mediaInfo";
import { createAudioClip } from "@/lib/stitch/audioClips";
import { createClip } from "@/lib/stitch/timeline";
import { useAssetStore } from "@/store/assetStore";
import { __resetEditProjectForTests, LAST_EDIT_KEY, useEditProjectStore } from "@/store/editProjectStore";
import { requestSave, useSaveRequestStore } from "@/store/saveRequestStore";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { useStitchClipboard } from "@/store/stitchClipboardStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { setLoopCount } from "@/components/stitch/editorActions";
import { libraryDrop } from "@/components/stitch/timeline/libraryDrop";
import { LOOP_AUDIO_NOTE } from "@/components/stitch/sequenceMenu";
import { EditVideoView } from "../EditVideoView";

const ID = "ed0000000000a1";
const OTHER = "ed0000000000b2";
const A = "aclipaaaaaaaa1";
const B = "aclipaaaaaaaa2";
const C = "aclipaaaaaaaa3";
const M = "aaudioaaaaaaa1";
const T0 = Date.UTC(2026, 9, 16, 12);
const editor = () => useStitchEditorStore.getState();
const project = () => useEditProjectStore.getState();

function asset(id: string, overrides: Partial<AssetView> = {}): AssetView {
  return {
    v: 1,
    id,
    kind: "video",
    origin: "generated",
    mime: "video/mp4",
    ext: "mp4",
    bytes: 2_400_000,
    sha256: id.padEnd(64, "0"),
    md5: "",
    file: { root: "library", rel: `Generations/2026-10-16/${id}.mp4` },
    filename: `${id}.mp4`,
    width: 1280,
    height: 720,
    durationSec: 5,
    createdAt: T0,
    model: { provider: "kie", modelId: "veo3", displayName: "Veo 3.1" },
    producer: { nodeId: "n1", nodeType: "generateVideo" },
    workflowId: "wf_1",
    workflowName: null,
    runId: "r1",
    tags: [],
    favorite: false,
    hasPoster: true,
    workflow: { id: "wf_1", name: "Launch", projectPath: "/Users/me/Node Banana/Launch film" },
    displayPath: `/Users/me/Node Banana/Generations/2026-10-16/${id}.mp4`,
    ...overrides,
  };
}

const LIBRARY: Record<string, AssetView> = {
  [A]: asset(A, { filename: "sunset.mp4" }),
  [B]: asset(B, { filename: "beach.mp4" }),
  [C]: asset(C, { filename: "desert.mp4" }),
  [M]: asset(M, { kind: "audio", mime: "audio/mp4", ext: "m4a", filename: "music.m4a", width: undefined, height: undefined, durationSec: 20 }),
};

function page(list: AssetView[]): AssetPage {
  return { assets: list, nextCursor: null, headCursor: list[0] ? "h" : null, total: list.length, totalBytes: 0 };
}

const facets: AssetFacets = {
  total: 4,
  favorites: 0,
  trash: 0,
  missing: 0,
  kinds: { image: 0, video: 3, audio: 1, "3d": 0 },
  origins: { generated: 4, edited: 0 },
  models: [],
  tags: [],
  workflows: [],
  projects: [{ path: "/Users/me/Node Banana/Launch film", name: "Launch film", count: 4 }],
};

const status = (available: boolean) =>
  ({
    available,
    reasonCode: available ? undefined : "hosted",
    root: null,
    source: "default",
    defaultRoot: "/x",
    cacheDir: "/x",
    platform: "darwin",
  }) as LibraryStatus;

function doc(overrides: Partial<EditDocument> = {}, layout: "track" | "stacked" = "track"): EditDocument {
  return {
    kind: "node-banana-edit",
    version: 1,
    id: ID,
    name: "Trip",
    createdAt: 1000,
    updatedAt: 2000,
    sequence: {
      timeline: [createClip({ kind: "asset", assetId: A }, { id: "v1" }), createClip({ kind: "asset", assetId: B }, { id: "v2" })],
      audioClips: [],
      loopCount: 1,
      sequenceLayout: { mode: layout, overlapSec: 0.5, crossfade: true },
    },
    assets: { [A]: { name: "sunset.mp4", kind: "video", project: "Launch film", durationSec: 5 } },
    renders: [],
    summary: { clipCount: 2, audioClipCount: 0, durationSec: 10, posterAssetId: A },
    ...overrides,
  };
}

function summary(document: EditDocument, overrides: Partial<EditSummary> = {}): EditSummary {
  return {
    ...document.summary,
    id: document.id,
    name: document.name,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    renderCount: document.renders.length,
    fileName: `${document.name}.nbedit`,
    poster: null,
    ...overrides,
  };
}

const listOf = (docs: EditDocument[], problems: { fileName: string; problem: "unreadable" | "newer" | "duplicate"; name: string | null }[] = []) => ({
  edits: docs.map((d) => summary(d)),
  problems,
  folder: "/Users/me/Node Banana/Edits",
});

/** Every clip's media measured: lengths 5 s, 1280 × 720. */
function measure(...ids: string[]) {
  for (const id of ids) __setMediaInfoForTests(assetMediaKey(id), { status: "ready", duration: 5, width: 1280, height: 720, fps: 24 });
}

/** The view with `document` open (it is the last edit, so entering opens it). */
async function renderOpen(document = doc()) {
  storage[LAST_EDIT_KEY] = document.id;
  edits.fetchEdit.mockResolvedValue(document);
  edits.fetchEditList.mockResolvedValue(listOf([document]));
  const view = render(<EditVideoView />);
  await screen.findByRole("button", { name: "Edit menu" });
  await screen.findAllByRole("button", { name: /^Add .* at the playhead$/ });
  return view;
}

async function renderHome(list = listOf([])) {
  edits.fetchEditList.mockResolvedValue(list);
  const view = render(<EditVideoView />);
  await act(async () => {});
  return view;
}

const press = (target: EventTarget, key: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
};
const tile = (id: string) => document.querySelector<HTMLElement>(`aside [data-asset-id="${id}"]`)!;
/**
 * A press on `target`, with the focus a browser gives it (jsdom moves none): the nearest focusable ancestor takes it
 * (the page, when none does), then the click.
 */
function pressAt(target: HTMLElement) {
  const focusable = target.closest<HTMLElement>("button:not(:disabled), input:not(:disabled), [tabindex]");
  act(() => {
    if (focusable) focusable.focus();
    else (document.activeElement as HTMLElement | null)?.blur();
  });
  fireEvent.click(target);
}
const tileIds = () => Array.from(document.querySelectorAll<HTMLElement>("aside [data-asset-id]")).map((el) => el.dataset.assetId);
/** A sheet's buttons take the editor's white focus ring, never the dialogs' blue one. */
function expectWhiteRings(sheet: HTMLElement) {
  for (const button of within(sheet).getAllByRole("button")) {
    expect(button.className).not.toMatch(/ring-selection/);
    expect(button.className.split(" ")).toContain("focus-visible:ring-white/40");
  }
}
const timelineIds = () => editor().draft!.timeline.map((c) => c.source.kind === "asset" ? c.source.assetId : c.id);

beforeEach(() => {
  for (const key of Object.keys(storage)) delete storage[key];
  vi.clearAllMocks();
  __resetEditProjectForTests();
  editor().close();
  __resetMediaInfoForTests();
  __resetAssetInfoForTests();
  __setMediaExtractorForTests({ probe: () => new Promise(() => {}), open: () => new Promise(() => {}) });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  applyLibraryStatus(status(true));
  useAssetStore.setState({ appView: "edit" });
  useWorkflowStore.setState({ autoSaveEnabled: false, shortcutsDialogOpen: false });
  useSaveRequestStore.setState({ request: null });
  assetsApi.fetchAsset.mockImplementation(async (id: string) => LIBRARY[id] ?? null);
  assetsApi.fetchAssetPage.mockResolvedValue(page([LIBRARY[C], LIBRARY[B], LIBRARY[A], LIBRARY[M]]));
  assetsApi.fetchFacets.mockResolvedValue(facets);
  edits.saveEdit.mockImplementation(async (_id: string, request: { sequence: EditDocument["sequence"] }) => doc({ updatedAt: 3000, sequence: request.sequence }));
  edits.revealEditsFolder.mockResolvedValue(undefined);
  recorded.listeners.clear();
  useStitchClipboard.getState().setClipboard(null);
});

afterEach(() => {
  act(() => editor().close());
  applyLibraryStatus(status(true));
  __setMediaExtractorForTests(null);
  vi.restoreAllMocks();
});

describe("the home screen", () => {
  it("lists the edits as rows, with New edit and Show in Finder; focus starts on the newest row", async () => {
    const other = doc({ id: OTHER, name: "Launch cut", updatedAt: 5000 });
    await renderHome(listOf([other, doc()]));
    const list = screen.getByRole("list", { name: "Edits" });
    const rows = within(list).getAllByRole("button", { name: /^Open / });
    expect(rows.map((c) => c.getAttribute("aria-label")?.split(",")[0])).toEqual(["Open Launch cut", "Open Trip"]);
    expect(rows[1]).toHaveAccessibleName(/^Open Trip, 2 clips, 0:10, edited /);
    expect(screen.getByRole("button", { name: "New edit" })).toBeEnabled();
    // Enter opens the newest
    expect(rows[0]).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Show in Finder" }));
    await waitFor(() => expect(edits.revealEditsFolder).toHaveBeenCalledTimes(1));
    fireEvent.click(rows[1]);
    await waitFor(() => expect(edits.fetchEdit).toHaveBeenCalledWith(ID));
  });

  it("says when there are no edits, while the list loads, and when it fails", async () => {
    const view = await renderHome();
    expect(screen.queryByRole("list", { name: "Edits" })).toBeNull();
    expect(screen.getByText("An edit puts videos and audio from any project on one timeline.")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "New edit" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "New edit" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Show in Finder" })).toBeInTheDocument();
    view.unmount();

    __resetEditProjectForTests();
    edits.fetchEditList.mockReturnValue(new Promise(() => {}));
    const loading = render(<EditVideoView />);
    expect(document.querySelector('[aria-busy="true"], [aria-busy]')).not.toBeNull();
    loading.unmount();

    __resetEditProjectForTests();
    edits.fetchEditList.mockRejectedValueOnce(new Error("The library could not be read")).mockResolvedValue(listOf([doc()]));
    render(<EditVideoView />);
    await screen.findByText("The library could not be read");
    expect(screen.getByRole("button", { name: "New edit" })).toHaveFocus();
    const again = screen.getByRole("button", { name: "Try again" });
    act(() => again.focus());
    fireEvent.click(again);
    // Try again goes with the message; focus goes to the edit it found
    await waitFor(() => expect(screen.getByRole("button", { name: /^Open Trip/ })).toHaveFocus());
  });

  it("with the library off, says so and offers neither New edit nor Show in Finder", async () => {
    applyLibraryStatus(status(false));
    await renderHome();
    expect(screen.getByText(/The asset library is off/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show in Finder" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "New edit" }) ?? { disabled: true }).toHaveProperty("disabled", true);
  });

  it("lists the files it cannot open, and makes a Finder copy a separate edit", async () => {
    edits.createEdit.mockResolvedValue(doc({ id: OTHER, name: "Trip copy" }));
    await renderHome(
      listOf([doc()], [
        { fileName: "Trip copy.nbedit", problem: "duplicate", name: "Trip" },
        { fileName: "Broken.nbedit", problem: "unreadable", name: null },
        { fileName: "Future.nbedit", problem: "newer", name: "Future" },
      ]),
    );
    expect(screen.getByText("Trip copy.nbedit is a copy of “Trip”")).toBeInTheDocument();
    expect(screen.getByText("Couldn't read Broken.nbedit")).toBeInTheDocument();
    expect(screen.getByText("Future.nbedit was made by a newer Node Banana")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Make it a separate edit" }));
    await waitFor(() => expect(edits.createEdit).toHaveBeenCalledWith({ separate: "Trip copy.nbedit" }));
  });

  it("New edit opens an Untitled edit with the editor and the library", async () => {
    edits.createEdit.mockResolvedValue(doc({ name: "Untitled edit", sequence: { ...doc().sequence, timeline: [] } }));
    await renderHome();
    fireEvent.click(screen.getByRole("button", { name: "New edit" }));
    await screen.findByRole("button", { name: "Edit menu" });
    expect(screen.getByRole("button", { name: "Untitled edit" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Library" })).toBeInTheDocument();
    expect(editor().editId).toBe(ID);
    expect(screen.getByTestId("edit-save-state")).toHaveTextContent("Saved");
  });
});

describe("the open edit", () => {
  it("renames in place: Enter commits, Escape puts the name back, a taken name keeps the field with a note", async () => {
    await renderOpen();
    edits.patchEdit.mockResolvedValueOnce({ document: doc({ name: "Launch cut", updatedAt: 2500 }), previousUpdatedAt: 2000 });
    fireEvent.click(screen.getByRole("button", { name: "Trip" }));
    const field = await screen.findByRole("textbox", { name: "Edit name" });
    fireEvent.change(field, { target: { value: "Launch cut" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await screen.findByRole("button", { name: "Launch cut" });
    expect(edits.patchEdit).toHaveBeenCalledWith(ID, { op: "rename", name: "Launch cut" });

    fireEvent.click(screen.getByRole("button", { name: "Launch cut" }));
    const again = await screen.findByRole("textbox", { name: "Edit name" });
    fireEvent.change(again, { target: { value: "Something else" } });
    fireEvent.keyDown(again, { key: "Escape" });
    expect(screen.getByRole("button", { name: "Launch cut" })).toBeInTheDocument();
    expect(edits.patchEdit).toHaveBeenCalledTimes(1);

    edits.patchEdit.mockRejectedValueOnce(new EditApiError("taken", 409, "name_taken"));
    fireEvent.click(screen.getByRole("button", { name: "Launch cut" }));
    const third = await screen.findByRole("textbox", { name: "Edit name" });
    fireEvent.change(third, { target: { value: "Other" } });
    fireEvent.keyDown(third, { key: "Enter" });
    await screen.findByText("Another edit has that name");
    expect(screen.getByRole("textbox", { name: "Edit name" })).toBeInTheDocument();
  });

  it("names a clip the library lost from the edit's file", async () => {
    assetsApi.fetchAsset.mockImplementation(async (id: string) => (id === A ? null : (LIBRARY[id] ?? null)));
    await renderOpen();
    act(() => editor().select({ kind: "clip", clipId: "v1" }));
    await screen.findByText("Not in the library · sunset.mp4");
    const slot = screen.getByTestId("edit-render-slot");
    expect(slot).toHaveTextContent("Clip 1's video is no longer in the library");
    expect(within(slot).getByRole("button", { name: "Render" })).toBeDisabled();
  });

  it("puts the controls in one row under the video, which drops Fit, then − and +, when narrow", async () => {
    measure(A, B);
    await renderOpen();
    expect(screen.queryByRole("slider", { name: "Timeline zoom" })).toBeNull();
    const row = screen.getByTestId("stitch-controls");
    expect(row.parentElement!.className).toContain("@container");
    expect(screen.getByTestId("stitch-stage-column")).toContainElement(row);
    // Time | start, play, end | the rest, in the boards' order
    const [time, middle, right] = [...row.children] as HTMLElement[];
    expect(time).toHaveTextContent("0:00.00 / 0:10.00");
    expect(within(middle).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Go to start", "Play", "Go to end"]);
    expect(within(right).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual([
      "Frame to canvas",
      "Mute all",
      "Track",
      "Stacked",
      "Snap",
      "Zoom out",
      "Zoom in",
      "Fit",
    ]);
    expect(screen.getByRole("button", { name: "Fit" }).parentElement!.className).toContain("@max-[695px]:hidden");
    for (const name of ["Zoom out", "Zoom in"]) {
      expect(screen.getByRole("button", { name }).parentElement!.className).toContain("@max-[628px]:hidden");
    }
    // Track and Stacked are the row's own buttons, pressed as Snap is, with no ground of their own
    const layout = screen.getByRole("group", { name: "Timeline layout" });
    expect(layout).not.toHaveClass("bg-edit-field");
    expect(within(layout).getByRole("button", { name: "Track" })).toHaveClass("aria-pressed:bg-edit-pressed");
  });

  it("mutes the preview from the control row, and shows Snap pressed while on", async () => {
    measure(A, B);
    await renderOpen();
    const mute = screen.getByRole("button", { name: "Mute all" });
    expect(mute).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(mute);
    expect(editor().soundOn).toBe(false);
    expect(mute).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(mute);
    expect(editor().soundOn).toBe(true);
    // The preview's sound is no edit
    expect(editor().past).toHaveLength(0);
    // Snap is on by default: a press turns it off and the next on again, and neither is an edit
    const snap = screen.getByRole("button", { name: "Snap" });
    expect(editor().snap).toBe(true);
    expect(snap).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(snap);
    expect(editor().snap).toBe(false);
    expect(snap).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(snap);
    expect(editor().snap).toBe(true);
    expect(snap).toHaveAttribute("aria-pressed", "true");
    expect(editor().past).toHaveLength(0);
  });

  it("keeps the rail's column with nothing selected, and leaves Library out of a clip's source", async () => {
    measure(A, B);
    await renderOpen();
    act(() => editor().select(null));
    const rail = screen.getByRole("complementary", { name: "Clip" });
    expect(rail).toHaveClass("w-[280px]", "border-l", "border-edit-line");
    expect(within(rail).getByText("Select a clip to edit it.")).toBeInTheDocument();
    act(() => editor().select({ kind: "clip", clipId: "v2" }));
    expect(within(rail).getByText("Clip 2 of 2")).toBeInTheDocument();
    // Every clip of an edit is the library's: the line is its model and length
    expect(within(rail).getByText("Veo 3.1 · 5.00 s")).toBeInTheDocument();
    // A trim shows as the part of the file kept, and Reset trim only then
    expect(within(rail).queryByRole("button", { name: "Reset trim" })).toBeNull();
    act(() => editor().apply((d) => ({ ...d, timeline: d.timeline.map((c) => (c.id === "v2" ? { ...c, inSec: 1 } : c)) })));
    expect(within(rail).getByText("Veo 3.1 · 4.00 s of 5.00 s")).toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: "Reset trim" })).toBeEnabled();
    // The editor sits on the pane, as the header does
    expect(screen.getByRole("button", { name: "Mute all" }).closest("[data-stitch-editor]")).toHaveClass("bg-pane");
  });

  it("asks for a clip's record again when its file can't be read, and holds Render back either way", async () => {
    const unreadable = () => Promise.reject(new Error("404"));
    __setMediaExtractorForTests({ probe: unreadable, open: unreadable });
    measure(B);
    // The record was read before the file went: it says the file is there until it is read again
    let reads = 0;
    assetsApi.fetchAsset.mockImplementation(async (id: string) =>
      id === A ? { ...LIBRARY[A], missing: ++reads > 1 } : (LIBRARY[id] ?? null),
    );
    await renderOpen();
    act(() => editor().select({ kind: "clip", clipId: "v1" }));
    await screen.findByText("Not in the library · sunset.mp4");
    expect(reads).toBe(2);
    const slot = screen.getByTestId("edit-render-slot");
    expect(slot).toHaveTextContent("Clip 1's video is no longer in the library");
    expect(within(slot).getByRole("button", { name: "Render" })).toBeDisabled();
  });

  it("holds Render back for a file that is there but can't be read", async () => {
    const unreadable = () => Promise.reject(new Error("Not a video"));
    __setMediaExtractorForTests({ probe: unreadable, open: unreadable });
    measure(B);
    await renderOpen();
    const slot = screen.getByTestId("edit-render-slot");
    await waitFor(() => expect(slot).toHaveTextContent("Clip 1's video can't be read"));
    expect(within(slot).getByRole("button", { name: "Render" })).toBeDisabled();
    // Asked about once more, not in a loop
    expect(assetsApi.fetchAsset.mock.calls.filter(([id]) => id === A)).toHaveLength(2);
  });

  it("Render runs with one clip, is held back with none, and Stop replaces it while rendering", async () => {
    const one = doc({ sequence: { ...doc().sequence, timeline: [createClip({ kind: "asset", assetId: A }, { id: "v1" })] } });
    measure(A);
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
    );
    const view = await renderOpen(one);
    const slot = screen.getByTestId("edit-render-slot");
    await waitFor(() => expect(within(slot).getByRole("button", { name: "Render" })).toBeEnabled());
    fireEvent.click(within(slot).getByRole("button", { name: "Render" }));
    await waitFor(() => expect(project().render.state).toBe("rendering"));
    const stop = await screen.findByRole("button", { name: "Stop" });
    expect(screen.queryByTestId("edit-render-slot")).toBeNull();
    fireEvent.click(stop);
    await waitFor(() => expect(project().render.state).toBe("idle"));
    await screen.findByTestId("edit-render-slot");
    view.unmount();
    act(() => editor().close());
    __resetEditProjectForTests();

    await renderOpen(doc({ sequence: { ...doc().sequence, timeline: [] } }));
    const empty = screen.getByTestId("edit-render-slot");
    await waitFor(() => expect(empty).toHaveTextContent("Add a clip to render"));
    expect(within(empty).getByRole("button", { name: "Render" })).toBeDisabled();
  });

  it("holds Render back while another edit renders", async () => {
    measure(A, B);
    await renderOpen();
    act(() => project().setRenderState({ state: "rendering", editId: OTHER, progress: 40 }));
    const slot = screen.getByTestId("edit-render-slot");
    expect(slot).toHaveTextContent("Another edit is rendering");
    expect(within(slot).getByRole("button", { name: "Render" })).toBeDisabled();
  });

  it("shows how saving stands: Saving…, Saved, Waiting…, Save failed, with the banners' choices", async () => {
    await renderOpen();
    const word = () => screen.getByTestId("edit-save-state");
    expect(word()).toHaveTextContent("Saved");
    act(() => setLoopCount(2));
    expect(word()).toHaveTextContent("Unsaved");

    let answer!: (value: EditDocument) => void;
    edits.saveEdit.mockReturnValueOnce(new Promise<EditDocument>((resolve) => (answer = resolve)));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(word()).toHaveTextContent("Saving…"));
    await act(async () => answer(doc({ updatedAt: 3000 })));
    expect(word()).toHaveTextContent("Saved");

    act(() => setLoopCount(3));
    edits.saveEdit.mockRejectedValueOnce(new EditApiError("paused", 503, "paused", undefined, 5000));
    await act(async () => void (await project().saveNow("manual")));
    expect(word()).toHaveTextContent("Waiting…");
    expect(screen.getByRole("alert")).toHaveTextContent("The library is moving. Saving resumes when it finishes.");

    edits.saveEdit.mockRejectedValueOnce(new EditApiError("disk full", 500));
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(word()).toHaveTextContent("Save failed"));
    expect(screen.getByRole("alert")).toHaveTextContent("Save failed: disk full");
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(word()).toHaveTextContent("Saved"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a conflict offers Keep mine and Use the other version; a gone edit offers Save as a new edit", async () => {
    await renderOpen();
    act(() => setLoopCount(2));
    edits.saveEdit.mockRejectedValueOnce(new EditApiError("conflict", 409, "conflict", doc({ updatedAt: 9000 })));
    await act(async () => void (await project().saveNow("manual")));
    expect(screen.getByTestId("edit-save-state")).toHaveTextContent("Changed elsewhere");
    const banner = screen.getByRole("alert");
    expect(banner).toHaveTextContent("This edit was changed in another window.");
    expect(within(banner).getAllByRole("button").map((b) => b.textContent)).toEqual(["Keep mine", "Use the other version"]);
    fireEvent.click(within(banner).getByRole("button", { name: "Keep mine" }));
    await waitFor(() => expect(edits.saveEdit).toHaveBeenLastCalledWith(ID, expect.objectContaining({ force: true })));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());

    act(() => setLoopCount(3));
    edits.saveEdit.mockRejectedValueOnce(new EditApiError("gone", 404, "not_found"));
    await act(async () => void (await project().saveNow("manual")));
    expect(screen.getByTestId("edit-save-state")).toHaveTextContent("Not in Edits");
    expect(screen.getByRole("alert")).toHaveTextContent("This edit is no longer in the Edits folder.");
    edits.createEdit.mockResolvedValueOnce(doc({ id: OTHER, updatedAt: 4000 }));
    fireEvent.click(screen.getByRole("button", { name: "Save as a new edit" }));
    await waitFor(() => expect(editor().editId).toBe(OTHER));
    expect(screen.getByTestId("edit-save-state")).toHaveTextContent("Saved");
  });

  it("⌘S saves the edit, never the workflow, before the canvas's listener hears it", async () => {
    await renderOpen();
    const canvasListener = vi.fn();
    window.addEventListener("keydown", canvasListener);
    try {
      act(() => setLoopCount(2));
      const event = press(document.body, "s", { metaKey: true });
      expect(event.defaultPrevented).toBe(true);
      await waitFor(() => expect(edits.saveEdit).toHaveBeenCalledTimes(1));
      expect(canvasListener).not.toHaveBeenCalled();
      expect(useSaveRequestStore.getState().request).toBeNull();
      // The agent's save_workflow asks the floating menu; the view leaves that request alone
      act(() => requestSave("menu", "From the agent"));
      expect(useSaveRequestStore.getState().request).toMatchObject({ reason: "menu", name: "From the agent" });
    } finally {
      window.removeEventListener("keydown", canvasListener);
    }
  });

  it("⌘S on the home screen is kept from the browser and saves nothing", async () => {
    await renderHome(listOf([doc()]));
    const canvasListener = vi.fn();
    window.addEventListener("keydown", canvasListener);
    try {
      const event = press(document.body, "s", { ctrlKey: true });
      expect(event.defaultPrevented).toBe(true);
      expect(canvasListener).not.toHaveBeenCalled();
      expect(edits.saveEdit).not.toHaveBeenCalled();
      expect(useSaveRequestStore.getState().request).toBeNull();
    } finally {
      window.removeEventListener("keydown", canvasListener);
    }
  });
});

describe("keys", () => {
  it("the header's menu, the library's filters and their project menu own Escape, Space, ⌫ and S while open", async () => {
    measure(A, B);
    await renderOpen();
    act(() => {
      editor().select({ kind: "clip", clipId: "v1" });
      editor().setPlayhead(2);
    });
    const draft = editor().draft;
    const selection = editor().selection;

    for (const open of [
      () => fireEvent.click(screen.getByRole("button", { name: "Edit menu" })),
      () => {
        fireEvent.click(screen.getByRole("button", { name: "Filter and sort" }));
        fireEvent.click(screen.getByRole("button", { name: "Project: All projects" }));
      },
    ]) {
      open();
      const menu = await screen.findByRole("menu");
      const item = menu.querySelector<HTMLElement>('[role^="menuitem"]')!;
      for (const key of [" ", "Backspace", "s"]) {
        const event = press(item, key);
        expect(event.defaultPrevented).toBe(false);
      }
      expect(editor().draft).toBe(draft);
      expect(editor().playing).toBe(false);
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
      expect(screen.queryByRole("menu")).toBeNull();
      expect(editor().draft).toBe(draft);
      expect(editor().selection).toBe(selection);
      expect(editor().playing).toBe(false);
    }

    // The project menu's Escape closed only it: the filters are still open, and own the keys too. Space is the
    // switch's (a browser turns it into a click), not Play
    const filters = screen.getByRole("dialog", { name: "Filter and sort" });
    const favourites = within(filters).getByRole("switch", { name: "Favorites" });
    favourites.focus();
    for (const key of [" ", "Backspace", "s"]) {
      const event = press(favourites, key);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(editor().draft).toBe(draft);
    expect(editor().playing).toBe(false);
    fireEvent.keyDown(favourites, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Filter and sort" })).toBeNull();
    expect(screen.getByRole("button", { name: "Filter and sort" })).toHaveFocus();
    expect(editor().selection).toBe(selection);
    act(() => (document.activeElement as HTMLElement | null)?.blur());

    // All closed: the editor's keys work again
    press(document.body, "s");
    expect(editor().draft!.timeline).toHaveLength(3);
    press(document.body, "Backspace");
    expect(editor().draft!.timeline).toHaveLength(2);
  });

  it("E, A, C and ? from the open edit; not while typing in the search, nor mid-drag", async () => {
    measure(A, B);
    await renderOpen();
    press(document.body, "?", { shiftKey: true });
    expect(useWorkflowStore.getState().shortcutsDialogOpen).toBe(true);

    const search = screen.getByRole("textbox", { name: "Search the library" });
    search.focus();
    press(search, "e");
    expect(useAssetStore.getState().appView).toBe("edit");
    // Escape leaves the field, and E is the view's again
    press(search, "Escape");
    expect(search).not.toHaveFocus();
    press(document.body, "e");
    expect(useAssetStore.getState().appView).toBe("canvas");
    act(() => useAssetStore.setState({ appView: "edit" }));

    // Mid-drag the view keys are swallowed (and no home-screen listener is there to hear them)
    fireEvent.pointerDown(tile(C), { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(tile(C), { pointerId: 1, clientX: 40, clientY: 10 });
    expect(editor().cancelGesture).not.toBeNull();
    press(document.body, "a");
    expect(useAssetStore.getState().appView).toBe("edit");
    press(document.body, "Escape");
    expect(editor().cancelGesture).toBeNull();

    for (const [key, view] of [["a", "assets"], ["c", "chat"], ["e", "canvas"]] as const) {
      act(() => useAssetStore.setState({ appView: "edit" }));
      press(document.body, key);
      expect(useAssetStore.getState().appView).toBe(view);
    }
  });

  it("on the home screen, E, A, C and ? are the view's own listener's", async () => {
    await renderHome(listOf([doc()]));
    press(document.body, "a");
    expect(useAssetStore.getState().appView).toBe("assets");
    act(() => useAssetStore.setState({ appView: "edit" }));
    press(document.body, "e", { repeat: true });
    expect(useAssetStore.getState().appView).toBe("edit");
    press(document.body, "e");
    expect(useAssetStore.getState().appView).toBe("canvas");
    act(() => useAssetStore.setState({ appView: "edit" }));
    press(document.body, "?", { shiftKey: true });
    expect(useWorkflowStore.getState().shortcutsDialogOpen).toBe(true);
  });

  it("the timeline's + focuses the library's search; the audio + also shows Audio", async () => {
    await renderOpen();
    act(() => useEditProjectStore.getState().setPaneKind("all"));
    expect(screen.getByRole("button", { name: "Filter and sort" })).not.toHaveAttribute("data-filtered");
    fireEvent.click(screen.getAllByRole("button", { name: "Add a clip from the library" })[0]);
    expect(screen.getByRole("textbox", { name: "Search the library" })).toHaveFocus();
    expect(editor().pickerOpen).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /Add audio/ }));
    expect(screen.getByRole("textbox", { name: "Search the library" })).toHaveFocus();
    // The kind is in the filters, whose button says something is set
    expect(screen.getByRole("button", { name: "Filter and sort" })).toHaveAttribute("data-filtered", "true");
    fireEvent.click(screen.getByRole("button", { name: "Filter and sort" }));
    expect(screen.getByRole("radio", { name: "Audio" })).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Filter and sort" })).toBeNull();

    // Hidden and shown again from the header: the earlier + is spent, so Space still plays
    fireEvent.click(screen.getByRole("button", { name: "Hide the library" }));
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    fireEvent.click(screen.getByRole("button", { name: "Show the library" }));
    expect(screen.getByRole("textbox", { name: "Search the library" })).not.toHaveFocus();
    fireEvent.click(screen.getAllByRole("button", { name: "Add a clip from the library" })[0]);
    expect(screen.getByRole("textbox", { name: "Search the library" })).toHaveFocus();
  });
});

describe("adding from the library", () => {
  it("a click adds at the playhead as one undo step: in Track after the clip under it", async () => {
    measure(A, B);
    await renderOpen();
    act(() => editor().setPlayhead(2));
    const past = editor().past.length;
    fireEvent.click(tile(C));
    expect(timelineIds()).toEqual([A, C, B]);
    expect(editor().past.length).toBe(past + 1);
    const added = editor().draft!.timeline[1].id;
    expect(editor().selection).toMatchObject({ kind: "clip", clipId: added });
    expect(editor().playhead).toBe(5);
  });

  it("in Stacked, a click puts a new row at the playhead with every other clip pinned", async () => {
    measure(A, B);
    await renderOpen(doc({}, "stacked"));
    act(() => editor().setPlayhead(2));
    fireEvent.click(tile(C));
    const timeline = editor().draft!.timeline;
    expect(timeline.map((c) => c.startSec)).toEqual([0, 4.5, 2]);
    expect(timelineIds()).toEqual([A, B, C]);
  });

  it("Enter on a focused tile is left to the button; Space plays and adds nothing", async () => {
    measure(A, B);
    await renderOpen();
    const target = tile(C);
    target.focus();
    const space = press(target, " ");
    expect(space.defaultPrevented).toBe(true);
    expect(editor().playing).toBe(true);
    expect(editor().draft!.timeline).toHaveLength(2);
    act(() => editor().setPlaying(false));
    const enter = press(target, "Enter");
    expect(enter.defaultPrevented).toBe(false);
    // A real button: the browser turns that Enter into a click, which adds
    expect(target.tagName).toBe("BUTTON");
    expect(target).toHaveAttribute("type", "button");
    fireEvent.click(target);
    expect(editor().draft!.timeline).toHaveLength(3);
  });

  it("one drop adds once: the marker shows where, release adds, the click after it adds nothing", async () => {
    measure(A, B);
    await renderOpen();
    // jsdom lays nothing out: the lanes' probe answers as the Timeline would over clip 2
    const unregister = libraryDrop.register(() => ({ lane: "clips", mode: "track", index: 1 }), () => null);
    try {
      const target = tile(C);
      const order = tileIds();
      const past = editor().past.length;
      fireEvent.pointerDown(target, { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(target, { pointerId: 1, clientX: 12, clientY: 11 });
      expect(screen.queryByTestId("library-drop-marker")).toBeNull();
      fireEvent.pointerMove(target, { pointerId: 1, clientX: 60, clientY: 300 });
      expect(screen.getByTestId("library-drop-marker")).toBeInTheDocument();
      // The ghost is the tile lifted: its cover and its length, no name
      const ghost = screen.getByTestId("library-drag-ghost");
      expect(ghost.querySelector("img")).toHaveAttribute("src", expect.stringContaining(LIBRARY[C].sha256));
      expect(ghost).toHaveTextContent(/^0:05$/);
      expect(editor().draft!.timeline).toHaveLength(2);
      fireEvent.pointerUp(target, { pointerId: 1, clientX: 60, clientY: 300 });
      fireEvent.click(target);
      expect(editor().past.length).toBe(past + 1);
      expect(timelineIds()).toEqual([A, C, B]);
      expect(screen.queryByTestId("library-drop-marker")).toBeNull();
      // The tile is the same element in the same place in the list (its box is the browser checks' to measure)
      expect(tile(C)).toBe(target);
      expect(tileIds()).toEqual(order);

      // Escape mid-drag: nothing added, and the click after the release adds nothing either
      fireEvent.pointerDown(target, { button: 0, pointerId: 2, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(target, { pointerId: 2, clientX: 60, clientY: 300 });
      expect(screen.getByTestId("library-drop-marker")).toBeInTheDocument();
      press(document.body, "Escape");
      expect(screen.queryByTestId("library-drop-marker")).toBeNull();
      fireEvent.pointerUp(target, { pointerId: 2, clientX: 60, clientY: 300 });
      fireEvent.click(target);
      expect(editor().past.length).toBe(past + 1);
      expect(editor().draft!.timeline).toHaveLength(3);
    } finally {
      unregister();
    }
  });

  it("a Stacked add waits while a clip is still loading, then adds a pinned row", async () => {
    measure(A);
    await renderOpen(doc({}, "stacked"));
    await waitFor(() => expect(tile(C)).toHaveAttribute("aria-disabled", "true"));
    expect(tile(C)).toHaveAttribute("title", "desert.mp4\nWaiting for the clips to load");
    // Audio never waits
    expect(tile(M)).not.toHaveAttribute("aria-disabled");
    fireEvent.click(tile(C));
    expect(editor().draft!.timeline).toHaveLength(2);
    expect(editor().draft!.timeline.every((c) => c.startSec === undefined)).toBe(true);
    // Dragged over the lanes, the ghost says why it cannot land
    const unregister = libraryDrop.register(() => ({ lane: "clips", mode: "stacked", startSec: 1, row: 2 }), () => null);
    try {
      fireEvent.pointerDown(tile(C), { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(tile(C), { pointerId: 1, clientX: 60, clientY: 300 });
      expect(screen.getByTestId("library-drag-ghost")).toHaveTextContent("0:05Waiting for the clips to load");
      expect(screen.queryByTestId("library-drop-marker")).toBeNull();
      press(document.body, "Escape");
      fireEvent.pointerUp(tile(C), { pointerId: 1, clientX: 60, clientY: 300 });
      expect(screen.queryByTestId("library-drag-ghost")).toBeNull();
    } finally {
      unregister();
    }

    act(() => measure(B));
    await waitFor(() => expect(tile(C)).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(tile(C));
    expect(editor().draft!.timeline.map((c) => c.startSec)).toEqual([0, 4.5, 0]);
  });

  it("a sound's ghost is its row: the music glyph, its name and length, no picture", async () => {
    measure(A, B);
    await renderOpen();
    const unregister = libraryDrop.register(() => ({ lane: "audio", startSec: 1, row: 0, newRow: true }), () => null);
    try {
      fireEvent.pointerDown(tile(M), { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(tile(M), { pointerId: 1, clientX: 60, clientY: 300 });
      const ghost = screen.getByTestId("library-drag-ghost");
      expect(ghost).toHaveTextContent(/^music\.m4a0:20$/);
      expect(ghost.querySelector("img")).toBeNull();
      expect(ghost.querySelector("svg")).not.toBeNull();
      press(document.body, "Escape");
      fireEvent.pointerUp(tile(M), { pointerId: 1, clientX: 60, clientY: 300 });
      expect(editor().draft!.audioClips).toHaveLength(0);
    } finally {
      unregister();
    }
  });

  it("holds new recordings behind “1 new · Show”, so no tile moves under a press", async () => {
    measure(A, B);
    await renderOpen();
    const order = tileIds();
    fireEvent.pointerDown(tile(B), { button: 0, pointerId: 1, clientX: 10, clientY: 10 });
    const fresh = asset("anewvideoaaaa1", { filename: "fresh.mp4" });
    act(() => {
      for (const listener of recorded.listeners) listener({ asset: fresh });
    });
    expect(tileIds()).toEqual(order);
    expect(screen.getByRole("button", { name: "1 new · Show" })).toBeInTheDocument();
    fireEvent.pointerUp(tile(B), { pointerId: 1, clientX: 10, clientY: 10 });

    assetsApi.fetchAssetPage.mockResolvedValue(page([fresh, LIBRARY[C], LIBRARY[B], LIBRARY[A], LIBRARY[M]]));
    fireEvent.click(screen.getByRole("button", { name: "1 new · Show" }));
    await waitFor(() => expect(tileIds()[0]).toBe(fresh.id));
    expect(screen.queryByRole("button", { name: /new · Show/ })).toBeNull();
  });
});

describe("the library pane", () => {
  const lastRequest = () => assetsApi.fetchAssetPage.mock.calls[assetsApi.fetchAssetPage.mock.calls.length - 1][0];
  const desert = { id: "wf_2", name: "Desert", projectPath: "/Users/me/Node Banana/Desert spots" };

  it("groups the library by project: covers, then sounds as rows, each tile's tooltip saying how to add it", async () => {
    assetsApi.fetchAssetPage.mockResolvedValue(page([asset(C, { filename: "desert.mp4", workflow: desert }), LIBRARY[B], LIBRARY[A], LIBRARY[M]]));
    await renderOpen();
    const pane = screen.getByRole("complementary", { name: "Library" });
    expect(within(pane).getByRole("heading", { level: 2, name: "Library" })).toBeInTheDocument();
    expect(lastRequest()).toEqual({ kinds: ["video", "audio"], limit: 60 });
    expect(within(pane).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Desert spots", "Launch film"]);
    const launch = within(pane).getByRole("group", { name: "Launch film" });
    expect([...launch.querySelectorAll<HTMLElement>("[data-asset-id]")].map((el) => el.dataset.assetId)).toEqual([B, A, M]);
    // A cover shows its length alone; a sound is a row with its name and length
    expect(tile(C)).toHaveTextContent(/^0:05$/);
    expect(tile(M)).toHaveTextContent("music.m4a0:20");
    expect(tile(C)).toHaveAccessibleName("Add desert.mp4, 0:05.0, Desert spots, at the playhead");
    expect(tile(C)).toHaveAttribute("title", "desert.mp4\nClick to add at the playhead, or drag onto the timeline.");
    // The hint is the tiles' tooltip now, not a line under the list
    expect(within(pane).queryByText("Click to add at the playhead, or drag onto the timeline.")).toBeNull();
  });

  it("keeps kind, project, favourites and sort in the search's filter popover, and dots its button while one is set", async () => {
    await renderOpen();
    const button = () => screen.getByRole("button", { name: "Filter and sort" });
    expect(button()).not.toHaveAttribute("data-filtered");
    fireEvent.click(button());
    const filters = screen.getByRole("dialog", { name: "Filter and sort" });
    // Focus starts on the kind's choice
    expect(within(filters).getByRole("radio", { name: "All" })).toHaveFocus();
    expect(within(filters).getByRole("button", { name: "Project: All projects" })).toBeInTheDocument();
    fireEvent.click(within(filters).getByRole("radio", { name: "Video" }));
    await waitFor(() => expect(lastRequest()).toMatchObject({ kinds: ["video"] }));
    expect(project().pane.kind).toBe("video");
    expect(button()).toHaveAttribute("data-filtered", "true");
    fireEvent.keyDown(within(filters).getByRole("radio", { name: "Video" }), { key: "ArrowRight" });
    await waitFor(() => expect(lastRequest()).toMatchObject({ kinds: ["audio"] }));
    expect(within(filters).getByRole("radio", { name: "Audio" })).toHaveFocus();
    fireEvent.click(within(filters).getByRole("switch", { name: "Favorites" }));
    await waitFor(() => expect(lastRequest()).toMatchObject({ kinds: ["audio"], favorite: true }));
    fireEvent.click(within(filters).getByRole("radio", { name: "Oldest" }));
    await waitFor(() => expect(lastRequest()).toMatchObject({ favorite: true, sort: "oldest" }));
    // A press outside closes it; the settings stay, and so does the dot
    fireEvent.pointerDown(screen.getByTestId("edit-library-grid"));
    expect(screen.queryByRole("dialog", { name: "Filter and sort" })).toBeNull();
    expect(button()).toHaveAttribute("data-filtered", "true");
    expect(button()).toHaveAccessibleDescription("Filters are on");
    fireEvent.click(button());
    expect(screen.getByRole("switch", { name: "Favorites" })).toHaveAttribute("aria-checked", "true");
  });

  it("never leaves its filters open with focus elsewhere, where they would keep the editor's keys", async () => {
    measure(A, B);
    await renderOpen();
    const button = () => screen.getByRole("button", { name: "Filter and sort" });
    const filters = () => screen.queryByRole("dialog", { name: "Filter and sort" });

    // A press on a row's label focuses the popover itself (nothing around it in the view could take focus, so a
    // browser would leave it on the page, out of reach of the popover's Escape)
    fireEvent.click(button());
    pressAt(within(filters()!).getByText("Kind"));
    expect(filters()).toHaveFocus();
    fireEvent.keyDown(filters()!, { key: "Escape" });
    expect(filters()).toBeNull();
    expect(button()).toHaveFocus();

    // Shift+Tab out of it: to its button (still open), then on to the search, which closes it
    fireEvent.click(button());
    act(() => button().focus());
    expect(filters()).not.toBeNull();
    const search = screen.getByRole("textbox", { name: "Search the library" });
    act(() => search.focus());
    expect(filters()).toBeNull();
    // Escape leaves the field, and the editor's keys are back
    press(search, "Escape");
    press(document.body, " ");
    expect(editor().playing).toBe(true);
    act(() => editor().setPlaying(false));

    // Tab on from it to a tile
    fireEvent.click(button());
    expect(within(filters()!).getByRole("radio", { name: "All" })).toHaveFocus();
    act(() => tile(C).focus());
    expect(filters()).toBeNull();

    // The library going off closes it, and it does not come back with the library, nor take focus
    fireEvent.click(button());
    act(() => applyLibraryStatus(status(false)));
    expect(filters()).toBeNull();
    act(() => applyLibraryStatus(status(true)));
    expect(filters()).toBeNull();
    expect(button()).toHaveAttribute("aria-expanded", "false");
  });

  it("says when the library is empty, when nothing matches, and when it can't be read", async () => {
    assetsApi.fetchAssetPage.mockResolvedValue(page([]));
    storage[LAST_EDIT_KEY] = ID;
    edits.fetchEdit.mockResolvedValue(doc());
    edits.fetchEditList.mockResolvedValue(listOf([doc()]));
    render(<EditVideoView />);
    expect(await screen.findByText("Nothing in the library yet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Filter and sort" }));
    fireEvent.click(screen.getByRole("switch", { name: "Favorites" }));
    expect(await screen.findByText("No videos or audio match")).toBeInTheDocument();
    assetsApi.fetchAssetPage.mockRejectedValueOnce(new Error("The library is moving."));
    fireEvent.click(screen.getByRole("switch", { name: "Favorites" }));
    expect(await screen.findByText("The library is moving.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Nothing in the library yet")).toBeInTheDocument();
  });

  it("with the library off, says so and turns its search and filters off", async () => {
    await renderOpen();
    act(() => applyLibraryStatus(status(false)));
    const pane = screen.getByRole("complementary", { name: "Library" });
    expect(within(pane).getByText("The asset library is off.")).toBeInTheDocument();
    expect(within(pane).getByRole("textbox", { name: "Search the library" })).toBeDisabled();
    expect(within(pane).getByRole("button", { name: "Filter and sort" })).toBeDisabled();
  });
});

describe("copy, cut and paste", () => {
  it("⌘C and ⌘V copy a clip and paste it after the selection, ⌘X cuts, each one undo step", async () => {
    measure(A, B);
    await renderOpen();
    act(() => editor().select({ kind: "clip", clipId: "v1" }));
    press(document.body, "c", { metaKey: true });
    expect(useStitchClipboard.getState().clipboard).toMatchObject({ origin: { kind: "edit", editId: ID }, items: [{ source: { kind: "asset", assetId: A } }] });
    const past = editor().past.length;
    press(document.body, "v", { metaKey: true });
    expect(timelineIds()).toEqual([A, A, B]);
    expect(editor().past.length).toBe(past + 1);

    act(() => editor().select({ kind: "clip", clipId: "v2" }));
    press(document.body, "x", { metaKey: true });
    expect(timelineIds()).toEqual([A, A]);
    expect(editor().past.length).toBe(past + 2);
    expect(useStitchClipboard.getState().clipboard?.items).toMatchObject([{ source: { kind: "asset", assetId: B } }]);
    expect(toast).not.toHaveBeenCalled();
  });

  it("the clip menu's Copy, Cut and Paste work in the view", async () => {
    measure(A, B);
    await renderOpen();
    act(() => {
      editor().select({ kind: "clip", clipId: "v2" });
      editor().openMenu({ kind: "clip", clipId: "v2", x: 10, y: 10 });
    });
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: /^Copy/ }));
    act(() => editor().openMenu({ kind: "clip", clipId: "v1", x: 10, y: 10 }));
    act(() => editor().select({ kind: "clip", clipId: "v1" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: /^Paste/ }));
    expect(timelineIds()).toEqual([A, B, B]);
    act(() => editor().openMenu({ kind: "clip", clipId: "v1", x: 10, y: 10 }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: /^Cut/ }));
    expect(timelineIds()).toEqual([B, B]);
  });

  it("pastes a node's library clips into the edit and says why its connected videos were left out", async () => {
    measure(A, B);
    await renderOpen();
    act(() => {
      useStitchClipboard.getState().setClipboard({
        origin: { kind: "node", nodeId: "s1", tabId: "t1", workflowId: "w1" },
        items: [
          { track: "video", source: { kind: "edge", edgeId: "e1" }, inSec: 0, outSec: null, muted: false, volume: 1, offsetSec: 0 },
          { track: "video", source: { kind: "asset", assetId: C }, inSec: 1, outSec: 3, muted: false, volume: 1, offsetSec: 5 },
          { track: "video", source: { kind: "edge", edgeId: "e2" }, inSec: 0, outSec: null, muted: false, volume: 1, offsetSec: 7 },
        ],
      });
      editor().select({ kind: "clip", clipId: "v2" });
    });
    press(document.body, "v", { metaKey: true });
    expect(timelineIds()).toEqual([A, B, C]);
    expect(editor().draft!.timeline[2]).toMatchObject({ inSec: 1, outSec: 3 });
    expect(toast).toHaveBeenCalledWith(
      "2 clips not pasted: an edit holds only clips from the library, not connected videos or music.",
      "info",
    );
  });
});

describe("the header", () => {
  it("leads with Edits › the name: Edits goes home, the name renames, and the save word follows it", async () => {
    await renderOpen();
    const crumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumb).getAllByRole("button").map((b) => b.textContent)).toEqual(["Edits", "Trip"]);
    expect(crumb.nextElementSibling).toBe(screen.getByTestId("edit-save-state"));
    fireEvent.click(within(crumb).getByRole("button", { name: "Edits" }));
    await screen.findByRole("button", { name: "New edit" });
    expect(editor().isOpen).toBe(false);
    // Back home, focus is on the newest edit
    await waitFor(() => expect(screen.getByRole("button", { name: /^Open Trip/ })).toHaveFocus());
  });

  it("back home from an edit that was not the newest, once saved, starts on it as the list read again puts it first", async () => {
    const other = doc({ id: OTHER, name: "Launch cut", updatedAt: 5000 });
    storage[LAST_EDIT_KEY] = ID;
    edits.fetchEdit.mockResolvedValue(doc());
    edits.fetchEditList.mockResolvedValue(listOf([other, doc()]));
    render(<EditVideoView />);
    await screen.findByRole("button", { name: "Edit menu" });
    // Trip was saved since the list was read: the home shows the old list until the read on the way home lands
    let land!: (list: ReturnType<typeof listOf>) => void;
    edits.fetchEditList.mockReturnValue(new Promise((resolve) => (land = resolve)));
    fireEvent.click(within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole("button", { name: "Edits" }));
    await screen.findByRole("button", { name: "New edit" });
    expect(screen.getByRole("button", { name: /^Open Launch cut/ })).toHaveFocus();
    await act(async () => land(listOf([doc({ updatedAt: 9000 }), other])));
    const trip = screen.getByRole("button", { name: /^Open Trip/ });
    expect(trip).toHaveFocus();
    expect(trip.closest("li")).toHaveAttribute("data-active");
    expect(document.querySelector("[data-edit-preview]")).toHaveAttribute("data-edit-preview", ID);
  });

  it("shows Save only with Save automatically off; ⌘S saves either way", async () => {
    useWorkflowStore.setState({ autoSaveEnabled: true });
    await renderOpen();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByRole("button", { name: "Render" })).toBeInTheDocument();
    act(() => useWorkflowStore.setState({ autoSaveEnabled: false }));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    act(() => setLoopCount(2));
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("while rendering, Rendering N% and Stop take Save and Render's place, over a progress line", async () => {
    measure(A, B);
    await renderOpen();
    act(() => project().setRenderState({ state: "rendering", editId: ID, progress: 40.4 }));
    expect(screen.getByText("Rendering 40%")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Rendering" })).toHaveAttribute("aria-valuenow", "40");
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByTestId("edit-render-slot")).toBeNull();
    // Stop ends the header, where Render did
    expect(screen.getByRole("button", { name: "Stop" }).parentElement!.nextElementSibling).toBe(
      screen.getByRole("progressbar", { name: "Rendering" }),
    );
    act(() => project().setRenderState({ state: "idle", editId: null, progress: 0 }));
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByTestId("edit-render-slot")).toBeInTheDocument();
  });

  it("Show the library sits first while the pane is hidden", async () => {
    await renderOpen();
    expect(screen.queryByRole("button", { name: "Show the library" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Hide the library" }));
    const show = screen.getByRole("button", { name: "Show the library" });
    expect(show.closest("[data-edit-chrome]")!.firstElementChild!.contains(show)).toBe(true);
    fireEvent.click(show);
    expect(screen.getByRole("complementary", { name: "Library" })).toBeInTheDocument();
  });
});

describe("the edit menu", () => {
  it("holds Rename, Duplicate, Show in Finder, Loop and Delete…, then what the sequence is", async () => {
    measure(A, B);
    await renderOpen();
    fireEvent.click(screen.getByRole("button", { name: "Edit menu" }));
    const menu = screen.getByRole("menu", { name: "Edit menu" });
    const names = within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.getAttribute("aria-label") ?? item.textContent);
    // New edit and the other edits are on the home, behind the breadcrumb's Edits
    expect(names).toEqual(["Rename", "Duplicate", "Show in Finder", "Loop: Off", "Delete…"]);
    expect(within(menu).getByRole("menuitem", { name: "Rename" })).toHaveFocus();
    expect(menu).toHaveAccessibleDescription("2 clips · 1280 × 720 · 24 fps");
    // Rename opens the name's field in place, and the field keeps the focus it takes
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Rename" }));
    expect(screen.queryByRole("menu")).toBeNull();
    const field = await screen.findByRole("textbox", { name: "Edit name" });
    expect(field).toHaveValue("Trip");
    await waitFor(() => expect(field).toHaveFocus());
  });

  it("Loop is a set of radios: picking one sets the loop count as one undo step", async () => {
    await renderOpen();
    const trigger = screen.getByRole("button", { name: "Edit menu" });
    fireEvent.click(trigger);
    // Its row reads Off at 1×, where nothing repeats
    const row = within(screen.getByRole("menu", { name: "Edit menu" })).getByRole("menuitem", { name: "Loop: Off" });
    expect(row).toHaveAttribute("aria-haspopup", "menu");
    fireEvent.keyDown(row, { key: "ArrowRight" });
    const loop = screen.getByRole("menu", { name: "Loop" });
    const radios = within(loop).getAllByRole("menuitemradio");
    expect(radios.map((r) => [r.textContent, r.getAttribute("aria-checked")])).toEqual([
      ["1×", "true"],
      ["2×", "false"],
      ["3×", "false"],
    ]);
    expect(radios[0]).toHaveFocus();
    // ← goes back to Loop's row, Enter opens it again
    fireEvent.keyDown(radios[0], { key: "ArrowLeft" });
    expect(screen.queryByRole("menu", { name: "Loop" })).toBeNull();
    expect(row).toHaveFocus();
    fireEvent.keyDown(row, { key: "Enter" });
    const past = editor().past.length;
    fireEvent.click(within(screen.getByRole("menu", { name: "Loop" })).getByRole("menuitemradio", { name: "3×" }));
    expect(editor().draft!.loopCount).toBe(3);
    expect(editor().past).toHaveLength(past + 1);
    expect(screen.queryByRole("menu")).toBeNull();
    // Focus goes back to ⋯, not to <body>
    expect(trigger).toHaveFocus();
    expect(screen.getByTestId("edit-save-state")).toHaveTextContent("Unsaved");
    fireEvent.click(trigger);
    expect(screen.getByRole("menuitem", { name: "Loop: 3×" })).toBeInTheDocument();
  });

  it("keeps Loop's submenu a moment after the pointer leaves its row, so the pointer can cross a row into it", async () => {
    await renderOpen();
    fireEvent.click(screen.getByRole("button", { name: "Edit menu" }));
    const row = screen.getByRole("menuitem", { name: /^Loop/ }).parentElement!;
    fireEvent.mouseEnter(row);
    expect(screen.getByRole("menu", { name: "Loop" })).toBeInTheDocument();
    fireEvent.mouseLeave(row);
    expect(screen.getByRole("menu", { name: "Loop" })).toBeInTheDocument();
    // Arriving in the submenu keeps it
    fireEvent.mouseEnter(screen.getByRole("menuitemradio", { name: "2×" }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.getByRole("menu", { name: "Loop" })).toBeInTheDocument();
    fireEvent.mouseLeave(row);
    await waitFor(() => expect(screen.queryByRole("menu", { name: "Loop" })).toBeNull());
    expect(screen.getByRole("menu", { name: "Edit menu" })).toBeInTheDocument();
    // The hover had put focus in the submenu; it is back on Loop's row, so the menu's keys still work
    expect(screen.getByRole("menuitem", { name: /^Loop/ })).toHaveFocus();
    press(document.activeElement!, "Escape");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("a click on Loop's row keeps open the submenu the hover opened", async () => {
    await renderOpen();
    fireEvent.click(screen.getByRole("button", { name: "Edit menu" }));
    const loop = screen.getByRole("menuitem", { name: /^Loop/ });
    fireEvent.mouseEnter(loop.parentElement!);
    expect(screen.getByRole("menu", { name: "Loop" })).toBeInTheDocument();
    fireEvent.click(loop);
    expect(screen.getByRole("menu", { name: "Loop" })).toBeInTheDocument();
    fireEvent.click(loop);
    expect(screen.getByRole("menu", { name: "Loop" })).toBeInTheDocument();
    expect(loop).toHaveAttribute("aria-expanded", "true");
  });

  it("Loop says each loop plays the audio clips again while it does", async () => {
    const withAudio = doc({
      sequence: { ...doc().sequence, loopCount: 2, audioClips: [createAudioClip({ kind: "asset", assetId: M }, { id: "a1" })] },
    });
    await renderOpen(withAudio);
    const showLoop = () => {
      fireEvent.click(screen.getByRole("button", { name: "Edit menu" }));
      fireEvent.mouseEnter(screen.getByRole("menuitem", { name: /^Loop/ }).parentElement!);
      return screen.getByRole("menu", { name: "Loop" });
    };
    expect(showLoop()).toHaveAccessibleDescription(LOOP_AUDIO_NOTE);
    fireEvent.click(within(screen.getByRole("menu", { name: "Loop" })).getByRole("menuitemradio", { name: "1×" }));
    expect(showLoop()).not.toHaveAttribute("aria-describedby");
  });

  it("Delete… asks, then sends the edit to the Trash and goes home", async () => {
    await renderOpen();
    edits.deleteEdit.mockResolvedValue(undefined);
    edits.fetchEditList.mockResolvedValue(listOf([]));
    fireEvent.click(screen.getByRole("button", { name: "Edit menu" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Delete…" }));
    const sheet = await screen.findByRole("dialog", { name: "Delete edit?" });
    expect(sheet).toHaveTextContent("Delete “Trip”?");
    expectWhiteRings(sheet);
    fireEvent.click(within(sheet).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(edits.deleteEdit).toHaveBeenCalledWith(ID));
    await screen.findByText("An edit puts videos and audio from any project on one timeline.");
    expect(editor().isOpen).toBe(false);
  });

  it("with Save automatically off, switching away from changes asks first", async () => {
    await renderOpen();
    act(() => setLoopCount(2));
    const home = () => within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole("button", { name: "Edits" });
    fireEvent.click(home());
    const sheet = await screen.findByRole("dialog", { name: "Save changes?" });
    expect(sheet).toHaveTextContent("Save changes to “Trip”?");
    expectWhiteRings(sheet);
    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(editor().editId).toBe(ID);
    expect(editor().draft!.loopCount).toBe(2);

    fireEvent.click(home());
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Save changes?" })).getByRole("button", { name: "Don't save" }));
    await screen.findByRole("button", { name: "New edit" });
    expect(editor().isOpen).toBe(false);
    expect(edits.saveEdit).not.toHaveBeenCalled();
  });
});
