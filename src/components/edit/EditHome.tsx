"use client";

import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { Film, Plus } from "lucide-react";
import { DialogButton, DialogSpinner } from "@/components/ui/Dialog";
import { useLibraryAvailable } from "@/components/stitch/library/useLibraryAvailable";
import type { EditListProblem } from "@/lib/edits/types";
import { useEditProjectStore } from "@/store/editProjectStore";
import { EditCard } from "./EditCard";
import { revealText } from "./EditMenu";

function problemText(problem: EditListProblem): string {
  switch (problem.problem) {
    case "unreadable":
      return `Couldn't read ${problem.fileName}`;
    case "newer":
      return `${problem.fileName} was made by a newer Node Banana`;
    case "duplicate":
      return problem.name ? `${problem.fileName} is a copy of “${problem.name}”` : `${problem.fileName} is a copy of another edit`;
  }
}

/** The card the arrow key moves to: across by one, or the nearest card in the row above or below. */
function nextCard(cards: HTMLElement[], from: number, key: string): number | null {
  if (key === "ArrowRight") return Math.min(from + 1, cards.length - 1);
  if (key === "ArrowLeft") return Math.max(from - 1, 0);
  if (key === "Home") return 0;
  if (key === "End") return cards.length - 1;
  if (key !== "ArrowDown" && key !== "ArrowUp") return null;
  const here = cards[from].getBoundingClientRect();
  let best: { index: number; dy: number; dx: number } | null = null;
  for (let index = 0; index < cards.length; index++) {
    const rect = cards[index].getBoundingClientRect();
    const dy = key === "ArrowDown" ? rect.top - here.top : here.top - rect.top;
    if (dy <= 1) continue;
    const dx = Math.abs(rect.left - here.left);
    if (!best || dy < best.dy - 1 || (Math.abs(dy - best.dy) <= 1 && dx < best.dx)) best = { index, dy, dx };
  }
  return best?.index ?? from;
}

/**
 * The Edit video view with no edit open: the edits in the Node Banana folder's
 * Edits, newest first, as cards; New edit; Show in Finder for the folder; and
 * the files that are not edits it can open (unreadable, from a newer Node
 * Banana, a copy made in Finder). The arrow keys move between the cards.
 */
export function EditHome({ newEditRef }: { newEditRef: RefObject<HTMLButtonElement | null> }) {
  const list = useEditProjectStore((s) => s.list);
  const creating = useEditProjectStore((s) => s.creating);
  const libraryOn = useLibraryAvailable();
  const [focusIndex, setFocusIndex] = useState(0);
  const gridRef = useRef<HTMLDivElement>(null);
  const store = useEditProjectStore.getState;

  const newEdit = (
    <DialogButton
      ref={newEditRef}
      variant="primary"
      disabled={creating || !libraryOn}
      onClick={() => void store().newEdit()}
      className="focus-visible:ring-offset-pane"
    >
      <Plus size={14} strokeWidth={2} />
      {creating ? "Creating…" : "New edit"}
    </DialogButton>
  );

  const onGridKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const cards = Array.from(gridRef.current?.querySelectorAll<HTMLElement>("[data-edit-card]") ?? []);
    const from = cards.indexOf(document.activeElement as HTMLElement);
    if (from === -1) return;
    const next = nextCard(cards, from, event.key);
    if (next === null) return;
    event.preventDefault();
    setFocusIndex(next);
    cards[next]?.focus();
  };

  let body;
  if (!libraryOn) {
    body = <Centered>The asset library is off, so edits cannot be saved or opened.</Centered>;
  } else if (list.status === "error" && list.edits.length === 0) {
    body = (
      <Centered>
        <span>{list.error ?? "The edits could not be read."}</span>
        <DialogButton variant="ghost" compact onClick={() => void store().refreshList()}>
          Try again
        </DialogButton>
      </Centered>
    );
  } else if (list.status !== "ready" && list.edits.length === 0) {
    body = (
      <div aria-busy className="flex justify-center py-24">
        <DialogSpinner />
      </div>
    );
  } else if (list.edits.length === 0) {
    body = (
      <div className="flex flex-col items-center gap-3 py-24 text-center">
        <Film size={40} strokeWidth={1.25} className="text-neutral-600" aria-hidden="true" />
        <div className="text-[13px] font-semibold text-neutral-200">No edits yet</div>
        <p className="max-w-[320px] text-[13px] text-ink-3">An edit puts videos and audio from any project on one timeline.</p>
        <div className="mt-2">{newEdit}</div>
      </div>
    );
  } else {
    const focus = Math.min(focusIndex, list.edits.length - 1);
    body = (
      <div
        ref={gridRef}
        role="list"
        aria-label="Edits"
        onKeyDown={onGridKeyDown}
        className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4"
      >
        {list.edits.map((edit, i) => (
          <EditCard key={edit.id} edit={edit} tabIndex={i === focus ? 0 : -1} />
        ))}
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-pane">
      <div className="mx-auto max-w-[1040px] px-8 pb-12 pt-8">
        <div className="mb-6 flex items-start justify-between gap-6">
          <div className="min-w-0">
            <h1 className="font-display text-base font-semibold text-neutral-100">Edit video</h1>
            <p className="mt-1 text-[13px] text-ink-3" title={list.folder ?? undefined}>
              Edits use videos and audio from any project. They are saved in your Node Banana folder, under Edits.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <DialogButton
              variant="ghost"
              disabled={!libraryOn}
              onClick={() => void store().revealFolder()}
              className="focus-visible:ring-offset-pane"
            >
              {revealText()}
            </DialogButton>
            {list.edits.length > 0 || list.status !== "ready" ? newEdit : null}
          </div>
        </div>
        {body}
        {list.problems.length > 0 && (
          <ul aria-label="Other files in the Edits folder" className="mt-8 flex flex-col gap-2 border-t border-chrome-border pt-4">
            {list.problems.map((problem) => (
              <li key={problem.fileName} className="flex items-center gap-3 text-[12px] text-neutral-400">
                <span className="min-w-0 truncate">{problemText(problem)}</span>
                <div className="ml-auto flex shrink-0 items-center gap-1">
                  {problem.problem === "duplicate" && (
                    <DialogButton variant="ghost" compact onClick={() => void store().separateDuplicate(problem.fileName)}>
                      Make it a separate edit
                    </DialogButton>
                  )}
                  <DialogButton variant="ghost" compact onClick={() => void store().revealFolder()}>
                    {revealText()}
                  </DialogButton>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex flex-col items-center gap-3 py-24 text-center text-[13px] text-neutral-500">{children}</div>;
}
