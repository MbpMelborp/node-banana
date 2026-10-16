"use client";

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Crosshair, RotateCcw, Scissors, Trash, Volume1, VolumeX } from "lucide-react";
import { MenuDivider, MenuHeader, MenuItem, MenuList, MenuSectionLabel, MenuShortcut, MenuSurface } from "@/components/ui/Menu";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { clipName } from "@/lib/stitch/labels";
import { isTrimmed } from "@/lib/stitch/timeline";
import {
  canRevealSource,
  canSplitSelectedAtPlayhead,
  removeSelection,
  resetSelectedTrim,
  revealSelectedSource,
  splitAtPlayhead,
  splitBlockedReason,
  toggleSelectedClipMute,
} from "../editorActions";
import type { ClipMediaView } from "../useStitchEditorMedia";

const MENU_WIDTH = 184;
const EDGE = 8;
const ICON = { size: 11, strokeWidth: 1.75, className: "shrink-0" } as const;

/**
 * A clip's right-click menu, on the app's menu skin: its sound, a split at
 * the playhead, its trim, its source node, and removing it. The clip is the
 * selection (the right-click selected it), so each item is the same action
 * as its key; an item selects it again before it runs, so the label and the
 * action never part. Any press outside closes it, even one that cancels its
 * pointerdown (a trim handle, the ruler). Escape belongs to the editor's key
 * handler, which closes it. However it closes, focus that was in it goes
 * back to the panel, so the editor's keys and its Tab trap keep working.
 */
export function ClipContextMenu({ media }: { media: ReadonlyMap<string, ClipMediaView> }) {
  const menu = useStitchEditorStore((s) => s.menu);
  if (!menu) return null;
  return <OpenMenu key={`${menu.clipId}:${menu.x}:${menu.y}`} media={media} clipId={menu.clipId} x={menu.x} y={menu.y} />;
}

function OpenMenu({
  media,
  clipId,
  x,
  y,
}: {
  media: ReadonlyMap<string, ClipMediaView>;
  clipId: string;
  x: number;
  y: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  const index = useStitchEditorStore((s) => s.draft?.timeline.findIndex((c) => c.id === clipId) ?? -1);
  const clip = useStitchEditorStore((s) => s.draft?.timeline.find((c) => c.id === clipId) ?? null);
  const canSplit = useStitchEditorStore(canSplitSelectedAtPlayhead);
  const splitBlocked = useStitchEditorStore(splitBlockedReason);
  const view = media.get(clipId);

  // Focus goes back to the panel, so the editor's keys work and Tab stays in the dialog
  const close = (run?: () => void) => {
    const panel = ref.current?.closest<HTMLElement>('[role="dialog"]');
    useStitchEditorStore.getState().openMenu(null);
    run?.();
    panel?.focus({ preventScroll: true });
  };
  const act = (run: () => void) => () =>
    close(() => {
      useStitchEditorStore.getState().select({ kind: "clip", clipId });
      run();
    });

  useLayoutEffect(() => {
    const height = ref.current?.offsetHeight ?? 0;
    setPosition({
      left: Math.max(EDGE, Math.min(x, window.innerWidth - MENU_WIDTH - EDGE)),
      top: Math.max(EDGE, Math.min(y, window.innerHeight - height - EDGE)),
    });
  }, [x, y]);

  useEffect(() => {
    const menu = ref.current;
    const panel = menu?.closest<HTMLElement>('[role="dialog"]') ?? null;
    menu?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus({ preventScroll: true });
    const dismiss = () => useStitchEditorStore.getState().openMenu(null);
    // Capture phase, and pointerdown: a press whose pointerdown is cancelled fires no mousedown
    const onPointerDown = (event: PointerEvent) => {
      if (menu && !menu.contains(event.target as Node)) dismiss();
    };
    const onWheel = (event: WheelEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) dismiss();
    };
    document.addEventListener("pointerdown", onPointerDown, { capture: true });
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, { capture: true });
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("resize", dismiss);
      // Its focused row is gone with it: focus would fall to <body>, outside the dialog's Tab trap
      const active = document.activeElement;
      if (panel?.isConnected && (!active || active === document.body || menu?.contains(active))) {
        panel.focus({ preventScroll: true });
      }
    };
  }, []);

  // A clip removed by undo while the menu was up: nothing to act on
  useEffect(() => {
    if (!clip) useStitchEditorStore.getState().openMenu(null);
  }, [clip]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const rows = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []);
    if (rows.length === 0) return;
    const at = rows.indexOf(document.activeElement as HTMLElement);
    let next: number | null = null;
    if (event.key === "ArrowDown") next = at < 0 ? 0 : (at + 1) % rows.length;
    else if (event.key === "ArrowUp") next = at <= 0 ? rows.length - 1 : at - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = rows.length - 1;
    else if (event.key === "Tab") {
      event.preventDefault();
      close();
      return;
    }
    if (next === null) return;
    event.preventDefault();
    rows[next]?.focus();
  };

  if (!clip) return null;
  const name = clipName(index);
  const source = view?.sourceLabel;
  const item = (label: string, icon: ReactNode, run: () => void, opts: { shortcut?: string; disabled?: boolean; danger?: boolean; title?: string } = {}) => (
    <MenuItem
      role="menuitem"
      disabled={opts.disabled}
      title={opts.title}
      onClick={act(run)}
      className={opts.danger ? "text-red-400 hover:text-red-300" : undefined}
    >
      {icon}
      <span className="truncate">{label}</span>
      {opts.shortcut && <MenuShortcut>{opts.shortcut}</MenuShortcut>}
    </MenuItem>
  );

  return (
    <MenuSurface
      ref={ref}
      role="menu"
      aria-label={name}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
      style={{ left: position.left, top: position.top, width: MENU_WIDTH }}
    >
      <MenuHeader className="px-2.5">
        <MenuSectionLabel>{source ? `${name} · ${source}` : name}</MenuSectionLabel>
      </MenuHeader>
      <MenuList>
        {clip.muted
          ? item("Unmute clip audio", <Volume1 {...ICON} />, toggleSelectedClipMute, { shortcut: "⌥M" })
          : item("Mute clip audio", <VolumeX {...ICON} />, toggleSelectedClipMute, { shortcut: "⌥M" })}
        {item("Split at playhead", <Scissors {...ICON} />, splitAtPlayhead, {
          shortcut: "S",
          disabled: !canSplit,
          title: canSplit ? undefined : (splitBlocked ?? undefined),
        })}
        {item("Reset trim", <RotateCcw {...ICON} />, resetSelectedTrim, { disabled: !isTrimmed(clip) })}
        <MenuDivider role="separator" className="my-1" />
        {item("Reveal source node", <Crosshair {...ICON} />, revealSelectedSource, { disabled: !canRevealSource(clip, view) })}
        {item("Remove from stitch", <Trash {...ICON} />, removeSelection, { shortcut: "⌫", danger: true })}
      </MenuList>
    </MenuSurface>
  );
}
