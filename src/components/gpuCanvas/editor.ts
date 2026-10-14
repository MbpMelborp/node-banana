/**
 * Editing on the GPU canvas: what a press on the scene does, and the keys
 * that edit the selection. It is today's canvas's behaviour (React Flow as
 * WorkflowCanvas configures it, and WorkflowCanvas's own handlers) on the
 * scene's hit tests:
 *
 * - a click selects a node (Shift adds or removes it) or a connection, and
 *   a click on empty canvas clears the selection;
 * - a drag on a node moves it, or the whole selection when it is selected;
 *   the first move and the drop go to the store (the first records the undo
 *   step), the moves between only to the scene and the live layer;
 * - a drag from a handle draws a connection, dropped on a handle, a node or
 *   empty canvas as today; a click on a handle opens its menu; a drag from
 *   a connection's end moves that end to another handle (React Flow's
 *   reconnect); the view pans while the pointer is near the canvas's edge;
 * - a drag on empty canvas pans or draws a marquee, as the navigation
 *   settings say;
 * - Delete and Backspace remove the selected nodes and connections; the
 *   arrow keys move the selection, and Enter, Space and Escape select and
 *   unselect a focused live node, as React Flow's keyboard handling does;
 *   Tab steps through the connections and nodes (keyboardFocus.ts).
 *
 * Painted nodes are pictures, so their handles and media cards are the ones
 * painting measured (SceneNode.handles, SceneNode.card). Live nodes are real
 * components: the live layer hands presses on their handles here.
 */
import type { Connection, EdgeChange, NodeChange } from "@xyflow/react";
import { useWorkflowStore } from "@/store/workflowStore";
import { setConnectDrag } from "@/store/connectDragStore";
import { useAssetStore } from "@/store/assetStore";
import type { WorkflowEdge, WorkflowNode } from "@/types";
import type { CanvasNavigationSettings } from "@/types/canvas";
import type { HandleMenuTarget } from "@/components/HandleMenu";
import { routeEdge } from "@/lib/edges/route";
import { Position } from "@xyflow/react";
import type { Gesture, Scene } from "@/lib/gpuCanvas/scene";
import { autoPanVelocity, closestHandle, edgeEndAt, edgeEndHandle, handleAt, marqueeNodes, paneDragAction, RECONNECT_RADIUS, selectionKeyHeld, type CardBox, type HandleHit } from "@/lib/gpuCanvas/gestures";
import { cubicAt } from "@/lib/gpuCanvas/edgeRoutes";
import { pathIntersectsRect } from "@/lib/edges/marquee";
import type { LiveLayer } from "./LiveLayer";
import { mediaCardBox } from "./nodeSheets";
import { KeyboardFocus } from "./keyboardFocus";

/** Pointer travel (css px) under which a press is a click (React Flow's nodeClickDistance and nodeDragThreshold). */
const CLICK_DISTANCE = 5;
/** Pointer travel (css px) a press on empty canvas must pass to start a marquee (React Flow's paneClickDistance). */
const PANE_CLICK_DISTANCE = 1;
/** Under this a press on a handle is a click that opens its menu. */
const HANDLE_CLICK_SLOP = 4;
/** Pointer travel (css px) past which a press on a handle draws its connection line (React Flow's connectionDragThreshold). */
const CONNECTION_DRAG_THRESHOLD = 1;
/** How near (css px) to a painted handle's centre a press takes it, however small the zoom makes its socket. */
const HANDLE_HIT_PX = 9;
/** How near (flow units) to a handle's centre a dragged connection finds it (React Flow's connectionRadius). */
const CONNECTION_RADIUS = 20;
/** React Flow's default connection line (its style.css): 1px of #b1b1b7 in flow units. */
const CONNECTION_LINE_STROKE = "#b1b1b7";

/** What dropping a connection that found no handle hands WorkflowCanvas (React Flow's onConnectEnd state, as it reads it). */
export interface ConnectEndState {
  isValid: false;
  fromNode: WorkflowNode;
  fromHandle: { id: string | null; type: "source" | "target" };
}

/** WorkflowCanvas's side of editing: its settings and handlers, read when used. */
export interface GpuEditing {
  navigation: CanvasNavigationSettings;
  /** The navigator's lock: nodes cannot be moved or selected; a socket still connects, with no line drawn (as classic). */
  locked: boolean;
  /** A dialog is over the canvas: no gesture but the wheel. */
  disabled: boolean;
  /** The tutorial is running: dragging never pans (React Flow's panOnDrag and panActivationKeyCode off). */
  tutorial: boolean;
  isValidConnection: (connection: Connection) => boolean;
  onConnect: (connection: Connection) => void;
  /** A connection's end dragged onto another handle (React Flow's onReconnect). */
  onReconnect: (edge: WorkflowEdge, connection: Connection) => void;
  /** A connection dropped without a handle: on a node (`nodeId`) or on empty canvas. */
  onConnectEnd: (event: MouseEvent, state: ConnectEndState, nodeId: string | null) => void;
  onHandleClick: (target: HandleMenuTarget) => void;
  /** A node drag ended on this node (group membership follows its centre). */
  onNodeDragStop: (event: MouseEvent, node: WorkflowNode) => void;
  onPaneClick: () => void;
  /** The add-node menu at a screen point (double-click or right-click on empty canvas). */
  onPaneMenu: (clientX: number, clientY: number) => void;
  onEdgeClick: (event: MouseEvent, edge: WorkflowEdge) => void;
  onEdgeContextMenu: (event: MouseEvent, edge: WorkflowEdge) => void;
  /** The selected nodes or connections changed, however (React Flow's onSelectionChange; GpuCanvas calls it). */
  onSelectionChange?: (params: { nodes: WorkflowNode[]; edges: WorkflowEdge[] }) => void;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPod|iPhone|iPad/.test(navigator.platform);

function typing(target: EventTarget | null) {
  const active = document.activeElement;
  const field = (element: unknown) => element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement || (element instanceof HTMLElement && element.isContentEditable);
  return field(target) || field(active);
}

/** React Flow's arrow-key velocity: 5px a press (Shift moves four times as far). */
const ARROW_STEPS: Record<string, { x: number; y: number }> = {
  ArrowUp: { x: 0, y: -5 },
  ArrowDown: { x: 0, y: 5 },
  ArrowLeft: { x: -5, y: 0 },
  ArrowRight: { x: 5, y: 0 },
};

/** React Flow's isInputDOMNode: the key went to a form field, an editable element, or something inside `.nokey`. */
function keyInField(event: KeyboardEvent) {
  const target = event.composedPath?.()[0] ?? event.target;
  if (!(target instanceof Element)) return false;
  return target.matches("input, select, textarea, [contenteditable]") || !!target.closest(".nokey") || typing(target);
}

export class Editor {
  private space = false;
  private hoveredHandle: string | null = null;
  private overlay: SVGSVGElement;
  private marquee: HTMLDivElement;
  /** React Flow's NodesSelection: the dotted frame around the nodes a marquee selected, until a click or no node is selected. */
  private selectionFrame: HTMLDivElement;
  private selectionFrameActive = false;
  private offs: (() => void)[] = [];
  /** Tab through the nodes and connections (keyboardFocus.ts). */
  readonly keyboard: KeyboardFocus;

