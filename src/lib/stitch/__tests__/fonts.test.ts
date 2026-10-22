import { afterEach, describe, expect, it, vi } from "vitest";
import type { StitchTextOverlay } from "@/types";
import {
  addFontFile,
  appSansList,
  ensureOverlayFonts,
  familyList,
  fileFamily,
  FontFileError,
  fontGeneration,
  fontKey,
  installedFamilies,
  listFontFiles,
  localFontsPermission,
  localFontsSupported,
  onFontsChanged,
  overlayFontList,
  quoteFamily,
  SHIPPED_FONTS,
  type FontDeps,
} from "../fonts";
import { createTextOverlay } from "../overlays";

const APP = '"Space Grotesk", sans-serif';
const TTF = new Uint8Array([0, 1, 0, 0, 1, 2, 3, 4]);
const text = (id: string, init: Partial<StitchTextOverlay> = {}) => createTextOverlay({ id, ...init });
const georgia = (id: string, init: Partial<StitchTextOverlay> = {}) => text(id, { font: { family: "Georgia", file: "Georgia.ttf" }, ...init });

/** A page that can register fonts: FontFace and document.fonts stand-ins, and a Fonts folder answering `status`. */
function page({ status = 200, refuse = false }: { status?: number; refuse?: boolean } = {}) {
  const made: { family: string; source: unknown; descriptors: unknown }[] = [];
  class Face {
    constructor(
      public family: string,
      public source: unknown,
      public descriptors: unknown,
    ) {
      made.push(this);
    }
    load = vi.fn(async () => {
      if (refuse) throw new DOMException("OTS parsing error: invalid sfntVersion", "SyntaxError");
      return this;
    });
  }
  const fonts = { add: vi.fn(), check: vi.fn(() => false), load: vi.fn(async (): Promise<unknown[]> => []) };
  const fetch = vi.fn<(url: string) => Promise<Response>>(async () => new Response(status === 200 ? TTF : null, { status }));
  const deps: Partial<FontDeps> = {
    fetch: fetch as unknown as typeof globalThis.fetch,
    FontFace: Face as unknown as typeof FontFace,
    fonts: fonts as unknown as FontFaceSet,
  };
  return { made, fonts, fetch, deps };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  document.documentElement.style.removeProperty("--font-space-grotesk");
  document.documentElement.style.removeProperty("--font-jetbrains-mono");
  delete (document as { fonts?: unknown }).fonts;
  delete (navigator as { permissions?: unknown }).permissions;
  vi.unstubAllGlobals();
});

