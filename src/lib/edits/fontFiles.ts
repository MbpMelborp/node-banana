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

/** Whether a stored or sent name may name a font file. A text layer's font.file comes from shared files: check it. */
export function isFontFileName(name: string): boolean {
  return FONT_FILE_PATTERN.test(name);
}

/** Font file names compare in one Unicode form and case-insensitively, as edit files do: a library moves to any disk. */
export function fontFileKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}
