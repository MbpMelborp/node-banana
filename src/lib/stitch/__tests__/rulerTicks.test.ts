import { describe, it, expect } from "vitest";
import { majorStep, rulerTicks } from "../rulerTicks";

const close = (values: number[]) => values.map((v) => Math.round(v * 1000) / 1000);

describe("rulerTicks", () => {
  it("draws Main.png at 64 px/s: 1 s majors, 0.25 s minors, labels every 2 s", () => {
    const ticks = rulerTicks(64, 0, 4);
    expect(close(ticks.majors)).toEqual([0, 1, 2, 3, 4]);
    expect(close(ticks.minors).slice(0, 4)).toEqual([0.25, 0.5, 0.75, 1.25]);
    expect(ticks.minors).toHaveLength(12);
    expect(ticks.labels.map((l) => l.text)).toEqual(["0:00", "0:02", "0:04"]);
  });

  it("keeps 1 s majors at Fit on a 1440px window (≈ 63 px/s)", () => {
    expect(majorStep(63.4)).toBe(1);
    expect(rulerTicks(63.4, 0, 18.4).labels.at(-1)?.text).toBe("0:18");
  });

  it("draws Trim.png at 120 px/s: 1 s majors, 0.2 s minors, a label every second with tenths", () => {
    const ticks = rulerTicks(120, 4, 9);
    expect(close(ticks.majors)).toEqual([4, 5, 6, 7, 8, 9]);
    expect(close(ticks.minors).slice(0, 4)).toEqual([4.2, 4.4, 4.6, 4.8]);
    expect(ticks.labels.map((l) => l.text)).toEqual(["0:04.0", "0:05.0", "0:06.0", "0:07.0", "0:08.0", "0:09.0"]);
  });

  it("steps down to half or quarter seconds when zoomed in", () => {
    expect(majorStep(150)).toBe(1);
    expect(majorStep(250)).toBe(0.5);
    expect(majorStep(480)).toBe(0.25);
    const ticks = rulerTicks(480, 1, 2);
    expect(close(ticks.majors)).toEqual([1, 1.25, 1.5, 1.75, 2]);
    expect(ticks.labels.map((l) => l.text)).toEqual(["0:01.00", "0:01.25", "0:01.50", "0:01.75", "0:02.00"]);
  });

  it("steps up to 5 or 10 s when zoomed out", () => {
    expect(majorStep(20)).toBe(5);
    expect(majorStep(8)).toBe(10);
    const ticks = rulerTicks(8, 0, 60);
    expect(close(ticks.majors)).toEqual([0, 10, 20, 30, 40, 50, 60]);
    expect(ticks.labels.map((l) => l.text)).toEqual(["0:00", "0:20", "0:40", "1:00"]);
  });

  it("draws only the asked range, and nothing for a bad zoom", () => {
    const ticks = rulerTicks(64, 10.1, 12.9);
    expect(close(ticks.majors)).toEqual([11, 12]);
    expect(ticks.minors.every((t) => t >= 10.1 && t <= 12.9)).toBe(true);
    expect(ticks.labels.map((l) => l.text)).toEqual(["0:12"]);
    expect(rulerTicks(0, 0, 10)).toEqual({ majors: [], minors: [], labels: [] });
    expect(rulerTicks(64, 5, 1)).toEqual({ majors: [], minors: [], labels: [] });
  });
});
