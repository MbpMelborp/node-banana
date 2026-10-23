"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/components/nodes/ui/cn";
import { CubicBezierEditor } from "@/components/CubicBezierEditor";
import { easingLabel, easingPolyline, isIdentityBezier } from "@/lib/easing";
import { RAMP_PRESETS, rampModeOf, seedRamp, type RampMode } from "@/lib/stitch/rampModes";
import { progressToY, remapPolyline, type RemapMetrics } from "@/lib/stitch/remapGeometry";
import { isWindowed, warpCurve } from "@/lib/stitch/warp";
import type { ClipWarpCurve } from "@/types";
import { EDITOR_PANEL_SELECTOR, SEGMENT_OFF, SEGMENT_ON } from "./editorStyles";
import { RailNote, RailSegments } from "./railParts";

type Handles = [number, number, number, number];

const MODES: ReadonlyArray<{ mode: RampMode; label: string }> = [
  { mode: "none", label: "None" },
  { mode: "preset", label: "Preset" },
  { mode: "bezier", label: "Bezier" },
  { mode: "points", label: "Points" },
];

const THUMB_PX = 24;
const GRID_COLUMNS = 6;
const THUMBS = RAMP_PRESETS.map((name) => ({
  name,
  label: easingLabel(name),
  points: easingPolyline(name, THUMB_PX, THUMB_PX, 20),
}));

/** The read-only preview's drawing box: the rail's 240px, 56 tall, 6px clear at every side. */
const PREVIEW_W = 240;
const PREVIEW_H = 56;
const PREVIEW_INSET = 6;
const PREVIEW_METRICS: RemapMetrics = { top: PREVIEW_INSET, span: PREVIEW_H - 2 * PREVIEW_INSET };

export interface EasePickerProps {
  /** The stored ramp; null: constant speed. */
  curve: ClipWarpCurve | null;
  /** A split piece's part of it. */
  window?: readonly [number, number];
  disabled?: boolean;
  /** A new ramp. While a bezier handle is held: { gestureKey }, so its frames are one undo step. */
  onChange: (curve: ClipWarpCurve | null, opts?: { gestureKey?: string }) => void;
  /** A held bezier handle let go (the rail ends the gesture). */
  onGestureEnd: () => void;
  gestureKey: string;
  /** Points pressed, pressed already or not: the timeline's speed row opens. */
  onPoints?: () => void;
  /** The bake budget a switch to Points uses (seedRamp's maxError). */
  maxError?: number;
}

/**
 * A clip's ramp, inline in the rail: None, Preset (a grid of the library's monotone easings), Bezier (the bezier
 * editor) or Points (the curve drawn; its knots are edited on the timeline). A switch seeds the new mode from the
 * ramp there is. A split piece shows as Points, its part of the ramp drawn.
 */
export function EasePicker({
  curve,
  window,
  disabled,
  onChange,
  onGestureEnd,
  gestureKey,
  onPoints,
  maxError,
}: EasePickerProps) {
  const root = useRef<HTMLDivElement>(null);
  // The handles while one is held: through the diagonal the stored ramp is none for a moment, and the editor must
  // stay under the pointer
  const [held, setHeld] = useState<Handles | null>(null);
  const mode: RampMode = held ? "bezier" : rampModeOf(curve, window);
  const handles = held ?? (curve?.kind === "bezier" ? curve.handles : null);

  const release = (h: Handles) => {
    onChange({ kind: "bezier", handles: h }, { gestureKey });
    onGestureEnd();
    // Let go on the diagonal there is no ramp, and the editor goes: a focused handle hands focus to the panel
    const active = document.activeElement;
    if (isIdentityBezier(h) && active && root.current?.contains(active)) {
      root.current.closest<HTMLElement>(EDITOR_PANEL_SELECTOR)?.focus({ preventScroll: true });
    }
    setHeld(null);
  };

  return (
    <div ref={root}>
      <RailSegments
        label="Ramp"
        segments={MODES.map(({ mode: m, label }) => ({
          label,
          pressed: mode === m,
          disabled,
          onClick: () => {
            if (m !== mode) onChange(seedRamp(m, curve, window, maxError));
            if (m === "points") onPoints?.();
          },
        }))}
      />
      {mode === "preset" && curve?.kind === "preset" && (
        <PresetGrid name={curve.name} disabled={disabled} onPick={(name) => onChange({ kind: "preset", name })} />
      )}
      {mode === "bezier" && handles && (
        <CubicBezierEditor
          tone="edit"
          className="mt-2"
          value={handles}
          disabled={disabled}
          onChange={(h) => {
            setHeld(h);
            onChange({ kind: "bezier", handles: h }, { gestureKey });
          }}
          onCommit={release}
        />
      )}
      {mode === "points" && curve && <RampPreview curve={curve} window={window} />}
      {mode === "points" && isWindowed(window) && <RailNote>Part of a ramp, cut by a split.</RailNote>}
    </div>
  );
}

