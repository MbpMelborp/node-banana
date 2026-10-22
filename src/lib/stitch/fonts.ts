import { FONT_ROUTES, fontFileKey, type FontFileInfo, type FontList } from "@/lib/edits/fontFiles";
import type { StitchOverlay, StitchOverlayFont } from "@/types";
import type { OverlayFontList } from "./overlayDraw";
import { APP_SANS_FAMILY } from "./overlays";

/**
 * Fonts for text layers, in the page. A layer's font is one the app ships, a
 * font file from the library's Fonts folder (`/api/fonts`), or a family
 * installed on the computer (or typed); it resolves to a CSS family list that
 * always ends in the app's sans and sans-serif, so a missing font falls back
 * to the app's sans and nothing fails for a font. The preview, the render and
 * Frame to canvas run in one page and share document.fonts, so one
 * registration serves all three.
 *
 * A file is registered under a made-up family ("nbf-" and a hash of its name),
 * never its own or its font's name, so it cannot shadow an installed or
 * shipped family and the name always parses; with a weight range, so a static
 * file draws at its own weight with no synthetic bold and a variable one
 * follows the layer's weight. Every load is awaited before the first frame of
 * a render or a capture; the preview draws at once and again on
 * onFontsChanged.
 */

export type FontState = "ready" | "missing" | "failed";

export interface ResolvedFont {
  /** The CSS family list to draw with. */
  list: string;
  /** "missing": the file is not in the Fonts folder, or the family not on this computer; "failed": it would not load. */
  state: FontState;
}

export interface ShippedFont {
  /** As stored on a layer. */
  family: string;
  label: string;
  /** The weights it has faces for. */
  weights: readonly number[];
  /** The next/font variable on <html> holding its family list. */
  cssVar?: string;
}

/** The fonts the app ships, the app's sans first, and the generic families. */
export const SHIPPED_FONTS: readonly ShippedFont[] = [
  { family: APP_SANS_FAMILY, label: APP_SANS_FAMILY, weights: [500, 600, 700], cssVar: "--font-space-grotesk" },
  { family: "JetBrains Mono", label: "JetBrains Mono", weights: [400, 500], cssVar: "--font-jetbrains-mono" },
  { family: "sans-serif", label: "Sans serif", weights: [400, 500, 600, 700] },
  { family: "serif", label: "Serif", weights: [400, 500, 600, 700] },
  { family: "monospace", label: "Monospace", weights: [400, 500, 600, 700] },
];

export interface FontDeps {
  fetch: typeof fetch;
  /** Absent where the page cannot register a font (jsdom): font files then fall back. */
  FontFace?: typeof FontFace;
  /** document.fonts; absent where there is none. */
  fonts?: Pick<FontFaceSet, "add" | "check" | "load">;
  /** Width of `text` in a CSS font, to tell an installed family from a missing one; absent where nothing measures. */
  measure?: (font: string, text: string) => number;
}

/** Keywords that name a generic family: never quoted, or they would name a family called that. */
const GENERIC_FAMILIES: ReadonlySet<string> = new Set(["sans-serif", "serif", "monospace", "system-ui"]);
/** A family is on this computer when this text measures differently in it than in the generic it falls back to. */
const PROBE_TEXT = "mmmmmmmmmmlli@#WQ";

/* Family lists --------------------------------------------------------- */

/** A family as CSS: generic keywords as they are, any other name quoted. */
export function quoteFamily(family: string): string {
  return GENERIC_FAMILIES.has(family) ? family : `"${family.replace(/["\\]/g, "\\$&")}"`;
}

/** The family a font file is registered under: "nbf-" and the FNV-1a hash of its name as the Fonts folder keys it. */
export function fileFamily(fileName: string): string {
  const key = fontFileKey(fileName);
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 0x01000193) >>> 0;
  return `nbf-${hash.toString(16).padStart(8, "0")}`;
}

/** One font per file, else per family. */
export function fontKey(font: StitchOverlayFont): string {
  return font.file ? `file:${fontFileKey(font.file)}` : `family:${font.family}`;
}

export function shippedFont(family: string): ShippedFont | null {
  return SHIPPED_FONTS.find((font) => font.family === family) ?? null;
}

