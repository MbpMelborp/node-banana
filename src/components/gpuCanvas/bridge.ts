/**
 * The running GPU canvas, for chrome that shows the whole graph and so
 * cannot read React Flow (whose store holds only the live nodes): the
 * navigator's minimap and its Fit view, the agent bringing its edits into view,
 * and the hook sweep crossing its connections.
 */
import { useSyncExternalStore } from "react";
import type { SceneGraph } from "@/lib/gpuCanvas/graph";
import type { View } from "@/lib/gpuCanvas/scene";
import type { HookPath } from "@/components/edges/EdgeHookSelection";

export interface GpuCanvasBridge {
  graph: () => SceneGraph;
  view: () => View;
  /** The canvas's size in css px. */
  size: () => { width: number; height: number };
  setView: (view: Partial<View>) => void;
  /** Moves to a view over `duration` ms, as React Flow's animated setViewport. */
  animateView: (view: View, duration: number) => void;
  fit: () => void;
  /** The paths of these connections near the view, sampled in client px (the hook sweep crosses them). */
  edgePaths: (ids: Set<string>) => HookPath[];
  /** Called when the view or the graph's layout changed. */
  subscribe: (listener: () => void) => () => void;
}

let current: GpuCanvasBridge | null = null;
const listeners = new Set<() => void>();

export function setGpuCanvasBridge(bridge: GpuCanvasBridge | null) {
  current = bridge;
  for (const listener of listeners) listener();
}

/** The running GPU canvas's connections for the hook sweep (EdgeHookSelection's `paths`); none while it is not running. */
export function gpuEdgePaths(ids: Set<string>): HookPath[] {
  return current?.edgePaths(ids) ?? [];
}

export function useGpuCanvasBridge(): GpuCanvasBridge | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => null,
  );
}
