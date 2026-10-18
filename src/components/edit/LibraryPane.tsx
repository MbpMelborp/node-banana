"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { PanelLeftClose, Star } from "lucide-react";
import { cn } from "@/components/nodes/ui/cn";
import { DialogButton, DialogSearchField, DialogSpinner } from "@/components/ui/Dialog";
import { Tooltip } from "@/components/ui/Tooltip";
import { AssetPlaceholder, tileThumbUrl } from "@/components/assets/AssetTile";
import { fetchFacets } from "@/lib/assets/client/api";
import { onPosterReady } from "@/lib/assets/client/poster";
import { onAssetRecorded } from "@/lib/assets/client/recorder";
import type { AssetFacets, AssetView } from "@/lib/assets/types";
import { WAITING_FOR_CLIPS } from "@/lib/stitch/libraryInsert";
import { DEFAULT_LIBRARY_QUERY, libraryKinds, type LibraryVideoQuery } from "@/lib/stitch/libraryRequest";
import { formatTimecode } from "@/lib/stitch/timecode";
import { addLibraryItemAt, libraryAddBlockedReason } from "@/components/stitch/editorActions";
import { EDITOR_CHIP, ICON_BUTTON, LIFTED_CLIP } from "@/components/stitch/editorStyles";
import { FILTER_BUTTON, FILTER_OFF, FILTER_ON } from "@/components/stitch/library/filterStyles";
import { LibraryTile } from "@/components/stitch/library/LibraryTile";
import { ProjectMenu } from "@/components/stitch/library/ProjectMenu";
import { SortMenu } from "@/components/stitch/library/SortMenu";
import { useLibraryAvailable } from "@/components/stitch/library/useLibraryAvailable";
import { useLibraryVideos } from "@/components/stitch/library/useLibraryVideos";
import { useEditProjectStore, type EditPaneKind } from "@/store/editProjectStore";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { useLibraryDrag, type LibraryDragGhost } from "./useLibraryDrag";

const NO_PROJECTS: AssetFacets["projects"] = [];
const KIND_OPTIONS: { value: EditPaneKind; label: string }[] = [
  { value: "all", label: "All" },
  { value: "video", label: "Video" },
  { value: "audio", label: "Audio" },
];
/** The ghost's poster, 16:9. */
const GHOST_WIDTH = 112;

const VIDEO_ITEM = { assetId: "", kind: "video", durationSec: null } as const;

/**
 * The last "+" request a pane acted on. Module state, so a pane shown again by "Show the library" does not take
 * focus for a request an earlier pane already answered; the store's count going back (a reset) starts it again.
 */
let focusHandled = 0;

/** Why a video cannot be added at the playhead now (one answer for every video tile), or null. */
function useVideoAddBlocked(): string | null {
  const loading = useEditProjectStore((s) => s.clipsLoading);
  return useStitchEditorStore((s) => libraryAddBlockedReason(VIDEO_ITEM, s, loading));
}

/**
 * The Edit video view's library pane, beside the timeline: the asset
 * library's videos and audio from every project, searched, narrowed by
 * project, kind and favourites, newest or oldest first. A click (or Enter)
 * on a tile adds it at the playhead; a drag puts it where it is dropped on
 * the timeline. A recording that lands while the pane is open never reloads
 * the list by itself (a new first tile would move every tile, perhaps under
 * a press): "N new · Show", in a row kept for it, loads the first page again.
 */
