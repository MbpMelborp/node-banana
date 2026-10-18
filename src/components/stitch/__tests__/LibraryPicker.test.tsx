import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AssetFacets, AssetPage, AssetView, LibraryStatus } from "@/lib/assets/types";

const api = vi.hoisted(() => ({
  fetchAssetPage: vi.fn(),
  fetchFacets: vi.fn(),
  fetchAsset: vi.fn(),
  assetFileUrl: (id: string, download = false) => `/api/assets/${id}/file${download ? "?download=1" : ""}`,
  assetThumbUrl: (sha: string, width: number) => `/api/assets/thumb/${sha}?w=${width}`,
}));
vi.mock("@/lib/assets/client/api", () => api);

const poster = vi.hoisted(() => ({
  ensurePoster: vi.fn(async () => false),
  listener: null as ((id: string) => void) | null,
}));
vi.mock("@/lib/assets/client/poster", () => ({
  ensurePoster: poster.ensurePoster,
  onPosterReady: (listener: (id: string) => void) => {
    poster.listener = listener;
    return () => {
      poster.listener = null;
    };
  },
}));

vi.mock("@/components/Toast", () => ({ useToast: { getState: () => ({ show: vi.fn() }) } }));
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

import { useWorkflowStore } from "@/store/workflowStore";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { __resetPosterRequestsForTests } from "@/components/assets/posterRequests";
import { applyLibraryStatus } from "@/lib/assets/client/recorder";
import { __resetAssetInfoForTests, getAssetInfo } from "@/lib/stitch/assetInfo";
import { __resetMediaInfoForTests, __setMediaExtractorForTests, __setMediaInfoForTests, mediaKeyOf } from "@/lib/stitch/mediaInfo";
import { createClip, sourceKey } from "@/lib/stitch/timeline";
import { DEFAULT_SEQUENCE_LAYOUT as TRACK_LAYOUT } from "@/lib/stitch/stack";
import { LibraryPicker } from "../library/LibraryPicker";
import { StitchEditorModal } from "../StitchEditorModal";
import { openStitchEditor } from "../openStitchEditor";
import type { StitchSequenceLayout, WorkflowNode } from "@/types";

const editor = () => useStitchEditorStore.getState();
const T0 = Date.UTC(2026, 9, 16, 12);

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

function page(assets: AssetView[], overrides: Partial<AssetPage> = {}): AssetPage {
  return { assets, nextCursor: null, headCursor: assets[0] ? "h" : null, total: assets.length, totalBytes: 0, ...overrides };
}

const facets = (projects: AssetFacets["projects"]): AssetFacets => ({
  total: 3,
  favorites: 0,
  trash: 0,
  missing: 0,
  kinds: { image: 0, video: 3, audio: 0, "3d": 0 },
  origins: { generated: 3, edited: 0 },
  models: [],
  tags: [],
  workflows: [],
  projects,
});

const lastRequest = () => api.fetchAssetPage.mock.calls[api.fetchAssetPage.mock.calls.length - 1][0];

/** An editor session with two clips of `clipSec` each, the picker open over it. */
function openPicker({
  workflowId = "wf_1" as string | null,
  clips = 2,
  clipSec = 4,
  sequenceLayout = TRACK_LAYOUT as StitchSequenceLayout,
  kind = "video" as "video" | "audio",
} = {}) {
  useWorkflowStore.setState({ workflowId });
  act(() => {
    editor().open({
      nodeId: "stitch",
      draft: {
        timeline: Array.from({ length: clips }, (_, i) => createClip({ kind: "edge", edgeId: `e${i}` }, { id: `c${i}` })),
        audioClips: [],
        legacyAudio: { curve: [], muted: false },
        loopCount: 1,
        sequenceLayout,
      },
      canvasGeneration: 0,
    });
    editor().setDurations(
      new Map(Array.from({ length: clips }, (_, i) => [sourceKey({ kind: "edge", edgeId: `e${i}` }), clipSec])),
    );
    editor().setPickerOpen(kind);
  });
  return render(<LibraryPicker />);
}

const dialog = () => screen.getByRole("dialog", { name: "Add from library" });
/** A tile's accessible name starts with its file name, then its length, project and flags. */
const named = (file: string) => new RegExp(`^${file.replace(/\./g, "\\.")}(,|$)`);
const tile = (file: string) => within(dialog()).getByRole("button", { name: named(file) });

