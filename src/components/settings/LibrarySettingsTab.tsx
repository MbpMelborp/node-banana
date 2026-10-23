"use client";

import { CloudUpload, FolderInput, TriangleAlert, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

import {
  bringInProjects,
  cancelJob,
  dismissProjectsOffer,
  fetchJob,
  fetchLibraryStatus,
  fetchProjects,
  revealLibraryRoot,
  setLibraryRoot,
  startCleanup,
} from "@/lib/assets/client/api";
import { followMovedProjects } from "@/lib/assets/client/movedProjects";
import { applyLibraryStatus } from "@/lib/assets/client/recorder";
import {
  FOUND_MEDIA_COUNT_CAP,
  MAX_IMPORT_PROJECTS,
  type LibraryJobStatus,
  type LibraryJobType,
  type LibraryRootSource,
  type LibraryStatus,
  type ProjectsOverview,
  type ScanProjectsResult,
  type SetLibraryRootRequest,
} from "@/lib/assets/types";
import { openBringIn } from "@/store/bringInStore";
import { ELSEWHERE_PITCH, elsewhereTitle, elsewhereWhere, shortenHomePath } from "@/components/assets/projectsFormat";
import {
  Dialog,
  DialogBody,
  DialogButton,
  DialogChip,
  DialogDescription,
  DialogEyebrow,
  DialogFooter,
  DialogHeader,
  DialogRow,
  DialogRowTitle,
  DialogSpinner,
  DialogStatus,
  DialogTextButton,
  DialogTitle,
  dialogCardClass,
} from "@/components/ui/Dialog";
import { cn } from "@/components/nodes/ui/cn";

/**
 * The Storage page of the settings dialog: the Creativo Melborp folder, which
 * holds the projects saved by name and the generations of workflows that
 * have none. Nothing here is a draft — every action applies at once and long
 * ones (moves, clean-up) run as a server job this page follows.
 *
 * Every status this page reads or is handed also goes to the recorder, which
 * records only while its last status says the library is available: a switch
 * away from an unplugged drive must turn recording back on without a reload.
 */

/** How often a running library job is polled. */
export const JOB_POLL_MS = 1000;
/** How often the status is read again while the library is still counting its assets. */
export const COUNT_POLL_MS = 2000;
/** Consecutive failed polls before the page stops following a job. */
const MAX_POLL_FAILURES = 10;

export const SOURCE_LABELS: Record<LibraryRootSource, string> = {
  default: "Default",
  config: "Chosen",
  env: "Set by NODE_BANANA_ASSET_LIBRARY",
  fallback: "Fallback",
};

const SYNC_SERVICES: Record<NonNullable<LibraryStatus["synced"]>, string> = {
  onedrive: "OneDrive",
  icloud: "iCloud",
  dropbox: "Dropbox",
};

const JOB_LABELS: Record<LibraryJobType, string> = {
  move: "Moving the library",
  import: "Importing generations",
  cleanup: "Cleaning up",
  export: "Exporting",
  projects: "Moving projects",
};

const JOB_STATES: Record<Exclude<LibraryJobStatus["state"], "running">, { label: string; tone: "ok" | "error" | "neutral" }> = {
  done: { label: "Done", tone: "ok" },
  failed: { label: "Failed", tone: "error" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

const BUSY_REASON = "Wait for the current job to finish";

/** "Show in Finder" / "Show in Explorer", by the server's platform. */
export function revealLabel(platform: string | null | undefined): string {
  if (platform === "darwin") return "Show in Finder";
  if (platform === "win32") return "Show in Explorer";
  return "Show folder";
}

/** 1024-based sizes with one decimal under 10: "0 B", "812 KB", "3.2 GB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  const rounded = exponent === 0 ? value : parseFloat(value.toFixed(value >= 10 ? 0 : 1));
  return `${rounded} ${units[exponent]}`;
}

function trimTrailingSeparators(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  // Keep "/" and "C:\" whole
  return trimmed === "" || /^[A-Za-z]:$/.test(trimmed) ? path : trimmed;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Whether two folders are the same, folding case where the platform's file system does. */
function samePath(a: string, b: string | null, platform: string): boolean {
  if (!b) return false;
  const normalize = (path: string) => {
    let out = trimTrailingSeparators(path.trim());
    if (platform === "win32") out = out.replace(/\//g, "\\");
    return platform === "win32" || platform === "darwin" ? out.toLowerCase() : out;
  };
  return normalize(a) === normalize(b);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** What a search for projects found, in words (for a list of what it found). */
export function describeScan(result: ScanProjectsResult): string {
  const count = result.projects.length;
  const parts = [
    count === 0
      ? `No Creativo Melborp projects in ${result.root}.`
      : `Found ${count.toLocaleString()} ${count === 1 ? "project" : "projects"} in ${result.root}.`,
  ];
  if (result.truncated) parts.push("The search stopped early; pick a smaller folder to see the rest.");
  if (result.unreadable > 0) {
    parts.push(`${result.unreadable.toLocaleString()} ${result.unreadable === 1 ? "folder" : "folders"} couldn't be read.`);
  }
  return parts.join(" ");
}

/** "1 file", "12 files", "10,000+ files" (the search stops counting there). */
export function formatFileCount(count: number): string {
  const capped = count >= FOUND_MEDIA_COUNT_CAP ? "+" : "";
  return `${count.toLocaleString()}${capped} ${count === 1 ? "file" : "files"}`;
}

/**
 * Opens the native folder picker (`/api/browse-directory`) with the title
 * for `purpose`. Null when the user cancels; throws with the picker's reason.
 */
async function pickFolder(purpose: "library" | "import"): Promise<string | null> {
  let result: { success?: boolean; cancelled?: boolean; path?: string | null; error?: string };
  try {
    const response = await fetch(`/api/browse-directory?purpose=${purpose}`);
    result = await response.json();
  } catch (error) {
    throw new Error(`Failed to open the folder picker: ${errorMessage(error, "Unknown error")}`);
  }
  if (!result.success) throw new Error(result.error || "Failed to open the folder picker");
  return result.cancelled || !result.path ? null : result.path;
}

/** A boxed line under the location: a warning, a sync note, why the library is off. */
function LibraryNotice({
  tone,
  icon,
  action,
  children,
}: {
  tone: "info" | "warning" | "error";
  icon: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "note"}
      className={cn(
        "flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-xs leading-4",
        tone === "error" ? "border-error/40 bg-error/[0.06] text-red-200" : "border-card-border bg-white/[0.02] text-neutral-300"
      )}
    >
      <span
        aria-hidden="true"
        className={cn("shrink-0", tone === "warning" ? "text-amber-400" : tone === "error" ? "text-error" : "text-ink-3")}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1 pt-px">{children}</span>
      {action && <span className="-my-1.5 shrink-0">{action}</span>}
    </div>
  );
}

/** A count, or null while the library is still counting (its zeros are not real yet). */
function Stat({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="min-w-0">
      <dt>
        <DialogEyebrow>{label}</DialogEyebrow>
      </dt>
      <dd className="mt-1 font-display text-xl leading-6 font-semibold tracking-[-0.02em] text-neutral-100 tabular-nums truncate">
        {value ?? <span className="font-sans text-sm font-normal tracking-normal text-ink-3">Counting…</span>}
      </dd>
    </div>
  );
}

/** Progress of one library job, with Cancel while it runs. `label` names it more closely ("Moving 14 projects"). */
function LibraryJobRow({
  job,
  label: ownLabel,
  cancelling,
  onCancel,
  onDismiss,
}: {
  job: LibraryJobStatus;
  label?: string;
  cancelling: boolean;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  const running = job.state === "running";
  const label = ownLabel ?? JOB_LABELS[job.type] ?? "Working";
  const percent = job.total > 0 ? Math.min(100, Math.round((job.done / job.total) * 100)) : null;
  const detail = [
    job.total > 0 ? `${job.done.toLocaleString()} of ${job.total.toLocaleString()} files` : null,
    job.bytesTotal > 0 ? `${formatBytes(job.bytesDone)} of ${formatBytes(job.bytesTotal)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const finished = job.state === "running" ? null : JOB_STATES[job.state];

  return (
    <div className="py-3.5 border-t border-card" data-testid="library-job">
      <div className="flex items-center justify-between gap-4 min-h-7">
        <div className="flex min-w-0 items-center gap-2.5">
          <DialogRowTitle className="truncate">{label}</DialogRowTitle>
          {finished && <DialogStatus tone={finished.tone}>{finished.label}</DialogStatus>}
        </div>
        {running ? (
          <DialogTextButton onClick={onCancel} disabled={cancelling}>
            {cancelling ? "Cancelling…" : "Cancel"}
          </DialogTextButton>
        ) : (
          <DialogTextButton onClick={onDismiss} aria-label="Dismiss" title="Dismiss" className="w-7 flex items-center justify-center">
            <X size={14} strokeWidth={1.75} />
          </DialogTextButton>
        )}
      </div>
      {running && (
        <div
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={job.total > 0 ? job.total : undefined}
          aria-valuenow={job.total > 0 ? job.done : undefined}
          className="mt-2 h-1 overflow-hidden rounded-full bg-card"
        >
          <div
            className={cn(
              "h-full rounded-full bg-neutral-200 transition-[width] duration-300 motion-reduce:transition-none",
              percent === null && "w-1/3 motion-safe:animate-pulse"
            )}
            style={percent === null ? undefined : { width: `${percent}%` }}
          />
        </div>
      )}
      {detail && <p className="mt-1.5 font-mono text-[11px] leading-4 text-ink-3 tabular-nums">{detail}</p>}
      {job.message && <p className="mt-1 text-xs leading-4 text-neutral-400">{job.message}</p>}
      {job.error && (
        <p role="alert" className="mt-1 text-xs leading-4 text-error">
          {job.error}
        </p>
      )}
    </div>
  );
}

/** "1 project", "14 projects". */
function projectCount(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? "project" : "projects"}`;
}

/** The known projects' folders, inside the Creativo Melborp folder or outside it (at most what one request takes). */
function projectDirs(overview: ProjectsOverview | null, inRoot: boolean): string[] {
  if (!overview) return [];
  return overview.projects
    .filter((project) => project.inRoot === inRoot)
    .map((project) => project.dir)
    .slice(0, MAX_IMPORT_PROJECTS);
}

/**
 * `onLeave` closes the settings dialog when an action continues elsewhere
 * ("Choose folder…" opens the quickstart's Bring-in view).
 */
export function LibrarySettingsTab({ onLeave }: { onLeave?: () => void } = {}) {
  const [status, setStatus] = useState<LibraryStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [job, setJob] = useState<LibraryJobStatus | null>(null);
  // One line under the location: what the last action did, or why it failed
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [pendingRoot, setPendingRoot] = useState<string | null>(null);
  const [applying, setApplying] = useState<SetLibraryRootRequest["mode"] | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  // The job a Cancel was sent for, until the job reports it has stopped
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  // The projects the app knows about, and those outside the folder (the offer)
  const [overview, setOverview] = useState<ProjectsOverview | null>(null);
  const [overviewFailed, setOverviewFailed] = useState(false);
  // "Keep where they are" was chosen on this page: the offer gives way to a line
  const [offerKept, setOfferKept] = useState(false);
  // How many projects the running projects move carries, for its row's title
  const [movingCount, setMovingCount] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchLibraryStatus();
      setStatus(next);
      applyLibraryStatus(next);
      setLoadError(null);
      // A job started elsewhere (the Assets view's offer) is followed here too,
      // but a job this page has already seen end is not brought back.
      const running = next.job?.state === "running" ? next.job : null;
      if (running) {
        setJob((previous) =>
          previous && previous.id === running.id && previous.state !== "running" ? previous : running
        );
      }
    } catch (error) {
      setLoadError(errorMessage(error, "Could not read the library's status."));
    }
  }, []);

  const refreshProjects = useCallback(async () => {
    try {
      setOverview(await fetchProjects());
      setOverviewFailed(false);
    } catch {
      setOverviewFailed(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshProjects();
  }, [refresh, refreshProjects]);

  // A big library's first scan outlasts the status request, whose counts are
  // then provisional zeros: read again until the real ones are in.
  const counting = status?.available === true && status.counting === true;
  useEffect(() => {
    if (!counting) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      await refresh();
      if (!stopped) timer = setTimeout(tick, COUNT_POLL_MS);
    };
    timer = setTimeout(tick, COUNT_POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [counting, refresh]);

  // What a job's end sets off: the counts and projects are read again.
  const jobEnded = useRef<(ended: LibraryJobStatus) => void>(() => {});

  const runJob = async (start: () => Promise<LibraryJobStatus>) => {
    setStarting(true);
    setFeedback(null);
    try {
      const started = await start();
      setJob(started);
      if (started.state !== "running") jobEnded.current(started);
    } catch (error) {
      setFeedback({ text: errorMessage(error, "Could not start the job."), error: true });
    } finally {
      setStarting(false);
    }
  };

  /** Moves project folders into the Creativo Melborp folder, as a job this page follows. */
  const moveProjects = (dirs: string[], count: number) => {
    setMovingCount(count);
    return runJob(async () => {
      const result = await bringInProjects({ dirs, mode: "move" });
      if (!result.job) throw new Error("The move did not start.");
      return result.job;
    });
  };

  jobEnded.current = () => {
    void refresh();
    void refreshProjects();
  };

  // Follow a running job once a second; refresh the counts when it ends.
  const runningJobId = job?.state === "running" ? job.id : null;
  useEffect(() => {
    if (!runningJobId) return;
    let stopped = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const next = await fetchJob(runningJobId);
        if (stopped) return;
        failures = 0;
        if (!next) {
          // The server no longer knows it (restarted): nothing left to follow
          setJob(null);
          void refresh();
          return;
        }
        setJob(next);
        followMovedProjects(next);
        if (next.state !== "running") {
          jobEnded.current(next);
          return;
        }
      } catch {
        if (stopped) return;
        failures += 1;
        if (failures >= MAX_POLL_FAILURES) {
          setFeedback({ text: "Lost track of the job. Its progress will show here again when the page reopens.", error: true });
          setJob(null);
          return;
        }
      }
      timer = setTimeout(tick, JOB_POLL_MS);
    };
    timer = setTimeout(tick, JOB_POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [runningJobId, refresh]);

  // The settings dialog saves and closes on Enter. Nothing on this page is a
  // draft, and Enter on an option must not close the dialog.
  const keepEnter = (event: ReactKeyboardEvent) => {
    if (event.key === "Enter") event.stopPropagation();
  };

  if (!status) {
    return (
      <div className="flex items-center gap-3 py-2">
        {loadError ? (
          <>
            <p role="alert" className="text-xs leading-4 text-error">
              {loadError}
            </p>
            <DialogTextButton onClick={() => void refresh()}>Try again</DialogTextButton>
          </>
        ) : (
          <>
            <DialogSpinner />
            <DialogEyebrow>Reading the library…</DialogEyebrow>
          </>
        )}
      </div>
    );
  }

  const busy = runningJobId !== null || starting || applying !== null;
  const fromEnv = status.source === "env";
  // Off with no location at all: the request guard refused this page, or the
  // server is hosted. The picker would open on the server's own screen and
  // the change be refused. A location that resolved but cannot be written
  // (an unplugged drive) is different: another folder is the fix.
  const unreachable = !status.available && !status.root;
  const changeDisabled = fromEnv || unreachable || busy || choosing;
  const changeTitle = fromEnv
    ? "Set by the NODE_BANANA_ASSET_LIBRARY environment variable"
    : unreachable
      ? (status.reason ?? "The library can't be changed from here.")
      : busy
        ? BUSY_REASON
        : undefined;

  const inRootDirs = projectDirs(overview, true);
  const elsewhere = overview?.elsewhere ?? null;
  const movingProjects = job?.type === "projects" && job.state === "running";
  const offerOpen =
    status.available && elsewhere !== null && elsewhere.count > 0 && !overview?.offerDismissed && !offerKept && !movingProjects;

  const reveal = async () => {
    setFeedback(null);
    try {
      await revealLibraryRoot();
    } catch (error) {
      setFeedback({ text: errorMessage(error, "Could not show the Creativo Melborp folder."), error: true });
    }
  };

  const chooseFolder = async () => {
    setChoosing(true);
    setFeedback(null);
    try {
      const picked = await pickFolder("library");
      if (!picked) return;
      if (samePath(picked, status.root, status.platform)) {
        setFeedback({ text: "That folder is already your Creativo Melborp folder.", error: false });
        return;
      }
      setApplyError(null);
      setPendingRoot(picked);
    } catch (error) {
      setFeedback({ text: errorMessage(error, "Failed to open the folder picker"), error: true });
    } finally {
      setChoosing(false);
    }
  };

  const applyRoot = async (mode: SetLibraryRootRequest["mode"]) => {
    if (!pendingRoot) return;
    const previousRoot = status.root;
    // The projects in the folder being left: listed where they are either
    // way, so they stay in Open and Assets; a move takes them along after,
    // in the same server job (so closing Settings meanwhile doesn't strand them).
    const leaving = inRootDirs;
    setApplying(mode);
    setApplyError(null);
    try {
      if (leaving.length > 0) await bringInProjects({ dirs: leaving, mode: "leave" });
      const next = await setLibraryRoot(
        mode === "move" && leaving.length > 0 ? { root: pendingRoot, mode, projects: leaving } : { root: pendingRoot, mode }
      );
      setStatus(next);
      applyLibraryStatus(next);
      if (mode === "move" && next.job) {
        setJob(next.job);
        // A small library can finish moving before the answer arrives
        if (next.job.state !== "running") jobEnded.current(next.job);
      } else if (next.job?.state === "running") {
        setJob(next.job);
      }
      setPendingRoot(null);
      void refreshProjects();
      if (mode === "switch") {
        setFeedback({
          text: previousRoot
            ? `Now saving to ${next.root ?? pendingRoot}. ${previousRoot} stays as it is.`
            : `Now saving to ${next.root ?? pendingRoot}.`,
          error: false,
        });
      }
    } catch (error) {
      setApplyError(errorMessage(error, "Could not change the Creativo Melborp folder."));
    } finally {
      setApplying(null);
    }
  };

  const cancel = async () => {
    if (!job) return;
    const jobId = job.id;
    setCancellingId(jobId);
    try {
      await cancelJob(jobId);
    } catch (error) {
      setCancellingId(null);
      setFeedback({ text: errorMessage(error, "Could not cancel the job."), error: true });
    }
  };

  const keepProjects = async () => {
    setOfferKept(true);
    try {
      await dismissProjectsOffer();
    } catch (error) {
      setFeedback({ text: errorMessage(error, "Could not save that choice."), error: true });
    }
  };

  const bringIn = () => {
    openBringIn();
    onLeave?.();
  };

  /** The job row, shown beside the action that starts that kind of job. */
  const jobRow = (...types: LibraryJobType[]) =>
    job && types.includes(job.type) ? (
      <LibraryJobRow
        job={job}
        label={job.type === "projects" && movingCount ? `Moving ${projectCount(movingCount)}` : undefined}
        cancelling={cancellingId === job.id}
        onCancel={() => void cancel()}
        onDismiss={() => setJob(null)}
      />
    ) : null;

  const changeButton = (
    <DialogButton
      variant="outline"
      size="md"
      className="h-8 shrink-0"
      onClick={() => void chooseFolder()}
      disabled={changeDisabled}
      title={changeTitle}
    >
      {choosing ? "Choosing…" : "Change…"}
    </DialogButton>
  );

  const assetCount = status.counts.assets;
  const moveDescription = !status.available
    ? "The current folder isn't available, so there is nothing to move."
    : inRootDirs.length > 0
      ? `Moves the ${projectCount(inRootDirs.length)} in your folder${
          overview?.rootBytes ? ` (${formatBytes(overview.rootBytes)})` : ""
        } and your unsaved generations, checks every file, then removes the originals. Projects in other folders stay where they are.`
      : "Moves your unsaved generations, checks every file, then removes the originals. Projects in other folders stay where they are.";

  return (
    <div onKeyDown={keepEnter}>
      {/* The Creativo Melborp folder */}
      <DialogRow
        first
        align="start"
        className="pt-0"
        title={
          <span className="flex items-center gap-2">
            Creativo Melborp folder
            <DialogChip>{SOURCE_LABELS[status.source] ?? status.source}</DialogChip>
          </span>
        }
        description={
          <span className="block mt-1 font-mono text-xs leading-4 text-neutral-300 break-all select-text">
            {status.root ?? "No folder"}
          </span>
        }
      >
        <div className="flex shrink-0 items-center gap-1.5">
          <DialogTextButton onClick={() => void reveal()} disabled={!status.root || !status.available}>
            {revealLabel(status.platform)}
          </DialogTextButton>
          {changeButton}
        </div>
      </DialogRow>

      <p className="-mt-1.5 pb-3.5 text-xs leading-4 text-ink-3">
        New projects are saved here, and generations from workflows you haven’t saved go to its Generations folder.
      </p>

      {fromEnv && (
        <p className="-mt-1.5 pb-3.5 text-xs leading-4 text-ink-3">
          Set by the NODE_BANANA_ASSET_LIBRARY environment variable. Unset it to choose a folder here.
        </p>
      )}

      {feedback && (
        <p role={feedback.error ? "alert" : "status"} className={cn("-mt-1.5 pb-3.5 text-xs leading-4", feedback.error ? "text-error" : "text-neutral-400")}>
          {feedback.text}
        </p>
      )}

      {(!status.available || status.fallbackReason || status.synced || loadError) && (
        <div className="flex flex-col gap-2 pb-3.5">
          {!status.available && (
            <LibraryNotice tone="error" icon={<TriangleAlert size={16} strokeWidth={1.75} />}>
              {status.reason ?? "The library is not available."}
            </LibraryNotice>
          )}
          {loadError && (
            <LibraryNotice tone="error" icon={<TriangleAlert size={16} strokeWidth={1.75} />}>
              {loadError}
            </LibraryNotice>
          )}
          {status.fallbackReason && (
            <LibraryNotice tone="warning" icon={<TriangleAlert size={16} strokeWidth={1.75} />}>
              {status.fallbackReason}
            </LibraryNotice>
          )}
          {status.synced && (
            <LibraryNotice
              tone="info"
              icon={<CloudUpload size={16} strokeWidth={1.75} />}
              action={
                <DialogTextButton onClick={() => void chooseFolder()} disabled={changeDisabled} title={changeTitle}>
                  Change…
                </DialogTextButton>
              }
            >
              This folder syncs to {SYNC_SERVICES[status.synced] ?? "the cloud"}; large videos will upload.
            </LibraryNotice>
          )}
        </div>
      )}

      {/* Projects that live in other folders: move them in, or keep them there */}
      {offerOpen && elsewhere && (
        <div
          role="region"
          aria-label="Projects in other folders"
          className="mb-3.5 flex items-start gap-2.5 rounded-lg border border-card-border bg-white/[0.02] px-3 py-2.5 text-xs leading-4 text-neutral-300"
        >
          <FolderInput size={16} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-ink-3" />
          <div className="min-w-0 flex-1">
            <div className="font-display text-[13px] leading-[18px] font-semibold tracking-[-0.01em] text-neutral-100">
              {elsewhereTitle(elsewhere)}
            </div>
            <p className="mt-0.5 text-neutral-400">
              {elsewhereWhere(elsewhere, true)}. {ELSEWHERE_PITCH}
            </p>
            <div className="mt-2.5 flex items-center gap-1.5">
              <DialogButton
                variant="outline"
                size="md"
                className="h-8"
                disabled={busy}
                title={busy ? BUSY_REASON : undefined}
                onClick={() => void moveProjects(elsewhere.dirs.slice(0, MAX_IMPORT_PROJECTS), elsewhere.count)}
              >
                Move them in
              </DialogButton>
              <DialogTextButton onClick={() => void keepProjects()}>Keep where they are</DialogTextButton>
            </div>
          </div>
        </div>
      )}
      {offerKept && (
        <p role="status" className="pb-3.5 text-xs leading-4 text-neutral-400">
          They stay where they are. You can bring them in later from below.
        </p>
      )}

      {jobRow("projects")}
      {jobRow("move", "export")}

      {status.available && (
        <>
          <dl
            aria-label="What the folder holds"
            aria-busy={counting || undefined}
            className="grid grid-cols-3 gap-4 py-3.5 border-t border-card"
          >
            <Stat
              label={inRootDirs.length === 1 ? "Project" : "Projects"}
              value={overview ? inRootDirs.length.toLocaleString() : overviewFailed ? "—" : null}
            />
            <Stat
              label={assetCount === 1 && !counting ? "Asset" : "Assets"}
              value={counting ? null : assetCount.toLocaleString()}
            />
            <Stat label="Size" value={counting ? null : formatBytes(status.counts.bytes)} />
          </dl>

          <DialogRow
            title="Bring in projects from another folder"
            description="Searches a folder and its subfolders, then lets you use, move or add what it finds."
          >
            <DialogButton
              variant="outline"
              size="md"
              className="h-8 shrink-0"
              disabled={busy}
              title={busy ? BUSY_REASON : undefined}
              onClick={bringIn}
            >
              Choose folder…
            </DialogButton>
          </DialogRow>

          {jobRow("import")}

          <DialogRow
            title="Clean up unused workflow data"
            description="Removes stored workflow media and video posters that nothing uses any more."
          >
            <DialogButton
              variant="outline"
              size="md"
              className="h-8 shrink-0"
              disabled={busy}
              title={busy ? BUSY_REASON : undefined}
              onClick={() => void runJob(() => startCleanup({ unusedMedia: true }))}
            >
              Clean up
            </DialogButton>
          </DialogRow>

          <DialogRow title="Clear thumbnail cache" description="Thumbnails are made again the next time they are shown.">
            <DialogButton
              variant="outline"
              size="md"
              className="h-8 shrink-0"
              disabled={busy}
              title={busy ? BUSY_REASON : undefined}
              onClick={() => void runJob(() => startCleanup({ thumbnails: true }))}
            >
              Clear
            </DialogButton>
          </DialogRow>

          {jobRow("cleanup")}
        </>
      )}

      {/* Confirm step for a new folder: move everything there, or just use it */}
      <Dialog
        open={pendingRoot !== null}
        onClose={applying ? undefined : () => setPendingRoot(null)}
        size="sm"
        className="w-[440px]"
        portal
      >
        <DialogHeader>
          <DialogTitle>Change the Creativo Melborp folder</DialogTitle>
          <DialogDescription className="font-mono break-all">{pendingRoot}</DialogDescription>
        </DialogHeader>
        <DialogBody scroll={false} className="flex flex-col gap-2 pb-4">
          <button
            type="button"
            className={cn(dialogCardClass, "px-3.5 py-3 disabled:opacity-50 disabled:cursor-not-allowed")}
            onClick={() => void applyRoot("move")}
            disabled={applying !== null || !status.available}
          >
            <span className="block font-display text-sm leading-[18px] font-semibold tracking-[-0.01em] text-neutral-100">
              {applying === "move" ? "Starting the move…" : "Move everything there"}
            </span>
            <span className="mt-0.5 block text-xs leading-4 text-ink-3">{moveDescription}</span>
          </button>
          <button
            type="button"
            className={cn(dialogCardClass, "px-3.5 py-3 disabled:opacity-50 disabled:cursor-not-allowed")}
            onClick={() => void applyRoot("switch")}
            disabled={applying !== null}
          >
            <span className="block font-display text-sm leading-[18px] font-semibold tracking-[-0.01em] text-neutral-100">
              {applying === "switch" ? "Switching…" : "Use that folder"}
            </span>
            <span className="mt-0.5 block text-xs leading-4 text-ink-3">
              {status.root
                ? `New projects and generations are saved there from now on. ${shortenHomePath(status.root)} stays as it is, and its projects stay in Open and Assets.`
                : "New projects and generations are saved there from now on."}
            </span>
          </button>
          {applyError && (
            <p role="alert" className="rounded-md bg-red-500/10 px-2.5 py-2 text-xs leading-4 text-red-300">
              {applyError}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <DialogButton variant="ghost" onClick={() => setPendingRoot(null)} disabled={applying !== null}>
            Cancel
          </DialogButton>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
