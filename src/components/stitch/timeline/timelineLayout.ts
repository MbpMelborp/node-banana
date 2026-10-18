import { audioSectionLayout, type AudioSectionLayout } from "@/lib/stitch/audioLayout";
import { GEOMETRY } from "../editorStyles";

export interface TimelineLayout {
  /** The timeline's height, its top border included, px. */
  height: number;
  /** The video part between the ruler and the audio section, px: Track's clips row, or Stacked's rows view and scrollbar. */
  videoHeight: number;
  audio: AudioSectionLayout;
}

/** Track's clips row with its room under it. */
const TRACK_VIDEO = GEOMETRY.clipRow + GEOMETRY.trackSlack;
/** Stacked's rows view is never capped below this, nor below what Track needs. */
const VIDEO_FLOOR = Math.max(TRACK_VIDEO, GEOMETRY.stackRowsFloor + GEOMETRY.stackSlack);

/**
 * The timeline's height. It depends on the number of clips and audio rows, the
 * expanded audio row and the room the editor leaves (maxHeight), never on the
 * layout or the selection: a switch of Track | Stacked, ⌘Z or a click moves
 * neither the transport above it nor anything in it. The video part is the
 * larger of what each layout needs (Track's clips row; Stacked's rows, up to
 * three and a half), so the one in use may have room to spare. Over maxHeight
 * the timeline gives up Stacked's rows view first, down to what Track needs,
 * then the audio rows view, down to one row; it never goes below
 * GEOMETRY.timeline.
 */
export function timelineLayout(
  clipCount: number,
  audioRowCount: number,
  expandedRow: number | null,
  maxHeight = Infinity,
): TimelineLayout {
  const stackedVideo = Math.min(Math.max(1, clipCount) * GEOMETRY.stackRow, GEOMETRY.stackRowsCap) + GEOMETRY.stackSlack;
  const videoWanted = Math.max(TRACK_VIDEO, stackedVideo);
  const full = audioSectionLayout(audioRowCount, expandedRow);
  const wanted = GEOMETRY.ruler + videoWanted + full.sectionHeight;
  if (!(Number.isFinite(maxHeight) && wanted > maxHeight)) {
    return { height: wanted, videoHeight: videoWanted, audio: full };
  }
  const room = Math.max(GEOMETRY.timeline, maxHeight);
  const videoHeight = Math.min(videoWanted, Math.max(VIDEO_FLOOR, room - GEOMETRY.ruler - full.sectionHeight));
  const audio = audioSectionLayout(
    audioRowCount,
    expandedRow,
    room - GEOMETRY.ruler - videoHeight - GEOMETRY.audioStrip,
  );
  return { height: GEOMETRY.ruler + videoHeight + audio.sectionHeight, videoHeight, audio };
}
