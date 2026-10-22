/**
 * Font files a text layer can name: files kept in `<Node Banana folder>/Fonts/`, shared by every edit and referenced
 * by file name. Shared by the server, the routes and the browser; no Node or DOM imports.
 */

export const FONT_EXTENSIONS = ["ttf", "otf", "woff", "woff2"] as const;
export type FontFormat = (typeof FONT_EXTENSIONS)[number];

/**
 * A bare file name with a font extension: no leading dot or space, no control character, none of <>:"/\|?* (so no
 * path) and no "%" (a route decodes its parameter once), at most 200 characters before the extension.
 */
export const FONT_FILE_PATTERN = /^(?![.\s])[^\u0000-\u001f\u007f<>:"/\\|?*%]{1,200}\.(?:ttf|otf|woff2?)$/i;

/** The largest font file accepted: Arial Unicode is 23 MB, a CJK font 16–20 MB. */
export const FONT_BYTE_LIMIT = 32 * 1024 * 1024;

/** The file picker's `accept`. */
export const FONT_ACCEPT = ".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2";

export const FONT_MIME: Record<FontFormat, string> = {
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
};

export const FONT_ROUTES = {
  /** GET FontList (503 with no library); POST ?name=<file name> with the raw bytes → 201 { font }, 200 when kept. */
  list: "/api/fonts",
  /** GET the file's bytes. */
  file: (name: string) => `/api/fonts/${encodeURIComponent(name)}`,
};

export interface FontFileInfo {
  name: string;
  format: FontFormat;
  bytes: number;
  modifiedAt: number;
}

export interface FontList {
  fonts: FontFileInfo[];
  /** The Fonts folder's path. */
  folder: string;
}

/** Half a surrogate pair on its own: no URL can carry it, and a disk stores it as U+FFFD, so no file has that name. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Whether a stored or sent name may name a font file. A text layer's font.file comes from shared files: check it. */
export function isFontFileName(name: string): boolean {
  return FONT_FILE_PATTERN.test(name) && !LONE_SURROGATE.test(name);
}

/** Font file names compare in one Unicode form and case-insensitively, as edit files do: a library moves to any disk. */
export function fontFileKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

/** The format a file name's extension claims; null for anything else. */
export function fontFormatOf(name: string): FontFormat | null {
  const ext = /\.([^.]+)$/.exec(name)?.[1].toLowerCase();
  return FONT_EXTENSIONS.find((format) => format === ext) ?? null;
}

/** The real format from the first bytes, whatever the name claims; "collection" for a .ttc; null for anything else. */
export function sniffFont(bytes: Uint8Array): FontFormat | "collection" | null {
  if (bytes.length < 4) return null;
  // sfnt version 1.0: TrueType outlines
  if (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0) return "ttf";
  const tag = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  // Apple's TrueType tag
  if (tag === "true") return "ttf";
  // CFF outlines
  if (tag === "OTTO") return "otf";
  if (tag === "wOFF") return "woff";
  if (tag === "wOF2") return "woff2";
  if (tag === "ttcf") return "collection";
  return null;
}
