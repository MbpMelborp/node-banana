/**
 * Workflow snapshots for "open original workflow".
 *
 * A snapshot is the workflow graph with every data:/blob: media string
 * replaced by `{ $nbMedia: sha256, mime, bytes }`. http(s) strings are left
 * as they are (never dereferenced). Media bytes are hashed in the browser
 * (crypto.subtle SHA-256), the server is asked which it lacks
 * (`mediaHas`), and only those are uploaded. Bounded string→hash maps (one
 * per workflow, rebuilt by each of its snapshots from the strings actually
 * found, and one seeded by the recorder with every recorded asset) avoid
 * re-hashing the same strings. blob: URLs are still read whenever a graph
 * is captured, hash known or not: that binds the bytes, which the server
 * may turn out to lack after the node revoked the URL.
 * Keys named `$nbMedia` already present in node data are escaped on encode
 * so a crafted workflow cannot inject refs.
 */

import type { WorkflowFile } from "@/store/workflowStore";
import { generateWorkflowId } from "@/store/utils/localStorage";
import type { EdgeAppearance, EdgeStyle, NodeGroup } from "@/types";
import {
  SHA256_PATTERN,
  type AssetKind,
  type AssetView,
  type SnapshotMediaRef,
  type SnapshotWorkflow,
} from "../types";
import { AssetApiError, fetchMediaBlob, mediaHas, uploadMedia } from "./api";
import { isTransient, mapWithConcurrency } from "./async";
import {
  blobToDataUrl,
  dataUrlMime,
  dataUrlToBlob,
  isBlobUrl,
  isDataUrl,
  isMediaString,
  readBlobBytes,
  sha256Hex,
} from "./mediaBlob";
import { isMediaReference } from "@/lib/media/isReference";

/** Videos larger than this open as blob: URLs rather than data: URLs (the executors' own threshold). */
export const INLINE_VIDEO_LIMIT = 20 * 1024 * 1024;

/** Node data is shallow in practice; this only stops a pathological structure. */
const MAX_DEPTH = 64;
/** Recorded media remembered for the next snapshot: entries, and characters of media string held. */
const REMEMBER_LIMIT = 64;
const REMEMBER_CHARS = 64 * 1024 * 1024;
/**
 * Workflows whose snapshot hashes are kept, and characters of media string
 * they may hold between them. The workflow just snapshotted always keeps
 * its own (its canvas holds those strings anyway); others go oldest first.
 */
const KNOWN_WORKFLOWS = 8;
const KNOWN_CHARS = 64 * 1024 * 1024;

/** Run-time node (and edge) fields a snapshot never keeps. */
const RUNTIME_NODE_KEYS = new Set(["selected", "dragging"]);
const RUNTIME_DATA_KEYS = new Set(["abortController", "execution", "jobId"]);

/** `$nbMedia`, `$nbMediaEscaped`, … — escaping adds one "Escaped", hydrating removes one. */
const REF_KEY = "$nbMedia";
const ESCAPABLE_KEY = /^\$nbMedia(?:Escaped)*$/;
const ESCAPED_KEY = /^\$nbMedia(?:Escaped)+$/;

/** The parts of the store a snapshot needs, held by reference (zustand state is immutable). */
export interface CapturedGraph {
  nodes: unknown[];
  edges: unknown[];
  groups?: Record<string, unknown>;
  edgeStyle: string;
  edgeAppearance?: unknown;
  workflowId: string;
  workflowName: string | null;
}

/** Synchronous: reads the fields, copies nothing. */
export function captureGraph(state: {
  nodes: unknown[];
  edges: unknown[];
  groups?: Record<string, unknown>;
  edgeStyle: string;
  edgeAppearance?: unknown;
  workflowId: string | null;
  workflowName: string | null;
}): CapturedGraph {
  if (!state.workflowId) throw new Error("A workflow snapshot needs a workflow id; ensure one before the run starts.");
  return {
    nodes: state.nodes,
    edges: state.edges,
    groups: state.groups,
    edgeStyle: state.edgeStyle,
    edgeAppearance: state.edgeAppearance,
    workflowId: state.workflowId,
    workflowName: state.workflowName,
  };
}

