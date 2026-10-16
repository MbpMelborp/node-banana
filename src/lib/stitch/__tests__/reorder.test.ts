import { describe, it, expect } from "vitest";
import { dropIndexAt, insertionX, stackedDropIndex, stackedInsertionY } from "../reorder";

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
  it("moves a row once the lifted box's centre passes half a row", () => {
    expect(stackedDropIndex(1, 25, 4, 52)).toBe(1);
    expect(stackedDropIndex(1, 27, 4, 52)).toBe(2);
    expect(stackedDropIndex(1, -27, 4, 52)).toBe(0);
    expect(stackedDropIndex(0, 104, 4, 52)).toBe(2);
  });

  it("stops at the first and last rows", () => {
    expect(stackedDropIndex(1, -500, 4, 52)).toBe(0);
    expect(stackedDropIndex(1, 500, 4, 52)).toBe(3);
    expect(stackedDropIndex(1, Number.NaN, 4, 52)).toBe(1);
  });
});

describe("stackedInsertionY", () => {
  it("marks above the drop row moving up, below it moving down", () => {
    expect(stackedInsertionY(0, 2, 52)).toBe(0);
    expect(stackedInsertionY(3, 1, 52)).toBe(208);
    expect(stackedInsertionY(1, 1, 52)).toBeNull();
  });
});
