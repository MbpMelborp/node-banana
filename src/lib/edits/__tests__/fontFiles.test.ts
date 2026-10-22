import { describe, expect, it } from "vitest";
import { FONT_EXTENSIONS, FONT_FILE_PATTERN, fontFileKey, isFontFileName } from "../fontFiles";

describe("font file names", () => {
  it("takes a bare name with a font extension, in any case", () => {
    for (const name of ["Inter.ttf", "Inter-Bold.OTF", "Space Grotesk.woff", "Ünïcödé (2).woff2", `${"x".repeat(200)}.ttf`]) {
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
    ];
    for (const name of refused) expect(isFontFileName(name), JSON.stringify(name)).toBe(false);
    expect(FONT_FILE_PATTERN.test("Inter.ttf")).toBe(true);
  });

  it("keys names as edit files are keyed: one Unicode form, any case", () => {
    expect(fontFileKey("Ünïcödé.TTF")).toBe(fontFileKey("U\u0308nïcödé.ttf"));
    expect(fontFileKey("Inter.TTF")).toBe("inter.ttf");
  });
});
