"use client";

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { FolderOpen, Plus } from "lucide-react";
import { cn } from "@/components/nodes/ui/cn";
import { tileThumbUrl } from "@/components/assets/AssetTile";
import { DialogSpinner } from "@/components/ui/Dialog";
import { Tooltip } from "@/components/ui/Tooltip";
import { ICON_BUTTON } from "@/components/stitch/editorStyles";
import { useLibraryAvailable } from "@/components/stitch/library/useLibraryAvailable";
import type { EditListProblem, EditSummary } from "@/lib/edits/types";
import { useEditProjectStore } from "@/store/editProjectStore";
import { EditIndexRow, INDEX_SCROLLER, type PointerSpot } from "./EditIndexRow";
import { revealText } from "./EditMenu";
import { editCardMeta } from "./editMeta";
import { EditPreview, EmptyPreview, PREVIEW_THUMB_PX } from "./EditPreview";

const BLURB = "An edit puts videos and audio from any project on one timeline.";

/** How many of the newest edits' posters are fetched ahead, so moving down the list never shows an empty frame. */
const PRELOAD_POSTERS = 24;

/** Marks the list of edits: ↑ and ↓ inside it are its own. */
const INDEX_LIST = "data-edit-index";

/**
 * New edit: the one white button. Its focus ring, like the rows' and the
 * empty entry's fill, shows only once a key has been pressed (`data-keyed`):
 * the focus the home gives it as it shows stays unmarked.
 */
const NEW_EDIT_BUTTON =
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-neutral-100 pl-2.5 pr-3.5 text-[13px] font-semibold text-neutral-950 transition-colors hover:bg-white focus-visible:outline-none in-data-[keyed]:focus-visible:ring-2 in-data-[keyed]:focus-visible:ring-white/40 in-data-[keyed]:focus-visible:ring-offset-2 in-data-[keyed]:focus-visible:ring-offset-pane disabled:cursor-not-allowed disabled:opacity-50";

/** The quiet text button: Try again. */
const QUIET_BUTTON =
  "inline-flex h-7 shrink-0 items-center rounded-md px-2 text-[12px] text-neutral-400 transition-colors hover:bg-white/6 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40";

/** An other file's action (Make it a separate edit): no brighter than the line it ends. */
const PROBLEM_BUTTON = cn(QUIET_BUTTON, "text-ink-3");

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

/**
 * The Edit video view with no edit open, as an index: the edits in the Node
 * Banana folder's Edits, newest first, one name to a row, beside a preview of
 * the active one (the row under the pointer or with focus; it stays on the
 * last one hovered and starts on the newest). ↑ ↓ Home End move, Enter opens.
 * Above them New edit and the Edits folder; under them the files that are not
 * edits it can open (unreadable, from a newer Node Banana, a copy made in
 * Finder). With no edits the list holds New edit, beside an empty frame.
 */
