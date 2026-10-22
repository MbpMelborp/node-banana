"use client";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/components/nodes/ui/cn";
import { MenuSurface, menuItemClass } from "@/components/ui/Menu";
import { isImeKeyEvent } from "@/lib/agent/client/keyboard";
import { FONT_ACCEPT, type FontFileInfo } from "@/lib/edits/fontFiles";
import {
  addFontFile,
  FontFileError,
  installedFamilies,
  listFontFiles,
  localFontsPermission,
  SHIPPED_FONTS,
  shippedFont,
} from "@/lib/stitch/fonts";
import type { StitchOverlayFont } from "@/types";
import { EDIT_MENU_MUTED, EDIT_MENU_ROW, EDIT_MENU_SURFACE, EDITOR_PANEL_SELECTOR, TIMECODE_WELL } from "./editorStyles";
import { RailNote } from "./railParts";

/** The list's gap from the field, and the room it keeps from the window's edges, px. */
const GAP = 4;
const EDGE = 8;

type Section = "app" | "files" | "computer";

const SECTIONS: ReadonlyArray<{ id: Section; label: string }> = [
  { id: "app", label: "In the app" },
  { id: "files", label: "Font files" },
  { id: "computer", label: "On this computer" },
];

interface FontRow {
  key: string;
  label: string;
  section: Section;
  font: StitchOverlayFont;
}

const TYPED_KEY = "typed";

/** What was typed, as a family of its own. */
interface TypedRow {
  key: typeof TYPED_KEY;
  label: string;
  font: StitchOverlayFont;
}

interface ActionRow {
  key: "action:computer" | "action:file";
  label: string;
}

type Row = TypedRow | FontRow | ActionRow;

/** A font file's name less its extension: the family a layer in it is named by. */
export function fontFileStem(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

/** What the field shows for a font: a shipped one's label, else its family. */
export function fontLabel(font: StitchOverlayFont): string {
  return font.file ? font.family : (shippedFont(font.family)?.label ?? font.family);
}

const sameFont = (a: StitchOverlayFont, b: StitchOverlayFont) => a.family === b.family && a.file === b.file;

/** The row a font is listed as: its file's, else the app's, else this computer's (a typed family has none). */
function rowKeyOf(font: StitchOverlayFont): string {
  if (font.file) return `file:${font.file}`;
  return shippedFont(font.family) ? `app:${font.family}` : `computer:${font.family}`;
}

/** The row typing `query` lights: the one named exactly that, else the first starting with it, else the first with it. */
function matchOf(rows: readonly FontRow[], query: string): string | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const name = (row: FontRow) => row.label.toLowerCase();
  const row =
    rows.find((r) => name(r) === q) ?? rows.find((r) => name(r).startsWith(q)) ?? rows.find((r) => name(r).includes(q));
  return row?.key ?? null;
}

/**
 * The text rail's Font: a field that keeps focus while the fonts hang in a list under it (a combobox), on the edit
 * menus' skin. The fonts the app ships, the font files in the library's Fonts folder, and the families installed on
 * this computer where the browser lets them be listed; then "Show fonts on this computer" (while listing them would
 * ask) and "Add font file…" (while there is a Fonts folder). Typing filters the list and lights the best match, and
 * unless a font is named just that, offers the typed name as a family of its own on a first row ("Use …", lit when
 * nothing matches; a family this computer lacks falls back to the app's sans). ↑ and ↓ move the light, Enter takes
 * the lit row and a click takes a row; the rows never take focus. An input method's keys are its own. Leaving the
 * field puts its text back; Escape closes the list, a second leaves the field; Tab closes it. The lists are read each
 * time it opens.
 */
