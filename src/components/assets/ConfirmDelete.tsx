"use client";

import { useEffect, useState } from "react";
import { Dialog, DialogBody, DialogButton, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/Dialog";
import { useAssetStore } from "@/store/assetStore";
import { formatCount, resolvePlatform } from "./assetFormat";

/** Where "deleted" library files go on this platform. */
function osTrashName(platform: string): string {
  if (platform === "win32") return "the Recycle Bin";
  return "the Trash";
}

/**
 * Asks before the one action Undo cannot reverse: deleting assets for good
 * (from the Trash) or removing records whose files are gone. Files in
 * project folders are named as kept, unless the user ticks to include them.
 */
export function ConfirmDelete() {
  const confirm = useAssetStore((state) => state.confirm);
  const closeConfirm = useAssetStore((state) => state.closeConfirm);
  const runBulk = useAssetStore((state) => state.runBulk);
  const library = useAssetStore((state) => state.library);
  const [deleteProjectFiles, setDeleteProjectFiles] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setDeleteProjectFiles(false);
    setBusy(false);
  }, [confirm]);

  if (!confirm) return null;
  const count = formatCount(confirm.count);
  const remove = confirm.kind === "remove";

  const run = async () => {
    setBusy(true);
    await runBulk(confirm.selection, remove ? { action: "delete" } : { action: "delete", deleteProjectFiles });
    closeConfirm();
  };

  return (
    <Dialog open onClose={closeConfirm} size="sm" portal>
      <DialogHeader>
        <DialogTitle>{remove ? `Remove ${count} from the library?` : `Delete ${count} permanently?`}</DialogTitle>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-3">
        <DialogDescription className="text-[13px] leading-5">
          {remove
            ? "Their files are already missing. The records, with their prompts and settings, are removed. This cannot be undone."
            : `Library files go to ${osTrashName(resolvePlatform(library))}. They leave Creativo Melborp for good: this cannot be undone here.`}
        </DialogDescription>
        {!remove && confirm.projectCount !== 0 && (
          <label className="flex items-start gap-2.5 rounded-lg border border-card-border p-3 text-[13px] leading-5 text-neutral-300">
            <input
              type="checkbox"
              checked={deleteProjectFiles}
              onChange={(event) => setDeleteProjectFiles(event.target.checked)}
              className="mt-1 accent-neutral-200"
            />
            <span>
              {confirm.projectCount === null
                ? "Also delete any of their files that are in project folders."
                : `Also delete the ${formatCount(confirm.projectCount, "file")} in project folders.`}
              <span className="block text-xs text-ink-3">
                Unticked, they stay in their projects, which still use them.
              </span>
            </span>
          </label>
        )}
      </DialogBody>
      <DialogFooter>
        <DialogButton variant="ghost" onClick={closeConfirm} autoFocus>
          Cancel
        </DialogButton>
        <DialogButton variant="danger" onClick={() => void run()} disabled={busy}>
          {remove ? "Remove from library" : "Delete permanently"}
        </DialogButton>
      </DialogFooter>
    </Dialog>
  );
}
