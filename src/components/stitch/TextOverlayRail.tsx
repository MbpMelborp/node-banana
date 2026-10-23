"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { Scissors, TextAlignCenter, TextAlignEnd, TextAlignStart, Trash } from "lucide-react";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { isImeKeyEvent } from "@/lib/agent/client/keyboard";
import {
  ensureOverlayFonts,
  fontGeneration,
  fontKey,
  onFontsChanged,
  overlayFontList,
  shippedFont,
  type FontState,
  type ResolvedFont,
} from "@/lib/stitch/fonts";
import { layoutOverlay, overlayLayoutSize, type OverlayFontList, type OverlaySize } from "@/lib/stitch/overlayDraw";
import { APP_SANS_FAMILY, draftOverlays, MAX_OVERLAY_TEXT, type OverlayPatch } from "@/lib/stitch/overlays";
import { formatSeconds, parseSeconds } from "@/lib/stitch/timecode";
import type { StitchOverlay, StitchOverlayFont, StitchTextOverlay } from "@/types";
import { EDITOR_PANEL_SELECTOR } from "./editorStyles";
import { FontCombobox } from "./FontCombobox";
import { OVERLAY_FALLBACK_FRAME } from "./OverlayCanvas";
import {
  canSplitOverlaysAtPlayhead,
  removeOverlaysById,
  setOverlayLength,
  setOverlayStart,
  splitSelectedOverlaysAtPlayhead,
  takeOverlayTextFocus,
  updateOverlay,
} from "./overlayActions";
import {
  RailAction,
  RailActions,
  RailField,
  RailLabel,
  RailNote,
  RailSegments,
  RailSlider,
  RailTitle,
  START_KEYS,
} from "./railParts";
import { TimecodeField } from "./TimecodeField";
import { overlayFirstLine } from "./timeline/OverlayClipBox";
import { overlayRowName } from "./timeline/OverlayLane";

/** What an installed or typed family offers; a shipped font offers the weights it has faces for. */
const FAMILY_WEIGHTS: readonly number[] = [400, 500, 600, 700];
/** A font file draws at its own weight whatever the layer's (its face takes them all): a layer in one keeps this. */
const FILE_WEIGHT = 400;

const ALIGNS: ReadonlyArray<{ align: StitchTextOverlay["align"]; label: string; icon: ReactNode }> = [
  { align: "left", label: "Left", icon: <TextAlignStart size={16} strokeWidth={1.5} /> },
  { align: "center", label: "Centre", icon: <TextAlignCenter size={16} strokeWidth={1.5} /> },
  { align: "right", label: "Right", icon: <TextAlignEnd size={16} strokeWidth={1.5} /> },
];

/** Where the text's centre goes, as fractions of the frame. */
const POSITIONS = [
  { label: "Centre", x: 0.5, y: 0.5 },
  { label: "Lower third", x: 0.5, y: 0.82 },
  { label: "Top", x: 0.5, y: 0.14 },
] as const;
/** A position this close to a preset's is that preset. */
const POSITION_EPS = 0.005;

/** Length's keys, either one: I starts the layer at the playhead, O ends it there, the other edge kept. */
const LENGTH_KEYS: readonly string[] = ["I", "O"];

const TEXT_AREA =
  "block max-h-[180px] min-h-[76px] w-full min-w-0 resize-none rounded-md border-0 bg-edit-field px-2.5 py-2 text-[13px] leading-5 text-neutral-200 outline-none transition-colors field-sizing-content focus-visible:ring-2 focus-visible:ring-white/40";

/** The native colour input, drawn as a square of its colour on the field ground. */
const SWATCH =
  "h-8 w-8 shrink-0 cursor-pointer appearance-none rounded-md border-0 bg-edit-field p-1.5 outline-none focus-visible:ring-2 focus-visible:ring-white/40 [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded-[3px] [&::-webkit-color-swatch]:border [&::-webkit-color-swatch]:border-white/10 [&::-moz-color-swatch]:rounded-[3px] [&::-moz-color-swatch]:border [&::-moz-color-swatch]:border-white/10";

