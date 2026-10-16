import { inputClass } from "@/components/ui/Controls";
import { cn } from "@/components/nodes/ui/cn";

/**
 * The Stitch editor's class constants and geometry, in one place so the
 * boards' values are not scattered through the components.
 */

/** Floating chips (delta, snap, dB readout): the Tooltip skin. */
export const EDITOR_CHIP =
  "rounded-md squircle border border-white/10 bg-neutral-950 shadow-[0_4px_12px_rgba(0,0,0,0.5)] px-2 py-1 text-[10px] font-medium leading-3";

/** The rail's action buttons: 32px, a faint fill and a hairline border. */
export const RAIL_BUTTON =
  "h-8 w-full flex items-center gap-2 px-2.5 rounded-lg border border-white/10 bg-white/6 text-xs font-medium text-neutral-200 text-left transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-white/6";

/** 28px icon buttons in the transport and track headers. */
export const ICON_BUTTON =
  "h-7 w-7 inline-flex items-center justify-center rounded-md text-neutral-400 transition-colors hover:text-neutral-100 hover:bg-white/6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-neutral-400";

/** Text ghosts: Undo, Redo, Snap, Fit. */
export const TEXT_GHOST =
  "h-7 px-2.5 inline-flex items-center gap-1.5 rounded-md text-xs text-neutral-400 transition-colors hover:text-neutral-100 hover:bg-neutral-700/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection disabled:text-neutral-600 disabled:hover:bg-transparent";

/** A pressed toggle (Snap, Sound off). */
export const TOGGLE_ON = "bg-white/10 text-neutral-100";

/** The In and Out wells. */
export const TIMECODE_WELL = cn(
  inputClass,
  "h-7 w-[88px] px-2 border-0 bg-editor-well shadow-well font-mono text-xs tabular-nums text-right text-neutral-100 focus-visible:ring-1 focus-visible:ring-neutral-500",
);

/** Pixel sizes from the boards (Main, Trim, Volume) the timeline lane computes with. The shell's own (header 48, transport 44, rail 280) are its Tailwind classes. */
export const GEOMETRY = {
  timeline: 200,
  timelineExpanded: 272,
  trackHeader: 132,
  ruler: 24,
  clipRow: 92,
  clipTop: 10,
  clipHeight: 72,
  audioRow: 64,
  audioRowExpanded: 136,
  audioBlockTop: 8,
  audioBlock: 48,
  audioBlockExpanded: 120,
  origin: 16,
  frameCell: 56,
  labelBar: 20,
  handle: 10,
  addSlot: 52,
  addSlotGap: 8,
  emptySlot: 160,
  /** The lane's margin after the add slot, and the empty lane's placeholder's right margin. */
  endMargin: 16,
} as const;

/** The room the lane keeps after the last clip: the add slot with its gap, and the end margin. Fit leaves it too. */
export const LANE_TRAILING_PX = GEOMETRY.addSlotGap + GEOMETRY.addSlot + GEOMETRY.endMargin;

/**
 * A label bar over a frame or waveform: a soft gradient, darker through the middle where the text sits, and a dense
 * black halo round the text, so the name, the grey source and the length stay readable over a white bottom edge
 * (sky, snow, a studio wall). Over a dark frame the halo does not show and the gradient stays a soft fade, not a band.
 */
export const LABEL_BAR =
  "bg-linear-to-t from-black/80 via-black/55 via-55% to-transparent [text-shadow:0_0_1px_rgb(0_0_0),0_0_2px_rgb(0_0_0),0_0_3px_rgb(0_0_0/0.9),0_0_6px_rgb(0_0_0/0.8)]";

/** A clip (or slot) lifted to be dragged to a new place (design-spec §9.1). */
export const LIFTED_CLIP = "z-10 -translate-y-1.5 -rotate-[1.5deg] shadow-[0_12px_28px_rgba(0,0,0,0.6)]";

/** The editor's panel, marked for code outside it that hands focus back (the library picker): not its label. */
export const STITCH_EDITOR_PANEL = "data-stitch-editor";
