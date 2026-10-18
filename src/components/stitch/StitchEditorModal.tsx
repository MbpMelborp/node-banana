"use client";

import { useRef, type HTMLAttributes } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { requestSave } from "@/store/saveRequestStore";
import { selectIsDirty, useStitchEditorStore } from "@/store/stitchEditorStore";
import { commitStitchEdit } from "./commitStitchEdit";
import { DiscardSheet } from "./DiscardSheet";
import { EditorHeader } from "./EditorHeader";
import { EditorWorkspace } from "./EditorWorkspace";
import { STITCH_EDITOR_PANEL } from "./editorStyles";
import { LibraryPicker } from "./library/LibraryPicker";
import { useEditorComposition } from "./useEditorComposition";
import { useEditorLifecycle } from "./useEditorLifecycle";
import { useStitchEditorKeys } from "./useStitchEditorKeys";

/** The header's height (its h-12). */
const HEADER_PX = 48;

/** Cancel and Escape: straight out when nothing changed, otherwise the discard sheet asks. */
function requestClose(): void {
  const s = useStitchEditorStore.getState();
  if (selectIsDirty(s)) s.setDiscardOpen(true);
  else s.close();
}

/** The marker the library picker hands focus back by (see STITCH_EDITOR_PANEL). */
const EDITOR_PANEL_PROPS = { [STITCH_EDITOR_PANEL]: "" } as HTMLAttributes<HTMLDivElement>;

/**
 * The Stitch editor: a near-full-screen dialog over the canvas, opened by
 * the node's Expand or Open editor. On the Dialog primitive inset 24px, like
 * the annotation editor, so it sits under the desktop's drag regions rather
 * than in them. Everything it edits is the editor store's draft until Done
 * (or Save, which keeps it open) writes it to the node in one step.
 */
export function StitchEditorModal() {
  // An edit project's session belongs to the Edit video view, never to this dialog
  const isOpen = useStitchEditorStore((s) => s.isOpen && s.nodeId !== null);
  if (!isOpen) return null;
  return <StitchEditor />;
}

function StitchEditor() {
  const rootRef = useRef<HTMLDivElement>(null);

  useEditorLifecycle();
  useStitchEditorKeys(rootRef, requestClose);
  const composition = useEditorComposition(rootRef, HEADER_PX);

  return (
    <Dialog
      open
      onClose={requestClose}
      closeOnBackdrop={false}
      closeOnEscape={false}
      stopWheel={false}
      label="Edit video"
      panelProps={EDITOR_PANEL_PROPS}
      className="w-[calc(100vw-48px)] max-w-none h-[calc(100vh-48px)] max-h-none bg-editor-chrome"
    >
      <div ref={rootRef} className="flex h-full min-h-0 flex-col">
        <EditorHeader
          clipCount={composition.clipCount}
          total={composition.total}
          size={composition.size}
          fps={composition.fps}
          onCancel={requestClose}
          // The editor's lifecycle answers every save request by writing the edit first
          onSave={() => requestSave("button")}
          onDone={commitStitchEdit}
        />
        <EditorWorkspace composition={composition} />
      </div>
      <DiscardSheet />
      <LibraryPicker />
    </Dialog>
  );
}
