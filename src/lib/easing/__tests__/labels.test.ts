import { describe, it, expect } from "vitest";
import { easingLabel, getAllEasingNames } from "..";

describe("easingLabel", () => {
  it("names every easing in the library readably", () => {
    expect(getAllEasingNames().map(easingLabel)).toEqual([
      "Linear",
      "Ease in quad",
      "Ease out quad",
      "Ease in-out quad",
      "Ease in cubic",
      "Ease out cubic",
      "Ease in-out cubic",
      "Ease in quart",
      "Ease out quart",
      "Ease in-out quart",
      "Ease in quint",
      "Ease out quint",
      "Ease in-out quint",
      "Ease in sine",
      "Ease out sine",
      "Ease in-out sine",
      "Ease in expo",
      "Ease out expo",
      "Ease in-out expo",
      "Ease in circ",
      "Ease out circ",
      "Ease in-out circ",
      "Ease in expo, out cubic",
      "Ease in quart, out quad",
    ]);
  });

  it("gives a name it does not know back as it is", () => {
    expect(easingLabel("easeOutBounce")).toBe("easeOutBounce");
    expect(easingLabel("")).toBe("");
  });
});
