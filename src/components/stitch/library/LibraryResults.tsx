"use client";

import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "@/components/nodes/ui/cn";
import { DialogSpinner } from "@/components/ui/Dialog";
import { projectLabel } from "@/components/assets/assetFormat";
import { onPosterReady } from "@/lib/assets/client/poster";
import type { AssetView } from "@/lib/assets/types";
import { QUIET_BUTTON } from "../editorStyles";
import type { useLibraryVideos } from "./useLibraryVideos";

export interface LibraryGroup {
  /** The project's folder, "" for not in a project. */
  key: string;
  label: string;
  videos: AssetView[];
  audio: AssetView[];
}

/**
 * The list's files by project, each project where its first file comes in the list (newest first, the project of
 * the newest file leads), its files in the list's order: the videos, then the audio files.
 */
export function groupByProject(assets: readonly AssetView[]): LibraryGroup[] {
  const groups = new Map<string, LibraryGroup>();
  for (const asset of assets) {
    const path = asset.workflow?.projectPath ?? null;
    const key = path ?? "";
    let group = groups.get(key);
    if (!group) {
      group = { key, label: projectLabel(path), videos: [], audio: [] };
      groups.set(key, group);
    }
    (asset.kind === "audio" ? group.audio : group.videos).push(asset);
  }
  return [...groups.values()];
}

/** What a tile is given beside its file: the scroll area it is seen in, and whether a poster was made for it since. */
export interface LibraryTileContext {
  scrollRoot: HTMLElement | null;
  posterReady: boolean;
}

/**
 * The pane's narrow column: two covers a row, one sound a row. The picker's: four covers, two sounds. The quiet
 * text (group labels, notices): ink-3 on the pane; neutral-400 on the picker's lighter card, where ink-3 falls
 * under 4.5:1.
 */
const GRID = {
  pane: { covers: "grid-cols-2 gap-2", sounds: "grid-cols-1 gap-1", muted: "text-ink-3" },
  picker: { covers: "grid-cols-4 gap-3", sounds: "grid-cols-2 gap-x-3 gap-y-1", muted: "text-neutral-400" },
} as const;

/**
 * The scroll area under the library's search, in the pane and in the
 * picker: the list grouped by project (a quiet label, the covers in a grid,
 * the sounds as rows under them), or what stands in for it (the library
 * off, the first page loading, failing with Try again, or nothing to show).
 * The next page comes as the end of the list scrolls near; one that fails
 * says so with Try again, and the list stays. A new query's list starts at
 * the top. A poster made for a tile since its page was read is passed on, so
 * the tile asks for its thumbnail again.
 */
export function LibraryResults({
  libraryOn,
  list,
  emptyText,
  layout,
  renderTile,
  className,
  testId,
}: {
  libraryOn: boolean;
  list: ReturnType<typeof useLibraryVideos>;
  /** Nothing to show: "Nothing in the library yet", "No videos match". */
  emptyText: string;
  layout: keyof typeof GRID;
  renderTile: (asset: AssetView, context: LibraryTileContext) => ReactNode;
  className?: string;
  testId?: string;
}) {
  const { assets, loading, loadingMore, error, moreError, hasMore, loadMore, retry, listingKey } = list;
  const id = useId();
  const groups = useMemo(() => groupByProject(assets), [assets]);

  const [posters, setPosters] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => onPosterReady((assetId) => setPosters((prev) => new Set(prev).add(assetId))), []);

  // The sentinel and the tiles observe the scroll area as their root
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

  const grid = GRID[layout];
  let body: ReactNode;
  if (!libraryOn) body = <Notice className={grid.muted}>The asset library is off.</Notice>;
  else if (assets.length === 0 && loading) {
    body = (
      <div className="flex h-full items-center justify-center" aria-busy>
        <DialogSpinner />
      </div>
    );
  } else if (assets.length === 0 && error) {
    body = (
      <div role="status" className={cn("flex h-full flex-col items-center justify-center gap-2 px-2 text-center text-xs", grid.muted)}>
        <span>{error}</span>
        <button type="button" className={QUIET_BUTTON} onClick={retry}>
          Try again
        </button>
      </div>
    );
  } else if (assets.length === 0) {
    body = <Notice className={grid.muted}>{emptyText}</Notice>;
  } else {
    body = (
      <>
        <div className={cn("flex flex-col gap-5 transition-opacity", loading && "opacity-60")} aria-busy={loading || undefined}>
          {groups.map((group, i) => (
            <div key={group.key} role="group" aria-labelledby={`${id}-${i}`} className="min-w-0">
              <h3 id={`${id}-${i}`} className={cn("mb-2 truncate text-xs leading-4", grid.muted)}>
                {group.label}
              </h3>
              {group.videos.length > 0 && (
                <div className={cn("grid", grid.covers)}>
                  {group.videos.map((asset) => (
                    <Fragment key={asset.id}>{renderTile(asset, { scrollRoot, posterReady: posters.has(asset.id) })}</Fragment>
                  ))}
                </div>
              )}
              {group.audio.length > 0 && (
                <div className={cn("grid", grid.sounds, group.videos.length > 0 && "mt-2")}>
                  {group.audio.map((asset) => (
                    <Fragment key={asset.id}>{renderTile(asset, { scrollRoot, posterReady: false })}</Fragment>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
        <div ref={sentinelRef} aria-hidden="true" className="h-px" />
        {loadingMore ? (
          <div className="flex justify-center py-3">
            <DialogSpinner />
          </div>
        ) : (
          moreError && (
            <div role="status" className={cn("flex flex-col items-center gap-2 py-3 text-center text-xs", grid.muted)}>
              <span>{moreError}</span>
              <button type="button" className={QUIET_BUTTON} onClick={loadMore}>
                Try again
              </button>
            </div>
          )
        )}
      </>
    );
  }

  return (
    <div ref={scrollRootRef} className={cn("min-h-0 flex-1 overflow-y-auto", className)} data-testid={testId}>
      {body}
    </div>
  );
}

function Notice({ className, children }: { className: string; children: ReactNode }) {
  return <div className={cn("flex h-full items-center justify-center px-2 text-center text-xs", className)}>{children}</div>;
}
