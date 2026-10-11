// GPU canvas spike (throwaway): the stand-in atlas the scene is measured with
// before any painter exists. Each distinct media URL is drawn once into a
// 2048 px page of 256 px cells; nodes sharing a photo share its cell.
import * as THREE from "three";
import type { SceneGraph } from "./graph";
import type { AtlasSlot } from "./Scene";
import { atlasMemory } from "../instrumentation";

const PAGE = 2048, CELL = 256, PER_ROW = PAGE / CELL;

export async function buildStandInAtlas(graph: SceneGraph): Promise<{ pages: THREE.Texture[]; slotOf: (node: number) => AtlasSlot | null }> {
  const urls = [...new Set(graph.nodes.map(node => node.media).filter((url): url is string => !!url))];
  const pageCount = Math.max(1, Math.ceil(urls.length / (PER_ROW * PER_ROW)));
  const canvases = Array.from({ length: pageCount }, () => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = PAGE;
    return canvas;
  });
  const slots = new Map<string, AtlasSlot>();
  await Promise.all(urls.map(async (url, i) => {
    const page = Math.floor(i / (PER_ROW * PER_ROW)), cell = i % (PER_ROW * PER_ROW);
    const cx = (cell % PER_ROW) * CELL, cy = Math.floor(cell / PER_ROW) * CELL;
    const small = url.startsWith("/api/gpu-spike/media/") ? url.replace(/\?w=\d+/, "?w=256") : url;
    try {
      const bitmap = await createImageBitmap(await (await fetch(small)).blob());
      // Cover the cell, as the media card crops.
      const scale = Math.max(CELL / bitmap.width, CELL / bitmap.height);
      const w = bitmap.width * scale, h = bitmap.height * scale;
      canvases[page].getContext("2d")!.drawImage(bitmap, cx + (CELL - w) / 2, cy + (CELL - h) / 2, w, h);
      bitmap.close();
    } catch {
      const context = canvases[page].getContext("2d")!;
      context.fillStyle = "#333";
      context.fillRect(cx, cy, CELL, CELL);
    }
    // Half a texel in from the edge so filtering stays inside the cell.
    const inset = 0.5 / PAGE;
    slots.set(url, { page, u0: cx / PAGE + inset, v0: cy / PAGE + inset, u1: (cx + CELL) / PAGE - inset, v1: (cy + CELL) / PAGE - inset });
  }));
  const pages = canvases.map(canvas => {
    const texture = new THREE.CanvasTexture(canvas);
    texture.flipY = false;
    texture.colorSpace = THREE.NoColorSpace;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = 4;
    return texture;
  });
  atlasMemory.pages = pages.length;
  // RGBA8 with a full mip chain.
  atlasMemory.bytes = pages.length * PAGE * PAGE * 4 * 4 / 3;
  return { pages, slotOf: node => { const url = graph.nodes[node].media; return url ? slots.get(url) ?? null : null; } };
}
