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
      };
      api.ready = true;
      setStatus("");
    })().catch(error => {
      api.error = error instanceof Error ? error.message : String(error);
      setStatus(`Failed: ${api.error}`);
    });
    setPerfOverlayVisible(new URLSearchParams(location.search).get("overlay") !== "off");
    return () => { cancelled = true; scene?.dispose(); };
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