function cssVar(name: string): string {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return "";
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function shippedFamilies(font: ShippedFont): string {
  return (font.cssVar && cssVar(font.cssVar)) || quoteFamily(font.family);
}

/** The app's sans and sans-serif: what every list ends in, and all a missing font draws in. */
export function appSansList(): string {
  return `${shippedFamilies(SHIPPED_FONTS[0])}, sans-serif`;
}

/** `font`'s list when it is ready, in front of `appSans`. */
function readyList(font: StitchOverlayFont, appSans: string): string {
  if (font.file) return `${quoteFamily(fileFamily(font.file))}, ${appSans}`;
  if (font.family === APP_SANS_FAMILY) return appSans;
  const shipped = shippedFont(font.family);
  return `${shipped ? shippedFamilies(shipped) : quoteFamily(font.family)}, ${appSans}`;
}

/** `font`'s family list, as if it had loaded (a family the page does not have falls through to the app's sans). */
export function familyList(font: StitchOverlayFont): string {
  return readyList(font, appSansList());
}

/** The lists to draw with: each font as `resolved` has it, else as familyList gives it. */
export function overlayFontList(resolved: ReadonlyMap<string, ResolvedFont>): OverlayFontList {
  const appSans = appSansList();
  const lists = new Map<string, string>();
  return (font) => {
    const key = fontKey(font);
    let list = resolved.get(key)?.list ?? lists.get(key);
    if (list === undefined) {
      list = readyList(font, appSans);
      lists.set(key, list);
    }
    return list;
  };
}

/* Changes ---------------------------------------------------------------- */

const changes = {
  generation: 0,
  listeners: new Set<() => void>(),
  unwatch: null as (() => void) | null,
};

/**
 * Bumped whenever a font face is added or loads, and when the Fonts folder is listed or added to: a layout measured
 * before may now measure otherwise, and a font that was missing may now load.
 */
export function fontGeneration(): number {
  return changes.generation;
}

function fontsChanged(): void {
  changes.generation++;
  for (const listener of [...changes.listeners]) listener();
}

/** Calls `listener` after each font change (fontGeneration's bump), including faces the page itself loads. */
export function onFontsChanged(listener: () => void): () => void {
  changes.listeners.add(listener);
  if (changes.listeners.size === 1) {
    const set = typeof document !== "undefined" ? document.fonts : undefined;
    if (set?.addEventListener) {
      set.addEventListener("loadingdone", fontsChanged);
      changes.unwatch = () => set.removeEventListener("loadingdone", fontsChanged);
    }
  }
  return () => {
    if (!changes.listeners.delete(listener) || changes.listeners.size) return;
    changes.unwatch?.();
    changes.unwatch = null;
  };
}

/* Loading ---------------------------------------------------------------- */

interface FileLoad {
  state: Promise<FontState>;
  settled?: FontState;
  /** retryEpoch when it started: a file that did not load is fetched again once the epoch moves on. */
  epoch: number;
}

/** Font files loaded into each font set, by fontFileKey. */
const fileLoads = new WeakMap<object, Map<string, FileLoad>>();
/** Moved on when the Fonts folder is listed or added to, so a file that was missing is looked for again. */
let retryEpoch = 0;

function defaultDeps(): FontDeps {
  const browser = typeof document !== "undefined" && document.fonts ? document.fonts : undefined;
  return {
    fetch: (input, init) => fetch(input, init),
    FontFace: typeof FontFace === "undefined" ? undefined : FontFace,
    fonts: browser,
    measure: browser ? canvasMeasure() : undefined,
  };
}

let measureContext: CanvasRenderingContext2D | null | undefined;

function canvasMeasure(): FontDeps["measure"] {
  measureContext ??= document.createElement("canvas").getContext("2d");
  const ctx = measureContext;
  if (!ctx) return undefined;
  return (font, text) => {
    ctx.font = font;
    return ctx.measureText(text).width;
  };
}

async function fetchFile(name: string, deps: FontDeps): Promise<FontState> {
  const { FontFace: Face, fonts } = deps;
  if (!Face || !fonts) return "failed";
  let response: Response;
  try {
    response = await deps.fetch(FONT_ROUTES.file(name));
  } catch {
    return "failed";
  }
  // 503: no library here
  if (response.status === 404 || response.status === 503) return "missing";
  if (!response.ok) return "failed";
  try {
    const face = new Face(fileFamily(name), await response.arrayBuffer(), { weight: "1 1000" });
    await face.load();
    fonts.add(face);
  } catch {
    return "failed";
  }
  fontsChanged();
  return "ready";
}

function loadFile(name: string, deps: FontDeps): Promise<FontState> {
  if (!deps.fonts) return fetchFile(name, deps);
  let loads = fileLoads.get(deps.fonts);
  if (!loads) fileLoads.set(deps.fonts, (loads = new Map()));
  const key = fontFileKey(name);
  const known = loads.get(key);
  if (known && (known.settled === undefined || known.settled === "ready" || known.epoch === retryEpoch)) return known.state;
  const load: FileLoad = { state: fetchFile(name, deps), epoch: retryEpoch };
  void load.state.then((state) => (load.settled = state));
  loads.set(key, load);
  return load.state;
}

function isInstalled(family: string, measure: FontDeps["measure"]): boolean {
  if (!measure) return true;
  return ["monospace", "serif", "sans-serif"].some(
    (generic) => measure(`72px ${quoteFamily(family)}, ${generic}`, PROBE_TEXT) !== measure(`72px ${generic}`, PROBE_TEXT),
  );
}

async function resolveFont(font: StitchOverlayFont, deps: FontDeps, appSans: string): Promise<ResolvedFont> {
  if (font.file) {
    const state = await loadFile(font.file, deps);
    return { list: state === "ready" ? readyList(font, appSans) : appSans, state };
  }
  if (shippedFont(font.family) || isInstalled(font.family, deps.measure)) return { list: readyList(font, appSans), state: "ready" };
  return { list: appSans, state: "missing" };
}

/** Loads the faces `font` (a CSS font value) needs for `text`, unless they are loaded. A value the set cannot parse draws in the fallback. */
async function loadFaces(font: string, text: string, fonts: FontDeps["fonts"]): Promise<void> {
  if (!fonts) return;
  try {
    if (fonts.check(font, text)) return;
    if ((await fonts.load(font, text)).length) fontsChanged();
  } catch {
    // Drawn in the next family of the list.
  }
}

/**
 * Resolves every layer's font, loading font files and the faces each layer's weight and text need, so the first frame
 * drawn after it is in the right font. Never rejects: a font that cannot be had resolves to the app's sans, with its
 * state. Keyed by fontKey; overlayFontList turns the result into the lists drawOverlays takes.
 */
export async function ensureOverlayFonts(
  overlays: readonly StitchOverlay[],
  deps: Partial<FontDeps> = {},
): Promise<Map<string, ResolvedFont>> {
  const d = { ...defaultDeps(), ...deps };
  const resolved = new Map<string, ResolvedFont>();
  const appSans = appSansList();
  const groups = new Map<string, { font: StitchOverlayFont; weights: Set<number>; text: string }>();
  for (const o of overlays) {
    const key = fontKey(o.font);
    const group = groups.get(key) ?? { font: o.font, weights: new Set<number>(), text: "" };
    group.weights.add(o.weight);
    group.text += o.text;
    groups.set(key, group);
  }
  await Promise.all(
    [...groups].map(async ([key, group]) => {
      let font: ResolvedFont;
      try {
        font = await resolveFont(group.font, d, appSans);
      } catch {
        font = { list: appSans, state: "failed" };
      }
      resolved.set(key, font);
      const text = [...new Set(group.text.replace(/\n/g, ""))].join("") || " ";
      await Promise.all([...group.weights].map((weight) => loadFaces(`${weight} 16px ${font.list}`, text, d.fonts)));
    }),
  );
  return resolved;
}

/* The Fonts folder --------------------------------------------------------- */

export class FontFileError extends Error {
  constructor(
    message: string,
    /** HTTP status, or 0 when the request never got an answer. */
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "FontFileError";
  }
}

/** The Fonts folder may hold a file it lacked: a file that was missing is fetched again, and the listeners ask again. */
function fontsFolderChanged(): void {
  retryEpoch++;
  fontsChanged();
}

/** The font files in the library's Fonts folder; null when there is no library here to keep them. */
export async function listFontFiles(): Promise<FontList | null> {
  let list: FontList | null;
  try {
    const response = await fetch(FONT_ROUTES.list, { cache: "no-store" });
    list = response.ok ? ((await response.json()) as FontList) : null;
  } catch {
    list = null;
  }
  if (list) fontsFolderChanged();
  return list;
}

/** Adds a font file to the Fonts folder; the answer names the file a layer then refers to. */
export async function addFontFile(file: File): Promise<FontFileInfo> {
  let response: Response;
  try {
    response = await fetch(`${FONT_ROUTES.list}?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
      cache: "no-store",
    });
  } catch {
    throw new FontFileError("Couldn't reach Node Banana's server.", 0);
  }
  const body = (await response.json().catch(() => ({}))) as { font?: FontFileInfo; error?: unknown; code?: unknown };
  if (!response.ok || !body.font) {
    const message = typeof body.error === "string" && body.error ? body.error : `${response.status} ${response.statusText}`.trim();
    throw new FontFileError(message, response.status, typeof body.code === "string" ? body.code : undefined);
  }
  fontsFolderChanged();
  return body.font;
}

/* Installed fonts ------------------------------------------------------------ */

interface LocalFontData {
  readonly family: string;
}

type LocalFontsWindow = Window & { queryLocalFonts?: () => Promise<LocalFontData[]> };

/** Whether this browser can list installed fonts (Local Font Access: Chromium, in a secure context). */
export function localFontsSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext === true &&
    typeof (window as LocalFontsWindow).queryLocalFonts === "function"
  );
}

/** Whether listing installed fonts would ask, without asking. */
export async function localFontsPermission(): Promise<PermissionState | "unsupported"> {
  if (!localFontsSupported()) return "unsupported";
  try {
    return (await navigator.permissions.query({ name: "local-fonts" as PermissionName })).state;
  } catch {
    return "prompt";
  }
}

/**
 * The families installed on this computer, sorted; null when the browser cannot list them or the user refused. Call
 * it straight from a click: where it asks, the browser wants the gesture.
 */
export async function installedFamilies(): Promise<string[] | null> {
  if (!localFontsSupported()) return null;
  try {
    const faces = await (window as LocalFontsWindow).queryLocalFonts!();
    const families = new Set(faces.map((face) => face.family).filter((family) => family && !family.startsWith(".")));
    return [...families].sort((a, b) => a.localeCompare(b));
  } catch {
    return null;
  }
}
