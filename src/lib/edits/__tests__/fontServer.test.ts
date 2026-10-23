// @vitest-environment node
import fs from "fs";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetAssetLibraryForTests } from "@/lib/assets/server";
import { tempDir } from "@/lib/assets/server/__tests__/helpers";
import { FONT_ROUTES, isFontFileName } from "../fontFiles";
import { addFont, listFonts, openFont } from "../fontServer";

let base: string;
let root: string;
let dir: string;

beforeEach(async () => {
  base = tempDir("nb-fonts-");
  root = path.join(base, "Library");
  dir = path.join(root, "Fonts");
  process.env.NODE_BANANA_ASSET_LIBRARY = root;
  await __resetAssetLibraryForTests();
});

afterEach(async () => {
  await __resetAssetLibraryForTests();
  delete process.env.NODE_BANANA_ASSET_LIBRARY;
  delete process.env.VERCEL;
  fs.rmSync(base, { recursive: true, force: true });
});

const TTF = Buffer.from([0, 1, 0, 0, 1, 2, 3, 4]);
const OTHER_TTF = Buffer.from([0, 1, 0, 0, 5, 6, 7, 8]);
const WOFF2 = Buffer.from("wOF2-font-bytes");
const files = () => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

describe("listFonts", () => {
  it("lists nothing, and writes nothing, with no Fonts folder", async () => {
    expect(await listFonts()).toEqual({ fonts: [], folder: dir });
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("lists the font files only, by name", async () => {
    fs.mkdirSync(path.join(dir, "Folder.ttf"), { recursive: true });
    fs.writeFileSync(path.join(dir, "Zilla.otf"), TTF);
    fs.writeFileSync(path.join(dir, "Inter.woff2"), WOFF2);
    for (const name of ["notes.txt", ".DS_Store", ".0f1e2d3c.tmp", "Inter.ttc", "100%.ttf"]) fs.writeFileSync(path.join(dir, name), "x");
    const listed = await listFonts();
    expect(listed.fonts.map((font) => [font.name, font.format, font.bytes])).toEqual([
      ["Inter.woff2", "woff2", WOFF2.length],
      ["Zilla.otf", "otf", TTF.length],
    ]);
    expect(listed.fonts[0].modifiedAt).toBe(Math.trunc(fs.statSync(path.join(dir, "Inter.woff2")).mtimeMs));
  });
});

describe("addFont", () => {
  it("keeps a new file, and answers the file already there for the same bytes again", async () => {
    const added = await addFont("Georgia.ttf", TTF);
    expect(added).toEqual({ created: true, font: { name: "Georgia.ttf", format: "ttf", bytes: TTF.length, modifiedAt: expect.any(Number) } });
    expect(fs.readFileSync(path.join(dir, "Georgia.ttf"))).toEqual(TTF);
    expect(await addFont("Georgia.ttf", TTF)).toEqual({ ...added, created: false });
    expect(files()).toEqual(["Georgia.ttf"]);
    expect((await listFonts()).fonts).toEqual([added.font]);
  });

  it("never replaces a file: other bytes under a taken name, in any case, get the next free name", async () => {
    await addFont("Georgia.ttf", TTF);
    expect(await addFont("georgia.TTF", OTHER_TTF)).toMatchObject({ created: true, font: { name: "georgia 2.ttf" } });
    expect(await addFont("Georgia.ttf", OTHER_TTF)).toMatchObject({ created: false, font: { name: "georgia 2.ttf" } });
    expect(await addFont("Georgia.ttf", Buffer.from([0, 1, 0, 0, 9]))).toMatchObject({ created: true, font: { name: "Georgia 3.ttf" } });
    expect(files()).toEqual(["Georgia 3.ttf", "Georgia.ttf", "georgia 2.ttf"]);
    expect(fs.readFileSync(path.join(dir, "Georgia.ttf"))).toEqual(TTF);
  });

  it("makes the name safe: its last segment, no path, no %, no hidden or device name", async () => {
    const named = async (raw: string) => (await addFont(raw, TTF)).font.name;
    expect(await named("../../evil.ttf")).toBe("evil.ttf");
    expect(await named("C:\\Fonts\\win.ttf")).toBe("win.ttf");
    expect(await named("a:b*?.ttf")).toBe("a b.ttf");
    expect(await named(".hidden.ttf")).toBe("hidden.ttf");
    expect(await named("100%.ttf")).toBe("100.ttf");
    expect(await named("con.ttf")).toBe("con project.ttf");
    expect(await named("U\u0308ber.TTF")).toBe("Über.ttf");
    expect(files()).toEqual(["100.ttf", "a b.ttf", "con project.ttf", "evil.ttf", "hidden.ttf", "win.ttf", "Über.ttf"].sort());
    expect(fs.readdirSync(base).sort()).toEqual(["Library"]);
  });

  it("shortens a long name without halving a character, so the name finds its file and a re-add never replaces it", async () => {
    const raw = `A${"🎉".repeat(40)}.ttf`;
    const added = await addFont(raw, TTF);
    const name = `A${"🎉".repeat(39)}.ttf`;
    expect(added).toMatchObject({ created: true, font: { name } });
    expect(isFontFileName(name)).toBe(true);
    expect(() => FONT_ROUTES.file(name)).not.toThrow();
    expect((await listFonts()).fonts.map((font) => font.name)).toEqual([name]);
    expect(await openFont(name)).toMatchObject({ path: path.join(dir, name), bytes: TTF.length });
    expect(await addFont(raw, OTHER_TTF)).toMatchObject({ created: true, font: { name: `A${"🎉".repeat(39)} 2.ttf` } });
    expect(fs.readFileSync(path.join(dir, name))).toEqual(TTF);
  });

  it("names the file for what its bytes are", async () => {
    expect((await addFont("Inter.otf", TTF)).font).toMatchObject({ name: "Inter.otf", format: "otf" });
    expect((await addFont("Mono.woff", TTF)).font).toMatchObject({ name: "Mono.ttf", format: "ttf" });
    expect((await addFont("Sans.ttf", WOFF2)).font).toMatchObject({ name: "Sans.woff2", format: "woff2" });
  });

  it("refuses a name without a font extension, a collection, and bytes that are no font", async () => {
    await expect(addFont("x.exe", TTF)).rejects.toMatchObject({ status: 400, message: "A font file must end in .ttf, .otf, .woff or .woff2." });
    await expect(addFont("x", TTF)).rejects.toMatchObject({ status: 400 });
    await expect(addFont(".ttf", TTF)).rejects.toMatchObject({ status: 400 });
    await expect(addFont(`${"x".repeat(1025)}.ttf`, TTF)).rejects.toMatchObject({ status: 400 });
    await expect(addFont("Fonts.ttf", Buffer.from("ttcf\0\u0001\0\0"))).rejects.toMatchObject({
      status: 415,
      code: "unsupported_media_type",
      message: "Font collections (.ttc) can't be used: add a single .ttf or .otf.",
    });
    await expect(addFont("Logo.ttf", Buffer.from("<svg/>"))).rejects.toMatchObject({ status: 415, code: "unsupported_media_type" });
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("refuses with paused while a move copies the library, and listing carries on", async () => {
    await addFont("Georgia.ttf", TTF);
    const rt = (globalThis as { __nodeBananaAssetLibrary?: { paused: boolean } }).__nodeBananaAssetLibrary!;
    rt.paused = true;
    try {
      await expect(addFont("Inter.ttf", OTHER_TTF)).rejects.toMatchObject({ status: 503, code: "paused" });
      expect((await listFonts()).fonts.map((font) => font.name)).toEqual(["Georgia.ttf"]);
    } finally {
      rt.paused = false;
    }
  });

  it("answers 503 unavailable without a library", async () => {
    process.env.VERCEL = "1";
    await expect(listFonts()).rejects.toMatchObject({ status: 503, code: "unavailable" });
    await expect(addFont("Georgia.ttf", TTF)).rejects.toMatchObject({ status: 503, code: "unavailable" });
    await expect(openFont("Georgia.ttf")).rejects.toMatchObject({ status: 503, code: "unavailable" });
  });
});

describe("openFont", () => {
  it("finds a file by its name in any case or Unicode form, ready to stream", async () => {
    fs.mkdirSync(dir, { recursive: true });
    const onDisk = "U\u0308ber Sans.WOFF2";
    fs.writeFileSync(path.join(dir, onDisk), WOFF2);
    const stat = fs.statSync(path.join(dir, onDisk));
    expect(await openFont("über sans.woff2")).toEqual({
      path: path.join(dir, onDisk),
      mime: "font/woff2",
      bytes: WOFF2.length,
      sha256: `${stat.size}-${Math.trunc(stat.mtimeMs)}`,
      filename: onDisk,
    });
  });

  it("answers null for no such file, a folder, a bad name, and serves a link to a file", async () => {
    fs.mkdirSync(path.join(dir, "Folder.ttf"), { recursive: true });
    fs.writeFileSync(path.join(base, "Elsewhere.ttf"), TTF);
    fs.symlinkSync(path.join(base, "Elsewhere.ttf"), path.join(dir, "Linked.ttf"));
    fs.symlinkSync(path.join(base), path.join(dir, "Loop.ttf"));
    expect(await openFont("Missing.ttf")).toBeNull();
    expect(await openFont("Folder.ttf")).toBeNull();
    expect(await openFont("Loop.ttf")).toBeNull();
    expect(await openFont("../Library/Fonts/Folder.ttf")).toBeNull();
    expect(await openFont("Linked.ttf")).toMatchObject({ path: path.join(dir, "Linked.ttf"), mime: "font/ttf", bytes: TTF.length });
  });
});
