/**
 * Font files on disk: `<library root>/Fonts/`, shared by every edit, which name a file by its name. The /api/fonts
 * routes call only this module.
 *
 * A file is found by reading the folder and comparing `fontFileKey`s, never by joining the requested name onto the
 * folder, so a name Finder wrote in another Unicode form or case still matches. An added file never replaces another:
 * a name already holding other bytes gets "Name 2.ext", since every edit that names it would change. Adds are
 * serialised per process and run inside `writeInLibraryRoot` (refused while the library moves).
 */

import type { Dirent } from "fs";
import { promises as fs } from "fs";
import path from "path";
import { LibraryError, libraryRootForRead, writeInLibraryRoot, type ServedFile } from "@/lib/assets/server";
import { errnoCode } from "@/lib/assets/server/errors";
import { atomicWriteFile, KeyedMutex } from "@/lib/assets/server/fsutil";
import { sanitiseFolderName } from "@/lib/assets/server/known";
import { FONTS_DIR } from "@/lib/assets/server/layout";
import {
  FONT_MIME,
  fontFileKey,
  fontFormatOf,
  isFontFileName,
  sniffFont,
  type FontFileInfo,
  type FontFormat,
  type FontList,
} from "./fontFiles";

const ADD_LOCK = "add";
const MAX_NAME_LENGTH = 1024;

interface FontsRuntime {
  locks: KeyedMutex;
}

const globalState = globalThis as typeof globalThis & { __nodeBananaFonts?: FontsRuntime };

/** On globalThis, so Next's per-route module copies share one set of locks. */
function runtime(): FontsRuntime {
  globalState.__nodeBananaFonts ??= { locks: new KeyedMutex() };
  return globalState.__nodeBananaFonts;
}

function fontsDir(root: string): string {
  return path.join(root, FONTS_DIR);
}

async function readEntries(dir: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return [];
    throw error;
  }
}

interface FontFile {
  /** The name on disk. */
  entry: string;
  full: string;
  format: FontFormat;
  stat: import("fs").Stats;
}

/** The folder's entry as a font file: a font file name, and a file (a symlink to one is the user's own). */
async function fontFile(dir: string, entry: Dirent): Promise<FontFile | null> {
  const format = fontFormatOf(entry.name);
  if (!format || !isFontFileName(entry.name) || !(entry.isFile() || entry.isSymbolicLink())) return null;
  const full = path.join(dir, entry.name);
  if (path.dirname(full) !== dir) return null;
  try {
    const stat = await fs.stat(full);
    return stat.isFile() ? { entry: entry.name, full, format, stat } : null;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
}

function infoOf(file: FontFile): FontFileInfo {
  return {
    name: file.entry.normalize("NFC"),
    format: file.format,
    bytes: file.stat.size,
    modifiedAt: Math.trunc(file.stat.mtimeMs),
  };
}

/** Every font file in the Fonts folder, by name; none (and nothing written) when there is no folder. */
export async function listFonts(): Promise<FontList> {
  const dir = fontsDir(await libraryRootForRead());
  const files = await Promise.all((await readEntries(dir)).map((entry) => fontFile(dir, entry)));
  const fonts = files.flatMap((file) => (file ? [infoOf(file)] : [])).sort((a, b) => a.name.localeCompare(b.name));
  return { fonts, folder: dir };
}

const extensionRefused = () => new LibraryError("A font file must end in .ttf, .otf, .woff or .woff2.", 400, "bad_request");

/**
 * The file name an upload called `rawName` is kept under: its last path segment, the stem made safe as a folder name
 * is (and without "%"), and the extension the bytes are. TrueType and OpenType outlines share one container, so either
 * name holds either.
 */
function fileNameFor(rawName: string, bytes: Uint8Array): { stem: string; ext: FontFormat } {
  if (!rawName || rawName.length > MAX_NAME_LENGTH) throw new LibraryError("Name the font file.", 400, "bad_request");
  const base = (rawName.split(/[\\/]/).pop() ?? "").normalize("NFC");
  const dot = base.lastIndexOf(".");
  const claimed = dot > 0 ? fontFormatOf(base) : null;
  if (!claimed) throw extensionRefused();
  const sniffed = sniffFont(bytes);
  if (sniffed === "collection") {
    throw new LibraryError("Font collections (.ttc) can't be used: add a single .ttf or .otf.", 415, "unsupported_media_type");
  }
  if (!sniffed) throw new LibraryError("That file is not a font.", 415, "unsupported_media_type");
  const sfnt = (format: FontFormat) => format === "ttf" || format === "otf";
  const ext = sfnt(sniffed) && sfnt(claimed) ? claimed : sniffed;
  const stem = sanitiseFolderName(base.slice(0, dot).replace(/%/g, " "));
  // Its cut to length can halve a surrogate pair: the half goes too.
  return { stem: /[\uD800-\uDBFF]$/.test(stem) ? sanitiseFolderName(stem.slice(0, -1)) : stem, ext };
}

async function sameBytes(file: string, bytes: Uint8Array): Promise<boolean> {
  return Buffer.from(bytes).equals(await fs.readFile(file));
}

/**
 * Keeps an uploaded font in the Fonts folder. Of "Stem.ext", "Stem 2.ext", … the first that is free is written, unless
 * one before it already holds these bytes: then that file is the answer, and nothing is written.
 */
export async function addFont(rawName: string, bytes: Uint8Array): Promise<{ font: FontFileInfo; created: boolean }> {
  const { stem, ext } = fileNameFor(rawName, bytes);
  return runtime().locks.run(ADD_LOCK, () =>
    writeInLibraryRoot(async (root) => {
      const dir = fontsDir(root);
      const entries = new Map((await readEntries(dir)).map((entry) => [fontFileKey(entry.name), entry]));
      for (let n = 1; ; n++) {
        const name = n === 1 ? `${stem}.${ext}` : `${stem} ${n}.${ext}`;
        if (!isFontFileName(name)) throw new LibraryError("That font file name can't be used.", 400, "bad_request");
        const taken = entries.get(fontFileKey(name));
        if (taken) {
          const file = await fontFile(dir, taken);
          if (file && file.stat.size === bytes.byteLength && (await sameBytes(file.full, bytes))) {
            return { font: infoOf(file), created: false };
          }
          continue;
        }
        const full = path.join(dir, name);
        await fs.mkdir(dir, { recursive: true });
        await atomicWriteFile(full, bytes, { fsync: true, shortTemp: true });
        const stat = await fs.stat(full);
        return { font: infoOf({ entry: name, full, format: ext, stat }), created: true };
      }
    }),
  );
}

/** The font file `name` names, to stream; null when the Fonts folder has no such file. */
export async function openFont(name: string): Promise<ServedFile | null> {
  if (!isFontFileName(name)) return null;
  const dir = fontsDir(await libraryRootForRead());
  const key = fontFileKey(name);
  const entry = (await readEntries(dir)).find((candidate) => fontFileKey(candidate.name) === key);
  const file = entry ? await fontFile(dir, entry) : null;
  if (!file) return null;
  const { size, mtimeMs } = file.stat;
  return { path: file.full, mime: FONT_MIME[file.format], bytes: size, sha256: `${size}-${Math.trunc(mtimeMs)}`, filename: file.entry };
}
