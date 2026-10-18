import { describe, expect, it } from "vitest";
import { timelineLayout } from "../timeline/timelineLayout";

describe("timelineLayout", () => {
  it("is 224 with a clip or two and one audio row, 296 with that row expanded", () => {
    expect(timelineLayout(1, 1, null).height).toBe(224);
    expect(timelineLayout(1, 1, 0).height).toBe(296);
    // Two clips: Stacked's two rows (104 + 9) are a pixel more than Track's clips row (92 + 20)
    expect(timelineLayout(2, 1, null).height).toBe(225);
    // No audio at all draws one placeholder row
    expect(timelineLayout(1, 0, null).height).toBe(224);
  });

  it("shows two audio rows before the rest scroll", () => {
    expect(timelineLayout(1, 2, null).height).toBe(288);
    expect(timelineLayout(1, 3, null).height).toBe(288);
    expect(timelineLayout(1, 3, null).audio.maxScroll).toBe(64);
    expect(timelineLayout(1, 2, 1).height).toBe(360);
  });

  it("sizes the video part by the larger of Track's and Stacked's needs, so the layout never changes the height", () => {
    // Three clips: Stacked's 156 + 9
    expect(timelineLayout(3, 1, null)).toMatchObject({ height: 24 + 165 + 88, videoHeight: 165 });
    // Six: capped at three and a half rows
    expect(timelineLayout(6, 1, null)).toMatchObject({ height: 24 + 191 + 88, videoHeight: 191 });
  });

  it("gives up Stacked's rows first, then the audio view, under the cap, and never goes below 224", () => {
    // 1280 × 800: the stage keeps 300 of a 752px dialog, which leaves the timeline 360
    const wanted = timelineLayout(4, 3, 0);
    expect(wanted.height).toBe(24 + 191 + 224);
    const capped = timelineLayout(4, 3, 0, 360);
    expect(capped.height).toBe(360);
    // Stacked's rows view gives way first, down to what Track needs; the audio view keeps its 200
    expect(capped.videoHeight).toBe(360 - 24 - 224);
    expect(capped.audio.viewHeight).toBe(200);
    // Tighter still: the video part stops at Track's need and the audio view shrinks
    const tight = timelineLayout(4, 3, 0, 300);
    expect(tight.videoHeight).toBe(112);
    expect(tight.audio.viewHeight).toBe(300 - 24 - 112 - 24);
    expect(tight.height).toBe(300);
    // Never below one audio row, and never below 224 in all
    const tiny = timelineLayout(4, 3, 0, 100);
    expect(tiny.audio.viewHeight).toBe(64);
    expect(tiny.height).toBe(224);
    // Room to spare changes nothing
    expect(timelineLayout(4, 3, 0, 1000)).toEqual(wanted);
  });
});
