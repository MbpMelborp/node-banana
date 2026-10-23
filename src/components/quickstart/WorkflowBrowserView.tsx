"use client";

import { FolderOpen } from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { WorkflowFile } from "@/store/workflowStore";
import {
  DialogButton,
  DialogEyebrow,
  DialogPage,
  DialogPageBody,
  DialogPageHead,
  DialogPane,
  DialogRowTitle,
  DialogSpinner,
  DialogStatus,
  DialogTextButton,
} from "@/components/ui/Dialog";
import { cn } from "@/components/nodes/ui/cn";
import { shortLibraryPath } from "@/components/assets/assetFormat";
import { shortenHomePath } from "@/components/assets/projectsFormat";
import { fetchProjects } from "@/lib/assets/client/api";
import type { KnownProject } from "@/lib/assets/types";
import { useSettingsDialogStore } from "@/store/settingsDialogStore";
import { QuickstartBackButton } from "./QuickstartBackButton";

interface WorkflowBrowserViewProps {
  onBack?: () => void;
  onWorkflowLoaded: (workflow: WorkflowFile, directoryPath: string) => void;
  onClose?: () => void;
  /** The empty state's "New project"; left out, the empty state has no button. */
  onNewProject?: () => void;
  /** The empty state's "Bring in your projects"; left out, no link. */
  onBringIn?: () => void;
}

function formatRelativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function FolderIcon({ className, strokeWidth = 1.5 }: { className?: string; strokeWidth?: number }) {
  return (
    <FolderOpen className={className} strokeWidth={strokeWidth} />
  );
}

/**
 * "Your projects": the pane names the Creativo Melborp folder and holds the
 * actions on it, the page lists every project the app knows about as ruled
 * rows, newest first, wherever it lives. With none yet, the page says where
 * saved projects go and offers a new one or to bring earlier ones in.
 */
