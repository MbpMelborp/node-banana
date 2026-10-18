import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useRef } from "react";
import { useWorkflowStore } from "@/store/workflowStore";
import { audioSelectionOf, useStitchEditorStore } from "@/store/stitchEditorStore";
import { useStitchClipboard } from "@/store/stitchClipboardStore";
import { requestSave, useSaveRequestStore } from "@/store/saveRequestStore";
import {
  __resetMediaInfoForTests,
  __setMediaExtractorForTests,
  __setMediaInfoForTests,
  assetMediaKey,
  mediaKeyOf,
} from "@/lib/stitch/mediaInfo";
import { __resetAssetInfoForTests, primeAssetInfo } from "@/lib/stitch/assetInfo";
import { createClip } from "@/lib/stitch/timeline";
import { createAudioClip, MUSIC_CLIP_ID } from "@/lib/stitch/audioClips";
import { musicAudio } from "@/lib/stitch/draft";
import type { AssetView } from "@/lib/assets/types";
import { StitchEditorModal } from "../StitchEditorModal";
import { EditorWorkspace } from "../EditorWorkspace";
import { useEditorComposition } from "../useEditorComposition";
import { openStitchEditor } from "../openStitchEditor";
import { libraryDrop } from "../timeline/libraryDrop";
import { setClipStart, setLoopCount, setOverlapSec, setSequenceMode } from "../editorActions";
import type { StitchAudioClip, VideoStitchNodeData, WorkflowEdge, WorkflowNode } from "@/types";

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
  return screen.getByRole("dialog", { name: "Edit video" });
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

  it("renders nothing for an edit project's session, which belongs to the Edit video view", () => {
    seed();
    render(<StitchEditorModal />);
    act(() =>
      editor().openEdit({
        editId: "e1",
        draft: {
          timeline: [createClip({ kind: "asset", assetId: "aclip00000001" })],
          audioClips: [],
          legacyAudio: { curve: [], muted: false },
          loopCount: 1,
          sequenceLayout: { mode: "track", overlapSec: 0.5, crossfade: true },
        },
      }),
    );
    expect(editor().isOpen).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
    // Nor does a node's Expand take the session from it
    act(() => {
      expect(openStitchEditor("stitch")).toBe(false);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(editor().editId).toBe("e1");
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
    expect(musicAudio(editor().draft!).muted).toBe(false);
    act(() => editor().close());

    seed({ stitch: { audioMuted: true } });
    act(() => {
      openStitchEditor("stitch");
    });
    press(document.body, "m");
    expect(musicAudio(editor().draft!).muted).toBe(false);
    act(() => editor().close());

    seed({ music: true });
    act(() => {
      openStitchEditor("stitch");
    });
    press(document.body, "m");
    expect(musicAudio(editor().draft!).muted).toBe(true);
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

  it("saves with Save and stays open: one write, Save off again, and Cancel then closes without asking", () => {
    seed();
    openEditor();
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    toggleClipAudio();
    expect(save).toBeEnabled();
    // A spy an earlier test left on the store's state rides into this one's state: count from here
    const write = vi.spyOn(wf(), "updateNodeData");
    write.mockClear();
    fireEvent.click(save);
    expect(write).toHaveBeenCalledTimes(1);
    expect(stitchData().timeline![0].muted).toBe(true);
    expect(screen.getByRole("dialog", { name: "Edit video" })).toBeInTheDocument();
    expect(save).toBeDisabled();
    // The workflow file is the floating menu's to write: Save asked for it
    expect(useSaveRequestStore.getState().request).toMatchObject({ reason: "button" });
    act(() => useSaveRequestStore.getState().consumeRequest());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Discard changes?" })).toBeNull();
    expect(editor().isOpen).toBe(false);
    expect(stitchData().timeline![0].muted).toBe(true);
  });

  it("puts the open edit in the node when the workflow is saved some other way (⌘S, File › Save)", () => {
    seed();
    openEditor();
    toggleClipAudio();
    act(() => requestSave("shortcut"));
    expect(stitchData().timeline![0].muted).toBe(true);
    expect(editor().isOpen).toBe(true);
    act(() => useSaveRequestStore.getState().consumeRequest());
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
    expect(screen.getByRole("dialog", { name: "Edit video" })).toBeInTheDocument();

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
    expect(screen.getByRole("dialog", { name: "Edit video" })).toBeInTheDocument();
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
    act(() => editor().openMenu({ kind: "clip", clipId: "clip:eA", x: 10, y: 10 }));
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

  it("keeps the zoom slider at every width: only the Edit video view drops it when narrow", () => {
    seed();
    openEditor();
    const slider = screen.getByRole("slider", { name: "Timeline zoom" });
    expect(slider.className).not.toContain("@max-");
    expect(slider.parentElement!.className).not.toContain("@container");
    for (const name of ["Zoom out", "Zoom in"]) {
      expect(screen.getByRole("button", { name }).className).not.toContain("@max-");
    }
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
    const remove = () => fireEvent.click(screen.getByRole("button", { name: /Remove clip/ }));
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
    expect(rail.getByText("Library · Video edit · 3.00 s")).toBeInTheDocument();
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
    expect(editor().pickerOpen).toBe("video");
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

    it("switches to Stacked from the transport, which shows Crossfade; Track hides it", () => {
      seed();
      openEditor();
      expect(screen.queryByRole("button", { name: "Crossfade" })).toBeNull();
      stack();
      expect(screen.getByRole("button", { name: "Crossfade" })).toHaveAttribute("aria-pressed", "true");
      expect(totalShown("0:08.00")).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "Crossfade" }));
      expect(editor().draft!.sequenceLayout.crossfade).toBe(false);
      expect(screen.getByRole("button", { name: "Crossfade" })).toHaveAttribute("aria-pressed", "false");
      expect(layoutButton("Stacked")).toHaveAttribute("aria-pressed", "true");
      fireEvent.click(layoutButton("Track"));
      expect(editor().draft!.sequenceLayout.mode).toBe("track");
      expect(layoutButton("Track")).toHaveAttribute("aria-pressed", "true");
      expect(screen.queryByRole("button", { name: "Crossfade" })).toBeNull();
      expect(totalShown("0:09.00")).toBe(true);
    });

    it("puts Crossfade in the transport beside Sound, and leaves the rail's footer to Loop sequence", () => {
      seed();
      openEditor();
      stack();
      const crossfade = screen.getByRole("button", { name: "Crossfade" });
      expect(crossfade.previousElementSibling).toBe(screen.getByRole("button", { name: "Sound" }));
      const rail = screen.getByRole("complementary", { name: "Clip" });
      expect(rail.contains(crossfade)).toBe(false);
      // No Overlap well and no summary line in Stacked: the footer is Loop sequence alone, as in Track
      expect(within(rail).queryByRole("textbox", { name: "Overlap" })).toBeNull();
      expect(screen.queryByTestId("stitch-sequence-summary")).toBeNull();
      expect(within(rail).getByText("Loop sequence")).toBeInTheDocument();
    });
    it("leaves the transport's toggle inert while there are no clips", () => {
      seed({ clips: false });
      openEditor();
      expect(screen.getByRole("group", { name: "Timeline layout", hidden: true })).toHaveAttribute("inert");
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

    it("commits a Start being typed when Track is clicked, and keeps focus in the dialog", () => {
      seed();
      const dialog = openEditor();
      stack();
      const field = screen.getByRole("textbox", { name: "Start on the timeline" });
      act(() => field.focus());
      fireEvent.focus(field);
      fireEvent.change(field, { target: { value: "2" } });
      pressLayout("Track");
      expect(editor().draft!.sequenceLayout.mode).toBe("track");
      expect(editor().draft!.timeline[0].startSec).toBe(2);
      expect(dialog.contains(document.activeElement)).toBe(true);
      // Two undo steps: the start, then the switch
      press(document.body, "z", { metaKey: true });
      expect(editor().draft!.sequenceLayout.mode).toBe("stacked");
      expect(editor().draft!.timeline[0].startSec).toBe(2);
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

describe("EditorWorkspace", () => {
  function Workspace({ onLoadingChange }: { onLoadingChange: (keys: ReadonlySet<string>) => void }) {
    const rootRef = useRef<HTMLDivElement>(null);
    const composition = useEditorComposition(rootRef, 0);
    return (
      <div ref={rootRef}>
        <EditorWorkspace composition={composition} onLoadingChange={onLoadingChange} />
      </div>
    );
  }

  it("reports the clips whose media is still loading, and again once it has loaded", () => {
    seed();
    __resetMediaInfoForTests();
    __setMediaInfoForTests(mediaKeyOf("blob:a"), { duration: 5, width: 1920, height: 1080, fps: 24 });
    act(() => {
      openStitchEditor("stitch");
    });
    const onLoadingChange = vi.fn();
    render(<Workspace onLoadingChange={onLoadingChange} />);
    expect([...onLoadingChange.mock.lastCall![0]]).toEqual(["edge:eB"]);

    act(() => __setMediaInfoForTests(mediaKeyOf("blob:b"), { status: "ready", duration: 4, width: 1280, height: 720, fps: 24 }));
    expect([...onLoadingChange.mock.lastCall![0]]).toEqual([]);
  });
});

describe("the Timeline and a library drag", () => {
  it("offers its lanes to a library drag while mounted, and draws no drop marker in the dialog", () => {
    seed();
    const view = render(<StitchEditorModal />);
    act(() => {
      openStitchEditor("stitch");
    });
    expect(libraryDrop.lanes()).toBe(screen.getByTestId("stitch-lanes"));
    expect(screen.queryByTestId("library-drop-marker")).toBeNull();
    view.unmount();
    expect(libraryDrop.lanes()).toBeNull();
  });
});

describe("StitchEditorModal, several clips", () => {
  /** Three clips: A 5 s (trimmed to start at 1 s), B 4 s muted, C 6 s. */
  function seedThree() {
    useWorkflowStore.setState({
      nodes: [
        node("gen-a", "generateVideo", { outputVideo: "blob:a" }),
        node("gen-b", "generateVideo", { outputVideo: "blob:b" }),
        node("gen-c", "generateVideo", { outputVideo: "blob:c" }),
        node("stitch", "videoStitch", {
          clips: [],
          clipOrder: ["eA", "eB", "eC"],
          outputVideo: null,
          loopCount: 1,
          status: "idle",
          timeline: [
            { id: "clip:eA", source: { kind: "edge", edgeId: "eA" }, inSec: 1, outSec: null, muted: false, volume: 1 },
            { id: "clip:eB", source: { kind: "edge", edgeId: "eB" }, inSec: 0, outSec: null, muted: true, volume: 1 },
            { id: "clip:eC", source: { kind: "edge", edgeId: "eC" }, inSec: 0, outSec: null, muted: false, volume: 1 },
          ],
        }),
      ],
      edges: [edge("eA", "gen-a", "video-0"), edge("eB", "gen-b", "video-1"), edge("eC", "gen-c", "video-2")],
      openModalCount: 0,
      isModalOpen: false,
    });
    __setMediaInfoForTests(mediaKeyOf("blob:a"), { duration: 5, width: 1920, height: 1080, fps: 24 });
    __setMediaInfoForTests(mediaKeyOf("blob:b"), { duration: 4, width: 1920, height: 1080, fps: 24 });
    __setMediaInfoForTests(mediaKeyOf("blob:c"), { duration: 6, width: 1920, height: 1080, fps: 24 });
  }
  const selectAll = () =>
    act(() => editor().select({ kind: "clip", clipId: "clip:eA", clipIds: ["clip:eA", "clip:eB", "clip:eC"] }));
  const rail = () => screen.getByRole("complementary", { name: "Clip" });
  const order = () => editor().draft!.timeline.map((c) => c.id);
  const mod = { metaKey: true };
  /**
   * A keydown on target: whether it was prevented, and whether a bubbling listener on the document or the window
   * (where the canvas listens), added after the editor's, heard it.
   */
  const keyOn = (target: EventTarget, key: string, init: KeyboardEventInit = mod) => {
    const heard = vi.fn();
    document.addEventListener("keydown", heard);
    window.addEventListener("keydown", heard);
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    act(() => {
      target.dispatchEvent(event);
    });
    document.removeEventListener("keydown", heard);
    window.removeEventListener("keydown", heard);
    return { prevented: event.defaultPrevented, heard: heard.mock.calls.length > 0 };
  };

  beforeEach(() => {
    useStitchClipboard.getState().setClipboard(null);
  });
  afterEach(() => {
    window.getSelection()?.removeAllRanges();
  });

  it("shows how many and which in the rail, and what applies to all of them", () => {
    seedThree();
    openEditor();
    selectAll();
    expect(within(rail()).getByText("3 clips")).toBeInTheDocument();
    expect(within(rail()).getByText("Clip 1, Clip 2 and Clip 3")).toBeInTheDocument();
    expect(within(rail()).getByText("3 / 3")).toBeInTheDocument();
    // No trims, Start or Volume: they are one clip's
    expect(screen.queryByRole("textbox", { name: "In" })).toBeNull();
    expect(screen.queryByRole("slider", { name: "Clip volume" })).toBeNull();
    // One muted and two not: neither On nor Off is pressed, and "Mixed" sits beside them at the row's right
    const sound = within(rail()).getByRole("group", { name: "Clip audio" });
    expect(within(sound).getAllByRole("button").filter((b) => b.getAttribute("aria-pressed") === "true")).toHaveLength(0);
    const wrapper = sound.parentElement!;
    expect(within(wrapper).getByText("Mixed")).toBeInTheDocument();
    expect(wrapper.parentElement!.children).toHaveLength(2);
    expect(wrapper.parentElement!.lastElementChild).toBe(wrapper);

    fireEvent.click(within(sound).getByRole("button", { name: "Off" }));
    expect(editor().draft!.timeline.every((c) => c.muted)).toBe(true);
    expect(editor().past).toHaveLength(1);
    expect(within(sound).getByRole("button", { name: "Off" })).toHaveAttribute("aria-pressed", "true");
    expect(within(rail()).queryByText("Mixed")).toBeNull();
    fireEvent.click(within(sound).getByRole("button", { name: "On" }));
    expect(editor().draft!.timeline.every((c) => !c.muted)).toBe(true);
    expect(editor().past).toHaveLength(2);

    // Clip 1 is trimmed, so Reset trim is on
    fireEvent.click(within(rail()).getByRole("button", { name: "Reset trim" }));
    expect(editor().draft!.timeline[0].inSec).toBe(0);
    expect(within(rail()).getByRole("button", { name: "Reset trim" })).toBeDisabled();
    fireEvent.click(within(rail()).getByRole("button", { name: /Remove 3 clips/ }));
    expect(order()).toEqual([]);
    expect(editor().past).toHaveLength(4);
  });

  it("names past three clips by the first two and a count", () => {
    seedThree();
    openEditor();
    act(() => editor().apply((d) => ({ ...d, timeline: [...d.timeline, { ...d.timeline[0], id: "clip:x" }] })));
    act(() =>
      editor().select({ kind: "clip", clipId: "clip:eA", clipIds: ["clip:eA", "clip:eB", "clip:eC", "clip:x"] }),
    );
    expect(within(rail()).getByText("Clip 1, Clip 2 and 2 more")).toBeInTheDocument();
  });

  it("opens the clip menu on a group with its items, Paste off until something is copied", () => {
    seedThree();
    openEditor();
    fireEvent.click(within(screen.getByRole("group", { name: "Timeline layout" })).getByRole("button", { name: "Stacked" }));
    selectAll();
    fireEvent.contextMenu(within(screen.getByRole("listbox", { name: "Clips" })).getAllByRole("option")[1], {
      clientX: 300,
      clientY: 300,
    });
    const menu = screen.getByRole("menu", { name: "3 clips" });
    // The group stays selected under the menu
    expect(editor().selection).toMatchObject({ clipIds: ["clip:eA", "clip:eB", "clip:eC"] });
    const items = within(menu).getAllByRole("menuitem").map((el) => el.textContent);
    expect(items).toEqual([
      "Mute clip audio⌥M",
      "Split at playheadS",
      "Start at playhead[",
      "End at playhead]",
      "Move up a row⌥↑",
      "Move down a row⌥↓",
      "Reset trim",
      "Copy⌘C",
      "Cut⌘X",
      "Paste⌘V",
      "Duplicate⌘D",
      "Reveal source node",
      "Remove 3 clips⌫",
    ]);
    const item = (name: string) => within(menu).getByRole("menuitem", { name: new RegExp(`^${name}`) });
    expect(item("Start at playhead")).toBeDisabled();
    expect(item("Start at playhead")).toHaveAttribute("title", "Select one clip");
    expect(item("End at playhead")).toHaveAttribute("title", "Select one clip");
    expect(item("Reveal source node")).toBeDisabled();
    expect(item("Reveal source node")).toHaveAttribute("title", "Select one clip");
    expect(item("Paste")).toBeDisabled();
    // A copy made anywhere turns Paste on, with no change to the editor's store
    act(() =>
      useStitchClipboard.getState().setClipboard({
        origin: { kind: "node", nodeId: "other", tabId: "t", workflowId: "w" },
        items: [{ track: "video", source: { kind: "asset", assetId: "x" }, inSec: 0, outSec: null, muted: false, volume: 1, offsetSec: 0 }],
      }),
    );
    expect(item("Paste")).toBeEnabled();
    // The menu acts on the whole group: Duplicate adds three
    fireEvent.click(item("Duplicate"));
    expect(order()).toHaveLength(6);
    expect(editor().past).toHaveLength(2);
  });

  it("selects every clip with ⌘A, and ⌘C then ⌘V pastes them, in one step, keeping them from the canvas and the browser", () => {
    seedThree();
    openEditor();
    const all = keyOn(document.body, "a");
    expect(all).toEqual({ prevented: true, heard: false });
    expect(editor().selection).toMatchObject({ clipIds: ["clip:eA", "clip:eB", "clip:eC"] });
    expect(keyOn(document.body, "c")).toEqual({ prevented: true, heard: false });
    expect(useStitchClipboard.getState().clipboard?.items).toHaveLength(3);
    act(() => editor().select({ kind: "clip", clipId: "clip:eA" }));
    expect(keyOn(document.body, "v")).toEqual({ prevented: true, heard: false });
    expect(order()).toHaveLength(6);
    expect(order().slice(0, 1)).toEqual(["clip:eA"]);
    expect(order().slice(4)).toEqual(["clip:eB", "clip:eC"]);
    expect(editor().past).toHaveLength(1);
    // The pasted clips are the selection
    expect(editor().selection).toMatchObject({ clipIds: order().slice(1, 4) });
    expect(keyOn(document.body, "x")).toEqual({ prevented: true, heard: false });
    expect(order()).toEqual(["clip:eA", "clip:eB", "clip:eC"]);
    expect(keyOn(document.body, "d")).toEqual({ prevented: true, heard: false });
    expect(order()).toHaveLength(4);
  });

  it("keeps ⌘D from the browser while the clip menu is open, and leaves ⌘A to a text field", () => {
    seedThree();
    openEditor();
    fireEvent.contextMenu(within(screen.getByRole("listbox", { name: "Clips" })).getAllByRole("option")[0], {
      clientX: 100,
      clientY: 300,
    });
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(keyOn(document.body, "d").prevented).toBe(true);
    expect(order()).toHaveLength(3);
    press(window, "Escape");
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(within(screen.getByRole("group", { name: "Timeline layout" })).getByRole("button", { name: "Stacked" }));
    const well = screen.getByRole("textbox", { name: "Start on the timeline" });
    act(() => well.focus());
    const before = editor().selection;
    expect(keyOn(well, "a").prevented).toBe(false);
    expect(editor().selection).toBe(before);
  });

  it("leaves ⌘C and ⌘X to selected text, kept from the canvas, and copies clips once nothing is selected", () => {
    seedThree();
    openEditor();
    selectAll();
    const names = within(rail()).getByText("Clip 1, Clip 2 and Clip 3");
    const range = document.createRange();
    range.selectNodeContents(names);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    expect(keyOn(document.body, "c")).toEqual({ prevented: false, heard: false });
    expect(keyOn(document.body, "x")).toEqual({ prevented: false, heard: false });
    expect(useStitchClipboard.getState().clipboard).toBeNull();
    expect(order()).toHaveLength(3);
    window.getSelection()!.removeAllRanges();
    expect(keyOn(document.body, "c").prevented).toBe(true);
    expect(useStitchClipboard.getState().clipboard?.items).toHaveLength(3);
  });

  it("names pasted and cut clips in the discard sheet", () => {
    seedThree();
    openEditor();
    keyOn(document.body, "c");
    keyOn(document.body, "v");
    act(() => editor().select({ kind: "clip", clipId: "clip:eB" }));
    keyOn(document.body, "x");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const sheet = screen.getByRole("dialog", { name: "Discard changes?" });
    expect(within(sheet).getByText("A pasted clip and a cut clip will be lost. The node keeps what it had.")).toBeInTheDocument();
  });
});

describe("StitchEditorModal, audio clips", () => {
  const TONE = "atone00000001";
  const toneClip = (id: string, init: Partial<StitchAudioClip> = {}) =>
    createAudioClip({ kind: "asset", assetId: TONE }, { id, ...init });

  /** Two video clips, music on the audio socket, and the node's audio clips as stored. */
  function seedAudio(audioClips: StitchAudioClip[]) {
    seed({ stitch: { audioClips } });
    useWorkflowStore.setState((s) => ({
      nodes: [
        ...s.nodes,
        node("music", "audioInput", { audioFile: "blob:m", filename: "score.mp3", duration: 20, format: "audio/mpeg" }),
      ],
      edges: [...s.edges, { id: "eM", source: "music", target: "stitch", sourceHandle: "audio", targetHandle: "audio" }],
    }));
    primeAssetInfo([{ id: TONE, kind: "audio", filename: "tone1320.m4a", durationSec: 3 } as unknown as AssetView]);
  }
  const audioIds = () => editor().draft!.audioClips.map((c) => c.id);

  it("plays each audio clip from its own hidden <audio>, two pieces of one file included", () => {
    seedAudio([
      createAudioClip({ kind: "music" }, { id: MUSIC_CLIP_ID, outSec: 4 }),
      createAudioClip({ kind: "music" }, { id: "piece", inSec: 4, startSec: 4 }),
      toneClip("t", { row: 1, startSec: 2 }),
    ]);
    openEditor();
    const elements = Array.from(document.querySelectorAll("audio"));
    expect(elements).toHaveLength(3);
    expect(elements.map((el) => el.getAttribute("src"))).toEqual(["blob:m", "blob:m", `/api/assets/${TONE}/file`]);
  });

  it("mutes the selected audio clips with M, and the music with none selected", () => {
    seedAudio([createAudioClip({ kind: "music" }, { id: MUSIC_CLIP_ID }), toneClip("t", { row: 1, startSec: 2 })]);
    openEditor();
    act(() => editor().select(audioSelectionOf({ clipId: "t" })));
    press(document.body, "m");
    expect(editor().draft!.audioClips.map((c) => c.muted)).toEqual([false, true]);
    act(() => editor().select(null));
    press(document.body, "m");
    expect(editor().draft!.audioClips.map((c) => c.muted)).toEqual([true, true]);
  });

  it("names audio edits in the discard sheet", () => {
    seedAudio([createAudioClip({ kind: "music" }, { id: MUSIC_CLIP_ID }), toneClip("t", { row: 1, startSec: 2 })]);
    openEditor();
    act(() => editor().select(audioSelectionOf({ clipId: "t" })));
    press(document.body, "ArrowRight", { altKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const sheet = screen.getByRole("dialog", { name: "Discard changes?" });
    expect(within(sheet).getByText("A moved audio clip will be lost. The node keeps what it had.")).toBeInTheDocument();
  });

  it("writes the audio clips on Done, with the music's copy for older builds", () => {
    seedAudio([createAudioClip({ kind: "music" }, { id: MUSIC_CLIP_ID, curve: [{ t: 1, gain: 0.5 }] })]);
    openEditor();
    // A legacy-shaped node keeps no audioClips key once read: add a library clip
    act(() =>
      editor().apply((d) => ({ ...d, audioClips: [...d.audioClips, toneClip("t", { row: 1, startSec: 2 })] })),
    );
    expect(audioIds()).toEqual([MUSIC_CLIP_ID, "t"]);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(stitchData().audioClips).toEqual([
      expect.objectContaining({ id: MUSIC_CLIP_ID, row: 0 }),
      expect.objectContaining({ id: "t", row: 1, startSec: 2 }),
    ]);
    expect(stitchData().audioCurve).toEqual([{ t: 1, gain: 0.5 }]);
    expect(stitchData().audioMuted).toBe(false);
  });
});
