"use client";

// GPU canvas spike (throwaway, never merged): the page at /gpu-spike. Loads a
// tiled dataset (?copies=17, or ?size=5k / 10k), draws it on the GPU scene
// and exposes window.__spike for scripts/gpu-spike.cjs. Nothing links here.
import { useEffect, useRef, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { PerfOverlay, setPerfOverlayVisible } from "@/components/PerfOverlay";
import type { WorkflowFile } from "@/store/workflowStore";
import { SPIKE_SIZES, type SpikeSize } from "./dataset";
import { createFrameRecorder, installSpikeApi, type SpikeApi } from "./instrumentation";
import { buildSceneGraph } from "./scene/graph";
import { buildStandInAtlas } from "./scene/standInAtlas";
import { Scene } from "./scene/Scene";
import { Painter } from "./painter/painter";
import { LiveLayer } from "./live/LiveLayer";
import { useWorkflowStore } from "@/store/workflowStore";

function copiesFromQuery(): number {
  const query = new URLSearchParams(location.search);
  const size = query.get("size") as SpikeSize | null;
  if (size && size in SPIKE_SIZES) return SPIKE_SIZES[size];
  return Number(query.get("copies") ?? SPIKE_SIZES["5k"]);
}

export function GpuSpike() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState("Loading the dataset…");

  useEffect(() => {
    const recorder = createFrameRecorder();
    const api: SpikeApi = installSpikeApi(recorder);
    let scene: Scene | undefined;
    let painter: Painter | undefined;
    let live: LiveLayer | undefined;
    let cancelled = false;
    (async () => {
      const copies = copiesFromQuery();
      const started = performance.now();
      const workflow = await (await fetch(`/api/gpu-spike/dataset?copies=${copies}`)).json() as WorkflowFile;
      const graph = buildSceneGraph(workflow);
      setStatus(`Drawing ${graph.nodes.length.toLocaleString()} stand-in images…`);
      const atlas = await buildStandInAtlas(graph);
      if (cancelled) return;
      api.dataset = { copies, nodes: graph.nodes.length, edges: graph.edges.length / 2, groups: graph.groups.length, loadMs: Math.round(performance.now() - started) };
      scene = new Scene({ canvas: canvasRef.current!, graph, atlas: atlas.pages, slotOf: atlas.slotOf, onFrame: recorder.frame });
      scene.fit();
      api.scene = {
        view: () => ({ ...scene!.view }),
        setView: (view: { x?: number; y?: number; zoom?: number }) => scene!.setView(view),
        fit: () => scene!.fit(),
        info: () => scene!.info(),
        /** Where a node is on screen (css px), by index or id. */
        nodeRect: (node: number | string) => {
          const i = typeof node === "number" ? node : graph.indexOf.get(node) ?? -1;
          const n = graph.nodes[i];
          if (!n) return null;
          const a = scene!.toScreen(n.x, n.y);
          return { index: i, id: n.id, type: n.type, x: a.x, y: a.y, width: n.w * scene!.view.zoom, height: n.h * scene!.view.zoom };
        },
        nodeAt: (x: number, y: number) => scene!.nodeAt(x, y),
        selected: () => [...scene!.selected],
        /** The node's painted rectangle (header and margin included) on screen, in css px. */
        paintRect: (id: string) => {
          const n = graph.nodes[graph.indexOf.get(id)!];
          const a = scene!.toScreen(n.x - 8, n.y - 30), z = scene!.view.zoom;
          return { x: a.x, y: a.y, width: (n.w + 16) * z, height: (n.h + 38) * z };
        },
      };
      // Painter A: on unless ?painter=off, and only where HTML-in-Canvas exists.
      if (api.htmlInCanvas.available && new URLSearchParams(location.search).get("painter") !== "off") {
        // The real nodes read the workflow store, as on the canvas.
        await useWorkflowStore.getState().loadWorkflow(workflow);
        painter = new Painter(scene, graph, canvasRef.current!, api);
        api.painter = {
          start: () => painter!.start(),
          paintNow: (id: string) => painter!.paintNow(graph.indexOf.get(id)!),
          status: () => ({ ...painter!.status }),
          /** Edits a node's data in the store, as typing elsewhere would; the repaint's latency lands in timings. */
          change: (id: string, data: Record<string, unknown>) => useWorkflowStore.getState().updateNodeData(id, data),
        };
        if (new URLSearchParams(location.search).get("paint") !== "manual") painter.start();
      }
      // The live layer: real nodes over the scene where they are being worked in.
      if (new URLSearchParams(location.search).get("live") !== "off") {
        const layer = live = new LiveLayer(canvasRef.current!.parentElement!, scene, graph, api);
        const s = scene;
        s.options.onHover = i => { if (hovered >= 0) layer.want(hovered, "hover", false); hovered = i; if (i >= 0) layer.want(i, "hover", true); };
        s.options.onSelection = selected => layer.wantOnly("selected", selected);
        let zoomTimer = 0;
        s.options.onViewChange = view => {
          layer.setView(view);
          // Above 100% every visible node is live, once the view settles.
          clearTimeout(zoomTimer);
          zoomTimer = window.setTimeout(() => {
            const visible: number[] = [];
            if (s.view.zoom > 1) {
              const w = canvasRef.current!.clientWidth, h = canvasRef.current!.clientHeight;
              graph.nodes.forEach((n, i) => { const a = s.toScreen(n.x, n.y); if (a.x + n.w * s.view.zoom > 0 && a.x < w && a.y + n.h * s.view.zoom > 0 && a.y < h) visible.push(i); });
            }
            layer.wantOnly("zoom", visible);
          }, 100);
        };
        let hovered = -1;
        api.live = {
          /** Makes nodes live for a test ("test" reason) and resolves once they are swapped in. */
          set: async (ids: string[]) => { layer.wantOnly("test", ids.map(id => graph.indexOf.get(id)!).filter(i => i != null)); await layer.settled(); return [...layer.live].map(i => graph.nodes[i].id); },
          ids: () => [...layer.live].map(i => graph.nodes[i].id),
        };
      }
      api.ready = true;
      setStatus("");
    })().catch(error => {
      api.error = error instanceof Error ? error.message : String(error);
      setStatus(`Failed: ${api.error}`);
    });
    setPerfOverlayVisible(new URLSearchParams(location.search).get("overlay") !== "off");
    return () => { cancelled = true; live?.dispose(); painter?.dispose(); scene?.dispose(); };
  }, []);

  return (
    <ReactFlowProvider>
      <div style={{ position: "fixed", inset: 0, background: "#0f0f0f" }}>
        <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block", touchAction: "none" }} />
        {status && <div style={{ position: "absolute", left: 16, top: 16, color: "#ddd", font: "13px system-ui" }}>{status}</div>}
      </div>
      <PerfOverlay />
    </ReactFlowProvider>
  );
}
