"use client";

import { Check, Info, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  DialogButton,
  DialogChip,
  DialogEyebrow,
  DialogPage,
  DialogPageBody,
  DialogPageFooter,
  DialogPageHead,
  DialogPageTitle,
  DialogPane,
  DialogPaneFoot,
  DialogRowTitle,
  DialogSpinner,
  DialogTextButton,
} from "@/components/ui/Dialog";
import { cn } from "@/components/nodes/ui/cn";
import { formatBytes, formatCount, shortLibraryPath } from "@/components/assets/assetFormat";
import { shortenHomePath } from "@/components/assets/projectsFormat";
import { bringInProjects, cancelJob, fetchJob, fetchProjects, scanProjects } from "@/lib/assets/client/api";
import { followMovedProjects } from "@/lib/assets/client/movedProjects";
import type { FoundProject, LibraryJobStatus, ScanProjectsResult } from "@/lib/assets/types";
import { APP_VERSION } from "@/lib/appVersion";
import { QuickstartBackButton } from "./QuickstartBackButton";
import { folderName, groupFoundProjects, movePercent, moveRowStates, type BringInMode } from "./bringInModel";

/** How often a running move is asked how far it got. */
const MOVE_POLL_MS = 1000;
/** Past this many rows the found list fades at the bottom, to say it scrolls. */
const LONG_LIST = 8;

type Phase =
  | { kind: "picking" }
  | { kind: "searching"; folder: string }
  | { kind: "results"; scan: ScanProjectsResult }
  | { kind: "moving"; scan: ScanProjectsResult; job: LibraryJobStatus };

interface BringInViewProps {
  /** Back to where the view was opened from; without it Back and Cancel close the dialog. */
  onBack?: () => void;
  onClose: () => void;
  /** The projects are in: the dialog moves on to Open. */
  onDone: () => void;
}

/** Ask for a folder with the native picker: null when cancelled; throws with the picker's reason. */
async function pickFolder(): Promise<string | null> {
  const response = await fetch("/api/browse-directory?purpose=import");
  const result = (await response.json()) as { success?: boolean; cancelled?: boolean; path?: string; error?: string };
  if (!result.success) throw new Error(result.error || "The folder picker could not be opened.");
  return result.cancelled || !result.path ? null : result.path;
}

function totalBytes(projects: FoundProject[]): number {
  return projects.reduce((sum, project) => sum + (project.bytes ?? 0), 0);
}

