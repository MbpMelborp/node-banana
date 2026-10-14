/**
 * What a wheel does on the GPU canvas: the classic canvas's two wheel
 * handlers in the order they see it. React Flow's zoom pane (d3-zoom) comes
 * first and takes a pinch, or a wheel with its zoom key held, zooming about
 * the pointer and stopping the event there. What it leaves goes to
 * `useWheelPanZoom` on the wrapper, which leaves an inner area that can
 * still scroll to the browser and otherwise steps the zoom 1.2x about the
 * centre, pans (a macOS trackpad) or does nothing.
 */
import { findScrollableAncestor, isMacOS, wheelAction } from "@/hooks/useWheelPanZoom";
import type { CanvasNavigationSettings } from "@/types/canvas";

export type SceneWheel =
  | { type: "zoom"; factor: number; about: "pointer" | "centre" }
  | { type: "pan"; dx: number; dy: number }
  /** Nothing moves, but the browser must not zoom the page either. */
  | { type: "block" }
  /** Left to the browser (an inner area scrolls, or the wheel does nothing). */
  | null;

export interface SceneWheelOptions {
  settings: CanvasNavigationSettings;
  /** React Flow's `zoomOnPinch` on classic (off in the tutorial and under a modal). */
  zoomOnPinch: boolean;
  /** Whether `useWheelPanZoom` runs on classic (off under a modal). */
  wrapperWheel: boolean;
  mac?: boolean;
}

/** React Flow's d3 wheel delta: a zoom by 2^delta. */
function flowWheelDelta(event: WheelEvent, mac: boolean) {
  const factor = event.ctrlKey && mac ? 10 : 1;
  return -event.deltaY * (event.deltaMode === 1 ? 0.05 : event.deltaMode ? 1 : 0.002) * factor;
}

export function sceneWheel(event: WheelEvent, { settings, zoomOnPinch, wrapperWheel, mac = isMacOS }: SceneWheelOptions): SceneWheel {
  const target = event.target instanceof HTMLElement ? event.target : null;
  const noWheel = !!target?.closest(".nowheel");
  // React Flow's zoom pane: a pinch (ctrl) when zoomOnPinch is on, or the zoom
  // activation key (Meta on macOS, Control elsewhere, which is the pinch's ctrl).
  const flowZooms = event.ctrlKey ? zoomOnPinch : mac && event.metaKey;
  if (flowZooms && !noWheel) return { type: "zoom", factor: 2 ** flowWheelDelta(event, mac), about: "pointer" };
  // A pinch over a .nowheel area never zooms the page (React Flow's rule).
  const held: SceneWheel = event.ctrlKey && noWheel ? { type: "block" } : null;
  if (!wrapperWheel || (target && findScrollableAncestor(target, event.deltaX, event.deltaY))) return held;
  const action = wheelAction(event, settings, mac);
  if (action === "ignore") return held;
  if (action === "pan") return { type: "pan", dx: event.deltaX, dy: event.deltaY };
  // React Flow's zoomIn/zoomOut: a 1.2x step about the centre, whatever the delta.
  return { type: "zoom", factor: action === "zoomIn" ? 1.2 : 1 / 1.2, about: "centre" };
}