export interface EncodedSnapshot {
  workflow: SnapshotWorkflow;
  mediaHashes: string[];
  /** The bytes behind a hash this snapshot references, for a later upload (PutRunResult.missingMedia). Null when unreadable. */
  readMedia?: (sha256: string) => Promise<Blob | null>;
}

interface MediaInfo {
  sha256: string;
  mime: string;
  bytes: number;
}

/**
 * Per workflow, the hashes of the strings its last snapshot found; each
 * snapshot replaces its own workflow's map, so running in one tab does not
 * make the next run in another hash its media again. Oldest first.
 */
const known = new Map<string, { media: Map<string, MediaInfo>; chars: number }>();
let knownChars = 0;
/** Hashes the recorder learned from recordings, kept until a snapshot finds them or they age out. */
const remembered = new Map<string, MediaInfo>();
let rememberedChars = 0;

function lookup(media: string): MediaInfo | undefined {
  for (const graph of known.values()) {
    const info = graph.media.get(media);
    if (info) return info;
  }
  return remembered.get(media);
}

function keepKnown(workflowId: string, media: Map<string, MediaInfo>): void {
  const previous = known.get(workflowId);
  if (previous) {
    known.delete(workflowId);
    knownChars -= previous.chars;
  }
  let chars = 0;
  for (const key of media.keys()) chars += key.length;
  known.set(workflowId, { media, chars });
  knownChars += chars;
  // Another workflow's strings may be held by nothing else any more (a closed tab).
  for (const [id, graph] of known) {
    if (known.size <= KNOWN_WORKFLOWS && knownChars <= KNOWN_CHARS) break;
    if (id === workflowId) continue;
    known.delete(id);
    knownChars -= graph.chars;
  }
}

/** Remember that `media` (a data: URL string) has this hash, so snapshots do not hash or upload it again. */
export function rememberMediaHash(media: string, sha256: string, mime: string, bytes: number): void {
  if (!isMediaString(media) || !SHA256_PATTERN.test(sha256)) return;
  if (remembered.has(media)) {
    remembered.delete(media);
    rememberedChars -= media.length;
  }
  remembered.set(media, { sha256, mime, bytes });
  rememberedChars += media.length;
  // Oldest first: a long session must not pin every output it ever made.
  for (const key of remembered.keys()) {
    if (remembered.size <= REMEMBER_LIMIT && rememberedChars <= REMEMBER_CHARS) break;
    remembered.delete(key);
    rememberedChars -= key.length;
  }
}

