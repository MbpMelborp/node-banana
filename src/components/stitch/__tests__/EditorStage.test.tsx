import { Profiler } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen } from "@testing-library/react";
import { ensureOverlayFonts, fileFamily, fontKey, type ResolvedFont } from "@/lib/stitch/fonts";
import type { StitchDraft } from "@/lib/stitch/draft";
import { createTextOverlay } from "@/lib/stitch/overlays";
import { overlaySelectionOf, setLivePlayhead, useStitchEditorStore } from "@/store/stitchEditorStore";
import type { StitchTextOverlay } from "@/types";
import { CONTROLS_MIN_PX, EditorStage, stageLayout } from "../EditorStage";
import { overlayNoVideoSlot } from "../OverlayCanvas";
import { GEOMETRY } from "../editorStyles";
import { useEditorComposition } from "../useEditorComposition";

const fontChanges = vi.hoisted(() => new Set<() => void>());
vi.mock("@/lib/stitch/fonts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stitch/fonts")>();
  return {
    ...actual,
    ensureOverlayFonts: vi.fn(actual.ensureOverlayFonts),
    onFontsChanged: (listener: () => void) => {
      fontChanges.add(listener);
      return () => fontChanges.delete(listener);
    },
  };
});

// The stage's geometry (the frame and the control row under it) and what it draws, without the editor around it.

const noop = () => {};

interface OverlayProps {
  hasOverlays?: boolean;
  frameSize?: { width: number; height: number } | null;
  total?: number;
}

function stage(empty = false, aspect = 16 / 9, overlays: OverlayProps = {}) {
  const { hasOverlays = false, frameSize = null, total = 0 } = overlays;
  return (
    <EditorStage
      empty={empty}
      aspect={aspect}
      layers={empty ? [] : [{ key: "c1", src: "blob:a" }]}
      registerVideo={noop}
      registerCanvas={noop}
      audioLayers={[]}
      registerAudio={noop}
      hasOverlays={hasOverlays}
      frameSize={frameSize}
      total={total}
    >
      <div data-testid="row" />
    </EditorStage>
  );
}

function renderStage(empty = false, aspect = 16 / 9, overlays: OverlayProps = {}) {
  return render(stage(empty, aspect, overlays));
}

/** jsdom lays nothing out: give every element the stage's size for a render. */
function sized(width: number, height: number) {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(width);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(height);
}

