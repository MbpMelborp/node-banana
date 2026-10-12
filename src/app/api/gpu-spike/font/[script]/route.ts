/**
 * GPU canvas spike (throwaway, never merged): a system font for question 3's
 * uikit text review, by script (latin, cjk, arabic, emoji). uikit draws text
 * from MSDF atlases it generates from a TTF, so the review needs a font file
 * that covers each script. GPU_SPIKE_FONT_<SCRIPT> names another file; the
 * response's X-Font-Path says which one was used.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { guardAssetRequest } from "@/lib/assets/server/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CANDIDATES: Record<string, Partial<Record<NodeJS.Platform, string[]>>> = {
  latin: {
    darwin: ["/System/Library/Fonts/Supplemental/Arial.ttf"],
    win32: ["C:\\Windows\\Fonts\\segoeui.ttf", "C:\\Windows\\Fonts\\arial.ttf"],
    linux: ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"],
  },
  cjk: {
    darwin: ["/System/Library/Fonts/Supplemental/Arial Unicode.ttf", "/Library/Fonts/Arial Unicode.ttf"],
    win32: ["C:\\Windows\\Fonts\\Deng.ttf", "C:\\Windows\\Fonts\\msyh.ttc", "C:\\Windows\\Fonts\\YuGothR.ttc"],
    linux: ["/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf"],
  },
  arabic: {
    darwin: ["/System/Library/Fonts/Supplemental/Arial Unicode.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf"],
    win32: ["C:\\Windows\\Fonts\\segoeui.ttf", "C:\\Windows\\Fonts\\arial.ttf"],
    linux: ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"],
  },
  emoji: {
    darwin: ["/System/Library/Fonts/Apple Color Emoji.ttc"],
    win32: ["C:\\Windows\\Fonts\\seguiemj.ttf"],
    linux: ["/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf"],
  },
};

export async function GET(request: Request, { params }: { params: Promise<{ script: string }> }) {
  const refused = guardAssetRequest(request);
  if (refused) return refused;
  const { script } = await params;
  const candidates = CANDIDATES[script];
  if (!candidates) return new Response("Not found", { status: 404 });
  const override = process.env[`GPU_SPIKE_FONT_${script.toUpperCase()}`];
  for (const file of [...(override ? [override] : []), ...(candidates[process.platform] ?? [])]) {
    const body = await fs.readFile(file).catch(() => null);
    if (body) return new Response(new Uint8Array(body), { headers: { "Content-Type": "font/ttf", "X-Font-Path": path.basename(file) } });
  }
  return new Response(`No ${script} font found`, { status: 404 });
}
