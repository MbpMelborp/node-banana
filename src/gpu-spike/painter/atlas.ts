// GPU canvas spike (throwaway): the painted atlas. A texture array of square
// layers, filled with a shelf allocator; images are copied in from the
// painter's staging texture by drawing quads, so a smaller tier is a filtered
// downscale (the staging texture has mipmaps).
import * as THREE from "three";
import { atlasMemory } from "../instrumentation";

export interface Slot { layer: number; x: number; y: number; w: number; h: number }

export interface BlitItem {
  /** Source rectangle in the staging texture, in its pixels. */
  src: { x: number; y: number; w: number; h: number };
  dst: Slot;
}

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

export class PaintedAtlas {
  readonly target: THREE.WebGLArrayRenderTarget;
  private shelves: { layer: number; y: number; h: number; x: number }[] = [];
  private nextY: number[];
  private blitScene = new THREE.Scene();
  private blitCamera = new THREE.Camera();
  private blitGeometry = new THREE.BufferGeometry();
  private blitMaterial: THREE.RawShaderMaterial;
  usedPixels = 0;

  constructor(readonly size: number, readonly layers: number) {
    this.target = new THREE.WebGLArrayRenderTarget(size, size, layers, { depthBuffer: false, stencilBuffer: false });
    const texture = this.target.texture;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    this.nextY = new Array(layers).fill(0);
    this.blitMaterial = new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: BLIT_VERTEX, fragmentShader: BLIT_FRAGMENT,
      uniforms: { uStaging: { value: null } }, depthTest: false, depthWrite: false, transparent: false, blending: THREE.NoBlending, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(this.blitGeometry, this.blitMaterial);
    mesh.frustumCulled = false;
    this.blitGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
    this.blitScene.add(mesh);
    atlasMemory.pages = layers;
    atlasMemory.bytes = size * size * 4 * layers;
  }

  /** A slot of w×h pixels, or null when the atlas is full. One pixel of gutter keeps filtering inside it. */
  allocate(w: number, h: number): Slot | null {
    w = Math.ceil(w); h = Math.ceil(h);
    const gw = w + 2, gh = h + 2;
    if (gw > this.size || gh > this.size) return null;
    for (const shelf of this.shelves) {
      if (shelf.h >= gh && shelf.h <= gh * 1.5 && shelf.x + gw <= this.size) {
        const slot = { layer: shelf.layer, x: shelf.x + 1, y: shelf.y + 1, w, h };
        shelf.x += gw;
        this.usedPixels += w * h;
        return slot;
      }
    }
    for (let layer = 0; layer < this.layers; layer++) {
      if (this.nextY[layer] + gh <= this.size) {
        const shelf = { layer, y: this.nextY[layer], h: gh, x: gw };
        this.nextY[layer] += gh;
        this.shelves.push(shelf);
        this.usedPixels += w * h;
        return { layer, x: 1, y: shelf.y + 1, w, h };
      }
    }
    return null;
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
