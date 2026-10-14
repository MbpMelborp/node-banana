import { describe, expect, it } from "vitest";
import { getBezierPath, getSmoothStepPath, Position } from "@xyflow/react";
import type { WorkflowEdge, WorkflowNode } from "@/types";
import { defaultCanvasNavigationSettings, type CanvasNavigationSettings } from "@/types/canvas";
import { defaultEdgeAppearance } from "@/types";
import { measuredChanges, SceneGraph } from "../graph";
import { cubicAt, distanceToCubic, pathToCubics, routeSceneEdge, type RouteContext } from "../edgeRoutes";
import { autoPanVelocity, closestHandle, edgeEndAt, edgeEndHandle, handleAt, marqueeNodes, paneDragAction, selectionKeyHeld } from "../gestures";
import { cachedHandle, handleFromCache } from "../paintCache";

function node(id: string, x: number, y: number, data: Record<string, unknown> = {}, type = "prompt"): WorkflowNode {
  return { id, type, position: { x, y }, data, width: 300 } as unknown as WorkflowNode;
}

function edge(id: string, source: string, target: string, data: Record<string, unknown> = {}, sourceHandle = "text", targetHandle = "text"): WorkflowEdge {
  return { id, source, target, sourceHandle, targetHandle, data } as WorkflowEdge;
}

function context(graphEdges: WorkflowEdge[], nodes: WorkflowNode[], style: RouteContext["style"] = "curved"): RouteContext {
  return { style, appearance: defaultEdgeAppearance, edges: graphEdges, nodes, thicknessPx: 3 };
}

describe("pathToCubics", () => {
  it("reads React Flow's bezier and step paths into cubics that pass through the same points", () => {
    const [bezier] = getBezierPath({ sourceX: 0, sourceY: 0, sourcePosition: Position.Right, targetX: 300, targetY: 100, targetPosition: Position.Left });
    const curve = pathToCubics(bezier);
    expect(curve).toHaveLength(1);
    expect(curve[0][0]).toBe(0);
    expect(curve[0][6]).toBe(300);
    expect(curve[0][7]).toBe(100);

    const [step] = getSmoothStepPath({ sourceX: 0, sourceY: 0, sourcePosition: Position.Right, targetX: 300, targetY: 100, targetPosition: Position.Left, borderRadius: 8 });
    const steps = pathToCubics(step);
    expect(steps.length).toBeGreaterThan(2);
    // Consecutive segments join, and the route ends at the target.
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i][0]).toBeCloseTo(steps[i - 1][6]);
      expect(steps[i][1]).toBeCloseTo(steps[i - 1][7]);
    }
    expect(steps[steps.length - 1][6]).toBeCloseTo(300);
    expect(steps[steps.length - 1][7]).toBeCloseTo(100);
  });

  it("measures distance to a curve", () => {
    const [line] = pathToCubics("M0,0 L100,0");
    expect(cubicAt(line, 0.5)).toEqual({ x: 50, y: 0 });
    expect(distanceToCubic(line, 50, 10)).toBeCloseTo(10);
  });
});

