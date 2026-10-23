import { describe, expect, it } from "vitest";
import { timelineLayout } from "../timeline/timelineLayout";

// The top edge (1) and the ruler (28), the text layers' rows (none without text layers), the video part, then the audio
// rows and the 28px strip with "+ Audio"

describe("timelineLayout", () => {
  it("is 189 in Track with one audio row, 265 with that row expanded, whatever the clips", () => {
    for (const clips of [0, 1, 2, 6]) {
      expect(timelineLayout(clips, 1, null, false)).toMatchObject({ height: 1 + 28 + 80 + 52 + 28, videoHeight: 80 });
      expect(timelineLayout(clips, 1, 0, false).height).toBe(1 + 28 + 80 + 128 + 28);
    }
    // No audio at all draws one placeholder row
    expect(timelineLayout(1, 0, null, false).height).toBe(189);
  });

  it("takes Stacked's rows as they need, up to three and a half", () => {
    expect(timelineLayout(1, 1, null, true)).toMatchObject({ height: 1 + 28 + 52 + 80, videoHeight: 52 });
    expect(timelineLayout(2, 1, null, true).videoHeight).toBe(104);
    expect(timelineLayout(3, 1, null, true)).toMatchObject({ height: 1 + 28 + 156 + 80, videoHeight: 156 });
    // Six: capped at three and a half rows
    expect(timelineLayout(6, 1, null, true)).toMatchObject({ height: 1 + 28 + 182 + 80, videoHeight: 182 });
    // An empty Stacked keeps one row's room
    expect(timelineLayout(0, 1, null, true).videoHeight).toBe(52);
  });

  it("shows two audio rows before the rest scroll", () => {
    expect(timelineLayout(1, 2, null, false).height).toBe(1 + 28 + 80 + 104 + 28);
    expect(timelineLayout(1, 3, null, false).height).toBe(241);
    expect(timelineLayout(1, 3, null, false).audio.maxScroll).toBe(52);
    expect(timelineLayout(1, 2, 1, false).height).toBe(1 + 28 + 80 + 180 + 28);
  });

  it("gives up Stacked's rows first, then the audio view, under the cap, and never goes below 189", () => {
    const wanted = timelineLayout(4, 3, 0, true);
    expect(wanted.height).toBe(1 + 28 + 182 + 180 + 28);
    const capped = timelineLayout(4, 3, 0, true, 360);
    expect(capped.height).toBe(360);
    // Stacked's rows view gives way first; the audio view keeps its 180
    expect(capped.videoHeight).toBe(360 - 1 - 28 - 208);
    expect(capped.audio.viewHeight).toBe(180);
    // Tighter still: the rows view stops at one and a half rows and the audio view shrinks
    const tight = timelineLayout(4, 3, 0, true, 300);
    expect(tight.videoHeight).toBe(78);
    expect(tight.audio.viewHeight).toBe(300 - 1 - 28 - 78 - 28);
    expect(tight.height).toBe(300);
    // Never below one audio row, and never below 189 in all
    const tiny = timelineLayout(4, 3, 0, true, 100);
    expect(tiny.audio.viewHeight).toBe(54);
    expect(tiny.height).toBe(189);
    // Room to spare changes nothing
    expect(timelineLayout(4, 3, 0, true, 1000)).toEqual(wanted);
  });

  it("takes a chosen height: the rows' views grow past their caps into it, Stacked's first, and give way under it", () => {
    // Stacked, six clips and three audio rows: 182 + 104 by default, 343 in all
    const grown = timelineLayout(6, 3, null, true, Infinity, 500);
    expect(grown.height).toBe(500);
    // 157 to spare: the rows view takes all six rows (312), the audio view the 27 left
    expect(grown.videoHeight).toBe(312);
    expect(grown.audio.viewHeight).toBe(104 + 27);
    // Track's clips row stays; the audio view shows every row, and the rest stays empty
    const track = timelineLayout(6, 3, null, false, Infinity, 500);
    expect(track).toMatchObject({ height: 500, videoHeight: 80 });
    expect(track.audio).toMatchObject({ viewHeight: 156, maxScroll: 0 });
    // Under what the rows need they give way as under the cap
    expect(timelineLayout(4, 3, 0, true, Infinity, 360)).toEqual(timelineLayout(4, 3, 0, true, 360));
    // Within the cap, and never below 189
    expect(timelineLayout(6, 3, null, true, 400, 500).height).toBe(400);
    expect(timelineLayout(6, 3, null, true, Infinity, 50).height).toBe(189);
  });

  it("keeps Track's clips row whole under the cap and gives up audio rows instead", () => {
    const capped = timelineLayout(4, 3, 0, false, 300);
    expect(capped).toMatchObject({ height: 300, videoHeight: 80 });
    expect(capped.audio.viewHeight).toBe(300 - 1 - 28 - 80 - 28);
    const tiny = timelineLayout(4, 3, 0, false, 100);
    expect(tiny).toMatchObject({ height: 189, videoHeight: 80 });
    expect(tiny.audio.viewHeight).toBe(52);
  });

  it("leaves every height as it was with no overlay rows: their section takes no room", () => {
    const pairs = [
      [timelineLayout(1, 1, null, false), timelineLayout(1, 1, null, false, Infinity, null, 0)],
      [timelineLayout(6, 3, 0, true, 360), timelineLayout(6, 3, 0, true, 360, null, 0)],
      [timelineLayout(4, 3, 0, false, 100), timelineLayout(4, 3, 0, false, 100, null, 0)],
      [timelineLayout(6, 3, null, true, Infinity, 500), timelineLayout(6, 3, null, true, Infinity, 500, 0)],
    ];
    for (const [before, withNone] of pairs) {
      expect(withNone).toEqual(before);
      expect(withNone.overlay).toMatchObject({ rowTops: [], viewHeight: 0, sectionHeight: 0 });
    }
  });

  it("adds the overlay rows between the ruler and the video: two show, the rest scroll", () => {
    expect(timelineLayout(1, 1, null, false, Infinity, null, 1).height).toBe(1 + 28 + 52 + 80 + 52 + 28);
    const two = timelineLayout(1, 1, null, true, Infinity, null, 2);
    expect(two.height).toBe(1 + 28 + 104 + 52 + 52 + 28);
    expect(two.overlay).toMatchObject({ viewHeight: 104, maxScroll: 0 });
    const three = timelineLayout(1, 1, null, false, Infinity, null, 3);
    expect(three.height).toBe(1 + 28 + 104 + 80 + 52 + 28);
    expect(three.overlay.maxScroll).toBe(52);
  });

  it("gives up Stacked's rows, then the audio view, then the overlay view under the cap; never below one row of each", () => {
    const wanted = timelineLayout(4, 3, null, true, Infinity, null, 3);
    expect(wanted.height).toBe(1 + 28 + 104 + 182 + 104 + 28);
    // Stacked's rows give way first
    const capped = timelineLayout(4, 3, null, true, 400, null, 3);
    expect(capped).toMatchObject({ height: 400, videoHeight: 400 - 1 - 28 - 104 - 132 });
    expect(capped.audio.viewHeight).toBe(104);
    expect(capped.overlay.viewHeight).toBe(104);
    // Then the audio view, down to one row
    const tighter = timelineLayout(4, 3, null, true, 300, null, 3);
    expect(tighter.videoHeight).toBe(78);
    expect(tighter.audio.viewHeight).toBe(300 - 1 - 28 - 104 - 78 - 28);
    expect(tighter.overlay.viewHeight).toBe(104);
    expect(tighter.height).toBe(300);
    // Then the overlay view
    const tight = timelineLayout(4, 3, null, true, 260, null, 3);
    expect(tight.audio.viewHeight).toBe(52);
    expect(tight.overlay.viewHeight).toBe(260 - 1 - 28 - 78 - 52 - 28);
    expect(tight.height).toBe(260);
    // Never below one row of each, and never below 189 + one overlay row in all
    const tiny = timelineLayout(4, 3, null, false, 100, null, 3);
    expect(tiny.overlay.viewHeight).toBe(52);
    expect(tiny.height).toBe(189 + 52);
  });

  it("takes a chosen height: Stacked's rows first, then the audio view, then the overlay view, past their caps", () => {
    // Track, three audio rows and three overlay rows: 104 + 80 + 104 + 28 by default
    const grown = timelineLayout(2, 3, null, false, Infinity, 1 + 28 + 104 + 80 + 104 + 28 + 80, 3);
    expect(grown.videoHeight).toBe(80);
    // 80 to spare: the audio view takes the 52 it needs to show all three rows, the overlay view the 28 left
    expect(grown.audio.viewHeight).toBe(156);
    expect(grown.overlay.viewHeight).toBe(104 + 28);
    // Never under the least it takes with overlays
    expect(timelineLayout(2, 3, null, false, Infinity, 50, 3).height).toBe(189 + 52);
  });
});

