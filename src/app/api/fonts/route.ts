/**
 * Font files for text layers: `<Node Banana folder>/Fonts/`.
 *
 * GET                           → FontList (503 "unavailable" with no library)
 * POST ?name=<file name>, bytes → 201 { font }; 200 { font } when a file of that name already holds these bytes
 */

import { badRequest, handle, json, readBytes } from "@/app/api/assets/_lib/http";
import { FONT_BYTE_LIMIT } from "@/lib/edits/fontFiles";
import { addFont, listFonts } from "@/lib/edits/fontServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handle(request, "fonts.list", async () => json(await listFonts()));
}

export async function POST(request: Request) {
  return handle(request, "fonts.add", async () => {
    const name = new URL(request.url).searchParams.get("name");
    if (!name) throw badRequest("Name the font file.");
    const { font, created } = await addFont(name, await readBytes(request, FONT_BYTE_LIMIT));
    return json({ font }, created ? 201 : 200);
  });
}
