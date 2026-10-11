// GPU canvas spike (throwaway): the whole graph on one WebGL2 canvas through
// three.js with our own shaders. Node images are instanced quads reading an
// atlas page, edges are instanced cubic beziers, and the dot grid, groups and
// selection outline are drawn by the same few draw calls. Pan and zoom change
// two uniforms; nothing per node runs on the CPU while the view moves.
import * as THREE from "three";
import { GridIndex, type SceneGraph } from "./graph";

/** Floats per node instance: rect (4), uv rect (4), colour (3), flags (1), painted layer (1), unused (3). */
const NODE_STRIDE = 16;
export const FLAG_SELECTED = 1, FLAG_IMAGE = 2, FLAG_HIDDEN = 4, FLAG_GROUP = 8, FLAG_PAINTED = 16;
const EDGE_SEGMENTS = 32;

export interface View { x: number; y: number; zoom: number }

export interface AtlasSlot { page: number; u0: number; v0: number; u1: number; v1: number }

/** A painted image of a node: where it sits in flow units (header and margin included) and where it is in the painted atlas. */
export interface PaintedSlot { x: number; y: number; w: number; h: number; layer: number; u0: number; v0: number; u1: number; v1: number }

const COMMON = /* glsl */ `
  uniform vec2 uViewport;   // css px
  uniform vec3 uView;       // translate x, y (css px), zoom (css px per flow unit)
  vec4 toClip(vec2 world) {
    vec2 css = world * uView.z + uView.xy;
    return vec4(css / uViewport * vec2(2.0, -2.0) + vec2(-1.0, 1.0), 0.0, 1.0);
  }
`;

const NODE_VERTEX = /* glsl */ `
  precision highp float;
  ${COMMON}
  in vec2 position;
  in vec4 iRect;
  in vec4 iUv;
  in vec3 iColor;
  in float iFlags;
  in float iLayer;
  out vec2 vLocal;
  out vec2 vSize;
  out vec4 vUv;
  out vec3 vColor;
  flat out int vFlags;
  flat out float vLayer;
  void main() {
    vFlags = int(iFlags);
    if ((vFlags & ${FLAG_HIDDEN}) != 0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    // One css pixel of margin for the outline and antialiasing.
    float pad = 2.0 / uView.z;
    vec2 local = position * (iRect.zw + 2.0 * pad) - pad;
    vLocal = local; vSize = iRect.zw; vUv = iUv; vColor = iColor; vLayer = iLayer;
    gl_Position = toClip(iRect.xy + local);
  }
`;

const NODE_FRAGMENT = /* glsl */ `
  precision highp float;
  precision highp sampler2DArray;
  uniform vec3 uView;
  uniform sampler2D uAtlas;
  uniform sampler2DArray uPainted;
  in vec2 vLocal;
  in vec2 vSize;
  in vec4 vUv;
  in vec3 vColor;
  flat in int vFlags;
  flat in float vLayer;
  out vec4 outColor;
  float box(vec2 p, vec2 half_, float r) { vec2 q = abs(p) - half_ + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
  void main() {
    float px = 1.0 / uView.z;   // flow units per css pixel
    if ((vFlags & ${FLAG_PAINTED}) != 0) {
      // The painted image already holds the node, its header and its margin.
      vec2 t = clamp(vLocal / vSize, 0.0, 1.0);
      vec4 texel = texture(uPainted, vec3(mix(vUv.xy, vUv.zw, t), vLayer));
      outColor = texel;
      return;
    }
    vec2 half_ = vSize * 0.5;
    float d = box(vLocal - half_, half_, 14.0);
    float inside = clamp(0.5 - d / px, 0.0, 1.0);
    if ((vFlags & ${FLAG_GROUP}) != 0) {
      float border = clamp(1.0 - abs(d) / px, 0.0, 1.0);
      outColor = vec4(vColor, max(inside * 0.08, border * 0.6));
      return;
    }
    vec3 color = vec3(0.11);
    // Header stripe in the node's minimap colour.
    if (vLocal.y < 6.0) color = vColor;
    if ((vFlags & ${FLAG_IMAGE}) != 0) {
      vec2 inset = vec2(10.0, 30.0);
      vec2 size = vSize - vec2(20.0, 40.0);
      vec2 t = (vLocal - inset) / size;
      if (all(greaterThanEqual(t, vec2(0.0))) && all(lessThanEqual(t, vec2(1.0)))) color = texture(uAtlas, mix(vUv.xy, vUv.zw, t)).rgb;
    } else if (vLocal.y > 34.0 && vLocal.y < vSize.y - 16.0) {
      // Text nodes: a few grey lines where the text sits.
      float line = mod(vLocal.y - 34.0, 22.0);
      if (line < 9.0 && vLocal.x > 14.0 && vLocal.x < vSize.x - 14.0 - mod(vLocal.y * 7.0, 60.0)) color = vec3(0.24);
    }
    float alpha = inside;
    if ((vFlags & ${FLAG_SELECTED}) != 0) {
      float ring = clamp(1.0 - abs(d - 1.5 * px) / (1.5 * px), 0.0, 1.0);
      color = mix(color, vec3(0.32, 0.6, 1.0), ring);
      alpha = max(alpha, ring);
    }
    outColor = vec4(color, alpha);
  }
`;