function forget(media: string): void {
  if (remembered.delete(media)) rememberedChars -= media.length;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function collectMedia(value: unknown, found: Set<string>, depth = 0): void {
  if (typeof value === "string") {
    if (isMediaString(value)) found.add(value);
    return;
  }
  if (depth > MAX_DEPTH || !value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectMedia(item, found, depth + 1);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const child of Object.values(value)) collectMedia(child, found, depth + 1);
}

function graphRoots(graph: CapturedGraph): unknown[] {
  return [graph.nodes, graph.edges, graph.groups, graph.edgeAppearance];
}

/** blob: URLs whose bytes were bound while the URL was live. */
export type PrefetchedMedia = Map<string, Promise<Blob | null>>;

function fetchBlobUrl(url: string): Promise<Blob | null> {
  // fetch() binds the blob URL entry when it is called, so revoking the URL
  // afterwards (a re-run, a closed tab) cannot lose the bytes.
  return fetch(url)
    .then((response) => (response.ok ? response.blob() : null))
    .catch(() => null);
}

/**
 * Starts reading every blob: URL in the graph, including ones an earlier
 * snapshot hashed: a known hash does not mean the server still holds the
 * bytes (a switched library), and once the node revokes the URL they could
 * not be sent. Reading a blob: URL only takes a handle on its bytes; they
 * are hashed later, and only when no hash is known. Synchronous up to the
 * fetch() calls; call it when the graph is captured, not when it is encoded.
 */
export function prefetchBlobUrls(graph: CapturedGraph, into: PrefetchedMedia = new Map()): PrefetchedMedia {
  const found = new Set<string>();
  for (const root of graphRoots(graph)) collectMedia(root, found);
  for (const media of found) {
    if (isBlobUrl(media) && !into.has(media)) into.set(media, fetchBlobUrl(media));
  }
  return into;
}

function escapeKey(key: string): string {
  return ESCAPABLE_KEY.test(key) ? `${key}Escaped` : key;
}

function unescapeKey(key: string): string {
  return ESCAPED_KEY.test(key) ? key.slice(0, -"Escaped".length) : key;
}

function encodeValue(value: unknown, refs: Map<string, MediaInfo | null>, depth: number, omit?: Set<string>): unknown {
  if (typeof value === "string") {
    if (!isMediaString(value)) return value;
    const info = refs.get(value);
    // Unreadable media (a blob: URL revoked before it was bound) cannot come back.
    return info ? ({ $nbMedia: info.sha256, mime: info.mime, bytes: info.bytes } satisfies SnapshotMediaRef) : null;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "object" || depth > MAX_DEPTH) return undefined;
  if (Array.isArray(value)) {
    return value.map((item) => {
      const encoded = encodeValue(item, refs, depth + 1);
      return encoded === undefined ? null : encoded;
    });
  }
  if (!isPlainObject(value)) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (omit?.has(key)) continue;
    const encoded = encodeValue(child, refs, depth + 1);
    if (encoded !== undefined) result[escapeKey(key)] = encoded;
  }
  return result;
}

function encodeNode(node: unknown, refs: Map<string, MediaInfo | null>): unknown {
  if (!isPlainObject(node)) return null;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(node)) {
    if (RUNTIME_NODE_KEYS.has(key)) continue;
    const encoded = key === "data" ? encodeValue(child, refs, 1, RUNTIME_DATA_KEYS) : encodeValue(child, refs, 1);
    if (encoded !== undefined) result[escapeKey(key)] = encoded;
  }
  return result;
}

/** The bytes behind one media string; null when a blob: URL or a referenced file can no longer be read. */
async function mediaBlob(media: string, prefetched: PrefetchedMedia): Promise<Blob | null> {
  if (isBlobUrl(media)) return await (prefetched.get(media) ?? fetchBlobUrl(media));
  // Media held by reference is read from its file, as a blob: URL is
  if (isMediaReference(media)) return await fetchBlobUrl(media);
  return dataUrlToBlob(media);
}

/** Bytes, hash and type of one media string. */
async function hashMedia(media: string, prefetched: PrefetchedMedia): Promise<{ info: MediaInfo; blob: Blob } | null> {
  const blob = await mediaBlob(media, prefetched);
  if (!blob) return null;
  const bytes = await readBlobBytes(blob);
  const mime = (isDataUrl(media) ? dataUrlMime(media) : null) || blob.type || "application/octet-stream";
  return { info: { sha256: await sha256Hex(bytes), mime, bytes: bytes.byteLength }, blob };
}

/**
 * Replaces media with refs and uploads any bytes the server lacks. Strips
 * `selected`/`dragging` from nodes and `abortController`, `execution` and
 * `jobId` from node data; everything else is kept as the graph held it.
 * Rejects when the server cannot be asked or a transient upload fails, so
 * the caller can retry the whole snapshot.
 */