  constructor(private scene: Scene, private live: LiveLayer, private host: HTMLElement, private editing: () => GpuEditing) {
    this.keyboard = new KeyboardFocus(scene, live, host, () => this.editing().locked);
    // The connection line, the marquee and the selection frame are mounted in the live flow as they show
    // (mountInFlow), where classic's own sit: under the flow's panels (the navigator), the line also under
    // what the viewport portal holds (the multi-select toolbar).
    this.overlay = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.overlay.setAttribute("class", "pointer-events-none absolute inset-0 h-full w-full");
    this.overlay.style.overflow = "visible";
    this.marquee = document.createElement("div");
    this.marquee.dataset.gpuCanvasMarquee = "";
    // React Flow's user selection look (globals.css styles .react-flow__selection the same way).
    this.marquee.style.cssText = "position:absolute;display:none;pointer-events:none;z-index:4;background:rgba(0,89,220,0.08);border:1px dotted rgba(0,89,220,0.8);";
    this.selectionFrame = document.createElement("div");
    this.selectionFrame.dataset.gpuCanvasSelectionFrame = "";
    // .react-flow__nodesselection-rect's look (React Flow's selection colours).
    this.selectionFrame.style.cssText = "position:absolute;display:none;pointer-events:none;z-index:4;background:rgba(0,89,220,0.08);border:1px dotted rgba(0,89,220,0.8);";
    // The frame follows the view, the nodes' moves and sizes, and the selection.
    const placeFrame = () => { if (this.selectionFrameActive) this.placeSelectionFrame(); };
    this.offs.push(scene.onViewChanged(placeFrame), scene.onLayoutChanged(placeFrame));
    this.offs.push(useWorkflowStore.subscribe((state, previous) => { if (state.nodes !== previous.nodes) placeFrame(); }));
    const on = <K extends keyof WindowEventMap>(type: K, listener: (event: WindowEventMap[K]) => void) => {
      window.addEventListener(type, listener);
      this.offs.push(() => window.removeEventListener(type, listener));
    };
    on("keydown", (event) => this.keyDown(event));
    on("keyup", (event) => {
      if (event.code === "Space") this.space = false;
    });
    on("blur", () => { this.space = false; });
  }

  dispose() {
    for (const off of this.offs) off();
    this.keyboard.dispose();
    this.overlay.remove();
    this.marquee.remove();
    this.selectionFrame.remove();
  }

  /**
   * Puts `element` in the live flow: in its wrapper after the renderer (z-index 4, under the panels' 5), as
   * classic's marquee and selection frame sit in its pane; or in its viewport, as the connection line
   * (z-index 1001, under the viewport portal's toolbar). The host stands in while the flow is not there.
   * Returns whether it went into the viewport, whose transform then places what it draws.
   */
  private mountInFlow(element: Element, where: "wrapper" | "viewport"): boolean {
    const wrapper = this.live.element?.querySelector<HTMLElement>(".react-flow") ?? null;
    const parent = where === "viewport" ? wrapper?.querySelector<HTMLElement>(".react-flow__viewport") ?? null : wrapper;
    if (element.parentNode !== (parent ?? this.host)) (parent ?? this.host).appendChild(element);
    return where === "viewport" && !!parent;
  }

  // ── Keys ──────────────────────────────────────────────────────────────

  private keyDown(event: KeyboardEvent) {
    if (event.code === "Space" && !typing(event.target)) this.space = true;
    if (event.defaultPrevented || keyInField(event)) return;
    const { disabled, locked } = this.editing();
    if (disabled || useAssetStore.getState().appView !== "canvas") return;
    if (event.key === "Delete" || event.key === "Backspace") {
      // React Flow's delete key: the key alone, with no modifier held.
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      // A dialog open over the canvas keeps its keys.
      if (document.querySelector("[data-dialog-overlay]") || (event.target instanceof Element && event.target.closest('[role="dialog"]'))) return;
      if (this.deleteSelection()) event.preventDefault();
      return;
    }
    // The keys React Flow gives a focused node: arrows move the selection, Enter and Space select, Escape unselects.
    if (locked) return;
    const step = ARROW_STEPS[event.key];
    if (step) {
      // A focused live node moves the selection only while it is part of it.
      const focusedNode = this.focusedLiveNode();
      if (focusedNode ? !useWorkflowStore.getState().nodes.find((n) => n.id === focusedNode)?.selected : !this.keyboardFocusOnCanvas()) return;
      if (this.nudgeSelection(step.x * (event.shiftKey ? 4 : 1), step.y * (event.shiftKey ? 4 : 1))) event.preventDefault();
      return;
    }
    const focused = this.focusedLiveNode();
    if (!focused) return;
    const node = useWorkflowStore.getState().nodes.find((n) => n.id === focused);
    if (!node || node.selectable === false) return;
    if ((event.key === "Enter" || event.key === " ") && !node.selected) this.selectNodes([focused], false);
    else if (event.key === "Escape" && node.selected) useWorkflowStore.getState().onNodesChange([{ type: "select", id: focused, selected: false }]);
  }