const EDGE_VERTEX = /* glsl */ `
  precision highp float;
  ${COMMON}
  in vec2 position;         // x: t along the curve, y: side (-1, 1)
  in vec4 iEnds;            // source x, y, target x, y
  out float vSide;
  vec2 bezier(vec2 a, vec2 b, vec2 c, vec2 d, float t) { float u = 1.0 - t; return u*u*u*a + 3.0*u*u*t*b + 3.0*u*t*t*c + t*t*t*d; }
  vec2 tangent(vec2 a, vec2 b, vec2 c, vec2 d, float t) { float u = 1.0 - t; return 3.0*u*u*(b-a) + 6.0*u*t*(c-b) + 3.0*t*t*(d-c); }
  void main() {
    vec2 s = iEnds.xy, e = iEnds.zw;
    float reach = max(abs(e.x - s.x) * 0.5, 60.0);
    vec2 c1 = s + vec2(reach, 0.0), c2 = e - vec2(reach, 0.0);
    vec2 p = bezier(s, c1, c2, e, position.x);
    vec2 dir = normalize(tangent(s, c1, c2, e, position.x) + 1e-5);
    // Two flow units wide, never under 1.5 css px.
    float width = max(2.0, 1.5 / uView.z);
    vSide = position.y;
    gl_Position = toClip(p + vec2(-dir.y, dir.x) * position.y * width);
  }
`;

const EDGE_FRAGMENT = /* glsl */ `
  precision highp float;
  in float vSide;
  out vec4 outColor;
  void main() { outColor = vec4(vec3(0.45), 1.0 - smoothstep(0.6, 1.0, abs(vSide))); }
`;

const GRID_VERTEX = /* glsl */ `
  precision highp float;
  in vec2 position;
  void main() { gl_Position = vec4(position, 0.0, 1.0); }
`;

const GRID_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform vec2 uViewport;
  uniform vec3 uView;
  uniform float uDpr;
  out vec4 outColor;
  void main() {
    vec2 css = vec2(gl_FragCoord.x, uViewport.y * uDpr - gl_FragCoord.y) / uDpr;
    vec2 world = (css - uView.xy) / uView.z;
    float spacing = 24.0;
    // Coarser dots when they would crowd under 8 css px apart.
    for (int i = 0; i < 6; i++) if (spacing * uView.z < 8.0) spacing *= 4.0;
    vec2 cell = mod(world + spacing * 0.5, spacing) - spacing * 0.5;
    float d = length(cell) * uView.z;
    float dot_ = 1.0 - smoothstep(0.6, 1.4, d);
    outColor = vec4(vec3(0.06) + dot_ * 0.12, 1.0);
  }
