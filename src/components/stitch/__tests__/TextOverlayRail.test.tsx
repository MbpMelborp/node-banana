import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { overlaySelectionOf, useStitchEditorStore } from "@/store/stitchEditorStore";
import type { StitchDraft } from "@/lib/stitch/draft";
import { FONT_ACCEPT, type FontFileInfo } from "@/lib/edits/fontFiles";
import * as fonts from "@/lib/stitch/fonts";
import { createTextOverlay } from "@/lib/stitch/overlays";
import { DEFAULT_SEQUENCE_LAYOUT } from "@/lib/stitch/stack";
import { createClip, type SourceKey } from "@/lib/stitch/timeline";
import type { StitchOverlay } from "@/types";
import { EditorRail } from "../EditorRail";
import { addTextOverlay } from "../overlayActions";

vi.mock("@/components/Toast", () => ({ useToast: { getState: () => ({ show: vi.fn() }) } }));
vi.mock("@/lib/stitch/fonts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stitch/fonts")>();
  return {
    ...actual,
    ensureOverlayFonts: vi.fn(),
    listFontFiles: vi.fn(),
    addFontFile: vi.fn(),
    localFontsPermission: vi.fn(),
    installedFamilies: vi.fn(),
  };
});

// The rail for selected text layers, through EditorRail, against the real editor store. The fonts registry stands in
// for the page's fonts, the Fonts folder and the browser's installed fonts.

const editor = () => useStitchEditorStore.getState();
const text = (id: string, init: Partial<StitchOverlay> = {}) => createTextOverlay({ id, ...init });
const GEORGIA: FontFileInfo = { name: "Georgia.ttf", format: "ttf", bytes: 1000, modifiedAt: 1 };
const INTER: FontFileInfo = { name: "Inter.ttf", format: "ttf", bytes: 1000, modifiedAt: 2 };

function open(overlays: StitchOverlay[], { video = true }: { video?: boolean } = {}) {
  // A 10 s video under the text, so the playhead can move
  const draft: StitchDraft = {
    timeline: video ? [createClip({ kind: "edge", edgeId: "e1" }, { id: "c1" })] : [],
    audioClips: [],
    overlays,
    legacyAudio: { curve: [], muted: false },
    loopCount: 1,
    sequenceLayout: DEFAULT_SEQUENCE_LAYOUT,
  };
  act(() => {
    editor().open({ nodeId: "stitch", draft, canvasGeneration: 1 });
    editor().setDurations(new Map<SourceKey, number>([["edge:e1", 10]]));
  });
}

const layers = () => editor().draft!.overlays ?? [];
const layer = (id: string) => layers().find((o) => o.id === id)!;
const select = (...ids: string[]) =>
  act(() => editor().select(overlaySelectionOf({ clipId: ids[0], ...(ids.length > 1 ? { clipIds: ids } : {}) })));

/** The rail in a panel focus can go back to, as the editor's column is. */
function renderRail() {
  return render(
    <div data-stitch-editor="" tabIndex={-1} data-testid="panel">
      <EditorRail media={new Map()} audio={new Map()} frameSize={null} />
    </div>,
  );
}

const well = (name: string) => screen.getByRole("textbox", { name }) as HTMLInputElement;
/** Typed into a well and committed with Enter, which hands focus back to the panel. */
function commit(name: string, value: string) {
  const field = well(name);
  act(() => field.focus());
  fireEvent.change(field, { target: { value } });
  fireEvent.keyDown(field, { key: "Enter" });
}
const segments = (group: string) =>
  within(screen.getByRole("group", { name: group }))
    .getAllByRole("button")
    .map((b) => [b.getAttribute("aria-label") ?? b.textContent, b.getAttribute("aria-pressed")]);
const combobox = () => screen.getByRole("combobox", { name: "Font" }) as HTMLInputElement;
const listbox = () => screen.queryByRole("listbox", { name: "Fonts" });
const option = (name: string) => within(listbox()!).getByRole("option", { name });
/** A row pressed as a pointer presses it: its mousedown keeps the focus in the field. */
function press(row: HTMLElement) {
  const kept = fireEvent.mouseDown(row);
  expect(kept).toBe(false);
  fireEvent.click(row);
}
/** Keys the editor would act on, had the field let them through. */
function windowKeys() {
  const heard = vi.fn();
  window.addEventListener("keydown", heard);
  return { heard, stop: () => window.removeEventListener("keydown", heard) };
}

