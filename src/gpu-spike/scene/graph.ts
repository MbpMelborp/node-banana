// GPU canvas spike (throwaway): the workflow as flat arrays the scene uploads
// to the GPU, plus a uniform grid index for finding the node under a point.
import type { WorkflowFile } from "@/store/workflowStore";
import type { NodeType } from "@/types";
import { defaultNodeDimensions } from "@/store/utils/nodeDefaults";
import { miniMapTypeColor } from "@/components/CanvasMinimap";

export interface SceneNode {
  id: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** The node's media URL, when it shows one. */
  media: string | null;
  color: [number, number, number];
}

export interface SceneGraph {
  nodes: SceneNode[];
  indexOf: Map<string, number>;
  /** Source and target node index per edge. */
  edges: Int32Array;
  /** Edge indices touching each node. */
  edgesOf: number[][];
  groups: { x: number; y: number; w: number; h: number; color: [number, number, number] }[];
}

const GROUP_COLORS: Record<string, string> = { blue: "#3b82f6", green: "#22c55e", purple: "#a855f7", orange: "#f97316", red: "#ef4444", gray: "#6b7280", yellow: "#eab308", pink: "#ec4899" };

function rgb(hex: string): [number, number, number] {
  const value = parseInt(hex.replace("#", "").slice(0, 6), 16);
  return [(value >> 16 & 255) / 255, (value >> 8 & 255) / 255, (value & 255) / 255];
}

function mediaOf(type: string, data: Record<string, unknown>): string | null {
  const value = type === "imageInput" ? data.image : type === "nanoBanana" ? data.outputImage : type === "output" ? data.image : null;
  return typeof value === "string" && value ? value : null;
}

export function buildSceneGraph(workflow: WorkflowFile): SceneGraph {
  const nodes: SceneNode[] = workflow.nodes.map(node => {
    const defaults = defaultNodeDimensions[node.type as NodeType] ?? { width: 300, height: 280 };
    const w = Number(node.width ?? node.style?.width ?? defaults.width);
    return { id: node.id, type: String(node.type), x: node.position.x, y: node.position.y, w, h: defaults.height,
      media: mediaOf(String(node.type), node.data as Record<string, unknown>), color: rgb(miniMapTypeColor(node.type)) };
  });
  const indexOf = new Map(nodes.map((node, i) => [node.id, i]));
  const pairs: number[] = [];
  const edgesOf: number[][] = nodes.map(() => []);
  for (const edge of workflow.edges) {
    const s = indexOf.get(edge.source), t = indexOf.get(edge.target);
    if (s == null || t == null) continue;
    const e = pairs.length / 2;
    pairs.push(s, t);
    edgesOf[s].push(e);
    edgesOf[t].push(e);
  }
  const groups = Object.values(workflow.groups ?? {}).map(group => ({ x: group.position.x, y: group.position.y, w: group.size.width, h: group.size.height,
    color: rgb(GROUP_COLORS[group.color as string] ?? "#6b7280") }));
  return { nodes, indexOf, edges: Int32Array.from(pairs), edgesOf, groups };
}

/** Uniform grid over node rectangles. */
export class GridIndex {
  private cells = new Map<string, number[]>();
  constructor(private nodes: SceneNode[], private cell = 512) {
    nodes.forEach((_, i) => this.insert(i));
  }
  private keys(i: number): string[] {
    const n = this.nodes[i], keys: string[] = [];
    for (let cx = Math.floor(n.x / this.cell); cx <= Math.floor((n.x + n.w) / this.cell); cx++) {
      for (let cy = Math.floor(n.y / this.cell); cy <= Math.floor((n.y + n.h) / this.cell); cy++) keys.push(`${cx},${cy}`);
    }
    return keys;
  }
  insert(i: number) {
    for (const key of this.keys(i)) (this.cells.get(key) ?? this.cells.set(key, []).get(key)!).push(i);
  }
  remove(i: number) {
    for (const key of this.keys(i)) {
      const list = this.cells.get(key);
      const at = list?.indexOf(i) ?? -1;
      if (list && at >= 0) list.splice(at, 1);
    }
  }
  /** The topmost (last drawn) node containing the point, or -1. */
  at(x: number, y: number): number {
    const list = this.cells.get(`${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`);
    let best = -1;
    for (const i of list ?? []) {
      const n = this.nodes[i];
      if (x >= n.x && x <= n.x + n.w && y >= n.y && y <= n.y + n.h && i > best) best = i;
    }
    return best;
  }
}