export function EditHome({ newEditRef }: { newEditRef: RefObject<HTMLButtonElement | null> }) {
  const list = useEditProjectStore((s) => s.list);
  const creating = useEditProjectStore((s) => s.creating);
  const libraryOn = useLibraryAvailable();
  const store = useEditProjectStore.getState;
  // A key pressed since the home showed: from then on keyboard focus is marked (the focus New edit takes on arrival is not)
  const [keyed, setKeyed] = useState(false);

  useEffect(() => {
    if (keyed) return;
    const onKey = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey && !event.altKey) setKeyed(true);
    };
    document.addEventListener("keydown", onKey, { capture: true });
    return () => document.removeEventListener("keydown", onKey, { capture: true });
  }, [keyed]);

  // ↑ or ↓ from New edit (which takes focus as the home shows) or the other buttons goes to the active row
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const target = event.target as HTMLElement;
    if (target.tagName !== "BUTTON" || target.closest(`[${INDEX_LIST}]`)) return;
    const row = event.currentTarget.querySelector<HTMLElement>("[data-edit-row][tabindex='0']");
    if (!row) return;
    event.preventDefault();
    row.focus();
  };

  let body;
  if (!libraryOn) {
    body = <Centered>The asset library is off, so edits cannot be saved or opened.</Centered>;
  } else if (list.status === "error" && list.edits.length === 0) {
    body = (
      <Centered>
        <span>{list.error ?? "The edits could not be read."}</span>
        <button type="button" className={QUIET_BUTTON} onClick={() => void store().refreshList()}>
          Try again
        </button>
        {/* A failed read again keeps the files the last one found */}
        <Problems problems={list.problems} />
      </Centered>
    );
  } else if (list.status !== "ready" && list.edits.length === 0) {
    body = (
      <div aria-busy className="flex flex-1 items-center justify-center pb-24">
        <DialogSpinner />
      </div>
    );
  } else if (list.edits.length === 0) {
    body = (
      <Body preview={<EmptyPreview />}>
        <button
          ref={newEditRef}
          type="button"
          disabled={creating}
          onClick={() => void store().newEdit()}
          className="-mx-2 flex h-12 shrink-0 items-center gap-3 self-start rounded-md px-2 font-display text-[22px] font-medium leading-[1.2] tracking-[-0.02em] text-neutral-100 transition-colors focus-visible:outline-none in-data-[keyed]:focus-visible:bg-white/6 disabled:opacity-50"
        >
          <Plus size={22} strokeWidth={1.5} aria-hidden="true" />
          {creating ? "Creating…" : "New edit"}
        </button>
        <p className="mt-2 max-w-[320px] text-[14px] leading-5 text-ink-3">{BLURB}</p>
        <Problems problems={list.problems} />
      </Body>
    );
  } else {
    body = <EditIndex edits={list.edits} problems={list.problems} />;
  }

  return (
    <div data-keyed={keyed || undefined} className="@container flex min-h-0 min-w-0 flex-1 flex-col bg-pane" onKeyDown={onKeyDown}>
      <div className="flex min-h-0 flex-1 flex-col px-24 pb-12 pt-12 @max-[1280px]:px-12">
        <div className="flex h-8 shrink-0 items-center justify-between gap-6">
          {/* Where the edits are, on hover, as the old home's line said */}
          <h1 title={list.folder ?? undefined} className="text-[13px] font-medium leading-none text-neutral-400">
            Edits
          </h1>
          <div className="flex items-center gap-2">
            {(list.edits.length > 0 || list.status !== "ready") && (
              <button
                ref={newEditRef}
                type="button"
                disabled={creating || !libraryOn}
                onClick={() => void store().newEdit()}
                className={NEW_EDIT_BUTTON}
              >
                <Plus size={16} strokeWidth={1.5} aria-hidden="true" />
                {creating ? "Creating…" : "New edit"}
              </button>
            )}
            <div className="group relative flex">
              <button
                type="button"
                aria-label={revealText()}
                disabled={!libraryOn}
                onClick={() => void store().revealFolder()}
                className={cn(ICON_BUTTON, "h-8 w-8 rounded-lg text-ink-3 focus-visible:ring-white/40")}
              >
                <FolderOpen size={16} strokeWidth={1.5} />
              </button>
              <Tooltip label={revealText()} placement="bottom" align="end" />
            </div>
          </div>
        </div>
        {body}
      </div>
    </div>
  );
}

/**
 * The edits, one to a row, and the active one's preview. Keyboard focus and
 * the active row stay together: the pointer taking another row takes focus
 * in the list with it, so the focused row is always the lit one and its ⋯
 * never goes away under focus.
 */
