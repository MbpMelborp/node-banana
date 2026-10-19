import { useEffect } from "react";
import { create } from "zustand";
import { useToast } from "@/components/Toast";
import { addMediaItems } from "@/components/stitch/editorActions";
import { NOT_MEDIA_REASON, recordUpload, uploadKindOf, type UploadContext, type UploadKind } from "@/lib/assets/client/upload";
import type { AssetView } from "@/lib/assets/types";
import { editMediaOf } from "@/lib/edits/document";
import { getAssetInfo, primeAssetInfo } from "@/lib/stitch/assetInfo";
import { onEditIdMoved, useEditProjectStore } from "@/store/editProjectStore";
import { useStitchEditorStore } from "@/store/stitchEditorStore";

/**
 * Files from the computer on their way into an edit's media: dropped on the
 * Edit video view's media pane, each recorded into the asset library as an
 * upload, all at once (the recorder sends two at a time). Until it joins
 * the edit's media a file is a pending upload here, kept by edit, so the pane
 * still shows it after being hidden or the view left. Recorded files join in
 * the order they were dropped (one waits for a file dropped before it), as
 * one undo step, and the pane scrolls to the last; one recorded while the
 * edit is not open joins the next time it is.
 */

/** A file on its way into the library. */
export interface FileUpload {
  /** Tells two uploads of one file apart. */
  key: string;
  /** The file's own name, which its row shows until the record names it. */
  name: string;
  kind: UploadKind;
}

export interface UploadHandlers {
  started?(upload: FileUpload): void;
  recorded(upload: FileUpload, asset: AssetView): void;
  /** After the failure toast. */
  failed?(upload: FileUpload, reason: string): void;
}

let nextKey = 0;

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Records the video and audio files among `files` into the library, every one at once; anything else is left out,
 * with one notice for the lot. A file that can't be added says so with its name and why. Each record goes to the
 * asset cache before `recorded` hears of it. Returns the uploads started, in the order given.
 */
export function uploadFiles(files: Iterable<File>, context: UploadContext, on: UploadHandlers): FileUpload[] {
  const started: { file: File; upload: FileUpload }[] = [];
  let skipped = false;
  for (const file of files) {
    const kind = uploadKindOf(file);
    if (kind) started.push({ file, upload: { key: `upload-${++nextKey}`, name: file.name, kind } });
    else skipped = true;
  }
  if (skipped) useToast.getState().show(NOT_MEDIA_REASON, "info");
  for (const { file, upload } of started) {
    on.started?.(upload);
    recordUpload(file, context).then(
      (asset) => {
        primeAssetInfo([asset]);
        on.recorded(upload, asset);
      },
      (error: unknown) => {
        const reason = reasonOf(error);
        useToast.getState().show(`Couldn't add “${upload.name}”`, "error", false, reason);
        on.failed?.(upload, reason);
      },
    );
  }
  return started.map(({ upload }) => upload);
}

/** A file dropped on an edit's media pane. */
export interface PendingMedia extends FileUpload {
  editId: string;
  /** Its record, once one exists: it joins the edit's media after the files dropped before it, with the edit open. */
  asset: AssetView | null;
}

interface MediaUploadsState {
  uploads: PendingMedia[];
}

export const useMediaUploads = create<MediaUploadsState>(() => ({ uploads: [] }));

const setUploads = (recipe: (uploads: PendingMedia[]) => PendingMedia[]) =>
  useMediaUploads.setState((state) => ({ uploads: recipe(state.uploads) }));

/** Whether the editor holds that edit's session (the view shows it). */
function editorHolds(editId: string): boolean {
  const s = useStitchEditorStore.getState();
  return s.isOpen && s.editId === editId && s.draft?.media !== undefined;
}

/**
 * The item already in the open edit's media with these very bytes (the same file dropped again is a second record
 * of one file), or null. One whose file the library lost doesn't count: the new record can be placed.
 */
