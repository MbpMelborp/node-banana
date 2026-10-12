// GPU canvas spike (throwaway): painter A. Paints real node components into
// the atlas with HTML-in-Canvas, nearest the view first, and keeps them up to
// date as the workflow store changes.
//
// Images come in tiers by scale (device pixels per flow unit): 1/8 for every
// node, kept for good, and 1/4, 1/2 and up to the device pixel ratio for nodes
// near the view, in cells that are evicted when the atlas runs out. A node is
// drawn with the smallest tier it holds that is as sharp as its size on
// screen needs.
//
// A batch is one tier: render a sheet of real nodes (PainterSheet) at that
// tier's zoom, wait for React Flow to measure them and their images to decode,
// pack them by their measured size, paint the sheet into a staging texture in
// one call, then copy each node's rectangle into its atlas slot.
import * as THREE from "three";
import type { Node } from "@xyflow/react";
import { useWorkflowStore } from "@/store/workflowStore";
import type { WorkflowNode } from "@/types";
import type { Scene } from "../scene/Scene";
import type { SceneGraph } from "../scene/graph";
import { recordTiming, type SpikeApi } from "../instrumentation";
import { PaintedAtlas, type BlitItem, type Slot } from "./atlas";
import { enableLayoutSubtree, paintElement } from "./htmlInCanvas";
import { HEADER, PAD, PainterSheet } from "./PainterSheet";

const SHEET_W = 2048, SHEET_H = 1536;
const ATLAS_SIZE = 2048, ATLAS_LAYERS = 16;
/** No batch starts until the pointer and wheel have been still this long. */
const QUIET_MS = 120;
/** Space between nodes on the sheet, in css px. */
const GAP_PX = 4;
/** The view's tiers are chosen this long after it stops moving. */
const VIEW_SETTLE_MS = 80;
/** Nodes this far outside the view (in screens) are painted ahead and kept from eviction. */
const MARGIN = 0.25;
const EIGHTH = 0.125;
const DEFAULT_BATCH = 48;

/** Priority: a change or paintNow, the view's tier, the background 1/8 pass. */
const URGENT = 0, VIEW = 1, BACKGROUND = 2;
interface Request { node: number; tier: number; queuedAt: number; priority: number; seq: number }
interface NodeState { slots: Map<number, Slot>; height?: number; shown?: Slot; lastSeen: number }

const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

export interface PainterStatus {
  running: boolean;
  queued: number;
  /** Images held, by tier. */
  held: Record<string, number>;
  /** Cells given up to make room. */
  evicted: number;
  /** Images squeezed into a cell smaller than the node. */
  oversize: number;
  batches: number;
  /** ms from start until every node in the starting view was as sharp as the view needs. */
  screenfulMs: number | null;
  /** ms from start until every node had at least its 1/8 image. */
  allMs: number | null;
  /** A larger tier could not be placed even after eviction (everything held is in view). */
  atlasFull: boolean;
  /** Atlas layers in use, of the whole. */
  atlasUsedPct: number;
  layers: ReturnType<PaintedAtlas["layersInUse"]>;
  /** Node data changes seen in the store (painting real nodes makes some: they derive data on mount). */
  storeWrites: number;
}

export class Painter {
  private sheet: PainterSheet;
  private atlas: PaintedAtlas;
  private staging = new THREE.Texture();
  private stagingGl: WebGLTexture;
  private state: NodeState[];
  private queued = new Map<string, Request>();
  private seq = 0;
  private running = false;
  private startedAt = 0;
  private screenful = new Set<number>();
  /** The canvas's backing scale (device pixels per css px). */
  private scale: number;
  readonly tiers: number[];
  /** Nodes in the view (with its margin) at the last refresh. */
  private near = new Set<number>();
  private viewTimer = 0;
  /** Nodes per sheet at most (?batch= overrides). */
  private maxBatch = Number(new URLSearchParams(location.search).get("batch")) || DEFAULT_BATCH;
  private unsubscribe: () => void;
  private waiters = new Map<number, (() => void)[]>();
  readonly status: PainterStatus = { running: false, queued: 0, held: {}, evicted: 0, oversize: 0, batches: 0, screenfulMs: null, allMs: null, atlasFull: false, atlasUsedPct: 0,
    layers: { shelf: 0, byTier: {}, total: ATLAS_LAYERS }, storeWrites: 0 };