export async function encodeSnapshot(graph: CapturedGraph, options: { prefetched?: PrefetchedMedia } = {}): Promise<EncodedSnapshot> {
  const found = new Set<string>();
  for (const root of graphRoots(graph)) collectMedia(root, found);

  // Bind every blob: URL before the first await.
  const prefetched = options.prefetched ?? new Map<string, Promise<Blob | null>>();
  for (const media of found) {
    if (isBlobUrl(media) && !prefetched.has(media)) prefetched.set(media, fetchBlobUrl(media));
  }

  const refs = new Map<string, MediaInfo | null>();
  const fresh = new Map<string, Blob>();
  await mapWithConcurrency([...found], 4, async (media) => {
    const cached = lookup(media);
    if (cached) {
      refs.set(media, cached);
      return;
    }
    try {
      const hashed = await hashMedia(media, prefetched);
      refs.set(media, hashed?.info ?? null);
      if (hashed && !fresh.has(hashed.info.sha256)) fresh.set(hashed.info.sha256, hashed.blob);
    } catch (error) {
      console.warn("A workflow snapshot could not read some media:", error);
      refs.set(media, null);
    }
  });

  // Keep only what this graph holds, so a workflow's map never outgrows its canvas.
  const next = new Map<string, MediaInfo>();
  for (const [media, info] of refs) {
    if (!info) continue;
    next.set(media, info);
    forget(media);
  }
  keepKnown(graph.workflowId, next);

  const sources = new Map<string, string>();
  for (const [media, info] of refs) if (info && !sources.has(info.sha256)) sources.set(info.sha256, media);
  const readMedia = async (sha256: string): Promise<Blob | null> => {
    const cachedBlob = fresh.get(sha256);
    if (cachedBlob) return cachedBlob;
    const media = sources.get(sha256);
    if (!media) return null;
    try {
      const blob = await mediaBlob(media, prefetched);
      const mime = refs.get(media)?.mime;
      return blob && mime && blob.type !== mime ? new Blob([blob], { type: mime }) : blob;
    } catch {
      return null;
    }
  };

  const mediaHashes = [...sources.keys()];
  const missing = await mediaHas(mediaHashes);
  let retryable: unknown = null;
  await mapWithConcurrency(missing, 2, async (sha256) => {
    if (!sources.has(sha256)) return;
    const blob = await readMedia(sha256);
    if (!blob) return;
    try {
      await uploadMedia(sha256, blob);
    } catch (error) {
      if (isTransient(error)) retryable ??= error;
      else console.warn(`Snapshot media ${sha256.slice(0, 8)} was refused:`, error instanceof AssetApiError ? error.message : error);
    }
  });
  if (retryable) throw retryable;

  const workflow: SnapshotWorkflow = {
    version: 1,
    id: graph.workflowId,
    name: graph.workflowName ?? "",
    nodes: graph.nodes.map((node) => encodeNode(node, refs)),
    edges: graph.edges.map((edge) => encodeValue(edge, refs, 1, RUNTIME_NODE_KEYS) ?? null),
    edgeStyle: graph.edgeStyle,
  };
  if (graph.edgeAppearance !== undefined) workflow.edgeAppearance = encodeValue(graph.edgeAppearance, refs, 0);
  if (graph.groups) workflow.groups = (encodeValue(graph.groups, refs, 0) as Record<string, unknown> | undefined) ?? {};
  return { workflow, mediaHashes, readMedia };
}

/* Hydrate ------------------------------------------------------------ */

function isRef(value: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(value, REF_KEY);
}

function refKey(ref: Record<string, unknown>): string {
  return `${String(ref.$nbMedia)}|${typeof ref.mime === "string" ? ref.mime : ""}`;
}

function collectRefs(value: unknown, refs: Map<string, SnapshotMediaRef>, depth = 0): void {
  if (depth > MAX_DEPTH || !value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, refs, depth + 1);
    return;
  }
  if (!isPlainObject(value)) return;
  if (isRef(value)) {
    if (typeof value.$nbMedia === "string" && SHA256_PATTERN.test(value.$nbMedia)) {
      refs.set(refKey(value), value as unknown as SnapshotMediaRef);
    }
    return;
  }
  for (const child of Object.values(value)) collectRefs(child, refs, depth + 1);
}

function decodeValue(value: unknown, urls: Map<string, string | null>, depth = 0): unknown {
  if (depth > MAX_DEPTH || !value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => decodeValue(item, urls, depth + 1));
  if (!isPlainObject(value)) return value;
  if (isRef(value)) return urls.get(refKey(value)) ?? null;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) result[unescapeKey(key)] = decodeValue(child, urls, depth + 1);
  return result;
}

