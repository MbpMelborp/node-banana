/**
 * GPU canvas spike (throwaway, never merged): the stress workflow tiled
 * ?copies= times (17 is about 5,100 nodes, 34 about 10,300), with every image,
 * generate and output node showing a sample photo by URL. ?generate=N is
 * instead N Generate nodes in a grid (question 3).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { guardAssetRequest } from "@/lib/assets/server/guard";
import { generateGrid, sampleMediaUrls, tileWorkflow } from "@/gpu-spike/dataset";
import type { WorkflowFile } from "@/store/workflowStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const refused = guardAssetRequest(request);
  if (refused) return refused;
  const query = new URL(request.url).searchParams;
  const copies = Number(query.get("copies") ?? 17);
  if (!Number.isInteger(copies) || copies < 1 || copies > 64) return new Response("copies is 1 to 64", { status: 400 });
  const generate = query.get("generate") == null ? null : Number(query.get("generate"));
  if (generate != null && (!Number.isInteger(generate) || generate < 1 || generate > 20000)) return new Response("generate is 1 to 20000", { status: 400 });
  const root = process.cwd();
  const base = JSON.parse(await fs.readFile(path.join(root, "examples/stress-workflow.json"), "utf8")) as WorkflowFile;
  const names = (await fs.readdir(path.join(root, "examples/sample-images"))).filter(name => /\.jpe?g$/i.test(name)).sort();
  if (generate != null) return Response.json(generateGrid(base, generate, sampleMediaUrls(names)));
  return Response.json(tileWorkflow(base, { copies, mediaFor: sampleMediaUrls(names) }));
}
