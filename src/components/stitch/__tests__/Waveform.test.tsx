import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { buildTimeAxis } from "@/lib/stitch/timeAxis";
import { clipSpans, createClip, type SourceDurations, type SourceKey } from "@/lib/stitch/timeline";
import { Waveform } from "../timeline/Waveform";

const clip = (id: string, edgeId: string) => createClip({ kind: "edge", edgeId }, { id });
const durations = (entries: Record<string, number>): SourceDurations =>
  new Map(Object.entries(entries) as [SourceKey, number][]);

/** 4 s, an empty clip (a 160px slot), then 6 s, at 16 px/s from x 16: the slot covers x 80..240. */
const axis = buildTimeAxis(
  clipSpans([clip("a", "e1"), clip("gap", "e2"), clip("b", "e3")], durations({ "edge:e1": 4, "edge:e3": 6 }), 0),
  16,
);

type Rect = [number, number, number, number];

/** A 2D context that records the bars it is asked to fill. */
function fakeContext() {
  const rects: Rect[] = [];
  const ctx = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    fillRect: (...r: Rect) => rects.push(r),
    fillStyle: "",
    globalAlpha: 1,
  };
  return { ctx, rects };
}

let rects: Rect[] = [];

beforeEach(() => {
  document.documentElement.style.setProperty("--color-handle-audio", "#22d3ee");
  const fake = fakeContext();
  rects = fake.rects;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(fake.ctx as unknown as CanvasRenderingContext2D);
});

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.style.removeProperty("--color-handle-audio");
});

function draw(expanded: boolean, peak = 0.5) {
  const blockX = axis.timeToX(0);
  const blockWidth = axis.timeToX(axis.total) - blockX;
  const height = expanded ? 120 : 48;
  render(
    <Waveform
      peaks={new Float32Array(256).fill(peak)}
      duration={20}
      axis={axis}
      blockX={blockX}
      blockWidth={blockWidth}
      height={height}
      expanded={expanded}
      viewLeft={0}
      viewRight={2000}
    />,
  );
  return { blockX, blockWidth, height };
}

describe("Waveform", () => {
  it("draws 3px bars on whole pixels at an 8px pitch while collapsed, none inside the slot", () => {
    const { blockX, blockWidth, height } = draw(false);
    const slot = axis.slots[0];
    expect(slot.width).toBe(160);
    expect(rects.length).toBeGreaterThan(0);
    for (const [x, y, w, h] of rects) {
      expect(w).toBe(3);
      // 2px into each 8px cell
      expect((x - 2) % 8).toBe(0);
      expect(Number.isInteger(x)).toBe(true);
      // Height is the peak's share of 70% of the block, centred
      expect(h).toBeCloseTo(0.5 * 0.7 * height);
      expect(y + h / 2).toBeCloseTo(height / 2);
      // Not a pixel of it inside the slot
      const laneX = blockX + x;
      expect(laneX + w <= slot.x || laneX >= slot.x + slot.width).toBe(true);
      expect(x + w).toBeLessThanOrEqual(blockWidth);
    }
    // Bars run on both sides of the slot
    expect(rects.some(([x]) => blockX + x < slot.x)).toBe(true);
    expect(rects.some(([x]) => blockX + x >= slot.x + slot.width)).toBe(true);
  });

  it("draws 4px bars 2px into each cell while expanded, as tall as the peak says", () => {
    const { height } = draw(true, 1);
    expect(rects.length).toBeGreaterThan(0);
    for (const [x, , w, h] of rects) {
      expect(w).toBe(4);
      expect((x - 2) % 8).toBe(0);
      expect(h).toBeCloseTo(0.7 * height);
    }
  });

  it("reads the source at sequence time plus the offset: a clip's In less its start", () => {
    // 20 s of source: silent for the first 10 s, then full scale
    const peaks = new Float32Array(256);
    peaks.fill(1, 128);
    const draw = (sourceOffset?: number) => {
      rects.length = 0;
      const blockX = axis.timeToX(0);
      const { unmount } = render(
        <Waveform
          peaks={peaks}
          duration={20}
          axis={axis}
          blockX={blockX}
          blockWidth={axis.timeToX(4) - blockX}
          height={48}
          expanded={false}
          viewLeft={0}
          viewRight={2000}
          sourceOffset={sourceOffset}
        />,
      );
      const drawn = rects.length;
      unmount();
      return drawn;
    };
    // Without an offset the first 4 s of the source are silent: no bars
    expect(draw()).toBe(0);
    // A clip whose In is 12 s, starting at 0:00, plays source 12–16 s: bars all along
    expect(draw(12)).toBeGreaterThan(0);
  });
});
