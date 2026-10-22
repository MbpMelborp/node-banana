import { clampAudioScroll, hiddenAudioRows, revealAudioRow, type AudioSectionLayout } from "./audioLayout";

/**
 * The overlay section's geometry: the text layers' rows between the ruler
 * and the video, and the view they scroll in. Row 0 is the one nearest the
 * video, at the section's bottom; each higher row sits above it, as it draws
 * in front. It depends on the row count and the height the timeline leaves
 * it, never on the selection. With no overlays the section takes no room at
 * all. Its scroll is kept from the bottom (how far the rows are scrolled up
 * to show higher ones), so a row added on top moves none on screen. Pure: no
 * React, no DOM.
 */

/** A 40px block with 6px over and under it. */
export const OVERLAY_ROW_PX = 52;
/** Rows shown before the rest scroll. */
export const OVERLAY_ROWS_CAP = 2;

/** The audio section's shape: rowTops in the rows block from its top (row 0 lowest), and no strip. */
export type OverlaySectionLayout = AudioSectionLayout;

/**
 * rowCount 0 takes no room. maxView: what the timeline's height cap leaves for the rows (Infinity when uncapped), never
 * below one row. rowsCap: the rows shown before the rest scroll (more when the timeline is dragged taller).
 */
export function overlaySectionLayout(
  rowCount: number,
  maxView = Infinity,
  rowsCap = OVERLAY_ROWS_CAP,
): OverlaySectionLayout {
  const rows = Math.max(0, Math.floor(Number.isFinite(rowCount) ? rowCount : 0));
  const rowsHeight = rows * OVERLAY_ROW_PX;
  const view = Math.min(rowsHeight, rowsCap * OVERLAY_ROW_PX, Number.isNaN(maxView) ? Infinity : maxView);
  const viewHeight = rows === 0 ? 0 : Math.max(OVERLAY_ROW_PX, view);
  return {
    rowTops: Array.from({ length: rows }, (_, row) => (rows - 1 - row) * OVERLAY_ROW_PX),
    rowHeights: Array.from({ length: rows }, () => OVERLAY_ROW_PX),
    rowsHeight,
    viewHeight,
    sectionHeight: viewHeight,
    maxScroll: Math.max(0, rowsHeight - viewHeight),
  };
}

/** A scroll kept from the bottom, within 0..maxScroll. */
export function clampOverlayScroll(scroll: number, layout: OverlaySectionLayout): number {
  return clampAudioScroll(scroll, layout);
}

/** How far the rows block is scrolled from its top (the translate it is drawn at), for a scroll kept from the bottom. */
export function overlayScrollTop(scroll: number, layout: OverlaySectionLayout): number {
  return layout.maxScroll - clampOverlayScroll(scroll, layout);
}

/** The scroll after the view moves `dy` px down the rows (a wheel, the browser's own scroll to a focused box). */
export function scrollOverlayBy(scroll: number, dy: number, layout: OverlaySectionLayout): number {
  return clampOverlayScroll(clampOverlayScroll(scroll, layout) - (Number.isFinite(dy) ? dy : 0), layout);
}

/** How many rows are cut off, wholly or in part, above (higher rows) and below the view. */
export function hiddenOverlayRows(scroll: number, layout: OverlaySectionLayout): { above: number; below: number } {
  return hiddenAudioRows(overlayScrollTop(scroll, layout), layout);
}

/** The least scroll that shows `row` whole. */
export function revealOverlayRow(scroll: number, row: number, layout: OverlaySectionLayout): number {
  return layout.maxScroll - revealAudioRow(overlayScrollTop(scroll, layout), row, layout);
}
