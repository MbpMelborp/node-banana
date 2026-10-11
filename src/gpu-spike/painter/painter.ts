// GPU canvas spike (throwaway): painter A. Paints real node components into
// the atlas with HTML-in-Canvas, nearest the view first, and keeps them up to
// date as the workflow store changes.
//
// A batch: render a sheet of real nodes (PainterSheet), wait for React Flow to
// measure them and their images to decode, pack them by their measured size,
// paint the sheet into a staging texture in one call, then copy each node's
// rectangle into its atlas slots: full size for nodes in or near the view, and
// 1/8 for every node.
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
const GAP = 16;

type Tier = "full" | "eighth";
interface NodeState { full?: Slot; eighth?: Slot; height?: number; data?: unknown }
interface Request { node: number; tier: Tier; queuedAt: number; urgent: boolean }

const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

export interface PainterStatus {
  running: boolean;
  queued: number;
  paintedFull: number;
  paintedEighth: number;
  batches: number;
  /** ms from start until every node in the starting view had a full-size image. */
  screenfulMs: number | null;
  /** ms from start until every node had at least its 1/8 image. */
  allMs: number | null;
  atlasFull: boolean;
  atlasUsedPct: number;
  /** Node data changes seen in the store (painting real nodes makes some: they derive data on mount). */
  storeWrites: number;
}

export class Painter {
  private sheet: PainterSheet;
  private atlas: PaintedAtlas;
  private staging = new THREE.Texture();
  private stagingGl: WebGLTexture;
  private state: NodeState[];
  private queue: Request[] = [];
  private queued = new Map<string, Request>();
  private running = false;
  private startedAt = 0;
  private screenful = new Set<number>();
  private dpr = devicePixelRatio;
  private unsubscribe: () => void;
  private waiters = new Map<number, (() => void)[]>();
  readonly status: PainterStatus = { running: false, queued: 0, paintedFull: 0, paintedEighth: 0, batches: 0, screenfulMs: null, allMs: null, atlasFull: false, atlasUsedPct: 0, storeWrites: 0 };

