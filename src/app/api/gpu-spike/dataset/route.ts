/**
 * GPU canvas spike (throwaway, never merged): the stress workflow tiled
 * ?copies= times (17 is about 5,100 nodes, 34 about 10,300), with every image,
 * generate and output node showing a sample photo by URL.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { guardAssetRequest } from "@/lib/assets/server/guard";
import { sampleMediaUrls, tileWorkflow } from "@/gpu-spike/dataset";
import type { WorkflowFile } from "@/store/workflowStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const refused = guardAssetRequest(request);
  if (refused) return refused;
  const copies = Number(new URL(request.url).searchParams.get("copies") ?? 17);
  if (!Number.isInteger(copies) || copies < 1 || copies > 64) return new Response("copies is 1 to 64", { status: 400 });
  const root = process.cwd();
  const base = JSON.parse(await fs.readFile(path.join(root, "examples/stress-workflow.json"), "utf8")) as WorkflowFile;
  const names = (await fs.readdir(path.join(root, "examples/sample-images"))).filter(name => /\.jpe?g$/i.test(name)).sort();
  return Response.json(tileWorkflow(base, { copies, mediaFor: sampleMediaUrls(names) }));
}
