"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface CubicBezierEditorProps {
  value: [number, number, number, number];
  onChange: (value: [number, number, number, number]) => void;
  /** The value a drag or a run of arrow keys ended on; only when it changed something. */
  onCommit?: (value: [number, number, number, number]) => void;
  disabled?: boolean;
  /** SVG polyline points string (in 0–100 coordinate space) for the actual easing curve overlay */
  easingCurve?: string;
  /** Extra classes on the framed box, e.g. to cap its size. */
  className?: string;
  /** "node": the Ease Curve node's lime on its dark square; "edit": the Edit video editor's neutrals. */
  tone?: "node" | "edit";
}

type Handle = "p1" | "p2";
type Value = [number, number, number, number];

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const round3 = (value: number) => Math.round(value * 1000) / 1000;

const ARROW_STEP = 0.01;
const BIG_ARROW_STEP = 0.1;
const ARROWS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

/** Class strings per tone; opacity, width and dash stay attributes. */
const TONES = {
  node: {
    frame: "bg-neutral-900/50 rounded-lg border border-neutral-700 p-2",
    plot: "fill-neutral-950 stroke-white/12",
    grid: "stroke-white/12",
    arms: "stroke-white/35",
    curve: "stroke-handle-easeCurve",
    muted: "stroke-white/35",
    handle: "border-neutral-900/80 bg-lime-300/80",
    dragging: "ring-2 ring-lime-300/80",
    focus: "",
  },
  edit: {
    frame: "rounded-lg bg-edit-field p-2",
    plot: "fill-pane stroke-white/10",
    grid: "stroke-white/10",
    arms: "stroke-white/35",
    curve: "stroke-neutral-100",
    muted: "stroke-white/35",
    handle: "border-pane bg-neutral-100",
    dragging: "ring-2 ring-white/40",
    focus: "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40",
  },
} as const;

const now = () =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

const sameValue = (a: Value, b: Value) => a.every((v, i) => v === b[i]);

