/**
 * One font file's bytes.
 *
 * GET → the file (Range, ETag), or 404 "not_found" when the Fonts folder has no such file
 */

import { REVALIDATE_CACHE, serveFile } from "@/app/api/assets/_lib/files";
import { handle, notFound, pathParam } from "@/app/api/assets/_lib/http";
import { FONT_FILE_PATTERN } from "@/lib/edits/fontFiles";
import { openFont } from "@/lib/edits/fontServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ name: string }>;
}

export async function GET(request: Request, { params }: RouteContext) {
  return handle(request, "fonts.get", async () => {
    const file = await openFont(pathParam((await params).name, FONT_FILE_PATTERN, "font file name"));
    if (!file) throw notFound("That font file is not in the Fonts folder.");
    return serveFile(request, file, { cacheControl: REVALIDATE_CACHE });
  });
}