  constructor(private scene: Scene, private graph: SceneGraph, private canvas: HTMLCanvasElement, private api: SpikeApi) {
    enableLayoutSubtree(canvas);
    this.sheet = new PainterSheet(canvas, SHEET_W, SHEET_H);
    this.atlas = new PaintedAtlas(ATLAS_SIZE, ATLAS_LAYERS);
    scene.setPaintedAtlas(this.atlas.target.texture);
    this.state = graph.nodes.map(() => ({}));
    // The staging texture is ours; three only binds it.
    const gl = scene.renderer.getContext() as WebGL2RenderingContext;
    this.stagingGl = gl.createTexture()!;
    const props = scene.renderer.properties.get(this.staging) as { __webglTexture?: WebGLTexture; __webglInit?: boolean };
    props.__webglTexture = this.stagingGl;
    props.__webglInit = true;
    scene.onViewChanged = () => this.chooseTiers();
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
        if (i == null) continue;
        this.request(i, this.inView(i, 0.5) ? "full" : "eighth", true);
      }
    });
  }

  /** Paints the view first at full size, then every node at 1/8. */
  start() {
    this.startedAt = performance.now();
    const visible = this.graph.nodes.map((_, i) => i).filter(i => this.inView(i, 0));
    this.screenful = new Set(visible);
    for (const i of this.byDistance(visible)) this.request(i, "full");
    for (const i of this.byDistance(this.graph.nodes.map((_, i) => i))) this.request(i, "eighth");
    void this.run();
  }

  /** Paints a node at full size now (ahead of the queue) and resolves once the scene shows it. */
  paintNow(i: number): Promise<void> {
    if (!this.startedAt) this.startedAt = performance.now();
    const done = new Promise<void>(resolve => (this.waiters.get(i) ?? this.waiters.set(i, []).get(i)!).push(resolve));
    this.request(i, "full", true);
    return done;
  }

  private request(node: number, tier: Tier, urgent = false) {
    const key = `${node}:${tier}`;
    const existing = this.queued.get(key);
    if (existing) { if (urgent && !existing.urgent) { existing.urgent = true; existing.queuedAt = performance.now(); } return; }
    const request = { node, tier, queuedAt: performance.now(), urgent };
    this.queued.set(key, request);
    if (urgent) this.queue.unshift(request); else this.queue.push(request);
    this.status.queued = this.queued.size;
    if (this.startedAt && !this.running) void this.run();
  }

  private inView(i: number, margin: number) {
    const n = this.graph.nodes[i], { view } = this.scene;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const a = this.scene.toScreen(n.x, n.y);
    return a.x + n.w * view.zoom >= -w * margin && a.x <= w * (1 + margin) && a.y + n.h * view.zoom >= -h * margin && a.y <= h * (1 + margin);
  }

  private byDistance(nodes: number[]) {
    const c = this.scene.toWorld(this.canvas.clientWidth / 2, this.canvas.clientHeight / 2);
    const d = (i: number) => { const n = this.graph.nodes[i]; return Math.hypot(n.x + n.w / 2 - c.x, n.y + n.h / 2 - c.y); };
    return [...nodes].sort((a, b) => d(a) - d(b));
  }

  private async run() {
    if (this.running) return;
    this.running = this.status.running = true;
    try {
      while (this.queue.length) {
        while (this.scene.interacting || performance.now() - this.scene.lastInputAt < QUIET_MS) await nextFrame();
        await this.batch();
        await nextFrame();
      }
    } finally {
      this.running = this.status.running = false;
    }
  }

  /** Takes requests that fit on one sheet (by estimated size), urgent ones first. */
  private take(): Request[] {
    const taken: Request[] = [];
    let x = 0, y = 0, row = 0;
    const seen = new Set<number>();
    for (let k = 0; k < this.queue.length;) {
      const request = this.queue[k];
      if (seen.has(request.node)) { k++; continue; }
      const n = this.graph.nodes[request.node];
      const w = n.w + PAD * 2, h = (this.state[request.node].height ?? n.h * 1.4) + HEADER + PAD;
      if (x + w > SHEET_W) { x = 0; y += row + GAP; row = 0; }
      if (y + h > SHEET_H) break;
      x += w + GAP; row = Math.max(row, h);
      seen.add(request.node);
      taken.push(request);
      this.queue.splice(k, 1);
      this.queued.delete(`${request.node}:${request.tier}`);
    }
    // A node wanted at full size is painted once for both tiers.
    for (const request of [...this.queue]) {
      if (!seen.has(request.node)) continue;
      if (request.tier === "full") { const mine = taken.find(r => r.node === request.node)!; mine.tier = "full"; mine.urgent ||= request.urgent; }
      this.queue.splice(this.queue.indexOf(request), 1);
      this.queued.delete(`${request.node}:${request.tier}`);
    }
    this.status.queued = this.queued.size;
    return taken;
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
    const requests = this.take();
    if (!requests.length) return;
    // First pass at estimated sizes, to measure.
    const estimate = this.pack(requests.map(r => r.node), i => this.state[i].height ?? this.graph.nodes[i].h * 1.4);
    await this.sheet.render(this.sheetNodes(requests, i => estimate.get(i)!));
    const t1 = performance.now();
    const { decodeMs } = await this.sheet.settle(requests.map(r => this.graph.nodes[r.node].id));
    const t2 = performance.now();
    for (const { node: i } of requests) {
      const element = this.sheet.nodeElement(this.graph.nodes[i].id);
      if (element) this.state[i].height = element.offsetHeight;
    }
    // Second pass at measured sizes; nodes that no longer fit wait for the next sheet.
    const placed = this.pack(requests.map(r => r.node), i => this.state[i].height!);
    const fits = requests.filter(r => placed.has(r.node));
    for (const r of requests) if (!placed.has(r.node)) this.request(r.node, r.tier, r.urgent);
    const moved = fits.some(r => { const a = estimate.get(r.node)!, b = placed.get(r.node)!; return a.x !== b.x || a.y !== b.y; });
    if (moved || fits.length !== requests.length) {
      await this.sheet.render(this.sheetNodes(fits, i => placed.get(i)!));
      await nextFrame();
    }
    const t3 = performance.now();

    // Paint the sheet into the staging texture.
    const renderer = this.scene.renderer;
    const gl = renderer.getContext() as WebGL2RenderingContext;
    gl.bindTexture(gl.TEXTURE_2D, this.stagingGl);
    paintElement(gl, this.sheet.element);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.generateMipmap(gl.TEXTURE_2D);
    renderer.resetState();
    const t4 = performance.now();

    // Copy each node into its slots.
    // The texture is the sheet's css size times the canvas's backing scale.
    const scale = this.canvas.width / this.canvas.clientWidth;
    const staging = { width: SHEET_W * scale, height: SHEET_H * scale };
    const items: BlitItem[] = [];
    for (const r of fits) {
      const i = r.node, p = placed.get(i)!, s = this.state[i], n = this.graph.nodes[i];
      const w = n.w + PAD * 2, h = s.height! + HEADER + PAD;
      const src = { x: p.x * scale, y: p.y * scale, w: w * scale, h: h * scale };
      const tiers: [Tier, number][] = r.tier === "full" ? [["full", scale], ["eighth", 1 / 8]] : [["eighth", 1 / 8]];
      for (const [tier, k] of tiers) {
        let slot = s[tier];
        const sw = Math.ceil(w * k), sh = Math.ceil(h * k);
        if (!slot || slot.w !== sw || slot.h !== sh) {
          const fresh = this.atlas.allocate(sw, sh);
          if (!fresh) { this.status.atlasFull = true; continue; }
          if (!slot) this.status[tier === "full" ? "paintedFull" : "paintedEighth"]++;
          slot = s[tier] = fresh;
        }
        items.push({ src, dst: slot });
      }
    }
    this.atlas.blit(renderer, this.staging, staging, items);
    renderer.resetState();
    for (const r of fits) this.show(r.node);
    const t5 = performance.now();
    for (const r of fits) {
      if (!this.state[r.node].full) continue;
      const waiting = this.waiters.get(r.node);
      this.waiters.delete(r.node);
      if (waiting) void nextFrame().then(() => { for (const resolve of waiting) resolve(); });
    }

    this.status.batches++;
    this.status.atlasUsedPct = Math.round(this.atlas.usedPixels / (ATLAS_SIZE * ATLAS_SIZE * ATLAS_LAYERS) * 1000) / 10;
    recordTiming(this.api, "painter.nodesPerBatch", fits.length);
    recordTiming(this.api, "painter.renderMs", t1 - t0);
    recordTiming(this.api, "painter.settleMs", t2 - t1 - decodeMs);
    recordTiming(this.api, "painter.decodeMs", decodeMs);
    recordTiming(this.api, "painter.repackMs", t3 - t2);
    recordTiming(this.api, "painter.paintMs", t4 - t3);
    recordTiming(this.api, "painter.blitMs", t5 - t4);
    recordTiming(this.api, "painter.batchMs", t5 - t0);
    const now = performance.now();
    for (const r of fits) if (r.urgent) {
      // Shown on the next frame the scene draws.
      void nextFrame().then(() => recordTiming(this.api, "painter.changeToShownMs", performance.now() - r.queuedAt));
    }
    if (this.status.screenfulMs == null && [...this.screenful].every(i => this.state[i].full)) this.status.screenfulMs = Math.round(now - this.startedAt);
    if (this.status.allMs == null && this.state.every(s => s.eighth || s.full)) this.status.allMs = Math.round(now - this.startedAt);
  }

  /** Shelf-packs nodes onto the sheet by width and the given height; nodes that do not fit are left out. */
  private pack(nodes: number[], height: (i: number) => number) {
    const out = new Map<number, { x: number; y: number }>();
    let x = 0, y = 0, row = 0;
    for (const i of nodes) {
      const w = this.graph.nodes[i].w + PAD * 2, h = height(i) + HEADER + PAD;
      if (x + w > SHEET_W) { x = 0; y += row + GAP; row = 0; }
      if (y + h > SHEET_H) continue;
      out.set(i, { x, y });
      x += w + GAP; row = Math.max(row, h);
    }
    return out;
  }

  /** Which tier the view wants: full size from a quarter zoom (device pixels) up. */
  private wantsFull() { return this.scene.view.zoom * this.dpr >= 0.25; }
  private lastWantsFull = true;

  private show(i: number) {
    const s = this.state[i];
    const slot = (this.wantsFull() ? s.full ?? s.eighth : s.eighth ?? s.full);
    if (!slot || s.height == null) return;
    const n = this.graph.nodes[i];
    this.scene.setPainted(i, { x: -PAD, y: -HEADER, w: n.w + PAD * 2, h: s.height + HEADER + PAD, layer: slot.layer, ...this.atlas.uv(slot) }, s.height);
  }

  private chooseTiers() {
    const full = this.wantsFull();
    if (full === this.lastWantsFull) return;
    this.lastWantsFull = full;
    for (let i = 0; i < this.state.length; i++) if (this.state[i].full && this.state[i].eighth) this.show(i);
  }

  dispose() {
    this.unsubscribe();
    this.sheet.dispose();
  }
}