describe("routeSceneEdge", () => {
  const nodes = [node("a", 0, 0), node("b", 600, 200)];

  it("routes a connection as the edge style says, between the measured handles", () => {
    const edges = [edge("e", "a", "b")];
    const graph = new SceneGraph(nodes, edges, {});
    graph.nodes[0].handles = new Map([["source:text", { x: 300, y: 40, position: "right" }]]);
    graph.nodes[1].handles = new Map([["target:text", { x: 0, y: 60, position: "left" }]]);
    const curved = routeSceneEdge(graph, 0, context(edges, nodes));
    expect(curved.ends).toEqual([300, 40, 600, 260]);
    expect(curved.segments).toHaveLength(1);
    expect(curved.decorated).toBe(false);
    const angular = routeSceneEdge(graph, 0, context(edges, nodes, "angular"));
    expect(angular.segments.length).toBeGreaterThan(2);
  });

  it("marks connections that show more than a line, and draws no line for a hidden one", () => {
    const edges = [edge("e", "a", "b", { label: "hero" }), edge("h", "a", "b", { hidden: true }), edge("p", "a", "b", { hasPause: true })];
    const graph = new SceneGraph(nodes, edges, {});
    expect(routeSceneEdge(graph, 0, context(edges, nodes)).decorated).toBe(true);
    const hidden = routeSceneEdge(graph, 1, context(edges, nodes));
    expect(hidden.hidden).toBe(true);
    expect(hidden.segments).toHaveLength(0);
    expect(routeSceneEdge(graph, 2, context(edges, nodes)).decorated).toBe(true);
  });

  it("draws a bundle's stem once and starts its members past it", () => {
    const fan = [node("a", 0, 0), node("b", 600, 0), node("c", 600, 400)];
    const edges = [
      edge("e1", "a", "b", { sourceBundleId: "x", createdAt: 1 }),
      edge("e2", "a", "c", { sourceBundleId: "x", createdAt: 2 }),
    ];
    const graph = new SceneGraph(fan, edges, {});
    const first = routeSceneEdge(graph, 0, context(edges, fan));
    const second = routeSceneEdge(graph, 1, context(edges, fan));
    expect(first.stems).toHaveLength(1);
    expect(second.stems).toHaveLength(0);
    // Both noodles leave from the stem's end, not the handle.
    expect(first.segments[0][0]).toBeGreaterThan(300);
    expect(second.segments[0][0]).toBe(first.segments[0][0]);
  });

  it("draws a reference link dashed and curved", () => {
    const edges = [{ ...edge("r", "a", "b"), type: "reference" } as WorkflowEdge];
    const graph = new SceneGraph(nodes, edges, {});
    const route = routeSceneEdge(graph, 0, context(edges, nodes, "angular"));
    expect(route.dashed).toBe(true);
    expect(route.width).toBe(2);
    expect(route.segments).toHaveLength(1);
  });
});

describe("SceneGraph edges", () => {
  it("updates replaced edges in place and rebuilds when one is added", () => {
    const nodes = [node("a", 0, 0), node("b", 600, 0)];
    const e1 = edge("e1", "a", "b");
    const graph = new SceneGraph(nodes, [e1], {});
    const selected = { ...e1, selected: true };
    const sync = graph.sync(nodes, [selected], {});
    expect(sync.edgesChanged).toBe(false);
    expect(sync.edgesUpdated).toEqual([0]);
    expect(graph.edges[0].edge).toBe(selected);
    const added = graph.sync(nodes, [selected, edge("e2", "b", "a")], {});
    expect(added.edgesChanged).toBe(true);
    expect(graph.edgeIndexOf.get("e2")).toBe(1);
  });
});

describe("paneDragAction", () => {
  const settings = (patch: Partial<CanvasNavigationSettings>): CanvasNavigationSettings => ({ ...defaultCanvasNavigationSettings, ...patch });
  const press = (patch: Partial<{ button: number; shiftKey: boolean; altKey: boolean; space: boolean }> = {}) => ({ button: 0, shiftKey: false, altKey: false, space: false, ...patch });

  it("follows today's canvas: off the Mac a drag pans, on the Mac it draws a marquee, Shift always draws one", () => {
    const defaults = settings({});
    expect(paneDragAction(defaults, press(), false)).toBe("pan");
    expect(paneDragAction(defaults, press(), true)).toBe("select");
    expect(paneDragAction(defaults, press({ shiftKey: true }), false)).toBe("select");
    expect(paneDragAction(defaults, press({ space: true }), true)).toBe("pan");
    expect(paneDragAction(defaults, press({ button: 1 }), false)).toBe("pan");
  });

  it("honours the pan and selection modes", () => {
    expect(paneDragAction(settings({ panMode: "always" }), press(), true)).toBe("pan");
    expect(paneDragAction(settings({ panMode: "middleMouse" }), press({ button: 2 }), true)).toBe("pan");
    expect(paneDragAction(settings({ panMode: "middleMouse" }), press(), false)).toBe(null);
    expect(paneDragAction(settings({ selectionMode: "altDrag" }), press({ altKey: true }), false)).toBe("select");
    expect(paneDragAction(settings({ selectionMode: "altDrag" }), press({ shiftKey: true }), false)).toBe("pan");
    expect(paneDragAction(settings({ selectionMode: "shiftDrag" }), press(), true)).toBe(null);
  });

  it("tells the selection key, which selects over nodes too, from selecting on drag, which starts only on the pane", () => {
    const defaults = settings({});
    expect(selectionKeyHeld(defaults, press())).toBe(false);
    expect(selectionKeyHeld(defaults, press({ shiftKey: true }))).toBe(true);
    expect(selectionKeyHeld(defaults, press({ shiftKey: true, button: 1 }))).toBe(false);
    expect(selectionKeyHeld(settings({ selectionMode: "altDrag" }), press({ shiftKey: true }))).toBe(false);
    expect(selectionKeyHeld(settings({ selectionMode: "altDrag" }), press({ altKey: true }))).toBe(true);
  });
});