beforeEach(() => {
  __resetPosterRequestsForTests();
  __resetAssetInfoForTests();
  api.fetchAssetPage.mockReset();
  api.fetchFacets.mockReset();
  api.fetchAsset.mockReset();
  api.fetchAssetPage.mockResolvedValue(page([asset("a1"), asset("a2", { durationSec: 4.6 }), asset("a3")]));
  api.fetchFacets.mockResolvedValue(facets([]));
  api.fetchAsset.mockResolvedValue(null);
});

afterEach(() => {
  act(() => editor().close());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * A stand-in IntersectionObserver (jsdom has none), put back by restore even when an assertion fails. The
 * sentinel is the grid's end marker; fire tells its observer that it came into view.
 */
function stubObserver() {
  const globals = globalThis as { IntersectionObserver?: unknown };
  const original = globals.IntersectionObserver;
  const live = new Set<{ callback: IntersectionObserverCallback; target: Element | null }>();
  let registered = 0;
  globals.IntersectionObserver = class {
    entry = { callback: null as unknown as IntersectionObserverCallback, target: null as Element | null };
    constructor(callback: IntersectionObserverCallback) {
      this.entry.callback = callback;
    }
    observe(target: Element) {
      this.entry.target = target;
      live.add(this.entry);
      registered++;
    }
    disconnect() {
      live.delete(this.entry);
    }
    unobserve() {}
  };
  return {
    /** How many observers have been registered so far. */
    registrations: () => registered,
    sentinel() {
      const entry = [...live].filter((o) => o.target?.getAttribute("aria-hidden") === "true").at(-1);
      return entry
        ? {
            fire: () =>
              entry.callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver),
          }
        : null;
    },
    restore() {
      globals.IntersectionObserver = original;
    },
  };
}

/**
 * Fires the sentinel's observer once the list now shown has registered its own. The picker registers it in a
 * passive effect after the commit that findByRole waits for, and until then none is live, or the previous list's,
 * whose loadMore asks from that list's cursor. `after`: the registrations before that list landed.
 */
async function fireSentinel(observers: ReturnType<typeof stubObserver>, after: number): Promise<void> {
  await waitFor(() => expect(observers.registrations()).toBeGreaterThan(after));
  act(() => observers.sentinel()!.fire());
}

describe("LibraryPicker", () => {
  it("lists the library's videos, 60 at a time, and nothing else by default", async () => {
    openPicker();
    expect(await within(dialog()).findByRole("button", { name: named("a1.mp4") })).toBeInTheDocument();
    expect(api.fetchAssetPage).toHaveBeenCalledTimes(1);
    expect(api.fetchAssetPage.mock.calls[0][0]).toEqual({ kinds: ["video"], limit: 60 });
    expect(api.fetchAssetPage.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
    // The tile: its length to a tenth, the file name and the project's folder
    expect(within(tile("a2.mp4")).getByText("0:04.6")).toBeInTheDocument();
    expect(within(tile("a2.mp4")).getAllByText("Launch film")).toHaveLength(1);
    // Everything the tile shows is in its name
    expect(tile("a2.mp4")).toHaveAccessibleName("a2.mp4, 0:04.6, Launch film");
  });

  it("searches 200 ms after the last key", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    openPicker();
    await act(async () => {});
    fireEvent.change(within(dialog()).getByRole("textbox", { name: "Search videos" }), { target: { value: "veo" } });
    await act(async () => {
      vi.advanceTimersByTime(199);
    });
    expect(api.fetchAssetPage).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(api.fetchAssetPage).toHaveBeenCalledTimes(2);
    expect(lastRequest()).toEqual({ kinds: ["video"], limit: 60, q: "veo" });
  });

  it("narrows to favourites and to this workflow", async () => {
    openPicker();
    await within(dialog()).findByRole("button", { name: named("a1.mp4") });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Favorites" }));
    await waitFor(() => expect(lastRequest()).toMatchObject({ favorite: true }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "This workflow" }));
    await waitFor(() => expect(lastRequest()).toMatchObject({ favorite: true, workflowIds: ["wf_1"] }));
    expect(within(dialog()).getByRole("button", { name: "This workflow" })).toHaveAttribute("aria-pressed", "true");
  });

  it("cannot narrow to a workflow that has no id yet", async () => {
    openPicker({ workflowId: null });
    await within(dialog()).findByRole("button", { name: named("a1.mp4") });
    const toggle = within(dialog()).getByRole("button", { name: "This workflow" });
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute("title", "Nothing from this workflow is in the library yet");
  });

  it("narrows to a project from the library's own list", async () => {
    api.fetchFacets.mockResolvedValue(
      facets([
        { path: "/p", name: "Launch film", count: 3 },
        { path: null, name: "Not in a project", count: 1 },
      ]),
    );
    openPicker();
    await within(dialog()).findByRole("button", { name: named("a1.mp4") });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Project: All projects" }));
    const menu = await screen.findByRole("menu", { name: "Project: All projects" });
    await waitFor(() => expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(3));
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Launch film" }));
    await waitFor(() => expect(lastRequest()).toMatchObject({ projects: ["/p"] }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(within(dialog()).getByRole("button", { name: "Project: Launch film" })).toBeInTheDocument();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Project: Launch film" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitemradio", { name: "Not in a project" }));
    await waitFor(() => expect(lastRequest()).toMatchObject({ projects: [""] }));
  });

  it("sorts oldest first, and Escape closes the menu but not the picker", async () => {
    openPicker();
    await within(dialog()).findByRole("button", { name: named("a1.mp4") });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Sort: Newest first" }));
    const menu = screen.getByRole("menu", { name: "Sort: Newest first" });
    fireEvent.keyDown(within(menu).getByRole("menuitemradio", { name: "Newest first" }), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(editor().pickerOpen).toBe("video");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Sort: Newest first" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitemradio", { name: "Oldest first" }));
    await waitFor(() => expect(lastRequest()).toMatchObject({ sort: "oldest" }));
  });

  it("counts the picked videos, their length and where they go", async () => {
    openPicker();
    await within(dialog()).findByRole("button", { name: named("a1.mp4") });
    expect(within(dialog()).getByRole("button", { name: "Add clips" })).toBeDisabled();
    // Where they go is said only once something is picked
    expect(within(dialog()).getByText("Pick videos to add")).toBeInTheDocument();
    expect(within(dialog()).queryByText(/goes after/)).toBeNull();
    fireEvent.click(tile("a1.mp4"));
    expect(within(dialog()).getByText("1 selected")).toBeInTheDocument();
    expect(within(dialog()).getByRole("button", { name: "Add 1 clip" })).toBeEnabled();
    fireEvent.click(tile("a2.mp4"));
    expect(tile("a2.mp4")).toHaveAttribute("aria-pressed", "true");
    expect(within(tile("a2.mp4")).getByLabelText("Selected")).toBeInTheDocument();
    expect(within(dialog()).getByText("2 selected")).toBeInTheDocument();
    expect(within(dialog()).getByText("0:09.60")).toBeInTheDocument();
    expect(within(dialog()).getByText("goes after Clip 2")).toBeInTheDocument();
    // A second press takes a video back out
    fireEvent.click(tile("a1.mp4"));
    expect(within(dialog()).getByText("1 selected")).toBeInTheDocument();
  });

  it("names the clip that ends last in a placed stack, where new clips start under it", async () => {
    openPicker({ clips: 3, clipSec: 4, sequenceLayout: { mode: "stacked", overlapSec: 1, crossfade: true } });
    // Clip 1 placed at 10 s ends last (14 s); Clips 2 and 3 end at 4 s and 6 s
    act(() =>
      editor().apply((d) => ({
        ...d,
        timeline: d.timeline.map((clip, i) => ({ ...clip, startSec: [10, 0, 2][i] })),
      })),
    );
    await within(dialog()).findByRole("button", { name: named("a1.mp4") });
    fireEvent.click(tile("a1.mp4"));
    expect(within(dialog()).getByText("goes after Clip 1")).toBeInTheDocument();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Add 1 clip" }));
    expect(editor().draft!.timeline[3].startSec).toBeUndefined();
    expect(editor().playhead).toBe(13);
  });

  it("says a clip goes first on an empty timeline", async () => {
    openPicker({ clips: 0 });
    await within(dialog()).findByRole("button", { name: named("a1.mp4") });
    fireEvent.click(tile("a1.mp4"));
    expect(within(dialog()).getByText("goes first")).toBeInTheDocument();
  });

  it("appends the picked videos as library clips in the order they were picked, in one step, and closes", async () => {
    openPicker();
    await within(dialog()).findByRole("button", { name: named("a1.mp4") });
    fireEvent.click(tile("a3.mp4"));
    fireEvent.click(tile("a1.mp4"));
    const before = editor().past.length;
    fireEvent.click(within(dialog()).getByRole("button", { name: "Add 2 clips" }));
    const timeline = editor().draft!.timeline;
    expect(timeline.map((c) => c.source)).toEqual([
      { kind: "edge", edgeId: "e0" },
      { kind: "edge", edgeId: "e1" },
      { kind: "asset", assetId: "a3" },
      { kind: "asset", assetId: "a1" },
    ]);
    expect(timeline.slice(2).every((c) => !c.muted && c.volume === 1 && c.inSec === 0 && c.outSec === null)).toBe(true);
    expect(editor().past.length).toBe(before + 1);
    expect(editor().selection).toEqual({ kind: "clip", clipId: timeline[2].id });
    // After the two 4 s clips
    expect(editor().playhead).toBe(8);
    expect(editor().pickerOpen).toBe(false);
    // Labelled from the page's records, with nothing asked again
    expect(getAssetInfo("a3")?.filename).toBe("a3.mp4");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add from library" })).toBeNull());
  });

  it("puts the playhead on a new clip's first frame in Stacked, where it starts under the last clip", async () => {
    openPicker({ clips: 1, clipSec: 5, sequenceLayout: { mode: "stacked", overlapSec: 1, crossfade: true } });
    await within(dialog()).findByRole("button", { name: named("a1.mp4") });
    fireEvent.click(tile("a1.mp4"));
    // The footer still says where it goes in the order, and how much footage is picked
    expect(within(dialog()).getByText("goes after Clip 1")).toBeInTheDocument();
    expect(within(dialog()).getByText("0:05.00")).toBeInTheDocument();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Add 1 clip" }));
    expect(editor().draft!.timeline).toHaveLength(2);
    // The 5 s clip ends at 5; the new 5 s clip starts 1 s before that
    expect(editor().playhead).toBe(4);
  });

  it("cannot pick a video whose file is missing", async () => {
    api.fetchAssetPage.mockResolvedValue(page([asset("a1", { missing: true }), asset("a2")]));
    openPicker();
    expect(await within(dialog()).findByRole("button", { name: named("a1.mp4") })).toBeDisabled();
    expect(tile("a1.mp4")).toHaveAttribute("title", "The file is missing");
    expect(tile("a2.mp4")).toBeEnabled();
  });

  it("drops an answer to a query that is no longer current", async () => {
    let answerFirst!: (value: AssetPage) => void;
    api.fetchAssetPage.mockImplementationOnce(() => new Promise((resolve) => (answerFirst = resolve)));
    api.fetchAssetPage.mockResolvedValueOnce(page([asset("fav", { favorite: true })]));
    openPicker();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Favorites" }));
    expect(await within(dialog()).findByRole("button", { name: named("fav.mp4") })).toBeInTheDocument();
    expect(tile("fav.mp4")).toHaveAccessibleName("fav.mp4, 0:05.0, Launch film, favorite");
    await act(async () => answerFirst(page([asset("stale")])));
    expect(within(dialog()).queryByRole("button", { name: named("stale.mp4") })).toBeNull();
    expect(tile("fav.mp4")).toBeInTheDocument();
  });

  it("shows when nothing matches, and the list's error", async () => {
    api.fetchAssetPage.mockResolvedValueOnce(page([]));
    openPicker();
    expect(await within(dialog()).findByText("No videos match")).toBeInTheDocument();
    api.fetchAssetPage.mockRejectedValueOnce(new Error("The library is moving."));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Favorites" }));
    expect(await within(dialog()).findByText("The library is moving.")).toBeInTheDocument();
  });

  it("asks for a first page that failed again from its Try again", async () => {
    api.fetchAssetPage.mockRejectedValueOnce(new Error("The library is moving."));
    openPicker();
    expect(await within(dialog()).findByText("The library is moving.")).toBeInTheDocument();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Try again" }));
    expect(await within(dialog()).findByRole("button", { name: named("a1.mp4") })).toBeInTheDocument();
    expect(api.fetchAssetPage).toHaveBeenCalledTimes(2);
    expect(api.fetchAssetPage.mock.calls[1][0]).toEqual(api.fetchAssetPage.mock.calls[0][0]);
    expect(within(dialog()).queryByText("The library is moving.")).toBeNull();
  });

  it("starts a new query's list at the top", async () => {
    openPicker();
    await within(dialog()).findByRole("button", { name: named("a1.mp4") });
    const grid = screen.getByTestId("stitch-library-grid");
    grid.scrollTop = 300;
    api.fetchAssetPage.mockResolvedValueOnce(page([asset("fav", { favorite: true }), asset("a2"), asset("a3")]));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Favorites" }));
    await within(dialog()).findByRole("button", { name: named("fav.mp4") });
    expect(grid.scrollTop).toBe(0);
  });

  it("loads the next page from the cursor as the end of the grid comes into view, and stops at the end", async () => {
    const observers = stubObserver();
    try {
      api.fetchAssetPage.mockResolvedValueOnce(page([asset("a1")], { nextCursor: "c1", total: 2 }));
      api.fetchAssetPage.mockResolvedValueOnce(page([asset("a2")], { nextCursor: "c1", total: 2 }));
      // Nothing new on the same cursor: the end, whatever the server says
      api.fetchAssetPage.mockResolvedValueOnce(page([asset("a1"), asset("a2")], { nextCursor: "c1", total: 2 }));
      openPicker();
      await within(dialog()).findByRole("button", { name: named("a1.mp4") });
      await fireSentinel(observers, 0);
      const mark = observers.registrations();
      expect(await within(dialog()).findByRole("button", { name: named("a2.mp4") })).toBeInTheDocument();
      expect(lastRequest()).toEqual({ kinds: ["video"], limit: 60, cursor: "c1" });
      expect(api.fetchAssetPage).toHaveBeenCalledTimes(2);
      await fireSentinel(observers, mark);
      await waitFor(() => expect(api.fetchAssetPage).toHaveBeenCalledTimes(3));
      await waitFor(() => expect(observers.sentinel()).toBeNull());
      expect(dialog().querySelectorAll("[data-asset-id]")).toHaveLength(2);
    } finally {
      observers.restore();
    }
  });

  it("asks no next page from the list while the same query's first page is out again, so none goes missing", async () => {
    const observers = stubObserver();
    try {
      let answerAgain!: (value: AssetPage) => void;
      api.fetchAssetPage.mockResolvedValueOnce(page([asset("a1")], { nextCursor: "c1", total: 3 }));
      api.fetchAssetPage.mockResolvedValueOnce(page([asset("a2")], { nextCursor: "c2", total: 3 }));
      // Favourites on (never answers), then off again: the first page is asked again
      api.fetchAssetPage.mockImplementationOnce(() => new Promise(() => {}));
      api.fetchAssetPage.mockImplementationOnce(() => new Promise((resolve) => (answerAgain = resolve)));
      api.fetchAssetPage.mockResolvedValueOnce(page([asset("a2")], { nextCursor: "c2", total: 3 }));
      api.fetchAssetPage.mockResolvedValueOnce(page([asset("a3")], { nextCursor: null, total: 3 }));
      openPicker();
      await within(dialog()).findByRole("button", { name: named("a1.mp4") });
      await fireSentinel(observers, 0);
      await within(dialog()).findByRole("button", { name: named("a2.mp4") });
      const favourites = within(dialog()).getByRole("button", { name: "Favorites" });
      fireEvent.click(favourites);
      fireEvent.click(favourites);
      expect(api.fetchAssetPage).toHaveBeenCalledTimes(4);
      // The old list is still shown; its end coming into view asks nothing yet
      act(() => observers.sentinel()?.fire());
      expect(api.fetchAssetPage).toHaveBeenCalledTimes(4);
      let mark = observers.registrations();
      await act(async () => answerAgain(page([asset("a1")], { nextCursor: "c1", total: 3 })));
      await fireSentinel(observers, mark);
      mark = observers.registrations();
      await within(dialog()).findByRole("button", { name: named("a2.mp4") });
      await fireSentinel(observers, mark);
      await within(dialog()).findByRole("button", { name: named("a3.mp4") });
      expect(api.fetchAssetPage.mock.calls.map((c) => c[0].cursor)).toEqual([undefined, "c1", undefined, undefined, "c1", "c2"]);
      expect([...dialog().querySelectorAll("[data-asset-id]")].map((el) => el.getAttribute("data-asset-id"))).toEqual([
        "a1",
        "a2",
        "a3",
      ]);
    } finally {
      observers.restore();
    }
  });

  it("asks nothing again when the workflow's id changes while This workflow is off", async () => {
    openPicker();
    await within(dialog()).findByRole("button", { name: named("a1.mp4") });
    act(() => useWorkflowStore.setState({ workflowId: "wf_2" }));
    await act(async () => {});
    expect(api.fetchAssetPage).toHaveBeenCalledTimes(1);
    expect(tile("a1.mp4")).toBeInTheDocument();
  });

  it("keeps the list when a next page fails, says so, and tries the same cursor again", async () => {
    const observers = stubObserver();
    try {
      api.fetchAssetPage.mockResolvedValueOnce(page([asset("a1")], { nextCursor: "c1", total: 2 }));
      api.fetchAssetPage.mockRejectedValueOnce(new Error("The library is moving."));
      api.fetchAssetPage.mockResolvedValueOnce(page([asset("a2")], { nextCursor: null, total: 2 }));
      openPicker();
      await within(dialog()).findByRole("button", { name: named("a1.mp4") });
      await fireSentinel(observers, 0);
      expect(await within(dialog()).findByText("The library is moving.")).toBeInTheDocument();
      expect(tile("a1.mp4")).toBeInTheDocument();
      // Not asked again by itself: no observer is left on the failed list
      await waitFor(() => expect(observers.sentinel()).toBeNull());
      fireEvent.click(within(dialog()).getByRole("button", { name: "Try again" }));
      expect(await within(dialog()).findByRole("button", { name: named("a2.mp4") })).toBeInTheDocument();
      expect(api.fetchAssetPage.mock.calls.map((c) => c[0].cursor)).toEqual([undefined, "c1", "c1"]);
      expect(within(dialog()).queryByText("The library is moving.")).toBeNull();
    } finally {
      observers.restore();
    }
  });

  it("asks for a poster for a tile on screen that has none, and shows it once made", async () => {
    api.fetchAssetPage.mockResolvedValue(page([asset("np", { hasPoster: false }), asset("a2")]));
    openPicker();
    const npTile = await within(dialog()).findByRole("button", { name: named("np.mp4") });
    await waitFor(() => expect(poster.ensurePoster).toHaveBeenCalledWith(expect.objectContaining({ id: "np" }), expect.anything()));
    expect(poster.ensurePoster).toHaveBeenCalledTimes(1);
    const before = npTile.querySelector("img")!.getAttribute("src");
    act(() => poster.listener!("np"));
    const after = npTile.querySelector("img")!.getAttribute("src");
    expect(after).not.toBe(before);
    expect(after).toBe(tile("a2.mp4").querySelector("img")!.getAttribute("src")!.replace("a2", "np"));
  });

  it("closes on a press on the scrim, but not on a drag from inside let go over it", async () => {
    openPicker();
    await within(dialog()).findByRole("button", { name: named("a1.mp4") });
    fireEvent.click(tile("a1.mp4"));
    const scrim = dialog().parentElement!;
    // Chromium sends the click to the common ancestor: the scrim
    fireEvent.pointerDown(within(dialog()).getByRole("textbox", { name: "Search videos" }));
    fireEvent.click(scrim);
    expect(editor().pickerOpen).toBe("video");
    expect(within(dialog()).getByText("1 selected")).toBeInTheDocument();
    fireEvent.pointerDown(scrim);
    fireEvent.click(scrim);
    expect(editor().pickerOpen).toBe(false);
  });

  it("closes an open menu on a wheel over the grid", async () => {
    openPicker();
    await within(dialog()).findByRole("button", { name: named("a1.mp4") });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Project: All projects" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.wheel(screen.getByTestId("stitch-library-grid"), { deltaY: 40 });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("LibraryPicker over the editor", () => {
  const node = (id: string, type: string, data: Record<string, unknown>): WorkflowNode =>
    ({ id, type, data, position: { x: 0, y: 0 } }) as WorkflowNode;

  beforeEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    useWorkflowStore.getState().clearWorkflow();
    __resetMediaInfoForTests();
    __setMediaExtractorForTests({ probe: () => new Promise(() => {}), open: () => new Promise(() => {}) });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    useWorkflowStore.setState({
      nodes: [
        node("gen-a", "generateVideo", { outputVideo: "blob:a" }),
        node("stitch", "videoStitch", { clips: [], clipOrder: [], outputVideo: null, loopCount: 1, status: "idle" }),
      ],
      edges: [{ id: "eA", source: "gen-a", target: "stitch", sourceHandle: "video", targetHandle: "video-0" }],
      openModalCount: 0,
      isModalOpen: false,
    });
    __setMediaInfoForTests(mediaKeyOf("blob:a"), { duration: 5, width: 1280, height: 720, fps: 24 });
  });

  afterEach(() => {
    __setMediaExtractorForTests(null);
    __resetMediaInfoForTests();
  });

  it("opens from the slot after the last clip, and Escape closes only the picker", async () => {
    render(<StitchEditorModal />);
    act(() => {
      openStitchEditor("stitch");
    });
    const editorDialog = screen.getByRole("dialog", { name: "Edit video" });
    // The + slot after the last clip (the timeline has no track headers, so no other +)
    const [slotAdd] = within(editorDialog).getAllByRole("button", { name: "Add a clip from the library" });
    expect(within(editorDialog).getAllByRole("button", { name: "Add a clip from the library" })).toHaveLength(1);
    expect(slotAdd).toBe(screen.getByTestId("stitch-add-slot"));
    // A browser focuses a button it clicks; jsdom does not
    act(() => slotAdd.focus());
    fireEvent.click(slotAdd);
    expect(await within(dialog()).findByRole("button", { name: named("a1.mp4") })).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(within(dialog()).getByRole("textbox", { name: "Search videos" })));
    // Canvas and editor keys stay off while the picker is up: ⌫ removes no clip
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }));
    });
    expect(editor().draft!.timeline).toHaveLength(1);
    act(() => {
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add from library" })).toBeNull());
    expect(editor().isOpen).toBe(true);
    expect(editor().discardOpen).toBe(false);
    expect(screen.getByRole("dialog", { name: "Edit video" })).toBeInTheDocument();
    // Focus goes back to the + that opened it
    await waitFor(() => expect(document.activeElement).toBe(slotAdd));

    fireEvent.click(screen.getByTestId("stitch-add-slot"));
    expect(editor().pickerOpen).toBe("video");
  });

  it("offers Add from library until the library is known to be off, then turns every entry point off", async () => {
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
    render(<StitchEditorModal />);
    act(() => {
      openStitchEditor("stitch");
    });
    // Not asked yet (null): offered, and the list request says what it finds
    const addAudio = () => screen.getByRole("button", { name: "Add audio" });
    expect(addAudio()).toBeEnabled();
    expect(screen.getByTestId("stitch-add-slot")).toBeEnabled();
    try {
      act(() => applyLibraryStatus(status(false)));
      expect(addAudio()).toBeDisabled();
      expect(addAudio()).toHaveAttribute("title", "The asset library is off");
      expect(screen.getByTestId("stitch-add-slot")).toBeDisabled();
      expect(screen.getByTestId("stitch-add-slot")).toHaveAttribute("title", "The asset library is off");
      // The picker, if it is up all the same, asks nothing
      act(() => editor().setPickerOpen("video"));
      expect(within(dialog()).getByText("The asset library is off.")).toBeInTheDocument();
      expect(api.fetchAssetPage).not.toHaveBeenCalled();
      act(() => editor().setPickerOpen(false));
      // The empty lane's placeholder: off, and no +
      act(() => editor().apply((d) => ({ ...d, timeline: [] })));
      const placeholder = screen.getByTestId("stitch-empty-lane");
      expect(placeholder).toBeDisabled();
      expect(placeholder.querySelector("svg")).toBeNull();
    } finally {
      act(() => applyLibraryStatus(status(true)));
    }
    expect(screen.getByTestId("stitch-empty-lane")).toBeEnabled();
    expect(screen.getByTestId("stitch-empty-lane").querySelector("svg")).not.toBeNull();
  });

  describe("set to audio", () => {
    const audioAsset = (id: string, durationSec: number) =>
      asset(id, {
        kind: "audio",
        mime: "audio/mp4",
        ext: "m4a",
        filename: `${id}.m4a`,
        width: undefined,
        height: undefined,
        durationSec,
        hasPoster: false,
      });
    const audioDialog = () => screen.getByRole("dialog", { name: "Add audio from the library" });
    const audioTile = (file: string) => within(audioDialog()).getByRole("button", { name: named(file) });

    beforeEach(() => {
      api.fetchAssetPage.mockResolvedValue(page([audioAsset("t1", 3), audioAsset("t2", 9)]));
    });

    it("lists the library's audio, with its own copy, and asks for no poster", async () => {
      poster.ensurePoster.mockClear();
      openPicker({ kind: "audio" });
      expect(await within(audioDialog()).findByRole("button", { name: named("t1.m4a") })).toBeInTheDocument();
      expect(api.fetchAssetPage.mock.calls[0][0]).toEqual({ kinds: ["audio"], limit: 60 });
      expect(
        within(audioDialog()).getByText(
          "Audio saved in your Node Banana folder. Each picked file goes on a new audio row, starting at the playhead.",
        ),
      ).toBeInTheDocument();
      expect(within(audioDialog()).getByRole("textbox", { name: "Search audio" })).toHaveAttribute(
        "placeholder",
        "Search audio",
      );
      expect(within(audioDialog()).getByText("Audio")).toBeInTheDocument();
      // The audio placeholder, not a thumbnail
      expect(audioTile("t1.m4a").querySelector("img")).toBeNull();
      expect(poster.ensurePoster).not.toHaveBeenCalled();
      expect(within(audioDialog()).getByText("Pick audio files to add")).toBeInTheDocument();
    });

    it("puts each picked file on a new row at the playhead, in one step, the first selected", async () => {
      openPicker({ kind: "audio" });
      act(() => editor().setPlayhead(2.5));
      await within(audioDialog()).findByRole("button", { name: named("t1.m4a") });
      fireEvent.click(audioTile("t2.m4a"));
      expect(within(audioDialog()).getByText("starts at 0:02.50 on a new row")).toBeInTheDocument();
      fireEvent.click(audioTile("t1.m4a"));
      expect(within(audioDialog()).getByText("each starts at 0:02.50 on a new row")).toBeInTheDocument();
      expect(within(audioDialog()).getByText("0:12.00")).toBeInTheDocument();
      const before = editor().past.length;
      fireEvent.click(within(audioDialog()).getByRole("button", { name: "Add 2 audio clips" }));
      const clips = editor().draft!.audioClips;
      expect(clips.map((c) => [c.source, c.row, c.startSec])).toEqual([
        [{ kind: "asset", assetId: "t2" }, 0, 2.5],
        [{ kind: "asset", assetId: "t1" }, 1, 2.5],
      ]);
      expect(editor().draft!.timeline).toHaveLength(2);
      expect(editor().past.length).toBe(before + 1);
      expect(editor().selection).toMatchObject({ kind: "audio", clipId: clips[0].id });
      expect(editor().pickerOpen).toBe(false);
      expect(getAssetInfo("t2")?.filename).toBe("t2.m4a");
    });

    it("says when the library has no audio, and when nothing matches", async () => {
      api.fetchAssetPage.mockResolvedValue(page([]));
      openPicker({ kind: "audio" });
      expect(await within(audioDialog()).findByText("No audio in the library yet")).toBeInTheDocument();
      fireEvent.click(within(audioDialog()).getByRole("button", { name: "Favorites" }));
      expect(await within(audioDialog()).findByText("No audio matches")).toBeInTheDocument();
    });

    it("opens from + Audio under the audio rows", async () => {
      render(<StitchEditorModal />);
      act(() => {
        openStitchEditor("stitch");
      });
      fireEvent.click(screen.getByRole("button", { name: "Add audio" }));
      expect(editor().pickerOpen).toBe("audio");
      expect(await within(audioDialog()).findByRole("button", { name: named("t1.m4a") })).toBeInTheDocument();
    });
  });
});
