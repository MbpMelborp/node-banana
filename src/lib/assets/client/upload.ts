/**
 * Files the user adds from their computer, kept in the asset library as
 * uploads (`origin: "uploaded"`): the Edit video view's Add media and the
 * drop onto its pane. An upload is recorded like a render, under the edit
 * it came in through (its id and name stand in for a workflow; no workflow
 * snapshot, no project), or under "Uploads" when it came in outside an edit.
 * It keeps the file's own name as its display name; the library names the
 * file on disk itself. The same file added twice is two records sharing one
 * file, as for any recording.
 */

import { ASSET_NAME_MAX, oneLineName } from "../name";
import type { AssetKind, AssetProducer, AssetRunContext, AssetView } from "../types";
import { patchAsset } from "./api";
import { newRunId } from "./ids";
import { recordAsset } from "./recorder";

export type UploadKind = Extract<AssetKind, "video" | "audio">;

/** The workflow an upload made outside an edit is listed under. */
export const UPLOADS_WORKFLOW_ID = "uploads";
const UPLOADS_WORKFLOW_NAME = "Uploads";

export const NOT_MEDIA_REASON = "Only video and audio files can be added.";
const UNREADABLE_REASON = "The file couldn't be read as video or audio.";

const VIDEO_EXTENSIONS = new Set(["mp4", "m4v", "mov", "webm", "mkv", "avi"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "aac", "wav", "ogg", "oga", "opus", "flac", "aif", "aiff"]);

/** How long the browser gets to read a file's length and size before the upload goes without them. */
const MEASURE_TIMEOUT_MS = 3_000;

/** Video or audio by the file's type, else by its extension; null for anything else. */
export function uploadKindOf(file: Pick<File, "name" | "type">): UploadKind | null {
  const type = file.type.toLowerCase();
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  const ext = /\.([^.]+)$/.exec(file.name)?.[1]?.toLowerCase() ?? "";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  return null;
}

export interface MeasuredMedia {
  durationSec?: number;
  width?: number;
  height?: number;
}

export type MeasureMedia = (file: File, kind: UploadKind) => Promise<MeasuredMedia>;

function positive(value: number): number | undefined {
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * The file's length (and a video's size) as a media element reads them from its metadata; nothing when it can't
 * within a few seconds. The server measures the file too, so these only stand in when it can't.
 */
export function measureMedia(file: File, kind: UploadKind): Promise<MeasuredMedia> {
  if (typeof document === "undefined") return Promise.resolve({});
  let url: string;
  try {
    url = URL.createObjectURL(file);
  } catch {
    return Promise.resolve({});
  }
  const element = document.createElement(kind);
  element.preload = "metadata";
  element.muted = true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish({}), MEASURE_TIMEOUT_MS);
    function finish(measured: MeasuredMedia) {
      clearTimeout(timer);
      element.onloadedmetadata = null;
      element.onerror = null;
      element.removeAttribute("src");
      try {
        element.load();
      } catch {
        // Releasing the decoder is a courtesy.
      }
      URL.revokeObjectURL(url);
      resolve(measured);
    }
    element.onloadedmetadata = () => {
      const measured: MeasuredMedia = {};
      const durationSec = positive(element.duration);
      if (durationSec) measured.durationSec = durationSec;
      if (element instanceof HTMLVideoElement) {
        const width = positive(element.videoWidth);
        const height = positive(element.videoHeight);
        if (width && height) Object.assign(measured, { width, height });
      }
      finish(measured);
    };
    element.onerror = () => finish({});
    element.src = url;
  });
}

/** The file's name as a display name: one line, at most 120 characters, its extension kept. */
function uploadName(fileName: string): string | undefined {
  const name = oneLineName(fileName).trim();
  if (name.length <= ASSET_NAME_MAX) return name || undefined;
  const ext = /\.[^.\s]{1,10}$/.exec(name)?.[0] ?? "";
  let head = name.slice(0, ASSET_NAME_MAX - ext.length);
  // Not half of an emoji
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return `${head.trimEnd()}${ext}`;
}

export interface UploadContext {
  /** The edit the file came in through; without one it is listed under "Uploads". */
  editId?: string;
  editName?: string;
}

export interface UploadDeps {
  measure?: MeasureMedia;
}

/**
 * Records a video or audio file into the library and resolves with its record. Rejects with an Error whose
 * message says why, as a sentence: not video or audio, the library refused or could not take it, or bytes nothing
 * can read. The recorder's own notice stays quiet; the caller tells the user. Bytes nothing can read are kept but
 * never listed, as for any recording; a file whose bytes are something else (a picture named `.mp4`) is put in
 * the Trash, so the library doesn't list what the user was told wasn't added.
 */
export async function recordUpload(file: File, context: UploadContext = {}, deps: UploadDeps = {}): Promise<AssetView> {
  const kind = uploadKindOf(file);
  if (!kind) throw new Error(NOT_MEDIA_REASON);
  const measured = await (deps.measure ?? measureMedia)(file, kind).catch((): MeasuredMedia => ({}));
  const { editId, editName } = context;
  const run: AssetRunContext = {
    runId: newRunId(),
    workflowId: editId ?? UPLOADS_WORKFLOW_ID,
    workflowName: editId ? (editName ?? null) : UPLOADS_WORKFLOW_NAME,
    projectDir: null,
    startedAt: Date.now(),
  };
  const producer: AssetProducer = editId
    ? { nodeId: editId, nodeType: "editProject", ...(editName ? { nodeTitle: editName } : {}), operation: "upload" }
    : { nodeId: "upload", nodeType: "upload", operation: "upload" };
  const handle = recordAsset(
    {
      kind,
      origin: "uploaded",
      media: file,
      mime: file.type || undefined,
      name: uploadName(file.name),
      producer,
      ...measured,
    },
    run,
    { quiet: true },
  );
  const result = await handle.done;
  if (!result) throw new Error(await handle.failed);
  const { asset } = result;
  if (asset.unreadable) throw new Error(UNREADABLE_REASON);
  if (asset.kind !== "video" && asset.kind !== "audio") {
    await patchAsset(asset.id, { trashed: true }).catch(() => {});
    throw new Error(UNREADABLE_REASON);
  }
  return asset;
}