describe("hit tests", () => {
  it("finds the nearest measured handle", () => {
    const graph = new SceneGraph([node("a", 100, 100)], [], {});
    graph.nodes[0].handles = new Map([["source:image", { x: 300, y: 50 }], ["target:text", { x: 0, y: 50 }]]);
    expect(handleAt(graph, [0], 402, 151, 10)).toMatchObject({ node: 0, handleId: "image", type: "source", x: 400, y: 150 });
    expect(handleAt(graph, [0], 250, 150, 10)).toBeNull();
  });

  // A schema node's Prompt row as React Flow measures it: the socket's 18×28 box 15 px out from the card,
  // and the legacy `text` socket hidden at the card's edge on the same row.
  function socketGraph() {
    const graph = new SceneGraph([node("a", 100, 100), node("b", 600, 100)], [], {});
    graph.nodes[0].handles = new Map([
      ["target:text-0", { x: -15, y: 50, position: "left", box: { x: -15, y: 36, w: 18, h: 28 }, connectableStart: true, connectableEnd: true }],
      ["target:text", { x: 0, y: 50, position: "left", box: { x: 0, y: 50, w: 0, h: 0 }, connectableStart: false, connectableEnd: false }],
    ]);
    graph.nodes[1].handles = new Map([
      ["source:text", { x: 315, y: 50, position: "right", box: { x: 297, y: 36, w: 18, h: 28 }, connectableStart: true, connectableEnd: true }],
    ]);
    return graph;
  }

  it("takes a socket where its ellipse reaches, never a hidden one", () => {
    const graph = socketGraph();
    // The hole (5.5 px out), a little inside the card, and the ellipse's far edge.
    for (const [x, y] of [[94.5, 150], [105, 150], [80, 150], [94, 166]]) {
      expect(handleAt(graph, [0], x, y, 9)).toMatchObject({ node: 0, handleId: "text-0", type: "target", x: 85, y: 150, cx: 94, cy: 150 });
    }
    expect(handleAt(graph, [0], 94, 170, 9)).toBeNull();
    expect(handleAt(graph, [0], 120, 150, 9)).toBeNull();
    // A small zoom keeps a floor round the centre.
    expect(handleAt(graph, [0], 94, 175, 30)).toMatchObject({ handleId: "text-0" });
  });

  it("finds the nearest connectable handle centre for a connection, as React Flow", () => {
    const graph = socketGraph();
    const from = handleAt(graph, [1], 909, 150, 9)!;
    expect(from).toMatchObject({ handleId: "text", type: "source", cx: 906 });
    expect(closestHandle(graph, [0, 1], 99, 150, 20, "target", from)).toMatchObject({ node: 0, handleId: "text-0" });
    expect(closestHandle(graph, [0, 1], 120, 150, 20, "target", from)).toBeNull();
    // The handle it starts from is left out.
    expect(closestHandle(graph, [1], 906, 150, 20, "target", from)).toBeNull();
    // On a tie the opposite kind wins.
    graph.nodes[0].handles!.set("source:out", { x: 0, y: 0, box: { x: -9, y: -14, w: 18, h: 28 } });
    graph.nodes[0].handles!.set("target:in", { x: 0, y: 0, box: { x: -9, y: -14, w: 18, h: 28 } });
    expect(closestHandle(graph, [0], 100, 105, 20, "target")).toMatchObject({ handleId: "in", type: "target" });
    expect(closestHandle(graph, [0], 100, 105, 20, "source")).toMatchObject({ handleId: "out", type: "source" });
  });

  it("keeps a handle's box and connectability in the disk cache", () => {
    const graph = socketGraph();
    for (const [key, anchor] of graph.nodes[0].handles!) expect(handleFromCache(cachedHandle(key, anchor))).toEqual([key, anchor]);
    expect(handleFromCache(["source:image", 1, 2, "right"])).toEqual(["source:image", { x: 1, y: 2, position: "right" }]);
  });

  it("takes a node only when the marquee holds its media card, or the whole node without one", () => {
    const graph = new SceneGraph([node("a", 0, 0), node("b", 400, 0)], [], {});
    graph.nodes[0].h = 300;
    graph.nodes[1].h = 300;
    graph.nodes[0].card = { x: 0, y: 0, w: 300, h: 200 };
    const marquee = { left: -10, top: -10, right: 1000, bottom: 250 };
    expect(marqueeNodes(graph, [0, 1], marquee)).toEqual([0]);
    expect(marqueeNodes(graph, [0, 1], { ...marquee, bottom: 400 })).toEqual([0, 1]);
  });

  it("judges a node by the card measured as it shows now over the painted one", () => {
    const graph = new SceneGraph([node("a", 0, 0), node("b", 400, 0)], [], {});
    graph.nodes[0].h = 300;
    graph.nodes[1].h = 300;
    graph.nodes[0].card = { x: 0, y: 0, w: 300, h: 280 };
    const marquee = { left: -10, top: -10, right: 1000, bottom: 250 };
    const cards = new Map([[0, { x: 0, y: 0, w: 300, h: 200 }], [1, { x: 0, y: 40, w: 300, h: 150 }]]);
    expect(marqueeNodes(graph, [0, 1], marquee)).toEqual([]);
    expect(marqueeNodes(graph, [0, 1], marquee, cards)).toEqual([0, 1]);
    // A live node without a card is taken whole.
    expect(marqueeNodes(graph, [0, 1], marquee, new Map([[0, null]]))).toEqual([]);
  });
});

