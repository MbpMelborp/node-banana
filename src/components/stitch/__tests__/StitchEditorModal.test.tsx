import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useWorkflowStore } from "@/store/workflowStore";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import {
  __resetMediaInfoForTests,
  __setMediaExtractorForTests,
  __setMediaInfoForTests,
  mediaKeyOf,
} from "@/lib/stitch/mediaInfo";
import { StitchEditorModal } from "../StitchEditorModal";
import { openStitchEditor } from "../openStitchEditor";
import { setLoopCount } from "../editorActions";
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

  it("closes without writing when the canvas is replaced", () => {
    seed();
    openEditor();
    toggleClipAudio();
    act(() => useWorkflowStore.setState({ canvasGeneration: wf().canvasGeneration + 1 }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect("timeline" in stitchData()).toBe(false);
  });
});