export function WorkflowBrowserView({
  onBack,
  onWorkflowLoaded,
  onClose,
  onNewProject,
  onBringIn,
}: WorkflowBrowserViewProps) {
  const [root, setRoot] = useState<string | null>(null);
  const [projects, setProjects] = useState<KnownProject[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadingWorkflow, setLoadingWorkflow] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchProjects(controller.signal)
      .then((overview) => {
        setRoot(overview.root || null);
        setProjects(overview.projects);
      })
      .catch((fetchError: unknown) => {
        if (controller.signal.aborted) return;
        setListError(fetchError instanceof Error && fetchError.message ? fetchError.message : "Failed to list projects");
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });
    return () => controller.abort();
  }, []);

  const loadFrom = useCallback(
    async (dirPath: string) => {
      setLoadingWorkflow(dirPath);
      setError(null);
      try {
        const res = await fetch(`/api/workflow?path=${encodeURIComponent(dirPath)}&load=true`);
        const result = await res.json();
        if (!result.success) {
          setError(result.error || "Failed to load workflow");
          setLoadingWorkflow(null);
          return;
        }
        onWorkflowLoaded(result.workflow as WorkflowFile, dirPath);
        onClose?.();
      } catch {
        setError("Failed to load workflow");
        setLoadingWorkflow(null);
      }
    },
    [onWorkflowLoaded, onClose]
  );

  const handleBrowseOther = useCallback(async () => {
    try {
      const browseRes = await fetch("/api/browse-directory");
      const browseResult = await browseRes.json();
      if (!browseResult.success || browseResult.cancelled || !browseResult.path) {
        if (!browseResult.success && !browseResult.cancelled) {
          setError(browseResult.error || "Failed to open directory picker");
        }
        return;
      }
      await loadFrom(browseResult.path);
    } catch {
      setError("Failed to open directory picker");
    }
  }, [loadFrom]);

  // Settings › Storage takes over from this dialog
  const handleChangeFolder = useCallback(() => {
    onClose?.();
    useSettingsDialogStore.getState().openSettings("library");
  }, [onClose]);

  const busy = loadingWorkflow !== null;
  const empty = !isLoading && !listError && projects.length === 0;

  return (
    <>
      <DialogPane width={300}>
        <div className="flex flex-col gap-[18px] min-h-0">
          {onBack && <QuickstartBackButton onClick={onBack} />}
          <h2
            id="workflow-browser-title"
            className="font-display text-[28px] leading-8 font-bold tracking-display text-neutral-100"
          >
            Your projects
          </h2>
          {!isLoading && (
            <div className="flex flex-col gap-1.5 min-h-0">
              <DialogEyebrow className="tabular-nums">
                {projects.length === 0 ? "No projects yet" : `${projects.length} project${projects.length !== 1 ? "s" : ""}`}
              </DialogEyebrow>
              {root && (
                <p className="font-mono text-[11px] leading-4 text-neutral-500 break-all" title={root}>
                  {shortenHomePath(root)}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-col items-start gap-2">
          <DialogButton variant="outline" size="md" onClick={handleBrowseOther} disabled={busy}>
            <FolderIcon className="w-3.5 h-3.5" />
            Open from elsewhere…
          </DialogButton>
          <DialogTextButton onClick={handleChangeFolder} disabled={busy}>
            Change folder
          </DialogTextButton>
        </div>
      </DialogPane>

      <DialogPage data-testid="workflow-browser-view">
        <DialogPageHead eyebrow="Recent" />

        {empty ? (
          <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-4 px-12 pb-6 text-center">
            <FolderIcon className="w-10 h-10 text-neutral-600" strokeWidth={1.25} />
            <p className="max-w-[360px] text-[13px] leading-[19px] text-neutral-400">
              Projects you save are kept here, in {root ? shortLibraryPath(root) : "your Creativo Melborp folder"}.
            </p>
            {onNewProject && (
              <DialogButton variant="primary" size="md" onClick={onNewProject}>
                New project
              </DialogButton>
            )}
            {onBringIn && (
              <DialogTextButton className="text-xs" onClick={onBringIn}>
                <span className="mr-1 text-neutral-500">Used Creativo Melborp before?</span>
                Bring in your projects
              </DialogTextButton>
            )}
            {error && (
              <DialogStatus tone="error" className="normal-case tracking-normal text-neutral-300">
                {error}
              </DialogStatus>
            )}
          </div>
        ) : (
          <DialogPageBody className="overscroll-contain pt-2 pb-4">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <DialogSpinner />
              </div>
            ) : projects.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <FolderIcon className="w-10 h-10 text-neutral-600 mb-4" strokeWidth={1.25} />
                <p className="font-display text-sm leading-[18px] font-semibold tracking-[-0.01em] text-neutral-100">
                  Projects could not be listed
                </p>
                <p className="mt-1 text-xs leading-4 text-ink-3">{listError}</p>
              </div>
            ) : (
              <div className="flex flex-col">
                {projects.map((project, index) => {
                  const isActive = loadingWorkflow === project.dir;
                  return (
                    <button
                      key={project.dir}
                      type="button"
                      onClick={() => loadFrom(project.dir)}
                      disabled={busy}
                      aria-busy={isActive || undefined}
                      className={cn(
                        "group flex items-center gap-3 w-full py-3 px-1 text-left transition-colors",
                        "hover:bg-white/[0.03] focus-visible:outline-none focus-visible:bg-white/[0.04]",
                        "disabled:opacity-50 disabled:cursor-not-allowed",
                        index > 0 && "border-t border-card",
                        isActive && "bg-white/[0.03] opacity-100"
                      )}
                    >
                      <span className="flex shrink-0 items-center justify-center w-[18px] h-[18px] text-neutral-500 group-hover:text-neutral-300 transition-colors">
                        {isActive ? (
                          <span className="w-3.5 h-3.5 border-2 border-neutral-600 border-t-neutral-300 rounded-full animate-spin" />
                        ) : (
                          <FolderIcon className="w-[18px] h-[18px]" />
                        )}
                      </span>

                      <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                        <DialogRowTitle className="truncate">{project.name}</DialogRowTitle>
                        <span className="font-mono text-[11px] leading-4 text-neutral-500 truncate" title={project.dir}>
                          {project.relativePath || shortenHomePath(project.dir)}
                        </span>
                      </span>

                      <span className="shrink-0 font-mono text-[11px] leading-4 text-neutral-500 tabular-nums">
                        {formatRelativeTime(project.lastModified)}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {error && (
              <DialogStatus tone="error" className="mt-3 px-1 normal-case tracking-normal text-neutral-300">
                {error}
              </DialogStatus>
            )}
          </DialogPageBody>
        )}
      </DialogPage>
    </>
  );
}
