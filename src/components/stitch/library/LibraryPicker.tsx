"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogButton,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { useStitchEditorStore, type StitchEditorState } from "@/store/stitchEditorStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { fetchFacets } from "@/lib/assets/client/api";
import type { AssetFacets, AssetKind, AssetView } from "@/lib/assets/types";
import { DEFAULT_LIBRARY_QUERY, type LibraryVideoQuery } from "@/lib/stitch/libraryRequest";
import { draftSpans } from "@/lib/stitch/draft";
import { clipName } from "@/lib/stitch/labels";
import { isPlaced } from "@/lib/stitch/timeline";
import { formatTimecode } from "@/lib/stitch/timecode";
import { addAssetClips, addAudioFromLibrary, drawnPlayhead } from "../editorActions";
import { STITCH_EDITOR_PANEL } from "../editorStyles";
import { LibraryResults } from "./LibraryResults";
import { FilterDivider, FilterRow, FilterSegments, FilterSwitch, LibrarySearch, SORT_OPTIONS } from "./LibrarySearch";
import { LibraryTile } from "./LibraryTile";
import { ProjectMenu } from "./ProjectMenu";
import { useLibraryAvailable } from "./useLibraryAvailable";
import { useLibraryVideos } from "./useLibraryVideos";

const NO_PROJECTS: AssetFacets["projects"] = [];
const VIDEO_KINDS: readonly AssetKind[] = ["video"];
const AUDIO_KINDS: readonly AssetKind[] = ["audio"];

const closePicker = () => useStitchEditorStore.getState().setPickerOpen(false);

/** The footer's buttons take the editor's white focus ring, not the dialogs' blue one. */
const FOOTER_RING = "focus-visible:ring-white/40";

/**
 * The clip new ones go after: the last row, or in a placed stack the clip that ends last (they start Overlap before
 * its end). -1 with no clip.
 */
function goesAfterIndex(s: StitchEditorState): number {
  const draft = s.draft;
  if (!draft || draft.timeline.length === 0) return -1;
  const last = draft.timeline.length - 1;
  if (draft.sequenceLayout.mode !== "stacked" || !isPlaced(draft.timeline)) return last;
  let latest: { index: number; end: number } | null = null;
  for (const span of draftSpans(draft, s.durations)) {
    if (span.length > 0 && (!latest || span.end >= latest.end)) latest = { index: span.index, end: span.end };
  }
  return latest?.index ?? last;
}

/**
 * "Add from library", over the Stitch editor: the library's videos (or, from
 * "+ Audio", its audio files) grouped by project, as the Edit video view's
 * library pane shows them, searched, and narrowed by project, favourites and
 * this workflow, newest or oldest first, in the search's filter popover.
 * Files are picked in order. Add appends one video clip each, in that order, after the last
 * clip; for audio it puts each file on a new audio row of its own, starting
 * at the playhead. The picker owns its query and its pages; it never touches
 * the Assets view's own list. Escape closes only the picker.
 */
export function LibraryPicker() {
  const open = useStitchEditorStore((s) => s.pickerOpen);
  if (!open) return null;
  return <OpenPicker key={open} kind={open} />;
}

