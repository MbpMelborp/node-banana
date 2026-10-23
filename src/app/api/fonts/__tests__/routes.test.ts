// @vitest-environment node
/**
 * The /api/fonts routes: the asset routes' guard, statuses and bodies, the
 * raw-body upload's limits, and the bytes streamed back. The fonts module is
 * mocked; its errors stay real.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/edits/fontServer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edits/fontServer")>();
  return { ...actual, listFonts: vi.fn(), addFont: vi.fn(), openFont: vi.fn() };
});
vi.mock("@/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { crossSite, ctx, page, unvouch, vouch } from "@/app/api/assets/__tests__/support";
import { LibraryError } from "@/lib/assets/server";
import { pausedError } from "@/lib/assets/server/errors";
import type { FontFileInfo } from "@/lib/edits/fontFiles";
import * as fonts from "@/lib/edits/fontServer";
import * as one from "../[name]/route";
import * as root from "../route";

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

const ROUTES: { path: string; module: Record<string, unknown>; params: Record<string, string> }[] = [
  { path: "/api/fonts", module: root, params: {} },
  { path: "/api/fonts/Georgia.ttf", module: one, params: { name: "Georgia.ttf" } },
];
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const TTF = Buffer.from([0, 1, 0, 0, 0, 10, 0, 128]);
const FONT: FontFileInfo = { name: "Georgia.ttf", format: "ttf", bytes: TTF.length, modifiedAt: 1 };

const mocked = () => [fonts.listFonts, fonts.addFont, fonts.openFont].map((fn) => vi.mocked(fn));

beforeEach(vouch);
afterEach(() => {
  unvouch();
  vi.resetAllMocks();
});

describe("every /api/fonts route", () => {
  it.each(ROUTES)("$path runs on Node and is never statically cached", ({ module }) => {
    expect(module.runtime).toBe("nodejs");
    expect(module.dynamic).toBe("force-dynamic");
  });

  it.each(ROUTES)("$path refuses another website, and a request the server did not vouch for", async ({ path, module, params }) => {
    const handlers = METHODS.filter((method) => typeof module[method] === "function");
    expect(handlers.length).toBeGreaterThan(0);
    for (const method of handlers) {
      const response = await (module[method] as Handler)(crossSite(path, method), ctx(params));
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(await response.json()).toMatchObject({ code: "forbidden" });
    }
    unvouch();
    for (const method of handlers) {
      const response = await (module[method] as Handler)(page(path, { method }), ctx(params));
      expect(response.status, `unvouched ${method} ${path}`).toBe(403);
    }
    for (const fn of mocked()) expect(fn).not.toHaveBeenCalled();
  });
});

describe("GET /api/fonts", () => {
  it("lists, uncached", async () => {
    vi.mocked(fonts.listFonts).mockResolvedValue({ fonts: [FONT], folder: "/Lib/Fonts" });
    const response = await root.GET(page("/api/fonts"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ fonts: [FONT], folder: "/Lib/Fonts" });
  });

  it("answers 503 without a library", async () => {
    vi.mocked(fonts.listFonts).mockRejectedValue(new LibraryError("No library here", 503, "unavailable"));
    const response = await root.GET(page("/api/fonts"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "unavailable" });
  });
});

describe("POST /api/fonts", () => {
  const post = (body: BodyInit, name: string | null = "Georgia.ttf", headers: Record<string, string> = {}) =>
    page(`/api/fonts${name === null ? "" : `?name=${encodeURIComponent(name)}`}`, { method: "POST", body, headers });

  it("adds with 201, passing the name and the bytes on whatever their type claims", async () => {
    vi.mocked(fonts.addFont).mockResolvedValue({ font: FONT, created: true });
    const response = await root.POST(post(TTF, "My Fonts/Georgia.ttf", { "content-type": "application/x-font-ttf" }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ font: FONT });
    const [name, bytes] = vi.mocked(fonts.addFont).mock.calls[0];
    expect(name).toBe("My Fonts/Georgia.ttf");
    expect(Buffer.from(bytes)).toEqual(TTF);
  });

  it("answers 200 when the file was already there", async () => {
    vi.mocked(fonts.addFont).mockResolvedValue({ font: FONT, created: false });
    expect((await root.POST(post(TTF))).status).toBe(200);
  });

  it("answers 400 with no name or no body, and 413 over 32 MB, before adding anything", async () => {
    expect((await root.POST(post(TTF, null))).status).toBe(400);
    expect((await root.POST(post(new Uint8Array(0)))).status).toBe(400);
    const declared = await root.POST(post(TTF, "Georgia.ttf", { "content-length": String(32 * 1024 * 1024 + 1) }));
    expect(declared.status).toBe(413);
    const large = await root.POST(post(Buffer.alloc(32 * 1024 * 1024 + 1)));
    expect(large.status).toBe(413);
    expect(await large.json()).toMatchObject({ code: "too_large" });
    expect(fonts.addFont).not.toHaveBeenCalled();
  });

  it("passes the module's refusals on", async () => {
    vi.mocked(fonts.addFont).mockRejectedValue(
      new LibraryError("Font collections (.ttc) can't be used: add a single .ttf or .otf.", 415, "unsupported_media_type"),
    );
    const response = await root.POST(post(TTF));
    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({
      error: "Font collections (.ttc) can't be used: add a single .ttf or .otf.",
      code: "unsupported_media_type",
    });
  });

  it("asks to retry while the library is moving", async () => {
    vi.mocked(fonts.addFont).mockRejectedValue(pausedError());
    const response = await root.POST(post(TTF));
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("5");
  });
});

describe("GET /api/fonts/[name]", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nb-font-route-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it.each(["../x.ttf", "a/b.ttf", "a\\b.ttf", ".hidden.ttf", "x.exe", "100%.ttf", "100%25.ttf", "folder", ""])("refuses %j", async (name) => {
    expect((await one.GET(page("/api/fonts/x"), ctx({ name }))).status).toBe(400);
    expect(fonts.openFont).not.toHaveBeenCalled();
  });

  it("answers 404 for a file that is not there", async () => {
    vi.mocked(fonts.openFont).mockResolvedValue(null);
    const response = await one.GET(page("/api/fonts/Georgia.ttf"), ctx({ name: "Georgia.ttf" }));
    expect(response.status).toBe(404);
    expect(fonts.openFont).toHaveBeenCalledWith("Georgia.ttf");
  });

  it("streams the bytes as a font, revalidated by ETag, with ranges", async () => {
    const file = path.join(dir, "Space Grotesk.ttf");
    fs.writeFileSync(file, TTF);
    vi.mocked(fonts.openFont).mockResolvedValue({ path: file, mime: "font/ttf", bytes: TTF.length, sha256: "8-1", filename: "Space Grotesk.ttf" });
    const response = await one.GET(page("/api/fonts/Space%20Grotesk.ttf"), ctx({ name: "Space%20Grotesk.ttf" }));
    expect(fonts.openFont).toHaveBeenCalledWith("Space Grotesk.ttf");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("font/ttf");
    expect(response.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(response.headers.get("ETag")).toBe('"8-1"');
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(TTF);

    const again = await one.GET(page("/api/fonts/Space%20Grotesk.ttf", { headers: { "if-none-match": '"8-1"' } }), ctx({ name: "Space Grotesk.ttf" }));
    expect(again.status).toBe(304);
    const part = await one.GET(page("/api/fonts/Space%20Grotesk.ttf", { headers: { range: "bytes=4-" } }), ctx({ name: "Space Grotesk.ttf" }));
    expect(part.status).toBe(206);
    expect(Buffer.from(await part.arrayBuffer())).toEqual(TTF.subarray(4));
  });
});
