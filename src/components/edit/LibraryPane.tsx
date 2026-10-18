"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Music, PanelLeftClose } from "lucide-react";
import { cn } from "@/components/nodes/ui/cn";
import { Tooltip } from "@/components/ui/Tooltip";
import { tileThumbUrl } from "@/components/assets/AssetTile";
import { fetchFacets } from "@/lib/assets/client/api";
import { onAssetRecorded } from "@/lib/assets/client/recorder";
import type { AssetFacets, AssetView } from "@/lib/assets/types";
import { WAITING_FOR_CLIPS } from "@/lib/stitch/libraryInsert";
import { DEFAULT_LIBRARY_QUERY, libraryKinds, type LibraryVideoQuery } from "@/lib/stitch/libraryRequest";
import { formatTimecode } from "@/lib/stitch/timecode";
import { addLibraryItemAt, libraryAddBlockedReason } from "@/components/stitch/editorActions";
import { EDITOR_CHIP, HEADER_ICON_BUTTON, LIFTED_CLIP } from "@/components/stitch/editorStyles";
import { LibraryResults } from "@/components/stitch/library/LibraryResults";
import {
  FilterDivider,
  FilterRow,
  FilterSegments,
  FilterSwitch,
  LibrarySearch,
  SORT_OPTIONS,
} from "@/components/stitch/library/LibrarySearch";
import { BlankCover, CoverLength, LibraryTile } from "@/components/stitch/library/LibraryTile";
import { ProjectMenu } from "@/components/stitch/library/ProjectMenu";
import { useLibraryAvailable } from "@/components/stitch/library/useLibraryAvailable";
import { useLibraryVideos } from "@/components/stitch/library/useLibraryVideos";
import { useEditProjectStore, type EditPaneKind } from "@/store/editProjectStore";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { useLibraryDrag, useLibraryDragGhost } from "./useLibraryDrag";

const NO_PROJECTS: AssetFacets["projects"] = [];
const KIND_OPTIONS: { value: EditPaneKind; label: string }[] = [
  { value: "all", label: "All" },
  { value: "video", label: "Video" },
  { value: "audio", label: "Audio" },
];
/** The ghost's cover, as wide as a tile's; an audio file's row. */
const GHOST_WIDTH = 112;
const GHOST_ROW_WIDTH = 200;

const VIDEO_ITEM = { assetId: "", kind: "video", durationSec: null } as const;

/**
 * The last "+" request a pane acted on. Module state, so a pane shown again by "Show the library" does not take
 * focus for a request an earlier pane already answered; the store's count going back (a reset) starts it again.
 */
let focusHandled = 0;

/** Why a video cannot be added at the playhead now (one answer for every video tile), or null. */
function useVideoAddBlocked(): string | null {
  return useStitchEditorStore((s) => libraryAddBlockedReason(VIDEO_ITEM, s));
}

/**
 * The Edit video view's library pane, beside the timeline: the asset
 * library's videos and audio from every project, grouped by project, under
 * one search whose filter button holds the rest: kind, project, favourites,
 * newest or oldest first. A click (or Enter) on a tile adds it at the
 * playhead; a drag puts it where it is dropped on the timeline (which the
 * tiles' tooltip says). A recording that lands while the pane is open never
 * reloads the list by itself (a new first tile would move every tile,
 * perhaps under a press): "N new · Show", in the top row, loads the first
 * page again.
 */