afterEach(() => {
  act(() => {
    editor().close();
    // The drawn playhead is the module's: a test that wrote it straight leaves it there for the next
    setLivePlayhead(0);
  });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const editor = () => useStitchEditorStore.getState();

const text = (id: string, init: Partial<StitchTextOverlay> = {}) =>
  createTextOverlay({ id, startSec: 0, endSec: 4, fadeInSec: 0.5, fadeOutSec: 0.5, ...init });

function openWith(overlays: StitchTextOverlay[]) {
  const draft: StitchDraft = {
    timeline: [],
    audioClips: [],
    legacyAudio: { curve: [], muted: false },
    loopCount: 1,
    sequenceLayout: { mode: "track", overlapSec: 0.5, crossfade: true },
    ...(overlays.length > 0 ? { overlays } : {}),
  };
  act(() => editor().openEdit({ editId: "ed0123456789ab", draft }));
}

/** The playhead moved there, as a click or a pause puts it. */
const playheadAt = (t: number) => act(() => editor().setPlayhead(t));

type Op =
  | { op: "transform" | "clear"; args: number[] }
  | { op: "wash"; args: number[]; alpha: number }
  | { op: "text"; text: string; alpha: number; font: string };

/** The 2D context every canvas gets: it records what is cleared, set and painted, in order. */
function fakeContext() {
  const ops: Op[] = [];
  const ctx = {
    globalAlpha: 1,
    fillStyle: "",
    font: "10px sans-serif",
    textAlign: "start",
    textBaseline: "alphabetic",
    measureText: (s: string) => ({ width: s.length * 10 }),
    setTransform: (...args: number[]) => ops.push({ op: "transform", args }),
    clearRect: (...args: number[]) => ops.push({ op: "clear", args }),
    fillRect: (...args: number[]) => ops.push({ op: "wash", args, alpha: ctx.globalAlpha }),
    fillText: (line: string) => ops.push({ op: "text", text: line, alpha: ctx.globalAlpha, font: ctx.font }),
  };
  const getContext = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  return { ops, getContext };
}

describe("the stage's floor", () => {
  it("is the stage with its padding and control row, so the timeline gets what is left of the column below it", () => {
    // At the floor the frame is 240px tall: 344 less 24px above and below and the row's 56
    expect(GEOMETRY.stageFloor).toBe(344);
    expect(stageLayout({ width: 2000, height: GEOMETRY.stageFloor }, 16 / 9)!.frame.height).toBe(240);
    const root = document.createElement("div");
    Object.defineProperty(root, "clientHeight", { value: 800 });
    // A 56px header over the stage: nothing else is reserved (the row is inside the stage)
    const { result } = renderHook(() => useEditorComposition({ current: root }, 56));
    expect(result.current.maxTimeline).toBe(800 - 56 - 344);
  });
});

describe("stageLayout", () => {
  it("is nothing until the stage has a size", () => {
    expect(stageLayout(null, 16 / 9)).toBeNull();
    expect(stageLayout({ width: 0, height: 0 }, 16 / 9)).toBeNull();
  });

  it("fits the frame across the stage less 32px each side, the row as wide (the Clip board's stage)", () => {
    // 884 × 610: 820 wide, and 820 / (16/9) = 461.25 fits under 610 − 48 − 56
    const layout = stageLayout({ width: 884, height: 610 }, 16 / 9)!;
    expect(layout.frame.width).toBe(820);
    expect(layout.frame.height).toBeCloseTo(461.25, 5);
    expect(layout.row).toBe(820);
  });

  it("fits the frame to the height left above the row when the stage is wide (the Focus board's)", () => {
    // 1428 × 610: 610 − 24 × 2 − 56 = 506 high, 899.6 wide
    const layout = stageLayout({ width: 1428, height: 610 }, 16 / 9)!;
    expect(layout.frame.height).toBe(506);
    expect(layout.frame.width).toBeCloseTo(899.56, 2);
    expect(layout.row).toBeCloseTo(899.56, 2);
  });

  it("keeps the row wide enough for its controls under a portrait frame, and inside the stage", () => {
    const tall = stageLayout({ width: 1000, height: 600 }, 9 / 16)!;
    expect(tall.frame.width).toBeCloseTo((496 * 9) / 16, 5);
    expect(tall.row).toBe(CONTROLS_MIN_PX);
    // A stage narrower than that: the row takes what there is
    const narrow = stageLayout({ width: 400, height: 600 }, 9 / 16)!;
    expect(narrow.row).toBe(336);
  });

  it("gives a stage with no room a frame of no size", () => {
    expect(stageLayout({ width: 900, height: 100 }, 16 / 9)!.frame).toEqual({ width: 0, height: 0 });
  });
});

describe("EditorStage", () => {
  it("draws the frame at its fitted size with the row under it at its width, on black with 8px corners and no ring", () => {
    sized(884, 610);
    renderStage();
    const frame = screen.getByTestId("stitch-preview");
    expect(frame.style.width).toBe("820px");
    expect(frame.style.height).toBe("461.25px");
    expect(frame).toHaveClass("rounded-lg", "bg-black");
    expect(frame.className).not.toContain("ring");
    const column = screen.getByTestId("stitch-stage-column");
    expect(column.style.width).toBe("820px");
    expect(column.firstElementChild).toBe(frame);
    expect(column.lastElementChild).toContainElement(screen.getByTestId("row"));
    expect(frame.querySelectorAll("video")).toHaveLength(1);
  });

  it("shows an empty frame that says why, with the row still under it", () => {
    sized(884, 610);
    renderStage(true);
    expect(screen.queryByTestId("stitch-preview")).toBeNull();
    const message = screen.getByText("No clips yet");
    const frame = message.parentElement!;
    expect(frame.style.width).toBe("820px");
    expect(frame).toHaveClass("bg-editor-well", "border-edit-line", "rounded-lg");
    expect(screen.getByText(/Connect videos to the node's inputs/)).toBeInTheDocument();
    expect(screen.getByTestId("stitch-stage-column")).toContainElement(screen.getByTestId("row"));
  });

  it("fills the column at the output's aspect until the stage is measured", () => {
    sized(0, 0);
    renderStage();
    const frame = screen.getByTestId("stitch-preview");
    expect(frame.style.width).toBe("100%");
    expect(frame.style.aspectRatio).not.toBe("");
    expect(screen.getByTestId("stitch-stage-column").style.width).toBe("100%");
  });
});

describe("the text layers on the stage", () => {
  /** The stage at 884 × 610: its frame is 820 × 461.25 at 16:9. */
  const STAGE = { width: 884, height: 610 };
  const HD = { width: 1920, height: 1080 };
  /** The clears, and the washes' and texts' alphas. */
  const painted = (ops: Op[]) =>
    ops.flatMap((o) =>
      o.op === "clear" ? [["clear"]] : o.op === "wash" ? [["wash", o.alpha]] : o.op === "text" ? [[o.text, o.alpha]] : [],
    );
  /** What was cleared and painted since the last call. */
  const take = (ops: Op[]) => painted(ops.splice(0));
  /**
   * The last draw since the last call, from its clear. At mount the canvas draws at its own size and again at the
   * frame's once the stage has measured it, before the first paint.
   */
  const lastDraw = (ops: Op[]) => {
    const drawn = ops.splice(0);
    return drawn.slice(drawn.findLastIndex((o) => o.op === "clear") - 1);
  };

  it("draws them over the frame on a canvas of their own, after the blend canvas, at the device pixel ratio", () => {
    sized(STAGE.width, STAGE.height);
    vi.stubGlobal("devicePixelRatio", 2);
    const { ops } = fakeContext();
    openWith([text("a")]);
    playheadAt(2);
    renderStage(false, 16 / 9, { hasOverlays: true, frameSize: HD, total: 10 });
    const frame = screen.getByTestId("stitch-preview");
    const canvases = frame.querySelectorAll("canvas");
    expect(canvases).toHaveLength(2);
    const overlay = screen.getByTestId("stitch-overlay-canvas") as HTMLCanvasElement;
    expect(frame.lastElementChild).toBe(overlay);
    expect(canvases[1]).toBe(overlay);
    expect(overlay).toHaveAttribute("aria-hidden", "true");
    expect(overlay).toHaveClass("pointer-events-none", "absolute", "inset-0");
    expect(overlay).not.toHaveClass("opacity-0");
    // 820 × 461.25 CSS px at 2×
    expect([overlay.width, overlay.height]).toEqual([1640, 923]);
    // Cleared at identity, then laid out in the output's pixels and scaled to the canvas's
    expect(lastDraw(ops)).toEqual([
      { op: "transform", args: [1, 0, 0, 1, 0, 0] },
      { op: "clear", args: [0, 0, 1640, 923] },
      { op: "transform", args: [1640 / 1920, 0, 0, 923 / 1080, 0, 0] },
      { op: "wash", args: [0, 0, 1920, 1080], alpha: 0.5 },
      { op: "text", text: "Title", alpha: 1, font: `600 ${0.08 * 1080}px "Space Grotesk", sans-serif` },
      { op: "transform", args: [1, 0, 0, 1, 0, 0] },
    ]);
  });

  it("lays them out at the output's size rounded down to even, as the render does, and scales each axis to the canvas", () => {
    sized(STAGE.width, STAGE.height);
    const { ops } = fakeContext();
    openWith([text("a")]);
    playheadAt(2);
    const aspect = 1285 / 717;
    renderStage(false, aspect, { hasOverlays: true, frameSize: { width: 1285, height: 717 }, total: 10 });
    const { frame } = stageLayout(STAGE, aspect)!;
    const [width, height] = [Math.round(frame.width), Math.round(frame.height)];
    const overlay = screen.getByTestId("stitch-overlay-canvas") as HTMLCanvasElement;
    expect([overlay.width, overlay.height]).toEqual([width, height]);
    expect(lastDraw(ops).slice(1, 4)).toEqual([
      { op: "clear", args: [0, 0, width, height] },
      { op: "transform", args: [width / 1284, 0, 0, height / 716, 0, 0] },
      { op: "wash", args: [0, 0, 1284, 716], alpha: 0.5 },
    ]);
  });

  it("redraws on every write of the live playhead, without a render, and does nothing while there is nothing to show", () => {
    sized(STAGE.width, STAGE.height);
    const { ops, getContext } = fakeContext();
    openWith([text("a")]);
    playheadAt(0);
    const commits = vi.fn();
    render(
      <Profiler id="stage" onRender={commits}>
        {stage(false, 16 / 9, { hasOverlays: true, frameSize: HD, total: 10 })}
      </Profiler>,
    );
    // At its start the layer has not begun to fade in: a clear canvas is left alone
    expect(ops).toEqual([]);
    expect(getContext).not.toHaveBeenCalled();
    const rendered = commits.mock.calls.length;
    act(() => setLivePlayhead(0.25));
    expect(take(ops)).toEqual([["clear"], ["wash", 0.25], ["Title", 0.5]]);
    act(() => setLivePlayhead(2));
    expect(take(ops)).toEqual([["clear"], ["wash", 0.5], ["Title", 1]]);
    // Past its end: cleared once, then left
    act(() => setLivePlayhead(4.5));
    expect(take(ops)).toEqual([["clear"]]);
    act(() => setLivePlayhead(5));
    expect(take(ops)).toEqual([]);
    expect(commits).toHaveBeenCalledTimes(rendered);
  });

  it("redraws on an edit to a layer, and on undo and redo, without a render", () => {
    sized(STAGE.width, STAGE.height);
    const { ops } = fakeContext();
    openWith([text("a")]);
    playheadAt(2);
    const commits = vi.fn();
    render(
      <Profiler id="stage" onRender={commits}>
        {stage(false, 16 / 9, { hasOverlays: true, frameSize: HD, total: 10 })}
      </Profiler>,
    );
    take(ops);
    const rendered = commits.mock.calls.length;
    const edited = { text: "Edited", wash: { opacity: 0 } };
    act(() => editor().apply((d) => ({ ...d, overlays: [{ ...d.overlays![0], ...edited }] })));
    expect(take(ops)).toEqual([["clear"], ["Edited", 1]]);
    act(() => editor().undo());
    expect(take(ops)).toEqual([["clear"], ["wash", 0.5], ["Title", 1]]);
    act(() => editor().redo());
    expect(take(ops)).toEqual([["clear"], ["Edited", 1]]);
    // A change to something else is not drawn again
    act(() => editor().apply((d) => ({ ...d, loopCount: 2 })));
    expect(take(ops)).toEqual([]);
    expect(commits).toHaveBeenCalledTimes(rendered);
  });

  it("draws at the start of the render's frame the playhead is in, and the last frame at the end", () => {
    sized(STAGE.width, STAGE.height);
    const { ops } = fakeContext();
    // A cut in at 2 s: the frame at 2 s starts at 1.9917 s (half a 60 fps frame before), and has the layer
    openWith([text("a", { startSec: 2, endSec: 3, fadeInSec: 0, fadeOutSec: 0 })]);
    playheadAt(1.996);
    renderStage(false, 16 / 9, { hasOverlays: true, frameSize: HD, total: 3 });
    expect(painted(lastDraw(ops))).toEqual([["clear"], ["wash", 0.5], ["Title", 1]]);
    // The frame before it does not
    act(() => setLivePlayhead(1.99));
    expect(take(ops)).toEqual([["clear"]]);
    // A layer that runs to the end is in the last frame (2.9833 s), which a playhead at or past the end shows
    act(() => setLivePlayhead(3));
    expect(take(ops)).toEqual([["clear"], ["wash", 0.5], ["Title", 1]]);
    act(() => setLivePlayhead(3.5));
    expect(take(ops)).toEqual([["clear"], ["wash", 0.5], ["Title", 1]]);
  });

  it("shows a layer that starts on a cut with the playhead on the cut, as the render's first frame after the cut has it", () => {
    sized(STAGE.width, STAGE.height);
    const { ops } = fakeContext();
    // A clip trimmed to 5.005 s: the clip after it starts on slot 300 (300.3 rounds down), and so does the layer
    openWith([text("a", { startSec: 5.005, endSec: 8, fadeInSec: 0, fadeOutSec: 0 })]);
    playheadAt(5.005);
    renderStage(false, 16 / 9, { hasOverlays: true, frameSize: HD, total: 10.005 });
    expect(painted(lastDraw(ops))).toEqual([["clear"], ["wash", 0.5], ["Title", 1]]);
    // The slot before the cut, the clip before it's last frame, has none
    act(() => setLivePlayhead(4.99));
    expect(take(ops)).toEqual([["clear"]]);
  });

  it("shows the black frame with the layers, not the empty card, when there is no video, at the selected layer's height", () => {
    sized(STAGE.width, STAGE.height);
    const { ops } = fakeContext();
    openWith([text("a", { startSec: 1, endSec: 5 }), text("b", { row: 1, startSec: 3, endSec: 7, text: "Second" })]);
    renderStage(true, 16 / 9, { hasOverlays: true, frameSize: null, total: 0 });
    expect(screen.queryByText("No clips yet")).toBeNull();
    const frame = screen.getByTestId("stitch-preview");
    expect(frame).toHaveClass("bg-black");
    expect(frame.querySelectorAll("video")).toHaveLength(0);
    expect(frame.lastElementChild).toBe(screen.getByTestId("stitch-overlay-canvas"));
    // The layer that starts first, where its fade-in ends (1.5 s), laid out at the render's 1920 × 1080
    const drawn = lastDraw(ops);
    expect(drawn.slice(1, 3)).toEqual([
      { op: "clear", args: [0, 0, 820, 461] },
      { op: "transform", args: [820 / 1920, 0, 0, 461 / 1080, 0, 0] },
    ]);
    expect(painted(drawn)).toEqual([["clear"], ["wash", 0.5], ["Title", 1]]);
    // Selecting the other draws at its own (3.5 s), where both show
    act(() => editor().select(overlaySelectionOf({ clipId: "b" })));
    expect(take(ops)).toEqual([["clear"], ["wash", 0.5], ["wash", 0.5], ["Title", 1], ["Second", 1]]);
    // A layer whose fades meet is drawn where they do (5 s), at its peak: 2/3, where its fade-in's end (6 s) has 1/3
    const [first, second] = editor().draft!.overlays!;
    act(() => editor().apply((d) => ({ ...d, overlays: [first, { ...second, fadeInSec: 3, fadeOutSec: 3 }] })));
    expect(take(ops)).toEqual([["clear"], ["wash", 1 / 3], ["Second", 2 / 3]]);
    // There is no playhead to follow
    act(() => setLivePlayhead(6));
    expect(take(ops)).toEqual([["clear"], ["wash", 1 / 3], ["Second", 2 / 3]]);
  });

  it("draws a layer with no video on the slot its fade-in tops out on, on the grid its edges round to", () => {
    // 1.0125 s rounds to slot 61; a 5 ms fade-in is over by the next slot, though 1.0175 s itself rounds to 61
    const brief = text("a", { startSec: 1.0125, endSec: 3, fadeInSec: 0.005 });
    expect(overlayNoVideoSlot([brief], null)).toBe(62);
    expect(overlayNoVideoSlot([text("a", { startSec: 1, endSec: 3 })], null)).toBe(90);
    // A layer shorter than its fade-in is drawn inside its end
    expect(overlayNoVideoSlot([text("a", { startSec: 1, endSec: 1.2, fadeInSec: 2, fadeOutSec: 0 })], null)).toBe(71);
  });

  it("follows the playhead while the clips' lengths are still being read, whatever layer is selected", () => {
    sized(STAGE.width, STAGE.height);
    const { ops } = fakeContext();
    openWith([text("a", { startSec: 5, endSec: 9, text: "Late title" })]);
    playheadAt(0);
    // A clip is there, but no length has been read yet: total 0 is not "no video"
    const { rerender } = renderStage(false, 16 / 9, { hasOverlays: true, frameSize: null, total: 0 });
    expect(take(ops)).toEqual([]);
    act(() => editor().select(overlaySelectionOf({ clipId: "a" })));
    expect(take(ops)).toEqual([]);
    act(() => setLivePlayhead(6));
    expect(take(ops)).toEqual([["clear"], ["wash", 0.5], ["Late title", 1]]);
    act(() => editor().select(null));
    expect(take(ops)).toEqual([]);
    // Once they are read, the playhead past the end shows the last frame (2.9833 s), which the layer is not in
    rerender(stage(false, 16 / 9, { hasOverlays: true, frameSize: HD, total: 3 }));
    expect(take(ops)).toEqual([["clear"]]);
  });

  it("mounts no canvas and asks for no context without overlays", () => {
    sized(STAGE.width, STAGE.height);
    const { getContext } = fakeContext();
    openWith([]);
    playheadAt(2);
    renderStage(false, 16 / 9, { hasOverlays: false, frameSize: HD, total: 10 });
    expect(screen.queryByTestId("stitch-overlay-canvas")).toBeNull();
    expect(screen.getByTestId("stitch-preview").querySelectorAll("canvas")).toHaveLength(1);
    act(() => setLivePlayhead(3));
    act(() => editor().apply((d) => ({ ...d, loopCount: 2 })));
    expect(getContext).not.toHaveBeenCalled();
  });

  it("draws in the fonts the layers resolve to once they have loaded, and again when a font loads", async () => {
    sized(STAGE.width, STAGE.height);
    const { ops } = fakeContext();
    const load = vi.mocked(ensureOverlayFonts);
    load.mockClear();
    let resolve!: (fonts: Map<string, ResolvedFont>) => void;
    load.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    openWith([text("a", { font: { family: "Missing Sans" } })]);
    playheadAt(2);
    renderStage(false, 16 / 9, { hasOverlays: true, frameSize: HD, total: 10 });
    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0][0]).toBe(editor().draft!.overlays);
    const px = 0.08 * 1080;
    const fonts = () => lastDraw(ops).flatMap((o) => (o.op === "text" ? [o.font] : []));
    // Drawn at once, as if it were there
    expect(fonts()).toEqual([`600 ${px}px "Missing Sans", "Space Grotesk", sans-serif`]);
    const missing: ResolvedFont = { list: '"Space Grotesk", sans-serif', state: "missing" };
    await act(async () => resolve(new Map([["family:Missing Sans", missing]])));
    expect(fonts()).toEqual([`600 ${px}px "Space Grotesk", sans-serif`]);
    // A font that loads redraws at once, and the fonts are asked for again
    act(() => fontChanges.forEach((listener) => listener()));
    expect(take(ops)).toEqual([["clear"], ["wash", 0.5], ["Title", 1]]);
    expect(load).toHaveBeenCalledTimes(2);
    // An edit to the layers loads what they now need
    act(() => editor().apply((d) => ({ ...d, overlays: [{ ...d.overlays![0], text: "Ünïcode" }] })));
    expect(load).toHaveBeenCalledTimes(3);
    expect(load.mock.calls[2][0]).toBe(editor().draft!.overlays);
  });

  it("draws a font file added to the Fonts folder once the fonts change, the layer as it was", async () => {
    sized(STAGE.width, STAGE.height);
    const { ops } = fakeContext();
    const load = vi.mocked(ensureOverlayFonts);
    load.mockClear();
    const inter = { family: "Inter", file: "Inter.ttf" };
    const app = '"Space Grotesk", sans-serif';
    load.mockResolvedValueOnce(new Map([[fontKey(inter), { list: app, state: "missing" }]]));
    openWith([text("a", { font: inter, weight: 400 })]);
    playheadAt(2);
    renderStage(false, 16 / 9, { hasOverlays: true, frameSize: HD, total: 10 });
    await act(async () => {});
    const px = 0.08 * 1080;
    const fonts = () => lastDraw(ops).flatMap((o) => (o.op === "text" ? [o.font] : []));
    // Made on another computer: this one's Fonts folder has no Inter.ttf
    expect(fonts()).toEqual([`400 ${px}px ${app}`]);
    // It is added back under its own name: the layer is unchanged, the fonts change
    const ready: ResolvedFont = { list: `"${fileFamily("Inter.ttf")}", ${app}`, state: "ready" };
    load.mockResolvedValueOnce(new Map([[fontKey(inter), ready]]));
    await act(async () => fontChanges.forEach((listener) => listener()));
    expect(load).toHaveBeenCalledTimes(2);
    expect(load.mock.calls[1][0]).toBe(editor().draft!.overlays);
    expect(fonts()).toEqual([`400 ${px}px ${ready.list}`]);
  });
});

describe("useEditorComposition's overlays", () => {
  it("tells the stage whether there are any, and is not rendered again by an edit to one", () => {
    openWith([]);
    const root = document.createElement("div");
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useEditorComposition({ current: root }, 56);
    });
    expect(result.current.hasOverlays).toBe(false);
    act(() => editor().apply((d) => ({ ...d, overlays: [text("a")] })));
    expect(result.current.hasOverlays).toBe(true);
    const before = renders;
    act(() => editor().apply((d) => ({ ...d, overlays: [{ ...d.overlays![0], text: "Edited" }] })));
    expect(renders).toBe(before);
    act(() => editor().apply((d) => ({ ...d, overlays: undefined })));
    expect(result.current.hasOverlays).toBe(false);
  });
});
