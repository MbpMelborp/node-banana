import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { CubicBezierEditor } from "@/components/CubicBezierEditor";

describe("CubicBezierEditor", () => {
  const defaultValue: [number, number, number, number] = [0.42, 0, 0.58, 1];
  const mockOnChange = vi.fn();
  const mockOnCommit = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    // Mock requestAnimationFrame for RAF throttling
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 0;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const renderEditor = (
    props: Partial<React.ComponentProps<typeof CubicBezierEditor>> = {}
  ) =>
    render(
      <CubicBezierEditor
        value={defaultValue}
        onChange={mockOnChange}
        onCommit={mockOnCommit}
        {...props}
      />
    );

  describe("SVG Rendering", () => {
    it("should render an SVG with viewBox", () => {
      const { container } = renderEditor();
      const svg = container.querySelector("svg");
      expect(svg).toBeInTheDocument();
      expect(svg?.getAttribute("viewBox")).toBe("0 0 100 100");
    });

    it("should render grid lines", () => {
      const { container } = renderEditor();
      const lines = container.querySelectorAll("svg line");
      // Should have grid lines (horizontal, vertical, diagonal) + control point lines
      expect(lines.length).toBeGreaterThanOrEqual(3);
    });

    it("should render a bezier curve path", () => {
      const { container } = renderEditor();
      const path = container.querySelector("svg path");
      expect(path).toBeInTheDocument();
      expect(path?.getAttribute("d")).toContain("M0 100 C");
    });
  });

  describe("Control Points", () => {
    it("should render two control point buttons", () => {
      renderEditor();
      expect(screen.getByLabelText("Adjust control point 1")).toBeInTheDocument();
      expect(screen.getByLabelText("Adjust control point 2")).toBeInTheDocument();
    });

    it("should position control point 1 based on value", () => {
      renderEditor({ value: [0.25, 0.1, 0.75, 0.9] });
      const cp1 = screen.getByLabelText("Adjust control point 1");
      // left = v0 * 100 = 25%, top = (1 - v1) * 100 = 90%
      // jsdom normalizes "25.00%" to "25%" — match the CSS-normalized form
      expect(cp1.style.left).toBe("25%");
      expect(cp1.style.top).toBe("90%");
    });

    it("should position control point 2 based on value", () => {
      renderEditor({ value: [0.25, 0.1, 0.75, 0.9] });
      const cp2 = screen.getByLabelText("Adjust control point 2");
      // left = v2 * 100 = 75%, top = (1 - v3) * 100 = 10%
      expect(cp2.style.left).toBe("75%");
      expect(cp2.style.top).toBe("10%");
    });

    it("should update positions when value changes", () => {
      const { rerender } = renderEditor({ value: [0, 0, 1, 1] });
      const cp1 = screen.getByLabelText("Adjust control point 1");
      expect(cp1.style.left).toBe("0%");

      rerender(
        <CubicBezierEditor
          value={[0.5, 0.5, 0.5, 0.5]}
          onChange={mockOnChange}
          onCommit={mockOnCommit}
        />
      );
      expect(cp1.style.left).toBe("50%");
    });
  });

  describe("Disabled State", () => {
    it("should disable control points when disabled=true", () => {
      renderEditor({ disabled: true });
      expect(screen.getByLabelText("Adjust control point 1")).toBeDisabled();
      expect(screen.getByLabelText("Adjust control point 2")).toBeDisabled();
    });

    it("should not start dragging when disabled", () => {
      renderEditor({ disabled: true });
      const cp1 = screen.getByLabelText("Adjust control point 1");
      fireEvent.pointerDown(cp1, { clientX: 50, clientY: 50 });
      // Should not have any ring class since dragging shouldn't start
      expect(cp1.className).not.toContain("ring-2");
    });
  });

  describe("Pointer Drag Interaction", () => {
    /** The editor 260px square at the page's origin, as jsdom lays nothing out. */
    const mockRect = (container: HTMLElement) =>
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
    const moveTo = (clientX: number, clientY: number) => fireEvent.pointerMove(window, { clientX, clientY });
    const lastChange = () => mockOnChange.mock.calls[mockOnChange.mock.calls.length - 1][0] as number[];

    it("moves a handle by the pointer's travel, never to the press", () => {
      const { container } = renderEditor();
      mockRect(container);
      fireEvent.pointerDown(screen.getByLabelText("Adjust control point 1"), { clientX: 130, clientY: 130 });
      expect(mockOnChange).not.toHaveBeenCalled();
      moveTo(156, 130);
      expect(mockOnChange).toHaveBeenCalledTimes(1);
      const [x1, y1, x2, y2] = lastChange();
      expect(x1).toBeCloseTo(0.52, 12);
      expect(y1).toBeCloseTo(0, 12);
      expect([x2, y2]).toEqual([0.58, 1]);
    });

    it("lets a handle held off-centre reach the far edge", () => {
      const { container } = renderEditor();
      mockRect(container);
      // Handle 1 sits on the foot (y 0): held 5px over its centre, then dragged far above the editor
      fireEvent.pointerDown(screen.getByLabelText("Adjust control point 1"), { clientX: 0.42 * 260, clientY: 255 });
      moveTo(0.42 * 260, -400);
      expect(lastChange()[1]).toBe(1);
      fireEvent.pointerUp(window);
      // Handle 2 sits at the top (y 1): held 5px under its centre, then dragged far below
      fireEvent.pointerDown(screen.getByLabelText("Adjust control point 2"), { clientX: 0.58 * 260, clientY: 5 });
      moveTo(0.58 * 260, 900);
      expect(lastChange()[3]).toBe(0);
    });

    it("commits once on pointerUp with the moved value, and changes nothing after it", () => {
      const { container } = renderEditor();
      mockRect(container);
      fireEvent.pointerDown(screen.getByLabelText("Adjust control point 1"), { clientX: 130, clientY: 130 });
      moveTo(156, 130);
      fireEvent.pointerUp(window);
      expect(mockOnCommit).toHaveBeenCalledTimes(1);
      expect(mockOnCommit.mock.calls[0][0]).toEqual(lastChange());
      const changes = mockOnChange.mock.calls.length;
      moveTo(200, 200);
      fireEvent.pointerUp(window);
      expect(mockOnChange).toHaveBeenCalledTimes(changes);
      expect(mockOnCommit).toHaveBeenCalledTimes(1);
    });

    it("lands a frame still pending before the commit", () => {
      const frames: FrameRequestCallback[] = [];
      vi.mocked(window.requestAnimationFrame).mockImplementation((cb) => {
        frames.push(cb);
        return frames.length;
      });
      vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
      const { container } = renderEditor();
      mockRect(container);
      fireEvent.pointerDown(screen.getByLabelText("Adjust control point 1"), { clientX: 130, clientY: 130 });
      moveTo(156, 130);
      expect(mockOnChange).not.toHaveBeenCalled();
      fireEvent.pointerUp(window);
      expect(mockOnChange).toHaveBeenCalledTimes(1);
      expect(mockOnCommit).toHaveBeenCalledTimes(1);
      expect(mockOnChange.mock.invocationCallOrder[0]).toBeLessThan(mockOnCommit.mock.invocationCallOrder[0]);
      // The cancelled frame, run late, has nothing left to land
      frames.forEach((cb) => cb(0));
      expect(mockOnChange).toHaveBeenCalledTimes(1);
    });

    it("calls neither for a press with no move", () => {
      const { container } = renderEditor();
      mockRect(container);
      fireEvent.pointerDown(screen.getByLabelText("Adjust control point 1"), { clientX: 120, clientY: 140 });
      fireEvent.pointerUp(window);
      expect(mockOnChange).not.toHaveBeenCalled();
      expect(mockOnCommit).not.toHaveBeenCalled();
    });

    it("calls neither for a move that goes nowhere, as a pen's pressure change reports", () => {
      const { container } = renderEditor();
      mockRect(container);
      fireEvent.pointerDown(screen.getByLabelText("Adjust control point 1"), { clientX: 113, clientY: 252 });
      moveTo(113, 252);
      fireEvent.pointerUp(window);
      expect(mockOnChange).not.toHaveBeenCalled();
      expect(mockOnCommit).not.toHaveBeenCalled();
    });
  });

  describe("Keys", () => {
    it("moves a focused handle by 0.01 with the arrows (⇧ 0.1), clamped, and commits on key-up", () => {
      renderEditor();
      const p1 = screen.getByLabelText("Adjust control point 1");
      const p2 = screen.getByLabelText("Adjust control point 2");
      fireEvent.keyDown(p1, { key: "ArrowRight" });
      expect(mockOnChange).toHaveBeenLastCalledWith([0.43, 0, 0.58, 1]);
      fireEvent.keyUp(p1, { key: "ArrowRight" });
      expect(mockOnCommit).toHaveBeenCalledTimes(1);
      expect(mockOnCommit).toHaveBeenLastCalledWith([0.43, 0, 0.58, 1]);
      mockOnChange.mockClear();
      // Already at the top: nothing to move
      fireEvent.keyDown(p2, { key: "ArrowUp", shiftKey: true });
      expect(mockOnChange).not.toHaveBeenCalled();
      fireEvent.keyDown(p2, { key: "ArrowDown", shiftKey: true });
      expect(mockOnChange).toHaveBeenLastCalledWith([0.43, 0, 0.58, 0.9]);
    });

    it("commits a run once on blur when no key-up came", () => {
      renderEditor();
      const p1 = screen.getByLabelText("Adjust control point 1");
      fireEvent.keyDown(p1, { key: "ArrowRight" });
      fireEvent.keyDown(p1, { key: "ArrowRight" });
      fireEvent.blur(p1);
      fireEvent.blur(p1);
      expect(mockOnCommit).toHaveBeenCalledTimes(1);
      expect(mockOnCommit).toHaveBeenLastCalledWith([0.44, 0, 0.58, 1]);
    });

    it("keeps the arrows from the page, and leaves ⌥, ⌘ and Ctrl arrows alone", () => {
      const parent = vi.fn();
      render(
        <div onKeyDown={(event) => parent(event.key)}>
          <CubicBezierEditor value={defaultValue} onChange={mockOnChange} onCommit={mockOnCommit} />
        </div>,
      );
      const p1 = screen.getByLabelText("Adjust control point 1");
      fireEvent.keyDown(p1, { key: "ArrowRight" });
      expect(parent).not.toHaveBeenCalled();
      mockOnChange.mockClear();
      for (const mod of [{ altKey: true }, { metaKey: true }, { ctrlKey: true }]) {
        fireEvent.keyDown(p1, { key: "ArrowRight", ...mod });
      }
      expect(mockOnChange).not.toHaveBeenCalled();
      expect(parent).toHaveBeenCalledTimes(3);
    });

    it("commits a run still open when a handle is pressed, as a gesture of its own", () => {
      renderEditor();
      const p1 = screen.getByLabelText("Adjust control point 1");
      fireEvent.keyDown(p1, { key: "ArrowRight" });
      expect(mockOnCommit).not.toHaveBeenCalled();
      fireEvent.pointerDown(p1, { clientX: 113, clientY: 260 });
      expect(mockOnCommit).toHaveBeenCalledTimes(1);
      expect(mockOnCommit).toHaveBeenLastCalledWith([0.43, 0, 0.58, 1]);
      fireEvent.pointerUp(window);
      expect(mockOnCommit).toHaveBeenCalledTimes(1);
    });

    it("does nothing while disabled", () => {
      renderEditor({ disabled: true });
      fireEvent.keyDown(screen.getByLabelText("Adjust control point 1"), { key: "ArrowRight" });
      expect(mockOnChange).not.toHaveBeenCalled();
    });
  });

  describe("Easing Curve Overlay", () => {
    it("should render polyline when easingCurve prop is provided", () => {
      const { container } = renderEditor({
        easingCurve: "0,100 50,50 100,0",
      });
      const polyline = container.querySelector("polyline");
      expect(polyline).toBeInTheDocument();
      expect(polyline?.getAttribute("points")).toBe("0,100 50,50 100,0");
    });

    it("should not render polyline when easingCurve is undefined", () => {
      const { container } = renderEditor();
      const polyline = container.querySelector("polyline");
      expect(polyline).not.toBeInTheDocument();
    });

    it("should dim the bezier curve when easingCurve is present", () => {
      const { container } = renderEditor({
        easingCurve: "0,100 50,50 100,0",
      });
      const path = container.querySelector("svg path");
      // When easing overlay is active, the bezier path is dimmed
      expect(path?.getAttribute("stroke-dasharray")).toBe("3 2");
    });
  });

  describe("Background and Border", () => {
    it("renders the background rect on the neutral ground", () => {
      const { container } = renderEditor();
      const rect = container.querySelector("svg rect");
      expect(rect).toBeInTheDocument();
      expect(rect).toHaveClass("fill-neutral-950");
      expect(rect).not.toHaveAttribute("fill");
    });
  });

  describe("Tones", () => {
    /** Every colour comes from a class: no hex or rgba attribute or class anywhere. */
    const colourless = (container: HTMLElement) => {
      for (const el of container.querySelectorAll("[fill], [stroke]")) {
        for (const attr of ["fill", "stroke"]) {
          const value = el.getAttribute(attr);
          if (value !== null) expect(value).toBe("none");
        }
      }
      for (const el of container.querySelectorAll("*")) {
        expect(el.getAttribute("class") ?? "").not.toMatch(/#[0-9a-f]{3,6}|rgba?\(/i);
      }
    };

    it("draws the node in its lime, from tokens", () => {
      const { container } = renderEditor({ easingCurve: "0,100 50,50 100,0" });
      colourless(container);
      expect(container.querySelector("polyline")).toHaveClass("stroke-handle-easeCurve");
      expect(screen.getByLabelText("Adjust control point 1")).toHaveClass("bg-lime-300/80");
    });

    it("draws the editor's in its neutrals", () => {
      const { container } = renderEditor({ tone: "edit" });
      colourless(container);
      expect(container.querySelector("svg rect")).toHaveClass("fill-pane");
      expect(container.querySelector("svg path")).toHaveClass("stroke-neutral-100");
      const handle = screen.getByLabelText("Adjust control point 1");
      expect(handle).toHaveClass("bg-neutral-100");
      expect(container.innerHTML).not.toMatch(/lime/);
    });
  });
});
