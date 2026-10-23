import { audioSectionLayout, type AudioSectionLayout } from "@/lib/stitch/audioLayout";
import { overlaySectionLayout, type OverlaySectionLayout } from "@/lib/stitch/overlayLayout";
import { STACK_ROW_EXPANDED_PX, STACK_ROW_PX, stackedRowsLayout } from "@/lib/stitch/stackedLayout";
import { GEOMETRY, TIMELINE_EDGE_PX as EDGE_PX } from "../editorStyles";

export interface TimelineLayout {
  /** The timeline's height, its top edge included and any horizontal scrollbar left out, px. */
  height: number;
  /** The video part between the overlay rows and the audio section, px: Track's clips row, or Stacked's rows view. */
  videoHeight: number;
  audio: AudioSectionLayout;
  /** The text layers' rows under the ruler; no room at all without any. */
  overlay: OverlaySectionLayout;
}

/**
 * The timeline's height: what its rows need, for the layout in use. The
 * ruler, then the text layers' rows (two show; none without text layers),
 * then Track's clips row or Stacked's rows (up to three and a half), then
 * the audio rows (two show) and the strip with "+ Audio". It depends on the
 * layout, the number of clips, overlay rows and audio rows, the expanded
 * audio row and the clip row open for its speed curve (a toggle, never the
 * selection), so a click moves nothing. Over maxHeight (the room the editor
 * leaves) Track's open clips row gives way first, down to the closed row,
 * and Stacked's rows view, down to one and a half rows, then the audio rows
 * view, down to one row, then the overlay rows view, down to one row; it
 * never goes below GEOMETRY.timeline (and one overlay row more while there
 * are any). The room for a horizontal scrollbar is the timeline's to add.
 *
 * chosenHeight is the height its top edge was dragged to (null fits the
 * rows). It is kept within maxHeight and above that least height. Under
 * what the rows need, they give way as under maxHeight. Over it, Stacked's
 * rows view grows past its cap first, then the audio view, then the overlay
 * view; what is left stays empty between the video part and the audio
 * section.
 *
 * expandedVideo: Track, any number opens the clips row; Stacked, the index of
 * the row grown for its clip's speed curve; null for none.
 */
export function timelineLayout(
  clipCount: number,
  audioRowCount: number,
  expandedRow: number | null,
  stacked: boolean,
  maxHeight = Infinity,
  chosenHeight: number | null = null,
  overlayRowCount = 0,
  expandedVideo: number | null = null,
): TimelineLayout {
  const overlayFull = overlaySectionLayout(overlayRowCount);
  const least = GEOMETRY.timeline + (overlayFull.sectionHeight > 0 ? GEOMETRY.overlayRow : 0);
  const rows = stackedRowsLayout(clipCount, stacked ? expandedVideo : null);
  const extra = rows.expanded !== -1 ? STACK_ROW_EXPANDED_PX - STACK_ROW_PX : 0;
  const trackRow = !stacked && expandedVideo !== null ? GEOMETRY.clipRowExpanded : GEOMETRY.clipRow;
  if (chosenHeight !== null) {
    const target = Math.max(least, Math.min(chosenHeight, maxHeight));
    const fitted = timelineLayout(
      clipCount,
      audioRowCount,
      expandedRow,
      stacked,
      target,
      null,
      overlayRowCount,
      expandedVideo,
    );
    let spare = target - fitted.height;
    if (spare <= 0) return fitted;
    const videoAll = stacked ? rows.height : trackRow;
    const videoHeight = Math.min(videoAll, fitted.videoHeight + spare);
    spare -= videoHeight - fitted.videoHeight;
    const audio = audioSectionLayout(audioRowCount, expandedRow, fitted.audio.viewHeight + spare, Infinity);
    spare -= audio.viewHeight - fitted.audio.viewHeight;
    const overlay = overlaySectionLayout(overlayRowCount, fitted.overlay.viewHeight + spare, Infinity);
    return { height: target, videoHeight, audio, overlay };
  }
  const videoWanted = stacked ? Math.min(rows.height, GEOMETRY.stackRowsCap + extra) : trackRow;
  const full = audioSectionLayout(audioRowCount, expandedRow);
  const top = EDGE_PX + GEOMETRY.ruler;
  const wanted = top + overlayFull.sectionHeight + videoWanted + full.sectionHeight;
  if (!(Number.isFinite(maxHeight) && wanted > maxHeight)) {
    return { height: wanted, videoHeight: videoWanted, audio: full, overlay: overlayFull };
  }
  const room = Math.max(least, maxHeight);
  const videoFloor = Math.min(videoWanted, stacked ? GEOMETRY.stackRowsFloor : GEOMETRY.clipRow);
  const videoHeight = Math.min(
    videoWanted,
    Math.max(videoFloor, room - top - overlayFull.sectionHeight - full.sectionHeight),
  );
  const audio = audioSectionLayout(
    audioRowCount,
    expandedRow,
    room - top - overlayFull.sectionHeight - videoHeight - GEOMETRY.audioStrip,
  );
  const overlay = overlaySectionLayout(overlayRowCount, room - top - videoHeight - audio.sectionHeight);
  return { height: top + overlay.sectionHeight + videoHeight + audio.sectionHeight, videoHeight, audio, overlay };
}
