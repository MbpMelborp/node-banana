import { describe, it, expect } from "vitest";
import {
  blockDropIndexAt,
  blockInsertionX,
  dropIndexAt,
  insertionX,
  stackedDropIndex,
  stackedInsertionY,
} from "../reorder";
import { stackedRowsLayout } from "../stackedLayout";

// Three boxes: 16–336, 336–604, 604–988
const boxes = [
  { x: 16, width: 320 },
  { x: 336, width: 268 },
  { x: 604, width: 384 },
];

describe("dropIndexAt", () => {
  it("moves the clip before the first one", () => {
    expect(dropIndexAt(20, boxes, 2)).toBe(0);
  });

  it("moves the clip after the last one once the pointer passes its middle", () => {
    expect(dropIndexAt(780, boxes, 0)).toBe(1);
    expect(dropIndexAt(800, boxes, 0)).toBe(2);
  });

  it("leaves the clip in place while the pointer is over itself", () => {
    expect(dropIndexAt(400, boxes, 1)).toBe(1);
    expect(dropIndexAt(170, boxes, 0)).toBe(0);
    expect(dropIndexAt(600, boxes, 1)).toBe(1);
  });

  it("counts every other clip whose middle it passed", () => {
    expect(dropIndexAt(480, boxes, 0)).toBe(1);
    expect(dropIndexAt(150, boxes, 1)).toBe(0);
    expect(dropIndexAt(200, boxes, 1)).toBe(1);
  });
});

describe("insertionX", () => {
  it("marks the gap the clip would go into", () => {
    expect(insertionX(0, boxes, 2)).toBe(14);
    expect(insertionX(1, boxes, 2)).toBe(336);
    expect(insertionX(2, boxes, 0)).toBe(990);
    // Dragging the middle clip between the other two: the gap where it was
    expect(insertionX(1, boxes, 1)).toBe(470);
  });
});

describe("stackedDropIndex", () => {
  const rows = stackedRowsLayout(4);

  it("moves a row once the lifted box's centre passes half a row", () => {
    expect(stackedDropIndex(1, 25, rows)).toBe(1);
    expect(stackedDropIndex(1, 27, rows)).toBe(2);
    expect(stackedDropIndex(1, -27, rows)).toBe(0);
    expect(stackedDropIndex(0, 104, rows)).toBe(2);
  });

  it("stops at the first and last rows", () => {
    expect(stackedDropIndex(1, -500, rows)).toBe(0);
    expect(stackedDropIndex(1, 500, rows)).toBe(3);
    expect(stackedDropIndex(1, Number.NaN, rows)).toBe(1);
  });

  it("takes the row under the centre when one is open, and equals the uniform rows' formula with none", () => {
    // Rows at 0, 52, 184 (row 1 open), 236: row 0's centre (26) moved 60 px is in row 1, 160 px still is, 159 + 26
    // past 184 is row 2
    const open = stackedRowsLayout(4, 1);
    expect(stackedDropIndex(0, 60, open)).toBe(1);
    expect(stackedDropIndex(0, 157, open)).toBe(1);
    expect(stackedDropIndex(0, 158, open)).toBe(2);
    let seed = 13;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let run = 0; run < 2000; run++) {
      const count = 1 + Math.floor(rnd() * 6);
      const index = Math.floor(rnd() * count);
      const dy = (rnd() - 0.5) * 800;
      const uniform = Math.min(Math.max(index + Math.round(dy / 52), 0), count - 1);
      expect(stackedDropIndex(index, dy, stackedRowsLayout(count))).toBe(uniform);
    }
  });
});

describe("stackedInsertionY", () => {
  it("marks above the drop row moving up, below it moving down", () => {
    const rows = stackedRowsLayout(4);
    expect(stackedInsertionY(0, 2, rows)).toBe(0);
    expect(stackedInsertionY(3, 1, rows)).toBe(208);
    expect(stackedInsertionY(1, 1, rows)).toBeNull();
    // Below an open row 1, and under the last row past it
    const open = stackedRowsLayout(4, 1);
    expect(stackedInsertionY(1, 0, open)).toBe(184);
    expect(stackedInsertionY(3, 0, open)).toBe(288);
    expect(stackedInsertionY(1, 3, open)).toBe(52);
  });
});

describe("blockDropIndexAt and blockInsertionX", () => {
  it("equal dropIndexAt and insertionX for one dragged clip", () => {
    for (let dragged = 0; dragged < boxes.length; dragged++) {
      for (let x = 0; x <= 1000; x += 7) {
        const index = dropIndexAt(x, boxes, dragged);
        expect(blockDropIndexAt(x, boxes, new Set([dragged]))).toBe(index);
        expect(blockInsertionX(index, boxes, new Set([dragged]))).toBe(insertionX(index, boxes, dragged));
      }
    }
  });

  it("counts only the clips outside the block", () => {
    const four = [...boxes, { x: 988, width: 200 }];
    const block = new Set([0, 2]);
    expect(blockDropIndexAt(20, four, block)).toBe(0);
    // Past Clip 2's middle (470): after it
    expect(blockDropIndexAt(480, four, block)).toBe(1);
    // Past Clip 4's middle (1088): at the end
    expect(blockDropIndexAt(1100, four, block)).toBe(2);
    expect(blockInsertionX(0, four, block)).toBe(334);
    expect(blockInsertionX(1, four, block)).toBe((604 + 988) / 2);
    expect(blockInsertionX(2, four, block)).toBe(1190);
  });

  it("marks the first box when every box is in the block", () => {
    expect(blockInsertionX(0, boxes, new Set([0, 1, 2]))).toBe(16);
  });
});
