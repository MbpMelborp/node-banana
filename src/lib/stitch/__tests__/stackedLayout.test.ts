import { describe, expect, it } from "vitest";
import {
  boxHeightOf,
  boxTopOf,
  groupTravel,
  nearestBoundary,
  revealRowScroll,
  rowAtY,
  rowCentreOf,
  rowUnder,
  stackedRowsLayout,
} from "../stackedLayout";

describe("stackedRowsLayout", () => {
  it("gives one 52 px row per clip, and one row's room with none", () => {
    expect(stackedRowsLayout(4)).toEqual({
      rowTops: [0, 52, 104, 156, 208],
      rowHeights: [52, 52, 52, 52],
      height: 208,
      expanded: -1,
    });
    expect(stackedRowsLayout(0)).toEqual({ rowTops: [0], rowHeights: [], height: 52, expanded: -1 });
  });

  it("grows the row open for its clip's speed curve to 132 px; an index out of range opens none", () => {
    const rows = stackedRowsLayout(3, 1);
    expect(rows.rowTops).toEqual([0, 52, 184, 236]);
    expect(rows.rowHeights).toEqual([52, 132, 52]);
    expect(rows.height).toBe(236);
    expect(rows.expanded).toBe(1);
    for (const out of [-1, 3, 1.5, Number.NaN]) expect(stackedRowsLayout(3, out)).toEqual(stackedRowsLayout(3));
  });

  it("places each box 6 px into its row, 40 px tall, 120 px on the open row", () => {
    const rows = stackedRowsLayout(3, 1);
    expect([0, 1, 2].map((i) => boxTopOf(rows, i))).toEqual([6, 58, 190]);
    expect([0, 1, 2].map((i) => boxHeightOf(rows, i))).toEqual([40, 120, 40]);
    expect([0, 1, 2].map((i) => rowCentreOf(rows, i))).toEqual([26, 118, 210]);
    // The add slot after the last row's box, and a row past the end
    expect(boxTopOf(rows, 3)).toBe(242);
    expect(boxTopOf(rows, 9)).toBe(242);
  });
});

describe("finding rows", () => {
  const rows = stackedRowsLayout(3, 1);

  it("rowUnder: the row a y falls in, or -1 outside the rows", () => {
    expect([0, 51.9, 52, 183.9, 184, 235.9].map((y) => rowUnder(rows, y))).toEqual([0, 0, 1, 1, 2, 2]);
    expect(rowUnder(rows, 236)).toBe(-1);
    expect(rowUnder(rows, -1)).toBe(-1);
    expect(rowUnder(rows, Number.NaN)).toBe(-1);
  });

  it("rowAtY: the same, clamped to the first and last rows (0 with none)", () => {
    expect(rowAtY(rows, -50)).toBe(0);
    expect(rowAtY(rows, 100)).toBe(1);
    expect(rowAtY(rows, 900)).toBe(2);
    expect(rowAtY(stackedRowsLayout(0), 30)).toBe(0);
  });

  it("nearestBoundary: the row boundary nearest y, a tie to the later one", () => {
    const uniform = stackedRowsLayout(3);
    expect(nearestBoundary(uniform, 26)).toBe(1);
    expect(nearestBoundary(uniform, 25.9)).toBe(0);
    expect(nearestBoundary(uniform, -40)).toBe(0);
    expect(nearestBoundary(uniform, 900)).toBe(3);
    expect(nearestBoundary(rows, 117)).toBe(1);
    expect(nearestBoundary(rows, 119)).toBe(2);
    expect(nearestBoundary(stackedRowsLayout(0), 30)).toBe(0);
  });
});

describe("groupTravel", () => {
  it("stops a group's first box on the first row and its last on the last row, an open row's height included", () => {
    const rows = stackedRowsLayout(4);
    expect(groupTravel(-200, 1, 2, rows)).toBe(-52);
    expect(groupTravel(200, 1, 2, rows)).toBe(52);
    expect(groupTravel(30, 1, 2, rows)).toBe(30);
    // Row 1 open: the group on rows 1–2 can go down to row 3 (236 − 184) and up to row 0 (0 − 52)
    const open = stackedRowsLayout(4, 1);
    expect(groupTravel(400, 1, 2, open)).toBe(52);
    expect(groupTravel(-400, 1, 2, open)).toBe(-52);
    // One box on row 0 below an open row 1: down to the last row's top, 236
    expect(groupTravel(400, 0, 0, open)).toBe(236);
  });
});

describe("revealRowScroll", () => {
  it("shows a row that fits whole, scrolling as little as it can", () => {
    const rows = stackedRowsLayout(6);
    // Row 1 (52–104) in a 100 px view
    expect(revealRowScroll(rows, 1, 80, 100)).toBe(52);
    expect(revealRowScroll(rows, 1, 0, 100)).toBe(4);
    expect(revealRowScroll(rows, 1, 30, 100)).toBe(30);
    expect(revealRowScroll(rows, 9, 30, 100)).toBe(30);
  });

  it("keeps an open row taller than the view where it fills the view (playback does not pull it back to its top)", () => {
    // Row 1 open (52–184) in Stacked's 78 px floor
    const rows = stackedRowsLayout(4, 1);
    expect(revealRowScroll(rows, 1, 82, 78)).toBe(82);
    expect(revealRowScroll(rows, 1, 52, 78)).toBe(52);
    expect(revealRowScroll(rows, 1, 106, 78)).toBe(106);
    expect(revealRowScroll(rows, 1, 10, 78)).toBe(52);
    expect(revealRowScroll(rows, 1, 150, 78)).toBe(106);
  });

  it("equals the uniform rows' reveal with no row open", () => {
    const uniform = (index: number, scrollTop: number, viewport: number) => {
      const top = index * 52;
      const bottom = top + 52;
      if (top < scrollTop) return top;
      if (bottom > scrollTop + viewport) return bottom - viewport;
      return scrollTop;
    };
    let seed = 5;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let run = 0; run < 2000; run++) {
      const count = 1 + Math.floor(rnd() * 12);
      const index = Math.floor(rnd() * count);
      const viewport = 52 + rnd() * 400;
      const scrollTop = rnd() * count * 52;
      expect(revealRowScroll(stackedRowsLayout(count), index, scrollTop, viewport)).toBe(uniform(index, scrollTop, viewport));
    }
  });
});