describe("timelineLayout with a clip row open for its speed curve", () => {
  it("Track: the clips row grows to 136, and gives way first under the room the editor leaves, down to 80", () => {
    expect(timelineLayout(2, 1, null, false, Infinity, null, 0, 0)).toMatchObject({ height: 245, videoHeight: 136 });
    expect(timelineLayout(2, 1, null, false, Infinity, null, 0, null)).toMatchObject({ height: 189, videoHeight: 80 });
    // Any index opens Track's one clips row
    expect(timelineLayout(2, 1, null, false, Infinity, null, 0, 1)).toMatchObject({ height: 245, videoHeight: 136 });
    expect(timelineLayout(2, 1, null, false, 220, null, 0, 0)).toMatchObject({ height: 220, videoHeight: 111 });
    // At the closed row's height it is the closed row, and the least height is unchanged
    expect(timelineLayout(2, 1, null, false, 189, null, 0, 0)).toMatchObject({ height: 189, videoHeight: 80 });
    expect(timelineLayout(2, 1, null, false, 100, null, 0, 0)).toMatchObject({ height: 189, videoHeight: 80 });
    // Dragged taller, it takes its 136 first
    expect(timelineLayout(2, 1, null, false, Infinity, 300, 0, 0)).toMatchObject({ height: 300, videoHeight: 136 });
  });

  it("Stacked: the open row is 132 px inside the rows view, whose cap grows by its 80 px more", () => {
    expect(timelineLayout(2, 1, null, true, Infinity, null, 0, 0)).toMatchObject({ height: 293, videoHeight: 184 });
    // Five clips, row 1 open: 340 px of rows in a 182 + 80 px view
    const five = timelineLayout(5, 1, null, true, Infinity, null, 0, 1);
    expect(five.videoHeight).toBe(262);
    expect(five.height).toBe(1 + 28 + 262 + 80);
    // Under the room the editor leaves the view gives way first, as with no row open, down to its floor of one and a
    // half rows (three audio rows here, so the floor is reached before the least height)
    expect(timelineLayout(5, 1, null, true, 200, null, 0, 1).videoHeight).toBe(200 - 1 - 28 - 80);
    expect(timelineLayout(5, 3, null, true, 230, null, 0, 1)).toMatchObject({ height: 230, videoHeight: 78 });
    // A chosen height past the rows' cap grows the view up to all of them
    expect(timelineLayout(5, 1, null, true, Infinity, 2000, 0, 1).videoHeight).toBe(340);
    expect(timelineLayout(5, 1, null, true, Infinity, 400, 0, 1).videoHeight).toBe(400 - 1 - 28 - 80);
    // A row out of range opens nothing
    expect(timelineLayout(2, 1, null, true, Infinity, null, 0, 5)).toEqual(timelineLayout(2, 1, null, true));
  });
});