export function LibraryPane() {
  const kind = useEditProjectStore((s) => s.pane.kind);
  const focusRequest = useEditProjectStore((s) => s.pane.focusRequest);
  const libraryOn = useLibraryAvailable();
  const [query, setQuery] = useState<LibraryVideoQuery>(DEFAULT_LIBRARY_QUERY);
  const list = useLibraryVideos(query, null, libraryOn, libraryKinds(kind));
  const { retry, listingKey } = list;
  const update = (patch: Partial<LibraryVideoQuery>) => setQuery((q) => ({ ...q, ...patch }));
  const videoBlocked = useVideoAddBlocked();
  const drag = useLibraryDrag();

  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusRequest < focusHandled) focusHandled = 0;
    if (focusRequest <= focusHandled) return;
    focusHandled = focusRequest;
    searchRef.current?.focus();
  }, [focusRequest]);

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

  // Recordings that landed since the list shown was read, of the kinds it shows: held until Show. A new list
  // (search, filter, sort or Show) has them, so the count belongs to the list it was counted against
  const [held, setHeld] = useState<{ key: string | null; count: number }>({ key: null, count: 0 });
  const shownKey = useRef(listingKey);
  useEffect(() => {
    shownKey.current = listingKey;
  });
  useEffect(() => {
    if (!libraryOn) return;
    const kinds = libraryKinds(kind);
    return onAssetRecorded(({ asset }) => {
      if (!kinds.includes(asset.kind)) return;
      const key = shownKey.current;
      setHeld((prev) => ({ key, count: (prev.key === key ? prev.count : 0) + 1 }));
    });
  }, [libraryOn, kind]);
  const arrivals = held.key === listingKey ? held.count : 0;
  const showArrivals = () => {
    setHeld({ key: null, count: 0 });
    retry();
  };

  const { consumeClick, onPointerDown } = drag;
  const add = useCallback(
    (asset: AssetView) => {
      if (consumeClick()) return;
      addLibraryItemAt(asset);
    },
    [consumeClick],
  );

  const filtered = query.q.trim() !== "" || query.project !== null || query.favourites;
  // The dot on the filter button: anything in its popover not at its default
  const filtersOn = kind !== "all" || query.project !== null || query.favourites || query.sort !== "newest";

  return (
    <aside aria-label="Library" data-edit-chrome className="flex w-[264px] shrink-0 flex-col border-r border-edit-line bg-pane">
      <div className="flex h-14 shrink-0 items-center gap-2 pl-4 pr-2">
        <h2 className="text-[13px] font-medium text-neutral-400">Library</h2>
        {/* Between the title and the button, so the line appearing moves neither */}
        <div className="flex min-w-0 flex-1 justify-end" data-testid="library-arrivals">
          {arrivals > 0 && (
            <button
              type="button"
              onClick={showArrivals}
              className="h-6 min-w-0 truncate rounded-md px-1.5 text-xs text-ink-3 transition-colors hover:bg-white/6 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
            >
              {`${arrivals} new · Show`}
            </button>
          )}
        </div>
        <div className="group relative flex shrink-0">
          <button
            type="button"
            aria-label="Hide the library"
            aria-expanded
            // It says the pane is open, but is not drawn as an open control
            className={cn(HEADER_ICON_BUTTON, "aria-expanded:bg-transparent aria-expanded:text-neutral-400 aria-expanded:hover:bg-white/6 aria-expanded:hover:text-neutral-100")}
            onClick={() => useEditProjectStore.getState().setPaneOpen(false)}
          >
            <PanelLeftClose size={16} strokeWidth={1.5} />
          </button>
          <Tooltip label="Hide the library" placement="bottom" />
        </div>
      </div>
      <LibrarySearch
        inputRef={searchRef}
        className="mx-4 shrink-0"
        label="Search the library"
        value={query.q}
        onChange={(q) => update({ q })}
        // Escape leaves the field, as in Assets, so E, Space and the editor's keys work again
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.currentTarget.blur();
        }}
        disabled={!libraryOn}
        filtered={filtersOn}
        filters={
          <>
            <FilterRow label="Kind">
              <FilterSegments
                label="Kind"
                value={kind}
                options={KIND_OPTIONS}
                onChange={(value) => useEditProjectStore.getState().setPaneKind(value)}
              />
            </FilterRow>
            <FilterRow label="Project">
              <ProjectMenu value={query.project} projects={projects} onChange={(project) => update({ project })} />
            </FilterRow>
            <FilterSwitch label="Favorites" checked={query.favourites} onChange={(favourites) => update({ favourites })} />
            <FilterDivider />
            <FilterRow label="Sort">
              <FilterSegments label="Sort" value={query.sort} options={SORT_OPTIONS} onChange={(sort) => update({ sort })} />
            </FilterRow>
          </>
        }
      />
      <LibraryResults
        libraryOn={libraryOn}
        list={list}
        emptyText={filtered ? "No videos or audio match" : "Nothing in the library yet"}
        layout="pane"
        testId="edit-library-grid"
        className="px-4 pt-5 pb-4"
        renderTile={(asset, { scrollRoot, posterReady }) => (
          <LibraryTile
            asset={asset}
            selected={false}
            posterReady={posterReady}
            scrollRoot={scrollRoot}
            onToggle={add}
            mode="add"
            disabledReason={asset.kind === "video" ? videoBlocked : null}
            onPointerDown={onPointerDown}
          />
        )}
      />
      <DragGhost />
    </aside>
  );
}

/**
 * What follows the pointer while a tile is dragged: the tile itself, lifted. A video's cover and its length (with why
 * it cannot land there yet, while it cannot), or a sound's row.
 */
function DragGhost() {
  const ghost = useLibraryDragGhost();
  if (!ghost) return null;
  const { asset } = ghost;
  const duration = typeof asset.durationSec === "number" && asset.durationSec > 0 ? asset.durationSec : null;
  const place = { left: ghost.x + 12, top: ghost.y + 12 };
  if (asset.kind === "audio") {
    return (
      <div
        aria-hidden="true"
        data-testid="library-drag-ghost"
        className={cn(
          "pointer-events-none fixed z-100 flex h-8 items-center gap-2 rounded-md bg-edit-field px-2 ring-1 ring-white/10",
          LIFTED_CLIP,
        )}
        style={{ ...place, width: GHOST_ROW_WIDTH }}
      >
        <Music size={14} strokeWidth={1.5} className="shrink-0 text-ink-3" />
        <span className="min-w-0 flex-1 truncate text-xs text-neutral-200">{asset.filename}</span>
        {duration !== null && <span className="shrink-0 text-[11px] tabular-nums text-ink-3">{formatTimecode(duration, 0)}</span>}
      </div>
    );
  }
  return (
    <div
      aria-hidden="true"
      data-testid="library-drag-ghost"
      className="pointer-events-none fixed z-100 flex flex-col gap-1"
      style={{ ...place, width: GHOST_WIDTH }}
    >
      <div className={cn("relative aspect-video w-full overflow-hidden rounded-md bg-edit-field ring-1 ring-white/10", LIFTED_CLIP)}>
        {asset.hasPoster ? (
          // eslint-disable-next-line @next/next/no-img-element -- a library thumbnail route
          <img src={tileThumbUrl(asset, GHOST_WIDTH)} alt="" draggable={false} className="h-full w-full object-cover" />
        ) : (
          <BlankCover />
        )}
        {duration !== null && <CoverLength seconds={duration} />}
      </div>
      {ghost.waiting && <span className={cn(EDITOR_CHIP, "self-start whitespace-nowrap text-neutral-200")}>{WAITING_FOR_CLIPS}</span>}
    </div>
  );
}