  /** The live node holding keyboard focus (React Flow focuses a node when it is clicked). */
  private focusedLiveNode(): string | null {
    const active = document.activeElement;
    if (!(active instanceof Element) || !active.closest("[data-gpu-canvas-live]")) return null;
    return active.closest(".react-flow__node:not(.react-flow__node-gpuGhost)")?.getAttribute("data-id") ?? null;
  }

  /** Focus where a click on a painted node or empty canvas leaves it: on nothing. */
  private keyboardFocusOnCanvas() {
    const active = document.activeElement;
    return !active || active === document.body || active === this.scene.canvas;
  }

  /** Moves the selected nodes by (dx, dy) as React Flow's arrow keys do (one position change, no undo step of its own). */
  private nudgeSelection(dx: number, dy: number): boolean {
    const graph = this.scene.graph;
    const moving = useWorkflowStore.getState().nodes
      .filter((n) => n.selected && n.draggable !== false)
      .map((n) => graph.indexOf.get(n.id))
      .filter((i): i is number => i != null);
    if (!moving.length) return false;
    for (const i of moving) {
      graph.nodes[i].x += dx;
      graph.nodes[i].y += dy;
    }
    this.scene.nodesMoved(moving);
    this.live.refresh();
    useWorkflowStore.getState().onNodesChange(this.positionChanges(moving, false));
    return true;
  }

  /** Removes the selected nodes and connections, as React Flow's delete key does: connections first, then nodes. */
  deleteSelection(): boolean {
    const store = useWorkflowStore.getState();
    const nodes = store.nodes.filter((n) => n.selected && n.deletable !== false);
    const removed = new Set(nodes.map((n) => n.id));
    const edges = store.edges.filter((e) => (e.selected && e.deletable !== false) || removed.has(e.source) || removed.has(e.target));
    if (!nodes.length && !edges.length) return false;
    if (edges.length) store.onEdgesChange(edges.map((e): EdgeChange<WorkflowEdge> => ({ type: "remove", id: e.id })));
    if (nodes.length) store.onNodesChange(nodes.map((n): NodeChange<WorkflowNode> => ({ type: "remove", id: n.id })));
    return true;
  }

  // ── Presses ───────────────────────────────────────────────────────────

  /** The scene's onPress: what this press starts. */
  press = (event: PointerEvent): Gesture | null => {
    const editing = this.editing();
    if (editing.disabled) return null;
    const scene = this.scene;
    const at = scene.local(event);
    const space = this.space && !editing.tutorial;
    const modifiers = { button: event.button, shiftKey: event.shiftKey, altKey: event.altKey, space };
    const panning = paneDragAction(editing.navigation, modifiers, isMac);
    // The tutorial turns panning off: such a press selects, drags and connects as a plain one.
    const action = editing.tutorial && panning === "pan" ? null : panning;
    // Space held (or the pan button) pans wherever the press lands, as React Flow's pan key does.
    if (action === "pan" && (space || event.button !== 0)) return scene.panGesture(event);
    if (event.button !== 0) return null;
    const keyHeld = selectionKeyHeld(editing.navigation, modifiers);
    // With the selection key held, React Flow's pane takes the press before a handle can: no connection starts.
    // A locked canvas still connects from a socket, as classic's do (Socket's handles stay connectable).
    if (!keyHeld) {
      const handle = this.handleFromEvent(event) ?? this.paintedHandleAt(at.x, at.y);
      if (handle) return this.connectGesture(event, handle);
    }
    const node = this.nodeFromEvent(event) ?? scene.nodeAt(at.x, at.y);
    // A connection's end, outside the handle it meets, moves that end (React Flow's reconnect anchors).
    if (node < 0 && !editing.locked && !keyHeld) {
      const end = this.edgeEndAt(at.x, at.y);
      if (end) return this.connectGesture(event, edgeEndHandle(scene.graph, end.edge, end.end === "source" ? "target" : "source"), end.edge);
    }
    const edge = node < 0 ? scene.edgeAt(at.x, at.y) : -1;
    // With the selection key held, a press on a node or connection starts a selection: a drag draws a
    // marquee at once, a release is still a click (Shift toggles it, as multiSelectionKeyCode).
    if ((node >= 0 || edge >= 0) && keyHeld && !editing.locked) {
      const click = node >= 0 ? () => this.clickNode(scene.graph.nodes[node].id, event.shiftKey) : () => this.clickEdge(event, edge);
      return this.clickGesture(event, click, () => this.marqueeGesture(event), 0);
    }
    // Otherwise a drag that selects (selectionOnDrag) starts only on empty canvas, as React Flow's pane does.
    if (node >= 0) return this.nodeGesture(event, node);
    if (edge >= 0) return this.clickGesture(event, () => this.clickEdge(event, edge));
    if (action === "pan") return this.paneGesture(event, scene.panGesture(event));
    // A marquee starts once the press moves (at once with the selection key held); a release before that is a pane click.
    if (action === "select" && !editing.locked) {
      return this.clickGesture(event, () => this.paneClick(), () => this.marqueeGesture(event), keyHeld ? 0 : PANE_CLICK_DISTANCE);
    }
    return this.paneGesture(event, null);
  };

  /** The live node (or its floating header) a press from the live layer landed on. */
  private nodeFromEvent(event: PointerEvent): number | null {
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest("[data-gpu-canvas-live]")) return null;
    const id = target.closest("[data-node-header]")?.getAttribute("data-node-header") ?? target.closest(".react-flow__node:not(.react-flow__node-gpuGhost)")?.getAttribute("data-id");
    return id ? this.scene.graph.indexOf.get(id) ?? null : null;
  }

  /** A handle of a live node, when the press came from the live layer. */
  private handleFromEvent(event: PointerEvent): HandleHit | null {
    const element = event.target instanceof Element ? event.target.closest<HTMLElement>(".react-flow__handle") : null;
    const nodeId = element?.dataset.nodeid;
    const i = nodeId ? this.scene.graph.indexOf.get(nodeId) : undefined;
    if (!element || i == null) return null;
    const rect = element.getBoundingClientRect(), box = this.scene.canvas.getBoundingClientRect();
    const p = this.scene.toWorld(rect.left + rect.width / 2 - box.left, rect.top + rect.height / 2 - box.top);
    const handleId = element.dataset.handleid ?? "", type = element.classList.contains("source") ? "source" : "target";
    const n = this.scene.graph.nodes[i], anchor = n.handles?.get(`${type}:${handleId}`);
    const classes = element.classList;
    return {
      node: i, handleId, type, x: anchor ? n.x + anchor.x : p.x, y: anchor ? n.y + anchor.y : p.y, cx: p.x, cy: p.y,
      connectableEnd: classes.contains("connectable") && classes.contains("connectableend"),
    };
  }

