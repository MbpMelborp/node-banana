"use client";

import { DialogButton } from "@/components/ui/Dialog";
import { cn } from "@/components/agent/lib/utils";
import {
  chooserOrder,
  HARNESS_BILLING_COPY,
  HARNESS_LABELS,
  readinessTone,
  type AgentReadiness,
} from "@/lib/agent/client/readiness";
import { AGENT_HARNESS_IDS, type AgentHarnessId } from "@/lib/agent/types";
import { InlineSpinner, StatusDot } from "./AgentChrome";
import { AgentTextButton } from "./AgentNotice";
import { HarnessIcon } from "./HarnessIcon";
import { CardHeading } from "./AgentSignInCard";
import { RefreshCwIcon } from "lucide-react";

/** What picking an option does: its harness's sign-in starts, or its card shows (install, switch). */
export type AgentChooserAction = "sign_in" | "show";

export interface AgentChooserCardProps {
  readiness: Record<AgentHarnessId, AgentReadiness>;
  onPick: (harness: AgentHarnessId, action: AgentChooserAction) => void;
  onCheckAgain: () => void;
  checking?: boolean;
}

/** The option row's status, in one or two words, and what its button does. */
function describeOption(readiness: AgentReadiness): { status: string; action: string; kind: AgentChooserAction; primary: boolean } {
  switch (readiness.kind) {
    case "ready":
      return { status: readiness.status.account?.plan ? `Signed in · ${readiness.status.account.plan}` : "Signed in", action: "Use", kind: "show", primary: true };
    case "signed_out":
    case "sign_in_failed":
      return { status: "Signed out", action: "Sign in", kind: "sign_in", primary: true };
    case "signing_in":
      return { status: "Signing in", action: "Continue", kind: "show", primary: true };
    case "wrong_billing":
      return { status: "Wrong account", action: "Switch account", kind: "show", primary: false };
    case "unconfirmed_billing":
      return { status: "No subscription", action: "Switch account", kind: "show", primary: false };
    case "not_installed":
      return { status: "Not installed", action: "Install", kind: "show", primary: false };
    case "unavailable":
      return { status: "Unavailable", action: "Details", kind: "show", primary: false };
    case "loading":
      return { status: "Checking", action: "Wait", kind: "show", primary: false };
  }
}

/** What the harness runs on, or what's wrong with its login, under the name. */
function describeSubline(harness: AgentHarnessId, readiness: AgentReadiness): string {
  if (readiness.kind === "wrong_billing") return "Signed in to an account that bills API credits, not a subscription";
  if (readiness.kind === "unconfirmed_billing") return `Signed in, but no ${HARNESS_BILLING_COPY[harness].plan} was found on the account`;
  return HARNESS_BILLING_COPY[harness].runsOn;
}

/**
 * First open, when neither harness has a paid subscription: both, with
 * their real state and one action each. Rows are the header menu's rows, so
 * there is no separate Back; the closest-to-working harness is listed first
 * and highlighted.
 */
export function AgentChooserCard({ readiness, onPick, onCheckAgain, checking = false }: AgentChooserCardProps) {
  const order = chooserOrder(readiness).filter((id) => (AGENT_HARNESS_IDS as readonly string[]).includes(id));
  return (
    <div data-testid="agent-chooser" className="flex w-full flex-col gap-5 px-4 pb-6 pt-5">
      <CardHeading harness="Agent" tone="unknown" pulse={false} title="Choose how to run the agent" size="full">
        Creativo Melborp runs the agent on a paid subscription you already have. Pick one to sign in; you can switch later
        from the header.
      </CardHeading>
      <div className="flex flex-col gap-2.5">
        {order.map((id, index) => {
          const current = readiness[id];
          const option = describeOption(current);
          return (
            <div
              key={id}
              data-testid={`agent-chooser-${id}`}
              className={cn(
                "flex flex-col gap-2.5 rounded-[10px] border bg-card p-3",
                index === 0 ? "border-white/[0.18]" : "border-white/[0.08]",
              )}
            >
              <div className="flex items-start gap-2.5">
                <HarnessIcon harness={id} className="mt-0.5 size-5" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2.5">
                    <span className="font-display text-sm font-semibold text-neutral-100">{HARNESS_LABELS[id]}</span>
                    <span className="ml-auto inline-flex items-center gap-1.5 whitespace-nowrap font-mono text-[10px] uppercase tracking-eyebrow text-ink-3">
                      <StatusDot tone={readinessTone(current)} />
                      {option.status}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs leading-4 text-neutral-400">{describeSubline(id, current)}</p>
                </div>
              </div>
              <DialogButton
                variant={option.primary ? "primary" : "outline"}
                size="md"
                data-agent-choose={id}
                onClick={() => onPick(id, option.kind)}
                className="w-full justify-center"
              >
                {option.action}
              </DialogButton>
            </div>
          );
        })}
      </div>
      <p className="text-[11px] leading-4 text-ink-3">
        Signed in from a terminal already?{" "}
        <AgentTextButton onClick={onCheckAgain} disabled={checking} className="!h-auto !p-0 text-[11px] underline decoration-white/30 underline-offset-2">
          {checking ? <InlineSpinner /> : <RefreshCwIcon aria-hidden="true" strokeWidth={1.75} />}
          {checking ? "Checking…" : "Check again"}
        </AgentTextButton>
      </p>
    </div>
  );
}