beforeEach(() => {
  act(() => editor().close());
  vi.mocked(fonts.ensureOverlayFonts).mockResolvedValue(new Map());
  vi.mocked(fonts.listFontFiles).mockResolvedValue({ fonts: [GEORGIA], folder: "/Library/Fonts" });
  vi.mocked(fonts.localFontsPermission).mockResolvedValue("unsupported");
  vi.mocked(fonts.installedFamilies).mockResolvedValue(null);
  // jsdom draws nothing: nothing is measured unless a test gives the rail a context
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => {
  act(() => editor().close());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.mocked(fonts.ensureOverlayFonts).mockReset();
  vi.mocked(fonts.listFontFiles).mockReset();
  vi.mocked(fonts.addFontFile).mockReset();
  vi.mocked(fonts.localFontsPermission).mockReset();
  vi.mocked(fonts.installedFamilies).mockReset();
});

describe("TextOverlayRail", () => {
  it("shows one layer: its first line, row and length, every setting, and its actions", () => {
    open([text("o1", { text: "Hello\nworld", startSec: 1 })]);
    select("o1");
    renderRail();
    const rail = screen.getByRole("complementary", { name: "Text" });
    expect(within(rail).getByText("Hello")).toBeInTheDocument();
    expect(within(rail).getByText("Text 1 · 4.00 s")).toBeInTheDocument();
    const area = well("Text");
    expect(area.value).toBe("Hello\nworld");
    expect(area).toHaveAttribute("maxLength", "2000");
    expect(combobox().value).toBe("Space Grotesk");
    expect(combobox()).toHaveAttribute("aria-expanded", "false");
    expect(well("Size").value).toBe("8%");
    // Space Grotesk's faces only
    expect(segments("Weight")).toEqual([
      ["500", "false"],
      ["600", "true"],
      ["700", "false"],
    ]);
    expect(screen.getByLabelText("Colour")).toHaveValue("#ffffff");
    expect(well("Hex colour").value).toBe("#ffffff");
    expect(segments("Align")).toEqual([
      ["Left", "false"],
      ["Centre", "true"],
      ["Right", "false"],
    ]);
    expect(segments("Position")).toEqual([
      ["Centre", "true"],
      ["Lower third", "false"],
      ["Top", "false"],
    ]);
    expect([well("X").value, well("Y").value]).toEqual(["50%", "50%"]);
    expect(screen.getByRole("slider", { name: "Wash opacity" })).toHaveValue("50");
    expect([well("Fade in").value, well("Fade out").value]).toEqual(["0.50 s", "0.50 s"]);
    expect([well("Start on the timeline").value, well("Length").value]).toEqual(["0:01.00", "0:04.00"]);
    // The playhead (0:00) is not inside the layer
    expect(screen.getByRole("button", { name: "Split at playhead" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Split at playhead" })).toHaveAttribute("aria-keyshortcuts", "S");
    expect(screen.getByRole("button", { name: "Remove text" })).toHaveAttribute("aria-keyshortcuts", "Backspace");
    // Nothing to say: the font is here and the text fits
    expect(screen.queryByText(/stands in/)).toBeNull();
    expect(screen.queryByText(/doesn't fit/)).toBeNull();
  });

  it("makes typing one undo step for each visit to the text, and Escape leaves it without the editor hearing", () => {
    open([text("o1")]);
    select("o1");
    renderRail();
    const area = well("Text");
    fireEvent.focus(area);
    fireEvent.change(area, { target: { value: "H" } });
    fireEvent.change(area, { target: { value: "Hi" } });
    expect(layer("o1").text).toBe("Hi");
    expect(editor().past).toHaveLength(1);
    // The title follows it
    expect(within(screen.getByRole("complementary", { name: "Text" })).getByText("Hi", { selector: "span" })).toBeInTheDocument();
    fireEvent.blur(area);
    fireEvent.focus(area);
    fireEvent.change(area, { target: { value: "Hi\nthere" } });
    expect(layer("o1").text).toBe("Hi\nthere");
    expect(editor().past).toHaveLength(2);
    act(() => editor().undo());
    expect(layer("o1").text).toBe("Hi");
    const keys = windowKeys();
    act(() => area.focus());
    fireEvent.keyDown(area, { key: "Escape" });
    keys.stop();
    expect(keys.heard).not.toHaveBeenCalled();
    expect(screen.getByTestId("panel")).toHaveFocus();
  });

  it("leaves an input method's Escape in the text: the conversion goes, the field stays, and nothing behind hears it", () => {
    open([text("o1")]);
    select("o1");
    renderRail();
    const area = well("Text");
    act(() => area.focus());
    const keys = windowKeys();
    // Composing (Chromium), or just ended with keyCode 229 still on it (Safari); not prevented: the input method's
    expect(fireEvent.keyDown(area, { key: "Escape", isComposing: true })).toBe(true);
    expect(fireEvent.keyDown(area, { key: "Escape", keyCode: 229 })).toBe(true);
    keys.stop();
    expect(keys.heard).not.toHaveBeenCalled();
    expect(area).toHaveFocus();
  });

  it("writes every setting as one undo step, and none for a value it already has", () => {
    open([text("o1", { startSec: 1 })]);
    select("o1");
    renderRail();
    const steps = () => editor().past.length;
    commit("Size", "12");
    expect(layer("o1").size).toBe(0.12);
    expect(well("Size").value).toBe("12%");
    fireEvent.click(within(screen.getByRole("group", { name: "Weight" })).getByRole("button", { name: "700" }));
    expect(layer("o1").weight).toBe(700);
    fireEvent.click(screen.getByRole("button", { name: "Right" }));
    expect(layer("o1").align).toBe("right");
    fireEvent.click(screen.getByRole("button", { name: "Lower third" }));
    expect(layer("o1")).toMatchObject({ x: 0.5, y: 0.82 });
    expect(segments("Position")).toEqual([
      ["Centre", "false"],
      ["Lower third", "true"],
      ["Top", "false"],
    ]);
    commit("X", "25%");
    expect(layer("o1").x).toBe(0.25);
    // Off the preset by more than half a percent: no preset is pressed
    expect(segments("Position").every(([, pressed]) => pressed === "false")).toBe(true);
    commit("Y", "14.5");
    expect(layer("o1").y).toBe(0.145);
    commit("Hex colour", "F80");
    expect(layer("o1").color).toBe("#ff8800");
    expect(screen.getByLabelText("Colour")).toHaveValue("#ff8800");
    commit("Fade in", "1.2");
    expect(layer("o1").fadeInSec).toBe(1.2);
    commit("Fade out", "0.25 s");
    expect(layer("o1").fadeOutSec).toBe(0.25);
    commit("Start on the timeline", "0:02");
    expect(layer("o1")).toMatchObject({ startSec: 2, endSec: 6 });
    commit("Length", "3");
    expect(layer("o1")).toMatchObject({ startSec: 2, endSec: 5 });
    expect(steps()).toBe(11);
    // What it already is writes nothing: a pressed segment, the same text, a value that does not parse
    fireEvent.click(screen.getByRole("button", { name: "Right" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Weight" })).getByRole("button", { name: "700" }));
    commit("Hex colour", "#FF8800");
    commit("Size", "big");
    expect(steps()).toBe(11);
  });

  it("never cuts the fades to the layer's length, and keeps Start and Length clear of the row's next layer", () => {
    open([text("o1", { startSec: 1, endSec: 5 }), text("o2", { startSec: 6, endSec: 8 })]);
    select("o1");
    renderRail();
    commit("Fade in", "10");
    expect(layer("o1").fadeInSec).toBe(10);
    // The next layer on the row starts at 6
    commit("Length", "9");
    expect(layer("o1")).toMatchObject({ startSec: 1, endSec: 6, row: 0 });
    // Moved onto it, it goes onto a row of its own (as a drag would)
    commit("Start on the timeline", "0:06.5");
    expect(layer("o1")).toMatchObject({ startSec: 6.5, endSec: 11.5, row: 1 });
  });

  it("makes a run of ↑ / ↓ in a well one undo step until the well is left, clamped", () => {
    open([text("o1", { startSec: 1 })]);
    select("o1");
    renderRail();
    const size = well("Size");
    fireEvent.focus(size);
    fireEvent.keyDown(size, { key: "ArrowUp" });
    fireEvent.keyDown(size, { key: "ArrowUp" });
    expect(layer("o1").size).toBe(0.1);
    expect(size.value).toBe("10%");
    expect(editor().past).toHaveLength(1);
    fireEvent.blur(size);
    fireEvent.focus(size);
    fireEvent.keyDown(size, { key: "ArrowDown", shiftKey: true });
    expect(layer("o1").size).toBe(0.01);
    expect(editor().past).toHaveLength(2);
    // At the floor: no step, nothing stored
    fireEvent.keyDown(size, { key: "ArrowDown" });
    expect(layer("o1").size).toBe(0.01);
    expect(editor().past).toHaveLength(2);
    fireEvent.blur(size);
    const start = well("Start on the timeline");
    fireEvent.focus(start);
    fireEvent.keyDown(start, { key: "ArrowUp", shiftKey: true });
    fireEvent.keyDown(start, { key: "ArrowUp" });
    expect(layer("o1")).toMatchObject({ startSec: 2.1, endSec: 6.1 });
    expect(start.value).toBe("0:02.10");
    expect(editor().past).toHaveLength(3);
    fireEvent.blur(start);
    const fadeOut = well("Fade out");
    fireEvent.focus(fadeOut);
    fireEvent.keyDown(fadeOut, { key: "ArrowUp" });
    fireEvent.keyDown(fadeOut, { key: "ArrowUp" });
    fireEvent.keyDown(fadeOut, { key: "ArrowUp" });
    expect(layer("o1").fadeOutSec).toBe(0.8);
    expect(editor().past).toHaveLength(4);
  });

  it("makes a wash drag one undo step: its ticks share one until the pointer is up", () => {
    open([text("o1")]);
    select("o1");
    renderRail();
    const slider = screen.getByRole("slider", { name: "Wash opacity" });
    fireEvent.change(slider, { target: { value: "40" } });
    fireEvent.change(slider, { target: { value: "30" } });
    expect(layer("o1").wash.opacity).toBe(0.3);
    expect(editor().past).toHaveLength(1);
    fireEvent.pointerUp(slider);
    fireEvent.change(slider, { target: { value: "0" } });
    expect(layer("o1").wash.opacity).toBe(0);
    expect(editor().past).toHaveLength(2);
  });

  it("makes a colour drag one undo step, ended by the picker's change or by leaving it", () => {
    open([text("o1")]);
    select("o1");
    renderRail();
    const colour = screen.getByLabelText("Colour");
    expect(colour).toHaveAttribute("type", "color");
    fireEvent.input(colour, { target: { value: "#ff0000" } });
    fireEvent.input(colour, { target: { value: "#00ff00" } });
    expect(layer("o1").color).toBe("#00ff00");
    expect(editor().past).toHaveLength(1);
    // The picker closes on its last colour: still the same step, and the end of it
    fireEvent.change(colour, { target: { value: "#0000ff" } });
    expect(layer("o1").color).toBe("#0000ff");
    expect(editor().past).toHaveLength(1);
    fireEvent.input(colour, { target: { value: "#111111" } });
    expect(editor().past).toHaveLength(2);
    fireEvent.blur(colour);
    fireEvent.input(colour, { target: { value: "#222222" } });
    expect(layer("o1").color).toBe("#222222");
    expect(editor().past).toHaveLength(3);
  });

  it("splits at the playhead and removes the layer, the focus staying on the action pressed", () => {
    open([text("o1", { startSec: 1 })]);
    select("o1");
    renderRail();
    act(() => editor().setPlayhead(3));
    const split = screen.getByRole("button", { name: "Split at playhead" });
    act(() => split.focus());
    fireEvent.click(split);
    expect(layers().map((o) => [o.startSec, o.endSec])).toEqual([
      [1, 3],
      [3, 5],
    ]);
    // The right piece is selected, and the rail is its
    expect(editor().selection).toMatchObject({ kind: "overlay", clipId: layers()[1].id });
    expect(well("Start on the timeline").value).toBe("0:03.00");
    expect(split).toHaveFocus();
    const remove = screen.getByRole("button", { name: "Remove text" });
    act(() => remove.focus());
    fireEvent.click(remove);
    expect(layers()).toHaveLength(1);
    // The left piece takes the selection, in the same rail
    expect(editor().selection).toMatchObject({ kind: "overlay", clipId: "o1" });
    expect(remove).toHaveFocus();
    // The last one gone, the panel takes the focus rather than the page
    fireEvent.click(remove);
    expect(layers()).toEqual([]);
    expect(screen.getByTestId("panel")).toHaveFocus();
  });

  it("shows several layers as a count, with Split at playhead and Remove for all of them", () => {
    open([text("o1", { text: "Hello" }), text("o2", { row: 1, startSec: 2, text: "  " })]);
    select("o1", "o2");
    renderRail();
    expect(screen.getByRole("complementary", { name: "Text" })).toBeInTheDocument();
    expect(screen.getByText("2 text layers")).toBeInTheDocument();
    expect(screen.getByText("Hello, Empty text")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Text" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Font" })).toBeNull();
    act(() => editor().setPlayhead(3));
    fireEvent.click(screen.getByRole("button", { name: "Split at playhead" }));
    expect(layers()).toHaveLength(4);
    act(() => editor().undo());
    select("o1", "o2");
    const remove = screen.getByRole("button", { name: "Remove 2 text layers" });
    expect(remove).toHaveAttribute("aria-keyshortcuts", "Backspace");
    act(() => remove.focus());
    fireEvent.click(remove);
    expect(layers()).toEqual([]);
    expect(screen.getByTestId("panel")).toHaveFocus();
  });

  it("says when the text does not fit the frame", () => {
    const ctx = { font: "10px sans-serif", measureText: (s: string) => ({ width: s.length * 10 }) };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as never);
    // Two lines at half the frame's height: taller than the frame inside its margins
    open([text("o1", { text: "One\nTwo", size: 0.5 })]);
    select("o1");
    renderRail();
    expect(screen.getByText("The text doesn't fit the frame: some of it falls outside.")).toBeInTheDocument();
    commit("Size", "20");
    expect(screen.queryByText(/doesn't fit/)).toBeNull();
  });

  it("names the rail Text, and asks for a layer to be selected in an edit of text alone", () => {
    open([text("o1")], { video: false });
    renderRail();
    expect(screen.getByRole("complementary", { name: "Clip" })).toBeInTheDocument();
    expect(screen.getByText("Select a text layer to edit it.")).toBeInTheDocument();
    select("o1");
    expect(screen.getByRole("complementary", { name: "Text" })).toBeInTheDocument();
    expect(well("Text").value).toBe("Title");
  });

  it("focuses the text of a layer \"+ Text\" adds, all of it selected, so typing replaces it", () => {
    open([]);
    renderRail();
    act(() => {
      addTextOverlay();
    });
    const area = well("Text");
    expect(area).toHaveFocus();
    expect([area.selectionStart, area.selectionEnd]).toEqual([0, "Title".length]);
    // Only the layer just added: selecting it again later leaves the focus where it is
    act(() => area.blur());
    const id = layers()[0].id;
    act(() => editor().select(null));
    select(id);
    expect(well("Text")).not.toHaveFocus();
  });
});

describe("the font field", () => {
  function openOn(init: Partial<StitchOverlay> = {}) {
    open([text("o1", init)]);
    select("o1");
    renderRail();
  }

  it("opens on a click with the app's fonts, the font files and Add font file…; a row's click takes it", async () => {
    openOn();
    act(() => combobox().focus());
    fireEvent.click(combobox());
    expect(combobox()).toHaveAttribute("aria-expanded", "true");
    const list = listbox()!;
    expect(combobox()).toHaveAttribute("aria-controls", list.id);
    const app = within(list).getByRole("group", { name: "In the app" });
    expect(within(app).getAllByRole("option").map((o) => [o.textContent, o.getAttribute("aria-selected")])).toEqual([
      ["Space Grotesk", "true"],
      ["JetBrains Mono", "false"],
      ["Sans serif", "false"],
      ["Serif", "false"],
      ["Monospace", "false"],
    ]);
    // The current font is lit
    expect(combobox()).toHaveAttribute("aria-activedescendant", option("Space Grotesk").id);
    const files = await within(list).findByRole("group", { name: "Font files" });
    expect(within(files).getByRole("option", { name: "Georgia" })).toBeInTheDocument();
    expect(within(within(list).getByRole("group", { name: "More fonts" })).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Add font file…",
    ]);
    // No installed fonts where the browser cannot list them
    expect(within(list).queryByRole("group", { name: "On this computer" })).toBeNull();
    // JetBrains Mono has 400 and 500: the layer's 600 goes to 500 in the same step
    press(option("JetBrains Mono"));
    expect(layer("o1")).toMatchObject({ font: { family: "JetBrains Mono" }, weight: 500 });
    expect(editor().past).toHaveLength(1);
    expect(listbox()).toBeNull();
    expect(combobox()).toHaveFocus();
    expect(combobox().value).toBe("JetBrains Mono");
    expect(segments("Weight")).toEqual([
      ["400", "false"],
      ["500", "true"],
    ]);
  });

  it("filters as it is typed, lights the best match, and Enter takes it", async () => {
    openOn();
    act(() => combobox().focus());
    fireEvent.change(combobox(), { target: { value: "ser" } });
    expect(within(listbox()!).getAllByRole("option").map((o) => o.textContent)).toEqual(
      expect.arrayContaining(["Sans serif", "Serif"]),
    );
    expect(within(listbox()!).queryByRole("option", { name: "JetBrains Mono" })).toBeNull();
    // Starting with it beats having it
    expect(combobox()).toHaveAttribute("aria-activedescendant", option("Serif").id);
    await within(listbox()!).findByRole("option", { name: "Add font file…" });
    fireEvent.keyDown(combobox(), { key: "Enter" });
    expect(layer("o1").font).toEqual({ family: "serif" });
    expect(combobox().value).toBe("Serif");
    expect(listbox()).toBeNull();
  });

  it("offers a typed name that matches nothing as a family of its own, lit, and Enter takes it with the weight kept", () => {
    openOn();
    act(() => combobox().focus());
    fireEvent.change(combobox(), { target: { value: "  Futura PT " } });
    expect(within(listbox()!).getAllByRole("option", { name: /Futura/ }).map((o) => o.textContent)).toEqual(["Use “Futura PT”"]);
    expect(combobox()).toHaveAttribute("aria-activedescendant", option("Use “Futura PT”").id);
    fireEvent.keyDown(combobox(), { key: "Enter" });
    expect(layer("o1")).toMatchObject({ font: { family: "Futura PT" }, weight: 600 });
    expect(layer("o1").font).not.toHaveProperty("file");
    expect(editor().past).toHaveLength(1);
    expect(combobox().value).toBe("Futura PT");
  });

  it("offers the typed name above the matches when a listed font has it in its name, by the arrows or a click", async () => {
    vi.mocked(fonts.listFontFiles).mockResolvedValue({
      fonts: [{ name: "Roboto Condensed.ttf", format: "ttf", bytes: 1000, modifiedAt: 1 }],
      folder: "/Library/Fonts",
    });
    openOn();
    act(() => combobox().focus());
    fireEvent.click(combobox());
    await within(listbox()!).findByRole("option", { name: "Roboto Condensed" });
    fireEvent.change(combobox(), { target: { value: "Roboto" } });
    expect(within(listbox()!).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Use “Roboto”",
      "Roboto Condensed",
      "Add font file…",
    ]);
    // The best match is lit; the typed name is a ↑ away
    expect(combobox()).toHaveAttribute("aria-activedescendant", option("Roboto Condensed").id);
    fireEvent.keyDown(combobox(), { key: "ArrowUp" });
    expect(combobox()).toHaveAttribute("aria-activedescendant", option("Use “Roboto”").id);
    fireEvent.keyDown(combobox(), { key: "Enter" });
    expect(layer("o1").font).toEqual({ family: "Roboto" });
    expect(listbox()).toBeNull();

    fireEvent.change(combobox(), { target: { value: "Rob" } });
    press(option("Use “Rob”"));
    expect(layer("o1").font).toEqual({ family: "Rob" });
    expect(editor().past).toHaveLength(2);
    // A name a listed font has exactly is that font: no row of its own
    fireEvent.change(combobox(), { target: { value: "serif" } });
    expect(within(listbox()!).queryByRole("option", { name: /^Use/ })).toBeNull();
    expect(combobox()).toHaveAttribute("aria-activedescendant", option("Serif").id);
  });

  it("leaves an input method's keys to it: its Enter takes nothing, its arrows move no light, its Escape closes nothing", () => {
    openOn();
    act(() => combobox().focus());
    fireEvent.change(combobox(), { target: { value: "ヒラギノ" } });
    const lit = combobox().getAttribute("aria-activedescendant");
    const keys = windowKeys();
    // Chromium sends the Enter that takes a conversion while composing; Safari ends the composition first, with
    // keyCode 229 still on the key
    fireEvent.keyDown(combobox(), { key: "Enter", isComposing: true });
    fireEvent.keyDown(combobox(), { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(combobox(), { key: "ArrowDown", isComposing: true });
    expect(fireEvent.keyDown(combobox(), { key: "Escape", isComposing: true })).toBe(true);
    keys.stop();
    // Nothing behind the field hears the Escape: the node's dialog would close on it
    expect(keys.heard.mock.calls.map(([event]) => (event as KeyboardEvent).key)).toEqual(["Enter", "Enter", "ArrowDown"]);
    expect(listbox()).not.toBeNull();
    expect(combobox()).toHaveAttribute("aria-activedescendant", lit!);
    expect(combobox()).toHaveFocus();
    expect(combobox().value).toBe("ヒラギノ");
    expect(editor().past).toHaveLength(0);
    // The conversion done, Enter is the field's again
    fireEvent.keyDown(combobox(), { key: "Enter" });
    expect(layer("o1").font).toEqual({ family: "ヒラギノ" });
  });

  it("moves the light with the arrows through the fonts and the actions, round the ends", async () => {
    openOn();
    act(() => combobox().focus());
    // ↓ opens it, on the current font
    fireEvent.keyDown(combobox(), { key: "ArrowDown" });
    await within(listbox()!).findByRole("option", { name: "Add font file…" });
    const lit = () => document.getElementById(combobox().getAttribute("aria-activedescendant")!)?.textContent;
    expect(lit()).toBe("Space Grotesk");
    fireEvent.keyDown(combobox(), { key: "ArrowDown" });
    expect(lit()).toBe("JetBrains Mono");
    fireEvent.keyDown(combobox(), { key: "ArrowUp" });
    fireEvent.keyDown(combobox(), { key: "ArrowUp" });
    expect(lit()).toBe("Add font file…");
    fireEvent.keyDown(combobox(), { key: "ArrowUp" });
    expect(lit()).toBe("Georgia");
    fireEvent.keyDown(combobox(), { key: "Enter" });
    expect(layer("o1").font).toEqual({ family: "Georgia", file: "Georgia.ttf" });
  });

  it("puts typed text back on leaving: only Enter or a click takes a font", () => {
    openOn();
    act(() => combobox().focus());
    fireEvent.change(combobox(), { target: { value: "Geo" } });
    expect(listbox()).not.toBeNull();
    fireEvent.blur(combobox());
    expect(listbox()).toBeNull();
    expect(combobox().value).toBe("Space Grotesk");
    expect(layer("o1").font).toEqual({ family: "Space Grotesk" });
    expect(editor().past).toHaveLength(0);
  });

  it("closes the list on Escape, leaves the field on a second, and the editor hears neither; Tab closes it too", () => {
    openOn();
    act(() => combobox().focus());
    fireEvent.change(combobox(), { target: { value: "Mono" } });
    const keys = windowKeys();
    fireEvent.keyDown(combobox(), { key: "Escape" });
    expect(listbox()).toBeNull();
    expect(combobox()).toHaveFocus();
    expect(combobox().value).toBe("Space Grotesk");
    fireEvent.keyDown(combobox(), { key: "Escape" });
    keys.stop();
    expect(keys.heard).not.toHaveBeenCalled();
    expect(screen.getByTestId("panel")).toHaveFocus();
    expect(editor().past).toHaveLength(0);
    act(() => combobox().focus());
    fireEvent.click(combobox());
    expect(listbox()).not.toBeNull();
    fireEvent.keyDown(combobox(), { key: "Tab" });
    expect(listbox()).toBeNull();
  });

  it("sets weight 400 with a font file in the same step, and turns Weight off with its note", async () => {
    openOn();
    fireEvent.click(combobox());
    press(await within(listbox()!).findByRole("option", { name: "Georgia" }));
    expect(layer("o1")).toMatchObject({ font: { family: "Georgia", file: "Georgia.ttf" }, weight: 400 });
    expect(editor().past).toHaveLength(1);
    expect(combobox().value).toBe("Georgia");
    const weight = within(screen.getByRole("group", { name: "Weight" })).getAllByRole("button");
    expect(weight.map((b) => b.textContent)).toEqual(["400", "500", "600", "700"]);
    for (const button of weight) {
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("aria-pressed", "false");
      expect(button).toHaveAttribute("title", "A font file draws at its own weight");
    }
  });

  it("snaps the weight to one a shipped face has when one is chosen", () => {
    openOn({ font: { family: "Helvetica" }, weight: 400 });
    // An installed or typed family offers 400 to 700
    expect(segments("Weight").map(([label]) => label)).toEqual(["400", "500", "600", "700"]);
    fireEvent.click(combobox());
    press(option("Space Grotesk"));
    expect(layer("o1")).toMatchObject({ font: { family: "Space Grotesk" }, weight: 500 });
    expect(editor().past).toHaveLength(1);
  });

  it("says when the font is not on this computer, or could not be read", async () => {
    vi.mocked(fonts.ensureOverlayFonts).mockImplementation(async ([o]) => {
      const state = o.font.file ? "failed" : "missing";
      return new Map([[fonts.fontKey(o.font), { list: "sans-serif", state }]]);
    });
    openOn({ font: { family: "Futura PT" } });
    expect(await screen.findByText("Futura PT isn't on this computer: Space Grotesk stands in.")).toBeInTheDocument();
    fireEvent.click(combobox());
    press(await within(listbox()!).findByRole("option", { name: "Georgia" }));
    expect(await screen.findByText("Georgia couldn't be read: Space Grotesk stands in.")).toBeInTheDocument();
    expect(screen.queryByText(/isn't on this computer/)).toBeNull();
  });

  it("asks again once the page's fonts change", async () => {
    // The page's font set, which says when faces have loaded
    Object.defineProperty(document, "fonts", { value: new EventTarget(), configurable: true });
    try {
      vi.mocked(fonts.ensureOverlayFonts).mockImplementation(async ([o]) => {
        return new Map([[fonts.fontKey(o.font), { list: "sans-serif", state: "missing" }]]);
      });
      openOn({ font: { family: "Georgia", file: "Georgia.ttf" } });
      expect(await screen.findByText("Georgia isn't on this computer: Space Grotesk stands in.")).toBeInTheDocument();
      vi.mocked(fonts.ensureOverlayFonts).mockResolvedValue(new Map());
      act(() => {
        document.fonts.dispatchEvent(new Event("loadingdone"));
      });
      await waitFor(() => expect(screen.queryByText(/stands in/)).toBeNull());
    } finally {
      delete (document as { fonts?: unknown }).fonts;
    }
  });

  it("offers Show fonts on this computer only while listing them would ask, and lists them once allowed", async () => {
    vi.mocked(fonts.localFontsPermission).mockResolvedValue("prompt");
    vi.mocked(fonts.installedFamilies).mockResolvedValue(["Arial", "Helvetica Neue"]);
    openOn();
    fireEvent.click(combobox());
    const ask = await within(listbox()!).findByRole("option", { name: "Show fonts on this computer" });
    expect(fonts.installedFamilies).not.toHaveBeenCalled();
    press(ask);
    // Straight from the press, with nothing awaited first: where it asks, the browser wants the gesture
    expect(fonts.installedFamilies).toHaveBeenCalledTimes(1);
    const computer = await within(listbox()!).findByRole("group", { name: "On this computer" });
    expect(within(computer).getAllByRole("option").map((o) => o.textContent)).toEqual(["Arial", "Helvetica Neue"]);
    expect(within(listbox()!).queryByRole("option", { name: "Show fonts on this computer" })).toBeNull();
    press(option("Helvetica Neue"));
    expect(layer("o1")).toMatchObject({ font: { family: "Helvetica Neue" }, weight: 600 });
  });

  it("lists the installed fonts on opening where the browser allows it, and offers nothing where it refused", async () => {
    vi.mocked(fonts.localFontsPermission).mockResolvedValue("granted");
    vi.mocked(fonts.installedFamilies).mockResolvedValue(["Arial"]);
    openOn();
    fireEvent.click(combobox());
    expect(await within(listbox()!).findByRole("option", { name: "Arial" })).toBeInTheDocument();
    expect(within(listbox()!).queryByRole("option", { name: "Show fonts on this computer" })).toBeNull();
    fireEvent.keyDown(combobox(), { key: "Escape" });

    vi.mocked(fonts.localFontsPermission).mockResolvedValue("denied");
    vi.mocked(fonts.installedFamilies).mockClear();
    fireEvent.click(combobox());
    await within(listbox()!).findByRole("option", { name: "Add font file…" });
    await waitFor(() => expect(fonts.localFontsPermission).toHaveBeenCalledTimes(2));
    expect(within(listbox()!).queryByRole("option", { name: "Show fonts on this computer" })).toBeNull();
    expect(fonts.installedFamilies).not.toHaveBeenCalled();
  });

  it("reads the Fonts folder again at each opening, so a file copied into it since shows", async () => {
    openOn();
    fireEvent.click(combobox());
    await within(listbox()!).findByRole("option", { name: "Georgia" });
    expect(within(listbox()!).queryByRole("option", { name: "Inter" })).toBeNull();
    fireEvent.keyDown(combobox(), { key: "Escape" });
    expect(listbox()).toBeNull();
    vi.mocked(fonts.listFontFiles).mockResolvedValue({ fonts: [GEORGIA, INTER], folder: "/Library/Fonts" });
    fireEvent.click(combobox());
    expect(await within(listbox()!).findByRole("option", { name: "Inter" })).toBeInTheDocument();
    expect(fonts.listFontFiles).toHaveBeenCalledTimes(2);
  });

  it("hides Add font file… where there is no Fonts folder", async () => {
    vi.mocked(fonts.listFontFiles).mockResolvedValue(null);
    openOn();
    fireEvent.click(combobox());
    await waitFor(() => expect(fonts.listFontFiles).toHaveBeenCalled());
    await act(async () => {});
    expect(within(listbox()!).queryByRole("option", { name: "Add font file…" })).toBeNull();
    expect(within(listbox()!).queryByRole("group", { name: "Font files" })).toBeNull();
  });

  it("adds a font file from Add font file… and takes it, or says why it could not", async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    vi.mocked(fonts.addFontFile).mockResolvedValueOnce({ name: "Inter Display.otf", format: "otf", bytes: 10, modifiedAt: 2 });
    openOn();
    fireEvent.click(combobox());
    press(await within(listbox()!).findByRole("option", { name: "Add font file…" }));
    expect(listbox()).toBeNull();
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(click).toHaveBeenCalledTimes(1);
    expect(click.mock.contexts[0]).toBe(input);
    expect(input).toHaveAttribute("accept", FONT_ACCEPT);
    const file = new File([new Uint8Array([0, 1, 0, 0])], "Inter Display.otf");
    fireEvent.change(input, { target: { files: [file] } });
    expect(fonts.addFontFile).toHaveBeenCalledWith(file);
    await waitFor(() => expect(layer("o1").font).toEqual({ family: "Inter Display", file: "Inter Display.otf" }));
    expect(layer("o1").weight).toBe(400);
    expect(editor().past).toHaveLength(1);

    vi.mocked(fonts.addFontFile).mockRejectedValueOnce(
      new fonts.FontFileError("Font collections (.ttc) can't be used: add a single .ttf or .otf.", 415),
    );
    fireEvent.change(input, { target: { files: [new File(["ttcf"], "Pack.ttc")] } });
    expect(await screen.findByText("Font collections (.ttc) can't be used: add a single .ttf or .otf.")).toBeInTheDocument();
    expect(editor().past).toHaveLength(1);
    // Opening the list again clears it
    fireEvent.click(combobox());
    expect(screen.queryByText(/Font collections/)).toBeNull();
  });

  it("finds a missing font file once Add font file… adds it back, the layer's font as it was", async () => {
    // The Fonts folder's own add, against a server that keeps the file under its name
    const { addFontFile } = await vi.importActual<typeof import("@/lib/stitch/fonts")>("@/lib/stitch/fonts");
    vi.mocked(fonts.addFontFile).mockImplementation(addFontFile);
    let added = false;
    const post = vi.fn(async () => {
      added = true;
      return new Response(JSON.stringify({ font: INTER }), { status: 201 });
    });
    vi.stubGlobal("fetch", post);
    vi.mocked(fonts.ensureOverlayFonts).mockImplementation(async ([o]) => {
      const font = added ? { list: `"${fonts.fileFamily("Inter.ttf")}", sans-serif`, state: "ready" as const } : { list: "sans-serif", state: "missing" as const };
      return new Map([[fonts.fontKey(o.font), font]]);
    });
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    // Made on another computer: this one's Fonts folder has no Inter.ttf
    openOn({ font: { family: "Inter", file: "Inter.ttf" }, weight: 400 });
    expect(await screen.findByText("Inter isn't on this computer: Space Grotesk stands in.")).toBeInTheDocument();
    fireEvent.click(combobox());
    press(await within(listbox()!).findByRole("option", { name: "Add font file…" }));
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(input, { target: { files: [new File([new Uint8Array([0, 1, 0, 0])], "Inter.ttf")] } });
    expect(post).toHaveBeenCalledWith("/api/fonts?name=Inter.ttf", expect.objectContaining({ method: "POST" }));
    await waitFor(() => expect(screen.queryByText(/stands in/)).toBeNull());
    // The same font and weight: nothing to undo
    expect(layer("o1")).toMatchObject({ font: { family: "Inter", file: "Inter.ttf" }, weight: 400 });
    expect(editor().past).toHaveLength(0);
  });
});

describe("the font list's place", () => {
  function openList() {
    open([text("o1")]);
    select("o1");
    renderRail();
    act(() => combobox().focus());
    fireEvent.click(combobox());
    expect(listbox()).not.toBeNull();
  }

  /** The field's box: `top` px down a window of jsdom's height. */
  function fieldAt(top: number) {
    vi.spyOn(combobox().parentElement!, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ x: 20, y: top, width: 240, height: 32 }),
    );
  }

  // Fixed over the page, it would float off its field
  it("closes when the rail or the page scrolls", () => {
    openList();
    fireEvent.scroll(screen.getByRole("complementary", { name: "Text" }));
    expect(listbox()).toBeNull();
    fireEvent.click(combobox());
    expect(listbox()).not.toBeNull();
    fireEvent.scroll(document);
    expect(listbox()).toBeNull();
  });

  it("stays open as its own rows scroll, or the field's text", () => {
    openList();
    fireEvent.scroll(listbox()!);
    fireEvent.scroll(combobox());
    expect(listbox()).not.toBeNull();
  });

  it("closes when the window changes size", () => {
    openList();
    fireEvent(window, new Event("resize"));
    expect(listbox()).toBeNull();
  });

  it("hangs under the field, or over it when there is no room below", () => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(200);
    open([text("o1")]);
    select("o1");
    renderRail();
    fieldAt(100);
    fireEvent.click(combobox());
    expect(listbox()!.style).toMatchObject({ left: "20px", top: `${132 + 4}px`, width: "240px" });
    fireEvent.keyDown(combobox(), { key: "Escape" });
    fieldAt(window.innerHeight - 40);
    fireEvent.click(combobox());
    expect(listbox()!.style.top).toBe(`${window.innerHeight - 40 - 4 - 200}px`);
  });
});