const editor = () => useStitchEditorStore.getState();

/** A fraction as a percentage, to a tenth: "8%", "82.5%". */
const formatPercent = (fraction: number) => `${Math.round(fraction * 1000) / 10}%`;

/** "8", "8%", "8.5 %", "8,5": the fraction; null for anything else. */
function parsePercent(text: string): number | null {
  const match = /^(\d+(?:[.,]\d*)?|[.,]\d+)\s*%?$/.exec(text.trim());
  return match ? Number(match[1].replace(",", ".")) / 100 : null;
}

/** "#ff8800", "FF8800", "#f80": the colour as one number, for the hex well. */
function parseHex(text: string): number | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text.trim());
  if (!match) return null;
  const hex = match[1].length === 3 ? [...match[1]].map((c) => c + c).join("") : match[1];
  return parseInt(hex, 16);
}

const formatHex = (rgb: number) => `#${rgb.toString(16).padStart(6, "0")}`;
const formatFade = (sec: number) => formatSeconds(sec, 2);
/** A stepped value without the float noise of its steps (0.7 + 0.1). */
const tidy = (value: number) => Math.round(value * 1e6) / 1e6;

/** The layer as the editor holds it now. */
function layerNow(id: string): StitchOverlay | undefined {
  const draft = editor().draft;
  return draft ? draftOverlays(draft).find((o) => o.id === id) : undefined;
}

/**
 * A well's ↑ / ↓ (TimecodeField's onNudge): `write` the value a step on (⇧: a big step) under the well's gesture key,
 * so a run of steps is one undo step until the well is left. The value then stored, or null when nothing changed.
 */
function nudger(
  id: string,
  well: string,
  read: (o: StitchOverlay) => number,
  write: (value: number, opts: { gestureKey: string }) => void,
  step: number,
  bigStep: number,
) {
  return (dir: 1 | -1, big: boolean): number | null => {
    const before = layerNow(id);
    if (!before) return null;
    write(tidy(read(before) + dir * (big ? bigStep : step)), { gestureKey: `${well}:${id}` });
    const after = layerNow(id);
    return after && after !== before ? read(after) : null;
  };
}

function nearestWeight(weights: readonly number[], weight: number): number {
  return weights.reduce((best, w) => (Math.abs(w - weight) < Math.abs(best - weight) ? w : best));
}

/** The rail's ⌫ for text layers: they go, and none of them stays tagged "cut". */
function removeLayers(ids: readonly string[]): void {
  editor().untagCut(removeOverlaysById(ids));
}

/**
 * The rail while text layers are selected. One: its first line, its row and length; then its text, font, size and
 * weight, colour and alignment, position (three presets, then the text's centre as X and Y), the wash behind it, its
 * fades, and where it starts and how long it lasts, with a note when its font is not to be had here or its text is too
 * big for the frame; then Split at playhead and Remove text. Several: how many, and what applies to all of them.
 * Every field writes one undo step; typing in a visit to the text, a colour drag, the wash slider and a run of ↑ / ↓
 * in a well each make one. `frameSize` is the output's (the fallback's while no clip has one).
 */
export function TextOverlayRail({
  overlays,
  frameSize,
}: {
  /** The selected text layers, in overlay order. */
  overlays: readonly StitchOverlay[];
  frameSize: OverlaySize | null;
}) {
  if (overlays.length > 1) return <SeveralLayers overlays={overlays} />;
  const overlay = overlays[0];
  if (!overlay) return null;
  return <OneLayer overlay={overlay} frameSize={frameSize} />;
}

function SeveralLayers({ overlays }: { overlays: readonly StitchOverlay[] }) {
  const canSplit = useStitchEditorStore(canSplitOverlaysAtPlayhead);
  return (
    <>
      <RailTitle
        title={`${overlays.length} text layers`}
        lines={[overlays.map((o) => overlayFirstLine(o.text) ?? "Empty text").join(", ")]}
      />
      <RailActions>
        <RailAction
          icon={<Scissors size={16} strokeWidth={1.5} />}
          label="Split at playhead"
          shortcut="S"
          disabled={!canSplit}
          onClick={splitSelectedOverlaysAtPlayhead}
        />
        <RailAction
          icon={<Trash size={16} strokeWidth={1.5} />}
          label={`Remove ${overlays.length} text layers`}
          shortcut="⌫"
          keyshortcuts="Backspace"
          onClick={() => removeLayers(overlays.map((o) => o.id))}
        />
      </RailActions>
    </>
  );
}