/** A media Blob as the string node data holds: a data: URL, or a blob: URL for a large video. */
export async function mediaBlobToNodeString(blob: Blob, mime?: string): Promise<string> {
  const typed = mime && blob.type !== mime ? new Blob([blob], { type: mime }) : blob;
  if (typed.type.startsWith("video/") && typed.size > INLINE_VIDEO_LIMIT) return URL.createObjectURL(typed);
  return blobToDataUrl(typed);
}

/** Refs → data: URLs (videos over 20 MB → blob: URLs). Media the server no longer has becomes null. */
export async function hydrateSnapshot(workflow: SnapshotWorkflow): Promise<WorkflowFile> {
  if (!workflow || workflow.version !== 1 || !Array.isArray(workflow.nodes) || !Array.isArray(workflow.edges)) {
    throw new Error("This workflow snapshot can't be read.");
  }
  const refs = new Map<string, SnapshotMediaRef>();
  for (const root of [workflow.nodes, workflow.edges, workflow.groups, workflow.edgeAppearance]) collectRefs(root, refs);

  const urls = new Map<string, string | null>();
  await mapWithConcurrency([...refs], 3, async ([key, ref]) => {
    try {
      urls.set(key, await mediaBlobToNodeString(await fetchMediaBlob(ref.$nbMedia), ref.mime || undefined));
    } catch (error) {
      console.warn(`Snapshot media ${ref.$nbMedia.slice(0, 8)} is unavailable:`, error instanceof Error ? error.message : error);
      urls.set(key, null);
    }
  });

  const file: WorkflowFile = {
    version: 1,
    name: typeof workflow.name === "string" ? workflow.name : "",
    nodes: decodeValue(workflow.nodes, urls) as WorkflowFile["nodes"],
    edges: decodeValue(workflow.edges, urls) as WorkflowFile["edges"],
    edgeStyle: workflow.edgeStyle as EdgeStyle,
  };
  if (workflow.id) file.id = workflow.id;
  if (workflow.edgeAppearance !== undefined) file.edgeAppearance = decodeValue(workflow.edgeAppearance, urls) as EdgeAppearance;
  if (workflow.groups) file.groups = decodeValue(workflow.groups, urls) as Record<string, NodeGroup>;
  return file;
}

/* Prepare for open --------------------------------------------------- */

/** Statuses of a node caught mid-run; a snapshot opens with nothing running. */
const RUNNING_STATUSES = new Set(["loading", "running", "pending", "processing", "queued", "in_progress"]);
/** Node-data fields that belong to one run and would mislead in a copy. */
const RUN_DATA_KEYS = ["jobId", "runStatus", "abortController", "execution", "selected", "__fallbackModelUsed", "__usedFallback", "__primaryError"];

/** Where each producing node type shows its output (spec A7). */
const OUTPUT_FIELDS: Record<string, string> = {
  nanoBanana: "outputImage",
  videoFrameGrab: "outputImage",
  removeBackground: "outputImage",
  imageResize: "outputImage",
  annotation: "outputImage",
  generateVideo: "outputVideo",
  videoStitch: "outputVideo",
  videoTrim: "outputVideo",
  easeCurve: "outputVideo",
  generateAudio: "outputAudio",
  generate3d: "output3dUrl",
  gifEncoder: "outputGif",
};

/**
 * Edits that cut an output into cells (spec A7: "splitGrid cells → leave").
 * The cells became nodes of their own; the producer recorded is the source
 * node, whose output field still holds the whole image.
 */
const CELL_OPERATIONS = new Set(["splitToNodes", "splitGrid"]);

/** Whether opening the asset's workflow puts the asset back into its producing node. False for split cells. */
export function injectsIntoProducer(asset: Pick<AssetView, "producer">): boolean {
  return !CELL_OPERATIONS.has(asset.producer.operation ?? "");
}

/** comfyApp's typed mirrors, the first declared output of each type (see outputsToNodeData). */
const COMFY_MIRRORS: Record<AssetKind, string> = {
  image: "outputImage",
  video: "outputVideo",
  audio: "outputAudio",
  "3d": "output3dUrl",
};