  constructor(private scene: Scene, private graph: SceneGraph, private canvas: HTMLCanvasElement, private api: SpikeApi) {
    enableLayoutSubtree(canvas);
    this.scale = canvas.width / canvas.clientWidth || devicePixelRatio;
    this.tiers = [...[EIGHTH, 0.25, 0.5, 1, 2].filter(t => t < this.scale - 0.01), this.scale];
    this.sheet = new PainterSheet(canvas, SHEET_W, SHEET_H);
    this.atlas = new PaintedAtlas(ATLAS_SIZE, ATLAS_LAYERS);
    scene.setPaintedAtlas(this.atlas.target.texture);
    this.state = graph.nodes.map(() => ({ slots: new Map(), lastSeen: 0 }));
    // The staging texture is ours; three only binds it.
    const gl = scene.renderer.getContext() as WebGL2RenderingContext;
    this.stagingGl = gl.createTexture()!;
    const props = scene.renderer.properties.get(this.staging) as { __webglTexture?: WebGLTexture; __webglInit?: boolean };
    props.__webglTexture = this.stagingGl;
    props.__webglInit = true;
    scene.onViewChanged = () => {
      clearTimeout(this.viewTimer);
      if (this.startedAt) this.viewTimer = window.setTimeout(() => this.refreshView(), VIEW_SETTLE_MS);
    };
    // Store changes: repaint the nodes whose data changed.
    this.unsubscribe = useWorkflowStore.subscribe((next, previous) => {
      if (next.nodes === previous.nodes) return;
      const before = new Map(previous.nodes.map(node => [node.id, node.data]));
      for (const node of next.nodes) {
        if (before.get(node.id) === node.data) continue;
        // Which fields changed, for finding writes that painting itself causes.
        const old = before.get(node.id) as Record<string, unknown> | undefined;
        const keys = Object.keys(node.data).filter(key => old?.[key] !== (node.data as Record<string, unknown>)[key]);
        const log = (window as unknown as { __spikeChanges?: unknown[] }).__spikeChanges ??= [];
        if (log.length < 500) log.push({ id: node.id, type: node.type, keys, at: Math.round(performance.now()) });
        this.status.storeWrites++;
        const i = graph.indexOf.get(node.id);
        if (i != null) this.changed(i);
      }
    });
  }

  /** Paints the view at the tier it needs, then every node at 1/8. */
  start() {
    this.startedAt = performance.now();
    this.screenful = new Set(this.visible(0));
    this.refreshView();
    for (const i of this.byDistance(this.graph.nodes.map((_, i) => i))) this.request(i, EIGHTH, BACKGROUND);
    void this.run();
  }

  /** Paints a node at the view's tier now (ahead of the queue) and resolves once the scene shows it. */
  paintNow(i: number): Promise<void> {
    if (!this.startedAt) this.startedAt = performance.now();
    const done = new Promise<void>(resolve => (this.waiters.get(i) ?? this.waiters.set(i, []).get(i)!).push(resolve));
    this.request(i, this.wanted(), URGENT);
    return done;
  }

  /** The smallest tier as sharp as the view's zoom needs. */
  private wanted() {
    const need = this.scene.view.zoom * this.scale;
    return this.tiers.find(t => t >= need - 1e-6) ?? this.tiers[this.tiers.length - 1];
  }

  /** How many visible nodes are drawn as sharp as the view needs. */
  sharpness() {
    const tier = this.wanted();
    const visible = this.visible(0);
    let sharp = 0;
    for (const i of visible) if ((this.state[i].shown?.tier ?? 0) >= tier) sharp++;
    return { visible: visible.length, sharp, tier };
  }

  /** A node's data changed: its images are stale. Repaint what the view shows and the 1/8, and drop the rest. */
  private changed(i: number) {
    const s = this.state[i], tier = this.wanted();
    for (const [t, slot] of s.slots) if (t !== tier && t !== EIGHTH) { this.atlas.release(slot); s.slots.delete(t); }
    if (this.near.has(i) && tier !== EIGHTH) this.request(i, tier, URGENT);
    this.request(i, EIGHTH, URGENT);
    this.show(i);
  }

