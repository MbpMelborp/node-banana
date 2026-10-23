/**
 * Stacked's clip rows: one 52px row per clip, its 40px box 6px under the
 * row's top, and the one row open for its clip's speed curve 132px (a 120px
 * box). With no row open every helper gives the uniform rows' numbers.
 * Pure: no React, no DOM.
 */

/** A 40px box with 6px over and under it. */
export const STACK_ROW_PX = 52;
/** The row open for its clip's speed curve: a 120px box with 6px over and under it. */
export const STACK_ROW_EXPANDED_PX = 132;
export const STACK_BOX_TOP_PX = 6;
export const STACK_BOX_PX = 40;
export const STACK_BOX_EXPANDED_PX = 120;

export interface StackedRowsLayout {
  /** Each clip row's top in the rows block, then the rows' end: rowTops[count] (0 with no clips). */
  rowTops: readonly number[];
  rowHeights: readonly number[];
  /** The rows block as drawn: at least one row (the empty lane's). */
  height: number;
  /** The row grown for its speed curve, or -1. */
  expanded: number;
}

/** One row per clip, 52px; `expanded` (a row index; out of [0, count) counts as none) 132px. */
export function stackedRowsLayout(count: number, expanded: number | null = null): StackedRowsLayout {
  const rows = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  const open = expanded !== null && Number.isInteger(expanded) && expanded >= 0 && expanded < rows ? expanded : -1;
  const rowHeights = Array.from({ length: rows }, (_, i) => (i === open ? STACK_ROW_EXPANDED_PX : STACK_ROW_PX));
  const rowTops = [0];
  for (const height of rowHeights) rowTops.push(rowTops[rowTops.length - 1] + height);
  return { rowTops, rowHeights, height: Math.max(STACK_ROW_PX, rowTops[rows]), expanded: open };
}

/** Row i's box top in the rows block (a row past the last: the rows' end). */
export const boxTopOf = (rows: StackedRowsLayout, i: number): number =>
  rows.rowTops[Math.min(i, rows.rowTops.length - 1)] + STACK_BOX_TOP_PX;

export const boxHeightOf = (rows: StackedRowsLayout, i: number): number =>
  i === rows.expanded ? STACK_BOX_EXPANDED_PX : STACK_BOX_PX;

export const rowCentreOf = (rows: StackedRowsLayout, i: number): number => rows.rowTops[i] + rows.rowHeights[i] / 2;

/** The row y (rows-block px) falls in, or -1 outside the rows. */
export function rowUnder(rows: StackedRowsLayout, y: number): number {
  if (!(y >= 0)) return -1;
  for (let i = 0; i < rows.rowHeights.length; i++) if (y < rows.rowTops[i + 1]) return i;
  return -1;
}

/** The row y falls in, clamped to the first and last rows (0 with none). */
export function rowAtY(rows: StackedRowsLayout, y: number): number {
  const last = rows.rowHeights.length - 1;
  if (last < 0) return 0;
  for (let i = 0; i < last; i++) if (y < rows.rowTops[i + 1]) return i;
  return last;
}

/** The row boundary 0..count nearest y; a tie goes to the later boundary, as Math.round does. */
export function nearestBoundary(rows: Pick<StackedRowsLayout, "rowTops">, y: number): number {
  if (!Number.isFinite(y)) return 0;
  let best = 0;
  rows.rowTops.forEach((top, i) => {
    if (Math.abs(top - y) <= Math.abs(rows.rowTops[best] - y)) best = i;
  });
  return best;
}

/**
 * A group's travel down the rows, clamped once for all of it: its first box stops where it rests on the first row,
 * its last where it rests on the last row, so a box dragged past the rows is drawn where release puts it. With one
 * clip (minIdx = maxIdx) it is the clamp for a single box.
 */
export function groupTravel(dy: number, minIdx: number, maxIdx: number, rows: StackedRowsLayout): number {
  const last = Math.max(0, rows.rowHeights.length - 1);
  return Math.min(Math.max(dy, rows.rowTops[0] - rows.rowTops[minIdx]), rows.rowTops[last] - rows.rowTops[maxIdx]);
}

/**
 * The scrollTop nearest `scrollTop` that shows row i: whole when it fits the view, filling the view when it is taller,
 * so a tall open row in a short view is not pulled back to its top while any of it fills the view.
 */
export function revealRowScroll(rows: StackedRowsLayout, i: number, scrollTop: number, viewport: number): number {
  if (!(i >= 0 && i < rows.rowHeights.length)) return scrollTop;
  const top = rows.rowTops[i];
  const bottom = top + rows.rowHeights[i] - viewport;
  return Math.min(Math.max(scrollTop, Math.min(top, bottom)), Math.max(top, bottom));
}