  /** The painted handle under a point (css px): on its socket, or within HANDLE_HIT_PX of its centre. */
  private paintedHandleAt(cssX: number, cssY: number): HandleHit | null {
    const scene = this.scene, p = scene.toWorld(cssX, cssY), floor = HANDLE_HIT_PX / scene.view.zoom;
    // Handles sit on a node's sides, a little outside it.
    let near = this.nodesNear(p.x, p.y, Math.max(floor, 24) + 24);
    // A node over the point covers the sockets of the nodes under it, as its element takes the pointer on today's canvas.
    const top = scene.nodeAt(cssX, cssY);
    if (top >= 0) near = near.filter((i) => scene.drawnAtOrAbove(i, top));
    return handleAt(scene.graph, near, p.x, p.y, floor);
  }

  /** The connection end (its reconnect anchor) under a point (css px). */
  private edgeEndAt(cssX: number, cssY: number) {
    const p = this.scene.toWorld(cssX, cssY);
    // The anchors sit beside the handles, a little outside their nodes.
    return edgeEndAt(this.scene.graph, this.nodesNear(p.x, p.y, RECONNECT_RADIUS * 2 + 24), p.x, p.y);
  }

  private nodesNear(x: number, y: number, reach: number): number[] {
    return this.scene.nodesWithin(x - reach, y - reach, x + reach, y + reach);
  }

  /**
   * Follows a press until it moves `distance` (any movement at 0) or ends; a release before that is a click.
   * A drag takes the pointer (the scene leaves a press on a live node uncaptured until then, so its click lands).
   */
  private clickGesture(event: PointerEvent, click: () => void, drag?: (move: PointerEvent) => Gesture | null, distance = CLICK_DISTANCE): Gesture {
    const startX = event.clientX, startY = event.clientY;
    let dragging: Gesture | null = null, moved = false;
    return {
      move: (move) => {
        if (dragging) return dragging.move(move);
        const travel = Math.hypot(move.clientX - startX, move.clientY - startY);
        if (moved || travel === 0 || travel < distance) return;
        moved = true;
        this.scene.capture();
        dragging = drag?.(move) ?? null;
        dragging?.move(move);
      },
      up: (up) => {
        if (dragging) dragging.up(up);
        else if (!moved) click();
      },
      cancel: () => dragging?.cancel(),
    };
  }

  /** Empty canvas: a click clears the selection; a drag pans when `pan` is given. */
  private paneGesture(event: PointerEvent, pan: Gesture | null): Gesture {
    return this.clickGesture(event, () => this.paneClick(), () => pan);
  }

  /**
   * A click on empty canvas: clears the selection (not on a locked canvas, where React Flow's
   * resetSelectedElements keeps it), and WorkflowCanvas's onPaneClick (it collapses the stub group).
   */
  private paneClick() {
    this.hideSelectionFrame();
    if (!this.editing().locked) this.clearSelection();
    this.editing().onPaneClick();
  }

  // ── Selection ─────────────────────────────────────────────────────────

  private clearSelection() {
    const store = useWorkflowStore.getState();
    const nodes = store.nodes.filter((n) => n.selected).map((n): NodeChange<WorkflowNode> => ({ type: "select", id: n.id, selected: false }));
    const edges = store.edges.filter((e) => e.selected).map((e): EdgeChange<WorkflowEdge> => ({ type: "select", id: e.id, selected: false }));
    if (nodes.length) store.onNodesChange(nodes);
    if (edges.length) store.onEdgesChange(edges);
  }

  /** Selects nodes as a click does: only these, or (additive) toggling them in the selection. */
  selectNodes(ids: string[], additive: boolean) {
    if (this.editing().locked) return;
    const store = useWorkflowStore.getState();
    const next = new Set(additive ? store.nodes.filter((n) => n.selected).map((n) => n.id) : []);
    for (const id of ids) {
      if (additive && next.has(id)) next.delete(id);
      else next.add(id);
    }
    const changes: NodeChange<WorkflowNode>[] = [];
    for (const node of store.nodes) if (!!node.selected !== next.has(node.id) && node.selectable !== false) changes.push({ type: "select", id: node.id, selected: next.has(node.id) });
    if (changes.length) store.onNodesChange(changes);
    // Selecting nodes drops a connection selection (WorkflowCanvas's handleSelectionChange).
    if (next.size) {
      const selectedEdges = useWorkflowStore.getState().edges.filter((e) => e.selected);
      if (selectedEdges.length) store.onEdgesChange(selectedEdges.map((e): EdgeChange<WorkflowEdge> => ({ type: "select", id: e.id, selected: false })));
    }
  }

  /**
   * A click on a node, as React Flow's handleNodeClick: an unselected node becomes the selection (Shift
   * adds it); a selected one leaves it with Shift, and otherwise the selection stays as it is.
   */
  clickNode(id: string, additive: boolean) {
    this.hideSelectionFrame();
    const node = useWorkflowStore.getState().nodes.find((n) => n.id === id);
    if (!node || (node.selected && !additive)) return;
    this.selectNodes([id], additive);
  }