function EditIndex({ edits, problems }: { edits: EditSummary[]; problems: EditListProblem[] }) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const listRef = useRef<HTMLUListElement>(null);
  // Where the pointer last was over a row, and where it was when ↑ ↓ Home End last moved focus
  const pointerAt = useRef<PointerSpot | null>(null);
  const keysAt = useRef<PointerSpot | null>(null);
  const active = edits.find((edit) => edit.id === activeId) ?? edits[0];
  // A row's open menu or name field keeps the preview on it while the pointer wanders
  const held = menuId !== null || renamingId !== null;

  const onPointer = (id: string, at: PointerSpot) => {
    pointerAt.current = at;
    // The list scrolled to the focused row under a pointer that has not moved since the keys: not a hover
    if (keysAt.current && keysAt.current.x === at.x && keysAt.current.y === at.y) return;
    keysAt.current = null;
    if (held) return;
    setActiveId(id);
    const row = rows.current.get(id);
    const focused = document.activeElement;
    if (row && focused !== row && listRef.current?.contains(focused)) row.focus({ preventScroll: true });
  };

  useEffect(() => {
    for (const edit of edits.slice(0, PRELOAD_POSTERS)) {
      if (edit.poster) new Image().src = tileThumbUrl(edit.poster, PREVIEW_THUMB_PX);
    }
  }, [edits]);

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLUListElement>) => {
    const from = edits.findIndex((edit) => edit.id === (event.target as HTMLElement).dataset.editRow);
    if (from === -1) return;
    let next: number;
    if (event.key === "ArrowDown") next = Math.min(from + 1, edits.length - 1);
    else if (event.key === "ArrowUp") next = Math.max(from - 1, 0);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = edits.length - 1;
    else return;
    event.preventDefault();
    keysAt.current = pointerAt.current;
    setActiveId(edits[next].id);
    rows.current.get(edits[next].id)?.focus();
  };

  // A wheel scrolls rows under a still pointer: the row that comes under it is hovered, as the browser shows
  const onWheel = () => {
    keysAt.current = null;
  };

  const setRenaming = (id: string, renaming: boolean) => {
    setRenamingId(renaming ? id : null);
    if (renaming) return;
    useEditProjectStore.setState({ renameError: null });
    // Enter or Escape took the field away with focus in it: give focus back to the row
    requestAnimationFrame(() => {
      if (document.activeElement === document.body) rows.current.get(id)?.focus({ preventScroll: true });
    });
  };

  return (
    <Body preview={<EditPreview edit={active} />}>
      <ul
        ref={listRef}
        aria-label="Edits"
        {...{ [INDEX_LIST]: "" }}
        onKeyDown={onListKeyDown}
        onWheel={onWheel}
      >
        {edits.map((edit) => (
          <EditIndexRow
            key={edit.id}
            edit={edit}
            active={edit.id === active.id}
            menuOpen={menuId === edit.id}
            renaming={renamingId === edit.id}
            openRef={(el) => {
              if (el) rows.current.set(edit.id, el);
              else rows.current.delete(edit.id);
            }}
            onPointer={(at) => onPointer(edit.id, at)}
            onFocusIn={() => setActiveId(edit.id)}
            onMenuChange={(open) => setMenuId(open ? edit.id : null)}
            onRenamingChange={(renaming) => setRenaming(edit.id, renaming)}
          />
        ))}
      </ul>
      {/* With no room for the preview, its caption stays: under the list, and at the column's foot while the list scrolls */}
      <p
        aria-hidden="true"
        data-edit-caption
        className="sticky bottom-0 hidden truncate bg-pane pt-3 text-[13px] leading-[18px] text-ink-3 tabular-nums @max-[980px]:block"
      >
        {editCardMeta(active).text}
      </p>
      <Problems problems={problems} />
    </Body>
  );
}

/**
 * The page under the top row: the 500 px list column (its own scroller, so a
 * long list scrolls inside it) and the preview, right-aligned, up to 680 px
 * and no taller than the column (a size container the preview fits itself
 * to). A view with no room for a preview about 320 px wide keeps the list
 * alone.
 */
function Body({ children, preview }: { children: ReactNode; preview: ReactNode }) {
  return (
    <div className="mt-24 flex min-h-0 flex-1 gap-14">
      <div className="-mt-2 flex w-[500px] min-w-0 flex-col">
        <div {...{ [INDEX_SCROLLER]: "" }} className="-mx-2 flex min-h-0 flex-1 flex-col overflow-y-auto px-2">
          {children}
        </div>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 items-start justify-end overflow-y-auto [container-type:size] @max-[980px]:hidden">
        {preview}
      </div>
    </div>
  );
}

/**
 * The files in the Edits folder that are not edits it can open, in quiet
 * rows under the list. A Finder copy can be made a separate edit; the top
 * row's folder button shows them all.
 */
function Problems({ problems }: { problems: EditListProblem[] }) {
  const store = useEditProjectStore.getState;
  if (problems.length === 0) return null;
  return (
    <ul aria-label="Other files in the Edits folder" className="mt-6 flex shrink-0 flex-col">
      {problems.map((problem) => (
        <li key={problem.fileName} className="flex min-h-8 items-center gap-3 text-[12px] text-ink-3">
          <span className="min-w-0 truncate">{problemText(problem)}</span>
          {problem.problem === "duplicate" && (
            <button type="button" className={cn(PROBLEM_BUTTON, "ml-auto")} onClick={() => void store().separateDuplicate(problem.fileName)}>
              Make it a separate edit
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 flex-col items-center justify-center gap-3 pb-24 text-center text-[13px] text-ink-3">{children}</div>;
}
