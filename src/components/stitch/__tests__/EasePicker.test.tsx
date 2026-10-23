import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { easingLabel, easingPolyline, isIdentityBezier } from "@/lib/easing";
import { RAMP_PRESETS, seedRamp, type RampMode } from "@/lib/stitch/rampModes";
import type { ClipWarpCurve } from "@/types";
import { EasePicker, type EasePickerProps } from "../EasePicker";

// The rail's ramp picker alone: its four modes, the preset grid, the bezier editor held through the diagonal, and the
// drawn points. jsdom lays nothing out, so the bezier editor's square is mocked at the page's origin, 260px.

const QUAD: ClipWarpCurve = { kind: "preset", name: "easeInQuad" };
const BEZIER: ClipWarpCurve = { kind: "bezier", handles: [0.42, 0, 0.58, 1] };
const POINTS: ClipWarpCurve = {
  kind: "points",
  points: [
    [0, 0],
    [0.3, 0.1],
    [0.7, 0.8],
    [1, 1],
  ],
};
const PIECE: [number, number] = [0.3, 1];

const onChange = vi.fn();
const onGestureEnd = vi.fn();
const onPoints = vi.fn();

function renderPicker(props: Partial<EasePickerProps> = {}) {
  return render(
    <EasePicker
      curve={null}
      gestureKey="curve:a"
      onChange={onChange}
      onGestureEnd={onGestureEnd}
      onPoints={onPoints}
      {...props}
    />,
  );
}

/** The picker over a stored ramp, as the store keeps it: a bezier on the diagonal is no ramp. */
function Stored({ initial }: { initial: ClipWarpCurve | null }) {
  const [curve, setCurve] = useState(initial);
  return (
    <div data-stitch-editor="" tabIndex={-1} data-testid="panel">
      <EasePicker
        curve={curve}
        gestureKey="curve:a"
        onChange={(next, opts) => {
          onChange(next, opts);
          setCurve(next?.kind === "bezier" && isIdentityBezier(next.handles) ? null : next);
        }}
        onGestureEnd={onGestureEnd}
      />
      <span data-testid="stored">{curve === null ? "none" : curve.kind}</span>
    </div>
  );
}

const modes = () =>
  within(screen.getByRole("group", { name: "Ramp" }))
    .getAllByRole("button")
    .map((b) => [b.textContent, b.getAttribute("aria-pressed")]);
