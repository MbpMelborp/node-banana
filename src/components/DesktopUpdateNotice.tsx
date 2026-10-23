"use client";

import { ArrowDownToLine, CircleAlert, CircleCheck, RefreshCw, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { DesktopUpdateState } from "@/types/desktop";
import { CHROME_SURFACE } from "./chromeStyles";

/** How long "Up to date" stays up after a manual check. */
const UP_TO_DATE_MS = 4000;

const STRONG = "h-7 shrink-0 whitespace-nowrap rounded-md bg-neutral-200 px-2.5 text-xs font-semibold text-neutral-900 transition-colors duration-[120ms] hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30";
const QUIET = "h-7 shrink-0 whitespace-nowrap rounded-md px-2.5 text-xs font-medium text-neutral-200 transition-colors duration-[120ms] hover:bg-white/7 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30";

/**
 * The desktop app's update notice, one row in the notification stack, the
 * shape of the server banner: offered when a newer release exists, following
 * the download, and asking to restart once it is ready. The cross puts it
 * away until the next check. Nothing renders in the browser or while there is
 * nothing to say.
 */
export function DesktopUpdateNotice() {
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  useEffect(() => {
    const updates = window.nodeBananaDesktop?.updates;
    if (!updates) return;
    let active = true;
    const unsubscribe = updates.onChange(next => { if (active) setState(next); });
    void updates.state().then(next => { if (active) setState(next); }).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, []);
  // A manual check that found nothing is worth a moment, not a fixture.
  useEffect(() => {
    if (state?.status !== "current") return;
    const timer = setTimeout(() => void window.nodeBananaDesktop?.updates.dismiss(), UP_TO_DATE_MS);
    return () => clearTimeout(timer);
  }, [state]);
  if (!state || !state.supported) return null;
  if (state.status === "idle" || (state.status === "checking" && !state.manual) || (state.status === "current" && !state.manual)) return null;

  const updates = window.nodeBananaDesktop!.updates;
  const openRelease = () => { if (state.url) window.open(state.url, "_blank", "noopener"); };
  let icon: ReactNode = <ArrowDownToLine size={16} strokeWidth={1.75} className="text-neutral-300" />;
  let text: string;
  let muted: string | null = null;
  let actions: ReactNode = null;
  let dismiss = true;
  let progress: number | null = null;
  switch (state.status) {
    case "checking":
      icon = <RefreshCw size={16} strokeWidth={1.75} className="animate-spin text-neutral-300" />;
      text = "Checking for updates…";
      dismiss = false;
      break;
    case "current":
      icon = <CircleCheck size={16} strokeWidth={1.75} className="text-emerald-400" />;
      text = "Up to date";
      dismiss = false;
      break;
    case "available":
      text = `Creativo Melborp ${state.version} is available`;
      actions = <>
        <button type="button" className={STRONG} onClick={() => void updates.download()}>Update</button>
        <button type="button" className={QUIET} onClick={() => void updates.skip()}>Skip</button>
      </>;
      break;
    case "downloading":
      icon = <RefreshCw size={16} strokeWidth={1.75} className="animate-spin text-neutral-300" />;
      text = `Downloading ${state.version}`;
      muted = `${state.percent ?? 0}%`;
      progress = state.percent ?? 0;
      dismiss = false;
      break;
    case "downloaded":
      icon = <CircleCheck size={16} strokeWidth={1.75} className="text-emerald-400" />;
      text = `${state.version} is ready`;
      actions = <button type="button" className={STRONG} onClick={() => void updates.install()}>Restart to update</button>;
      break;
    case "error":
      icon = <CircleAlert size={16} strokeWidth={1.75} className="text-amber-400" />;
      text = state.version ? "Update failed" : "Couldn’t check for updates";
      actions = state.version && state.url ? <button type="button" className={QUIET} onClick={openRelease}>Get the installer</button> : null;
      break;
  }
  return (
    <div role="status" data-testid="desktop-update-notice" title={state.error} className={`${CHROME_SURFACE} animate-drop-in relative flex h-10 w-max max-w-full items-center gap-3 overflow-hidden rounded-xl pl-3.5 ${dismiss || actions ? "pr-1.5" : "pr-3.5"}`}>
      <span className="flex shrink-0">{icon}</span>
      <span className="whitespace-nowrap text-xs leading-4 text-neutral-200">
        {text}{muted && <> <span className="text-neutral-400">{muted}</span></>}
      </span>
      {(actions || dismiss) && (
        <span className="ml-1 flex shrink-0 items-center gap-0.5">
          {actions}
          {dismiss && (
            <button type="button" aria-label="Dismiss update notice" className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition-colors duration-[120ms] hover:bg-white/7 hover:text-white" onClick={() => void updates.dismiss()}>
              <X size={14} strokeWidth={1.75} />
            </button>
          )}
        </span>
      )}
      {progress !== null && (
        <span role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-label="Download progress" className="absolute inset-x-0 bottom-0 h-0.5 bg-white/8">
          <span className="block h-full bg-neutral-200 transition-[width] duration-300" style={{ width: `${progress}%` }} />
        </span>
      )}
    </div>
  );
}