/** Carousel history arrays and the index that selects one of their entries. */
const CAROUSELS = [
  ["imageHistory", "selectedHistoryIndex"],
  ["videoHistory", "selectedVideoHistoryIndex"],
  ["audioHistory", "selectedAudioHistoryIndex"],
] as const;

function carouselIndexOf(data: Record<string, unknown>, assetId: string): { indexKey: string; index: number } | null {
  for (const [historyKey, indexKey] of CAROUSELS) {
    const history = data[historyKey];
    if (!Array.isArray(history)) continue;
    const index = history.findIndex((item) => isPlainObject(item) && item.assetId === assetId);
    if (index >= 0) return { indexKey, index };
  }
  return null;
}

function injectComfyOutput(data: Record<string, unknown>, asset: AssetView, media: string): void {
  const outputs = isPlainObject(data.outputs) ? { ...(data.outputs as Record<string, unknown>) } : {};
  const handle = asset.producer.outputHandle;
  if (handle) outputs[handle] = media;
  data.outputs = outputs;
  const declared = isPlainObject(data.app) && Array.isArray(data.app.outputs) ? (data.app.outputs as unknown[]) : [];
  let mirror: unknown = null;
  for (const output of declared) {
    if (!isPlainObject(output) || output.type !== asset.kind || typeof output.id !== "string") continue;
    if (outputs[output.id]) {
      mirror = outputs[output.id];
      break;
    }
  }
  data[COMFY_MIRRORS[asset.kind]] = mirror ?? media;
}

/** The label that tells a copy from its original: "27 Sep 14:32" (locale order, 24-hour). */
export function snapshotOpenedLabel(at: number, locale?: string): string {
  const date = new Date(at);
  const day = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(date);
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  return `${day} ${time}`;
}

/**
 * Makes a hydrated snapshot safe to open as a new, unsaved workflow:
 * fresh id, no directoryPath, name "<name> (27 Sep 14:32)", statuses reset
 * (loading/running → idle; jobId, runStatus, abortController, selected
 * dropped), and `assetMedia` injected into the producing node's output
 * field (plus its carousel selection when the node has one). A split cell
 * injects nothing: its producer is the source node, which keeps the grid.
 */
export function prepareWorkflowForOpen(
  file: WorkflowFile,
  options: { asset: AssetView; assetMedia: string | null; openedAt: number; locale?: string },
): WorkflowFile {
  const { asset, assetMedia } = options;
  const nodes = (file.nodes as unknown[]).filter(isPlainObject);
  // The producer by id; failing that, the node whose carousel holds this asset.
  const producer =
    nodes.find((node) => node.id === asset.producer.nodeId && node.type === asset.producer.nodeType) ??
    nodes.find((node) => isPlainObject(node.data) && carouselIndexOf(node.data, asset.id) !== null);

  const prepared = nodes.map((node) => {
    const { selected: _selected, dragging: _dragging, ...rest } = node;
    const data: Record<string, unknown> = isPlainObject(node.data) ? { ...node.data } : {};
    for (const key of RUN_DATA_KEYS) delete data[key];
    if (typeof data.status === "string" && RUNNING_STATUSES.has(data.status)) data.status = "idle";

    if (node === producer && injectsIntoProducer(asset)) {
      const field = OUTPUT_FIELDS[String(node.type)];
      if (assetMedia && (field || node.type === "comfyApp")) {
        if (node.type === "comfyApp") injectComfyOutput(data, asset, assetMedia);
        else data[field] = assetMedia;
        data.status = "complete";
        data.error = null;
      }
      const carousel = carouselIndexOf(data, asset.id);
      if (carousel) data[carousel.indexKey] = carousel.index;
    }
    return { ...rest, data };
  });

  const baseName = file.name?.trim() || asset.workflow.name?.trim() || asset.workflowName?.trim() || "Untitled";
  const { directoryPath: _directoryPath, ...rest } = file;
  return {
    ...rest,
    id: generateWorkflowId(),
    name: `${baseName} (${snapshotOpenedLabel(options.openedAt, options.locale)})`,
    nodes: prepared as unknown as WorkflowFile["nodes"],
  };
}