export function FontCombobox({
  font,
  onPick,
}: {
  font: StitchOverlayFont;
  onPick: (font: StitchOverlayFont) => void;
}) {
  const inputId = useId();
  const listId = useId();
  const fieldRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // The field's box while the list is open
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [typed, setTyped] = useState<string | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  // undefined until listed; null: no Fonts folder here
  const [files, setFiles] = useState<FontFileInfo[] | null | undefined>(undefined);
  const [installed, setInstalled] = useState<string[] | null>(null);
  const [permission, setPermission] = useState<PermissionState | "unsupported" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const open = anchor !== null;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const allFonts = useMemo(() => {
    const rows: FontRow[] = SHIPPED_FONTS.map((shipped) => ({
      key: `app:${shipped.family}`,
      label: shipped.label,
      section: "app",
      font: { family: shipped.family },
    }));
    const stems = (files ?? []).map((info) => fontFileStem(info.name));
    (files ?? []).forEach((info, i) => {
      // Two files of one name in other formats: each by its whole name
      const shared = stems.indexOf(stems[i]) !== stems.lastIndexOf(stems[i]);
      rows.push({
        key: `file:${info.name}`,
        label: shared ? info.name : stems[i],
        section: "files",
        font: { family: stems[i], file: info.name },
      });
    });
    for (const family of installed ?? []) {
      rows.push({ key: `computer:${family}`, label: family, section: "computer", font: { family } });
    }
    return rows;
  }, [files, installed]);

  const family = typed?.trim() ?? "";
  const query = family.toLowerCase();
  const fonts = query ? allFonts.filter((row) => row.label.toLowerCase().includes(query)) : allFonts;
  // Reachable even when a listed font has the name in its own ("Roboto" in "Roboto Condensed")
  const typedRows: TypedRow[] =
    family && !allFonts.some((row) => row.label.toLowerCase() === query)
      ? [{ key: TYPED_KEY, label: `Use “${family}”`, font: { family } }]
      : [];

  const close = () => {
    setAnchor(null);
    setTyped(null);
    setActiveKey(null);
  };

  const askInstalled = () => {
    // Straight from the press: where it asks, the browser wants the gesture
    void installedFamilies().then((families) => {
      if (!mounted.current) return;
      setInstalled(families);
      setPermission(families ? "granted" : "denied");
    });
  };

  const actions: ActionRow[] = [];
  if (permission === "prompt") actions.push({ key: "action:computer", label: "Show fonts on this computer" });
  if (files) actions.push({ key: "action:file", label: "Add font file…" });
  const rows: Row[] = [...typedRows, ...fonts, ...actions];
  const activeIndex = rows.findIndex((row) => row.key === activeKey);

  const openList = () => {
    const box = fieldRef.current?.getBoundingClientRect();
    if (!box) return;
    setError(null);
    setAnchor(box);
    setActiveKey(rowKeyOf(font));
  };

  const take = (row: Row) => {
    if (row.key === "action:computer") return askInstalled();
    close();
    if ("font" in row) onPick(row.font);
    else fileRef.current?.click();
  };

  // Each opening reads the Fonts folder, and the installed families when the browser already allows it
  useEffect(() => {
    if (!open) return;
    let current = true;
    void listFontFiles().then((list) => {
      if (current) setFiles(list ? list.fonts : null);
    });
    void localFontsPermission().then((state) => {
      if (!current) return;
      setPermission(state);
      if (state !== "granted") return setInstalled(null);
      void installedFamilies().then((families) => {
        if (current && families) setInstalled(families);
      });
    });
    return () => {
      current = false;
    };
  }, [open]);

  // Fixed, so the rail's scroll does not clip it: it closes when anything holding the field scrolls, or the window
  // changes size
  useEffect(() => {
    if (!open) return;
    const dismiss = () => {
      setAnchor(null);
      setTyped(null);
      setActiveKey(null);
    };
    const onScroll = (event: Event) => {
      const field = fieldRef.current;
      const target = event.target;
      if (target === document || (target instanceof Node && field && target !== field && target.contains(field))) dismiss();
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", dismiss);
    };
  }, [open]);

  // Under the field, or over it when there is no room below
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !anchor) return;
    const height = list.offsetHeight;
    const below = anchor.bottom + GAP;
    const above = anchor.top - GAP - height;
    list.style.top = `${below + height > window.innerHeight - EDGE && above >= EDGE ? above : below}px`;
  });

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>("[data-active]")?.scrollIntoView?.({ block: "nearest" });
  }, [activeKey]);

  const leave = (input: HTMLInputElement) => {
    const panel = input.closest<HTMLElement>(EDITOR_PANEL_SELECTOR);
    if (panel) panel.focus();
    else input.blur();
  };

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    if (!open) openList();
    setTyped(value);
    setActiveKey(matchOf(allFonts, value) ?? (value.trim() ? TYPED_KEY : null));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      // The editor's Escape does not run, nor the dialog's
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation();
    }
    // An input method's own: ↑ and ↓ pick its candidates, Enter takes a conversion, Escape drops one
    if (isImeKeyEvent(event)) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) return openList();
      if (rows.length === 0) return;
      const down = event.key === "ArrowDown";
      const next = down
        ? activeIndex < 0
          ? 0
          : (activeIndex + 1) % rows.length
        : activeIndex <= 0
          ? rows.length - 1
          : activeIndex - 1;
      setActiveKey(rows[next].key);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (open && activeIndex >= 0) take(rows[activeIndex]);
      else close();
    } else if (event.key === "Escape") {
      // The list closes, or the field is left
      event.preventDefault();
      if (open) close();
      else leave(event.currentTarget);
    } else if (event.key === "Tab") {
      close();
    }
  };

  const onFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Cleared, so the same file can be chosen again
    event.target.value = "";
    if (!file) return;
    setError(null);
    addFontFile(file).then(
      (info) => onPick({ family: fontFileStem(info.name), file: info.name }),
      (reason: unknown) => {
        if (mounted.current) setError(reason instanceof FontFileError ? reason.message : "Couldn't add that font file.");
      },
    );
  };

  const option = (row: Row) => {
    const index = rows.indexOf(row);
    const active = index === activeIndex;
    const chosen = "font" in row && sameFont(row.font, font);
    return (
      <div
        key={row.key}
        id={`${listId}-${index}`}
        role="option"
        aria-selected={chosen}
        data-active={active || undefined}
        onClick={() => take(row)}
        className={cn(
          menuItemClass,
          EDIT_MENU_ROW,
          "cursor-default",
          // The light a key moves: ringed as a focused row is, since the field keeps the focus
          active && "bg-white/6 ring-2 ring-inset ring-white/40",
        )}
      >
        <span className="min-w-0 truncate">{row.label}</span>
        {chosen && <Check size={14} strokeWidth={1.5} aria-hidden="true" className="ml-auto shrink-0" />}
      </div>
    );
  };

  return (
    <>
      <label htmlFor={inputId} className="mb-1.5 block text-xs leading-3 text-ink-3">
        Font
      </label>
      <div ref={fieldRef} className="relative">
        <input
          id={inputId}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
          className={cn(TIMECODE_WELL, "pr-8")}
          value={typed ?? fontLabel(font)}
          onFocus={(event) => event.currentTarget.select()}
          onClick={() => {
            if (!open) openList();
          }}
          onChange={onChange}
          onKeyDown={onKeyDown}
          // Only Enter or a click takes a font: anything typed goes back
          onBlur={close}
        />
        <ChevronDown
          size={14}
          strokeWidth={1.5}
          aria-hidden="true"
          className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-3"
        />
      </div>
      {/* Outside the list, which is gone by the time the file is chosen */}
      <input ref={fileRef} type="file" accept={FONT_ACCEPT} hidden tabIndex={-1} onChange={onFile} />
      {error && <RailNote>{error}</RailNote>}
      {anchor && (
        <MenuSurface
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Fonts"
          // A press anywhere in it leaves the focus in the field
          onMouseDown={(event) => event.preventDefault()}
          className={cn(EDIT_MENU_SURFACE, "max-h-[320px] overflow-y-auto")}
          style={{ left: anchor.left, top: anchor.bottom + GAP, width: anchor.width }}
        >
          {typedRows.map(option)}
          {SECTIONS.map((section) => {
            const sectionRows = fonts.filter((row) => row.section === section.id);
            if (sectionRows.length === 0) return null;
            const headingId = `${listId}-${section.id}`;
            return (
              <div key={section.id} role="group" aria-labelledby={headingId}>
                <div id={headingId} className={cn(EDIT_MENU_MUTED, "pb-1 pt-1.5")}>
                  {section.label}
                </div>
                {sectionRows.map(option)}
              </div>
            );
          })}
          {actions.length > 0 && (
            <div role="group" aria-label="More fonts" className="mt-1 border-t border-neutral-800 pt-1">
              {actions.map(option)}
            </div>
          )}
        </MenuSurface>
      )}
    </>
  );
}