  private clickEdge(event: PointerEvent, e: number) {
    const editing = this.editing();
    const store = useWorkflowStore.getState();
    const edge = store.edges.find((candidate) => candidate.id === this.scene.graph.edges[e]?.id);
    if (!edge) return;
    // On a locked canvas, or for a connection that cannot be selected, the click still reaches
    // WorkflowCanvas (its toolbar moves there) without changing the selection, as React Flow's EdgeWrapper.
    if (!editing.locked && edge.selectable !== false) {
      // Shift adds the connection, and selected nodes drop it again at once (WorkflowCanvas's handleSelectionChange,
      // which closes its toolbar too): nothing changes.
      if (event.shiftKey && store.nodes.some((n) => n.selected)) return;
      // React Flow's edge click: only this connection, or added to the selection with Shift.
      const additive = event.shiftKey;
      const nodes = additive ? [] : store.nodes.filter((n) => n.selected).map((n): NodeChange<WorkflowNode> => ({ type: "select", id: n.id, selected: false }));
      const edges = store.edges.flatMap((candidate): EdgeChange<WorkflowEdge>[] => {
        const selected = candidate.id === edge.id ? (additive ? !candidate.selected : true) : additive ? !!candidate.selected : false;
        return !!candidate.selected === selected ? [] : [{ type: "select", id: candidate.id, selected }];
      });
      if (nodes.length) store.onNodesChange(nodes);
      if (edges.length) store.onEdgesChange(edges);
    }
    editing.onEdgeClick(event, edge);
  }

  // ── Node drag ─────────────────────────────────────────────────────────

  private nodeGesture(event: PointerEvent, i: number): Gesture {
    const id = this.scene.graph.nodes[i].id;
    return this.clickGesture(event, () => this.clickNode(id, event.shiftKey), (move) => this.editing().locked ? null : this.dragGesture(event, move, i));
  }

  private dragGesture(down: PointerEvent, first: PointerEvent, pressed: number): Gesture | null {
    const scene = this.scene, graph = scene.graph;
    const store = useWorkflowStore.getState();
    const pressedId = graph.nodes[pressed].id;
    const pressedNode = store.nodes.find((n) => n.id === pressedId);
    if (!pressedNode || pressedNode.draggable === false) return null;
    // A selected node carries the selection; an unselected one moves alone (selectNodesOnDrag is off).
    const ids = (pressedNode.selected ? store.nodes.filter((n) => n.selected && n.draggable !== false).map((n) => n.id) : [pressedId])
      .filter((id) => graph.indexOf.has(id));
    const start = new Map(ids.map((id) => {
      const n = graph.nodes[graph.indexOf.get(id)!];
      return [id, { x: n.x, y: n.y }];
    }));
    // The nodes are held by id: nodes added or removed mid-drag renumber the graph (GpuCanvas's sync).
    const moving = () => ids.map((id) => scene.graph.indexOf.get(id)).filter((n): n is number => n != null);
    const moveTo = (indices: number[], dx: number, dy: number) => {
      for (const n of indices) {
        const node = scene.graph.nodes[n], from = start.get(node.id)!;
        node.x = from.x + dx;
        node.y = from.y + dy;
      }
    };
    const generation = store.canvasGeneration;
    const origin = scene.toWorld(scene.local(down).x, scene.local(down).y);
    // The dragged nodes stay live while they move (the pressed one is hovered, a selection is live).
    this.live.wantOnly("drag", ids);
    document.documentElement.classList.add("canvas-interacting");
    let committedFirst = false;
    let last = { dx: 0, dy: 0 };
    const place = (event: PointerEvent) => {
      const p = scene.local(event), w = scene.toWorld(p.x, p.y);
      const dx = w.x - origin.x, dy = w.y - origin.y;
      if (dx === last.dx && dy === last.dy) return;
      last = { dx, dy };
      const indices = moving();
      moveTo(indices, dx, dy);
      scene.input(event);
      scene.nodesMoved(indices);
      this.live.refresh();
      // The first move reaches the store: it records the undo step.
      if (!committedFirst) {
        committedFirst = true;
        useWorkflowStore.getState().onNodesChange(this.positionChanges(indices, true));
      }
    };
    const finish = (event: PointerEvent | null) => {
      this.live.wantOnly("drag", []);
      document.documentElement.classList.remove("canvas-interacting");
      const state = useWorkflowStore.getState();
      // The canvas was replaced mid-drag: the positions belong to the old one.
      if (state.canvasGeneration !== generation) return;
      const indices = moving();
      if (!event) {
        moveTo(indices, 0, 0);
        scene.nodesMoved(indices);
        state.onNodesChange(this.positionChanges(indices, false));
        return;
      }
      state.onNodesChange(this.positionChanges(indices, false));
      const node = useWorkflowStore.getState().nodes.find((n) => n.id === pressedId);
      if (node) this.editing().onNodeDragStop(event, node);
    };
    place(first);
    return { move: place, up: (event) => finish(event), cancel: () => finish(null) };
  }

  private positionChanges(moving: number[], dragging: boolean): NodeChange<WorkflowNode>[] {
    const graph = this.scene.graph;
    return moving.map((n) => ({ type: "position", id: graph.nodes[n].id, position: { x: graph.nodes[n].x, y: graph.nodes[n].y }, dragging }));
  }

  // ── Marquee ───────────────────────────────────────────────────────────

