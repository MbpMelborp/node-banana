import { cn } from "@/components/nodes/ui/cn";
import { AUDIO_ROW_EXPANDED_PX, AUDIO_ROW_PX, AUDIO_ROWS_CAP, AUDIO_STRIP_PX } from "@/lib/stitch/audioLayout";

/**
 * The Stitch editor's class constants and geometry, in one place so the
 * boards' values are not scattered through the components.
 */

/** Floating chips (delta, snap, dB readout): the Tooltip skin. */
export const EDITOR_CHIP =
  "rounded-md squircle border border-white/10 bg-neutral-950 shadow-[0_4px_12px_rgba(0,0,0,0.5)] px-2 py-1 text-[10px] font-medium leading-3";

/**
 * The rail's actions (Split at playhead, Reset trim, Remove clip): a text row with no box, its icon in ink-3 at the
 * content's left edge (the row's padding hangs into the rail's), the key shown at the right on hover or focus.
 */
export const RAIL_ACTION =
  "group/action -mx-2 h-9 w-[calc(100%+16px)] shrink-0 flex items-center gap-2.5 px-2 rounded-md text-left text-[13px] text-neutral-300 transition-colors hover:bg-white/4 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-neutral-300";

/** 28px icon buttons in the track headers, the library pane and the home. */
export const ICON_BUTTON =
  "h-7 w-7 inline-flex items-center justify-center rounded-md text-neutral-400 transition-colors hover:text-neutral-100 hover:bg-white/6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-neutral-400";

/** Text ghosts: the track headers' small text buttons. */
export const TEXT_GHOST =
  "h-7 px-2.5 inline-flex items-center gap-1.5 rounded-md text-xs text-neutral-400 transition-colors hover:text-neutral-100 hover:bg-neutral-700/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 disabled:text-neutral-600 disabled:hover:bg-transparent";

/** The headers' height (the view's and the dialog's h-14): what sits over the stage in the editor's column. */
export const HEADER_PX = 56;

/** The headers' 32px icon buttons (Undo, Redo, ⋯, Show the library): dimmed when off, filled while open. */
export const HEADER_ICON_BUTTON =
  "h-8 w-8 shrink-0 inline-flex items-center justify-center rounded-lg text-neutral-400 transition-colors hover:text-neutral-100 hover:bg-white/6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 aria-expanded:bg-edit-pressed aria-expanded:text-neutral-100 disabled:text-neutral-600 disabled:hover:bg-transparent";

/** The one white button in a header: Render, Done. */
export const HEADER_PRIMARY =
  "h-8 shrink-0 inline-flex items-center rounded-lg bg-neutral-100 px-4 text-[13px] font-semibold text-neutral-950 transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-pane disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-neutral-100";

/** A header's quiet text button: Save, Cancel. */
export const HEADER_GHOST =
  "h-8 shrink-0 inline-flex items-center rounded-lg px-3 text-[13px] font-medium text-neutral-300 transition-colors hover:bg-white/6 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 disabled:cursor-not-allowed disabled:text-neutral-600 disabled:hover:bg-transparent";

/** Stop, outlined beside the render's progress. */
export const HEADER_OUTLINE =
  "h-8 shrink-0 inline-flex items-center rounded-lg border border-neutral-800 px-3.5 text-[13px] font-medium text-neutral-100 transition-colors hover:bg-white/6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40";

/** A header's title: the edit's name, or "Edit video" in the dialog. */
export const HEADER_TITLE = "font-display text-[15px] font-medium leading-[18px] tracking-[-0.02em] text-neutral-100";

/**
 * The control row's 32px icon buttons under the video: quiet, and white on the pressed fill while on (Snap, Mute all,
 * Crossfade, Track | Stacked).
 */
export const CONTROL_BUTTON = cn(
  HEADER_ICON_BUTTON,
  "aria-pressed:bg-edit-pressed aria-pressed:text-neutral-100 aria-disabled:cursor-progress",
);

/** The rail's fields (Start, In, Out): 32px on the field ground, 13px tabular figures, as wide as their column. */
export const TIMECODE_WELL =
  "h-8 w-full min-w-0 rounded-md border-0 bg-edit-field px-2.5 text-[13px] tabular-nums text-neutral-200 outline-none transition-colors placeholder:text-neutral-500 focus-visible:ring-2 focus-visible:ring-white/40 disabled:opacity-50";

/**
 * Pixel sizes from the boards (Main, Trim, Volume) the timeline lane computes with. The shell's own (header 56, rail
 * 280) are its Tailwind classes; the stage's room and its control row are EditorStage's.
 */
export const GEOMETRY = {
  /** One video row (Track's clips, or up to two of Stacked's), one audio row and the audio strip. */
  timeline: 224,
  /** The same with that audio row expanded. */
  timelineExpanded: 296,
  trackHeader: 132,
  ruler: 24,
  clipRow: 92,
  clipTop: 10,
  clipHeight: 72,
  audioRow: AUDIO_ROW_PX,
  audioRowExpanded: AUDIO_ROW_EXPANDED_PX,
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
  /** One clip per row in Stacked. */
  stackRow: 52,
  stackClipTop: 6,
  stackClipHeight: 40,
  /** 3.5 rows: the rows scroll vertically past this. */
  stackRowsCap: 182,
  /** The timeline's 1px border and an 8px horizontal scrollbar. */
  stackSlack: 9,
  /** Track's room under its clips row: the border, the scrollbar and some air. */
  trackSlack: 20,
  /** Under the audio rows: "+ Add audio" in the header, the "New row" drop target in the lanes. */
  audioStrip: AUDIO_STRIP_PX,
  /** Audio rows shown before the rest scroll. */
  audioRowsCap: AUDIO_ROWS_CAP,
  /**
   * The stage keeps at least this much height, its padding and the control row under the video included (a 240px
   * frame): the timeline gives up room below it first.
   */
  stageFloor: 344,
  /** Stacked's rows view is never capped below one and a half rows, so it still reads as scrollable. */
  stackRowsFloor: 78,
  /** An audio row header's controls sit this far above the row's bottom, in either height. */
  audioControlsBottom: 22,
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

/** A clip (or slot) Stacked's body drag carries in time and across rows: on top, ringed and raised. */
export const MOVING_CLIP = "z-10 ring-2 ring-selection shadow-[0_8px_20px_rgba(0,0,0,0.5)] cursor-grabbing";

/** The editor's panel, marked for code outside it that hands focus back (the library picker): not its label. */
export const STITCH_EDITOR_PANEL = "data-stitch-editor";

/**
 * The element focus goes back to inside the editor: the dialog's panel, or the Edit video view's editor column (which
 * carries STITCH_EDITOR_PANEL and is no dialog). The same element in the dialog, so nothing changes there.
 */
export const EDITOR_PANEL_SELECTOR = `[role="dialog"], [${STITCH_EDITOR_PANEL}]`;
