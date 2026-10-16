"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Star } from "lucide-react";
import { cn } from "@/components/nodes/ui/cn";
import {
  Dialog,
  DialogButton,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogSearchField,
  DialogSpinner,
  DialogTitle,
} from "@/components/ui/Dialog";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { fetchFacets } from "@/lib/assets/client/api";
import { onPosterReady } from "@/lib/assets/client/poster";
import type { AssetFacets, AssetView } from "@/lib/assets/types";
import { DEFAULT_LIBRARY_QUERY, type LibraryVideoQuery } from "@/lib/stitch/libraryRequest";
import { clipName } from "@/lib/stitch/labels";
import { formatTimecode } from "@/lib/stitch/timecode";
import { addAssetClips } from "../editorActions";
import { STITCH_EDITOR_PANEL } from "../editorStyles";
import { LibraryTile } from "./LibraryTile";
import { ProjectMenu } from "./ProjectMenu";
import { SortMenu } from "./SortMenu";
import { useLibraryAvailable } from "./useLibraryAvailable";
import { useLibraryVideos } from "./useLibraryVideos";

/** Toolbar toggles: 32px with a hairline border, the pressed one filled and borderless (Library board). */
const FILTER_BUTTON =
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection disabled:cursor-not-allowed disabled:opacity-50";
const FILTER_OFF = "border-card-border text-neutral-400 hover:text-neutral-200 hover:bg-white/[0.03] disabled:hover:bg-transparent disabled:hover:text-neutral-400";
const FILTER_ON = "border-transparent bg-white/10 text-neutral-100";

const NO_PROJECTS: AssetFacets["projects"] = [];

const closePicker = () => useStitchEditorStore.getState().setPickerOpen(false);

/**
 * "Add from library", over the Stitch editor: the library's videos, searched
 * and narrowed by project, favourites and this workflow, newest or oldest
 * first. Videos are picked in order, and Add appends one clip each, in that
 * order, after the last clip. The picker owns its query and its pages; it
 * never touches the Assets view's own list. Escape closes only the picker.
 */
export function LibraryPicker() {
  const open = useStitchEditorStore((s) => s.pickerOpen);
  if (!open) return null;
  return <OpenPicker />;
}

function OpenPicker() {
  const workflowId = useWorkflowStore((s) => s.workflowId);
  const clipCount = useStitchEditorStore((s) => s.draft?.timeline.length ?? 0);
  const libraryOn = useLibraryAvailable();
  const [query, setQuery] = useState<LibraryVideoQuery>(DEFAULT_LIBRARY_QUERY);
  const { assets, loading, loadingMore, error, moreError, hasMore, loadMore, retry, listingKey } = useLibraryVideos(
    query,
    workflowId,
    libraryOn,
  );
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
          const clipId = selection?.kind === "clip" ? selection.clipId : null;
          const box = clipId
            ? panel?.querySelector<HTMLElement>(`[role="option"][data-clip-id="${CSS.escape(clipId)}"]`)
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
    addAssetClips(picked);
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

  // A poster made for a tile since its page was read: the tile asks for its thumbnail again
  const [posters, setPosters] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => onPosterReady((id) => setPosters((prev) => new Set(prev).add(id))), []);

  // The next page comes as the end of the grid scrolls near
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

  // A new query's list starts at the top, as the Assets view's does: its newest matches are not left above the view
  useLayoutEffect(() => {
    if (scrollEl.current) scrollEl.current.scrollTop = 0;
  }, [listingKey]);

  const pickedIds = new Set(picked.map((a) => a.id));
  const pickedSec = picked.reduce((sum, a) => sum + (a.durationSec ?? 0), 0);
  const where = clipCount > 0 ? `goes after ${clipName(clipCount - 1)}` : "goes first";
  const n = picked.length;

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
      <div role="status" className="flex h-full items-center justify-center gap-3 text-xs text-neutral-500">
        <span>{error}</span>
        <DialogButton variant="ghost" compact onClick={retry}>
          Try again
        </DialogButton>
      </div>
    );
  }
  else if (assets.length === 0) body = <Notice>No videos match</Notice>;
  else {
    body = (
      <>
        <div
          className={cn("grid grid-cols-4 gap-x-3 gap-y-3.5 transition-opacity", loading && "opacity-60")}
          aria-busy={loading || undefined}
        >
          {assets.map((asset) => (
            <LibraryTile
              key={asset.id}
              asset={asset}
              selected={pickedIds.has(asset.id)}
              posterReady={posters.has(asset.id)}
              scrollRoot={scrollRoot}
              onToggle={toggle}
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
            <div role="status" className="flex items-center justify-center gap-3 py-3 text-xs text-neutral-500">
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
        <DialogTitle>Add from library</DialogTitle>
        <DialogDescription>
          Videos saved in your Node Banana folder. A picked clip goes on the timeline after the last one and keeps its
          link to the library.
        </DialogDescription>
      </DialogHeader>

      <div className="flex shrink-0 items-center gap-2 px-5 py-2.5">
        <DialogSearchField
          ref={searchRef}
          className="w-[260px] shrink-0"
          placeholder="Search videos"
          aria-label="Search videos"
          value={query.q}
          onChange={(event) => update({ q: event.target.value })}
          disabled={!libraryOn}
        />
        <ProjectMenu value={query.project} projects={projects} onChange={(project) => update({ project })} />
        <span className={cn(FILTER_BUTTON, FILTER_ON)}>Videos</span>
        <button
          type="button"
          aria-pressed={query.favourites}
          onClick={() => update({ favourites: !query.favourites })}
          className={cn(FILTER_BUTTON, query.favourites ? FILTER_ON : FILTER_OFF)}
        >
          <Star size={12} strokeWidth={2} />
          Favourites
        </button>
        <button
          type="button"
          aria-pressed={query.thisWorkflow}
          disabled={workflowId === null}
          title={workflowId === null ? "Nothing from this workflow is in the library yet" : undefined}
          onClick={() => update({ thisWorkflow: !query.thisWorkflow })}
          className={cn(FILTER_BUTTON, query.thisWorkflow ? FILTER_ON : FILTER_OFF)}
        >
          This workflow
        </button>
        <div className="flex-1" />
        <SortMenu value={query.sort} onChange={(sort) => update({ sort })} />
      </div>

      {/* DialogBody's own shape, as a plain element: the sentinel and the tiles observe it as their root */}
      <div ref={scrollRootRef} className="min-h-0 flex-1 overflow-y-auto px-5 pt-0.5 pb-4" data-testid="stitch-library-grid">
        {body}
      </div>

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
            <span className="text-neutral-400">Pick videos to add</span>
          )}
        </div>
        <DialogButton variant="ghost" onClick={closePicker}>
          Cancel
        </DialogButton>
        <DialogButton variant="primary" disabled={n === 0} onClick={add}>
          {n === 0 ? "Add clips" : `Add ${n} clip${n === 1 ? "" : "s"}`}
        </DialogButton>
      </DialogFooter>
    </Dialog>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return <div className="flex h-full items-center justify-center text-xs text-neutral-500">{children}</div>;
}