`;

const EMPTY_ARRAY = (() => {
  const texture = new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1);
  texture.needsUpdate = true;
  return texture;
})();

function material(vertexShader: string, fragmentShader: string, uniforms: Record<string, THREE.IUniform>, transparent = true) {
  // Flow space has y down, so quads wind the other way on screen: no culling.
  return new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader, fragmentShader, uniforms, transparent, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
}

export interface SceneOptions {
  canvas: HTMLCanvasElement;
  graph: SceneGraph;
  /** The atlas pages (stand-ins until a painter fills them) and each node's slot. */
  atlas: THREE.Texture[];
  slotOf: (node: number) => AtlasSlot | null;
  onFrame?: (now: number, jsMs: number) => void;
  onSelection?: (selected: Set<number>) => void;
  onHover?: (node: number) => void;
  onViewChange?: (view: View) => void;
}

export class Scene {
  readonly renderer: THREE.WebGLRenderer;
  readonly view: View = { x: 0, y: 0, zoom: 1 };
  readonly selected = new Set<number>();
  hovered = -1;
  /** When the pointer or wheel last moved the view or a node (performance.now()). */
  lastInputAt = 0;
  onViewChanged?: () => void;
  /** A pan or drag is under way. */
  get interacting() { return this.gesture !== null; }
  private scene = new THREE.Scene();
  private camera = new THREE.Camera();
  private uniforms = { uViewport: { value: new THREE.Vector2() }, uView: { value: new THREE.Vector3() }, uDpr: { value: 1 } };
  private nodeData: Float32Array;
  private nodeAttr!: THREE.InstancedInterleavedBuffer;
  private nodeUniforms!: Record<string, THREE.IUniform>;
  private painted = new Map<number, PaintedSlot>();
  private edgeEnds: Float32Array;
  private edgeAttr: THREE.InstancedBufferAttribute;
  private index: GridIndex;
  private dirty = true;
  private frameHandle = 0;
  private disposed = false;
  private gesture: { kind: "pan" | "drag"; x: number; y: number; moved: number[] } | null = null;

  constructor(readonly options: SceneOptions) {
    const { canvas, graph, atlas } = options;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(devicePixelRatio);
    this.renderer.autoClear = false;
    this.index = new GridIndex(graph.nodes);

    const grid = new THREE.BufferGeometry();
    grid.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 3, -1, -1, 3], 2));
    this.add(new THREE.Mesh(grid, material(GRID_VERTEX, GRID_FRAGMENT, this.uniforms, false)), 0);

    // Groups: the node shader with the group flag.
    if (graph.groups.length) {
      const data = new Float32Array(graph.groups.length * NODE_STRIDE);
      graph.groups.forEach((g, i) => data.set([g.x, g.y, g.w, g.h, 0, 0, 0, 0, ...g.color, FLAG_GROUP], i * NODE_STRIDE));
      this.add(this.nodeMesh(data, graph.groups.length, null).mesh, 1);
    }

    // Edges.
    const strip: number[] = [], indices: number[] = [];
    for (let i = 0; i <= EDGE_SEGMENTS; i++) {
      strip.push(i / EDGE_SEGMENTS, -1, i / EDGE_SEGMENTS, 1);
      if (i < EDGE_SEGMENTS) indices.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    }
    const edges = new THREE.InstancedBufferGeometry();
    edges.setAttribute("position", new THREE.Float32BufferAttribute(strip, 2));
    edges.setIndex(indices);
    this.edgeEnds = new Float32Array(graph.edges.length * 2);
    this.edgeAttr = new THREE.InstancedBufferAttribute(this.edgeEnds, 4);
    this.edgeAttr.setUsage(THREE.DynamicDrawUsage);
    edges.setAttribute("iEnds", this.edgeAttr);
    edges.instanceCount = graph.edges.length / 2;
    for (let e = 0; e < graph.edges.length / 2; e++) this.writeEdge(e);
    this.add(new THREE.Mesh(edges, material(EDGE_VERTEX, EDGE_FRAGMENT, this.uniforms)), 2);

    // Nodes: one instanced mesh; stand-ins read uAtlas, painted images uPainted.
    this.nodeData = new Float32Array(graph.nodes.length * NODE_STRIDE);
    graph.nodes.forEach((_, i) => this.writeNode(i));
    const { mesh, attr, uniforms } = this.nodeMesh(this.nodeData, graph.nodes.length, atlas[0] ?? null);
    this.nodeAttr = attr;
    this.nodeUniforms = uniforms;
    this.add(mesh, 3);

    this.resize();
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    addEventListener("resize", this.resize);
    this.frameHandle = requestAnimationFrame(this.tick);
  }

  private add(mesh: THREE.Mesh, order: number) {
    mesh.frustumCulled = false;
    // Positions are 2D; three cannot compute bounds from them, and nothing is culled anyway.
    mesh.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
    mesh.renderOrder = order;
    this.scene.add(mesh);
  }

  private nodeMesh(data: Float32Array, count: number, texture: THREE.Texture | null) {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
    geometry.setIndex([0, 1, 2, 1, 3, 2]);
    const attr = new THREE.InstancedInterleavedBuffer(data, NODE_STRIDE);
    attr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("iRect", new THREE.InterleavedBufferAttribute(attr, 4, 0));
    geometry.setAttribute("iUv", new THREE.InterleavedBufferAttribute(attr, 4, 4));
    geometry.setAttribute("iColor", new THREE.InterleavedBufferAttribute(attr, 3, 8));
    geometry.setAttribute("iFlags", new THREE.InterleavedBufferAttribute(attr, 1, 11));
    geometry.setAttribute("iLayer", new THREE.InterleavedBufferAttribute(attr, 1, 12));
    geometry.instanceCount = count;
    const uniforms = { ...this.uniforms, uAtlas: { value: texture }, uPainted: { value: EMPTY_ARRAY } };
    const mesh = new THREE.Mesh(geometry, material(NODE_VERTEX, NODE_FRAGMENT, uniforms));
    return { mesh, attr, uniforms };
  }

  private writeNode(i: number) {
    const node = this.options.graph.nodes[i];
    let flags = this.hidden.has(i) ? FLAG_HIDDEN : 0;
    if (this.selected.has(i)) flags |= FLAG_SELECTED;
    const painted = this.painted.get(i);
    if (painted) {
      this.nodeData.set([node.x + painted.x, node.y + painted.y, painted.w, painted.h, painted.u0, painted.v0, painted.u1, painted.v1, ...node.color, flags | FLAG_PAINTED, painted.layer], i * NODE_STRIDE);
      return;
    }
    const slot = node.media ? this.options.slotOf(i) : null;
    if (slot) flags |= FLAG_IMAGE;
    this.nodeData.set([node.x, node.y, node.w, node.h, slot?.u0 ?? 0, slot?.v0 ?? 0, slot?.u1 ?? 0, slot?.v1 ?? 0, ...node.color, flags, 0], i * NODE_STRIDE);
  }

  /** Re-uploads one node's instance data. */
  private touchNode(i: number) {
    if (!this.nodeAttr) { this.writeNode(i); return; }
    this.writeNode(i);
    this.nodeAttr.addUpdateRange(i * NODE_STRIDE, NODE_STRIDE);
    this.nodeAttr.needsUpdate = true;
    this.dirty = true;
  }

  /** The painted atlas (a texture array) the scene reads painted images from. */
  setPaintedAtlas(texture: THREE.Texture) {
    this.nodeUniforms.uPainted.value = texture;
    this.dirty = true;
  }

  /**
   * A painter's image for a node, positioned relative to the node (x, y are
   * offsets from its top-left), or null for the stand-in. Height is the
   * node's measured height, which also moves its edge ends.
   */
  setPainted(i: number, slot: PaintedSlot | null, measuredHeight?: number) {
    if (slot) this.painted.set(i, slot); else this.painted.delete(i);
    if (measuredHeight && measuredHeight !== this.options.graph.nodes[i].h) {
      this.index.remove(i);
      this.options.graph.nodes[i].h = measuredHeight;
      this.index.insert(i);
      for (const e of this.options.graph.edgesOf[i]) { this.writeEdge(e); this.edgeAttr.addUpdateRange(e * 4, 4); }
      this.edgeAttr.needsUpdate = true;
    }
    this.touchNode(i);
  }

  private writeEdge(e: number) {
    const { nodes, edges } = this.options.graph;
    const s = nodes[edges[e * 2]], t = nodes[edges[e * 2 + 1]];
    this.edgeEnds.set([s.x + s.w, s.y + s.h / 2, t.x, t.y + t.h / 2], e * 4);
  }

  /** Nodes the live layer covers are not drawn by the scene. */
  readonly hidden = new Set<number>();
  setHidden(i: number, hidden: boolean) {
    if (hidden === this.hidden.has(i)) return;
    if (hidden) this.hidden.add(i); else this.hidden.delete(i);
    this.touchNode(i);
  }

  /** A painter replaced a node's image (its slot may have moved). */
  refreshNode(i: number) { this.touchNode(i); }
  invalidate() { this.dirty = true; }

  setView(view: Partial<View>) {
    Object.assign(this.view, view);
    this.dirty = true;
    this.options.onViewChange?.(this.view);
    this.onViewChanged?.();
  }

  /** Fits every node on screen. */
  fit(padding = 40) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of this.options.graph.nodes) {
      minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + n.h);
    }
    const { clientWidth: w, clientHeight: h } = this.options.canvas;
    const zoom = Math.min((w - padding * 2) / (maxX - minX), (h - padding * 2) / (maxY - minY));
    this.setView({ zoom, x: (w - (maxX - minX) * zoom) / 2 - minX * zoom, y: (h - (maxY - minY) * zoom) / 2 - minY * zoom });
  }

  toWorld(cssX: number, cssY: number) { return { x: (cssX - this.view.x) / this.view.zoom, y: (cssY - this.view.y) / this.view.zoom }; }
  toScreen(x: number, y: number) { return { x: x * this.view.zoom + this.view.x, y: y * this.view.zoom + this.view.y }; }
  nodeAt(cssX: number, cssY: number) { const p = this.toWorld(cssX, cssY); return this.index.at(p.x, p.y); }

  select(nodes: Iterable<number>) {
    const next = new Set(nodes);
    for (const i of this.selected) if (!next.has(i)) { this.selected.delete(i); this.touchNode(i); }
    for (const i of next) if (!this.selected.has(i)) { this.selected.add(i); this.touchNode(i); }
    this.options.onSelection?.(this.selected);
  }

  private moveNodes(nodes: number[], dx: number, dy: number) {
    const { graph } = this.options;
    const touched = new Set<number>();
    for (const i of nodes) {
      graph.nodes[i].x += dx; graph.nodes[i].y += dy;
      this.touchNode(i);
      for (const e of graph.edgesOf[i]) touched.add(e);
    }
    for (const e of touched) {
      this.writeEdge(e);
      this.edgeAttr.addUpdateRange(e * 4, 4);
    }
    if (touched.size) this.edgeAttr.needsUpdate = true;
  }

  /** Pointer position in the canvas's css pixels, whatever element the event came from. */
  private local(event: MouseEvent) {
    const box = this.options.canvas.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  }

  /** Public so the live layer can hand presses on a live node's body to the scene. */
  pointerDown = (event: PointerEvent) => this.onPointerDown(event);
  wheel = (event: WheelEvent) => this.onWheel(event);

  private onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    const canvas = this.options.canvas;
    canvas.setPointerCapture(event.pointerId);
    this.lastInputAt = performance.now();
    const at = this.local(event);
    const hit = this.nodeAt(at.x, at.y);
    if (hit >= 0) {
      if (event.shiftKey) {
        const next = new Set(this.selected);
        if (next.has(hit)) next.delete(hit); else next.add(hit);
        this.select(next);
      } else if (!this.selected.has(hit)) this.select([hit]);
      const moved = [...this.selected];
      for (const i of moved) this.index.remove(i);
      this.gesture = { kind: "drag", x: event.clientX, y: event.clientY, moved };
    } else {
      this.gesture = { kind: "pan", x: event.clientX, y: event.clientY, moved: [] };
    }
  };

  private onPointerMove = (event: PointerEvent) => {
    const gesture = this.gesture;
    if (!gesture) {
      const at = this.local(event);
      const hit = this.nodeAt(at.x, at.y);
      if (hit !== this.hovered) { this.hovered = hit; this.options.onHover?.(hit); }
      return;
    }
    this.lastInputAt = performance.now();
    const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
    gesture.x = event.clientX; gesture.y = event.clientY;
    if (gesture.kind === "pan") this.setView({ x: this.view.x + dx, y: this.view.y + dy });
    else this.moveNodes(gesture.moved, dx / this.view.zoom, dy / this.view.zoom);
  };

  private onPointerUp = (event: PointerEvent) => {
    const gesture = this.gesture;
    this.gesture = null;
    if (!gesture) return;
    if (gesture.kind === "drag") for (const i of gesture.moved) this.index.insert(i);
    else if (Math.abs(event.clientX - gesture.x) < 1 && this.selected.size) this.select([]);
  };

  private onWheel = (event: WheelEvent) => {
    event.preventDefault();
    this.lastInputAt = performance.now();
    if (event.ctrlKey || event.metaKey) {
      const zoom = Math.min(4, Math.max(0.01, this.view.zoom * Math.exp(-event.deltaY * 0.0025)));
      const at = this.local(event);
      const p = this.toWorld(at.x, at.y);
      this.setView({ zoom, x: at.x - p.x * zoom, y: at.y - p.y * zoom });
    } else {
      this.setView({ x: this.view.x - event.deltaX, y: this.view.y - event.deltaY });
    }
  };

  private resize = () => {
    const canvas = this.options.canvas;
    this.renderer.setPixelRatio(devicePixelRatio);
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    this.uniforms.uViewport.value.set(canvas.clientWidth, canvas.clientHeight);
    this.uniforms.uDpr.value = devicePixelRatio;
    this.dirty = true;
  };

  private tick = (now: number) => {
    if (this.disposed) return;
    this.frameHandle = requestAnimationFrame(this.tick);
    let jsMs = 0;
    if (this.dirty) {
      const start = performance.now();
      this.dirty = false;
      this.uniforms.uView.value.set(this.view.x, this.view.y, this.view.zoom);
      this.renderer.clear();
      this.renderer.render(this.scene, this.camera);
      jsMs = performance.now() - start;
    }
    this.options.onFrame?.(now, jsMs);
  };

  /** Draw calls and triangles in the last frame. */
  info() { return { calls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles }; }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frameHandle);
    removeEventListener("resize", this.resize);
    this.renderer.dispose();
  }
}
