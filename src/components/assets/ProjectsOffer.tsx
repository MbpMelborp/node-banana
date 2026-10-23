"use client";

import { FolderInput } from "lucide-react";
import { useEffect, useState } from "react";
import { bringInProjects, dismissProjectsOffer, fetchProjects } from "@/lib/assets/client/api";
import { MAX_IMPORT_PROJECTS, type ProjectsOverview } from "@/lib/assets/types";
import { cn } from "@/components/nodes/ui/cn";
import { useAssetStore } from "@/store/assetStore";
import { ELSEWHERE_PITCH, elsewhereTitle, elsewhereWhere } from "./projectsFormat";
import { quietTool, toolClass } from "./AssetsHeader";

const KEPT_MESSAGE = "They stay where they are. Settings › Storage can move them later.";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * The card between the Assets header and the grid when known projects live
 * outside the Creativo Melborp folder: "Move them in" starts the projects move
 * (its progress shows in the header), "Keep where they are" declines, and
 * the offer is not made again here or in Settings › Storage.
 */
export function ProjectsOffer() {
  const available = useAssetStore((state) => state.library?.available === true);
  const root = useAssetStore((state) => state.library?.root ?? null);
  const job = useAssetStore((state) => state.job);
  const [overview, setOverview] = useState<ProjectsOverview | null>(null);
  // Answered on this visit: the card goes at once, whatever the server says next
  const [answered, setAnswered] = useState(false);
  // A projects move that ended changes what lives elsewhere: ask again then
  const endedMove = job?.type === "projects" && job.state !== "running" ? job.id : null;

  useEffect(() => {
    if (!available) return;
    let live = true;
    fetchProjects()
      .then((next) => {
        if (live) setOverview(next);
      })
      .catch(() => {
        // No offer is better than a wrong one
      });
    return () => {
      live = false;
    };
  }, [available, root, endedMove]);

  const elsewhere = overview?.elsewhere ?? null;
  const moving = job?.type === "projects" && job.state === "running";
  if (!available || answered || moving || !overview || overview.offerDismissed || !elsewhere || elsewhere.count === 0) return null;

  const moveIn = async () => {
    const store = useAssetStore.getState();
    setAnswered(true);
    try {
      // The folders the offer counted: never one that holds more than a project
      const dirs = elsewhere.dirs.slice(0, MAX_IMPORT_PROJECTS);
      const result = await bringInProjects({ dirs, mode: "move" });
      if (result.job) store.trackJob(result.job);
    } catch (error) {
      setAnswered(false);
      store.showNotice({ message: errorMessage(error, "The move did not start."), tone: "error" });
    }
  };

  const keep = async () => {
    const store = useAssetStore.getState();
    setAnswered(true);
    store.showNotice({ message: KEPT_MESSAGE, tone: "info" });
    try {
      await dismissProjectsOffer();
    } catch (error) {
      store.showNotice({ message: errorMessage(error, "Could not save that choice."), tone: "error" });
    }
  };

  const busy = job?.state === "running";
  return (
    <div
      role="region"
      aria-label="Projects in other folders"
      className="mb-2 ml-8 mr-6 flex shrink-0 items-center gap-3 rounded-[10px] border border-white/[0.09] bg-white/[0.03] py-2.5 pl-3.5 pr-2.5"
    >
      <FolderInput size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-ink-3" />
      <div className="min-w-0 flex-1">
        <span className="block font-display text-[13px] leading-[18px] font-semibold tracking-[-0.01em] text-neutral-100">
          {elsewhereTitle(elsewhere)}
        </span>
        <span className="block text-xs leading-4 text-ink-3">
          {elsewhereWhere(elsewhere, false)}. {ELSEWHERE_PITCH}
        </span>
      </div>
      <button
        type="button"
        onClick={() => void keep()}
        className={cn(toolClass, "border-transparent bg-transparent text-neutral-400 hover:text-neutral-100")}
      >
        Keep where they are
      </button>
      <button
        type="button"
        onClick={() => void moveIn()}
        disabled={busy}
        title={busy ? "Wait for the current job to finish" : undefined}
        className={cn(
          toolClass,
          busy ? quietTool : "border-neutral-200 bg-neutral-200 font-semibold text-neutral-900 hover:bg-white",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
      >
        Move them in
      </button>
    </div>
  );
}