  private marqueeGesture(down: PointerEvent): Gesture {
    const scene = this.scene;
    // The press is held in flow coordinates, so a pan or zoom mid-marquee keeps its corner on the same canvas spot.
    const down0 = scene.local(down);
    const anchor = scene.toWorld(down0.x, down0.y);
    let last = down0;
    let previousNodes = "", previousEdges = "";
    // A marquee replaces the selection: it starts from none (React Flow's resetSelectedElements as it starts).
    this.hideSelectionFrame();
    this.clearSelection();
    // Live nodes are judged by their cards as they show now, as NodeMarqueeSelection measures the DOM as it starts.
    const cards = this.liveCards();
    const update = (at: { x: number; y: number }) => {
      last = at;
      const start = scene.toScreen(anchor.x, anchor.y);
      const left = Math.min(start.x, at.x), top = Math.min(start.y, at.y), width = Math.abs(at.x - start.x), height = Math.abs(at.y - start.y);
      this.mountInFlow(this.marquee, "wrapper");
      Object.assign(this.marquee.style, { display: "block", left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
      const a = scene.toWorld(left, top), b = scene.toWorld(left + width, top + height);
      const box = { left: a.x, top: a.y, right: b.x, bottom: b.y };
      const taken = marqueeNodes(scene.graph, scene.nodesWithin(a.x, a.y, b.x, b.y), box, cards).map((i) => scene.graph.nodes[i].id);
      const key = taken.join("\n");
      const state = useWorkflowStore.getState();
      if (key !== previousNodes) {
        previousNodes = key;
        const next = new Set(taken);
        const changes = state.nodes.filter((n) => !!n.selected !== next.has(n.id) && n.selectable !== false).map((n): NodeChange<WorkflowNode> => ({ type: "select", id: n.id, selected: next.has(n.id) }));
        if (changes.length) state.onNodesChange(changes);
      }
      // With no node selected, the connections the marquee crosses (EdgeMarqueeSelection).
      const edgeIds = useWorkflowStore.getState().nodes.some((n) => n.selected) ? [] : this.edgesCrossing(box);
      const edgeKey = edgeIds.join("\n");
      if (edgeKey !== previousEdges) {
        previousEdges = edgeKey;
        const next = new Set(edgeIds);
        const now = useWorkflowStore.getState();
        const changes = now.edges.filter((e) => !!e.selected !== next.has(e.id)).map((e): EdgeChange<WorkflowEdge> => ({ type: "select", id: e.id, selected: next.has(e.id) }));
        if (changes.length) now.onEdgesChange(changes);
      }
    };
    // A wheel or pinch redraws the box at once, from where the pointer last was.
    const offView = scene.onViewChanged(() => update(last));
    const end = () => {
      offView();
      this.marquee.style.display = "none";
    };
    return {
      move: (event) => update(scene.local(event)),
      up: (event) => {
        end();
        // A marquee that took only connections opens the toolbar at the release (handleSelectionEnd).
        const now = useWorkflowStore.getState();
        const firstEdge = now.edges.find((e) => e.selected);
        if (now.nodes.some((n) => n.selected)) {
          // Nodes taken: React Flow frames them (nodesSelectionActive).
          this.selectionFrameActive = true;
          this.placeSelectionFrame();
        } else if (firstEdge) {
          const p = scene.local(event), w = scene.toWorld(p.x, p.y);
          useWorkflowStore.setState({ edgeMenuAnchor: { edgeId: firstEdge.id, x: w.x, y: w.y } });
        }
      },
      cancel: end,
    };
  }

  /** The media cards of the live nodes as they show (an image loaded or a section opened since their paint). */
  private liveCards(): Map<number, CardBox> {
    const cards = new Map<number, CardBox>();
    for (const id of this.live.live) {
      const i = this.scene.graph.indexOf.get(id);
      if (i == null || !this.live.nodeElement(id)?.offsetWidth) continue;
      cards.set(i, mediaCardBox(this.live.element, id));
    }
    return cards;
  }

  /** Frames the selected nodes (the union of their boxes, in css px), or hides the frame when none is selected. */
  private placeSelectionFrame() {
    const scene = this.scene, graph = scene.graph;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const node of useWorkflowStore.getState().nodes) {
      const i = node.selected ? graph.indexOf.get(node.id) : undefined;
      if (i == null) continue;
      const n = graph.nodes[i];
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.w);
      maxY = Math.max(maxY, n.y + n.h);
    }
    if (minX > maxX) {
      this.hideSelectionFrame();
      return;
    }
    const a = scene.toScreen(minX, minY), b = scene.toScreen(maxX, maxY);
    this.mountInFlow(this.selectionFrame, "wrapper");
    Object.assign(this.selectionFrame.style, { display: "block", left: `${a.x}px`, top: `${a.y}px`, width: `${b.x - a.x}px`, height: `${b.y - a.y}px` });
  }

  private hideSelectionFrame() {
    if (!this.selectionFrameActive) return;
    this.selectionFrameActive = false;
    this.selectionFrame.style.display = "none";
  }

  private edgesCrossing(box: { left: number; top: number; right: number; bottom: number }): string[] {
    const scene = this.scene, ids: string[] = [];
    const rect = { x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top };
    for (const e of scene.edgesWithin(box.left, box.top, box.right, box.bottom)) {
      const edge = scene.graph.edges[e]?.edge;
      const route = scene.edgeRoute(e);
      if (!edge || !route || edge.hidden || edge.data?.hidden || edge.selectable === false || edge.type === "reference") continue;
      // The noodle is one path; a bundle's shared stem is a path of its first member's (BundleStem).
      const sample = (c: (typeof route.segments)[number]) => Array.from({ length: 17 }, (_, k) => cubicAt(c, k / 16));
      const paths = [route.segments.flatMap(sample), ...route.stems.map((stem) => sample(stem.segment))];
      if (paths.some((points) => pathIntersectsRect(points, rect))) ids.push(edge.id);
    }
    return ids;
  }

  // ── Connecting ────────────────────────────────────────────────────────

