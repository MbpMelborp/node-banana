"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, Film, PanelLeftOpen } from "lucide-react";
import { DialogButton } from "@/components/ui/Dialog";
import { MenuDivider } from "@/components/ui/Menu";
import { Tooltip } from "@/components/ui/Tooltip";
import { cn } from "@/components/nodes/ui/cn";
import { ICON_BUTTON, TEXT_GHOST } from "@/components/stitch/editorStyles";
import type { EditorComposition } from "@/components/stitch/useEditorComposition";
import { useLibraryAvailable } from "@/components/stitch/library/useLibraryAvailable";
import { clipName } from "@/lib/stitch/labels";
import { formatTimecode } from "@/lib/stitch/timecode";
import { sessionIsDirty, useEditProjectStore, type EditSaveState } from "@/store/editProjectStore";
import { selectCanRedo, selectCanUndo, useStitchEditorStore } from "@/store/stitchEditorStore";
import { EditMenu } from "./EditMenu";
import { EditNameField } from "./EditNameField";

/** The encoder is asked once per page. */
let encoderCheck: Promise<boolean> | null = null;

/** Whether this browser can encode the render; null until it has said. */
function useEncoderSupported(): boolean | null {
  const [supported, setSupported] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    encoderCheck ??= import("@/hooks/useStitchVideos").then((m) => m.checkEncoderSupport()).catch(() => false);
    void encoderCheck.then((ok) => {
      if (live) setSupported(ok);
    });
    return () => {
      live = false;
    };
  }, []);
  return supported;
}

/** The word the header shows for how saving stands. */
export function saveStateWord(state: EditSaveState, dirty: boolean): { text: string; tone: string; title?: string } {
  switch (state) {
    case "saving":
      return { text: "Saving…", tone: "text-neutral-400" };
    case "waiting":
      return { text: "Waiting…", tone: "text-neutral-400", title: "Waiting for the library to finish moving" };
    case "failed":
      return { text: "Save failed", tone: "text-red-400" };
    case "gone":
      return { text: "Not in Edits", tone: "text-red-400" };
    case "conflict":
      return { text: "Changed elsewhere", tone: "text-amber-400" };
    case "saved":
      return dirty ? { text: "Unsaved", tone: "text-neutral-400" } : { text: "Saved", tone: "text-neutral-500" };
  }
}

/** Why Render cannot run now, or null. */
function renderBlockedReason(
  composition: EditorComposition,
  libraryOn: boolean,
  encoder: boolean | null,
  otherRendering: boolean,
): string | null {
  if (!libraryOn) return "The asset library is off";
  if (encoder === false) return "This browser can't encode H.264 video";
  if (otherRendering) return "Another edit is rendering";
  if (composition.clipCount === 0) return "Add a clip to render";
  for (const span of composition.spans) {
    const media = composition.byClip.get(span.clip.id);
    if (media?.missing) return `${clipName(span.index)}'s video is no longer in the library`;
    if (media?.status === "error") return `${clipName(span.index)}'s video can't be read`;
  }
  const loading = composition.spans.some((span) => composition.byClip.get(span.clip.id)?.status === "loading");
  if (!loading && composition.spans.every((span) => span.length <= 0)) return "Every clip is empty";
  return null;
}

/**
 * The open edit's 48px header: All edits, the mark, the name (renamed in
 * place) and its menu, what the sequence is; then how saving stands, Undo and
 * Redo, and Save and Render, which a render in progress replaces with its
 * progress and Stop. The save word and the Save/Render slot keep fixed
 * widths, so nothing under the pointer moves as they change; the meta line
 * gives way first in a narrow window.
 */
