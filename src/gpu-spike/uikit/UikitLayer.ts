// GPU canvas spike (throwaway): question 3. uikit Generate nodes drawn live
// over the scene (one uikit root holding every node, its camera following the
// scene's view), and the same nodes painted into a texture to time uikit as a
// painter.
import * as THREE from "three";
import { Container, Text, reversePainterSortStable } from "@pmndrs/uikit";
import type { SceneGraph } from "../scene/graph";
import type { View } from "../scene/Scene";
import { add, generateNode, type GenerateNodeData } from "./generateNode";

const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

/** The flow's y runs down; three's runs up. The root's top-left is at the origin. */
function rootFor(width: number, height: number) {
  return new Container({ pixelSize: 1, anchorX: "left", anchorY: "top", sizeX: width, sizeY: height, width, height });
}

/** Sets an orthographic camera to show flow (x, y, zoom) over a width × height css px screen. */
function fitCamera(camera: THREE.OrthographicCamera, view: View, width: number, height: number) {
  camera.left = -view.x / view.zoom;
  camera.right = (width - view.x) / view.zoom;
  camera.top = view.y / view.zoom;
  camera.bottom = -(height - view.y) / view.zoom;
  camera.updateProjectionMatrix();
}

export class UikitLayer {
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(0, 1, 0, -1, 0.1, 1000);
  readonly nodes = new Map<string, Container>();
  private textures = new Map<string, THREE.Texture>();
  /** ms spent in uikit's update (layout, signals) per frame. */
  readonly updateMs: number[] = [];

  private root!: Container;

  private constructor(private graph: SceneGraph, private canvas: HTMLCanvasElement, private dataOf: (id: string) => Record<string, unknown> | undefined) {
    this.camera.position.z = 100;
  }

  /**
   * Loads each photo once and builds the nodes. uikit's Image loads a texture
   * per component when given a URL, so the nodes share textures loaded here
   * (an Image reads the photo's size when it gets its texture, so they are
   * loaded first).
   */
  static async create(graph: SceneGraph, canvas: HTMLCanvasElement, dataOf: (id: string) => Record<string, unknown> | undefined, { icons = true } = {}) {
    const layer = new UikitLayer(graph, canvas, dataOf);
    const urls = new Set(graph.nodes.map(n => dataOf(n.id)?.outputImage).filter((url): url is string => typeof url === "string"));
    const loader = new THREE.TextureLoader();
    await Promise.all([...urls].map(async url => {
      const texture = await loader.loadAsync(url);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.matrixAutoUpdate = false;
      layer.textures.set(url, texture);
    }));
    const bounds = graph.nodes.reduce((b, n) => ({ w: Math.max(b.w, n.x + n.w + 40), h: Math.max(b.h, n.y + n.h + 40) }), { w: 1, h: 1 });
    layer.root = rootFor(bounds.w, bounds.h);
    add(layer.scene, layer.root);
    for (const n of graph.nodes) {
      const node = generateNode(n.x, n.y, layer.nodeData(n.id), { icons });
      add(layer.root, node);
      layer.nodes.set(n.id, node);
    }
    return layer;
  }

  private texture(url: string | undefined) {
    return url ? this.textures.get(url) : undefined;
  }

  nodeData(id: string): GenerateNodeData {
    const data = this.dataOf(id) ?? {};
    const model = data.selectedModel as { displayName?: string } | undefined;
    return { title: model?.displayName ?? "Generate", aspectRatio: String(data.aspectRatio ?? "1:1"), resolution: String(data.resolution ?? "1K"), image: this.texture(data.outputImage as string | undefined) };
  }

  /** Hides or shows one node (for comparing it with the live React node in its place). */
  setVisible(id: string, visible: boolean) {
    this.nodes.get(id)?.setProperties({ display: visible ? "flex" : "none" });
  }

  draw(renderer: THREE.WebGLRenderer, view: View, deltaMs: number) {
    const t0 = performance.now();
    this.root.update(deltaMs);
    const t1 = performance.now();
    if (this.updateMs.length < 20000) this.updateMs.push(t1 - t0);
    fitCamera(this.camera, view, this.canvas.clientWidth, this.canvas.clientHeight);
    renderer.localClippingEnabled = true;
    renderer.setTransparentSort(reversePainterSortStable);
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
  }

  /**
   * uikit as a painter: `count` nodes laid out on a 2048 × 1536 sheet at a
   * tier's scale and rendered into a texture, `rounds` times with every
   * node's text changed between rounds. Times each step; the GPU is waited
   * for by reading back a pixel.
   */
  async paintBench(renderer: THREE.WebGLRenderer, { count = 48, tier = 1, rounds = 5 } = {}) {
    const width = 2048, height = 1536;
    const target = new THREE.WebGLRenderTarget(width, height, { depthBuffer: true });
    const scene = new THREE.Scene(), camera = new THREE.OrthographicCamera(0, 1, 0, -1, 0.1, 1000);
    camera.position.z = 100;
    const view = { x: 0, y: 22 * tier, zoom: tier };
    fitCamera(camera, view, width, height);
    const columns = Math.max(1, Math.floor(width / tier / 316));
    const sample = [...this.graph.nodes.slice(0, count)];
    const t0 = performance.now();
    const root = rootFor(width / tier, height / tier);
    const nodes = sample.map((n, k) => generateNode((k % columns) * 316, Math.floor(k / columns) * 290, this.nodeData(n.id)));
    add(root, ...nodes);
    add(scene, root);
    const buildMs = performance.now() - t0;
    const pixel = new Uint8Array(4);
    const render = () => {
      const previous = renderer.getRenderTarget();
      renderer.setRenderTarget(target);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(target, 0, 0, 1, 1, pixel);
      renderer.setRenderTarget(previous);
      renderer.setClearColor(0x0f0f0f, 1);
    };
    // The first layout, and a few frames for its geometry to settle.
    const t1 = performance.now();
    root.update(16);
    const firstLayoutMs = performance.now() - t1;
    for (let k = 0; k < 3; k++) { await nextFrame(); root.update(16); }
    const runs: { layoutMs: number; renderMs: number }[] = [];
    for (let round = 0; round < rounds; round++) {
      await nextFrame();
      const a = performance.now();
      nodes.forEach((node, k) => {
        const controls = node.children[2] as unknown as Container;
        (controls.children.find(child => (child as unknown) instanceof Text) as unknown as Text).setProperties({ text: `Model ${round}-${k}` } as never);
      });
      root.update(16);
      const b = performance.now();
      render();
      runs.push({ layoutMs: b - a, renderMs: performance.now() - b });
    }
    const out = { count: sample.length, tier, buildMs, firstLayoutMs, runs, perNodeMs: runs.reduce((s, r) => s + r.layoutMs + r.renderMs, 0) / runs.length / sample.length };
    root.dispose();
    target.dispose();
    return out;
  }

  dispose() {
    this.root.dispose();
    for (const texture of this.textures.values()) texture.dispose();
  }
}