  /**
   * A connection drawn from `from`. With `reconnecting`, the press took that edge's other end: the
   * edge is hidden while it is drawn and a valid drop moves its end (React Flow's reconnect anchors);
   * a press that does not move is a click on the edge.
   */
  private connectGesture(down: PointerEvent, pressed: HandleHit, reconnecting?: number): Gesture {
    const scene = this.scene;
    const fromLive = reconnecting == null && down.target instanceof Element && !!down.target.closest(".react-flow__handle");
    // The nodes and the connection are held by id, as React Flow's are: nodes added or removed mid-drag
    // renumber the graph (GpuCanvas's sync), so `from` and the target are looked up again as they are used.
    const fromId = scene.graph.nodes[pressed.node].id;
    let from = pressed;
    const heldEdgeId = reconnecting == null ? null : scene.graph.edges[reconnecting].id;
    const handleId = from.handleId || null;
    const startX = down.clientX, startY = down.clientY;
    let dragging = false, ended = false;
    let target: { hit: HandleHit; nodeId: string } | null = null;
    let last = down, panFrame = 0, inViewport = false;
    let offs: (() => void)[] = [];
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const wanted = from.type === "source" ? "target" : "source";
    const draw = (event: PointerEvent) => {
      const fromIndex = scene.graph.indexOf.get(fromId);
      // The node it starts from was removed: the connection goes with it.
      if (fromIndex == null) {
        end();
        return;
      }
      if (fromIndex !== from.node) from = { ...from, node: fromIndex };
      const at = scene.local(event), p = scene.toWorld(at.x, at.y);
      // As React Flow finds it: the handle under the pointer, else the one whose centre is nearest within the
      // connection radius, of either kind. The line ends on it only if the connection would be made.
      const candidate = this.liveHandleAt(event) ?? this.paintedHandleAt(at.x, at.y)
        ?? closestHandle(scene.graph, this.nodesNear(p.x, p.y, CONNECTION_RADIUS + 24), p.x, p.y, CONNECTION_RADIUS, wanted, from);
      const candidateId = candidate ? scene.graph.nodes[candidate.node].id : "";
      const valid = !!candidate && candidate.type === wanted && candidate.connectableEnd
        && !(candidateId === fromId && candidate.handleId === from.handleId && candidate.type === from.type)
        && this.editing().isValidConnection(this.connection(fromId, from, candidateId, candidate));
      target = valid ? { hit: candidate, nodeId: candidateId } : null;
      // The nodes React Flow would show sockets for: their labels show, and a valid target's socket fills.
      setConnectDrag(true, target ? { nodeId: target.nodeId, handleId: target.hit.handleId || null, type: target.hit.type } : null);
      const under = scene.nodeAt(at.x, at.y);
      this.live.wantOnly("connect", [fromId, ...(under >= 0 ? [scene.graph.nodes[under].id] : []), ...(target ? [target.nodeId] : [])]);
      // React Flow's line runs between the handles' centres, in flow units inside the viewport (css px on the host).
      const tip = target ? { x: target.hit.cx, y: target.hit.cy } : p;
      const place = (x: number, y: number) => inViewport ? { x, y } : scene.toScreen(x, y);
      const a = place(from.cx, from.cy), b = place(tip.x, tip.y);
      const fromSource = from.type === "source";
      const [d] = routeEdge({
        style: "curved",
        sourceX: fromSource ? a.x : b.x, sourceY: fromSource ? a.y : b.y, sourcePosition: Position.Right,
        targetX: fromSource ? b.x : a.x, targetY: fromSource ? b.y : a.y, targetPosition: Position.Left,
      });
      path.setAttribute("d", d);
      path.setAttribute("stroke-width", inViewport ? "1" : String(scene.view.zoom));
    };
    // React Flow's autoPanOnConnect: near the canvas's edge the view pans every frame, the pointer still or not
    // (the pan redraws the line through the view listener).
    const autoPan = () => {
      const { clientWidth: width, clientHeight: height } = scene.canvas;
      const [vx, vy] = width && height ? autoPanVelocity(scene.local(last), { width, height }) : [0, 0];
      if (vx || vy) scene.setView({ x: scene.view.x + vx, y: scene.view.y + vy });
      if (!ended) panFrame = requestAnimationFrame(autoPan);
    };
    // The reconnected edge's live copy (its decorations), hidden with the scene's stroke.
    const liveEdge = () => heldEdgeId == null ? null : this.live.element?.querySelector<SVGElement>(`.react-flow__edge[data-id="${CSS.escape(heldEdgeId)}"]`) ?? null;
    // The reconnected edge stays hidden through a rebuilt graph (which shows it again, at its new index).
    const holdEdge = () => {
      const e = heldEdgeId == null ? undefined : scene.graph.edgeIndexOf.get(heldEdgeId);
      if (e != null) scene.setHeldEdge(e);
    };
    const start = (event: PointerEvent) => {
      dragging = true;
      scene.capture();
      if (heldEdgeId != null) {
        holdEdge();
        liveEdge()?.style.setProperty("visibility", "hidden");
      }
      // The pointer has left the pressed socket: its hidden connections stop ghosting back.
      this.hoveredHandle = null;
      if (useWorkflowStore.getState().hoveredHandle) useWorkflowStore.getState().setHoveredHandle(null);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", CONNECTION_LINE_STROKE);
      inViewport = this.mountInFlow(this.overlay, "viewport");
      this.overlay.style.zIndex = inViewport ? "1001" : "4";
      // React Flow draws no connection line while nodes are not connectable (a locked canvas).
      if (!this.editing().locked) this.overlay.append(path);
      document.documentElement.classList.add("canvas-interacting");
      // A wheel, pinch or auto-pan keeps the line on its socket (React Flow's line is in flow units) and finds
      // what is now under the still pointer; a rebuilt graph renumbers the nodes and connections.
      offs = [
        scene.onViewChanged(() => draw(last)),
        scene.onLayoutChanged(() => {
          holdEdge();
          draw(last);
        }),
      ];
      draw(event);
      if (!ended) panFrame = requestAnimationFrame(autoPan);
    };
    const end = () => {
      if (ended) return;
      ended = true;
      for (const off of offs) off();
      cancelAnimationFrame(panFrame);
      path.remove();
      if (heldEdgeId != null) {
        scene.setHeldEdge(-1);
        liveEdge()?.style.removeProperty("visibility");
      }
      setConnectDrag(false);
      this.live.wantOnly("connect", []);
      document.documentElement.classList.remove("canvas-interacting");
    };
    return {
      move: (event) => {
        if (ended) return;
        last = event;
        if (!dragging) {
          // React Flow's connectionDragThreshold: the line shows as soon as the pointer moves.
          if (Math.hypot(event.clientX - startX, event.clientY - startY) <= CONNECTION_DRAG_THRESHOLD) return;
          start(event);
          return;
        }
        scene.input(event);
        draw(event);
      },
      up: (event) => {
        if (ended) return;
        const wasDragging = dragging;
        if (dragging) end();
        // A press on a connection's end that did not move is a click on the connection.
        if (!wasDragging && heldEdgeId != null) {
          const e = scene.graph.edgeIndexOf.get(heldEdgeId);
          if (e != null) this.clickEdge(event, e);
          return;
        }
        const editing = this.editing();
        if (wasDragging && target) {
          const connection = this.connection(fromId, from, target.nodeId, target.hit);
          const store = useWorkflowStore.getState();
          if (!store.nodes.some((n) => n.id === connection.source) || !store.nodes.some((n) => n.id === connection.target)) return;
          const edge = heldEdgeId == null ? undefined : store.edges.find((e) => e.id === heldEdgeId);
          if (heldEdgeId == null) editing.onConnect(connection);
          else if (edge) editing.onReconnect(edge, connection);
          return;
        }
        // Released within HANDLE_CLICK_SLOP of the press, a handle's press is a click (WorkflowCanvas's handle
        // menu listener), wherever its line went: no add-node menu (handleConnectEnd's own guard).
        if (heldEdgeId == null && Math.hypot(event.clientX - startX, event.clientY - startY) <= HANDLE_CLICK_SLOP) {
          // The click reaches the node as well: it selects it, as React Flow's node click (connectOnClick is off).
          this.clickNode(fromId, event.shiftKey);
          // A click on the handle opens its menu at its centre (a live node's handle opens it through WorkflowCanvas's own listener).
          if (fromLive || !scene.graph.indexOf.has(fromId)) return;
          const p = scene.toScreen(from.cx, from.cy), box = scene.canvas.getBoundingClientRect();
          editing.onHandleClick({ nodeId: fromId, handleId, type: from.type, position: { x: box.left + p.x, y: box.top + p.y } });
          return;
        }
        // No handle: WorkflowCanvas connects to a compatible handle of the node under the pointer, or offers the
        // add-node menu (a reconnect too: the connection stays, and the new one starts from its other end).
        const fromNode = useWorkflowStore.getState().nodes.find((n) => n.id === fromId);
        if (!fromNode) return;
        // Classic finds the node by its element: its floating header is not part of it, its sockets are.
        const at = scene.local(event);
        let node = scene.nodeAt(at.x, at.y, false);
        if (node < 0) node = (this.liveHandleAt(event) ?? this.paintedHandleAt(at.x, at.y))?.node ?? -1;
        editing.onConnectEnd(event, { isValid: false, fromNode, fromHandle: { id: handleId, type: from.type } }, node >= 0 ? scene.graph.nodes[node].id : null);
      },
      cancel: end,
    };
  }