describe("family lists", () => {
  it("quotes every family but the generic keywords, escaping quotes and backslashes", () => {
    expect(quoteFamily("Font 2")).toBe('"Font 2"');
    expect(quoteFamily("3D Sans")).toBe('"3D Sans"');
    expect(quoteFamily('My "Best" \\ Font')).toBe('"My \\"Best\\" \\\\ Font"');
    for (const generic of ["sans-serif", "serif", "monospace", "system-ui"]) expect(quoteFamily(generic)).toBe(generic);
  });

  it("ends every list in the app's sans and sans-serif", () => {
    expect(appSansList()).toBe(APP);
    expect(familyList({ family: "Space Grotesk" })).toBe(APP);
    expect(familyList({ family: "JetBrains Mono" })).toBe(`"JetBrains Mono", ${APP}`);
    expect(familyList({ family: "serif" })).toBe(`serif, ${APP}`);
    expect(familyList({ family: "Inter Display" })).toBe(`"Inter Display", ${APP}`);
    expect(familyList({ family: "Georgia", file: "Georgia.ttf" })).toBe(`"${fileFamily("Georgia.ttf")}", ${APP}`);
  });

  it("reads the shipped families from next/font's variables when the page has them", () => {
    document.documentElement.style.setProperty("--font-space-grotesk", '"Space Grotesk", "Space Grotesk Fallback"');
    document.documentElement.style.setProperty("--font-jetbrains-mono", '"JetBrains Mono", "JetBrains Mono Fallback"');
    const app = '"Space Grotesk", "Space Grotesk Fallback", sans-serif';
    expect(appSansList()).toBe(app);
    expect(familyList({ family: "JetBrains Mono" })).toBe(`"JetBrains Mono", "JetBrains Mono Fallback", ${app}`);
  });

  it("registers a file under nbf- and a hash of its name, one per file in any case or Unicode form", () => {
    expect(fileFamily("Georgia.ttf")).toMatch(/^nbf-[0-9a-f]{8}$/);
    expect(fileFamily("GEORGIA.TTF")).toBe(fileFamily("Georgia.ttf"));
    expect(fileFamily("Ünïcödé.otf")).toBe(fileFamily("Ünïcödé.otf"));
    expect(fileFamily("Inter.ttf")).not.toBe(fileFamily("Georgia.ttf"));
    expect(fontKey({ family: "Georgia", file: "Georgia.TTF" })).toBe(fontKey({ family: "Other", file: "georgia.ttf" }));
    expect(fontKey({ family: "Georgia" })).not.toBe(fontKey({ family: "Georgia", file: "Georgia.ttf" }));
  });

  it("ships the app's faces at the weights it loads, and the generic families", () => {
    expect(SHIPPED_FONTS.map((font) => [font.family, font.label, font.weights])).toEqual([
      ["Space Grotesk", "Space Grotesk", [500, 600, 700]],
      ["JetBrains Mono", "JetBrains Mono", [400, 500]],
      ["sans-serif", "Sans serif", [400, 500, 600, 700]],
      ["serif", "Serif", [400, 500, 600, 700]],
      ["monospace", "Monospace", [400, 500, 600, 700]],
    ]);
  });
});