/**
 * Whether the layer's font is to be had here (ensureOverlayFonts, asked again as the layer or the page's fonts change:
 * `generation`): the reason when it is not, and the family lists the stage draws the layer in, to measure it in.
 */
function useLayerFont(
  o: StitchOverlay,
  generation: number,
): {
  problem: Exclude<FontState, "ready"> | null;
  fontList: OverlayFontList;
} {
  const [resolved, setResolved] = useState<ReadonlyMap<string, ResolvedFont>>(() => new Map());

  useEffect(() => {
    let live = true;
    void ensureOverlayFonts([o]).then((fonts) => {
      if (live) setResolved(fonts);
    });
    return () => {
      live = false;
    };
  }, [o, generation]);

  // An answer for the font the layer had is no answer for the one it has
  const state = resolved.get(fontKey(o.font))?.state;
  const fontList = useMemo(() => overlayFontList(resolved), [resolved]);
  return { problem: state && state !== "ready" ? state : null, fontList };
}

/** Whether the layer's text fits the frame (layoutOverlay at the output's size); true where nothing can measure. */
function useFitsFrame(
  o: StitchOverlay,
  frameSize: OverlaySize | null,
  fontList: OverlayFontList,
  generation: number,
): boolean {
  const [ctx] = useState(() => (typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d")));
  const { width, height } = frameSize ?? OVERLAY_FALLBACK_FRAME;
  return useMemo(
    () => !ctx || layoutOverlay(ctx, o, overlayLayoutSize(width, height), fontList).fitsFrame,
    // A face that loads (the fonts' generation) measures otherwise
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ctx, o, width, height, fontList, generation],
  );
}

function OneLayer({ overlay: o, frameSize }: { overlay: StitchOverlay; frameSize: OverlaySize | null }) {
  const canSplit = useStitchEditorStore(canSplitOverlaysAtPlayhead);
  const endGesture = useStitchEditorStore((s) => s.endGesture);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const colorRef = useRef<HTMLInputElement>(null);
  // Bumped as font faces are added or load
  const generation = useSyncExternalStore(onFontsChanged, fontGeneration, () => 0);
  const { problem, fontList } = useLayerFont(o, generation);
  const fits = useFitsFrame(o, frameSize, fontList, generation);
  const id = o.id;

  // "+ Text" just added it: its text takes focus, selected, so typing replaces "Title"
  useEffect(() => {
    const area = textRef.current;
    if (!area || !takeOverlayTextFocus(id)) return;
    area.focus();
    area.select();
  }, [id]);

  // The picker's input events are one drag, one undo step; its change (the picker closed) is the last of it. A
  // listener of its own: React's onChange is the input event
  useEffect(() => {
    const input = colorRef.current;
    if (!input) return;
    const commit = () => {
      updateOverlay(id, { color: input.value }, { gestureKey: `overlay-color:${id}` });
      endGesture();
    };
    input.addEventListener("change", commit);
    return () => input.removeEventListener("change", commit);
  }, [id, endGesture]);

  const length = o.endSec - o.startSec;
  const file = o.font.file !== undefined;
  const weights = (!file && shippedFont(o.font.family)?.weights) || FAMILY_WEIGHTS;

  const pickFont = (font: StitchOverlayFont) => {
    const shipped = font.file ? null : shippedFont(font.family);
    // One step: a file draws at its own weight, a shipped face only at the weights it has
    const weight = font.file ? FILE_WEIGHT : shipped ? nearestWeight(shipped.weights, o.weight) : o.weight;
    updateOverlay(id, { font, weight });
  };

  const onTextKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Escape") return;
    // The editor's Escape does not run, nor the dialog's; an input method's drops a conversion and leaves it at that
    event.stopPropagation();
    event.nativeEvent.stopImmediatePropagation();
    if (isImeKeyEvent(event)) return;
    // The field is left, as a well's Escape leaves it
    event.preventDefault();
    const panel = event.currentTarget.closest<HTMLElement>(EDITOR_PANEL_SELECTOR);
    if (panel) panel.focus();
    else event.currentTarget.blur();
  };

  /** A setting's well's ↑ / ↓. */
  const setting = (
    well: string,
    read: (l: StitchOverlay) => number,
    patch: (value: number) => OverlayPatch,
    step: number,
    bigStep: number,
  ) => nudger(id, well, read, (value, opts) => updateOverlay(id, patch(value), opts), step, bigStep);

  return (
    <>
      <RailTitle
        title={overlayFirstLine(o.text) ?? "Empty text"}
        lines={[`${overlayRowName(o.row)} · ${formatSeconds(length)}`]}
      />

      <div className="mt-7">
        {/* One undo step for each visit: leaving the field ends it */}
        <RailField label="Text" onBlur={endGesture}>
          <textarea
            ref={textRef}
            rows={3}
            maxLength={MAX_OVERLAY_TEXT}
            value={o.text}
            onChange={(event) => updateOverlay(id, { text: event.target.value }, { gestureKey: `overlay-text:${id}` })}
            onKeyDown={onTextKeyDown}
            className={TEXT_AREA}
          />
        </RailField>
      </div>

      <div className="mt-5">
        {/* Its list and its note are the layer's */}
        <FontCombobox key={id} font={o.font} onPick={pickFont} />
        {problem && (
          <RailNote>
            {problem === "missing"
              ? `${o.font.family} isn't on this computer: ${APP_SANS_FAMILY} stands in.`
              : `${o.font.family} couldn't be read: ${APP_SANS_FAMILY} stands in.`}
          </RailNote>
        )}
      </div>

      <div className="mt-5 grid grid-cols-[72px_minmax(0,1fr)] gap-2">
        <RailField label="Size" onBlur={endGesture}>
          <TimecodeField
            label="Size"
            value={o.size}
            format={formatPercent}
            parse={parsePercent}
            onCommit={(size) => updateOverlay(id, { size })}
            onNudge={setting("overlay-size", (l) => l.size, (size) => ({ size }), 0.01, 0.1)}
          />
        </RailField>
        <div className="min-w-0">
          <RailLabel>Weight</RailLabel>
          <RailSegments
            label="Weight"
            segments={weights.map((weight) => ({
              label: String(weight),
              pressed: !file && o.weight === weight,
              disabled: file,
              title: file ? "A font file draws at its own weight" : undefined,
              onClick: () => updateOverlay(id, { weight }),
            }))}
          />
        </div>
      </div>
      {!fits && <RailNote>The text doesn&apos;t fit the frame: some of it falls outside.</RailNote>}

      <div className="mt-5 grid grid-cols-2 gap-2">
        <div className="min-w-0">
          <RailLabel>Colour</RailLabel>
          <div className="flex gap-1.5">
            <input
              ref={colorRef}
              type="color"
              aria-label="Colour"
              value={o.color}
              onChange={(event) => updateOverlay(id, { color: event.target.value }, { gestureKey: `overlay-color:${id}` })}
              onBlur={endGesture}
              className={SWATCH}
            />
            <TimecodeField
              label="Hex colour"
              value={parseInt(o.color.slice(1), 16)}
              format={formatHex}
              parse={parseHex}
              onCommit={(rgb) => updateOverlay(id, { color: formatHex(rgb) })}
            />
          </div>
        </div>
        <div className="min-w-0">
          <RailLabel>Align</RailLabel>
          <RailSegments
            label="Align"
            segments={ALIGNS.map(({ align, label, icon }) => ({
              label,
              icon,
              pressed: o.align === align,
              onClick: () => updateOverlay(id, { align }),
            }))}
          />
        </div>
      </div>

      <div className="mt-5">
        <RailLabel>Position</RailLabel>
        <RailSegments
          label="Position"
          segments={POSITIONS.map(({ label, x, y }) => ({
            label,
            pressed: Math.abs(o.x - x) <= POSITION_EPS && Math.abs(o.y - y) <= POSITION_EPS,
            onClick: () => updateOverlay(id, { x, y }),
          }))}
        />
        <div className="mt-2 grid grid-cols-2 gap-2">
          <RailField label="X" onBlur={endGesture}>
            <TimecodeField
              label="X"
              value={o.x}
              format={formatPercent}
              parse={parsePercent}
              onCommit={(x) => updateOverlay(id, { x })}
              onNudge={setting("overlay-x", (l) => l.x, (x) => ({ x }), 0.01, 0.1)}
            />
          </RailField>
          <RailField label="Y" onBlur={endGesture}>
            <TimecodeField
              label="Y"
              value={o.y}
              format={formatPercent}
              parse={parsePercent}
              onCommit={(y) => updateOverlay(id, { y })}
              onNudge={setting("overlay-y", (l) => l.y, (y) => ({ y }), 0.01, 0.1)}
            />
          </RailField>
        </div>
      </div>

      {/* A drag, or a held arrow key, is one undo step */}
      <div className="mt-5" onPointerUp={endGesture} onKeyUp={endGesture} onBlur={endGesture}>
        <RailSlider
          label="Wash"
          ariaLabel="Wash opacity"
          value={Math.round(o.wash.opacity * 100)}
          onChange={(pct) => updateOverlay(id, { wash: { opacity: pct / 100 } }, { gestureKey: `overlay-wash:${id}` })}
        />
      </div>

      <div className="mt-5 grid grid-cols-2 gap-2">
        <RailField label="Fade in" onBlur={endGesture}>
          <TimecodeField
            label="Fade in"
            value={o.fadeInSec}
            format={formatFade}
            parse={parseSeconds}
            onCommit={(fadeInSec) => updateOverlay(id, { fadeInSec })}
            onNudge={setting("overlay-fade-in", (l) => l.fadeInSec, (fadeInSec) => ({ fadeInSec }), 0.1, 1)}
          />
        </RailField>
        <RailField label="Fade out" onBlur={endGesture}>
          <TimecodeField
            label="Fade out"
            value={o.fadeOutSec}
            format={formatFade}
            parse={parseSeconds}
            onCommit={(fadeOutSec) => updateOverlay(id, { fadeOutSec })}
            onNudge={setting("overlay-fade-out", (l) => l.fadeOutSec, (fadeOutSec) => ({ fadeOutSec }), 0.1, 1)}
          />
        </RailField>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-2">
        <RailField label="Start" hint="Start or end at the playhead" shortcut={START_KEYS} onBlur={endGesture}>
          <TimecodeField
            label="Start on the timeline"
            value={o.startSec}
            onCommit={(sec) => setOverlayStart(id, sec)}
            onNudge={nudger(id, "overlay-start", (l) => l.startSec, (sec, opts) => setOverlayStart(id, sec, opts), 0.1, 1)}
          />
        </RailField>
        <RailField label="Length" hint="In or out at the playhead" shortcut={LENGTH_KEYS} last onBlur={endGesture}>
          <TimecodeField
            label="Length"
            value={length}
            onCommit={(sec) => setOverlayLength(id, sec)}
            onNudge={nudger(
              id,
              "overlay-length",
              (l) => l.endSec - l.startSec,
              (sec, opts) => setOverlayLength(id, sec, opts),
              0.1,
              1,
            )}
          />
        </RailField>
      </div>

      <RailActions>
        <RailAction
          icon={<Scissors size={16} strokeWidth={1.5} />}
          label="Split at playhead"
          shortcut="S"
          disabled={!canSplit}
          onClick={splitSelectedOverlaysAtPlayhead}
        />
        <RailAction
          icon={<Trash size={16} strokeWidth={1.5} />}
          label="Remove text"
          shortcut="⌫"
          keyshortcuts="Backspace"
          onClick={() => removeLayers([id])}
        />
      </RailActions>
    </>
  );
}
