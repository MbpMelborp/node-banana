/**
 * GPU canvas spike (throwaway, never merged): a sample photo from
 * examples/sample-images, resized to ?w= on the long edge, as JPEG. The
 * spike's datasets reference their media by this URL, since 5,000 nodes of
 * base64 do not fit in one workflow string.
 */

import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { guardAssetRequest } from "@/lib/assets/server/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NAME = /^[a-z0-9-]+\.jpe?g$/i;
const WIDTHS = new Set([128, 256, 512, 1024, 2048]);
const cache = new Map<string, Promise<Buffer>>();

export async function GET(request: Request, { params }: { params: Promise<{ name: string }> }) {
  const refused = guardAssetRequest(request);
  if (refused) return refused;
  const { name } = await params;
  const width = Number(new URL(request.url).searchParams.get("w") ?? 1024);
  if (!NAME.test(name) || !WIDTHS.has(width)) return new Response("Not found", { status: 404 });
  const key = `${name}@${width}`;
  let jpeg = cache.get(key);
  if (!jpeg) {
    jpeg = fs.readFile(path.join(process.cwd(), "examples/sample-images", name))
      .then(file => sharp(file).resize(width, width, { fit: "inside" }).jpeg({ quality: 88 }).toBuffer());
    cache.set(key, jpeg);
    jpeg.catch(() => cache.delete(key));
  }
  try {
    const body = await jpeg;
    return new Response(new Uint8Array(body), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=31536000, immutable" } });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
