/**
 * Media by reference.
 *
 * Node data holds media as a same-origin URL wherever the bytes already live
 * on this computer: an asset in the library (`/api/assets/<id>/file`) or a
 * file in a saved workflow's folder (`/api/workflow-images?…&raw=1`). The
 * browser loads these like any image or video, so the canvas, thumbnails,
 * annotation and the video tools read them as they are, and the store, undo
 * and autosave carry a short string instead of megabytes of base64.
 *
 * The routes that call providers take media inline, so a request body goes
 * through `inlineMediaReferences` on its way out: each reference becomes the
 * data: URL it stands for, exactly as node data held it before.
 */
import { blobToDataUrl } from "@/lib/assets/client/mediaBlob";
import { assetFileUrl } from "@/lib/assets/client/api";

import { isMediaReference } from "./isReference";

export { isMediaReference };

/** The reference for an asset in the library. */
export function assetReference(assetId: string): string {
  return assetFileUrl(assetId);
}

/** The reference for a file in a saved workflow's folder: an image, video or audio ref id (`imageRef`, `videoRef`, …). */
export function workflowImageReference(workflowPath: string, imageId: string, folder?: "inputs" | "generations"): string {
  const params = new URLSearchParams({ workflowPath, imageId, raw: "1" });
  if (folder) params.set("folder", folder);
  return `/api/workflow-images?${params.toString()}`;
}

/* Resolving ------------------------------------------------------------ */

/**
 * The data: URLs of recently resolved references. A run sends the same
 * inputs to several nodes, and a batch sends them again on every run.
 */
const CACHE_CHARS = 256 * 1024 * 1024;
const cache = new Map<string, string>();
let cachedChars = 0;
const inFlight = new Map<string, Promise<string>>();

function remember(reference: string, dataUrl: string): void {
  if (dataUrl.length > CACHE_CHARS / 4) return;
  cache.set(reference, dataUrl);
  cachedChars += dataUrl.length;
  for (const [key, value] of cache) {
    if (cachedChars <= CACHE_CHARS) break;
    cache.delete(key);
    cachedChars -= value.length;
  }
}

/** The data: URL a reference stands for. Throws when its bytes cannot be read. */
export async function resolveMediaReference(reference: string): Promise<string> {
  const hit = cache.get(reference);
  if (hit !== undefined) {
    // Most recently used goes last
    cache.delete(reference);
    cache.set(reference, hit);
    return hit;
  }
  let pending = inFlight.get(reference);
  if (!pending) {
    pending = (async () => {
      const response = await fetch(reference);
      if (!response.ok) throw new Error(`Media could not be read (${response.status})`);
      const dataUrl = await blobToDataUrl(await response.blob());
      remember(reference, dataUrl);
      return dataUrl;
    })().finally(() => inFlight.delete(reference));
    inFlight.set(reference, pending);
  }
  return pending;
}

function collect(value: unknown, found: Set<string>, depth: number): void {
  if (depth > 12) return;
  if (isMediaReference(value)) {
    found.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collect(item, found, depth + 1);
  } else if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    for (const item of Object.values(value)) collect(item, found, depth + 1);
  }
}

function replace(value: unknown, resolved: Map<string, string>, depth: number): unknown {
  if (depth > 12) return value;
  if (typeof value === "string") return resolved.get(value) ?? value;
  if (Array.isArray(value)) {
    let next: unknown[] | null = null;
    for (let i = 0; i < value.length; i++) {
      const item = replace(value[i], resolved, depth + 1);
      if (item !== value[i]) (next ??= value.slice())[i] = item;
    }
    return next ?? value;
  }
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    let next: Record<string, unknown> | null = null;
    for (const [key, child] of Object.entries(value)) {
      const item = replace(child, resolved, depth + 1);
      if (item !== child) (next ??= { ...(value as Record<string, unknown>) })[key] = item;
    }
    return next ?? value;
  }
  return value;
}

/**
 * `value` with every media reference in it (at any depth) replaced by the
 * data: URL it stands for. Returns `value` itself when it holds none.
 */
export async function inlineMediaReferences<T>(value: T): Promise<T> {
  const found = new Set<string>();
  collect(value, found, 0);
  if (found.size === 0) return value;
  const resolved = new Map<string, string>();
  await Promise.all([...found].map(async (reference) => {
    resolved.set(reference, await resolveMediaReference(reference));
  }));
  return replace(value, resolved, 0) as T;
}

/** Forget cached bytes (tests). */
export function clearMediaReferenceCache(): void {
  cache.clear();
  cachedChars = 0;
}