describe("ensureOverlayFonts", () => {
  it("registers a font file once under its family with a weight range, for every layer that names it", async () => {
    const { made, fonts, fetch, deps } = page();
    const listener = vi.fn();
    const off = onFontsChanged(listener);
    const before = fontGeneration();
    const resolved = await ensureOverlayFonts([georgia("a"), georgia("b", { font: { family: "Georgia", file: "GEORGIA.ttf" } })], deps);
    off();
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["/api/fonts/Georgia.ttf"]);
    expect(made.map(({ family, descriptors }) => [family, descriptors])).toEqual([[fileFamily("Georgia.ttf"), { weight: "1 1000" }]]);
    expect(new Uint8Array(made[0].source as ArrayBuffer)).toEqual(TTF);
    expect(fonts.add).toHaveBeenCalledWith(made[0]);
    expect(resolved).toEqual(new Map([[fontKey(georgia("a").font), { list: `"${fileFamily("Georgia.ttf")}", ${APP}`, state: "ready" }]]));
    expect(fontGeneration()).toBeGreaterThan(before);
    expect(listener).toHaveBeenCalled();

    await ensureOverlayFonts([georgia("c")], deps);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [404, "missing"],
    [503, "missing"],
    [500, "failed"],
  ] as const)("falls back to the app's sans for a file answered %i (%s)", async (status, state) => {
    const { fonts, deps } = page({ status });
    const resolved = await ensureOverlayFonts([georgia("a")], deps);
    expect(resolved.get(fontKey(georgia("a").font))).toEqual({ list: APP, state });
    expect(fonts.add).not.toHaveBeenCalled();
  });

  it("marks a file the browser refuses, or one it could not fetch, failed", async () => {
    const refused = page({ refuse: true });
    expect([...(await ensureOverlayFonts([georgia("a")], refused.deps)).values()]).toEqual([{ list: APP, state: "failed" }]);
    expect(refused.fonts.add).not.toHaveBeenCalled();
    const offline = page();
    offline.fetch.mockRejectedValue(new TypeError("Failed to fetch"));
    expect([...(await ensureOverlayFonts([georgia("a")], offline.deps)).values()]).toEqual([{ list: APP, state: "failed" }]);
  });

  it("falls back without fetching where the page cannot register a font", async () => {
    const { fetch, deps } = page();
    expect([...(await ensureOverlayFonts([georgia("a")], { ...deps, FontFace: undefined })).values()]).toEqual([
      { list: APP, state: "failed" },
    ]);
    expect(fetch).not.toHaveBeenCalled();
    expect([...(await ensureOverlayFonts([georgia("a")])).values()]).toEqual([{ list: APP, state: "failed" }]);
  });

  it("looks for a missing file again once the Fonts folder is listed", async () => {
    const { fetch, deps } = page({ status: 404 });
    await ensureOverlayFonts([georgia("a")], deps);
    await ensureOverlayFonts([georgia("a")], deps);
    expect(fetch).toHaveBeenCalledTimes(1);

    vi.stubGlobal("fetch", vi.fn(async () => json({ fonts: [], folder: "/Lib/Fonts" })));
    await listFontFiles();
    fetch.mockResolvedValue(new Response(TTF, { status: 200 }));
    expect([...(await ensureOverlayFonts([georgia("a")], deps)).values()]).toEqual([
      { list: `"${fileFamily("Georgia.ttf")}", ${APP}`, state: "ready" },
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("looks for a missing file again once a file is added to the Fonts folder, not after an add it refused", async () => {
    const { fetch, deps } = page({ status: 404 });
    await ensureOverlayFonts([georgia("a")], deps);
    expect(fetch).toHaveBeenCalledTimes(1);

    const post = vi.fn<(url: string) => Promise<Response>>(async () =>
      json({ error: "That file is not a font.", code: "unsupported_media_type" }, 415),
    );
    vi.stubGlobal("fetch", post);
    const file = new File([TTF], "Georgia.ttf");
    await expect(addFontFile(file)).rejects.toBeInstanceOf(FontFileError);
    expect([...(await ensureOverlayFonts([georgia("a")], deps)).values()]).toEqual([{ list: APP, state: "missing" }]);
    expect(fetch).toHaveBeenCalledTimes(1);

    post.mockResolvedValue(json({ font: { name: "Georgia.ttf", format: "ttf", bytes: TTF.length, modifiedAt: 1 } }, 201));
    await addFontFile(file);
    fetch.mockResolvedValue(new Response(TTF, { status: 200 }));
    expect([...(await ensureOverlayFonts([georgia("a")], deps)).values()]).toEqual([
      { list: `"${fileFamily("Georgia.ttf")}", ${APP}`, state: "ready" },
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(post.mock.calls.map(([url]) => url)).toEqual(["/api/fonts?name=Georgia.ttf", "/api/fonts?name=Georgia.ttf"]);
  });

  it("tells an installed or typed family from a missing one by measuring it against the generics", async () => {
    const measure = vi.fn((font: string) => (font.startsWith('72px "Inter"') ? 900 : 500));
    const resolved = await ensureOverlayFonts(
      [text("a", { font: { family: "Inter" } }), text("b", { font: { family: "Nowhere Sans" } }), text("c", { font: { family: "JetBrains Mono" } })],
      { ...page().deps, measure },
    );
    expect(resolved.get("family:Inter")).toEqual({ list: `"Inter", ${APP}`, state: "ready" });
    // A family that looks missing keeps its place in the list: the canvas falls through it where the computer lacks it
    expect(resolved.get("family:Nowhere Sans")).toEqual({ list: `"Nowhere Sans", ${APP}`, state: "missing" });
    expect(resolved.get("family:JetBrains Mono")).toEqual({ list: `"JetBrains Mono", ${APP}`, state: "ready" });
    expect(measure.mock.calls.some(([font]) => font.includes("JetBrains"))).toBe(false);
  });

  it("finds a font for one script only by the layers' own text, which the Latin probe cannot", async () => {
    // Farah draws no Latin letter, so the probe measures as the generic; the Arabic it draws does not
    const arabic = /[\u0600-\u06ff]/;
    const measure = vi.fn((font: string, sample: string) => (font.includes('"Farah"') && arabic.test(sample) ? 233.8 : 317.9));
    const layers = [
      text("a", { text: "مرحبا", font: { family: "Farah" } }),
      text("b", { text: "بالعالم\nمرحبا", font: { family: "Farah" } }),
      text("c", { text: "Hello", font: { family: "Nowhere Sans" } }),
    ];
    const resolved = await ensureOverlayFonts(layers, { ...page().deps, measure });
    expect(resolved.get("family:Farah")).toEqual({ list: `"Farah", ${APP}`, state: "ready" });
    expect(resolved.get("family:Nowhere Sans")).toEqual({ list: `"Nowhere Sans", ${APP}`, state: "missing" });
    // Measured in the layers' characters, each once, with no line break
    const farahText = measure.mock.calls.find(([font, sample]) => font.includes('"Farah"') && sample !== "mmmmmmmmmmlli@#WQ")?.[1];
    expect(farahText).toBe([...new Set("مرحبابالعالم")].join(""));

    // Arabic text in a font that draws none of it is still told apart from a font that is there
    const latinOnly = vi.fn((font: string, sample: string) => (font.includes('"Georgia"') && !arabic.test(sample) ? 900 : 500));
    const georgiaArabic = await ensureOverlayFonts([text("d", { text: "مرحبا", font: { family: "Georgia" } })], { ...page().deps, measure: latinOnly });
    expect(georgiaArabic.get("family:Georgia")).toEqual({ list: `"Georgia", ${APP}`, state: "ready" });
  });

  it("loads the faces each weight needs for the layers' characters, unless they are loaded", async () => {
    const { fonts, deps } = page();
    const layers = [text("a", { text: "Hi", weight: 600 }), text("b", { text: "Ho\nHi", weight: 700 }), text("c", { text: "", font: { family: "serif" } })];
    await ensureOverlayFonts(layers, deps);
    expect(fonts.load.mock.calls).toEqual([
      [`600 16px ${APP}`, "Hio"],
      [`700 16px ${APP}`, "Hio"],
      [`600 16px serif, ${APP}`, " "],
    ]);

    fonts.load.mockClear();
    fonts.check.mockReturnValue(true);
    await ensureOverlayFonts(layers, deps);
    expect(fonts.load).not.toHaveBeenCalled();
  });

  it("counts a load that brought faces as a change, and shrugs off one that throws", async () => {
    const { fonts, deps } = page();
    fonts.load.mockResolvedValueOnce([{}]);
    const before = fontGeneration();
    await ensureOverlayFonts([text("a")], deps);
    expect(fontGeneration()).toBe(before + 1);

    fonts.check.mockImplementation(() => {
      throw new SyntaxError("Could not parse");
    });
    await expect(ensureOverlayFonts([text("a")], deps)).resolves.toEqual(new Map([["family:Space Grotesk", { list: APP, state: "ready" }]]));
  });
});

describe("overlayFontList", () => {
  it("gives a resolved font's list, and any other font's as if it had loaded", () => {
    const list = overlayFontList(new Map([["file:georgia.ttf", { list: APP, state: "missing" as const }]]));
    expect(list({ family: "Georgia", file: "Georgia.ttf" })).toBe(APP);
    expect(list({ family: "Inter" })).toBe(`"Inter", ${APP}`);
  });
});

describe("onFontsChanged", () => {
  it("hears the page's own font loads while anyone listens", () => {
    const set = new EventTarget();
    Object.defineProperty(document, "fonts", { value: set, configurable: true });
    const listener = vi.fn();
    const off = onFontsChanged(listener);
    const before = fontGeneration();
    set.dispatchEvent(new Event("loadingdone"));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(fontGeneration()).toBe(before + 1);
    off();
    set.dispatchEvent(new Event("loadingdone"));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(fontGeneration()).toBe(before + 1);
  });
});

describe("the Fonts folder", () => {
  const INFO = { name: "Georgia.ttf", format: "ttf", bytes: 8, modifiedAt: 1 };

  it("lists the font files, or none where there is no library", async () => {
    const fetch = vi.fn(async () => json({ fonts: [INFO], folder: "/Lib/Fonts" }));
    vi.stubGlobal("fetch", fetch);
    expect(await listFontFiles()).toEqual({ fonts: [INFO], folder: "/Lib/Fonts" });
    expect(fetch).toHaveBeenCalledWith("/api/fonts", { cache: "no-store" });
    fetch.mockResolvedValue(json({ error: "No library", code: "unavailable" }, 503));
    expect(await listFontFiles()).toBeNull();
    fetch.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await listFontFiles()).toBeNull();
  });

  it("tells whoever draws once the folder is listed or added to, so a missing file is asked for again; not when either fails", async () => {
    const listener = vi.fn();
    const off = onFontsChanged(listener);
    const before = fontGeneration();
    const fetch = vi.fn(async () => json({ fonts: [INFO], folder: "/Lib/Fonts" }));
    vi.stubGlobal("fetch", fetch);
    await listFontFiles();
    expect(listener).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValue(json({ error: "No library", code: "unavailable" }, 503));
    await listFontFiles();
    expect(listener).toHaveBeenCalledTimes(1);

    const file = new File([TTF], "Georgia.ttf");
    fetch.mockResolvedValue(json({ font: INFO }, 201));
    await addFontFile(file);
    expect(listener).toHaveBeenCalledTimes(2);
    fetch.mockResolvedValue(json({ error: "That file is not a font.", code: "unsupported_media_type" }, 415));
    await expect(addFontFile(file)).rejects.toBeInstanceOf(FontFileError);
    off();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(fontGeneration()).toBe(before + 2);
  });

  it("adds a file's bytes under its name, and says why one was refused", async () => {
    const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => json({ font: INFO }, 201));
    vi.stubGlobal("fetch", fetch);
    const file = new File([TTF], "Georgia Bold.ttf", { type: "" });
    expect(await addFontFile(file)).toEqual(INFO);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("/api/fonts?name=Georgia%20Bold.ttf");
    expect(init).toMatchObject({ method: "POST", body: file, headers: { "Content-Type": "application/octet-stream" } });

    fetch.mockResolvedValue(json({ error: "Font collections (.ttc) can't be used: add a single .ttf or .otf.", code: "unsupported_media_type" }, 415));
    const refused = await addFontFile(file).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(FontFileError);
    expect(refused).toMatchObject({ status: 415, code: "unsupported_media_type", message: "Font collections (.ttc) can't be used: add a single .ttf or .otf." });

    fetch.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(addFontFile(file)).rejects.toMatchObject({ status: 0 });
  });
});

describe("installed fonts", () => {
  it("is not offered without Local Font Access", async () => {
    expect(localFontsSupported()).toBe(false);
    expect(await localFontsPermission()).toBe("unsupported");
    expect(await installedFamilies()).toBeNull();
  });

  it("lists each family once, sorted, without the system's hidden ones, asking as a method of window", async () => {
    vi.stubGlobal("isSecureContext", true);
    const queryLocalFonts = vi.fn(function (this: unknown) {
      if (this !== window) throw new TypeError("Illegal invocation");
      return Promise.resolve(["Zapfino", "Avenir", ".SF NS", "Avenir", "Ägypt"].map((family) => ({ family })));
    });
    vi.stubGlobal("queryLocalFonts", queryLocalFonts);
    expect(localFontsSupported()).toBe(true);
    expect(await installedFamilies()).toEqual(["Ägypt", "Avenir", "Zapfino"]);

    queryLocalFonts.mockImplementation(() => Promise.reject(new DOMException("Permission denied", "NotAllowedError")));
    expect(await installedFamilies()).toBeNull();
  });

  it("reads the permission without asking", async () => {
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("queryLocalFonts", vi.fn());
    const query = vi.fn(async () => ({ state: "granted" }));
    Object.defineProperty(navigator, "permissions", { value: { query }, configurable: true });
    expect(await localFontsPermission()).toBe("granted");
    expect(query).toHaveBeenCalledWith({ name: "local-fonts" });
    query.mockRejectedValue(new TypeError("not a valid permission name"));
    expect(await localFontsPermission()).toBe("prompt");
  });
});