function sameFileInMedia(asset: AssetView): string | null {
  const draft = useStitchEditorStore.getState().draft;
  if (!draft) return null;
  for (const id of editMediaOf(draft)) {
    if (id === asset.id) continue;
    const view = getAssetInfo(id);
    if (view && !view.missing && view.sha256 === asset.sha256) return id;
  }
  return null;
}

/**
 * Recorded files into the open edit's media, in order, as one undo step; one whose bytes the media holds already
 * adds nothing. The pane scrolls to the last of them (the one already there, for a file dropped twice).
 */
function placeInOpenEdit(assets: readonly AssetView[]): void {
  let last: string | null = null;
  const fresh: AssetView[] = [];
  for (const asset of assets) {
    const existing = sameFileInMedia(asset) ?? fresh.find((other) => other.sha256 === asset.sha256)?.id ?? null;
    if (existing) last = existing;
    else {
      fresh.push(asset);
      last = asset.id;
    }
  }
  addMediaItems(fresh);
  if (last) useEditProjectStore.getState().revealMedia(last);
}

/** The edit an upload is going into now: Save as a new edit moves them. */
const editOf = (key: string) => useMediaUploads.getState().uploads.find((upload) => upload.key === key)?.editId ?? null;

/**
 * The files dropped on an edit's media pane: video and audio are recorded into the library as uploads under the edit
 * and join its media in the order they came as their records exist (anything else is left out, with one notice).
 * Each shows as a pending upload of that edit until then.
 */
export function addFilesToEdit(files: Iterable<File>, edit: { editId: string; editName?: string }): void {
  uploadFiles(files, edit, {
    started: (upload) => setUploads((uploads) => [...uploads, { ...upload, editId: edit.editId, asset: null }]),
    recorded: (upload, asset) => {
      const editId = editOf(upload.key);
      if (editId === null) return;
      setUploads((uploads) => uploads.map((u) => (u.key === upload.key ? { ...u, asset } : u)));
      placeRecordedUploads(editId);
    },
    failed: (upload) => {
      const editId = editOf(upload.key);
      if (editId === null) return;
      setUploads((uploads) => uploads.filter((u) => u.key !== upload.key));
      // The files dropped after it may have been waiting for it
      placeRecordedUploads(editId);
    },
  });
}

/**
 * Once the editor holds `editId`: its recorded uploads join its media in the order they were dropped, as one undo
 * step, up to the first one still being recorded.
 */
export function placeRecordedUploads(editId: string): void {
  if (!editorHolds(editId)) return;
  const ready: PendingMedia[] = [];
  for (const upload of useMediaUploads.getState().uploads) {
    if (upload.editId !== editId) continue;
    if (!upload.asset) break;
    ready.push(upload);
  }
  if (ready.length === 0) return;
  const keys = new Set(ready.map((upload) => upload.key));
  setUploads((uploads) => uploads.filter((upload) => !keys.has(upload.key)));
  placeInOpenEdit(ready.map((upload) => upload.asset!));
}

/** Save as a new edit: the uploads still on their way into `from` go into the new edit instead. */
export function moveEditUploads(from: string, to: string): void {
  if (!useMediaUploads.getState().uploads.some((upload) => upload.editId === from)) return;
  setUploads((uploads) => uploads.map((upload) => (upload.editId === from ? { ...upload, editId: to } : upload)));
}

onEditIdMoved(moveEditUploads);

/** For the open edit: its uploads recorded while it was not open (or under the id it had) join its media as it shows. */
export function usePlaceRecordedUploads(): void {
  const editId = useStitchEditorStore((s) => (s.isOpen ? s.editId : null));
  const ready = useMediaUploads((s) => editId !== null && !!s.uploads.find((upload) => upload.editId === editId)?.asset);
  useEffect(() => {
    if (editId !== null && ready) placeRecordedUploads(editId);
  }, [editId, ready]);
}

/** For tests: no uploads pending. */
export function __resetMediaUploadsForTests(): void {
  nextKey = 0;
  useMediaUploads.setState({ uploads: [] });
}
