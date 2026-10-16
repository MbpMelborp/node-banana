/**
 * Drag-to-reorder in the clips lane: which place a dragged clip would take,
 * and where the insertion bar marks it. Boxes are the lane's boxes in
 * sequence order (the dragged one included), in lane pixels. Pure.
 */

type Box = { x: number; width: number };

/** The final index for moveClip: how many of the other clips have their midpoint left of the pointer. */
export function dropIndexAt(x: number, boxes: ReadonlyArray<Box>, draggedIndex: number): number {
  let index = 0;
  boxes.forEach((box, i) => {
    if (i !== draggedIndex && box.x + box.width / 2 < x) index++;
  });
  return index;
}

/** x of the 3px insertion bar's centre for that drop index: in the gap between the clips it falls between. */
export function insertionX(dropIndex: number, boxes: ReadonlyArray<Box>, draggedIndex: number): number {
  const others = boxes.filter((_, i) => i !== draggedIndex);
  if (others.length === 0) return boxes[0]?.x ?? 0;
  if (dropIndex <= 0) return others[0].x - 2;
  if (dropIndex >= others.length) {
    const last = others[others.length - 1];
    return last.x + last.width + 2;
  }
  const before = others[dropIndex - 1];
  const after = others[dropIndex];
  return (before.x + before.width + after.x) / 2;
}