  /** The handle of a live node under the pointer, for a connection being drawn over it. */
  private liveHandleAt(event: PointerEvent): HandleHit | null {
    for (const element of document.elementsFromPoint(event.clientX, event.clientY)) {
      if (!(element instanceof HTMLElement) || !element.classList.contains("react-flow__handle") || !element.closest("[data-gpu-canvas-live]")) continue;
      const hit = this.handleFromEvent({ target: element } as unknown as PointerEvent);
      if (hit) return hit;
    }
    return null;
  }

  private connection(fromId: string, from: HandleHit, toId: string, to: HandleHit): Connection {
    const [source, target] = from.type === "source" ? [{ id: fromId, hit: from }, { id: toId, hit: to }] : [{ id: toId, hit: to }, { id: fromId, hit: from }];
    return { source: source.id, sourceHandle: source.hit.handleId || null, target: target.id, targetHandle: target.hit.handleId || null };
  }

  // ── Hover, double-click and context menus ─────────────────────────────

  /** The scene's onIdleMove: the cursor, and the handle under the pointer (hidden connections ghost back). */
  idleMove = (event: PointerEvent) => {
    const scene = this.scene, at = scene.local(event);
    const handle = this.editing().disabled ? null : this.paintedHandleAt(at.x, at.y);
    const key = handle ? `${handle.node}:${handle.type}:${handle.handleId}` : null;
    if (key !== this.hoveredHandle) {
      const hadOne = this.hoveredHandle !== null;
      this.hoveredHandle = key;
      const store = useWorkflowStore.getState();
      if (handle) store.setHoveredHandle({ nodeId: scene.graph.nodes[handle.node].id, handleId: handle.handleId || null, type: handle.type });
      else if (hadOne) store.setHoveredHandle(null);
    }
    const node = handle ? -1 : scene.nodeAt(at.x, at.y);
    // A connection's end shows React Flow's move cursor where a press would reconnect it.
    const end = handle || node >= 0 || this.editing().disabled || this.editing().locked ? null : this.edgeEndAt(at.x, at.y);
    const edge = handle || node >= 0 ? -1 : end?.edge ?? scene.edgeAt(at.x, at.y);
    // The connection holding keyboard focus looks hovered while the pointer is on no other.
    const focused = this.keyboard.edgeId == null ? undefined : scene.graph.edgeIndexOf.get(this.keyboard.edgeId);
    scene.setHoveredEdge(edge >= 0 ? edge : focused ?? -1);
    scene.canvas.style.cursor = handle ? "crosshair" : node >= 0 ? "grab" : end ? "move" : edge >= 0 ? "pointer" : "";
  };

  /** The scene's onContextMenu: the add-node menu on empty canvas, the connection menu on a connection. */
  contextMenu = (event: MouseEvent) => {
    const editing = this.editing();
    if (editing.disabled) return;
    const scene = this.scene, at = scene.local(event);
    // A node, its header band or a painted handle is not the pane: the browser's own menu shows.
    if (scene.nodeAt(at.x, at.y) >= 0 || this.paintedHandleAt(at.x, at.y)) return;
    // A connection's reconnect anchors are part of it.
    const e = this.edgeEndAt(at.x, at.y)?.edge ?? scene.edgeAt(at.x, at.y);
    const edge = e >= 0 ? useWorkflowStore.getState().edges.find((candidate) => candidate.id === scene.graph.edges[e].id) : undefined;
    // The right button pans in "middleMouse" mode (React Flow's panOnDrag [2] swallows the menu).
    if (editing.navigation.panMode === "middleMouse" && !editing.tutorial) {
      event.preventDefault();
      return;
    }
    if (edge) {
      editing.onEdgeContextMenu(event, edge);
      return;
    }
    event.preventDefault();
    editing.onPaneMenu(event.clientX, event.clientY);
  };

  /** A double-click on empty canvas (at a flow point) opens the add-node menu; on a connection or a handle it does nothing. */
  paneDoubleClick = (x: number, y: number, screen: { x: number; y: number }) => {
    if (this.editing().disabled) return;
    const at = this.scene.toScreen(x, y);
    if (this.scene.edgeAt(at.x, at.y) >= 0 || this.edgeEndAt(at.x, at.y) || this.paintedHandleAt(at.x, at.y)) return;
    this.editing().onPaneMenu(screen.x, screen.y);
  };
}
