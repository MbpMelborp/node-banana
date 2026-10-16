import { useEffect, type RefObject } from "react";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { isSaveShortcut } from "@/utils/saveShortcut";
import { editorKeyAction, isCanvasKey, isTypingTarget, NO_REPEAT, type EditorKeyAction } from "./editorKeys";
import {
  pause,
  play,
  removeSelection,
  setEdgeAtPlayheadForSelection,
  splitAtPlayhead,
  stepBack,
  toggleMusicMute,
  togglePlay,
  toggleSelectedClipMute,
} from "./editorActions";

/** A dialog stacked over the editor (the discard sheet, the picker, anything else): it owns the keys. */
function stackedDialogOpen(root: HTMLElement | null): boolean {
  const s = useStitchEditorStore.getState();
  if (s.discardOpen || s.pickerOpen) return true;
  const overlays = document.querySelectorAll("[data-dialog-overlay]");
  const top = overlays[overlays.length - 1];
  return Boolean(top && root && !top.contains(root));
}

function run(action: EditorKeyAction, requestClose: () => void): void {
  const s = useStitchEditorStore.getState();
  switch (action) {
    case "togglePlay":
      return togglePlay();
    case "play":
      return play();
    case "pause":
      return pause();
    case "back":
      return stepBack();
    case "setIn":
      return setEdgeAtPlayheadForSelection("in");
    case "setOut":
      return setEdgeAtPlayheadForSelection("out");
    case "split":
      return splitAtPlayhead();
    case "remove":
      return removeSelection();
    case "toggleMusicMute":
      return toggleMusicMute();
    case "toggleClipMute":
      return toggleSelectedClipMute();
    case "undo":
      return s.undo();
    case "redo":
      return s.redo();
    case "escape":
      if (s.cancelGesture) return s.cancelGesture();
      return requestClose();
  }
}

/**
 * The editor's keys, taken at the window in the capture phase while it is
 * open: before React Flow's document listener, before WorkflowCanvas's
 * window listener, and before the Dialog's own Escape. An editor key is
 * handled and stopped. Every other key the canvas would act on (⌘Z, ⌘↵,
 * Shift+letters, ⌘V, ?) is stopped too, without preventDefault, so nothing
 * runs behind the dialog while Tab, the arrows and Enter keep their native
 * behaviour. ⌘S still saves. A text field, a stacked dialog and the clip
 * menu each keep their own keys.
 */
export function useStitchEditorKeys(rootRef: RefObject<HTMLElement | null>, requestClose: () => void): void {
  const isOpen = useStitchEditorStore((s) => s.isOpen);

  useEffect(() => {
    if (!isOpen) return;

    const onKeyDown = (e: KeyboardEvent) => {
      const shield = () => {
        if (isCanvasKey(e) && !isTypingTarget(e.target)) e.stopImmediatePropagation();
      };
      if (isSaveShortcut(e)) return;

      // A stacked dialog hears its own Escape (its Dialog listener); canvas keys stay off
      if (stackedDialogOpen(rootRef.current)) {
        if (e.key !== "Escape") shield();
        return;
      }

      // The clip menu: Escape closes it and nothing else; its own onKeyDown moves between rows
      const s = useStitchEditorStore.getState();
      if (s.menu) {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopImmediatePropagation();
          s.openMenu(null);
          return;
        }
        shield();
        return;
      }

      // A timecode field keeps its keys (Enter commits, Escape reverts, native undo)
      if (isTypingTarget(e.target)) return;

      const action = editorKeyAction(e);
      if (action) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.repeat && NO_REPEAT.has(action)) return;
        run(action, requestClose);
        return;
      }
      shield();
    };

    // A focused button would click on Space's keyup; the keydown already played
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== " " || isTypingTarget(e.target)) return;
      if (stackedDialogOpen(rootRef.current) || useStitchEditorStore.getState().menu) return;
      e.preventDefault();
    };

    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("keyup", onKeyUp, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("keyup", onKeyUp, { capture: true });
    };
  }, [isOpen, rootRef, requestClose]);
}
