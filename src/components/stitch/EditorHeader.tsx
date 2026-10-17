"use client";

import { Film } from "lucide-react";
import { DialogButton } from "@/components/ui/Dialog";
import { Tooltip } from "@/components/ui/Tooltip";
import { MenuDivider } from "@/components/ui/Menu";
import { selectCanRedo, selectCanUndo, useStitchEditorStore } from "@/store/stitchEditorStore";
import { formatTimecode } from "@/lib/stitch/timecode";
import { TEXT_GHOST } from "./editorStyles";

/**
 * The editor's 48px header: the mark, "Stitch" and what the sequence is
 * (clips, length, size, rate); Undo and Redo over the editor's own history;
 * Cancel and Done. Nothing clickable sits in the top 12px of the left
 * 60px, where the desktop's window controls draw over the panel's corner.
 */
export function EditorHeader({
  clipCount,
  total,
  size,
  fps,
  onCancel,
  onDone,
}: {
  clipCount: number;
  total: number;
  /** "1920 × 1080", or null when no ready clip has a size. */
  size: string | null;
  /** "24 fps", or null (mixed or unknown rates). */
  fps: string | null;
  onCancel: () => void;
  onDone: () => void;
}) {
  const canUndo = useStitchEditorStore(selectCanUndo);
  const canRedo = useStitchEditorStore(selectCanRedo);
  const initialClipCount = useStitchEditorStore((s) => s.initial?.timeline.length ?? 0);
  const undo = useStitchEditorStore((s) => s.undo);
  const redo = useStitchEditorStore((s) => s.redo);

  // Size and rate read as one item, "1920 × 1080 · 24 fps", with plain spaces round their dot
  const meta = clipCount === 0 ? null : [size, fps].filter((v): v is string => v !== null).join(" · ") || null;
  return (
    <div className="h-12 shrink-0 flex items-center justify-between gap-4 px-3 border-b border-chrome-border bg-editor-chrome">
      <div className="flex min-w-0 items-center gap-2.5 pl-2">
        <Film size={16} strokeWidth={1.75} className="shrink-0 text-neutral-400" aria-hidden="true" />
        <span className="text-[13px] font-semibold text-neutral-100">Stitch</span>
        <MenuDivider variant="bar" className="mx-0.5 shrink-0" aria-hidden="true" />
        <div className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[11px] text-neutral-500">
          <span>{`${clipCount} clip${clipCount === 1 ? "" : "s"}`}</span>
          {clipCount > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums text-neutral-400">{formatTimecode(total)}</span>
            </>
          )}
          {meta && (
            <>
              <span aria-hidden="true">·</span>
              <span>{meta}</span>
            </>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {/* The tooltips open downward, into the stage, inside the panel */}
        <div className="group relative flex">
          <button type="button" className={TEXT_GHOST} disabled={!canUndo} onClick={undo}>
            Undo
          </button>
          <Tooltip label="Undo" shortcut="⌘Z" placement="bottom" />
        </div>
        <div className="group relative flex">
          <button type="button" className={TEXT_GHOST} disabled={!canRedo} onClick={redo}>
            Redo
          </button>
          <Tooltip label="Redo" shortcut="⇧⌘Z" placement="bottom" />
        </div>
        <MenuDivider variant="bar" className="mx-2" aria-hidden="true" />
        <DialogButton variant="ghost" className="focus-visible:ring-offset-editor-chrome" onClick={onCancel}>
          Cancel
        </DialogButton>
        <DialogButton
          variant="primary"
          className="focus-visible:ring-offset-editor-chrome"
          // Off only when there is nothing and nothing was given; a user who removed every clip can apply that.
          // Not "dirty": with nothing given, a loop count alone is nothing to keep.
          disabled={clipCount === 0 && initialClipCount === 0}
          onClick={onDone}
        >
          Done
        </DialogButton>
      </div>
    </div>
  );
}
