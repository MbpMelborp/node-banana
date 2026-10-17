import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useWorkflowStore } from "@/store/workflowStore";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import {
  __resetMediaInfoForTests,
  __setMediaExtractorForTests,
  __setMediaInfoForTests,
  assetMediaKey,
  mediaKeyOf,
} from "@/lib/stitch/mediaInfo";
import { __resetAssetInfoForTests, primeAssetInfo } from "@/lib/stitch/assetInfo";
import { createClip } from "@/lib/stitch/timeline";
import type { AssetView } from "@/lib/assets/types";
import { StitchEditorModal } from "../StitchEditorModal";
import { openStitchEditor } from "../openStitchEditor";
import { setClipStart, setCrossfade, setLoopCount, setOverlapSec, setSequenceMode } from "../editorActions";
import type { VideoStitchNodeData, WorkflowEdge, WorkflowNode } from "@/types";

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

// The modal against the real stores and the real media hooks: a selector
// that returned fresh objects would loop here ("Maximum update depth").

const wf = () => useWorkflowStore.getState();
const editor = () => useStitchEditorStore.getState();
const node = (id: string, type: string, data: Record<string, unknown>): WorkflowNode =>
  ({ id, type, data, position: { x: 0, y: 0 } }) as WorkflowNode;
const edge = (id: string, source: string, targetHandle: string): WorkflowEdge => ({
  id,
  source,
  target: "stitch",
  sourceHandle: "video",
  targetHandle,
});
const stitchData = () => wf().nodes.find((n) => n.id === "stitch")!.data as VideoStitchNodeData;

function seed({
  clips = true,
  fps = [24, 24],
  stitch = {},
  music = false,
}: {
  clips?: boolean;
  fps?: [number, number];
  stitch?: Partial<VideoStitchNodeData>;
  music?: boolean;
} = {}) {
  const musicEdge: WorkflowEdge = { id: "eM", source: "gen-m", target: "stitch", sourceHandle: "audio", targetHandle: "audio" };
  useWorkflowStore.setState({
    nodes: [
      node("gen-a", "generateVideo", {
        outputVideo: "blob:a",
        selectedModel: { provider: "kie", modelId: "veo", displayName: "Veo 3.1" },
      }),
      node("gen-b", "generateVideo", { outputVideo: "blob:b" }),
      node("gen-m", "generateAudio", {}),
      node("stitch", "videoStitch", {
        clips: [],
        clipOrder: [],
        outputVideo: null,
        loopCount: 1,
        status: "idle",
        ...stitch,
      }),
    ],
    edges: [
      ...(clips ? [edge("eA", "gen-a", "video-0"), edge("eB", "gen-b", "video-1")] : []),
      ...(music ? [musicEdge] : []),
    ],
    openModalCount: 0,
    isModalOpen: false,
  });
  __setMediaInfoForTests(mediaKeyOf("blob:a"), { duration: 5, width: 1920, height: 1080, fps: fps[0] });
  __setMediaInfoForTests(mediaKeyOf("blob:b"), { duration: 4, width: 1280, height: 720, fps: fps[1] });
}

function openEditor() {
  render(<StitchEditorModal />);
  act(() => {
    openStitchEditor("stitch");
  });
  return screen.getByRole("dialog", { name: "Edit stitch" });
}

const press = (target: EventTarget, key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });

const toggleClipAudio = () => fireEvent.click(screen.getByRole("switch", { name: "Clip audio" }));

beforeEach(async () => {
  // An edge removal holds the store's delete checkpoint until the next task; let an earlier test's go
  await new Promise((resolve) => setTimeout(resolve, 0));
  wf().clearWorkflow();
  editor().close();
  __resetMediaInfoForTests();
  __resetAssetInfoForTests();
  // Nothing is ever read from a real file here
  __setMediaExtractorForTests({ probe: () => new Promise(() => {}), open: () => new Promise(() => {}) });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});

afterEach(() => {
  act(() => editor().close());
  __setMediaExtractorForTests(null);
  __resetMediaInfoForTests();
  vi.restoreAllMocks();
});