  private request(node: number, tier: number, priority: number) {
    const key = `${node}:${tier}`;
    const existing = this.queued.get(key);
    if (existing) { if (priority < existing.priority) { existing.priority = priority; existing.queuedAt = performance.now(); } return; }
    this.queued.set(key, { node, tier, queuedAt: performance.now(), priority, seq: this.seq++ });
    this.status.queued = this.queued.size;
    if (this.startedAt && !this.running) void this.run();
  }

  private inView(i: number, margin: number) {
    const n = this.graph.nodes[i], { view } = this.scene;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const a = this.scene.toScreen(n.x, n.y);
    return a.x + n.w * view.zoom >= -w * margin && a.x <= w * (1 + margin) && a.y + n.h * view.zoom >= -h * margin && a.y <= h * (1 + margin);
  }

  private visible(margin: number) {
    const out: number[] = [];
    for (let i = 0; i < this.graph.nodes.length; i++) if (this.inView(i, margin)) out.push(i);
    return out;
  }

  private byDistance(nodes: number[]) {
    const c = this.scene.toWorld(this.canvas.clientWidth / 2, this.canvas.clientHeight / 2);
    const d = (i: number) => { const n = this.graph.nodes[i]; return Math.hypot(n.x + n.w / 2 - c.x, n.y + n.h / 2 - c.y); };
    return [...nodes].sort((a, b) => d(a) - d(b));
  }

  /** The view settled: drop requests it no longer needs, ask for its tier, and show each node's best image. */
  private refreshView() {
    const tier = this.wanted(), now = performance.now();
    this.near = new Set(this.visible(MARGIN));
    for (const i of this.near) this.state[i].lastSeen = now;
    for (const [key, r] of this.queued) if (r.priority === VIEW && (r.tier !== tier || !this.near.has(r.node))) this.queued.delete(key);
    for (const i of this.byDistance([...this.near])) if (!this.state[i].slots.has(tier)) this.request(i, tier, VIEW);
    for (let i = 0; i < this.state.length; i++) this.show(i);
    this.status.queued = this.queued.size;
  }

  private async run() {
    if (this.running) return;
    this.running = this.status.running = true;
    try {
      while (this.queued.size) {
        while (this.scene.interacting || performance.now() - this.scene.lastInputAt < QUIET_MS) await nextFrame();
        await this.batch();
        await nextFrame();
      }
    } finally {
      this.running = this.status.running = false;
    }
  }

  /** Takes the first request's tier, and as many of that tier as fit on one sheet (by estimated size). */
  private take(): { tier: number; requests: Request[] } {
    const queue = [...this.queued.values()].sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    const tier = queue[0].tier, zoom = tier / this.scale;
    const width = SHEET_W / zoom, height = SHEET_H / zoom, gap = GAP_PX / zoom;
    const requests: Request[] = [];
    let x = 0, y = 0, row = 0;
    for (const request of queue) {
      if (request.tier !== tier) continue;
      if (requests.length >= this.maxBatch) break;
      const n = this.graph.nodes[request.node];
      const w = n.w + PAD * 2, h = (this.state[request.node].height ?? n.h * 1.4) + HEADER + PAD;
      if (x + w > width) { x = 0; y += row + gap; row = 0; }
      if (y + h > height) break;
      x += w + gap; row = Math.max(row, h);
      requests.push(request);
      this.queued.delete(`${request.node}:${tier}`);
    }
    this.status.queued = this.queued.size;
    return { tier, requests };
  }

  private sheetNodes(requests: Request[], place: (i: number) => { x: number; y: number }): Node[] {
    const store = useWorkflowStore.getState();
    const byId = new Map<string, WorkflowNode>(store.nodes.map(node => [node.id, node]));
    return requests.map(({ node: i }) => {
      const n = this.graph.nodes[i], source = byId.get(n.id);
      const p = place(i);
      return { id: n.id, type: n.type, position: { x: p.x + PAD, y: p.y + HEADER }, data: (source?.data ?? {}) as Record<string, unknown>,
        style: { width: n.w }, width: n.w } as Node;
    });
  }