describe("measuredChanges", () => {
  it("reports the scene's measured sizes the store does not know yet", () => {
    const nodes = [node("a", 0, 0), { ...node("b", 400, 0), measured: { width: 300, height: 180 } }, { ...node("c", 800, 0), measured: { width: 300, height: 100 } }] as WorkflowNode[];
    const graph = new SceneGraph(nodes, [], {});
    graph.nodes[0].h = 150;
    graph.nodes[1].h = 180.3;
    graph.nodes[2].h = 240;
    const indexOf = (id: string) => nodes.findIndex((n) => n.id === id);
    expect(measuredChanges(nodes, indexOf, graph, ["a", "b", "c", "gone"])).toEqual([
      { type: "dimensions", id: "a", dimensions: { width: 300, height: 150 }, setAttributes: false },
      { type: "dimensions", id: "c", dimensions: { width: 300, height: 240 }, setAttributes: false },
    ]);
  });
});

describe("edgeEndAt", () => {
  const nodes = [node("a", 0, 0), node("b", 600, 0)];
  const graph = () => {
    const g = new SceneGraph(nodes, [edge("ab", "a", "b")], {});
    g.nodes[0].handles = new Map([["source:text", { x: 315, y: 100, position: "right" }]]);
    g.nodes[1].handles = new Map([["target:text", { x: -15, y: 100, position: "left" }]]);
    return g;
  };

  it("finds React Flow's reconnect anchors: 10 flow units round each end, shifted 10 outward", () => {
    const g = graph();
    expect(edgeEndAt(g, [0, 1], 325, 100)).toEqual({ edge: 0, end: "source" });
    expect(edgeEndAt(g, [0, 1], 575, 108)).toEqual({ edge: 0, end: "target" });
    // Inward of the end is the handle's, not the anchor's.
    expect(edgeEndAt(g, [0, 1], 300, 100)).toBeNull();
    expect(edgeEndAt(g, [0, 1], 450, 100)).toBeNull();
  });

  it("skips connections React Flow does not render or cannot reconnect", () => {
    const g = graph();
    g.edges[0].edge = { ...g.edges[0].edge, reconnectable: false };
    expect(edgeEndAt(g, [0, 1], 325, 100)).toBeNull();
  });

  it("gives the handle at the other end to draw from", () => {
    expect(edgeEndHandle(graph(), 0, "source")).toMatchObject({ node: 0, handleId: "text", type: "source", x: 315, y: 100 });
  });
});

describe("autoPanVelocity", () => {
  it("is React Flow's calcAutoPan: nothing inside 40 px of the edges, up to 15 px a frame at them", () => {
    const size = { width: 1000, height: 800 };
    expect(autoPanVelocity({ x: 500, y: 400 }, size)).toEqual([0, 0]);
    expect(autoPanVelocity({ x: 0, y: 400 }, size)).toEqual([15, 0]);
    expect(autoPanVelocity({ x: 20, y: 790 }, size)).toEqual([7.5, -11.25]);
    expect(autoPanVelocity({ x: 1100, y: -50 }, size)).toEqual([-15, 15]);
  });
});