function OpenPicker({ kind }: { kind: "video" | "audio" }) {
  const workflowId = useWorkflowStore((s) => s.workflowId);
  const afterIndex = useStitchEditorStore(goesAfterIndex);
  const playhead = useStitchEditorStore(drawnPlayhead);
  const libraryOn = useLibraryAvailable();
  const audio = kind === "audio";
  const [query, setQuery] = useState<LibraryVideoQuery>(DEFAULT_LIBRARY_QUERY);
  const list = useLibraryVideos(query, workflowId, libraryOn, audio ? AUDIO_KINDS : VIDEO_KINDS);
  const update = (patch: Partial<LibraryVideoQuery>) => setQuery((q) => ({ ...q, ...patch }));

  // Focus goes to the search through the Dialog (not autoFocus), so the Dialog records the + that opened it and
  // gives focus back to it. After an Add, the first added clip takes it instead: focusing it scrolls the lanes
  // to it (a zoomed-in timeline may have it far off to the right), and the keyboard lands on what was added.
  // When neither is there (the empty lane's placeholder is gone), the editor's panel takes it, so its keys and
  // its Tab trap keep working.
  const searchRef = useRef<HTMLInputElement>(null);
  const added = useRef(false);
  useEffect(
    () => () => {
      const wasAdd = added.current;
      requestAnimationFrame(() => {
        const panel = document.querySelector<HTMLElement>(`[${STITCH_EDITOR_PANEL}]`);
        if (wasAdd) {
          const selection = useStitchEditorStore.getState().selection;
          const box = selection
            ? panel?.querySelector<HTMLElement>(
                selection.kind === "audio"
                  ? `[role="option"][data-audio-clip-id="${CSS.escape(selection.clipId)}"]`
                  : `[role="option"][data-clip-id="${CSS.escape(selection.clipId)}"]`,
              )
            : null;
          if (box) {
            box.focus();
            return;
          }
        }
        const active = document.activeElement;
        if (active && active !== document.body && active.isConnected) return;
        panel?.focus({ preventScroll: true });
      });
    },
    [],
  );
  const add = () => {
    added.current = true;
    if (audio) addAudioFromLibrary(picked);
    else addAssetClips(picked);
  };

  // The scrim closes the picker only for a press that starts and ends on it: a drag out of the search field
  // that is let go over the scrim is not a click on it, and must not drop the picks
  const pressedScrim = useRef(false);

  /** In the order they were picked; kept across filter changes, so a pick is never lost by narrowing the list. */
  const [picked, setPicked] = useState<AssetView[]>([]);
  const toggle = useCallback(
    (asset: AssetView) =>
      setPicked((prev) => (prev.some((a) => a.id === asset.id) ? prev.filter((a) => a.id !== asset.id) : [...prev, asset])),
    [],
  );

  const [projects, setProjects] = useState<AssetFacets["projects"]>(NO_PROJECTS);
  useEffect(() => {
    if (!libraryOn) return;
    const controller = new AbortController();
    fetchFacets(controller.signal).then(
      (facets) => setProjects(facets.projects),
      () => {
        // The menu then offers All projects only
      },
    );
    return () => controller.abort();
  }, [libraryOn]);

  const pickedIds = new Set(picked.map((a) => a.id));
  const pickedSec = picked.reduce((sum, a) => sum + (a.durationSec ?? 0), 0);
  const n = picked.length;
  const where = audio
    ? `${n === 1 ? "starts" : "each starts"} at ${formatTimecode(playhead)} on a new row`
    : afterIndex >= 0
      ? `goes after ${clipName(afterIndex)}`
      : "goes first";
  const filtered = query.q.trim() !== "" || query.project !== null || query.favourites || query.thisWorkflow;
  // The dot on the filter button: anything in its popover not at its default
  const filtersOn = query.project !== null || query.favourites || query.thisWorkflow || query.sort !== "newest";

  return (
    <Dialog
      open
      onClose={closePicker}
      size="lg"
      portal
      initialFocusRef={searchRef}
      closeOnBackdrop={false}
      overlayProps={{
        onPointerDown: (event) => {
          pressedScrim.current = event.target === event.currentTarget;
        },
        onClick: (event) => {
          if (event.target === event.currentTarget && pressedScrim.current) closePicker();
          pressedScrim.current = false;
        },
      }}
      className="max-w-[880px] h-[min(580px,85vh)]"
    >
      <DialogHeader divider>
        <DialogTitle>{audio ? "Add audio from the library" : "Add from library"}</DialogTitle>
        <DialogDescription>
          {audio
            ? "Audio saved in your Node Banana folder. Each picked file goes on a new audio row, starting at the playhead."
            : "Videos saved in your Node Banana folder. A picked clip goes on the timeline after the last one and keeps its link to the library."}
        </DialogDescription>
      </DialogHeader>

      <div className="flex shrink-0 items-center px-5 py-2.5">
        <LibrarySearch
          inputRef={searchRef}
          className="w-[260px]"
          label={audio ? "Search audio" : "Search videos"}
          placeholder={audio ? "Search audio" : "Search videos"}
          value={query.q}
          onChange={(q) => update({ q })}
          disabled={!libraryOn}
          filtered={filtersOn}
          filters={
            <>
              <FilterRow label="Project">
                <ProjectMenu value={query.project} projects={projects} onChange={(project) => update({ project })} />
              </FilterRow>
              <FilterSwitch label="Favorites" checked={query.favourites} onChange={(favourites) => update({ favourites })} />
              <FilterSwitch
                label="This workflow"
                checked={query.thisWorkflow}
                disabled={workflowId === null}
                title={workflowId === null ? "Nothing from this workflow is in the library yet" : undefined}
                onChange={(thisWorkflow) => update({ thisWorkflow })}
              />
              <FilterDivider />
              <FilterRow label="Sort">
                <FilterSegments label="Sort" value={query.sort} options={SORT_OPTIONS} onChange={(sort) => update({ sort })} />
              </FilterRow>
            </>
          }
        />
      </div>

      <LibraryResults
        libraryOn={libraryOn}
        list={list}
        emptyText={!audio ? "No videos match" : filtered ? "No audio matches" : "No audio in the library yet"}
        layout="picker"
        testId="stitch-library-grid"
        className="px-5 pt-1 pb-4"
        renderTile={(asset, { scrollRoot, posterReady }) => (
          <LibraryTile
            asset={asset}
            selected={pickedIds.has(asset.id)}
            posterReady={posterReady}
            scrollRoot={scrollRoot}
            onToggle={toggle}
          />
        )}
      />

      <DialogFooter>
        <div className="mr-auto flex min-w-0 items-center gap-2 text-xs">
          {n > 0 ? (
            <>
              <span className="text-neutral-400">{n} selected</span>
              <span aria-hidden="true" className="text-neutral-600">
                ·
              </span>
              <span className="font-mono tabular-nums text-neutral-400">{formatTimecode(pickedSec)}</span>
              <span className="ml-1 text-neutral-500">{where}</span>
            </>
          ) : (
            <span className="text-neutral-400">{audio ? "Pick audio files to add" : "Pick videos to add"}</span>
          )}
        </div>
        <DialogButton variant="ghost" className={FOOTER_RING} onClick={closePicker}>
          Cancel
        </DialogButton>
        <DialogButton variant="primary" className={FOOTER_RING} disabled={n === 0} onClick={add}>
          {n === 0
            ? "Add clips"
            : audio
              ? `Add ${n} audio clip${n === 1 ? "" : "s"}`
              : `Add ${n} clip${n === 1 ? "" : "s"}`}
        </DialogButton>
      </DialogFooter>
    </Dialog>
  );
}
