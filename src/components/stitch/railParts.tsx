"use client";

import type { ReactNode } from "react";
import { Kbd } from "@/components/ui/Kbd";

/** A rail row: its label at the left, its control at the right. */
export function RailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="h-7 flex items-center justify-between gap-3">
      <span className="text-xs text-neutral-400">{label}</span>
      {children}
    </div>
  );
}

/** The keys under a rail's actions, each beside what it does. */
export function KeyHints({ hints }: { hints: ReadonlyArray<{ key: string; text: string }> }) {
  return (
    <div className="mt-4 flex flex-col gap-1.5 text-[11px] text-neutral-500">
      {hints.map((hint) => (
        <div key={hint.key} className="flex items-center gap-1.5">
          {/* One cap width, so the texts start in one column (⇧ and ⌥ are wider than I and O) */}
          <Kbd size="sm" className="w-[22px] px-0">
            {hint.key}
          </Kbd>
          <span>{hint.text}</span>
        </div>
      ))}
    </div>
  );
}
