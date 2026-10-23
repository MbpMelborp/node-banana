const SIDES: Record<string, string> = { In: "in", Out: "out", InOut: "in-out" };

/**
 * A named easing's readable name, for the editor's ramp presets: "Ease in-out sine", "Ease in expo, out cubic",
 * "Linear". A name the library does not shape this way comes back as itself.
 */
export function easingLabel(name: string): string {
  if (name === "linear") return "Linear";
  const named = /^ease(InOut|In|Out)(Quad|Cubic|Quart|Quint|Sine|Expo|Circ)$/.exec(name);
  if (named) return `Ease ${SIDES[named[1]]} ${named[2].toLowerCase()}`;
  const hybrid = /^easeIn(\w+?)Out(\w+)$/.exec(name);
  if (hybrid) return `Ease in ${hybrid[1].toLowerCase()}, out ${hybrid[2].toLowerCase()}`;
  return name;
}
