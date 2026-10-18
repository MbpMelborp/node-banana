"use client";

import { useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { cn } from "@/components/nodes/ui/cn";
import { AssetPlaceholder, tileThumbUrl } from "@/components/assets/AssetTile";
import { formatDuration, formatRelativeDate } from "@/components/assets/assetFormat";
import { ICON_BUTTON } from "@/components/stitch/editorStyles";
import type { EditSummary } from "@/lib/edits/types";
import { useEditProjectStore } from "@/store/editProjectStore";
import { ActionMenu, revealText } from "./EditMenu";
import { EditNameField } from "./EditNameField";

/** "3 clips · 0:12 · 2h ago" and, for a screen reader, "3 clips, 0:12, edited 2h ago". */
export function editCardMeta(edit: Pick<EditSummary, "clipCount" | "durationSec" | "updatedAt">, now = Date.now()) {
  const clips = `${edit.clipCount} clip${edit.clipCount === 1 ? "" : "s"}`;
  const length = formatDuration(edit.durationSec);
  const when = formatRelativeDate(edit.updatedAt, now);
  // "edited 2h ago", "edited yesterday", "edited Thu 16 Oct": only the relative words start lower case
  const spoken = when === "Just now" || when === "Yesterday" ? when.toLowerCase() : when;
  return { text: `${clips} · ${length} · ${when}`, label: `${clips}, ${length}, edited ${spoken}` };
}

/**
 * One edit on the home screen: its poster (the first clip's), name and what
 * it holds. A press opens it; ⋯ (shown on hover or focus) renames it in
 * place, duplicates it, shows its file or deletes it.
 */
export function EditCard({ edit, tabIndex }: { edit: EditSummary; tabIndex: number }) {
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [thumbFailed, setThumbFailed] = useState(false);
  const renameError = useEditProjectStore((s) => s.renameError);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const store = useEditProjectStore.getState;
  const meta = editCardMeta(edit);
  const poster = edit.poster && !thumbFailed ? tileThumbUrl(edit.poster, 320) : null;

  const setEditing = (editing: boolean) => {
    setRenaming(editing);
    if (!editing) useEditProjectStore.setState({ renameError: null });
  };

  return (
    <div role="listitem" className="group relative flex min-w-0 flex-col gap-2">
      <button
        type="button"
        tabIndex={tabIndex}
        data-edit-card={edit.id}
        aria-label={`Open ${edit.name}, ${meta.label}`}
        onClick={() => void store().openEditById(edit.id)}
        className="relative block aspect-video w-full overflow-hidden rounded-media bg-well ring-1 ring-white/8 transition-shadow hover:ring-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
      >
        {poster ? (
          // eslint-disable-next-line @next/next/no-img-element -- a library thumbnail route, which can answer 204
          <img src={poster} alt="" draggable={false} onError={() => setThumbFailed(true)} className="h-full w-full object-cover" />
        ) : (
          <AssetPlaceholder kind="video" size={28} />
        )}
      </button>
      <div className="flex min-w-0 items-start gap-1">
        <div className="min-w-0 flex-1">
          {renaming ? (
            <EditNameField
              name={edit.name}
              editing
              onEditingChange={setEditing}
              onCommit={(next) => store().rename(next, edit.id)}
              error={renameError}
            />
          ) : (
            <div className="truncate text-[13px] text-neutral-100">{edit.name}</div>
          )}
          <div className="truncate text-[11px] text-neutral-500">{meta.text}</div>
        </div>
        <div className="relative shrink-0" data-edit-chrome>
          <button
            ref={triggerRef}
            type="button"
            aria-label={`More for ${edit.name}`}
            aria-haspopup="menu"
            aria-expanded={menu}
            className={cn(ICON_BUTTON, "opacity-0 group-hover:opacity-100 focus-visible:opacity-100", menu && "opacity-100")}
            onClick={() => setMenu((open) => !open)}
          >
            <MoreHorizontal size={16} strokeWidth={1.75} />
          </button>
          {menu && (
            <ActionMenu
              label={edit.name}
              triggerRef={triggerRef}
              className="right-0"
              entries={[
                { kind: "item", label: "Rename", onSelect: () => setEditing(true) },
                { kind: "item", label: "Duplicate", onSelect: () => void store().duplicate(edit.id) },
                { kind: "item", label: revealText(), onSelect: () => void store().reveal(edit.id) },
                { kind: "divider" },
                { kind: "item", label: "Delete…", danger: true, onSelect: () => store().requestDelete(edit.id) },
              ]}
              onClose={(refocus) => {
                setMenu(false);
                if (refocus) triggerRef.current?.focus({ preventScroll: true });
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
