"use client";

import { memo, useEffect, useRef, useState, type RefObject } from "react";
import { Check, Star } from "lucide-react";
import { cn } from "@/components/nodes/ui/cn";
import { AssetPlaceholder, tileThumbUrl } from "@/components/assets/AssetTile";
import { projectLabel } from "@/components/assets/assetFormat";
import { requestPoster } from "@/components/assets/posterRequests";
import type { AssetView } from "@/lib/assets/types";
import { formatTimecode } from "@/lib/stitch/timecode";

/** About a quarter of the 880px dialog, for the thumbnail size asked for. */
const TILE_WIDTH = 200;

/** Whether the element is inside the scroll area's view (always, where IntersectionObserver is missing). */
function useOnScreen(ref: RefObject<HTMLElement | null>, root: HTMLElement | null): boolean {
  const [onScreen, setOnScreen] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setOnScreen(entry?.isIntersecting ?? false), { root });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, root]);
  return onScreen;
}

/**
 * One library video in the picker: its poster, its length, a star when it
 * is a favourite, and a check once picked. The tile is a toggle button. A
 * video without a poster on screen gets one made, through the Assets view's
 * own capture queue; a tile whose file is gone cannot be picked.
 */
export const LibraryTile = memo(function LibraryTile({
  asset,
  selected,
  posterReady,
  scrollRoot,
  onToggle,
}: {
  asset: AssetView;
  selected: boolean;
  /** A poster was made for it since the page was read. */
  posterReady: boolean;
  scrollRoot: HTMLElement | null;
  onToggle: (asset: AssetView) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const onScreen = useOnScreen(ref, scrollRoot);
  const hasPoster = !!asset.hasPoster || posterReady;
  const [thumbFailed, setThumbFailed] = useState<string | null>(null);
  const thumbUrl = tileThumbUrl({ sha256: asset.sha256, hasPoster }, TILE_WIDTH);
  const missing = !!asset.missing;

  // Only while on screen: one scrolled past before its turn is withdrawn
  const needsPoster = !hasPoster && !missing;
  useEffect(() => {
    if (!needsPoster || !onScreen) return;
    return requestPoster(asset);
    // Once per asset, whatever else about the record changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsPoster, onScreen, asset.id]);

  const duration = typeof asset.durationSec === "number" && asset.durationSec > 0 ? asset.durationSec : null;
  const project = projectLabel(asset.workflow?.projectPath ?? null);
  // Everything the tile shows, for a screen reader (the pressed state is aria-pressed)
  const label = [
    asset.filename,
    duration !== null ? formatTimecode(duration, 1) : null,
    project,
    asset.favorite ? "favourite" : null,
    missing ? "file missing" : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <button
      ref={ref}
      type="button"
      aria-pressed={selected}
      aria-label={label}
      data-asset-id={asset.id}
      disabled={missing}
      title={missing ? "The file is missing" : undefined}
      onClick={() => onToggle(asset)}
      className={cn("group flex min-w-0 flex-col gap-1.5 text-left focus-visible:outline-none", missing && "opacity-40")}
    >
      <span
        className={cn(
          "relative block aspect-video w-full overflow-hidden rounded-media bg-well transition-shadow",
          // The blue ring is the pick alone; keyboard focus is the Assets view's white ring, set off from a pick
          selected
            ? "ring-2 ring-selection group-focus-visible:ring-offset-2 group-focus-visible:ring-offset-card"
            : "ring-1 ring-white/8 group-focus-visible:ring-2 group-focus-visible:ring-white/40 group-focus-visible:ring-offset-1 group-focus-visible:ring-offset-card",
        )}
      >
        {!missing && thumbFailed !== thumbUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- a library thumbnail route, which can answer 204
          <img
            src={thumbUrl}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={() => setThumbFailed(thumbUrl)}
            className="pointer-events-none h-full w-full object-cover"
          />
        ) : (
          <AssetPlaceholder kind="video" size={24} />
        )}
        {asset.favorite && (
          <Star
            size={13}
            strokeWidth={1.5}
            fill="currentColor"
            aria-hidden="true"
            className="absolute left-1.5 top-1.5 text-amber-400"
          />
        )}
        {duration !== null && (
          <span className="absolute bottom-1.5 left-1.5 rounded px-[5px] py-0.5 font-mono text-[10px] leading-3 tabular-nums text-neutral-200 bg-black/70">
            {formatTimecode(duration, 1)}
          </span>
        )}
        {selected ? (
          <span
            aria-label="Selected"
            className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-selection text-white"
          >
            <Check size={12} strokeWidth={3} />
          </span>
        ) : (
          !missing && (
            <span
              aria-hidden="true"
              className="absolute right-1.5 top-1.5 h-5 w-5 rounded-full border-[1.5px] border-white/70 bg-black/25 opacity-0 transition-opacity group-hover:opacity-100"
            />
          )
        )}
      </span>
      <span className="flex min-w-0 justify-between gap-2 text-[11px] leading-[14px]">
        <span className={cn("truncate", selected ? "text-neutral-100" : "text-neutral-300")}>{asset.filename}</span>
        <span className="shrink-0 whitespace-nowrap text-neutral-500">{project}</span>
      </span>
    </button>
  );
});