/** The presets as curve thumbnails, one tab stop (the pressed one): the arrows, Home and End move, a press picks. */
function PresetGrid({
  name,
  disabled,
  onPick,
}: {
  name: string;
  disabled?: boolean;
  onPick: (name: string) => void;
}) {
  const pressed = THUMBS.findIndex((t) => t.name === name);
  const stop = pressed === -1 ? 0 : pressed;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at === -1) return;
    const last = buttons.length - 1;
    const moves: Record<string, number> = {
      ArrowLeft: at - 1,
      ArrowRight: at + 1,
      ArrowUp: at - GRID_COLUMNS,
      ArrowDown: at + GRID_COLUMNS,
      Home: 0,
      End: last,
    };
    if (!(event.key in moves)) return;
    event.preventDefault();
    buttons[Math.min(Math.max(moves[event.key], 0), last)].focus();
  };

  return (
    <div
      role="group"
      aria-label="Ramp presets"
      className="mt-2 grid grid-cols-6 gap-0.5 rounded-lg bg-edit-field p-0.5"
      onKeyDown={onKeyDown}
    >
      {THUMBS.map((thumb, i) => (
        <button
          key={thumb.name}
          type="button"
          aria-pressed={i === pressed}
          aria-label={thumb.label}
          title={thumb.label}
          tabIndex={i === stop ? 0 : -1}
          disabled={disabled}
          onClick={() => onPick(thumb.name)}
          className={cn(
            "flex aspect-square items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 disabled:cursor-not-allowed disabled:opacity-40",
            i === pressed ? SEGMENT_ON : SEGMENT_OFF,
          )}
        >
          <svg aria-hidden="true" viewBox={`0 0 ${THUMB_PX} ${THUMB_PX}`} className="h-6 w-6 overflow-visible">
            <polyline
              points={thumb.points}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      ))}
    </div>
  );
}

/** A points ramp or a split piece, drawn read-only: source progress up, the clip's time across, over its average (the diagonal). */
function RampPreview({ curve, window }: { curve: ClipWarpCurve; window?: readonly [number, number] }) {
  const width = PREVIEW_W - 2 * PREVIEW_INSET;
  const x = (p: number) => PREVIEW_INSET + p * width;
  const knots = curve.kind === "points" && !isWindowed(window) ? curve.points.slice(1, -1) : [];
  const line = remapPolyline(
    warpCurve(curve, window).ease,
    width,
    PREVIEW_METRICS,
    knots.map(([p]) => p),
  );
  return (
    <svg
      aria-hidden="true"
      data-testid="stitch-ramp-preview"
      width="100%"
      height={PREVIEW_H}
      viewBox={`0 0 ${PREVIEW_W} ${PREVIEW_H}`}
      className="mt-2 block rounded-lg bg-edit-field"
    >
      <line
        x1={x(0)}
        y1={progressToY(0, PREVIEW_METRICS)}
        x2={x(1)}
        y2={progressToY(1, PREVIEW_METRICS)}
        strokeWidth={1}
        strokeDasharray="3 3"
        className="stroke-white/10"
      />
      <polyline
        points={line.map((v) => `${(v.x + PREVIEW_INSET).toFixed(1)},${v.y.toFixed(1)}`).join(" ")}
        fill="none"
        strokeWidth={1.5}
        strokeLinejoin="round"
        className="stroke-neutral-100"
      />
      {knots.map(([p, q]) => (
        <circle key={p} cx={x(p)} cy={progressToY(q, PREVIEW_METRICS)} r={2.5} className="fill-neutral-100" />
      ))}
    </svg>
  );
}