/** "57 projects · 12.8 GB", the size left out while the search could not count it. */
function countAndSize(projects: FoundProject[]): string {
  const bytes = totalBytes(projects);
  return bytes > 0 ? `${formatCount(projects.length, "project")} · ${formatBytes(bytes)}` : formatCount(projects.length, "project");
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * "Bring in your projects": pick the folder an earlier Creativo Melborp saved
 * projects in, see what is there, then make it the Creativo Melborp folder, move
 * the projects into the current one (with progress), or list them where
 * they are. Opened from the welcome dialog, Open's empty state and
 * Settings › Storage.
 */
export function BringInView({ onBack, onClose, onDone }: BringInViewProps) {
  const [phase, setPhase] = useState<Phase>({ kind: "picking" });
  const [root, setRoot] = useState<string | null>(null);
  const [choice, setChoice] = useState<BringInMode>("use");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const leave = onBack ?? onClose;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // The Creativo Melborp folder, for "Move them into …" and the move's destination
  useEffect(() => {
    const controller = new AbortController();
    fetchProjects(controller.signal)
      .then((overview) => {
        if (overview.root) setRoot(overview.root);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const search = useCallback(
    async (cancelled: () => void) => {
      setError(null);
      let folder: string | null;
      try {
        folder = await pickFolder();
      } catch (pickError) {
        if (alive.current) setError(errorText(pickError, "The folder picker could not be opened."));
        return;
      }
      if (!alive.current) return;
      if (!folder) {
        cancelled();
        return;
      }
      setPhase({ kind: "searching", folder });
      try {
        const scan = await scanProjects(folder);
        if (!alive.current) return;
        setChoice(scan.recommendUse ? "use" : "move");
        setPhase({ kind: "results", scan });
      } catch (scanError) {
        if (!alive.current) return;
        setError(errorText(scanError, "That folder could not be searched."));
        setPhase({ kind: "picking" });
      }
    },
    []
  );

  // Opening the view opens the picker; cancelling it goes back
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void search(leave);
  }, [search, leave]);

  const job = phase.kind === "moving" ? phase.job : null;
  const jobRunning = job?.state === "running";
  useEffect(() => {
    if (!job || !jobRunning) return;
    const timer = window.setTimeout(async () => {
      try {
        const next = await fetchJob(job.id);
        followMovedProjects(next);
        if (!alive.current || !next) return;
        setPhase((current) => (current.kind === "moving" ? { ...current, job: next } : current));
      } catch {
        // Asked again on the next tick
        if (alive.current) setPhase((current) => (current.kind === "moving" ? { ...current, job: { ...current.job } } : current));
      }
    }, MOVE_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [job, jobRunning]);

  const confirm = useCallback(async () => {
    if (phase.kind !== "results") return;
    const { scan } = phase;
    setBusy(true);
    setError(null);
    try {
      const result = await bringInProjects({
        dirs: scan.projects.map((project) => project.dir),
        mode: choice,
        ...(choice === "use" ? { folder: scan.root } : {}),
      });
      if (!alive.current) return;
      if (choice === "move" && result.job) {
        setPhase({ kind: "moving", scan, job: result.job });
      } else {
        onDone();
      }
    } catch (bringInError) {
      if (alive.current) setError(errorText(bringInError, "The projects could not be brought in."));
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [phase, choice, onDone]);

  const stop = useCallback(async () => {
    if (!job) return;
    try {
      await cancelJob(job.id);
    } catch (stopError) {
      if (alive.current) setError(errorText(stopError, "The move could not be stopped."));
    }
  }, [job]);

  const rootShort = root ? shortLibraryPath(root) : "your Creativo Melborp folder";

  if (phase.kind === "moving") {
    return <MovingView scan={phase.scan} job={phase.job} root={root} rootShort={rootShort} error={error} onStop={stop} onClose={onClose} onDone={onDone} />;
  }

  const scan = phase.kind === "results" ? phase.scan : null;
  const folder = phase.kind === "searching" ? phase.folder : scan?.root ?? null;
  const found = scan?.projects ?? [];
  const count = found.length;

  return (
    <>
      <DialogPane width={300}>
        <div className="flex flex-col gap-[18px] min-h-0">
          <QuickstartBackButton onClick={leave} />
          <DialogHeadingTitle>Bring in your projects</DialogHeadingTitle>
          {folder && (
            <div className="flex flex-col gap-1.5">
              <DialogEyebrow className="tabular-nums">
                {phase.kind === "searching" ? "Searching…" : count > 0 ? countAndSize(found) : "No projects found"}
              </DialogEyebrow>
              <p className="font-mono text-[11px] leading-4 text-neutral-500 break-all" title={folder}>
                {shortenHomePath(folder)}
              </p>
            </div>
          )}
          {scan && count > 0 && <FoundList root={scan.root} projects={found} grouped={!scan.recommendUse} />}
        </div>
        <div>
          <DialogTextButton className="-ml-1.5" onClick={() => void search(() => {})} disabled={busy || phase.kind === "searching"}>
            Search another folder…
          </DialogTextButton>
        </div>
      </DialogPane>

      <DialogPage data-testid="bring-in-view">
        <DialogPageHead />
        {phase.kind === "searching" ? (
          <Wait spinner>Looking for projects in {shortenHomePath(phase.folder)} and its subfolders…</Wait>
        ) : scan && count > 0 ? (
          <>
            <DialogPageTitle size="md" heading="What should happen to them?" lead="You can change this later in Settings › Storage." />
            <DialogPageBody>
              <div role="radiogroup" aria-label="What to do with the projects" className="flex flex-col gap-2">
                <ChoiceCard
                  checked={choice === "use"}
                  onSelect={() => setChoice("use")}
                  title="Make this my Creativo Melborp folder"
                  recommended={scan.recommendUse === true}
                  description={
                    scan.recommendUse
                      ? `Nothing moves. New projects save here, and generations from workflows you haven’t saved go to ${folderName(scan.root)} › Generations.`
                      : "Nothing moves, but this folder holds more than projects. New projects and unsaved generations would go in it too."
                  }
                />
                <ChoiceCard
                  checked={choice === "move"}
                  onSelect={() => setChoice("move")}
                  title={`Move them into ${rootShort}`}
                  recommended={scan.recommendUse !== true}
                  description={moveDescription(scan, folderName(scan.root))}
                />
                <ChoiceCard
                  checked={choice === "leave"}
                  onSelect={() => setChoice("leave")}
                  title="Leave them where they are"
                  description={`They appear in Open and Assets from where they are. New projects save to ${rootShort}.`}
                />
              </div>
              {error && <p role="alert" className="mt-3 text-xs leading-4 text-red-400">{error}</p>}
            </DialogPageBody>
            <DialogPageFooter>
              <DialogButton variant="ghost" size="md" onClick={leave} disabled={busy}>
                Cancel
              </DialogButton>
              <DialogButton variant="primary" size="md" onClick={() => void confirm()} disabled={busy}>
                {choice === "use" ? "Use this folder" : choice === "move" ? `Move ${formatCount(count, "project")}` : `Add ${formatCount(count, "project")}`}
              </DialogButton>
            </DialogPageFooter>
          </>
        ) : scan ? (
          <Wait>
            No Creativo Melborp projects in {shortenHomePath(scan.root)} or its subfolders.
            {scan.unreadable > 0 && ` ${formatCount(scan.unreadable, "folder")} could not be read.`}
          </Wait>
        ) : (
          <Wait>{error ?? "Choose the folder your projects are in."}</Wait>
        )}
      </DialogPage>
    </>
  );
}

function moveDescription(scan: ScanProjectsResult, name: string): string {
  const count = scan.projects.length;
  const bytes = totalBytes(scan.projects);
  const size = bytes > 0 ? ` (${formatBytes(bytes)})` : "";
  return scan.recommendUse
    ? `Moves the ${formatCount(count, "project")}${size}, keeping their subfolders. Each file is checked before its original is removed.`
    : `Moves only the ${formatCount(count, "project folder")}${size}, keeping their subfolders. Nothing else in ${name} moves.`;
}

/** The pane's 28px heading; it names the dialog. */
function DialogHeadingTitle({ children }: { children: ReactNode }) {
  return <h2 className="font-display text-[28px] leading-8 font-bold tracking-display text-neutral-100">{children}</h2>;
}

/** A centred line on the page, with the spinner while something is on its way. */
function Wait({ spinner = false, children }: { spinner?: boolean; children: ReactNode }) {
  return (
    <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3.5 px-12 pb-6 text-center">
      {spinner && <DialogSpinner />}
      <p className="max-w-[320px] text-[13px] leading-[19px] text-neutral-400">{children}</p>
    </div>
  );
}

/** What the folder holds: each project with its asset count, or where they sit when they are spread out. */
function FoundList({ root, projects, grouped }: { root: string; projects: FoundProject[]; grouped: boolean }) {
  const rows = useMemo(
    () =>
      grouped
        ? groupFoundProjects(root, projects).map((group) => ({ key: group.label, name: group.label, count: formatCount(group.count, "project") }))
        : projects.map((project) => ({ key: project.dir, name: project.name, count: formatCount(project.mediaCount) })),
    [root, projects, grouped]
  );
  return (
    <ul
      aria-label={grouped ? "Folders with projects" : "Projects found"}
      className={cn("flex flex-col max-h-[190px] overflow-y-auto", rows.length > LONG_LIST && "[mask-image:linear-gradient(#000_78%,transparent)]")}
    >
      {rows.map((row) => (
        <li key={row.key} className="flex items-baseline justify-between gap-3 py-1 text-xs leading-4 text-neutral-400">
          <span className="min-w-0 truncate" title={row.name}>{row.name}</span>
          <span className="shrink-0 font-mono text-[11px] text-neutral-500 tabular-nums">{row.count}</span>
        </li>
      ))}
    </ul>
  );
}

/** One of the three answers: a radio card with a title, a line of detail and maybe "Recommended". */
function ChoiceCard({
  checked,
  onSelect,
  title,
  description,
  recommended = false,
}: {
  checked: boolean;
  onSelect: () => void;
  title: string;
  description: string;
  recommended?: boolean;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className={cn(
        "flex items-start gap-3 w-full px-3.5 py-3 rounded-[10px] border text-left transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection focus-visible:ring-offset-2 focus-visible:ring-offset-canvas-bg",
        checked ? "border-neutral-400 bg-white/[0.03]" : "border-card-border hover:border-neutral-600 hover:bg-white/[0.02]"
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "shrink-0 flex items-center justify-center w-4 h-4 mt-px rounded-full border-[1.5px]",
          checked ? "border-neutral-200" : "border-neutral-600"
        )}
      >
        {checked && <span className="w-2 h-2 rounded-full bg-neutral-200" />}
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-2 font-display text-sm leading-[18px] font-semibold tracking-[-0.01em] text-neutral-100">
          {title}
          {recommended && <DialogChip>Recommended</DialogChip>}
        </span>
        <span className="block mt-0.5 text-xs leading-4 text-ink-3">{description}</span>
      </span>
    </button>
  );
}

/** The quiet box with an info glyph, under the progress and in the stopped state. */
function Note({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg border border-card-border bg-white/[0.02] text-xs leading-4 text-neutral-300">
      <Info size={16} strokeWidth={1.75} className="shrink-0 text-ink-3" />
      <span>{children}</span>
    </div>
  );
}

/** W3: the projects move, with each project's state in the pane and the job's progress on the page. */
function MovingView({
  scan,
  job,
  root,
  rootShort,
  error,
  onStop,
  onClose,
  onDone,
}: {
  scan: ScanProjectsResult;
  job: LibraryJobStatus;
  root: string | null;
  rootShort: string;
  error: string | null;
  onStop: () => void;
  onClose: () => void;
  onDone: () => void;
}) {
  const projects = scan.projects;
  const total = projects.length;
  const states = moveRowStates(projects, job);
  const movedCount = states.filter((state) => state === "done").length;
  const current = projects[states.indexOf("now")];
  const percent = movePercent(job);

  return (
    <>
      <DialogPane width={300}>
        <div className="flex flex-col gap-[18px] min-h-0">
          <DialogHeadingTitle>Bringing in your projects</DialogHeadingTitle>
          <div className="flex flex-col gap-1.5">
            <DialogEyebrow className="tabular-nums">{countAndSize(projects)}</DialogEyebrow>
            {root && (
              <p className="font-mono text-[11px] leading-4 text-neutral-500 break-all" title={root}>
                to {shortenHomePath(root)}
              </p>
            )}
          </div>
          <ul
            aria-label="Projects"
            className={cn("flex flex-col max-h-[236px] overflow-y-auto", total > LONG_LIST && "[mask-image:linear-gradient(#000_78%,transparent)]")}
          >
            {projects.map((project, index) => {
              const state = states[index];
              return (
                <li
                  key={project.dir}
                  data-state={state}
                  className={cn(
                    "flex items-baseline justify-between gap-3 py-1 text-xs leading-4",
                    state === "done" ? "text-neutral-500" : state === "now" ? "text-neutral-100" : "text-neutral-600"
                  )}
                >
                  <span className="flex-1 min-w-0 truncate">{project.name}</span>
                  {state === "done" && <Check size={12} strokeWidth={2} className="shrink-0 self-center" aria-label="Moved" />}
                  {state === "now" && <LoaderCircle size={12} strokeWidth={2.5} className="shrink-0 self-center animate-spin" aria-label="Moving" />}
                </li>
              );
            })}
          </ul>
        </div>
        <DialogPaneFoot version={APP_VERSION || undefined} />
      </DialogPane>

      <DialogPage data-testid="bring-in-moving">
        <DialogPageHead />
        {job.state === "running" ? (
          <>
            <DialogPageTitle size="md" heading={`Moving ${formatCount(total, "project")}`} lead={`Into ${rootShort}. Closing this won’t stop it.`} />
            <DialogPageBody className="flex flex-col gap-4">
              <div>
                <div className="flex items-baseline justify-between gap-3">
                  <DialogRowTitle className="min-w-0 truncate">{current?.name ?? "Preparing…"}</DialogRowTitle>
                  <DialogEyebrow className="text-neutral-400 tabular-nums">{percent}%</DialogEyebrow>
                </div>
                <div
                  role="progressbar"
                  aria-label="Moving projects"
                  aria-valuemin={0}
                  aria-valuemax={job.total}
                  aria-valuenow={job.done}
                  className="mt-2.5 h-1 rounded-full bg-card overflow-hidden"
                >
                  <div className="h-full rounded-full bg-neutral-200 transition-[width] duration-300" style={{ width: `${percent}%` }} />
                </div>
                <p className="mt-2 font-mono text-[11px] leading-4 text-ink-3 tabular-nums">
                  {job.done.toLocaleString("en-US")} of {formatCount(job.total, "file")}
                  {job.bytesTotal > 0 && ` · ${formatBytes(job.bytesDone)} of ${formatBytes(job.bytesTotal)}`}
                </p>
              </div>
              <Note>
                Each project is copied and checked before its original is removed. If the move stops, finished projects stay
                moved and the rest stay where they were. Open and Assets keep working the whole time.
              </Note>
              {error && <p role="alert" className="text-xs leading-4 text-red-400">{error}</p>}
            </DialogPageBody>
            <DialogPageFooter>
              <DialogButton variant="ghost" size="md" onClick={onStop}>
                Stop move
              </DialogButton>
              <DialogButton variant="primary" size="md" onClick={onClose}>
                Close
              </DialogButton>
            </DialogPageFooter>
          </>
        ) : (
          <>
            <DialogPageTitle size="md" {...finishedTitle(job, movedCount, total, rootShort)} />
            <DialogPageBody>
              {job.state === "done" && !job.moved?.some((entry) => entry.leftovers) ? null : (
                <Note>{finishedNote(job, movedCount, total)}</Note>
              )}
            </DialogPageBody>
            <DialogPageFooter>
              <DialogButton variant="primary" size="md" onClick={onDone}>
                Done
              </DialogButton>
            </DialogPageFooter>
          </>
        )}
      </DialogPage>
    </>
  );
}

function finishedTitle(job: LibraryJobStatus, moved: number, total: number, rootShort: string): { heading: string; lead: string } {
  if (job.state === "done") return { heading: `Moved ${formatCount(moved, "project")}`, lead: `They are in ${rootShort} now.` };
  return {
    heading: job.state === "failed" ? "Move failed" : "Move stopped",
    lead: `${moved.toLocaleString("en-US")} of ${formatCount(total, "project")} moved to ${rootShort}.`,
  };
}

function finishedNote(job: LibraryJobStatus, moved: number, total: number): string {
  if (job.state === "done") return job.message ?? "Some files could not be removed from the old folders.";
  const rest = total - moved;
  const others = `The other ${rest.toLocaleString("en-US")} ${rest === 1 ? "is" : "are"} where ${rest === 1 ? "it was" : "they were"}.`;
  const all = total === 1 ? "It is in Open and Assets" : `All ${total.toLocaleString("en-US")} are in Open and Assets`;
  const reason = job.state === "failed" && job.error ? `${job.error} ` : "";
  return `${reason}${others} ${all}, and Settings › Storage can move the rest later.`;
}
