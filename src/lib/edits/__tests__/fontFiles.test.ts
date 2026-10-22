import { describe, expect, it } from "vitest";
import {
  FONT_ACCEPT,
  FONT_EXTENSIONS,
  FONT_FILE_PATTERN,
  FONT_MIME,
  FONT_ROUTES,
  fontFileKey,
  fontFormatOf,
  isFontFileName,
  sniffFont,
} from "../fontFiles";

describe("font file names", () => {
  it("takes a bare name with a font extension, in any case", () => {
    for (const name of ["Inter.ttf", "Inter-Bold.OTF", "Space Grotesk.woff", "Ünïcödé (2).woff2", "Party 🎉.ttf", `${"x".repeat(200)}.ttf`]) {
      expect(isFontFileName(name), name).toBe(true);
    }
    expect(FONT_EXTENSIONS).toEqual(["ttf", "otf", "woff", "woff2"]);
  });

  it("refuses paths, hidden and odd names, other extensions and over-long names", () => {
    const refused = [
      "../Inter.ttf",
      "Fonts/Inter.ttf",
      "C:\\Fonts\\Inter.ttf",
      ".Inter.ttf",
      " Inter.ttf",
      "In\u0000ter.ttf",
      "In\nter.ttf",
      "In%2e.ttf",
      "In*ter.ttf",
      'In"ter.ttf',
      "Inter.ttc",
      "Inter.ttf.exe",
      "Inter",
      ".ttf",
      "",
      `${"x".repeat(201)}.ttf`,
      "Party \uD83C.ttf",
      "\uDF89Party.ttf",
      "Party \uDF89\uD83C.ttf",
    ];
    for (const name of refused) expect(isFontFileName(name), JSON.stringify(name)).toBe(false);
    expect(FONT_FILE_PATTERN.test("Inter.ttf")).toBe(true);
  });

  it("keys names as edit files are keyed: one Unicode form, any case", () => {
    expect(fontFileKey("Ünïcödé.TTF")).toBe(fontFileKey("U\u0308nïcödé.ttf"));
    expect(fontFileKey("Inter.TTF")).toBe("inter.ttf");
  });
});

describe("font formats", () => {
  const bytes = (head: number[] | string) =>
    new Uint8Array([...(typeof head === "string" ? [...head].map((c) => c.charCodeAt(0)) : head), 0, 9, 8, 7]);

  it("tells the format from the first bytes, whatever the name says", () => {
    expect(sniffFont(bytes([0, 1, 0, 0]))).toBe("ttf");
    expect(sniffFont(bytes("true"))).toBe("ttf");
    expect(sniffFont(bytes("OTTO"))).toBe("otf");
    expect(sniffFont(bytes("wOFF"))).toBe("woff");
    expect(sniffFont(bytes("wOF2"))).toBe("woff2");
    expect(sniffFont(bytes("ttcf"))).toBe("collection");
    expect(sniffFont(bytes("<svg"))).toBeNull();
    expect(sniffFont(new Uint8Array([0, 1, 0]))).toBeNull();
  });

  it("reads the format a name claims", () => {
    expect(fontFormatOf("Inter.TTF")).toBe("ttf");
    expect(fontFormatOf("Inter.woff2")).toBe("woff2");
    expect(fontFormatOf("Inter.ttc")).toBeNull();
    expect(fontFormatOf("Inter")).toBeNull();
  });

  it("serves each format as its font type, and names a file in its route", () => {
    expect(FONT_EXTENSIONS.map((ext) => FONT_MIME[ext])).toEqual(["font/ttf", "font/otf", "font/woff", "font/woff2"]);
    expect(FONT_ACCEPT.split(",").filter((type) => type.startsWith("."))).toEqual(FONT_EXTENSIONS.map((ext) => `.${ext}`));
    expect(FONT_ROUTES.file("Space Grotesk #2.ttf")).toBe("/api/fonts/Space%20Grotesk%20%232.ttf");
  });
});