export function LibraryPane() {
  const kind = useEditProjectStore((s) => s.pane.kind);
  const focusRequest = useEditProjectStore((s) => s.pane.focusRequest);
  const libraryOn = useLibraryAvailable();
  const [query, setQuery] = useState<LibraryVideoQuery>(DEFAULT_LIBRARY_QUERY);
  const { assets, loading, loadingMore, error, moreError, hasMore, loadMore, retry, listingKey } = useLibraryVideos(
    query,
    null,
    libraryOn,
    libraryKinds(kind),
  );
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

  const [posters, setPosters] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => onPosterReady((id) => setPosters((prev) => new Set(prev).add(id))), []);

  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);
  const scrollEl = useRef<HTMLDivElement | null>(null);
  const scrollRootRef = useCallback((el: HTMLDivElement | null) => {
    scrollEl.current = el;
    setScrollRoot(el);
  }, []);
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !scrollRoot || !hasMore || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => entry?.isIntersecting && loadMore(), {
      root: scrollRoot,
      rootMargin: "240px",
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [scrollRoot, hasMore, loadMore]);
  useLayoutEffect(() => {
    if (scrollEl.current) scrollEl.current.scrollTop = 0;
  }, [listingKey]);

  const { consumeClick, onPointerDown } = drag;
  const add = useCallback(
    (asset: AssetView) => {
      if (consumeClick()) return;
      addLibraryItemAt(asset);
    },
    [consumeClick],
  );

  const filtered = query.q.trim() !== "" || query.project !== null || query.favourites;
  let body: ReactNode;
  if (!libraryOn) body = <Notice>The asset library is off.</Notice>;
  else if (assets.length === 0 && loading) {
    body = (
      <div className="flex h-full items-center justify-center" aria-busy>
        <DialogSpinner />
      </div>
    );
  } else if (assets.length === 0 && error) {
    body = (
      <div role="status" className="flex h-full flex-col items-center justify-center gap-2 px-2 text-center text-xs text-neutral-500">
        <span>{error}</span>
        <DialogButton variant="ghost" compact onClick={retry}>
          Try again
        </DialogButton>
      </div>
    );
  } else if (assets.length === 0) {
    body = <Notice>{filtered ? "No videos or audio match" : "Nothing in the library yet"}</Notice>;
  } else {
    body = (
      <>
        <div className={cn("grid grid-cols-2 gap-x-2 gap-y-3", loading && "opacity-60")} aria-busy={loading || undefined}>
          {assets.map((asset) => (
            <LibraryTile
              key={asset.id}
              asset={asset}
              selected={false}
              posterReady={posters.has(asset.id)}
              scrollRoot={scrollRoot}
              onToggle={add}
              mode="add"
              disabledReason={asset.kind === "video" ? videoBlocked : null}
              onPointerDown={onPointerDown}
            />
          ))}
        </div>
        <div ref={sentinelRef} aria-hidden="true" className="h-px" />
        {loadingMore ? (
          <div className="flex justify-center py-3">
            <DialogSpinner />
          </div>
        ) : (
          moreError && (
            <div role="status" className="flex flex-col items-center gap-2 py-3 text-xs text-neutral-500">
              <span>{moreError}</span>
              <DialogButton variant="ghost" compact onClick={loadMore}>
                Try again
              </DialogButton>
            </div>
          )
        )}
      </>
    );
  }

  return (
    <aside
      aria-label="Library"
      data-edit-chrome
      className="flex w-[240px] shrink-0 flex-col border-r border-chrome-border bg-pane"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 pl-4 pr-2">
        <span className="text-[13px] font-semibold text-neutral-100">Library</span>
        {/* Between the title and the button, so the chip appearing moves neither */}
        <div className="flex min-w-0 flex-1 justify-end" data-testid="library-arrivals">
          {arrivals > 0 && (
            <button
              type="button"
              onClick={showArrivals}
              className={cn(
                EDITOR_CHIP,
                "truncate text-neutral-200 hover:bg-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection",
              )}
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
            className={ICON_BUTTON}
            onClick={() => useEditProjectStore.getState().setPaneOpen(false)}
          >
            <PanelLeftClose size={16} strokeWidth={1.75} />
          </button>
          <Tooltip label="Hide the library" placement="bottom" />
        </div>
      </div>
      <div className="flex shrink-0 flex-col gap-2 px-4">
        <DialogSearchField
          ref={searchRef}
          placeholder="Search videos and audio"
          aria-label="Search the library"
          value={query.q}
          onChange={(event) => update({ q: event.target.value })}
          disabled={!libraryOn}
        />
        <div className="flex min-w-0 items-center gap-1">
          <ProjectMenu value={query.project} projects={projects} onChange={(project) => update({ project })} />
          <div className="flex-1" />
          <SortMenu value={query.sort} onChange={(sort) => update({ sort })} short />
        </div>
        <div className="flex items-center gap-1">
          <div role="radiogroup" aria-label="Kind" className="flex items-center gap-1">
            {KIND_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={kind === option.value}
                onClick={() => useEditProjectStore.getState().setPaneKind(option.value)}
                className={cn(FILTER_BUTTON, "h-7 px-2", kind === option.value ? FILTER_ON : FILTER_OFF)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="flex-1" />
          <div className="group relative flex">
            <button
              type="button"
              aria-label="Favourites"
              aria-pressed={query.favourites}
              onClick={() => update({ favourites: !query.favourites })}
              className={cn(FILTER_BUTTON, "h-7 w-7 justify-center px-0", query.favourites ? FILTER_ON : FILTER_OFF)}
            >
              <Star size={12} strokeWidth={2} fill={query.favourites ? "currentColor" : "none"} />
            </button>
            <Tooltip label="Favourites" placement="bottom" />
          </div>
        </div>
      </div>
      <div ref={scrollRootRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3" data-testid="edit-library-grid">
        {body}
      </div>
      <p className="shrink-0 border-t border-chrome-border px-4 py-2.5 text-[11px] leading-4 text-neutral-500">
        Click to add at the playhead, or drag onto the timeline.
      </p>
      {drag.ghost && <DragGhost ghost={drag.ghost} />}
    </aside>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return <div className="flex h-full items-center justify-center px-2 text-center text-xs text-neutral-500">{children}</div>;
}

/** What follows the pointer while a tile is dragged: its poster (or the audio mark), name and length. */
function DragGhost({ ghost }: { ghost: LibraryDragGhost }) {
  const { asset } = ghost;
  const duration = typeof asset.durationSec === "number" && asset.durationSec > 0 ? asset.durationSec : null;
  return (
    <div
      aria-hidden="true"
      data-testid="library-drag-ghost"
      className="pointer-events-none fixed z-100 flex flex-col gap-1"
      style={{ left: ghost.x + 12, top: ghost.y + 12, width: GHOST_WIDTH }}
    >
      <div className={cn("relative aspect-video w-full overflow-hidden rounded-media bg-well ring-1 ring-white/10", LIFTED_CLIP)}>
        {asset.kind === "audio" ? (
          <AssetPlaceholder kind="audio" size={20} />
        ) : asset.hasPoster ? (
          // eslint-disable-next-line @next/next/no-img-element -- a library thumbnail route
          <img src={tileThumbUrl(asset, GHOST_WIDTH)} alt="" draggable={false} className="h-full w-full object-cover" />
        ) : (
          <AssetPlaceholder kind="video" size={20} />
        )}
      </div>
      <span className={cn(EDITOR_CHIP, "self-start whitespace-nowrap text-neutral-200")}>
        {ghost.waiting ? WAITING_FOR_CLIPS : duration !== null ? `${asset.filename} · ${formatTimecode(duration, 1)}` : asset.filename}
      </span>
    </div>
  );
}
