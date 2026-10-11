// GPU canvas spike (throwaway, never merged). The spike's datasets: the stress
// workflow tiled the way the earlier perf runs tiled it, with a photo on every
// image, generate and output node.
//
// Media is given by `mediaFor`, so the same tiling serves the scene (media by
// URL: 5,000 nodes of base64 would not fit in one string) and the store
// benchmark (by URL, and inline data URLs).
import type { WorkflowFile } from "@/store/workflowStore";

/** Copies of the 303-node stress workflow: 17 is about 5,100 nodes, 34 about 10,300. */
export const SPIKE_SIZES = { "5k": 17, "10k": 34 } as const;
export type SpikeSize = keyof typeof SPIKE_SIZES;

/** Copies are laid out in rows of this many. */
const COLUMNS = 4;
/** Space between copies, in flow units. */
const GAP = 800;

export interface TileOptions {
  copies: number;
  /** The media string for the nth media node (a URL or a data URL). */
  mediaFor: (index: number) => string;
}

/**
 * Tiles `base` `copies` times. Ids, edge ends, groups and a split grid's
 * references get a `~<copy>` suffix so every copy is independent.
 */
export function tileWorkflow(base: WorkflowFile, { copies, mediaFor }: TileOptions): WorkflowFile {
  let maxX = 0, maxY = 0;
  for (const node of base.nodes) {
    const width = Number(node.style?.width ?? node.width ?? 300);
    maxX = Math.max(maxX, node.position.x + width);
    maxY = Math.max(maxY, node.position.y + 600);
  }
  for (const group of Object.values(base.groups ?? {})) {
    maxX = Math.max(maxX, group.position.x + group.size.width);
    maxY = Math.max(maxY, group.position.y + group.size.height);
  }
  const stepX = maxX + GAP, stepY = maxY + GAP;

  const nodes: WorkflowFile["nodes"] = [];
  const edges: WorkflowFile["edges"] = [];
  const groups: NonNullable<WorkflowFile["groups"]> = {};
  let media = 0;
  for (let copy = 0; copy < copies; copy++) {
    const suffix = `~${copy}`;
    const dx = (copy % COLUMNS) * stepX, dy = Math.floor(copy / COLUMNS) * stepY;
    const imageOf = new Map<string, string>();
    for (const node of base.nodes) {
      const data = structuredClone(node.data) as Record<string, unknown>;
      if (node.type === "imageInput") {
        data.image = mediaFor(media++);
        data.filename = `reference-${media}.jpg`;
        imageOf.set(node.id, data.image as string);
      } else if (node.type === "nanoBanana") {
        data.outputImage = mediaFor(media++);
        data.status = "complete";
        imageOf.set(node.id, data.outputImage as string);
      }
      if (typeof data.groupId === "string") data.groupId += suffix;
      nodes.push({
        ...node,
        id: node.id + suffix,
        position: { x: node.position.x + dx, y: node.position.y + dy },
        ...(node.groupId ? { groupId: node.groupId + suffix } : {}),
        data,
      } as WorkflowFile["nodes"][number]);
    }
    for (const edge of base.edges) {
      edges.push({ ...edge, id: edge.id + suffix, source: edge.source + suffix, target: edge.target + suffix, data: edge.data ? structuredClone(edge.data) : edge.data });
    }
    for (const [id, group] of Object.entries(base.groups ?? {})) {
      groups[id + suffix] = { ...group, id: id + suffix, name: `${group.name} (${copy + 1})`, position: { x: group.position.x + dx, y: group.position.y + dy } };
    }
    // Output nodes show what feeds them; one with no image upstream gets its own.
    const firstImageEdgeTo = new Map<string, string>();
    for (const edge of base.edges) {
      if (!firstImageEdgeTo.has(edge.target) && imageOf.has(edge.source)) firstImageEdgeTo.set(edge.target, edge.source);
    }
    for (const node of nodes.slice(nodes.length - base.nodes.length)) {
      if (node.type !== "output") continue;
      const baseId = node.id.slice(0, -suffix.length);
      const source = firstImageEdgeTo.get(baseId);
      Object.assign(node.data, { image: source ? imageOf.get(source)! : mediaFor(media++), contentType: "image" });
    }
  }
  return { ...base, id: `gpu-spike-${copies}`, name: `GPU spike: ${copies} copies`, nodes, edges, groups };
}

/** The sample photos, by URL, from the spike's media route (`/api/gpu-spike/media`). */
export function sampleMediaUrls(names: string[], { width = 1024 }: { width?: number } = {}): (index: number) => string {
  return index => `/api/gpu-spike/media/${encodeURIComponent(names[index % names.length])}?w=${width}`;
}
