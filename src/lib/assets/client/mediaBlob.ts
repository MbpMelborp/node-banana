/**
 * Media strings and Blobs: telling a data:/blob: URL apart from text,
 * decoding a data: URL into a Blob synchronously, reading a Blob's bytes, and
 * turning a Blob back into a data: URL.
 *
 * Blob.arrayBuffer() is missing from some environments (jsdom), so bytes are
 * read through FileReader when it is.
 */

import { parseDataUrl as decodeDataUrl } from "@/utils/dataUrl";
import { isMediaReference } from "@/lib/media/isReference";

/**
 * `data:[<type>][;param]*,<payload>` with a real media type (or none at all),
 * so prose that happens to start with "data:" is not mistaken for media.
 */
const DATA_URL = /^data:(?:[\w.+-]+\/[\w.+-]+)?(?:;[\w.+-]+(?:=[^;,]*)?)*,/i;

export function isDataUrl(value: string): boolean {
  return value.startsWith("data:") && DATA_URL.test(value.slice(0, 256));
}

export function isBlobUrl(value: string): boolean {
  return value.startsWith("blob:");
}

/**
 * A string a snapshot stores by hash rather than inline: a data: or blob:
 * URL, or media node data holds by reference (src/lib/media/references.ts).
 */
export function isMediaString(value: unknown): value is string {
  return typeof value === "string" && (isBlobUrl(value) || isDataUrl(value) || isMediaReference(value));
}

export interface ParsedDataUrl {
  /** Lowercased media type without parameters, "" when the URL has none. */
  mime: string;
  base64: boolean;
  payload: string;
}

export function parseDataUrl(value: string): ParsedDataUrl | null {
  if (!isDataUrl(value)) return null;
  const comma = value.indexOf(",");
  const header = value.slice(5, comma);
  const parts = header.split(";");
  const mime = (parts[0] ?? "").trim().toLowerCase();
  const base64 = parts.slice(1).some((part) => part.trim().toLowerCase() === "base64");
  return { mime, base64, payload: value.slice(comma + 1) };
}

/** The MIME type a data: URL declares (without `;charset=` and the like), or null. */
export function dataUrlMime(value: string): string | null {
  return parseDataUrl(value)?.mime || null;
}

/**
 * The bytes a data: URL carries: its base64 payload decoded (whitespace, the
 * URL-safe alphabet and missing padding forgiven), or a plain one
 * percent-decoded, by the shared parser in `src/utils/dataUrl.ts`. Throws on
 * a malformed URL.
 */
export function dataUrlBytes(value: string): Uint8Array {
  const decoded = isDataUrl(value) ? decodeDataUrl(value) : null;
  if (!decoded) throw new Error("Not a readable data: URL");
  return decoded.bytes;
}

/** Synchronous: the Blob holds the bytes, so nothing depends on the string afterwards. */
export function dataUrlToBlob(value: string, mime?: string): Blob {
  const type = mime || dataUrlMime(value) || "application/octet-stream";
  return new Blob([dataUrlBytes(value) as BlobPart], { type });
}

export async function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === "function") return new Uint8Array(await blob.arrayBuffer());
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error("The media could not be read."));
    reader.readAsArrayBuffer(blob);
  });
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("The media could not be read."));
    reader.readAsDataURL(blob);
  });
}

/** Lowercase hex SHA-256 (matches SHA256_PATTERN). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  let hex = "";
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}