export function EditHeader({ composition }: { composition: EditorComposition }) {
  const { clipCount, total, size, fps } = composition;
  const name = useEditProjectStore((s) => s.open?.name ?? "");
  const editId = useEditProjectStore((s) => s.open?.id ?? null);
  const saveState = useEditProjectStore((s) => s.save.state);
  const renameError = useEditProjectStore((s) => s.renameError);
  const paneOpen = useEditProjectStore((s) => s.pane.open);
  const render = useEditProjectStore((s) => s.render);
  const dirty = useStitchEditorStore((s) => sessionIsDirty(s));
  const canUndo = useStitchEditorStore(selectCanUndo);
  const canRedo = useStitchEditorStore(selectCanRedo);
  const undo = useStitchEditorStore((s) => s.undo);
  const redo = useStitchEditorStore((s) => s.redo);
  const libraryOn = useLibraryAvailable();
  const encoder = useEncoderSupported();
  const [renaming, setRenaming] = useState(false);

  const store = useEditProjectStore.getState;
  const word = saveStateWord(saveState, dirty);
  const rendering = render.state === "rendering" && render.editId === editId;
  const blocked = renderBlockedReason(composition, libraryOn, encoder, render.state === "rendering" && !rendering);
  const percent = Math.round(Math.min(100, Math.max(0, render.progress)));
  const meta = clipCount === 0 ? null : [size, fps].filter((v): v is string => v !== null).join(" · ") || null;

  const setEditing = (editing: boolean) => {
    setRenaming(editing);
    if (!editing) useEditProjectStore.setState({ renameError: null });
  };

  return (
    <div
      data-edit-chrome
      className="@container relative z-20 flex h-12 shrink-0 items-center justify-between gap-4 border-b border-chrome-border bg-editor-chrome px-3"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {!paneOpen && (
          <div className="group relative flex shrink-0">
            <button
              type="button"
              aria-label="Show the library"
              aria-expanded={false}
              className={ICON_BUTTON}
              onClick={() => store().setPaneOpen(true)}
            >
              <PanelLeftOpen size={16} strokeWidth={1.75} />
            </button>
            <Tooltip label="Show the library" placement="bottom" align="start" />
          </div>
        )}
        <div className="group relative flex shrink-0">
          <button type="button" aria-label="All edits" className={ICON_BUTTON} onClick={() => void store().goHome()}>
            <ArrowLeft size={16} strokeWidth={1.75} />
          </button>
          <Tooltip label="All edits" placement="bottom" />
        </div>
        <Film size={16} strokeWidth={1.75} className="ml-1 shrink-0 text-neutral-400" aria-hidden="true" />
        <EditNameField
          name={name}
          editing={renaming}
          onEditingChange={setEditing}
          onCommit={(next) => store().rename(next)}
          error={renameError}
        />
        <EditMenu onRename={() => setEditing(true)} />
        <MenuDivider variant="bar" className="mx-1 shrink-0 @max-[1100px]:hidden" aria-hidden="true" />
        <div className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[11px] text-neutral-500 @max-[1100px]:hidden">
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
              <span className="truncate">{meta}</span>
            </>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <span
          aria-live="polite"
          data-testid="edit-save-state"
          title={word.title}
          className={cn("w-[112px] truncate text-right text-[11px]", word.tone)}
        >
          {word.text}
        </span>
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
        <div className="flex w-[200px] items-center justify-end gap-1">
          {rendering ? (
            <>
              <div
                role="progressbar"
                aria-label="Rendering"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                className="h-0.5 w-24 overflow-hidden rounded-full bg-neutral-700"
              >
                <div
                  className="h-full rounded-full bg-neutral-200 transition-[width] duration-200 motion-reduce:transition-none"
                  style={{ width: `${percent}%` }}
                />
              </div>
              <span className="w-9 text-right font-mono text-[11px] tabular-nums text-neutral-400">{`${percent}%`}</span>
              <DialogButton
                variant="ghost"
                className="focus-visible:ring-offset-editor-chrome"
                onClick={() => store().stopRender()}
              >
                Stop
              </DialogButton>
            </>
          ) : (
            <>
              <div className="group relative flex">
                <DialogButton
                  variant="ghost"
                  className="focus-visible:ring-offset-editor-chrome"
                  disabled={!dirty && saveState === "saved"}
                  onClick={() => void store().saveNow("manual")}
                >
                  Save
                </DialogButton>
                <Tooltip label="Save" shortcut="⌘S" placement="bottom" />
              </div>
              {/* On the wrapper: a disabled button is never hovered itself */}
              <div className="group relative flex" data-testid="edit-render-slot">
                <DialogButton
                  variant="primary"
                  className="focus-visible:ring-offset-editor-chrome"
                  disabled={blocked !== null}
                  onClick={() => store().startRender()}
                >
                  Render
                </DialogButton>
                {blocked && <Tooltip label={blocked} placement="bottom" align="end" />}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