const pressed = () => modes().find(([, on]) => on === "true")?.[0];
const mode = (name: string) => within(screen.getByRole("group", { name: "Ramp" })).getByRole("button", { name });
const thumbs = () => within(screen.getByRole("group", { name: "Ramp presets" })).getAllByRole("button");
const handle = (i: 1 | 2) => screen.getByLabelText(`Adjust control point ${i}`);
/** The bezier editor's square, 260px at the origin. */
function mockSquare(container: HTMLElement) {
  vi.spyOn(container.querySelector(".relative.w-full")!, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 260,
    height: 260,
    right: 260,
    bottom: 260,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
}
/** A drag of a handle from its centre to (x, y) in the unit square, released there. */
function drag(i: 1 | 2, from: [number, number], to: [number, number], release = true) {
  fireEvent.pointerDown(handle(i), { clientX: from[0] * 260, clientY: (1 - from[1]) * 260 });
  fireEvent.pointerMove(window, { clientX: to[0] * 260, clientY: (1 - to[1]) * 260 });
  if (release) fireEvent.pointerUp(window);
}

beforeEach(() => {
  onChange.mockClear();
  onGestureEnd.mockClear();
  onPoints.mockClear();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    cb(0);
    return 0;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("EasePicker", () => {
  it("shows the stored ramp's mode, a split piece as Points", () => {
    for (const [curve, window, shown] of [
      [null, undefined, "None"],
      [QUAD, undefined, "Preset"],
      [BEZIER, undefined, "Bezier"],
      [POINTS, undefined, "Points"],
      [QUAD, PIECE, "Points"],
    ] as const) {
      const view = renderPicker({ curve, window });
      expect(modes().map(([label]) => label)).toEqual(["None", "Preset", "Bezier", "Points"]);
      expect(pressed()).toBe(shown);
      view.unmount();
    }
  });

  it("offers the presets as named curve thumbnails, one tab stop, the arrows, Home and End moving and a press picking", () => {
    renderPicker({ curve: { kind: "preset", name: "easeInOutSine" } });
    const buttons = thumbs();
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(RAMP_PRESETS.map(easingLabel));
    expect(buttons.filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.title)).toEqual(["Ease in-out sine"]);
    RAMP_PRESETS.forEach((name, i) => {
      expect(buttons[i].querySelector("polyline")!.getAttribute("points")).toBe(easingPolyline(name, 24, 24, 20));
    });
    const stop = buttons.filter((b) => b.tabIndex === 0);
    expect(stop).toEqual([buttons[RAMP_PRESETS.indexOf("easeInOutSine")]]);

    act(() => buttons[0].focus());
    fireEvent.keyDown(buttons[0], { key: "ArrowRight" });
    expect(document.activeElement).toBe(buttons[1]);
    fireEvent.keyDown(buttons[1], { key: "ArrowDown" });
    expect(document.activeElement).toBe(buttons[7]);
    fireEvent.keyDown(buttons[7], { key: "ArrowUp" });
    fireEvent.keyDown(buttons[1], { key: "ArrowLeft" });
    fireEvent.keyDown(buttons[0], { key: "ArrowLeft" });
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.keyDown(buttons[0], { key: "End" });
    expect(document.activeElement).toBe(buttons[22]);
    fireEvent.keyDown(buttons[22], { key: "Home" });
    expect(document.activeElement).toBe(buttons[0]);
    // Enter is the button's own: a click (Space plays in the editor)
    fireEvent.click(buttons[3]);
    expect(onChange).toHaveBeenLastCalledWith({ kind: "preset", name: RAMP_PRESETS[3] });
  });

  it("seeds each mode it switches to, does nothing for the mode shown, but Points opens the row each time", () => {
    const cases: Array<[ClipWarpCurve | null, RampMode]> = [
      [null, "preset"],
      [null, "bezier"],
      [null, "points"],
      [QUAD, "bezier"],
      [BEZIER, "none"],
      [POINTS, "preset"],
    ];
    for (const [curve, to] of cases) {
      onChange.mockClear();
      const view = renderPicker({ curve, maxError: 0.004 });
      fireEvent.click(mode(to[0].toUpperCase() + to.slice(1)));
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange.mock.calls[0]).toEqual([seedRamp(to, curve, undefined, 0.004)]);
      view.unmount();
    }
    onChange.mockClear();
    onPoints.mockClear();
    const view = renderPicker({ curve: QUAD });
    fireEvent.click(mode("Preset"));
    expect(onChange).not.toHaveBeenCalled();
    view.unmount();
    renderPicker({ curve: QUAD, window: PIECE });
    fireEvent.click(mode("Points"));
    fireEvent.click(mode("Points"));
    expect(onChange).not.toHaveBeenCalled();
    expect(onPoints).toHaveBeenCalledTimes(2);
  });

  it("keeps the bezier editor under the pointer while a drag crosses the diagonal", () => {
    const { container } = render(<Stored initial={BEZIER} />);
    mockSquare(container);
    drag(1, [0.42, 0], [0, 0]);
    expect(screen.getByTestId("stored")).toHaveTextContent("bezier");
    onGestureEnd.mockClear();
    // Handle 2 into the top-right corner: on the diagonal, so nothing is stored, and the editor stays
    drag(2, [0.58, 1], [1, 1], false);
    expect(onChange).toHaveBeenLastCalledWith({ kind: "bezier", handles: [0, 0, 1, 1] }, { gestureKey: "curve:a" });
    expect(screen.getByTestId("stored")).toHaveTextContent("none");
    expect(handle(2)).toBeInTheDocument();
    expect(pressed()).toBe("Bezier");
    // Off the diagonal again, and back onto it to let go
    fireEvent.pointerMove(window, { clientX: 260, clientY: 26 });
    expect(screen.getByTestId("stored")).toHaveTextContent("bezier");
    fireEvent.pointerMove(window, { clientX: 260, clientY: 0 });
    fireEvent.pointerUp(window);
    expect(onGestureEnd).toHaveBeenCalledTimes(1);
    expect(pressed()).toBe("None");
    expect(screen.queryByLabelText("Adjust control point 1")).toBeNull();
  });

  it("keeps it through the arrow keys too, and hands focus to the panel when it goes", () => {
    render(<Stored initial={{ kind: "bezier", handles: [0.42, 0.41, 0.58, 0.58] }} />);
    const first = handle(1);
    act(() => first.focus());
    fireEvent.keyDown(first, { key: "ArrowUp" });
    expect(onChange).toHaveBeenLastCalledWith({ kind: "bezier", handles: [0.42, 0.42, 0.58, 0.58] }, { gestureKey: "curve:a" });
    expect(screen.getByTestId("stored")).toHaveTextContent("none");
    expect(handle(1)).toBe(first);
    expect(onGestureEnd).not.toHaveBeenCalled();
    fireEvent.keyUp(first, { key: "ArrowUp" });
    expect(onGestureEnd).toHaveBeenCalledTimes(1);
    expect(pressed()).toBe("None");
    expect(document.activeElement).toBe(screen.getByTestId("panel"));
  });

  it("draws the bezier editor in the editor's tone", () => {
    const { container } = renderPicker({ curve: BEZIER });
    expect(container.querySelector("svg rect")).toHaveClass("fill-pane");
    expect(container.innerHTML).not.toMatch(/lime/);
  });

  it("draws a points ramp with its knots, and a split piece without them, with its note", () => {
    const view = renderPicker({ curve: POINTS });
    const preview = screen.getByTestId("stitch-ramp-preview");
    expect(preview.querySelectorAll("polyline")).toHaveLength(1);
    expect(preview.querySelectorAll("circle")).toHaveLength(2);
    expect(screen.queryByText("Part of a ramp, cut by a split.")).toBeNull();
    view.unmount();
    renderPicker({ curve: POINTS, window: PIECE });
    expect(screen.getByTestId("stitch-ramp-preview").querySelectorAll("circle")).toHaveLength(0);
    expect(screen.getByText("Part of a ramp, cut by a split.")).toBeInTheDocument();
  });

  it("turns every control off while disabled", () => {
    const view = renderPicker({ curve: QUAD, disabled: true });
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
    view.unmount();
    renderPicker({ curve: BEZIER, disabled: true });
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
  });
});