  private async batch() {
    const t0 = performance.now();
    const { tier, requests } = this.take();
    if (!requests.length) return;
    const zoom = tier / this.scale;
    // First pass at estimated sizes, to measure.
    const estimate = this.pack(requests.map(r => r.node), zoom, i => this.state[i].height ?? this.graph.nodes[i].h * 1.4);
    await this.sheet.render(this.sheetNodes(requests, i => estimate.get(i)!), zoom);
    const t1 = performance.now();
    const { decodeMs } = await this.sheet.settle(requests.map(r => this.graph.nodes[r.node].id));
    const t2 = performance.now();
    for (const { node: i } of requests) {
      const element = this.sheet.nodeElement(this.graph.nodes[i].id);
      if (element) this.state[i].height = element.offsetHeight;
    }
    // Second pass at measured sizes; nodes that no longer fit wait for the next sheet.
    const placed = this.pack(requests.map(r => r.node), zoom, i => this.state[i].height!);
    const fits = requests.filter(r => placed.has(r.node));
    for (const r of requests) if (!placed.has(r.node)) this.request(r.node, r.tier, r.priority);
    const moved = fits.some(r => { const a = estimate.get(r.node)!, b = placed.get(r.node)!; return a.x !== b.x || a.y !== b.y; });
    if (moved || fits.length !== requests.length) {
      await this.sheet.render(this.sheetNodes(fits, i => placed.get(i)!), zoom);
      await nextFrame();
    }
    const t3 = performance.now();

    // Paint the sheet into the staging texture.
    const renderer = this.scene.renderer;
    const gl = renderer.getContext() as WebGL2RenderingContext;
    gl.bindTexture(gl.TEXTURE_2D, this.stagingGl);
    paintElement(gl, this.sheet.element);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    renderer.resetState();
    const t4 = performance.now();

    // Copy each node into its slot. The texture is the sheet's css size times
    // the canvas's backing scale; a flow unit on the sheet is `tier` texels.
    const staging = { width: SHEET_W * this.scale, height: SHEET_H * this.scale };
    const items: BlitItem[] = [], done: number[] = [];
    for (const r of fits) {
      const i = r.node, p = placed.get(i)!, s = this.state[i], n = this.graph.nodes[i];
      const w = n.w + PAD * 2, h = s.height! + HEADER + PAD;
      const src = { x: p.x * tier, y: p.y * tier, w: w * tier, h: h * tier };
      const sw = Math.ceil(w * tier), sh = Math.ceil(h * tier);
      let slot = s.slots.get(tier);
      if (!slot || slot.w !== sw || slot.h !== sh) {
        if (slot) { this.atlas.release(slot); s.slots.delete(tier); }
        const fresh = this.allocate(i, tier, sw, sh);
        if (!fresh) continue;
        if (fresh.w < sw || fresh.h < sh) this.status.oversize++;
        slot = fresh;
        s.slots.set(tier, slot);
      }
      items.push({ src, dst: slot });
      done.push(i);
    }
    this.atlas.blit(renderer, this.staging, staging, items);
    renderer.resetState();
    for (const i of done) this.show(i, true);
    const t5 = performance.now();
    for (const i of done) {
      const waiting = this.waiters.get(i);
      this.waiters.delete(i);
      if (waiting) void nextFrame().then(() => { for (const resolve of waiting) resolve(); });
    }

    this.status.batches++;
    this.count();
    recordTiming(this.api, "painter.nodesPerBatch", fits.length);
    recordTiming(this.api, `painter.nodesPerBatch@${tier}`, fits.length);
    recordTiming(this.api, "painter.renderMs", t1 - t0);
    recordTiming(this.api, "painter.settleMs", t2 - t1 - decodeMs);
    recordTiming(this.api, "painter.decodeMs", decodeMs);
    recordTiming(this.api, "painter.repackMs", t3 - t2);
    recordTiming(this.api, "painter.paintMs", t4 - t3);
    recordTiming(this.api, "painter.blitMs", t5 - t4);
    recordTiming(this.api, "painter.batchMs", t5 - t0);
    const now = performance.now();
    for (const r of fits) if (r.priority === URGENT) {
      // Shown on the next frame the scene draws.
      void nextFrame().then(() => recordTiming(this.api, "painter.changeToShownMs", performance.now() - r.queuedAt));
    }
    if (this.status.screenfulMs == null && this.screenful.size && [...this.screenful].every(i => this.state[i].slots.size && (this.state[i].shown?.tier ?? 0) >= this.wanted()))
      this.status.screenfulMs = Math.round(now - this.startedAt);
    if (this.status.allMs == null && this.state.every(s => s.slots.has(EIGHTH))) this.status.allMs = Math.round(now - this.startedAt);
  }

