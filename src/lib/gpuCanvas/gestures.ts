/**
 * What a press on the GPU canvas does, decided as today's canvas decides it
 * from the navigation settings (WorkflowCanvas's React Flow props), and the
 * hit tests the scene's editing needs: handles, and what a marquee takes.
 */
import type { CanvasNavigationSettings } from "@/types/canvas";
import { contains, type Box } from "@/lib/nodes/marqueeSelection";
import type { HandleAnchor, SceneGraph } from "./graph";

export type PaneAction = "pan" | "select" | null;

export interface PaneModifiers {
  button: number;
  shiftKey: boolean;
  altKey: boolean;
  /** Space is held (the "space" pan mode's key). */
  space: boolean;
}

/**
 * What a drag on empty canvas does. Mirrors React Flow as WorkflowCanvas
 * configures it: `selectionKeyCode` (Shift, or Alt for "altDrag") draws a
 * marquee; `panActivationKeyCode` (Space in "space" mode) pans; otherwise
 * `panOnDrag` (left and middle when "always", or by default off the Mac; the
 * right button in "middleMouse" mode) pans, and `selectionOnDrag` (on the
 * Mac, unless a drag mode or "always" is set) draws a marquee.
 */
export function paneDragAction(settings: CanvasNavigationSettings, modifiers: PaneModifiers, isMac: boolean): PaneAction {
  const { button } = modifiers;
  if (selectionKeyHeld(settings, modifiers)) return "select";
  if (settings.panMode === "space" && modifiers.space && (button === 0 || button === 1)) return "pan";
  const panButtons = settings.panMode === "always" ? [0, 1] : settings.panMode === "middleMouse" ? [2] : isMac ? [] : [0, 1];
  if (panButtons.includes(button)) return "pan";
  const selectionOnDrag = settings.selectionMode === "altDrag" || settings.selectionMode === "shiftDrag" ? false : settings.panMode === "always" ? false : isMac;
  if (button === 0 && selectionOnDrag) return "select";
  return null;
}

/**
 * A left press with React Flow's `selectionKeyCode` held (Shift, or Alt for
 * "altDrag"). Unlike `selectionOnDrag`, which draws a marquee only from empty
 * canvas, it starts a selection over nodes and connections too.
 */
export function selectionKeyHeld(settings: CanvasNavigationSettings, modifiers: PaneModifiers): boolean {
  return modifiers.button === 0 && (settings.selectionMode === "altDrag" ? modifiers.altKey : modifiers.shiftKey);
}

export interface HandleHit {
  node: number;
  /** The handle's id ("" for a handle without one). */
  handleId: string;
  type: "source" | "target";
  /** Its anchor, where an edge meets it (flow units). */
  x: number;
  y: number;
  /** Its box's centre (flow units): where React Flow ends a connection line and opens the handle's menu. */
  cx: number;
  cy: number;
  /** Whether a connection may end on it. */
  connectableEnd: boolean;
}

/** A socket's reach round its box's centre: the 30×34 ellipse of `.react-flow__handle.socket::before` (globals.css). */
const SOCKET_REACH_X = 15;
const SOCKET_REACH_Y = 17;

function handleHit(graph: SceneGraph, i: number, key: string, anchor: HandleAnchor): HandleHit {
  const n = graph.nodes[i], colon = key.indexOf(":"), box = anchor.box;
  const x = n.x + anchor.x, y = n.y + anchor.y;
  return {
    node: i, handleId: key.slice(colon + 1), type: key.slice(0, colon) as "source" | "target", x, y,
    cx: box ? n.x + box.x + box.w / 2 : x, cy: box ? n.y + box.y + box.h / 2 : y,
    connectableEnd: anchor.connectableEnd !== false,
  };
}

/** A hidden legacy socket: kept for the edges that name it, but no pointer reaches it. */
function takesNoPointer(anchor: HandleAnchor) {
  return anchor.connectableStart === false && anchor.connectableEnd === false;
}

/**
 * The measured handle under a flow point, as the element under the pointer
 * would be on today's canvas: in the handle's box or the socket's ellipse
 * round it, or within `floor` (flow units) of its centre so a small zoom
 * still grabs it. The nearest centre wins. Handles are known for nodes that
 * have been painted (or are live).
 */
export function handleAt(graph: SceneGraph, nodes: Iterable<number>, x: number, y: number, floor: number): HandleHit | null {
  let best: HandleHit | null = null, bestDistance = Infinity;
  for (const i of nodes) {
    const n = graph.nodes[i];
    if (!n?.handles) continue;
    for (const [key, anchor] of n.handles) {
      if (takesNoPointer(anchor)) continue;
      const hit = handleHit(graph, i, key, anchor), box = anchor.box;
      const dx = x - hit.cx, dy = y - hit.cy, distance = Math.hypot(dx, dy);
      const on = distance <= floor || (!!box && ((dx / SOCKET_REACH_X) ** 2 + (dy / SOCKET_REACH_Y) ** 2 <= 1
        || (Math.abs(dx) <= box.w / 2 && Math.abs(dy) <= box.h / 2)));
      if (!on || distance >= bestDistance) continue;
      bestDistance = distance;
      best = hit;
    }
  }
  return best;
}

/**
 * React Flow's getClosestHandle for a connection being drawn: the handle
 * whose centre is nearest a flow point within `radius`, of either kind (on
 * a tie the kind `prefer`), leaving out the one the connection starts from
 * and those it cannot end on.
 */
export function closestHandle(graph: SceneGraph, nodes: Iterable<number>, x: number, y: number, radius: number, prefer: "source" | "target", from?: HandleHit): HandleHit | null {
  let best: HandleHit | null = null, bestDistance = Infinity;
  for (const i of nodes) {
    const n = graph.nodes[i];
    if (!n?.handles) continue;
    for (const [key, anchor] of n.handles) {
      if (anchor.connectableEnd === false) continue;
      const hit = handleHit(graph, i, key, anchor);
      if (from && hit.node === from.node && hit.type === from.type && hit.handleId === from.handleId) continue;
      const distance = Math.hypot(x - hit.cx, y - hit.cy);
      if (distance > radius || distance > bestDistance || (distance === bestDistance && (hit.type !== prefer || best?.type === prefer))) continue;
      bestDistance = distance;
      best = hit;
    }
  }
  return best;
}

export type CardBox = { x: number; y: number; w: number; h: number } | null;

/**
 * The nodes a marquee takes (flow units): it must hold the node's media
 * card whole, or the node whole when it has none (marqueeSelection.ts).
 * `cards` holds cards measured as they show now (live nodes), which win
 * over the painted ones; null is a node with no card.
 */
export function marqueeNodes(graph: SceneGraph, candidates: Iterable<number>, marquee: Box, cards?: ReadonlyMap<number, CardBox>): number[] {
  const taken: number[] = [];
  for (const i of candidates) {
    const n = graph.nodes[i];
    const card = cards?.has(i) ? cards.get(i) : n.card;
    const box: Box = card
      ? { left: n.x + card.x, top: n.y + card.y, right: n.x + card.x + card.w, bottom: n.y + card.y + card.h }
      : { left: n.x, top: n.y, right: n.x + n.w, bottom: n.y + n.h };
    if (contains(marquee, box)) taken.push(i);
  }
  return taken;
}