describe("StitchEditorModal", () => {
  it("renders nothing while closed", () => {
    seed();
    render(<StitchEditorModal />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens on the node's sequence with its length, size and rate", () => {
    seed();
    const dialog = openEditor();
    const header = within(dialog);
    expect(header.getByText("2 clips")).toBeInTheDocument();
    expect(header.getAllByText("0:09.00").length).toBeGreaterThan(0);
    // Size and rate are one item, so their dot is spaced like the words round it
    expect(header.getByText("1920 × 1080 · 24 fps")).toBeInTheDocument();
    // The rail shows the first clip (the timeline names it too)
    const rail = within(header.getByRole("complementary", { name: "Clip" }));
    expect(rail.getByText("Clip 1")).toBeInTheDocument();
    expect(rail.getByText("Generate video · Veo 3.1 · 5.00 s")).toBeInTheDocument();
  });

  it("leaves the rate out when the clips disagree", () => {
    seed({ fps: [24, 30] });
    openEditor();
    expect(screen.queryByText(/fps$/)).toBeNull();
  });

  it("leaves a clip the encode drops out of the size and rate", () => {
    // Clip 1 starts past the end of its 5 s video, so only clip 2 (1280 × 720 at 30) is encoded
    seed({
      fps: [24, 30],
      stitch: {
        clipOrder: ["eA", "eB"],
        timeline: [
          { id: "c1", source: { kind: "edge", edgeId: "eA" }, inSec: 6, outSec: null, muted: false, volume: 1 },
          { id: "c2", source: { kind: "edge", edgeId: "eB" }, inSec: 0, outSec: null, muted: false, volume: 1 },
        ],
      },
    });
    const dialog = within(openEditor());
    expect(dialog.getByText("1280 × 720 · 30 fps")).toBeInTheDocument();
    expect(dialog.queryByText(/1920 × 1080/)).toBeNull();
  });

  it("shows an Out stored past the video's end at the end", () => {
    seed({
      stitch: {
        clipOrder: ["eA", "eB"],
        timeline: [
          { id: "c1", source: { kind: "edge", edgeId: "eA" }, inSec: 0, outSec: 8, muted: false, volume: 1 },
          { id: "c2", source: { kind: "edge", edgeId: "eB" }, inSec: 0, outSec: null, muted: false, volume: 1 },
        ],
      },
    });
    openEditor();
    expect((screen.getByRole("textbox", { name: "Out" }) as HTMLInputElement).value).toBe("0:05.00");
  });

  it("mutes the music with M only when music is connected, and can still unmute a muted node", () => {
    seed();
    openEditor();
    press(document.body, "m");
    expect(editor().draft!.audioMuted).toBe(false);
    act(() => editor().close());

    seed({ stitch: { audioMuted: true } });
    act(() => {
      openStitchEditor("stitch");
    });
    press(document.body, "m");
    expect(editor().draft!.audioMuted).toBe(false);
    act(() => editor().close());

    seed({ music: true });
    act(() => {
      openStitchEditor("stitch");
    });
    press(document.body, "m");
    expect(editor().draft!.audioMuted).toBe(true);
  });

  it("closes on Done without touching a node nothing was changed on", () => {
    seed();
    openEditor();
    const before = wf().nodes;
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(wf().nodes).toBe(before);
    expect("timeline" in stitchData()).toBe(false);
  });

  it("writes the edited sequence on Done, in one write", () => {
    seed();
    openEditor();
    const write = vi.spyOn(wf(), "updateNodeData");
    toggleClipAudio();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][1]).toEqual({
      timeline: [
        expect.objectContaining({ id: "clip:eA", muted: true }),
        expect.objectContaining({ id: "clip:eB", muted: false }),
      ],
      audioCurve: [],
      audioMuted: false,
      loopCount: 1,
      clipOrder: ["eA", "eB"],
    });
    expect(stitchData().timeline![0].muted).toBe(true);
  });

  it("asks before Cancel drops changes; Keep editing goes back, Discard leaves the node as it was", () => {
    seed();
    openEditor();
    toggleClipAudio();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const sheet = screen.getByRole("dialog", { name: "Discard changes?" });
    expect(within(sheet).getByText("A muted clip will be lost. The node keeps what it had.")).toBeInTheDocument();

    fireEvent.click(within(sheet).getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByRole("dialog", { name: "Discard changes?" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Edit stitch" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect("timeline" in stitchData()).toBe(false);
  });

  it("closes on Escape when nothing changed", () => {
    seed();
    openEditor();
    press(document.body, "Escape");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks on Escape when something changed, and Escape on the sheet closes only the sheet", () => {
    seed();
    openEditor();
    toggleClipAudio();
    press(document.body, "Escape");
    expect(screen.getByRole("dialog", { name: "Discard changes?" })).toBeInTheDocument();
    press(document.body, "Escape");
    expect(screen.queryByRole("dialog", { name: "Discard changes?" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Edit stitch" })).toBeInTheDocument();
    expect(editor().isOpen).toBe(true);
  });

  it("keeps its keys from the canvas behind it", () => {
    seed();
    openEditor();
    const canvas = vi.fn();
    document.addEventListener("keydown", canvas);
    press(document.body, "Backspace");
    press(document.body, "z", { metaKey: true });
    press(document.body, "G", { shiftKey: true });
    press(document.body, "Enter", { metaKey: true });
    press(document.body, "Escape");
    document.removeEventListener("keydown", canvas);
    expect(canvas).not.toHaveBeenCalled();
  });

  it("keeps canvas keys away while the clip menu is open, and Escape closes only the menu", () => {
    seed();
    openEditor();
    act(() => editor().openMenu({ clipId: "clip:eA", x: 10, y: 10 }));
    const canvas = vi.fn();
    document.addEventListener("keydown", canvas);
    press(document.body, "z", { metaKey: true });
    press(document.body, "G", { shiftKey: true });
    press(document.body, "v", { metaKey: true });
    press(document.body, "?", { shiftKey: true });
    press(document.body, "Escape");
    document.removeEventListener("keydown", canvas);
    expect(canvas).not.toHaveBeenCalled();
    expect(editor().menu).toBeNull();
    expect(editor().isOpen).toBe(true);
  });

  it("types into the In field without the I key, and commits a typed time on Enter", () => {
    seed();
    openEditor();
    act(() => editor().setPlayhead(2));
    const field = screen.getByRole("textbox", { name: "In" }) as HTMLInputElement;
    act(() => field.focus());
    press(field, "i");
    expect(editor().draft!.timeline[0].inSec).toBe(0);

    fireEvent.change(field, { target: { value: "0:01.00" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(editor().draft!.timeline[0].inSec).toBe(1);
  });

  it("sets In at the playhead with I", () => {
    seed();
    openEditor();
    act(() => editor().setPlayhead(2));
    press(document.body, "i");
    expect(editor().draft!.timeline[0].inSec).toBe(2);
  });

  it("steps back with J from the end of a sequence that got shorter, not from the old end", () => {
    seed();
    openEditor();
    act(() => editor().setPlayhead(9));
    act(() => editor().select({ kind: "clip", clipId: "clip:eB" }));
    press(document.body, "Backspace");
    expect(editor().draft!.timeline).toHaveLength(1);
    press(document.body, "j");
    expect(editor().playhead).toBe(4);
  });

  it("shows the trim keys in the rail", () => {
    seed();
    openEditor();
    expect(screen.getByText("In at the playhead")).toBeInTheDocument();
    expect(screen.getByText("Out at the playhead")).toBeInTheDocument();
    expect(screen.getByText("Hold to trim without snapping")).toBeInTheDocument();
  });

  it("undoes a rail change in its own history, not the canvas's", () => {
    seed();
    openEditor();
    const canvasUndo = vi.spyOn(wf(), "undo");
    // Stands in for WorkflowCanvas's window listener (bubble phase), which undoes on ⌘Z
    const canvas = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") wf().undo();
    };
    window.addEventListener("keydown", canvas);
    toggleClipAudio();
    expect(editor().draft!.timeline[0].muted).toBe(true);
    press(document.body, "z", { metaKey: true });
    expect(editor().draft!.timeline[0].muted).toBe(false);
    press(document.body, "z", { metaKey: true, shiftKey: true });
    expect(editor().draft!.timeline[0].muted).toBe(true);
    press(document.body, "z", { ctrlKey: true, altKey: true });
    window.removeEventListener("keydown", canvas);
    expect(canvasUndo).not.toHaveBeenCalled();
  });

  it("keeps modified canvas chords from the window listener too (arrange, AltGr undo, Shift+Alt+letter)", () => {
    seed();
    openEditor();
    const canvas = vi.fn();
    window.addEventListener("keydown", canvas);
    press(document.body, "g", { metaKey: true });
    press(document.body, "g", { ctrlKey: true, shiftKey: true });
    press(document.body, "v", { altKey: true });
    press(document.body, "z", { ctrlKey: true, altKey: true });
    press(document.body, "G", { shiftKey: true, altKey: true });
    press(document.body, "c", { metaKey: true });
    window.removeEventListener("keydown", canvas);
    expect(canvas).not.toHaveBeenCalled();
  });

  it("does not repeat a held ⌫ or Space", () => {
    seed();
    openEditor();
    press(document.body, "Backspace");
    press(document.body, "Backspace", { repeat: true });
    expect(editor().draft!.timeline.map((c) => c.id)).toEqual(["clip:eB"]);
    press(document.body, " ", { repeat: true });
    expect(editor().playing).toBe(false);
  });

  it("stops a focused button clicking on Space's keyup, except while the discard sheet is up", () => {
    seed();
    openEditor();
    const keyUp = () => {
      const event = new KeyboardEvent("keyup", { key: " ", bubbles: true, cancelable: true });
      act(() => {
        document.body.dispatchEvent(event);
      });
      return event.defaultPrevented;
    };
    expect(keyUp()).toBe(true);
    toggleClipAudio();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(keyUp()).toBe(false);
  });

  it("leaves a trim alone when its field is focused and left without typing", () => {
    seed();
    openEditor();
    act(() => editor().setPlayhead(1.23456));
    press(document.body, "i");
    expect(editor().draft!.timeline[0].inSec).toBe(1.23456);
    const past = editor().past.length;
    const field = screen.getByRole("textbox", { name: "In" }) as HTMLInputElement;
    act(() => field.focus());
    act(() => field.blur());
    act(() => field.focus());
    fireEvent.keyDown(field, { key: "Enter" });
    expect(editor().draft!.timeline[0].inSec).toBe(1.23456);
    expect(editor().past.length).toBe(past);
  });

  it("settles an In being typed when a transport button is pressed, so the next Space plays", () => {
    seed();
    const dialog = openEditor();
    const field = screen.getByRole("textbox", { name: "In" }) as HTMLInputElement;
    act(() => field.focus());
    fireEvent.change(field, { target: { value: "0:01.00" } });
    fireEvent.mouseDown(screen.getByRole("button", { name: "Play" }));
    expect(editor().draft!.timeline[0].inSec).toBe(1);
    expect(document.activeElement).toBe(dialog);
  });

  it("commits an In being typed to its own clip when another clip is right-clicked", () => {
    seed();
    openEditor();
    const field = screen.getByRole("textbox", { name: "In" }) as HTMLInputElement;
    act(() => field.focus());
    fireEvent.change(field, { target: { value: "0:02.00" } });
    const other = document.querySelector<HTMLElement>('[data-clip-id="clip:eB"]')!;
    fireEvent.pointerDown(other, { button: 2 });
    fireEvent.mouseDown(other, { button: 2 });
    fireEvent.contextMenu(other, { button: 2, clientX: 300, clientY: 400 });
    expect(editor().draft!.timeline.map((c) => c.inSec)).toEqual([2, 0]);
    expect(editor().selection).toEqual({ kind: "clip", clipId: "clip:eB" });
    expect(editor().menu).toMatchObject({ clipId: "clip:eB" });
  });

  it("gives focus back to Cancel when the discard sheet closes", () => {
    seed();
    openEditor();
    toggleClipAudio();
    const cancel = screen.getByRole("button", { name: "Cancel" });
    act(() => cancel.focus());
    fireEvent.click(cancel);
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(document.activeElement).toBe(cancel);
  });

  it("offers Split only when the playhead is inside the clip the rail shows", () => {
    seed();
    openEditor();
    act(() => editor().setPlayhead(2.5));
    const split = () => screen.getByRole("button", { name: /Split at playhead/ });
    expect(split()).toBeEnabled();
    act(() => editor().select({ kind: "clip", clipId: "clip:eB" }));
    expect(split()).toBeDisabled();
    act(() => editor().setPlayhead(7));
    expect(split()).toBeEnabled();
  });

  it("still calls an edge clip a video after its edge goes away", () => {
    seed();
    openEditor();
    act(() => useWorkflowStore.setState({ edges: wf().edges.filter((e) => e.id !== "eA") }));
    const rail = screen.getByRole("complementary", { name: "Clip" });
    expect(within(rail).getByText("Video")).toBeInTheDocument();
    expect(within(rail).queryByText("Library")).toBeNull();
  });

  it("opens empty on a node with no clips, with Done off", () => {
    seed({ clips: false });
    openEditor();
    expect(screen.getByText("0 clips")).toBeInTheDocument();
    expect(screen.getByText("No clips yet")).toBeInTheDocument();
    // Nothing to select, so the rail does not ask for a selection
    expect(screen.queryByText("Select a clip to trim it.")).toBeNull();
    expect(screen.getByRole("button", { name: "Done" })).toBeDisabled();
  });

  it("keeps Done off in an empty editor whatever the loop count, and the loop footer inert", () => {
    seed({ clips: false });
    openEditor();
    const loop = screen.getByRole("group", { name: "Loop", hidden: true }).closest("[inert]");
    expect(loop).not.toBeNull();
    // A loop count set another way (the footer cannot be reached) is still nothing to keep
    act(() => setLoopCount(2));
    expect(screen.getByRole("button", { name: "Done" })).toBeDisabled();
  });

  it("lets every clip be removed, and Done then disconnects their videos", () => {
    seed();
    openEditor();
    const remove = () => fireEvent.click(screen.getByRole("button", { name: /Remove from stitch/ }));
    remove();
    remove();
    expect(screen.getByText("0 clips")).toBeInTheDocument();
    const done = screen.getByRole("button", { name: "Done" });
    expect(done).toBeEnabled();
    fireEvent.click(done);
    expect(wf().edges).toEqual([]);
    expect(stitchData().timeline).toEqual([]);
  });

  it("opens a node whose clips all come from the library, labels them from the library, and Done writes them", () => {
    seed({
      clips: false,
      stitch: {
        timeline: [
          createClip({ kind: "asset", assetId: "alibrary00001" }, { id: "lib1" }),
          createClip({ kind: "asset", assetId: "alibrary00002" }, { id: "lib2" }),
        ],
      },
    });
    primeAssetInfo([
      { id: "alibrary00001", model: { provider: "kie", modelId: "veo3", displayName: "Veo 3.1" }, producer: { nodeId: "n", nodeType: "generateVideo" } },
      { id: "alibrary00002", producer: { nodeId: "n", nodeType: "videoStitch", operation: "stitch" } },
    ] as AssetView[]);
    __setMediaInfoForTests(assetMediaKey("alibrary00001"), { duration: 5, width: 1280, height: 720, fps: 24 });
    __setMediaInfoForTests(assetMediaKey("alibrary00002"), { duration: 3, width: 1280, height: 720, fps: 24 });
    const dialog = openEditor();
    expect(within(dialog).getByText("2 clips")).toBeInTheDocument();
    expect(within(dialog).getByText("0:08.00")).toBeInTheDocument();
    const rail = within(screen.getByRole("complementary"));
    expect(rail.getByText("Library · Veo 3.1 · 5.00 s")).toBeInTheDocument();
    // The second clip names what made it
    act(() => editor().select({ kind: "clip", clipId: "lib2" }));
    expect(rail.getByText("Library · Stitched · 3.00 s")).toBeInTheDocument();
    toggleClipAudio();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(stitchData().timeline).toEqual([
      expect.objectContaining({ id: "lib1", source: { kind: "asset", assetId: "alibrary00001" }, muted: false }),
      expect.objectContaining({ id: "lib2", source: { kind: "asset", assetId: "alibrary00002" }, muted: true }),
    ]);
    expect(wf().edges).toEqual([]);
  });

  it("shows a library clip the library no longer has as a slot that counts no time", () => {
    seed({
      stitch: {
        clipOrder: ["eA", "eB"],
        timeline: [
          createClip({ kind: "edge", edgeId: "eA" }, { id: "a" }),
          createClip({ kind: "asset", assetId: "agone00000001" }, { id: "lib" }),
          createClip({ kind: "edge", edgeId: "eB" }, { id: "b" }),
        ],
      },
    });
    __setMediaInfoForTests(assetMediaKey("agone00000001"), { duration: 6 });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
    const dialog = openEditor();
    return vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
      const slot = dialog.querySelector('[data-clip-id="lib"]');
      expect(slot).toHaveAttribute("data-empty-reason", "gone");
      expect(slot).toHaveTextContent("Clip 2 · not in the library");
      expect(within(dialog).getByText("0:09.00")).toBeInTheDocument();
    });
  });

  it("reads a library clip's record again when the editor opens, so one deleted since shows as gone", async () => {
    seed({
      stitch: {
        clipOrder: ["eA", "eB"],
        timeline: [
          createClip({ kind: "edge", edgeId: "eA" }, { id: "a" }),
          createClip({ kind: "asset", assetId: "alibrary00001" }, { id: "lib" }),
          createClip({ kind: "edge", edgeId: "eB" }, { id: "b" }),
        ],
      },
    });
    // Known from an earlier Add, and the card still holds its probe
    primeAssetInfo([{ id: "alibrary00001", producer: { nodeId: "n", nodeType: "generateVideo" } }] as AssetView[]);
    __setMediaInfoForTests(assetMediaKey("alibrary00001"), { duration: 6 });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
    const dialog = openEditor();
    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining("/api/assets/alibrary00001"), expect.anything());
      expect(dialog.querySelector('[data-clip-id="lib"]')).toHaveAttribute("data-empty-reason", "gone");
    });
    expect(within(dialog).getByText("0:09.00")).toBeInTheDocument();
  });

  it("shows a library clip as gone once the library says its file is missing, though the file was read before", async () => {
    seed({
      stitch: {
        clipOrder: ["eA", "eB"],
        timeline: [
          createClip({ kind: "edge", edgeId: "eA" }, { id: "a" }),
          createClip({ kind: "asset", assetId: "alibrary00001" }, { id: "lib" }),
          createClip({ kind: "edge", edgeId: "eB" }, { id: "b" }),
        ],
      },
    });
    const record = { id: "alibrary00001", producer: { nodeId: "n", nodeType: "generateVideo" } };
    primeAssetInfo([record] as AssetView[]);
    // The card read the file while it was there; a run has since got a 404 for it
    __setMediaInfoForTests(assetMediaKey("alibrary00001"), { duration: 6 });
    const notFound = async (): Promise<never> => {
      throw new Error("Not found");
    };
    __setMediaExtractorForTests({ probe: notFound, open: notFound });
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ ...record, missing: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const dialog = openEditor();
    await vi.waitFor(() => {
      expect(dialog.querySelector('[data-clip-id="lib"]')).toHaveAttribute("data-empty-reason", "gone");
      expect(within(dialog).getByText("0:09.00")).toBeInTheDocument();
    });
  });

  it("counts a library clip whose record says its file is missing once the file itself reads", () => {
    seed({
      stitch: {
        clipOrder: ["eA", "eB"],
        timeline: [
          createClip({ kind: "edge", edgeId: "eA" }, { id: "a" }),
          createClip({ kind: "asset", assetId: "alibrary00001" }, { id: "lib" }),
          createClip({ kind: "edge", edgeId: "eB" }, { id: "b" }),
        ],
      },
    });
    // A stale flag: the file route found the file again (as the encode will)
    primeAssetInfo([{ id: "alibrary00001", missing: true, producer: { nodeId: "n", nodeType: "generateVideo" } }] as AssetView[]);
    __setMediaInfoForTests(assetMediaKey("alibrary00001"), { duration: 6 });
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
    const dialog = openEditor();
    expect(dialog.querySelector('[data-clip-id="lib"]')).not.toHaveAttribute("data-empty-reason", "gone");
    expect(within(dialog).getByText("0:15.00")).toBeInTheDocument();
  });

  it("reads a library clip's file again when the editor opens, after an earlier read of it failed", async () => {
    seed({
      stitch: {
        clipOrder: ["eA", "eB"],
        timeline: [
          createClip({ kind: "edge", edgeId: "eA" }, { id: "a" }),
          createClip({ kind: "asset", assetId: "alibrary00001" }, { id: "lib" }),
          createClip({ kind: "edge", edgeId: "eB" }, { id: "b" }),
        ],
      },
    });
    primeAssetInfo([{ id: "alibrary00001", producer: { nodeId: "n", nodeType: "generateVideo" } }] as AssetView[]);
    // An earlier read of the file failed (a library job had it); the file is back now
    __setMediaInfoForTests(assetMediaKey("alibrary00001"), { status: "error", duration: null, level: null });
    const probe = vi.fn(async () => ({ duration: 6, width: 1280, height: 720, fps: 24 }));
    __setMediaExtractorForTests({ probe, open: () => new Promise(() => {}) });
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
    const dialog = openEditor();
    await vi.waitFor(() => {
      expect(dialog.querySelector('[data-clip-id="lib"]')).not.toHaveAttribute("data-empty-reason");
      expect(within(dialog).getByText("0:15.00")).toBeInTheDocument();
    });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("opens the library picker from the empty lane's placeholder", () => {
    seed({ clips: false });
    // The picker's list request never answers here
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
    openEditor();
    const placeholder = screen.getByTestId("stitch-empty-lane");
    expect(placeholder).toHaveAttribute("title", "Add from library");
    // No separate slot while the lane is empty
    expect(screen.queryByTestId("stitch-add-slot")).toBeNull();
    fireEvent.click(placeholder);
    expect(editor().pickerOpen).toBe(true);
    expect(screen.getByRole("dialog", { name: "Add from library" })).toBeInTheDocument();
    expect(screen.getByText("Pick videos to add")).toBeInTheDocument();
  });

  it("closes without writing when the canvas is replaced", () => {
    seed();
    openEditor();
    toggleClipAudio();
    act(() => useWorkflowStore.setState({ canvasGeneration: wf().canvasGeneration + 1 }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect("timeline" in stitchData()).toBe(false);
  });

  describe("in Stacked", () => {
    // Clip 1 is 5 s and clip 2 is 4 s: 9 s end to end, 8 s overlapping by 1 s
    const totalShown = (text: string) => screen.getAllByText(text).length > 0;
    const overlapField = () => screen.getByRole("textbox", { name: "Overlap" }) as HTMLInputElement;
    // The transport's toggle, as a user switches
    const layoutButton = (name: "Track" | "Stacked") =>
      within(screen.getByRole("group", { name: "Timeline layout" })).getByRole("button", { name });
    const stack = () => fireEvent.click(layoutButton("Stacked"));

    it("puts Track | Stacked at the transport's right end, after Fit and a divider", () => {
      seed();
      openEditor();
      const toggle = screen.getByRole("group", { name: "Timeline layout" });
      const fit = screen.getByRole("button", { name: "Fit" });
      // The transport's last control, after a divider and Fit
      const transport = toggle.parentElement!;
      expect(transport.contains(fit)).toBe(true);
      expect(transport.lastElementChild).toBe(toggle);
      const divider = toggle.previousElementSibling!;
      expect(divider).toHaveAttribute("aria-hidden", "true");
      expect(divider).toHaveClass("w-px");
      expect(divider.previousElementSibling).toBe(fit);
      // Not in the header, nor in the timeline
      expect(screen.getByRole("button", { name: "Undo" }).parentElement!.parentElement!.contains(toggle)).toBe(false);
      expect(screen.getByRole("listbox", { name: "Clips" }).closest(".bg-editor-lanes")!.contains(toggle)).toBe(false);
      // It switches from there, and back
      stack();
      expect(editor().draft!.sequenceLayout.mode).toBe("stacked");
      expect(toggle.isConnected).toBe(true);
      expect(screen.getByRole("group", { name: "Timeline layout" })).toBe(toggle);
      fireEvent.click(layoutButton("Track"));
      expect(editor().draft!.sequenceLayout.mode).toBe("track");
      expect(editor().past).toHaveLength(2);
    });

    it("switches to Stacked from the transport, which shows Overlap, Crossfade and what they do; Track hides them", () => {
      seed();
      openEditor();
      expect(screen.queryByRole("textbox", { name: "Overlap" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Crossfade" })).toBeNull();
      stack();
      expect(overlapField().value).toBe("1.0 s");
      expect(screen.getByRole("button", { name: "Crossfade" })).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByText("Each join blends over 1.0 s.")).toBeInTheDocument();
      expect(screen.getByText("Loop sequence")).toBeInTheDocument();
      expect(totalShown("0:08.00")).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "Crossfade" }));
      expect(editor().draft!.sequenceLayout.crossfade).toBe(false);
      expect(screen.getByRole("button", { name: "Crossfade" })).toHaveAttribute("aria-pressed", "false");
      expect(screen.getByText("Each clip starts 1.0 s early, under the clip above. Both are heard.")).toBeInTheDocument();
      expect(layoutButton("Stacked")).toHaveAttribute("aria-pressed", "true");
      fireEvent.click(layoutButton("Track"));
      expect(editor().draft!.sequenceLayout.mode).toBe("track");
      expect(layoutButton("Track")).toHaveAttribute("aria-pressed", "true");
      expect(screen.queryByRole("textbox", { name: "Overlap" })).toBeNull();
      expect(totalShown("0:09.00")).toBe(true);
    });

    it("puts Crossfade in the transport beside Sound, and the summary above the Overlap row, which rests on Loop", () => {
      seed();
      openEditor();
      stack();
      const crossfade = screen.getByRole("button", { name: "Crossfade" });
      // In the transport, after Sound: out of the rail, so nothing the summary says can move it
      expect(crossfade.previousElementSibling).toBe(screen.getByRole("button", { name: "Sound" }));
      expect(screen.getByRole("complementary", { name: "Clip" }).contains(crossfade)).toBe(false);
      const row = overlapField().closest(".h-9")!;
      const footer = row.parentElement!;
      // The line first, the row last, then Loop sequence: what the line says changes the height above the row only
      const line = screen.getByText("Each join blends over 1.0 s.");
      expect(footer.firstElementChild).toBe(line);
      expect(footer.lastElementChild).toBe(row);
      expect(footer.nextElementSibling).toHaveTextContent("Loop sequence");
      // One sentence, nothing reserved: the other crossfade sentence is not in the page
      expect(footer.querySelectorAll("p")).toHaveLength(1);
      expect(screen.queryByText("Each clip starts 1.0 s early, under the clip above. Both are heard.")).toBeNull();
      // In a short window the line is cut before the row moves; its full text is on hover
      expect(line).toHaveAttribute("title", "Each join blends over 1.0 s.");
      // Pressing Crossfade blurs a typed Overlap, which commits: the line follows at once, with no hold, and the row
      // stays the footer's last element
      fireEvent.pointerDown(crossfade);
      act(() => setOverlapSec(3));
      expect(line).toHaveTextContent(
        "Each join blends over 3.0 s. The join into Clip 2 is 2.00 s: an overlap is at most half a clip.",
      );
      expect(line).toHaveAttribute("title", line.textContent);
      expect(footer.firstElementChild).toBe(line);
      expect(footer.lastElementChild).toBe(row);
      fireEvent.click(crossfade);
      expect(editor().draft!.sequenceLayout).toEqual({ mode: "stacked", overlapSec: 3, crossfade: false });
      expect(footer.lastElementChild).toBe(row);
    });

    it("leaves the transport's toggle inert while there are no clips", () => {
      seed({ clips: false });
      openEditor();
      expect(screen.getByRole("group", { name: "Timeline layout", hidden: true })).toHaveAttribute("inert");
    });

    it("takes a typed Overlap, shortens the sequence by it, and ⌘Z puts it back", () => {
      seed();
      openEditor();
      stack();
      const field = overlapField();
      field.focus();
      fireEvent.focus(field);
      fireEvent.change(field, { target: { value: "2" } });
      fireEvent.keyDown(field, { key: "Enter" });
      expect(editor().draft!.sequenceLayout.overlapSec).toBe(2);
      expect(totalShown("0:07.00")).toBe(true);
      press(document.body, "z", { metaKey: true });
      expect(editor().draft!.sequenceLayout.overlapSec).toBe(1);
      expect(overlapField().value).toBe("1.0 s");
      expect(totalShown("0:08.00")).toBe(true);
    });

    it("names a join the half-clip cap shortens", () => {
      seed();
      openEditor();
      stack();
      act(() => setOverlapSec(3));
      expect(
        screen.getByText("Each join blends over 3.0 s. The join into Clip 2 is 2.00 s: an overlap is at most half a clip."),
      ).toBeInTheDocument();
    });

    it("writes the layout on Done, in the same single write", () => {
      seed();
      openEditor();
      // An earlier test's spy can outlive its restore: the store copies the spied function into each new state
      const write = vi.spyOn(wf(), "updateNodeData");
      write.mockClear();
      stack();
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
      expect(write).toHaveBeenCalledTimes(1);
      expect(write.mock.calls[0][1]).toEqual({
        timeline: [expect.objectContaining({ id: "clip:eA" }), expect.objectContaining({ id: "clip:eB" })],
        audioCurve: [],
        audioMuted: false,
        loopCount: 1,
        clipOrder: ["eA", "eB"],
        sequenceLayout: { mode: "stacked", overlapSec: 1, crossfade: true },
      });
    });

    it("says which layout change Cancel would drop", () => {
      seed();
      openEditor();
      stack();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      const sheet = screen.getByRole("dialog", { name: "Discard changes?" });
      expect(within(sheet).getByText("The switch to Stacked will be lost. The node keeps what it had.")).toBeInTheDocument();
    });

    it("turns Split off inside an overlap and says why", () => {
      seed();
      openEditor();
      stack();
      const split = () => screen.getByRole("button", { name: /Split at playhead/ });
      act(() => editor().setPlayhead(4.5));
      expect(split()).toBeDisabled();
      expect(split()).toHaveAttribute("title", "Move the playhead out of the overlap to split");
      act(() => editor().setPlayhead(2.5));
      expect(split()).toBeEnabled();
      expect(split()).not.toHaveAttribute("title");
    });

    it("leaves Track's elements to their classes after switching back from Stacked while playing", () => {
      seed();
      openEditor();
      stack();
      act(() => editor().setPlaying(true));
      act(() => setSequenceMode("track"));
      expect(editor().playing).toBe(false);
      const videos = [...screen.getByTestId("stitch-preview").querySelectorAll("video")];
      expect(videos).toHaveLength(2);
      expect(videos.map((v) => v.style.opacity)).toEqual(["", ""]);
      expect(videos.filter((v) => v.classList.contains("opacity-100"))).toHaveLength(1);
    });

    // As a mouse does it: the toggle keeps focus where it was on mousedown, then the click switches
    const pressLayout = (name: "Track" | "Stacked") => {
      fireEvent.mouseDown(layoutButton(name));
      fireEvent.click(layoutButton(name));
    };
    // A Stacked box's name also says where it starts ("Clip 2, starts 0:04.00")
    const option = (name: string) =>
      within(screen.getByRole("listbox", { name: "Clips" })).getByRole("option", { name: new RegExp(`^${name}(,|$)`) });

    it("keeps focus in the dialog, on the new lane's clip, when a switch removes the focused clip", () => {
      seed();
      const dialog = openEditor();
      act(() => editor().select({ kind: "clip", clipId: "clip:eB" }));
      act(() => option("Clip 2").focus());
      pressLayout("Stacked");
      expect(editor().draft!.sequenceLayout.mode).toBe("stacked");
      expect(document.activeElement).toBe(option("Clip 2"));
      // ⌘Z from a focused stacked clip switches back: focus lands on Track's clip
      press(document.activeElement!, "z", { metaKey: true });
      expect(editor().draft!.sequenceLayout.mode).toBe("track");
      expect(document.activeElement).toBe(option("Clip 2"));
      expect(dialog.contains(document.activeElement)).toBe(true);
    });

    it("keeps focus in the dialog when Track takes away the focused Crossfade button", () => {
      seed();
      const dialog = openEditor();
      stack();
      const crossfade = screen.getByRole("button", { name: "Crossfade" });
      act(() => crossfade.focus());
      fireEvent.click(crossfade);
      pressLayout("Track");
      expect(editor().draft!.sequenceLayout.mode).toBe("track");
      expect(document.activeElement).not.toBe(document.body);
      expect(dialog.contains(document.activeElement)).toBe(true);
    });

    it("commits an Overlap being typed when Track is clicked, and keeps focus in the dialog", () => {
      seed();
      const dialog = openEditor();
      stack();
      const field = overlapField();
      act(() => field.focus());
      fireEvent.focus(field);
      fireEvent.change(field, { target: { value: "3" } });
      pressLayout("Track");
      expect(editor().draft!.sequenceLayout).toEqual({ mode: "track", overlapSec: 3, crossfade: true });
      expect(dialog.contains(document.activeElement)).toBe(true);
      // Two undo steps: the overlap, then the switch
      press(document.body, "z", { metaKey: true });
      expect(editor().draft!.sequenceLayout).toEqual({ mode: "stacked", overlapSec: 3, crossfade: true });
    });

    it("shows the frame under the playhead after switching back to Track at Overlap 0, and on ⌘Z and ⇧⌘Z", () => {
      seed();
      openEditor();
      stack();
      act(() => setOverlapSec(0));
      act(() => editor().setPlayhead(7.5));
      const clip2 = () =>
        [...screen.getByTestId("stitch-preview").querySelectorAll("video")].find((v) => v.getAttribute("src") === "blob:b")!;
      expect(clip2().currentTime).toBeCloseTo(2.5, 6);
      // Track mounts its own elements; the spans and the playhead are the same as Stacked's at Overlap 0
      act(() => setSequenceMode("track"));
      expect(clip2().currentTime).toBeCloseTo(2.5, 6);
      press(document.body, "z", { metaKey: true });
      expect(editor().draft!.sequenceLayout.mode).toBe("stacked");
      expect(clip2().currentTime).toBeCloseTo(2.5, 6);
      press(document.body, "z", { metaKey: true, shiftKey: true });
      expect(editor().draft!.sequenceLayout.mode).toBe("track");
      expect(clip2().currentTime).toBeCloseTo(2.5, 6);
    });

    it("stops playing on a switch of layout, and on the ⌘Z that switches it back", async () => {
      seed();
      openEditor();
      const play = vi.spyOn(HTMLMediaElement.prototype, "play");
      act(() => editor().setPlaying(true));
      expect(editor().playing).toBe(true);
      expect(play).toHaveBeenCalled();
      stack();
      expect(editor().playing).toBe(false);
      // One <video> per clip now
      expect(screen.getByTestId("stitch-preview").querySelectorAll("video")).toHaveLength(2);

      act(() => editor().setPlaying(true));
      expect(editor().playing).toBe(true);
      press(document.body, "z", { metaKey: true });
      expect(editor().draft!.sequenceLayout.mode).toBe("track");
      expect(editor().playing).toBe(false);
      // Nothing is started again once the loop has gone
      const calls = play.mock.calls.length;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      expect(play).toHaveBeenCalledTimes(calls);
      expect(editor().playing).toBe(false);
    });

    describe("with clips placed in time", () => {
      const startField = () => screen.getByRole("textbox", { name: "Start on the timeline" }) as HTMLInputElement;
      const selectClip2 = () => act(() => editor().select({ kind: "clip", clipId: "clip:eB" }));
      const summary = () => screen.getByRole("textbox", { name: "Overlap" }).closest(".h-9")!.previousElementSibling!;

      it("shows Start in Stacked only, above Trim", () => {
        seed();
        openEditor();
        expect(screen.queryByRole("textbox", { name: "Start on the timeline" })).toBeNull();
        stack();
        const rail = screen.getByRole("complementary", { name: "Clip" });
        expect(within(rail).getByText("Start")).toBeInTheDocument();
        expect(startField().value).toBe("0:00.00");
        const trim = within(rail).getByText("Trim");
        expect(startField().compareDocumentPosition(trim) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        selectClip2();
        expect(startField().value).toBe("0:04.00");
      });

      it("moves the clip to a typed Start, the header's total with it, and Done writes it in the single write", () => {
        seed();
        openEditor();
        stack();
        selectClip2();
        const field = startField();
        field.focus();
        fireEvent.focus(field);
        fireEvent.change(field, { target: { value: "6" } });
        fireEvent.keyDown(field, { key: "Enter" });
        expect(editor().draft!.timeline.map((clip) => clip.startSec)).toEqual([0, 6]);
        expect(startField().value).toBe("0:06.00");
        expect(totalShown("0:10.00")).toBe(true);

        const write = vi.spyOn(wf(), "updateNodeData");
        write.mockClear();
        fireEvent.click(screen.getByRole("button", { name: "Done" }));
        expect(write).toHaveBeenCalledTimes(1);
        expect((write.mock.calls[0][1] as Partial<VideoStitchNodeData>).timeline!.map((clip) => clip.startSec)).toEqual([
          0, 6,
        ]);
      });

      it("steps the Start well with ↑, as one undo step until it is left", () => {
        seed();
        openEditor();
        stack();
        selectClip2();
        const field = startField();
        field.focus();
        fireEvent.focus(field);
        fireEvent.keyDown(field, { key: "ArrowUp" });
        fireEvent.keyDown(field, { key: "ArrowUp" });
        fireEvent.keyDown(field, { key: "ArrowUp", shiftKey: true });
        expect(editor().draft!.timeline[1].startSec).toBeCloseTo(5.2, 9);
        const steps = editor().past.length;
        fireEvent.blur(field);
        act(() => editor().setPlayhead(0));
        fireEvent.focus(startField());
        fireEvent.keyDown(startField(), { key: "ArrowDown" });
        expect(editor().past.length).toBe(steps + 1);
      });

      it("writes a clip moved by its box in Done's single write, the total with it on release", () => {
        seed();
        openEditor();
        stack();
        act(() => editor().setZoom(64));
        const pointer = (type: "pointermove" | "pointerup", clientX: number) =>
          act(() => {
            window.dispatchEvent(new MouseEvent(type, { clientX, clientY: 78, bubbles: true }));
          });
        // Clip 2 (4 s) a second later, by its box
        fireEvent.pointerDown(option("Clip 2"), { button: 0, pointerId: 1, clientX: 400, clientY: 78 });
        pointer("pointermove", 464);
        expect(editor().draft!.timeline.map((clip) => clip.startSec)).toEqual([undefined, undefined]);
        expect(totalShown("0:08.00")).toBe(true);
        pointer("pointerup", 464);
        expect(editor().draft!.timeline.map((clip) => clip.startSec)).toEqual([0, 5]);
        expect(totalShown("0:09.00")).toBe(true);
        expect(option("Clip 2")).toHaveAttribute("aria-label", "Clip 2, starts 0:05.00");

        const write = vi.spyOn(wf(), "updateNodeData");
        write.mockClear();
        fireEvent.click(screen.getByRole("button", { name: "Done" }));
        expect(write).toHaveBeenCalledTimes(1);
        expect((write.mock.calls[0][1] as Partial<VideoStitchNodeData>).timeline!.map((clip) => clip.startSec)).toEqual([
          0, 5,
        ]);
      });

      it("says Cancel would lose a moved clip", () => {
        seed();
        openEditor();
        stack();
        act(() => setClipStart("clip:eB", 6));
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
        const sheet = screen.getByRole("dialog", { name: "Discard changes?" });
        expect(
          within(sheet).getByText("A moved clip and the switch to Stacked will be lost. The node keeps what it had."),
        ).toBeInTheDocument();
      });

      it("splits inside a placed overlap, with no title on Split", () => {
        seed();
        openEditor();
        stack();
        act(() => setClipStart("clip:eB", 3));
        selectClip2();
        act(() => editor().setPlayhead(4));
        const split = screen.getByRole("button", { name: /Split at playhead/ });
        expect(split).toBeEnabled();
        expect(split).not.toHaveAttribute("title");
      });

      it("says what a placed stack does: where clips sit, how they layer, a clip hidden, the gaps", () => {
        seed({ music: true });
        openEditor();
        stack();
        // Clip 2 (4 s) wholly under Clip 1 (5 s), which is the higher row
        act(() => setClipStart("clip:eB", 0.5));
        expect(summary()).toHaveTextContent(
          "Clips sit where you put them. Overlap applies to new clips and to Line up. Where clips overlap, the higher " +
            "row fades in or out over the rows below. Clip 2 is hidden under a higher row.",
        );
        act(() => setCrossfade(false));
        expect(summary()).toHaveTextContent(
          "Clips sit where you put them. Overlap applies to new clips and to Line up. Where clips overlap, the higher " +
            "row is in front. Every clip that plays is heard. Clip 2 is hidden under a higher row.",
        );
        act(() => setClipStart("clip:eB", 6));
        expect(summary()).toHaveTextContent(
          "Clips sit where you put them. Overlap applies to new clips and to Line up. None overlap. 1 gap plays black. " +
            "The music plays on.",
        );
        expect(screen.getByText("Overlap")).toHaveAttribute(
          "title",
          "How far each clip overlaps the one above when lined up, and where new clips go.",
        );
      });

      it("shows the whole summary where the rail has room, and holds its height from a press in the rail until the click", async () => {
        seed();
        openEditor();
        stack();
        selectClip2();
        const line = summary() as HTMLElement;
        // No fixed cap: only a window too short for it cuts the line (the rail body gives its room first)
        expect(line.className).not.toMatch(/max-h-/);
        expect(line).toHaveAttribute("title", line.textContent);
        vi.spyOn(line, "offsetHeight", "get").mockReturnValue(50);
        const split = screen.getByRole("button", { name: /Split at playhead/ });
        fireEvent.pointerDown(split, { button: 0, pointerId: 1 });
        // A commit the press makes cannot shrink the line under the pointer
        expect(line.style.minHeight).toBe("50px");
        act(() => {
          window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
        });
        expect(line.style.minHeight).toBe("50px");
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(line.style.minHeight).toBe("");
      });

      it("lists the placing keys under the clip actions in Stacked, and the trim keys in Track", () => {
        seed();
        openEditor();
        const rail = () => within(screen.getByRole("complementary", { name: "Clip" }));
        expect(rail().getByText("Hold to trim without snapping")).toBeInTheDocument();
        expect(rail().queryByText("Start at the playhead")).toBeNull();
        stack();
        for (const text of [
          "In at the playhead",
          "Out at the playhead",
          "Start at the playhead",
          "End at the playhead",
          "With ← → nudge a frame, with ↑ ↓ change row",
          "Hold to move or trim without snapping",
        ]) {
          expect(rail().getByText(text)).toBeInTheDocument();
        }
      });

      it("handles ⌥← in Track as a key that does nothing, so the browser does not go back", () => {
        seed();
        openEditor();
        selectClip2();
        const before = editor().draft;
        const event = new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, bubbles: true, cancelable: true });
        act(() => {
          document.body.dispatchEvent(event);
        });
        expect(event.defaultPrevented).toBe(true);
        expect(editor().draft).toBe(before);
      });

      it("nudges the selected clip a frame with ⌥→ in Stacked, and moves its row with ⌥↑", () => {
        seed();
        openEditor();
        stack();
        selectClip2();
        press(document.body, "ArrowRight", { altKey: true });
        expect(editor().draft!.timeline[1].startSec).toBeCloseTo(4 + 1 / 60, 9);
        press(document.body, "ArrowUp", { altKey: true });
        expect(editor().draft!.timeline.map((clip) => clip.id)).toEqual(["clip:eB", "clip:eA"]);
        expect(editor().draft!.timeline[0].startSec).toBeCloseTo(4 + 1 / 60, 9);
      });

      it("plays the placed layers by the envelope: hidden clips at opacity 0, black in a gap", () => {
        seed();
        openEditor();
        stack();
        act(() => setClipStart("clip:eB", 0.5));
        act(() => editor().setPlayhead(2));
        const videos = () => [...screen.getByTestId("stitch-preview").querySelectorAll("video")];
        // Row order in the DOM: Clip 1 covers Clip 2
        expect(videos().map((v) => v.style.opacity)).toEqual(["1", "0"]);
        act(() => setClipStart("clip:eB", 6));
        act(() => editor().setPlayhead(5.5));
        expect(videos().map((v) => v.style.opacity)).toEqual(["0", "0"]);
      });
    });
  });
});
