// GPU canvas spike (throwaway): the painted atlas. A texture array of square
// layers. The 1/8 images every node keeps are shelf-packed into layers of
// their own and never evicted; the larger tiers, kept only near the view, use
// fixed cells per tier so a cell can be freed and reused. Images are copied in
// from the painter's staging texture by drawing quads.
import * as THREE from "three";
import { atlasMemory } from "../instrumentation";

export interface Slot { layer: number; x: number; y: number; w: number; h: number; tier: number; cell?: number }

export interface BlitItem {
  /** Source rectangle in the staging texture, in its pixels. */
  src: { x: number; y: number; w: number; h: number };
  dst: Slot;
}

/** The largest painted image, in css px at 100% (node, header and margin). */
export const MAX_IMAGE = { w: 520, h: 680 };

const BLIT_VERTEX = /* glsl */ `
  precision highp float;
  in vec2 position;   // destination, in clip space of the atlas layer
  in vec2 aSrc;
  out vec2 vSrc;
  void main() { vSrc = aSrc; gl_Position = vec4(position, 0.0, 1.0); }
`;
const BLIT_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform sampler2D uStaging;
  in vec2 vSrc;
  out vec4 outColor;
  void main() { outColor = texture(uStaging, vSrc); }
`;

interface Slab { tier: number; layer: number; cols: number; cellW: number; cellH: number; free: number[]; owner: (number | undefined)[] }

export class PaintedAtlas {
  readonly target: THREE.WebGLArrayRenderTarget;
  /** What each layer holds: "shelf", a tier's slab, or nothing yet. */
  private layerUse: ("shelf" | Slab | null)[];
  private shelves: { layer: number; y: number; h: number; x: number }[] = [];
  private shelfTop = new Map<number, number>();
  private slabs: Slab[] = [];
  private blitScene = new THREE.Scene();
  private blitCamera = new THREE.Camera();
  private blitGeometry = new THREE.BufferGeometry();
  private blitMaterial: THREE.RawShaderMaterial;
  /** Pixels holding images, by tier. */
  readonly usedPixels = new Map<number, number>();

  constructor(readonly size: number, readonly layers: number) {
    this.target = new THREE.WebGLArrayRenderTarget(size, size, layers, { depthBuffer: false, stencilBuffer: false });
    const texture = this.target.texture;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    this.layerUse = new Array(layers).fill(null);
    this.blitMaterial = new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: BLIT_VERTEX, fragmentShader: BLIT_FRAGMENT,
      uniforms: { uStaging: { value: null } }, depthTest: false, depthWrite: false, transparent: false, blending: THREE.NoBlending, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(this.blitGeometry, this.blitMaterial);
    mesh.frustumCulled = false;
    this.blitGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
    this.blitScene.add(mesh);
    this.account();
  }

  private freeLayer(): number {
    return this.layerUse.indexOf(null);
  }

  /** A permanent, shelf-packed slot (the 1/8 tier), or null when no layer is left. */
  allocateShelf(w: number, h: number, tier: number): Slot | null {
    w = Math.ceil(w); h = Math.ceil(h);
    const gw = w + 2, gh = h + 2;
    for (const shelf of this.shelves) {
      if (shelf.h >= gh && shelf.h <= gh * 1.5 && shelf.x + gw <= this.size) {
        const slot = { layer: shelf.layer, x: shelf.x + 1, y: shelf.y + 1, w, h, tier };
        shelf.x += gw;
        this.use(tier, w * h);
        return slot;
      }
    }
    let layer = [...this.shelfTop].find(([, top]) => top + gh <= this.size)?.[0];
    if (layer == null) {
      layer = this.freeLayer();
      if (layer < 0) return null;
      this.layerUse[layer] = "shelf";
      this.shelfTop.set(layer, 0);
      this.account();
    }
    const y = this.shelfTop.get(layer)!;
    this.shelfTop.set(layer, y + gh);
    this.shelves.push({ layer, y, h: gh, x: gw });
    this.use(tier, w * h);
    return { layer, x: 1, y: y + 1, w, h, tier };
  }

  /** A freeable cell of a tier (its scale), or null when every layer is taken. */
  allocateCell(tier: number, w: number, h: number, owner: number): Slot | null {
    w = Math.ceil(w); h = Math.ceil(h);
    let slab = this.slabs.find(s => s.tier === tier && s.free.length);
    if (!slab) {
      const layer = this.freeLayer();
      if (layer < 0) return null;
      const cellW = Math.ceil(MAX_IMAGE.w * tier) + 2, cellH = Math.ceil(MAX_IMAGE.h * tier) + 2;
      const cols = Math.floor(this.size / cellW), rows = Math.floor(this.size / cellH);
      slab = { tier, layer, cols, cellW, cellH, free: Array.from({ length: cols * rows }, (_, k) => cols * rows - 1 - k), owner: [] };
      this.slabs.push(slab);
      this.layerUse[layer] = slab;
      this.account();
    }
    const cell = slab.free.pop()!;
    slab.owner[cell] = owner;
    this.use(tier, w * h);
    return { layer: slab.layer, x: (cell % slab.cols) * slab.cellW + 1, y: Math.floor(cell / slab.cols) * slab.cellH + 1, w: Math.min(w, slab.cellW - 2), h: Math.min(h, slab.cellH - 2), tier, cell };
  }

  release(slot: Slot) {
    if (slot.cell == null) return;
    const slab = this.layerUse[slot.layer];
    if (!slab || slab === "shelf") return;
    slab.owner[slot.cell] = undefined;
    slab.free.push(slot.cell);
    this.use(slot.tier, -slot.w * slot.h);
    // An empty slab gives its layer back.
    if (slab.free.length === slab.cols * Math.floor(this.size / slab.cellH)) {
      this.slabs.splice(this.slabs.indexOf(slab), 1);
      this.layerUse[slot.layer] = null;
      this.account();
    }
  }

  /** Every node holding a cell of this tier (for choosing what to evict). */
  cellOwners(tier: number): number[] {
    return this.slabs.filter(s => s.tier === tier).flatMap(s => s.owner.filter((o): o is number => o != null));
  }

  private use(tier: number, pixels: number) {
    this.usedPixels.set(tier, (this.usedPixels.get(tier) ?? 0) + pixels);
  }

  /** Layers in use count toward the budget; the array itself is allocated whole up front. */
  private account() {
    const inUse = this.layerUse.filter(Boolean).length;
    atlasMemory.pages = inUse;
    atlasMemory.bytes = inUse * this.size * this.size * 4;
  }

  layersInUse() {
    return { shelf: this.layerUse.filter(u => u === "shelf").length, byTier: Object.fromEntries([...new Set(this.slabs.map(s => s.tier))].map(t => [t, this.slabs.filter(s => s.tier === t).length])), total: this.layers };
  }

  /** The slot's texture coordinates (v = 0 at the top row). */
  uv(slot: Slot) {
    return { u0: slot.x / this.size, v0: slot.y / this.size, u1: (slot.x + slot.w) / this.size, v1: (slot.y + slot.h) / this.size };
  }

  /** Copies each item's source rectangle of `staging` into its slot. */
  blit(renderer: THREE.WebGLRenderer, staging: THREE.Texture, stagingSize: { width: number; height: number }, items: BlitItem[]) {
    this.blitMaterial.uniforms.uStaging.value = staging;
    const byLayer = new Map<number, BlitItem[]>();
    for (const item of items) (byLayer.get(item.dst.layer) ?? byLayer.set(item.dst.layer, []).get(item.dst.layer)!).push(item);
    const previous = renderer.getRenderTarget();
    for (const [layer, list] of byLayer) {
      const dst: number[] = [], src: number[] = [];
      for (const { src: s, dst: d } of list) {
        const x0 = d.x / this.size * 2 - 1, y0 = d.y / this.size * 2 - 1, x1 = (d.x + d.w) / this.size * 2 - 1, y1 = (d.y + d.h) / this.size * 2 - 1;
        const u0 = s.x / stagingSize.width, v0 = s.y / stagingSize.height, u1 = (s.x + s.w) / stagingSize.width, v1 = (s.y + s.h) / stagingSize.height;
        dst.push(x0, y0, x1, y0, x0, y1, x1, y0, x1, y1, x0, y1);
        src.push(u0, v0, u1, v0, u0, v1, u1, v0, u1, v1, u0, v1);
      }
      this.blitGeometry.setAttribute("position", new THREE.Float32BufferAttribute(dst, 2));
      this.blitGeometry.setAttribute("aSrc", new THREE.Float32BufferAttribute(src, 2));
      renderer.setRenderTarget(this.target, layer);
      renderer.render(this.blitScene, this.blitCamera);
    }
    renderer.setRenderTarget(previous);
  }
}