export function CubicBezierEditor({
  value,
  onChange,
  onCommit,
  disabled = false,
  easingCurve,
  className,
  tone = "node",
}: CubicBezierEditorProps) {
  const palette = TONES[tone];
  const editorRef = useRef<HTMLDivElement | null>(null);
  const valueRef = useRef(value);
  const draggingHandleRef = useRef<Handle | null>(null);
  const [draggingHandle, setDraggingHandle] = useState<Handle | null>(null);
  const commitFrameRef = useRef<number | null>(null);
  const pendingValueRef = useRef<{
    value: Value;
    capturedAt: number;
  } | null>(null);
  // Where the pointer held the handle, from its centre (normalised): a press never jumps it
  const grabRef = useRef({ x: 0, y: 0 });
  // The gesture moved the value: only then does it end in onCommit
  const changedRef = useRef(false);

  const [v0, v1, v2, v3] = value;

  // Sync valueRef with prop values (used by drag handlers)
  useEffect(() => {
    valueRef.current = value;
  }, [v0, v1, v2, v3]); // eslint-disable-line react-hooks/exhaustive-deps

  const flushPendingChange = useCallback(() => {
    commitFrameRef.current = null;
    if (!pendingValueRef.current) return;
    const { value: nextValue } = pendingValueRef.current;
    onChange(nextValue);
    pendingValueRef.current = null;
  }, [onChange]);

  const scheduleCommit = useCallback(() => {
    if (commitFrameRef.current !== null) return;
    const frame = window.requestAnimationFrame(flushPendingChange);
    // A frame that ran at once has flushed already, and must not be waited for
    if (pendingValueRef.current) commitFrameRef.current = frame;
  }, [flushPendingChange]);

  useEffect(() => {
    return () => {
      if (commitFrameRef.current !== null) {
        cancelAnimationFrame(commitFrameRef.current);
      }
    };
  }, []);

  /** The pointer in the editor's unit square, unclamped (y up). */
  const pointerAt = useCallback((clientX: number, clientY: number) => {
    const rect = editorRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const width = rect.width || 260;
    const height = rect.height || 260;
    return { x: (clientX - rect.left) / width, y: 1 - (clientY - rect.top) / height };
  }, []);

  const updateHandleFromClient = useCallback(
    (handle: Handle, clientX: number, clientY: number) => {
      const pointer = pointerAt(clientX, clientY);
      if (!pointer) return;
      // The grab comes off the raw pointer and only the result is clamped, so a handle held off-centre still reaches the edge
      const x = clamp(pointer.x - grabRef.current.x);
      const y = clamp(pointer.y - grabRef.current.y);
      const current = valueRef.current;
      const nextValue: Value =
        handle === "p1" ? [x, y, current[2], current[3]] : [current[0], current[1], x, y];
      if (sameValue(nextValue, current)) return;
      pendingValueRef.current = {
        value: nextValue,
        capturedAt: now(),
      };
      valueRef.current = nextValue;
      changedRef.current = true;
      scheduleCommit();
    },
    [pointerAt, scheduleCommit]
  );

  const startDragging = useCallback(
    (handle: Handle, event: React.PointerEvent<HTMLButtonElement>) => {
      if (disabled) return;
      event.preventDefault();
      // A run of arrow keys still open ends first, as its own gesture
      if (changedRef.current) {
        changedRef.current = false;
        onCommit?.(valueRef.current);
      }
      const pointer = pointerAt(event.clientX, event.clientY);
      const current = valueRef.current;
      const [hx, hy] = handle === "p1" ? [current[0], current[1]] : [current[2], current[3]];
      grabRef.current = pointer ? { x: pointer.x - hx, y: pointer.y - hy } : { x: 0, y: 0 };
      draggingHandleRef.current = handle;
      setDraggingHandle(handle);
    },
    [disabled, onCommit, pointerAt]
  );

  // Window-level pointer listeners for smooth drag across entire viewport
  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const handle = draggingHandleRef.current;
      if (!handle || disabled) return;
      event.preventDefault();
      updateHandleFromClient(handle, event.clientX, event.clientY);
    };

    const stopDragging = () => {
      if (!draggingHandleRef.current) return;
      draggingHandleRef.current = null;
      setDraggingHandle(null);
      // The last frame's value lands before the gesture ends, never after it
      if (commitFrameRef.current !== null) {
        cancelAnimationFrame(commitFrameRef.current);
        commitFrameRef.current = null;
      }
      if (pendingValueRef.current) {
        const { value: last } = pendingValueRef.current;
        pendingValueRef.current = null;
        onChange(last);
      }
      if (changedRef.current) {
        changedRef.current = false;
        onCommit?.(valueRef.current);
      }
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopDragging);
    window.addEventListener("pointercancel", stopDragging);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopDragging);
      window.removeEventListener("pointercancel", stopDragging);
    };
  }, [disabled, onChange, onCommit, updateHandleFromClient]);

  // The arrows move a focused handle (⇧ further); the run ends in onCommit on key-up or blur
  const onHandleKeyDown = (handle: Handle, event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled || draggingHandleRef.current || !ARROWS.has(event.key)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    // React Flow's node would move with them
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? BIG_ARROW_STEP : ARROW_STEP;
    const dx = event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0;
    const dy = event.key === "ArrowUp" ? step : event.key === "ArrowDown" ? -step : 0;
    const current = valueRef.current;
    const i = handle === "p1" ? 0 : 2;
    const x = round3(clamp(current[i] + dx));
    const y = round3(clamp(current[i + 1] + dy));
    if (x === current[i] && y === current[i + 1]) return;
    const nextValue: Value = handle === "p1" ? [x, y, current[2], current[3]] : [current[0], current[1], x, y];
    valueRef.current = nextValue;
    changedRef.current = true;
    onChange(nextValue);
  };
  const endKeys = () => {
    if (!changedRef.current || draggingHandleRef.current) return;
    changedRef.current = false;
    onCommit?.(valueRef.current);
  };

  const controlStyles = useMemo(
    () => ({
      p1: {
        left: `${(v0 * 100).toFixed(2)}%`,
        top: `${((1 - v1) * 100).toFixed(2)}%`,
      },
      p2: {
        left: `${(v2 * 100).toFixed(2)}%`,
        top: `${((1 - v3) * 100).toFixed(2)}%`,
      },
    }),
    [v0, v1, v2, v3]
  );

  const svgPoints = useMemo(
    () => ({
      start: { x: 0, y: 100 },
      end: { x: 100, y: 0 },
      c1: { x: v0 * 100, y: (1 - v1) * 100 },
      c2: { x: v2 * 100, y: (1 - v3) * 100 },
    }),
    [v0, v1, v2, v3]
  );

  const curvePath = useMemo(
    () =>
      `M${svgPoints.start.x} ${svgPoints.start.y} C ${svgPoints.c1.x} ${svgPoints.c1.y}, ${svgPoints.c2.x} ${svgPoints.c2.y}, ${svgPoints.end.x} ${svgPoints.end.y}`,
    [svgPoints]
  );

  const handleButton = (handle: Handle, label: string) => (
    // nodrag nopan touch-none keep React Flow from dragging the node
    <button
      type="button"
      aria-label={label}
      className={`nodrag nopan absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border ${palette.handle} shadow transition active:cursor-grabbing active:scale-95 disabled:cursor-not-allowed disabled:pointer-events-none touch-none ${palette.focus} ${
        draggingHandle === handle ? palette.dragging : ""
      }`}
      style={controlStyles[handle]}
      onPointerDown={(event) => startDragging(handle, event)}
      onKeyDown={(event) => onHandleKeyDown(handle, event)}
      onKeyUp={(event) => {
        if (ARROWS.has(event.key)) endKeys();
      }}
      onBlur={endKeys}
      disabled={disabled}
    />
  );

  return (
    <div className={`${palette.frame}${className ? ` ${className}` : ""}`}>
      <div ref={editorRef} className="relative w-full aspect-square">
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full select-none"
          aria-hidden="true"
        >
          <rect x="0" y="0" width="100" height="100" className={palette.plot} strokeWidth="0.8" rx="2" />
          {/* Grid lines */}
          <g className={palette.grid} strokeWidth="0.4" strokeOpacity="0.6">
            <line x1="0" y1="50" x2="100" y2="50" />
            <line x1="50" y1="0" x2="50" y2="100" />
          </g>
          {/* Diagonal reference line */}
          <line
            x1="0"
            y1="100"
            x2="100"
            y2="0"
            className={palette.grid}
            strokeWidth="0.6"
            strokeDasharray="4 4"
            strokeOpacity="0.7"
          />
          {/* Control point lines */}
          <g className={palette.arms} strokeWidth="0.8">
            <line x1="0" y1="100" x2={svgPoints.c1.x} y2={svgPoints.c1.y} />
            <line x1="100" y1="0" x2={svgPoints.c2.x} y2={svgPoints.c2.y} />
          </g>
          {/* Bezier curve — dimmed when easing overlay is active */}
          <path
            d={curvePath}
            fill="none"
            className={easingCurve ? palette.muted : palette.curve}
            strokeWidth={easingCurve ? "0.8" : "1.5"}
            strokeLinecap="round"
            strokeDasharray={easingCurve ? "3 2" : undefined}
          />
          {/* Actual easing function curve overlay */}
          {easingCurve && (
            <polyline
              points={easingCurve}
              fill="none"
              className={palette.curve}
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
        </svg>
        {handleButton("p1", "Adjust control point 1")}
        {handleButton("p2", "Adjust control point 2")}
      </div>
    </div>
  );
}
