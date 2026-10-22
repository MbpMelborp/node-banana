import { describe, expect, it } from "vitest";
import {
  clampOverlayScroll,
  hiddenOverlayRows,
  OVERLAY_ROW_PX,
  overlayScrollTop,
  overlaySectionLayout,
  revealOverlayRow,
  scrollOverlayBy,
} from "../overlayLayout";

describe("overlaySectionLayout", () => {
  it("takes no room at all with no rows", () => {
    expect(overlaySectionLayout(0)).toEqual({
      rowTops: [],
      rowHeights: [],
      rowsHeight: 0,
      viewHeight: 0,
      sectionHeight: 0,
      maxScroll: 0,
    });
    expect(overlaySectionLayout(Number.NaN).sectionHeight).toBe(0);
    expect(overlaySectionLayout(-2).sectionHeight).toBe(0);
    // A cap changes nothing when there is nothing to show
    expect(overlaySectionLayout(0, 10).viewHeight).toBe(0);
  });

  it("draws 52px rows bottom-up, row 0 nearest the video, with no strip", () => {
    expect(OVERLAY_ROW_PX).toBe(52);
    expect(overlaySectionLayout(1)).toMatchObject({ rowTops: [0], rowHeights: [52], viewHeight: 52, sectionHeight: 52 });
    expect(overlaySectionLayout(2)).toMatchObject({ rowTops: [52, 0], rowsHeight: 104, viewHeight: 104, sectionHeight: 104 });
  });

  it("shows two rows and scrolls the rest", () => {
    expect(overlaySectionLayout(4)).toMatchObject({
      rowTops: [156, 104, 52, 0],
      rowsHeight: 208,
      viewHeight: 104,
      sectionHeight: 104,
      maxScroll: 104,
    });
  });

  it("gives up height to the cap, never below one row, and grows past its rows cap when asked", () => {
    expect(overlaySectionLayout(3, 70)).toMatchObject({ viewHeight: 70, maxScroll: 156 - 70 });
    expect(overlaySectionLayout(3, 10).viewHeight).toBe(52);
    expect(overlaySectionLayout(3, Number.NaN).viewHeight).toBe(104);
    expect(overlaySectionLayout(3, 500, Infinity)).toMatchObject({ viewHeight: 156, maxScroll: 0 });
  });
});

describe("scrolling, kept from the bottom", () => {
  // Four rows, two shown: row 0 at the bottom of the block (156–208), row 3 at its top
  const layout = overlaySectionLayout(4);

  it("shows the rows nearest the video at 0, the rows block drawn from its top at maxScroll", () => {
    expect(overlayScrollTop(0, layout)).toBe(104);
    expect(overlayScrollTop(104, layout)).toBe(0);
    expect(clampOverlayScroll(-5, layout)).toBe(0);
    expect(clampOverlayScroll(500, layout)).toBe(104);
    expect(clampOverlayScroll(Number.NaN, layout)).toBe(0);
  });

  it("counts the rows cut off above (higher rows) and below", () => {
    expect(hiddenOverlayRows(0, layout)).toEqual({ above: 2, below: 0 });
    expect(hiddenOverlayRows(104, layout)).toEqual({ above: 0, below: 2 });
    expect(hiddenOverlayRows(26, layout)).toEqual({ above: 2, below: 1 });
    expect(hiddenOverlayRows(0, overlaySectionLayout(2))).toEqual({ above: 0, below: 0 });
    expect(hiddenOverlayRows(0, overlaySectionLayout(0))).toEqual({ above: 0, below: 0 });
  });

  it("reveals a row, scrolling as little as it can", () => {
    expect(revealOverlayRow(0, 0, layout)).toBe(0);
    expect(revealOverlayRow(0, 2, layout)).toBe(52);
    expect(revealOverlayRow(0, 3, layout)).toBe(104);
    expect(revealOverlayRow(104, 1, layout)).toBe(52);
    expect(revealOverlayRow(52, 2, layout)).toBe(52);
    expect(revealOverlayRow(52, 9, layout)).toBe(52);
  });

  it("scrolls by a wheel or the browser's own scroll: down the screen is toward row 0", () => {
    expect(scrollOverlayBy(0, -30, layout)).toBe(30);
    expect(scrollOverlayBy(30, 50, layout)).toBe(0);
    expect(scrollOverlayBy(100, -50, layout)).toBe(104);
    expect(scrollOverlayBy(30, Number.NaN, layout)).toBe(30);
  });

  it("moves no row on screen when a row is added on top", () => {
    const before = overlaySectionLayout(3);
    const after = overlaySectionLayout(4);
    // Row 0's top in the view at the same scroll, before and after
    const rowTopInView = (l: typeof layout, row: number, scroll: number) => l.rowTops[row] - overlayScrollTop(scroll, l);
    for (const scroll of [0, 20, 52]) {
      expect(rowTopInView(after, 0, scroll)).toBe(rowTopInView(before, 0, scroll));
      expect(rowTopInView(after, 1, scroll)).toBe(rowTopInView(before, 1, scroll));
    }
  });
});
