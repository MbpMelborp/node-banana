import { describe, it, expect, vi } from "vitest";
import { easing, easingPolyline, getAllEasingNames } from "..";

describe("easingPolyline", () => {
  it("draws samples + 1 points, y down, to one decimal", () => {
    expect(easingPolyline("linear", 10, 10, 2)).toBe("0.0,10.0 5.0,5.0 10.0,0.0");
    expect(easingPolyline("easeInQuad", 64, 64).split(" ")).toHaveLength(21);
  });

  it("gives a name and its function the same line", () => {
    for (const name of getAllEasingNames()) {
      expect(easingPolyline(easing[name as keyof typeof easing], 24, 24, 20)).toBe(easingPolyline(name, 24, 24, 20));
    }
  });

  it("draws an unknown name straight, as getEasingFunction gives it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(easingPolyline("nope", 10, 10, 2)).toBe(easingPolyline("linear", 10, 10, 2));
    warn.mockRestore();
  });
});