  /** A slot for a node's tier: 1/8 on a shelf for good, others in a cell, evicting the longest unseen nodes outside the view. */
  private allocate(i: number, tier: number, w: number, h: number): Slot | null {
    if (tier === EIGHTH) {
      const slot = this.atlas.allocateShelf(w, h, tier);
      if (!slot) this.status.atlasFull = true;
      return slot;
    }
    let slot = this.atlas.allocateCell(tier, w, h, i);
    if (slot) return slot;
    // Same tier first (frees a cell at once), then other tiers until a layer comes free.
    const victims = (t: number) => this.atlas.cellOwners(t).filter(o => !this.near.has(o)).sort((a, b) => this.state[a].lastSeen - this.state[b].lastSeen);
    const order = [...victims(tier).map(o => [o, tier]), ...this.tiers.filter(t => t !== tier && t !== EIGHTH).flatMap(t => victims(t).map(o => [o, t]))];
    for (const [o, t] of order) {
      const s = this.state[o], held = s.slots.get(t);
      if (!held) continue;
      this.atlas.release(held);
      s.slots.delete(t);
      this.status.evicted++;
      this.show(o);
      slot = this.atlas.allocateCell(tier, w, h, i);
      if (slot) return slot;
    }
    this.status.atlasFull = true;
    return null;
  }

  /** Shelf-packs nodes onto the sheet (in flow units at its zoom) by width and the given height; nodes that do not fit are left out. */
  private pack(nodes: number[], zoom: number, height: (i: number) => number) {
    const out = new Map<number, { x: number; y: number }>();
    const width = SHEET_W / zoom, bottom = SHEET_H / zoom, gap = GAP_PX / zoom;
    let x = 0, y = 0, row = 0;
    for (const i of nodes) {
      const w = this.graph.nodes[i].w + PAD * 2, h = height(i) + HEADER + PAD;
      if (x + w > width) { x = 0; y += row + gap; row = 0; }
      if (y + h > bottom) continue;
      out.set(i, { x, y });
      x += w + gap; row = Math.max(row, h);
    }
    return out;
  }

  /** Draws the node with the smallest tier it holds that is sharp enough, else its sharpest. */
  private show(i: number, force = false) {
    const s = this.state[i];
    const tier = this.wanted();
    let best: Slot | undefined;
    for (const slot of s.slots.values()) {
      if (!best) { best = slot; continue; }
      const enough = slot.tier >= tier, bestEnough = best.tier >= tier;
      if (enough && (!bestEnough || slot.tier < best.tier)) best = slot;
      else if (!enough && !bestEnough && slot.tier > best.tier) best = slot;
    }
    if (best === s.shown && !force) return;
    s.shown = best;
    if (!best || s.height == null) { this.scene.setPainted(i, null); return; }
    const n = this.graph.nodes[i];
    this.scene.setPainted(i, { x: -PAD, y: -HEADER, w: n.w + PAD * 2, h: s.height + HEADER + PAD, layer: best.layer, ...this.atlas.uv(best) }, s.height);
  }

  private count() {
    const held: Record<string, number> = {};
    for (const s of this.state) for (const t of s.slots.keys()) held[t] = (held[t] ?? 0) + 1;
    this.status.held = held;
    this.status.layers = this.atlas.layersInUse();
    const inUse = this.status.layers.shelf + Object.values(this.status.layers.byTier).reduce((a, b) => a + b, 0);
    this.status.atlasUsedPct = Math.round(inUse / ATLAS_LAYERS * 1000) / 10;
  }

  dispose() {
    clearTimeout(this.viewTimer);
    this.unsubscribe();
    this.sheet.dispose();
  }
}
